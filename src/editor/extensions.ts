import { EditorState, Facet, StateEffect } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  keymap,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { indentUnit, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { findBar, findKeymap } from "./findPanel";
import { sandyHighlightStyle } from "./highlight";
import { imeBusy, imeCompositionGuard } from "./imeGuard";
import { highlightMark } from "./highlightMark";
import { commentMark } from "./commentMark";
import { livePreview } from "./livePreview";
import {
  isPlainPaste,
  markdownEditingKeymap,
  smartUrlPaste,
  wrapSelectionOnType,
} from "./markdownKeymap";
import { pasteSanitizer } from "./pasteClean";
import { sandySelectionLayer } from "./selectionLayer";
import { isSourceRevealed, revealSourceKeymap, revealedSource } from "./revealSource";
import { isImageEmbed, wikiLink } from "./wikiLink";
import { frontmatterWikiLinkAt } from "./frontmatter";
import { DEFAULT_WRITING_MODES, type WritingModes, writingModes } from "./writingModes";

export interface WikiOptions {
  /** Follow a [[wiki-link]] — receives the raw inner text. */
  onFollow?: (inner: string) => void;
  /** Styles unresolved links; return true when no vault index exists yet. */
  isResolved?: (inner: string) => boolean;
  /** Open an external URL ([text](url) / <autolink>) in the system browser. */
  onOpenUrl?: (url: string) => void;
  /** Persist a pasted image; resolves to the rel path to insert, or null. */
  onAttachImage?: (data: ArrayBuffer, ext: string) => Promise<string | null>;
  /** Map a markdown image src to a displayable URL (note-relative → asset). */
  resolveImageSrc?: (src: string) => string;
}

export const wikiOptions = Facet.define<WikiOptions, WikiOptions>({
  combine: (values) => values[0] ?? {},
});

/** Dispatch after the vault index changes so unresolved marks recompute. */
export const vaultIndexChanged = StateEffect.define<null>();

export type LinkTarget =
  | { kind: "wiki"; from: number; to: number; inner: string }
  | { kind: "url"; from: number; to: number; url: string };

export function linkAt(state: EditorState, pos: number): LinkTarget | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 0);
  for (; node; node = node.parent) {
    if (node.name === "WikiLink" || node.name === "WikiEmbed") {
      const inner = state.sliceDoc(node.from + (node.name === "WikiEmbed" ? 3 : 2), node.to - 2);
      // an image embed renders as the picture itself; clicking it is not a
      // navigation, so it stops here rather than trying to open a .png as a note
      if (node.name === "WikiEmbed" && isImageEmbed(inner)) return null;
      return { kind: "wiki", from: node.from, to: node.to, inner };
    }
    /* A bare https://… is a URL node with no link parent (GFM autolink
     * literal): the text you typed is the whole link. livePreview styles it
     * like any other, so it has to open like any other — a link that only
     * looks like one is the gap this closes. Inside a real [text](url) the
     * walk reaches the Link node one step further out, which is what the
     * branch below wants. */
    if (node.name === "URL" && !/^(Link|Image|Autolink)$/.test(node.parent?.name ?? "")) {
      return { kind: "url", from: node.from, to: node.to, url: state.sliceDoc(node.from, node.to) };
    }
    if (node.name === "Link" || node.name === "Autolink") {
      const url = node.getChild("URL");
      if (!url) return null;
      return {
        kind: "url",
        from: node.from,
        to: node.to,
        url: state.sliceDoc(url.from, url.to),
      };
    }
  }
  return null;
}

export function externalHref(url: string): string | null {
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url;
  if (/^www\./i.test(url)) return `https://${url}`;
  /* <foo@bar.com>. livePreview's Autolink case hides the angle brackets
   * unconditionally, so a null here does not mean "plain text" — it means a
   * bare address sitting on the page with no style and no click, while the
   * export prints it as a live link. One clause, and every caller (the styling,
   * `linkAt`, the click) picks it up at once. */
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) return `mailto:${url}`;
  return null; // relative paths / anchors — nothing to open
}

/* Links open on plain click while rendered — which is now all of the time,
 * unless the block is showing its source under Ctrl+/, where a plain click
 * places the cursor so the label and the URL can be edited. Ctrl+Click always
 * follows. (To put the caret in a rendered link without opening it, arrow into
 * it, or click just past it.) */
const linkClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || event.shiftKey || event.altKey || event.metaKey) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    // Wiki-links live in frontmatter too — the syntax tree doesn't parse that
    // block, so match it directly before falling back to the tree walk.
    const fmLink = frontmatterWikiLinkAt(view.state, pos);
    if (fmLink) {
      if (!event.ctrlKey && isSourceRevealed(view.state, fmLink.from, fmLink.to)) return false;
      const { onFollow } = view.state.facet(wikiOptions);
      if (!onFollow) return false;
      event.preventDefault();
      onFollow(fmLink.inner);
      return true;
    }
    const link = linkAt(view.state, pos);
    if (!link) return false;
    if (!event.ctrlKey && isSourceRevealed(view.state, link.from, link.to)) return false;
    const { onFollow, onOpenUrl } = view.state.facet(wikiOptions);
    if (link.kind === "wiki") {
      if (!onFollow) return false;
      event.preventDefault();
      onFollow(link.inner);
      return true;
    }
    const href = externalHref(link.url);
    if (!href || !onOpenUrl) return false;
    event.preventDefault();
    onOpenUrl(href);
    return true;
  },
});

/* Alt+Enter follows the link under the caret — the keyboard twin of link-click.
 * Navigation only (never edits), but still IME-gated: dispatching a follow mid-
 * composition would blur the editor under the composition window. */
const followLinkUnderCaret = (view: EditorView): boolean => {
  if (imeBusy(view)) return false;
  const pos = view.state.selection.main.head;
  const { onFollow, onOpenUrl } = view.state.facet(wikiOptions);
  const fmLink = frontmatterWikiLinkAt(view.state, pos);
  if (fmLink) {
    if (!onFollow) return false;
    onFollow(fmLink.inner);
    return true;
  }
  const link = linkAt(view.state, pos);
  if (!link) return false;
  if (link.kind === "wiki") {
    if (!onFollow) return false;
    onFollow(link.inner);
    return true;
  }
  const href = externalHref(link.url);
  if (!href || !onOpenUrl) return false;
  onOpenUrl(href);
  return true;
};

/** Insert `![](rel)` at the selection. At a line end a newline follows, so the
 * caret leaves the image node and it renders immediately (edges are inclusive). */
export function insertImageMarkdown(view: EditorView, rel: string): void {
  if (imeBusy(view)) return;
  const { main } = view.state.selection;
  const atLineEnd = main.to === view.state.doc.lineAt(main.to).to;
  const insert = `![](${rel})` + (atLineEnd ? "\n" : "");
  view.dispatch({
    changes: { from: main.from, to: main.to, insert },
    selection: { anchor: main.from + insert.length },
    userEvent: "input.paste",
    scrollIntoView: true,
  });
}

/* Pasting a clipboard bitmap (screenshot) attaches it next to the note and
 * inserts the image markdown. Text-bearing pastes stay default; never fires
 * during composition (hard IME constraint). */
const imagePaste = EditorView.domEventHandlers({
  paste(event, view) {
    if (imeBusy(view) || isPlainPaste(event)) return false;
    const { onAttachImage } = view.state.facet(wikiOptions);
    if (!onAttachImage) return false;
    const dt = event.clipboardData;
    if (!dt || dt.getData("text/plain").trim()) return false;
    const file = Array.from(dt.files).find((f) => f.type.startsWith("image/"));
    if (!file) return false;
    event.preventDefault();
    const ext = file.type.slice("image/".length).replace(/\+.*$/, "").replace("jpeg", "jpg");
    void file.arrayBuffer().then(async (data) => {
      const rel = await onAttachImage(data, ext);
      if (rel && view.dom.isConnected) insertImageMarkdown(view, rel);
    });
    return true;
  },
});

export function editorExtensions(
  wiki: WikiOptions = {},
  modes: WritingModes = DEFAULT_WRITING_MODES,
) {
  return [
    history(),
    /* The doc IS the file (LF-normalized by loadDoc). Without an explicit
     * separator CM6 also splits on lone \r, silently promoting a pasted
     * stray \r to a line break the save then rewrites — a byte change the
     * user never made. Pin splitting to \n and normalize the only two entry
     * points for foreign line endings (paste + drop) at the door. */
    EditorState.lineSeparator.of("\n"),
    EditorView.clipboardInputFilter.of((text) => text.replace(/\r\n?/g, "\n")),
    /* Kept for its caret layer only — its selection layer is display:none in
     * editor.css and the native ::selection it hides is re-enabled there.
     * Text is the browser's to paint; this layer paints the two things the
     * browser can't: a grid table row (by the cell) and any range that isn't
     * selection.main. specs/selection-model.md. */
    drawSelection(),
    sandySelectionLayer(),
    // column (rectangular) selection on Alt+drag; crosshair cursor while Alt is held
    rectangularSelection(),
    crosshairCursor(),
    // Track native composition so decoration plugins can freeze during IME
    // input; must sit ahead of livePreview.
    imeCompositionGuard(),
    EditorState.allowMultipleSelections.of(true),
    /* Windows' own spellchecker. CM6 hard-sets `spellcheck:"false"` on the
     * content DOM, and nothing here ever said otherwise — so Sandy shipped
     * without a squiggle at all. This is the OS checker (WebView2), not a
     * bundled dictionary: nothing to download, nothing to configure, and it
     * knows the user's own languages. `autocorrect`/`autocapitalize` stay off
     * where CM6 left them — those rewrite bytes the author didn't type. The
     * corrections themselves live in the native context menu, which
     * Shift+right-click reaches (App.tsx). */
    EditorView.contentAttributes.of({ spellcheck: "true" }),
    EditorView.lineWrapping,
    indentUnit.of("  "),
    /* lang-markdown's bundled keymap and URL-paste handler are disabled and
     * re-bound through IME-guarded wrappers in markdownKeymap.ts */
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      extensions: [wikiLink, highlightMark, commentMark],
      addKeymap: false,
      pasteURLAsLink: false,
    }),
    syntaxHighlighting(sandyHighlightStyle),
    wikiOptions.of(wiki),
    linkClick,
    imagePaste,
    smartUrlPaste,
    wrapSelectionOnType,
    // last in the paste chain: image + URL-over-selection have already claimed
    // their events, so this only ever sanitizes an ordinary text paste
    pasteSanitizer,
    // the rendered page never opens at the caret; this field is the one
    // deliberate exception, and livePreview reads it (revealSource.ts)
    revealedSource,
    livePreview,
    writingModes(modes),
    findBar,
    /* Breathing room: the typed line never hugs the window edges. This is
     * `cursorScrollMargin` and not `scrollMargins`, whose own doc says it is
     * for extensions that *cover* the scroller (a fixed gutter) and adds "Not
     * to be confused with cursorScrollMargin". Nothing here covers the text —
     * the corner panel sits in the right gutter, outside the measure — and the
     * old 64/128 pair was asymmetric, which shrinks the visible rect unevenly:
     * `scrollIntoView(head, {y:"center"})` then settled the caret ~32px above
     * the true centre, permanently, in the one mode whose entire premise is
     * that the line sits in the middle. Symmetric, so a centre stays a centre. */
    EditorView.cursorScrollMargin.of(64),
    keymap.of([
      { key: "Alt-Enter", run: followLinkUnderCaret },
      ...revealSourceKeymap,
      ...findKeymap,
      ...markdownEditingKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
  ];
}
