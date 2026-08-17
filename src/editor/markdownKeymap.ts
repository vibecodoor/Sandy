import { EditorSelection, EditorState, type ChangeSpec, type Line } from "@codemirror/state";
import { EditorView, type Command, type KeyBinding } from "@codemirror/view";
import { indentUnit, syntaxTree } from "@codemirror/language";
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import {
  cursorGroupForwardWin,
  deleteGroupForwardWin,
  selectGroupForwardWin,
} from "@codemirror/commands";
import type { SyntaxNode } from "@lezer/common";
import { frontmatterInfo } from "./frontmatter";
import { imeBusy } from "./imeGuard";

/* Editing ergonomics. Hard constraint: no document transform may be dispatched
 * while an IME composition is active — every command here defers to default
 * behavior instead. lang-markdown's own Enter/Backspace keymap and URL-paste
 * handler are disabled in extensions.ts and re-bound through these guards. */

const imeSafe =
  (command: Command): Command =>
  (view) =>
    imeBusy(view) ? false : command(view);

/** Walk up from both sides of `from` to a `name` node spanning [from, to]. */
function enclosingFormat(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(from, side);
    for (; node; node = node.parent) {
      if (node.name === name && node.from <= from && node.to >= to) return node;
    }
  }
  return null;
}

function inCodeBlock(state: EditorState, pos: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);
  for (; node; node = node.parent) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
  }
  return false;
}

/** Visit each line touched by any selection range exactly once, in order. */
function forEachSelectedLine(state: EditorState, f: (line: Line) => void) {
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n++) {
      if (!seen.has(n)) {
        seen.add(n);
        f(state.doc.line(n));
      }
    }
  }
}

/* Inline toggles: wrap the selection (or word under the caret) in `marker`, or
 * unwrap when the range already sits in a matching node — so applying twice
 * restores the original. Delimiters are located via the node's mark children,
 * falling back to marker length, and only those exact spans change. */
const inlineMarkName: Record<string, string> = {
  StrongEmphasis: "EmphasisMark",
  Emphasis: "EmphasisMark",
  Strikethrough: "StrikethroughMark",
  InlineCode: "CodeMark",
};

function toggleInline(nodeName: string, marker: string): Command {
  const len = marker.length;
  return (view) => {
    const { state } = view;
    view.dispatch(
      state.changeByRange((range) => {
        const node = enclosingFormat(state, range.from, range.to, nodeName);
        if (node) {
          const marks = node.getChildren(inlineMarkName[nodeName]);
          const open = marks.length >= 2 ? marks[0] : { from: node.from, to: node.from + len };
          const close =
            marks.length >= 2 ? marks[marks.length - 1] : { from: node.to - len, to: node.to };
          const removedBefore = (pos: number) =>
            Math.max(0, Math.min(pos, open.to) - open.from) +
            Math.max(0, Math.min(pos, close.to) - close.from);
          return {
            changes: [
              { from: open.from, to: open.to },
              { from: close.from, to: close.to },
            ],
            range: EditorSelection.range(
              range.anchor - removedBefore(range.anchor),
              range.head - removedBefore(range.head),
            ),
          };
        }
        let { from, to } = range;
        if (from === to) {
          // caret between an empty marker pair → remove it (undoes the empty insert)
          if (
            state.sliceDoc(from - len, from) === marker &&
            state.sliceDoc(from, from + len) === marker
          ) {
            return {
              changes: [
                { from: from - len, to: from },
                { from, to: from + len },
              ],
              range: EditorSelection.cursor(from - len),
            };
          }
          const word = state.wordAt(from);
          if (word) ({ from, to } = word);
        }
        const changes: ChangeSpec = [
          { from, insert: marker },
          { from: to, insert: marker },
        ];
        if (from === to) return { changes, range: EditorSelection.cursor(from + len) };
        return {
          changes,
          range:
            range.head < range.anchor
              ? EditorSelection.range(to + len, from + len)
              : EditorSelection.range(from + len, to + len),
        };
      }),
    );
    return true;
  };
}

/* Ctrl+K: selection/word → "[text](|)"; inside an existing link → back to the
 * plain label text. */
const toggleLink: Command = (view) => {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const node = enclosingFormat(state, range.from, range.to, "Link");
      if (node) {
        const marks = node.getChildren("LinkMark");
        if (marks.length < 2) return { range };
        const label = state.sliceDoc(marks[0].to, marks[1].from);
        return {
          changes: { from: node.from, to: node.to, insert: label },
          range: EditorSelection.range(node.from, node.from + label.length),
        };
      }
      let { from, to } = range;
      if (from === to) {
        const word = state.wordAt(from);
        if (word) ({ from, to } = word);
      }
      if (from === to) {
        return { changes: { from, insert: "[]()" }, range: EditorSelection.cursor(from + 1) };
      }
      return {
        changes: [
          { from, insert: "[" },
          { from: to, insert: "]()" },
        ],
        range: EditorSelection.cursor(to + 3),
      };
    }),
  );
  return true;
};

/* Ctrl+1…6 set the ATX heading level (same level toggles it off), Ctrl+0
 * clears. Line-based; blank lines and code blocks are left alone. */
function setHeading(level: number): Command {
  return (view) => {
    const { state } = view;
    const changes: ChangeSpec[] = [];
    forEachSelectedLine(state, (line) => {
      if (!line.text.trim() || inCodeBlock(state, line.from)) return;
      const m = /^(#{1,6})\s+/.exec(line.text);
      const current = m ? m[1].length : 0;
      const target = level === current ? 0 : level;
      if (current === 0 && target === 0) return;
      const prefix = target ? "#".repeat(target) + " " : "";
      changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: prefix });
    });
    if (changes.length) view.dispatch({ changes });
    return true;
  };
}

/* Ctrl+Shift+8 / 7 / 9: bullet list, ordered list, blockquote — the same
 * prefix-diff discipline as setHeading: only marker bytes change, blank and
 * code-block lines are left alone. If every eligible line already has the
 * marker the toggle removes it; otherwise it applies to all (mixed selections
 * converge instead of flip-flopping). */
const bulletPrefixRe = /^(\s*)[-*+]\s+/;
const orderedPrefixRe = /^(\s*)\d+[.)]\s+/;

function eligibleLines(state: EditorState): Line[] {
  const lines: Line[] = [];
  forEachSelectedLine(state, (line) => {
    if (line.text.trim() && !inCodeBlock(state, line.from)) lines.push(line);
  });
  return lines;
}

function toggleList(kind: "bullet" | "ordered"): Command {
  const re = kind === "bullet" ? bulletPrefixRe : orderedPrefixRe;
  const other = kind === "bullet" ? orderedPrefixRe : bulletPrefixRe;
  return (view) => {
    const { state } = view;
    const lines = eligibleLines(state);
    if (!lines.length) return false;
    const allHave = lines.every((line) => re.test(line.text));
    const changes: ChangeSpec[] = [];
    let n = 0;
    let prev = -2;
    for (const line of lines) {
      if (line.number !== prev + 1) n = 0; // a gap (blank line) restarts numbering
      prev = line.number;
      const m = re.exec(line.text) ?? other.exec(line.text);
      const indent = m ? m[1].length : /^\s*/.exec(line.text)![0].length;
      if (allHave) {
        // off: the marker goes, and a task box glued to it goes with it
        const box = /^\[[ xX]\]\s+/.exec(line.text.slice(m![0].length));
        changes.push({
          from: line.from + indent,
          to: line.from + m![0].length + (box ? box[0].length : 0),
        });
      } else {
        const marker = kind === "bullet" ? "- " : `${++n}. `;
        changes.push({
          from: line.from + indent,
          to: line.from + (m ? m[0].length : indent),
          insert: marker,
        });
      }
    }
    view.dispatch({ changes });
    return true;
  };
}

const quoteRe = /^(\s*)>\s?/;

const toggleQuote: Command = (view) => {
  const { state } = view;
  const lines = eligibleLines(state);
  if (!lines.length) return false;
  const allHave = lines.every((line) => quoteRe.test(line.text));
  const changes: ChangeSpec[] = [];
  for (const line of lines) {
    const m = quoteRe.exec(line.text);
    if (allHave) changes.push({ from: line.from + m![1].length, to: line.from + m![0].length });
    else if (!m)
      changes.push({ from: line.from + /^\s*/.exec(line.text)![0].length, insert: "> " });
  }
  if (changes.length) view.dispatch({ changes });
  return true;
};

/* Ctrl+Enter: toggle task checkboxes on all selected lines; falls through to
 * the default (insert blank line) when no selected line is a task. */
const taskRe = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/;

const toggleTask: Command = (view) => {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  forEachSelectedLine(state, (line) => {
    const m = taskRe.exec(line.text);
    if (!m) return;
    const pos = line.from + m[1].length;
    changes.push({ from: pos, to: pos + 1, insert: m[2] === " " ? "x" : " " });
  });
  if (!changes.length) return false;
  view.dispatch({ changes });
  return true;
};

/* Tab / Shift+Tab: indent or outdent the list-item lines in the selection by
 * one indentUnit. Non-list lines stay byte-identical; outside lists the key
 * keeps its default behavior. */
const listLineRe = /^\s*(?:[-*+]|\d+[.)])\s/;

function changeListIndent(dir: 1 | -1): Command {
  return (view) => {
    const { state } = view;
    const unit = state.facet(indentUnit);
    const changes: ChangeSpec[] = [];
    let sawList = false;
    forEachSelectedLine(state, (line) => {
      if (!listLineRe.test(line.text)) return;
      sawList = true;
      if (dir === 1) {
        changes.push({ from: line.from, insert: unit });
      } else {
        const ws = /^[ \t]+/.exec(line.text)?.[0];
        if (!ws) return;
        const drop = ws[0] === "\t" ? 1 : Math.min(unit.length, ws.length);
        changes.push({ from: line.from, to: line.from + drop });
      }
    });
    if (!sawList) return false;
    if (changes.length) view.dispatch({ changes });
    return true;
  };
}

/* Pasting a URL over a selection produces [selection](url); plain paste
 * otherwise. Replaces lang-markdown's pasteURLAsLink so the transform can
 * never fire during composition. */
const urlRe = /^(?:https?:\/\/|www\.)\S+$/i;
const nonPlainText = /code|horizontalrule|html|link|comment|processing|escape|entity|image|mark|url/i;

function crossesFormatting(state: EditorState, from: number, to: number): boolean {
  let crosses = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (n) => {
      if (n.from > from || nonPlainText.test(n.name)) crosses = true;
    },
    leave: (n) => {
      if (n.to < to) crosses = true;
    },
  });
  return crosses;
}

/* Ctrl+Shift+V: paste with every smart handler suppressed — no link wrapping,
 * no image attach, just the clipboard text. WebView2 already treats the chord as
 * "paste without formatting", so the binding only has to arm the flag and let
 * the native paste through (returning false = not handled). Every editor that
 * transforms what you paste needs a documented way to say "not this time". */
let plainPasteUntil = 0;
const plainPastes = new WeakSet<ClipboardEvent>();

const armPlainPaste: Command = () => {
  plainPasteUntil = Date.now() + 1000;
  return false;
};

/** Is this paste event the one Ctrl+Shift+V armed? Latches per event. */
export function isPlainPaste(event: ClipboardEvent): boolean {
  if (plainPastes.has(event)) return true;
  if (Date.now() > plainPasteUntil) return false;
  plainPasteUntil = 0;
  plainPastes.add(event);
  return true;
}

export const smartUrlPaste = EditorView.domEventHandlers({
  paste(event, view) {
    if (imeBusy(view) || isPlainPaste(event)) return false;
    const { main } = view.state.selection;
    if (main.empty) return false;
    let url = (event.clipboardData?.getData("text/plain") ?? "").trim();
    if (!urlRe.test(url)) return false;
    if (/^www\./i.test(url)) url = `https://${url}`;
    if (crossesFormatting(view.state, main.from, main.to)) return false;
    view.dispatch({
      changes: [
        { from: main.from, insert: "[" },
        { from: main.to, insert: `](${url})` },
      ],
      userEvent: "input.paste",
      scrollIntoView: true,
    });
    return true;
  },
});

/* Typing a wrap character over a selection wraps it instead of replacing it —
 * the writer's reflex from every serious editor. The selection stays on the
 * text, so pressing `*` twice builds `**bold**`, `=` twice `==mark==`. Empty
 * carets in a multi-range selection just type the character. Never fires
 * during composition (hard IME constraint). */
const wrapPairs: Record<string, string> = {
  "*": "*",
  _: "_",
  "`": "`",
  "~": "~",
  "=": "=",
  "(": ")",
  "[": "]",
};

export const wrapSelectionOnType = EditorView.inputHandler.of((view, _from, _to, text) => {
  const close = wrapPairs[text];
  if (!close || imeBusy(view)) return false;
  const { state } = view;
  if (state.selection.ranges.every((r) => r.empty)) return false;
  view.dispatch(
    state.changeByRange((range) => {
      if (range.empty) {
        return {
          changes: { from: range.from, insert: text },
          range: EditorSelection.cursor(range.from + 1),
        };
      }
      return {
        changes: [
          { from: range.from, insert: text },
          { from: range.to, insert: close },
        ],
        range:
          range.head < range.anchor
            ? EditorSelection.range(range.to + 1, range.from + 1)
            : EditorSelection.range(range.from + 1, range.to + 1),
      };
    }),
    { userEvent: "input.type", scrollIntoView: true },
  );
  return true;
});

/* ── Enter ends the paragraph ─────────────────────────────────────────────
 *
 * A lone "\n" is a CommonMark *soft break*: the two lines stay one paragraph,
 * and with `.cm-line` padding at 0 they render flush — indistinguishable from
 * a wrap. So the app's most repeated gesture produced a file that disagreed
 * with the page it was showing, which is the one thing the rendered page is
 * not allowed to do (PROJECT: the reveal model). Enter now writes the blank
 * line the reader is already seeing.
 *
 * It is a fall-through, not a replacement: `continueMarkup` runs first, so
 * lists, quotes and fences keep byte-identical behaviour and only plain prose
 * reaches here. Shift+Enter is still the soft break (defaultKeymap binds it,
 * and this binding declares no `shift` variant).
 */

/* The list half of Enter, configured rather than stock. Unconfigured, this
 * command has `nonTightLists` on: pressing Enter on the blank second item of a
 * tight list takes its "make the two-item list non-tight" branch, which inserts
 * a blank line *above* and keeps the caret in the list. So `- one` ⏎ `- ` ⏎ —
 * the universal gesture for *leaving* a list — added a byte, loosened the list
 * and changed its spacing on screen, instead of ending it. Off, the blank item
 * is simply removed and the caret lands on a plain line. */
const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** Blocks a blank line would cut in half — there Enter stays a plain "\n". */
function breaksIfSplit(state: EditorState, pos: number): boolean {
  const fm = frontmatterInfo(state);
  if (fm && pos <= fm.to) return true;
  /* Side 1 looks *forward*, and at the end of the document nothing is: the
   * resolve lands above the block, so Enter on the last line of a fence or a
   * table wrote a paragraph break into it. Looking back is only right there —
   * at the start of a prose line directly after a closing fence, -1 resolves
   * back into the fence and Enter would become a soft break. */
  const side = pos === state.doc.length ? -1 : 1;
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);
  for (; node; node = node.parent) {
    if (/^(FencedCode|CodeBlock|Table|HTMLBlock)$/.test(node.name)) return true;
  }
  return false;
}

const paragraphBreak: Command = (view) => {
  const { state } = view;
  const { ranges } = state.selection;
  /* An empty line has no paragraph to end: Enter there is just air, and one
   * "\n" is the whole of it. Asked per range and at `from` — where the caret
   * lands — because a multi-range Enter must write at each caret what a lone
   * caret would write there. Reading `main.head` instead made the same gesture
   * write different bytes depending on which end you dragged from. */
  const endsParagraph = (at: number) => state.doc.lineAt(at).text.trim() !== "";
  if (!ranges.some((r) => endsParagraph(r.from))) return false;
  if (ranges.some((r) => breaksIfSplit(state, r.from) || breaksIfSplit(state, r.to))) {
    return false;
  }
  view.dispatch(
    state.changeByRange((range) => {
      const insert = endsParagraph(range.from) ? "\n\n" : "\n";
      return {
        changes: { from: range.from, to: range.to, insert },
        range: EditorSelection.cursor(range.from + insert.length),
      };
    }),
    { userEvent: "input", scrollIntoView: true },
  );
  return true;
};

/* Named commands — the context menu reuses the exact keymap behaviors. */
export const toggleBold = imeSafe(toggleInline("StrongEmphasis", "**"));
export const toggleItalic = imeSafe(toggleInline("Emphasis", "*"));
export const toggleStrike = imeSafe(toggleInline("Strikethrough", "~~"));
export const toggleInlineCode = imeSafe(toggleInline("InlineCode", "`"));
export const toggleLinkCommand = imeSafe(toggleLink);

export const markdownEditingKeymap: KeyBinding[] = [
  { key: "Enter", run: imeSafe((view) => continueMarkup(view) || paragraphBreak(view)) },
  { key: "Backspace", run: imeSafe(deleteMarkupBackward) },
  /* defaultKeymap binds Mod-Delete to deleteGroupForward — the Unix convention,
   * which leaves the whitespace after the word behind. This is a Windows-only
   * app; Windows eats that space too. Bound here rather than in extensions.ts
   * because this list runs ahead of defaultKeymap and gets the IME guard. */
  { key: "Mod-Delete", run: imeSafe(deleteGroupForwardWin) },
  /* …and the caret half of the same convention, which was left behind: without
   * this, Ctrl+Delete ate the trailing space while Ctrl+→ stopped before it, so
   * the two halves of one convention disagreed — worse than either applied
   * throughout. Stock `cursorGroupForward` also never had the IME guard. */
  {
    key: "Mod-ArrowRight",
    run: imeSafe(cursorGroupForwardWin),
    shift: imeSafe(selectGroupForwardWin),
  },
  { key: "Tab", run: imeSafe(changeListIndent(1)), shift: imeSafe(changeListIndent(-1)) },
  { key: "Mod-b", run: toggleBold },
  { key: "Mod-i", run: toggleItalic },
  { key: "Mod-Shift-x", run: toggleStrike },
  { key: "Mod-Shift-c", run: toggleInlineCode },
  { key: "Mod-k", run: toggleLinkCommand },
  { key: "Mod-Shift-v", run: armPlainPaste },
  { key: "Mod-Enter", run: imeSafe(toggleTask) },
  { key: "Mod-Shift-8", run: imeSafe(toggleList("bullet")) },
  { key: "Mod-Shift-7", run: imeSafe(toggleList("ordered")) },
  { key: "Mod-Shift-9", run: imeSafe(toggleQuote) },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({ key: `Mod-${level}`, run: imeSafe(setHeading(level)) })),
  { key: "Mod-0", run: imeSafe(setHeading(0)) },
];
