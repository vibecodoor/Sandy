import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { imeBusy } from "./imeGuard";
import { isPlainPaste } from "./markdownKeymap";

/*
 * Paste hygiene - the calm guard on the plaintext core.
 *
 * Text pasted from an LLM chat, a PDF, or a web page routinely carries
 * characters you cannot see: zero-width spaces and joiners, bidirectional
 * controls, Unicode "tag" characters, stray control codes - plus visible AI
 * citation crumbs like [cite_start] or a bracketed "source" superscript. None
 * of them render, so they slip into the file invisibly and then quietly break
 * search, wiki-link and heading matching, and the byte round-trip the whole app
 * is built on. You cannot find or delete what you cannot see, which is exactly
 * why an editor that promises a clean plaintext file has to strip them at the
 * door.
 *
 * This runs only on an ordinary text paste. It is NOT smart-quote flattening:
 * Sandy renders the curly glyphs over plain ASCII (typography.ts), so visible
 * punctuation a paste brings is the user's content and stays untouched - we
 * remove only what has no legitimate place in prose. Ctrl+Shift+V
 * (markdownKeymap.ts) is the documented escape hatch: it pastes the clipboard
 * verbatim, junk and all. Never fires during IME composition
 * (hard IME constraint).
 */

/*
 * The set of code points with no legitimate place in prose, built from numeric
 * ranges so the source of a feature about invisible characters contains none of
 * them itself. Tab (U+0009), newline (U+000A) and carriage return (U+000D) are
 * excluded, so pasted structure and line breaks survive. Emoji variation
 * selectors (U+FE00-U+FE0F, U+E0100-U+E01EF) are meaningful and left in place.
 */
const STRIP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08], // C0 controls (keep 09 tab, 0a newline)
  [0x0b, 0x0c], // vertical tab, form feed (keep 0d carriage return)
  [0x0e, 0x1f], // remaining C0 controls
  [0x7f, 0x7f], // DEL
  [0x00ad, 0x00ad], // soft hyphen
  [0x180e, 0x180e], // Mongolian vowel separator (deprecated space)
  [0x200b, 0x200b], // zero-width space
  /* NOT 200C/200D: ZWNJ is orthographically required in Persian and Indic
   * scripts, and ZWJ is the joiner in every emoji family/profession/flag
   * sequence (👩‍💻, 👨‍👩‍👧, 🏳️‍🌈) — stripping them visibly corrupted pasted
   * content. They are exactly as meaningful as the variation selectors the
   * header already promises to keep (s57 #B11). */
  [0x200e, 0x200f], // LRM/RLM
  [0x202a, 0x202e], // bidi embedding / override
  [0x2060, 0x2064], // word joiner + invisible math operators
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // zero-width no-break space (mid-text BOM)
  [0xfff9, 0xfffb], // interlinear annotation anchors
  [0xfffc, 0xfffc], // object replacement character
  [0xe0000, 0xe007f], // Unicode tags (a text-hiding / steganography vector)
];

/** `\u{...}` escape for a code point - only ASCII backslashes/digits are typed. */
function esc(cp: number): string {
  return "\\u{" + cp.toString(16) + "}";
}

const INVISIBLE = new RegExp(
  "[" +
    STRIP_RANGES.map(([a, b]) => (a === b ? esc(a) : esc(a) + "-" + esc(b))).join("") +
    "]",
  "gu",
);

/* Well-known AI citation artifacts - visible, but junk in every real paste.
 * Kept deliberately tight: the bracketed form must contain a dagger (U+2020),
 * so genuine CJK brackets in prose are never touched. Built from code points to
 * keep the invisible-character rule uniform across the module. */
const CITATIONS = new RegExp(
  "\\[cite_(?:start|end)\\]|" +
    esc(0x3010) +
    "[^" +
    esc(0x3011) +
    "]*" +
    esc(0x2020) +
    "[^" +
    esc(0x3011) +
    "]*" +
    esc(0x3011),
  "gu",
);

/* U+2028/2029 LINE/PARAGRAPH SEPARATOR: an invisible non-\n "line break" (JS
 * console copies, some PDF extractors). Replaced with a real newline rather
 * than stripped — the reader saw a break there (s57 #B18). */
const LINE_SEPS = new RegExp("[" + esc(0x2028) + esc(0x2029) + "]", "gu");

/** Strip invisible corruption and AI citation crumbs from pasted text. */
export function cleanPastedText(text: string): string {
  return text.replace(INVISIBLE, "").replace(CITATIONS, "").replace(LINE_SEPS, "\n");
}

/* Sits last in the paste chain (after image + URL-over-selection handling), so
 * it only ever sees an ordinary text paste. If the clipboard is already clean it
 * returns false and the native paste proceeds unchanged - default behavior and
 * undo grouping are untouched for the common case. */
export const pasteSanitizer = EditorView.domEventHandlers({
  paste(event, view) {
    if (imeBusy(view) || isPlainPaste(event)) return false;
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return false;
    const cleaned = cleanPastedText(text);
    if (cleaned === text) return false; // nothing invisible to remove
    event.preventDefault();
    /* This path preempts CM6's own doPaste, so it must redo two things the
     * native door did for free (s57 #B10/#B13): CRLF→LF (clipboardInputFilter
     * lives inside doPaste — without this a junk-carrying Windows paste wrote
     * literal \r into the doc, and the next save put stray CR bytes on disk),
     * and the N-lines-to-N-cursors rule for multi-range selections. */
    const insert = cleaned.replace(/\r\n?/g, "\n");
    // A paste that was *entirely* junk inserts nothing and leaves the selection
    // intact, rather than silently deleting it.
    if (insert) {
      const { state } = view;
      const lines = insert.split("\n");
      const ranges = state.selection.ranges;
      if (ranges.length > 1 && lines.length === ranges.length) {
        let i = 0;
        view.dispatch(
          state.changeByRange((range) => {
            const line = lines[i++];
            return {
              changes: { from: range.from, to: range.to, insert: line },
              range: EditorSelection.cursor(range.from + line.length),
            };
          }),
          { userEvent: "input.paste", scrollIntoView: true },
        );
      } else {
        view.dispatch(view.state.replaceSelection(insert), {
          userEvent: "input.paste",
          scrollIntoView: true,
        });
      }
    }
    return true;
  },
});
