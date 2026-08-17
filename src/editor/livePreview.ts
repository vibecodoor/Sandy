import type { Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";
import {
  BoolWidget,
  CalloutLabelWidget,
  CheckboxWidget,
  HRWidget,
  ImageWidget,
  markEditMoment,
} from "./widgets";
import { externalHref, vaultIndexChanged, wikiOptions } from "./extensions";
import { frozenDuringComposition, isImeSafeFlushTransaction } from "./imeGuard";
import { frontmatterInfo } from "./frontmatter";
import { type SmartHit, scanSmartTypography } from "./typography";
import { embedTarget, isImageEmbed } from "./wikiLink";
import { revealedSource } from "./revealSource";
import { applyWritingModes, writingModesField } from "./writingModes";

/*
 * Live preview: hide Markdown syntax. All of it, all of the time.
 *
 * The caret is not a reveal trigger. Clicking into a table, a bold word, a
 * heading or a link leaves the page exactly as it was rendered — the document
 * you are editing looks like the document you are reading, which is the whole
 * promise of this editor. Only an explicit Ctrl+/ opens one block's raw source
 * (revealSource.ts); `activeLines` / `revealsSource` below are that block and
 * nothing else.
 *
 * The consequence worth knowing: decorations no longer depend on the selection
 * at all, so moving the caret rebuilds nothing and text can never reflow under
 * a pointer that is mid-drag.
 *
 * The document text is never altered — decorations only.
 */

const hidden = Decoration.replace({});

/* Obsidian-style callouts: "> [!type] Title" renders as an accented aside.
 * Any type is accepted; unknown ones borrow the note styling. */
const CALLOUT_KIND: Record<string, string> = {
  note: "note",
  example: "note",
  info: "info",
  todo: "info",
  abstract: "info",
  summary: "info",
  tldr: "info",
  tip: "tip",
  hint: "tip",
  important: "tip",
  success: "tip",
  check: "tip",
  done: "tip",
  warning: "warning",
  caution: "warning",
  attention: "warning",
  question: "warning",
  help: "warning",
  faq: "warning",
  danger: "danger",
  error: "danger",
  bug: "danger",
  failure: "danger",
  fail: "danger",
  missing: "danger",
  quote: "quote",
  cite: "quote",
};
/* The trailing [-+] is Obsidian's foldable-callout marker. Sandy has no folding,
 * but the marker must still disappear with the rest of the token — left in, it
 * renders as a stray "- " at the head of every folded callout in an imported
 * vault. Unsupported syntax degrades quietly or it isn't supported at all. */
/* The prefix is every ">" the line opens with, not one: `^(\s*>\s*)` cannot eat
 * the second marker of a nested `> > [!warning]`, and a callout this regex
 * misses does not degrade to plain text — the `[!warning]` token falls through
 * to the Link case below and paints an accent-underlined link. */
const CALLOUT_RE = /^(\s*(?:>\s*)+)(\[!(\w+)\][-+]?)([ \t]*)(.*)$/;

/* Text metrics for the list hanging indent.
 * Column counts can't be used here: `ch` is the width of "0", while a space is
 * roughly half that in a proportional face, so a column-derived offset lands
 * about twice too far right. Measuring the real prefix in the editor's own font
 * is exact, and a cached canvas context keeps it off the layout path — no
 * per-line getComputedStyle, no forced reflow. */
let metricsCtx: CanvasRenderingContext2D | null = null;
let metricsEm = 0;

/* A table cell is not the prose face: mirrors of editor.css's `.md-table-row`
 * font-size, `.md-table-cell` padding, and the `.md-inline-code` pill. Column
 * floors are measured in these, so a cell's own font decides its width. */
const CELL_SCALE = 0.9;
const CELL_PAD_X = 0.72;
const CELL_CODE_SCALE = 0.82;
const CELL_CODE_PAD_X = 0.32;

let cellCtx: CanvasRenderingContext2D | null = null;
let cellCodeCtx: CanvasRenderingContext2D | null = null;
let cellEm = 0;
let cellFonts = "";

function refreshMetrics(view: EditorView): void {
  metricsCtx ??= document.createElement("canvas").getContext("2d");
  if (!metricsCtx) return;
  const cs = getComputedStyle(view.contentDOM);
  // built from parts: the `font` shorthand is not reliably serialized
  metricsCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  metricsEm = Number.parseFloat(cs.fontSize) || 0;

  cellCtx ??= document.createElement("canvas").getContext("2d");
  cellCodeCtx ??= document.createElement("canvas").getContext("2d");
  cellEm = metricsEm * CELL_SCALE;
  // the two families never change; reading them once keeps a second
  // getComputedStyle off every build
  if (!cellFonts) {
    const root = getComputedStyle(document.documentElement);
    cellFonts = `${root.getPropertyValue("--font-ui").trim()}|${root
      .getPropertyValue("--font-mono")
      .trim()}`;
  }
  const [ui, mono] = cellFonts.split("|");
  // 650 is the header weight — the widest a cell is ever set, and the safe side
  // to reserve from
  if (cellCtx) cellCtx.font = `650 ${cellEm}px ${ui}`;
  if (cellCodeCtx) cellCodeCtx.font = `${cellEm * CELL_CODE_SCALE}px ${mono}`;
}

function textWidth(text: string): number {
  return metricsCtx ? metricsCtx.measureText(text).width : 0;
}

/* The widest single word a table column must show without breaking it. Column
 * weights below are proportional (`fr`), and nothing in a proportion stops a
 * short column from being squeezed under its own header — which is how a "Rank"
 * header came out as "Ran / k". Measured from the real glyphs, so it holds for
 * any table in any font. A cell carrying inline code is measured in the mono
 * pill too: the pad is real width the UI face doesn't account for. */
function widestCellWord(text: string, hasCode: boolean): number {
  let widest = 0;
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    const plain = cellCtx ? cellCtx.measureText(word).width : 0;
    const code =
      hasCode && cellCodeCtx
        ? cellCodeCtx.measureText(word).width + 2 * CELL_CODE_PAD_X * CELL_CODE_SCALE * cellEm
        : 0;
    widest = Math.max(widest, plain, code);
  }
  return widest;
}

/* Nodes whose text is syntax or verbatim content — smart typography must not
 * touch them (`--` inside a URL, quotes inside code, a setext `---` underline). */
const NO_SMART_NODE =
  /^(FencedCode|CodeBlock|CodeText|InlineCode|CodeMark|CodeInfo|URL|Escape|Entity|HTMLTag|HTMLBlock|Autolink|WikiLink|WikiEmbed|Image|MdComment|HeaderMark|TableDelimiter|LinkTitle)$/;

/* The OS spellchecker runs over the whole document (extensions.ts) — correct
 * for prose, wrong for everything that isn't a word. An address, a code span,
 * a [[target]] and a frontmatter key are not misspelled English, and a page
 * where every link wears a red wave reads as broken rather than as careful.
 * Same idea as NO_SMART_NODE above, for the other pass that walks this text.
 * A link's *label* is prose and keeps the check; only its hidden URL doesn't,
 * and it is hidden, so it is not in the DOM to check. */
const NO_SPELL = { spellcheck: "false" };

/**
 * Where the build looks, for a caller that is not the viewport.
 *
 * `ranges` defaults to `view.visibleRanges` — the plugin's own case, and the
 * reason the walk is bounded at all (a card's spacer decoration lands on the
 * line outside it, so the plugin passes ±1 line of slack; see the walk below).
 *
 * `tree` matters only for a whole-document caller: `syntaxTree(state)` returns
 * the *state field's* tree, which the background worker only advances to about
 * the viewport, and iterating past its end yields nothing at all — silently.
 * A caller that asks about the whole document must hand in a tree that reaches
 * it (`ensureSyntaxTree`), or it will be told the tail contains no markup.
 */
export type BuildScope = {
  ranges?: readonly { from: number; to: number }[];
  tree?: Tree;
};

/**
 * `atomicOut`, when given, collects every replace range this build produced —
 * the spans that are on screen as nothing, or as a widget. They feed
 * `EditorView.atomicRanges` so the caret steps over hidden markup instead of
 * through it: without that, an arrow key looked dead for the length of a
 * hidden URL, and Backspace at a link's edge silently ate its closing ")".
 */
export function buildDecorations(
  view: EditorView,
  atomicOut?: Range<Decoration>[],
  scope?: BuildScope,
): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const { state } = view;
  const { doc } = state;
  /* The viewport bound lives here, in the caller's argument — not in any rule
   * below. That is what lets `visibleText.ts` run these exact rules over the
   * whole document to answer "is this text on screen?" without a second copy
   * of them (see BuildScope). */
  const walkRanges = scope?.ranges ?? view.visibleRanges;
  const tree = scope?.tree ?? syntaxTree(state);
  refreshMetrics(view);
  /* Every replace-decoration range, recorded as it is added. Smart typography
   * runs last and skips anything already replaced — two overlapping replace
   * ranges are a hard CM6 error, and this is the only way to be certain, since
   * hidden spans (a link's `](url)`, a hidden alias) don't map to single nodes. */
  const replacedRanges: Array<[number, number]> = [];
  const noSmart: Array<[number, number]> = [];
  const pushReplace = (from: number, to: number, deco: Decoration) => {
    decos.push(deco.range(from, to));
    replacedRanges.push([from, to]);
    if (from < to) atomicOut?.push(hidden.range(from, to));
  };
  const hide = (from: number, to: number) => pushReplace(from, to, hidden);

  /* The one block the user asked to see the source of (Ctrl+/), if any — the
   * only thing in this file that is ever left un-rendered. */
  const revealed = state.field(revealedSource, false) ?? null;
  const activeLines = new Set<number>();
  if (revealed) {
    const last = doc.lineAt(revealed.to).number;
    for (let n = doc.lineAt(revealed.from).number; n <= last; n++) activeLines.add(n);
  }
  const lineActive = (pos: number) => activeLines.has(doc.lineAt(pos).number);
  const revealsSource = (from: number, to: number) =>
    revealed != null && revealed.from <= to && revealed.to >= from;

  const tableAlignments = (separator: SyntaxNode | null) => {
    if (!separator) return [];
    const source = state.sliceDoc(separator.from, separator.to).trim();
    const body = source.replace(/^\|/, "").replace(/\|$/, "");
    return body.split("|").map((cell) => {
      const value = cell.trim();
      if (value.startsWith(":") && value.endsWith(":")) return "center";
      if (value.endsWith(":")) return "right";
      return "left";
    });
  };

  const tableRowLayout = (row: SyntaxNode) => {
    const delimiters = row.getChildren("TableDelimiter");
    const source = state.sliceDoc(row.from, row.to);
    const first = source.search(/\S/);
    const last = source.search(/\S\s*$/);
    const leading =
      first >= 0 && delimiters.some((delimiter) => delimiter.from === row.from + first);
    const trailing =
      last >= 0 && delimiters.some((delimiter) => delimiter.from === row.from + last);
    return {
      delimiters,
      leading,
      columns: Math.max(1, delimiters.length + 1 - Number(leading) - Number(trailing)),
    };
  };

  const tableCellColumn = (
    layout: ReturnType<typeof tableRowLayout>,
    cell: SyntaxNode,
  ) =>
    layout.delimiters.filter((delimiter) => delimiter.from < cell.from).length +
    (layout.leading ? 0 : 1);

  /* Breathing room around a card (table, callout) is padding on the lines
   * around it — never a margin on the block's own lines. CM6 sizes every line
   * from its border box, so a margin is space the height map never learns
   * about: each click, drag-selection, and vertical caret move below the block
   * lands off by exactly that much. A table's two margins put everything after
   * it two thirds of a row out — which is what made its cells feel unclickable
   * (the caret landed in the row below the one under the pointer). */
  const spaceBefore = (firstLine: number, kind: string) => {
    if (firstLine > 1) {
      decos.push(
        Decoration.line({ class: `md-space-before-${kind}` }).range(doc.line(firstLine - 1).from),
      );
    }
  };
  const spaceAfter = (lastLine: number, kind: string) => {
    if (lastLine < doc.lines) {
      decos.push(
        Decoration.line({ class: `md-space-after-${kind}` }).range(doc.line(lastLine + 1).from),
      );
    }
  };

  const tableCellText = (cell: SyntaxNode) =>
    state
      .sliceDoc(cell.from, cell.to)
      // an image is visible content even with empty alt — never measure it as
      // an empty cell (a trailing all-"image" column must not be dropped)
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => alt || "□")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/[*_~`]/g, "")
      .replace(/\\([|\\])/g, "$1")
      .trim();

  const decorateTable = (table: SyntaxNode) => {
    const header = table.getChild("TableHeader");
    const rows = [
      ...(header ? [header] : []),
      ...table.getChildren("TableRow"),
    ];
    if (!rows.length) return;

    const layouts = rows.map(tableRowLayout);
    let columns = Math.max(...layouts.map((layout) => layout.columns));
    const separator = table.getChild("TableDelimiter");
    const alignments = tableAlignments(separator);
    const columnWidths = new Array<number>(columns).fill(0);
    const columnFloors = new Array<number>(columns).fill(0);

    rows.forEach((row, rowIndex) => {
      for (const cell of row.getChildren("TableCell")) {
        const column = tableCellColumn(layouts[rowIndex], cell);
        const text = tableCellText(cell);
        const visibleLength = Array.from(text).length;
        columnWidths[column - 1] = Math.max(
          columnWidths[column - 1],
          visibleLength + (row === header ? 1 : 0),
        );
        columnFloors[column - 1] = Math.max(
          columnFloors[column - 1],
          widestCellWord(text, state.sliceDoc(cell.from, cell.to).includes("`")),
        );
      }
    });

    while (columns > 1 && columnWidths[columns - 1] === 0) columns -= 1;
    const columnWeights = columnWidths
      .slice(0, columns)
      .map((width) => Math.min(28, Math.max(6, width)));
    /* Each track carries a floor: its widest word plus the cell's padding, so a
     * column can never be narrower than a word it has to show. `min(…, equal
     * share)` caps every floor at 100/n % of the card, so the floors can never
     * add up past the card's own width — a table overflows its box for no
     * table, and a word that is genuinely wider than a fair share wraps. */
    const share = (100 / columns).toFixed(3);
    const template = columnWeights
      .map((weight, index) => {
        const floor = Math.ceil(columnFloors[index] + 2 * CELL_PAD_X * cellEm) + 1;
        return `minmax(min(${floor}px, ${share}%), ${weight}fr)`;
      })
      .join(" ");
    const totalWeight = columnWeights.reduce((sum, weight) => sum + weight, 0);
    let runningWeight = 0;
    const dividers = columnWeights
      .slice(0, -1)
      .map((weight) => {
        runningWeight += weight;
        const position = ((runningWeight / totalWeight) * 100).toFixed(3);
        return `linear-gradient(to right, transparent calc(${position}% - 0.5px), var(--rule) calc(${position}% - 0.5px), var(--rule) calc(${position}% + 0.5px), transparent calc(${position}% + 0.5px))`;
      })
      .join(", ");

    rows.forEach((row, rowIndex) => {
      const layout = layouts[rowIndex];
      const line = doc.lineAt(row.from);
      const active = lineActive(row.from);
      /* Editing a row does not open it: the grid stays, the caret sits in the
       * cell it landed in, and the pipes stay hidden. Only Ctrl+/ shows the raw
       * row — and even then it keeps the card: same box, same face, same
       * height, only the grid is off, so nothing around it jumps. */
      const classes = [
        "md-table-row",
        row === header ? "md-table-header" : "",
        rowIndex === rows.length - 1 ? "md-table-row-last" : "",
        active ? "md-table-source" : "",
      ]
        .filter(Boolean)
        .join(" ");
      decos.push(
        Decoration.line({
          class: classes,
          attributes: {
            style: `--md-table-template: ${template}; --md-table-dividers: ${dividers || "none"}`,
          },
        }).range(line.from),
      );

      if (active) {
        // Register it so the generic inline walk below doesn't keep previewing
        // emphasis/links inside it — a half-raw, half-rendered row reads as
        // corruption (a real defect once — don't regress it).
        activeTableRows.push([row.from, row.to]);
        return;
      }

      /* Every direct child of the row must be a placed grid cell. A hidden "|"
       * left at the top level is a bare span, which grid auto-places into an
       * implicit row *below* the cells — and CM6 reads that span's rect back for
       * coordsAtPos, so the caret at a row's end, and every selection rectangle
       * that touches a delimiter, landed outside the row. Each cell mark is
       * therefore widened to swallow the delimiter in front of it (the last one
       * also swallows the row's tail), which nests those spans inside a cell. */
      const cells = row
        .getChildren("TableCell")
        .filter((cell) => tableCellColumn(layout, cell) <= columns);
      let cursor = line.from;
      cells.forEach((cell, index) => {
        const last = index === cells.length - 1;
        // the tail — trailing "|" plus any columns dropped as empty — is hidden
        // inside the last cell rather than after it
        const to = last ? line.to : cell.to;
        if (cursor < cell.from) hide(cursor, cell.from);
        if (last && cell.to < line.to) hide(cell.to, line.to);
        if (to <= cursor) return; // an empty cell claims no track
        const column = tableCellColumn(layout, cell);
        const alignment = alignments[column - 1] ?? "left";
        decos.push(
          Decoration.mark({
            inclusive: true,
            attributes: {
              class: `md-table-cell md-table-cell-${alignment}`,
              style: `grid-column: ${column}; grid-row: 1`,
            },
          }).range(cursor, to),
        );
        cursor = to;
      });
      if (cursor < line.to) {
        // nothing but delimiters on this row: one empty cell keeps the grid honest
        decos.push(
          Decoration.mark({
            inclusive: true,
            attributes: {
              class: "md-table-cell md-table-cell-left",
              style: "grid-column: 1; grid-row: 1",
            },
          }).range(cursor, line.to),
        );
        hide(cursor, line.to);
      }
    });

    if (separator) {
      const sepLine = doc.lineAt(separator.from);
      if (lineActive(separator.from)) {
        // under Ctrl+/ the alignment row becomes visible and editable, and the
        // card doesn't open a gap while it is
        const bare = rows.length === 1; // a table still being typed: no body yet
        decos.push(
          Decoration.line({
            class: `md-table-row md-table-source${bare ? " md-table-row-last" : ""}`,
          }).range(sepLine.from),
        );
      } else {
        decos.push(Decoration.line({ class: "md-table-divider" }).range(sepLine.from));
        hide(separator.from, separator.to);
      }
    }

    // the whole node, not the last body row: while a table is still being typed
    // its last line is the alignment row, and the spacer must not land inside
    // the card (a collapsed divider with padding would prise it open)
    spaceBefore(doc.lineAt(table.from).number, "table");
    spaceAfter(doc.lineAt(Math.max(table.from, table.to - 1)).number, "table");
  };

  /* Hide a mark plus one trailing space, if present; returns the position the
   * line's visible text resumes at. */
  const hideMark = (from: number, to: number) => {
    if (doc.sliceString(to, to + 1) === " ") to += 1;
    hide(from, to);
    return to;
  };

  const decoratedTables = new Set<number>();
  /* Same reason as decoratedTables: a block that spans lines can overlap two
   * of the walk's ranges, and hiding its fences twice is two identical replace
   * ranges — a hard CM6 error, not a cosmetic one. */
  const decoratedFences = new Set<number>();
  const activeTableRows: Array<[number, number]> = [];
  const inActiveTableRow = (from: number, to: number) =>
    activeTableRows.some(([f, t]) => from >= f && to <= t);

  /* YAML frontmatter → a quiet properties card. Decoration only: the bytes
   * never change, and the card stays a card while you type in it — Ctrl+/ shows
   * the raw YAML. Nodes fully inside the block are skipped in the walk below, so the
   * default parser can't render the fences as a rule / setext heading. */
  let fmEnd = -1;
  const fm = frontmatterInfo(state);
  if (fm) {
    fmEnd = fm.to;
    const { isResolved } = state.facet(wikiOptions);
    for (let n = 1; n <= fm.toLine; n++) {
      const line = doc.line(n);
      const active = activeLines.has(n);
      const fence = n === 1 || n === fm.toLine;
      let cls = "md-frontmatter";
      if (n === 1) cls += " md-frontmatter-first";
      if (n === fm.toLine) cls += " md-frontmatter-last";
      if (fence && !active) cls += " md-frontmatter-rule";
      decos.push(Decoration.line({ class: cls }).range(line.from));
      if (fence || active) continue;

      const text = line.text;
      const indent = text.length - text.trimStart().length;
      const colon = text.indexOf(":");
      if (colon > indent && /^[\w.$-]+$/.test(text.slice(indent, colon))) {
        decos.push(
          Decoration.mark({ class: "md-frontmatter-key", attributes: NO_SPELL }).range(
            line.from + indent,
            line.from + colon,
          ),
        );
        // a bare true/false value renders as a clickable checkbox — the click
        // flips just that literal token (BoolWidget), like a task checkbox
        const after = text.slice(colon + 1);
        const value = after.trim();
        if (value === "true" || value === "false") {
          const vFrom = line.from + colon + 1 + (after.length - after.trimStart().length);
          // through pushReplace, like every other replace: the literal is on
          // screen as a checkbox, so the caret must cross it in one press and
          // Backspace must take the whole word rather than leaving "tru"
          pushReplace(
            vFrom,
            vFrom + value.length,
            Decoration.replace({ widget: new BoolWidget(value === "true") }),
          );
        }
      }
      // wiki-links in a value render like anywhere else — Tolaria's "relations
      // live in plain frontmatter", distilled to just: the link works.
      const re = /\[\[([^\]\n]+)\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const from = line.from + m.index;
        const to = from + m[0].length;
        const inner = m[1];
        const linkCls =
          isResolved && !isResolved(inner)
            ? "md-wikilink md-wikilink-unresolved"
            : "md-wikilink";
        decos.push(
          Decoration.mark({ class: linkCls, attributes: NO_SPELL }).range(from, to),
        );
        const pipe = inner.indexOf("|");
        hide(from, from + 2);
        if (pipe >= 0) hide(from + 2, from + 2 + pipe + 1);
        hide(to - 2, to);
      }
    }
  }

  /* One line of slack each way. A card's spacer decoration lands on the line
   * *outside* the card, so a table whose first line sat just past the fold left
   * its neighbour un-padded until it scrolled in — and the padding then appeared
   * and shoved the page under the reader by up to 17px, mid-scroll. One line is
   * exactly enough: a spacer is never further than that from its card. */
  // two ranges must not walk the same node twice — duplicate replace ranges
  // are a hard CM6 error
  let walked = 0;
  for (const { from, to } of walkRanges) {
    const start = Math.max(walked, doc.line(Math.max(1, doc.lineAt(from).number - 1)).from);
    const end = doc.line(Math.min(doc.lines, doc.lineAt(to).number + 1)).to;
    if (end <= start) continue;
    walked = end;
    tree.iterate({
      from: start,
      to: end,
      enter: (node) => {
        const name = node.name;

        // Inside frontmatter the block above owns every decoration; skip the
        // node and its subtree so no rule/setext/emphasis leaks through.
        if (fmEnd >= 0 && node.to <= fmEnd) return false;

        if (NO_SMART_NODE.test(name)) noSmart.push([node.from, node.to]);

        if (name === "Table") {
          if (!decoratedTables.has(node.from)) {
            decoratedTables.add(node.from);
            decorateTable(node.node);
          }
          // Keep walking: inline links/emphasis inside cells use the same preview rules.
          return;
        }

        /* Setext headings had no case at all: the `===`/`---` underline stayed on
         * the page as a literal row and the title got none of the --h-above /
         * --h-below air, while the export emitted a proper <h1>. The face comes
         * from the highlight style either way; what is added here is the ladder
         * on the title's line and the underline's disappearance. The row it
         * leaves behind is collapsed by .md-setext-rule the way a table's
         * alignment row is — otherwise hiding the marker only trades a line of
         * "===" for a blank one. */
        if (name.startsWith("SetextHeading")) {
          const level = name.charAt(name.length - 1);
          const line = doc.lineAt(node.from);
          decos.push(
            Decoration.line({ class: `md-hline md-hline-${level}` }).range(line.from),
          );
          const mark = node.node.getChild("HeaderMark");
          if (mark) {
            const rule = doc.lineAt(mark.from);
            if (!activeLines.has(line.number) && !activeLines.has(rule.number)) {
              hideMark(mark.from, mark.to);
              decos.push(Decoration.line({ class: "md-setext-rule" }).range(rule.from));
            }
          }
          return;
        }

        if (name.startsWith("ATXHeading")) {
          const level = name.charAt(name.length - 1);
          const line = doc.lineAt(node.from);
          decos.push(
            Decoration.line({ class: `md-hline md-hline-${level}` }).range(line.from),
          );
          if (!activeLines.has(line.number)) {
            const mark = node.node.getChild("HeaderMark");
            if (mark) hideMark(mark.from, mark.to);
          }
          return;
        }

        switch (name) {
          case "Emphasis":
          case "StrongEmphasis":
          case "Strikethrough": {
            if (inActiveTableRow(node.from, node.to)) return;
            if (revealsSource(node.from, node.to)) return;
            const markName =
              name === "Strikethrough" ? "StrikethroughMark" : "EmphasisMark";
            for (const mark of node.node.getChildren(markName)) {
              hide(mark.from, mark.to);
            }
            return;
          }

          case "Highlight": {
            if (inActiveTableRow(node.from, node.to)) return;
            decos.push(
              Decoration.mark({ class: "md-highlight" }).range(node.from, node.to),
            );
            if (revealsSource(node.from, node.to)) return;
            for (const mark of node.node.getChildren("HighlightMark")) {
              hide(mark.from, mark.to);
            }
            return;
          }

          case "InlineCode": {
            if (inActiveTableRow(node.from, node.to)) return;
            decos.push(
              Decoration.mark({ class: "md-inline-code", attributes: NO_SPELL }).range(
                node.from,
                node.to,
              ),
            );
            if (revealsSource(node.from, node.to)) return;
            for (const mark of node.node.getChildren("CodeMark")) {
              hide(mark.from, mark.to);
            }
            return;
          }

          case "Escape": {
            /* `\*` is one escaped character, and the backslash is its markup —
             * markdown-it drops it, while lezer styles the pair `tags.escape`,
             * so the screen showed a backslash in the string colour. Only the
             * marker goes; the character it protects is content. */
            if (lineActive(node.from)) return;
            hide(node.from, node.from + 1);
            return;
          }

          case "LinkReference": {
            /* `[r]: https://…` is a definition, not content: markdown-it consumes
             * it and prints nothing. With no case here the whole line showed —
             * and its URL child reached the `URL` rule below, so the definition
             * carried a live accent link. Hidden whole, and the subtree is
             * skipped so nothing inside it decorates itself back into view. */
            if (revealsSource(node.from, node.to)) return false;
            hide(node.from, node.to);
            return false;
          }

          case "Link": {
            if (inActiveTableRow(node.from, node.to)) return;
            decos.push(Decoration.mark({ class: "md-link" }).range(node.from, node.to));
            if (revealsSource(node.from, node.to)) return;
            const marks = node.node.getChildren("LinkMark");
            if (marks.length >= 2) {
              hide(marks[0].from, marks[0].to);
              hide(marks[1].from, node.to);
            }
            return;
          }

          case "Autolink": {
            /* <https://…> — the angle brackets are markup like any other pair,
             * and the address inside them is its own label. Ctrl+/ on the line
             * brings them back; nothing else about the link is hidden. */
            if (inActiveTableRow(node.from, node.to)) return;
            const url = node.node.getChild("URL");
            if (url && externalHref(state.sliceDoc(url.from, url.to))) {
              decos.push(
                Decoration.mark({ class: "md-autolink", attributes: NO_SPELL }).range(
                  node.from,
                  node.to,
                ),
              );
            }
            if (revealsSource(node.from, node.to)) return;
            for (const mark of node.node.getChildren("LinkMark")) hide(mark.from, mark.to);
            return;
          }

          case "URL": {
            /* A pasted https://… parses as a bare URL node with no link parent
             * (GFM autolink literal) — until now the one address on the page
             * that read as prose while every other link was styled and
             * clickable. Nothing is hidden here: the URL *is* the label, so
             * this adds no reveal debt. Styled only when it actually opens
             * (externalHref), so it never looks like a link that does nothing;
             * `linkAt` in extensions.ts follows the same rule for the click. */
            const parent = node.node.parent?.name ?? "";
            if (parent === "Link" || parent === "Image" || parent === "Autolink") return;
            if (inActiveTableRow(node.from, node.to)) return;
            if (!externalHref(state.sliceDoc(node.from, node.to))) return;
            decos.push(
              Decoration.mark({ class: "md-autolink", attributes: NO_SPELL }).range(
                node.from,
                node.to,
              ),
            );
            return;
          }

          case "Image": {
            if (inActiveTableRow(node.from, node.to)) return;
            if (revealsSource(node.from, node.to)) return;
            const url = node.node.getChild("URL");
            if (!url) return;
            const raw = state.sliceDoc(url.from, url.to);
            const { resolveImageSrc } = state.facet(wikiOptions);
            const src = resolveImageSrc ? resolveImageSrc(raw) : raw;
            const alt =
              /^!\[([^\]]*)\]/.exec(state.sliceDoc(node.from, node.to))?.[1] ?? "";
            pushReplace(
              node.from,
              node.to,
              Decoration.replace({ widget: new ImageWidget(src, alt) }),
            );
            return;
          }

          case "MdComment": {
            if (inActiveTableRow(node.from, node.to)) return;
            // revealed: the whole comment shows, faint. Otherwise it disappears
            // from the page while staying in the file.
            if (revealsSource(node.from, node.to)) {
              decos.push(
                Decoration.mark({ class: "md-comment" }).range(node.from, node.to),
              );
              return;
            }
            hide(node.from, node.to);
            return;
          }

          case "WikiLink":
          case "WikiEmbed": {
            if (inActiveTableRow(node.from, node.to)) return;
            const embed = name === "WikiEmbed";
            const open = embed ? 3 : 2; // "![[" vs "[["
            const inner = state.sliceDoc(node.from + open, node.to - 2);
            const showSource = revealsSource(node.from, node.to);

            if (embed && isImageEmbed(inner)) {
              // ![[picture.png]] renders like any other image
              if (showSource) return;
              const { resolveImageSrc } = state.facet(wikiOptions);
              const target = embedTarget(inner);
              const pipe = inner.indexOf("|");
              pushReplace(
                node.from,
                node.to,
                Decoration.replace({
                  widget: new ImageWidget(
                    resolveImageSrc ? resolveImageSrc(target) : target,
                    pipe >= 0 ? inner.slice(pipe + 1) : "",
                  ),
                }),
              );
              return;
            }

            /* Everything else — including ![[Note]] transclusion, which Sandy
             * does not do — renders as a plain wiki-link. The target stays one
             * click away instead of showing raw brackets. */
            const { isResolved } = state.facet(wikiOptions);
            const cls =
              isResolved && !isResolved(inner)
                ? "md-wikilink md-wikilink-unresolved"
                : "md-wikilink";
            decos.push(
              Decoration.mark({ class: cls, attributes: NO_SPELL }).range(node.from, node.to),
            );
            if (showSource) return;
            const pipe = inner.indexOf("|");
            hide(node.from, node.from + open);
            if (pipe >= 0) {
              hide(node.from + open, node.from + open + pipe + 1);
            }
            hide(node.to - 2, node.to);
            return;
          }

          case "FencedCode": {
            if (decoratedFences.has(node.from)) return;
            decoratedFences.add(node.from);
            const first = doc.lineAt(node.from).number;
            const last = doc.lineAt(node.to).number;
            /* The ``` fences were the last markup that stayed on the page
             * everywhere: InlineCode hides its backticks, so a note with no
             * other syntax showing still had two rows of them per code block.
             * The card is the statement instead — its own top and bottom edge
             * says "this is code" — and where a fence carries an info string
             * (```js) that string stays as the card's label, which is the half
             * of the fence that means anything.
             * The hidden half comes back the one way everything else does:
             * Ctrl+/ inside the block reveals it whole (revealSource's
             * WHOLE_BLOCK covers FencedCode), and `lineActive` here is that
             * reveal, never the caret. */
            const caps = new Set<number>();
            let labelLine = 0;
            for (const mark of node.node.getChildren("CodeMark")) {
              if (lineActive(mark.from)) continue;
              const line = doc.lineAt(mark.from);
              const resumes = hideMark(mark.from, mark.to);
              // what survives on the fence's own line decides how it reads:
              // an info string makes it the label row, nothing makes it a cap
              if (state.sliceDoc(resumes, line.to).trim()) labelLine = line.number;
              else caps.add(line.number);
            }
            for (let n = first; n <= last; n++) {
              let cls = "md-codeblock";
              if (n === first) cls += " md-codeblock-first";
              if (n === last) cls += " md-codeblock-last";
              if (caps.has(n)) cls += " md-codeblock-cap";
              if (n === labelLine) cls += " md-codeblock-label";
              decos.push(
                Decoration.line({ class: cls, attributes: NO_SPELL }).range(doc.line(n).from),
              );
            }
            return;
          }

          case "Blockquote": {
            const firstLine = doc.lineAt(node.from);
            const first = firstLine.number;
            const last = doc.lineAt(node.to).number;
            /* A nested callout's opening line belongs to every Blockquote
             * wrapping it, and each one would claim the same token — two
             * replace decorations over one range, the label painted twice.
             * The outermost quote opening on that line owns it. */
            let owns = true;
            for (let up = node.node.parent; up; up = up.parent) {
              if (up.name === "Blockquote" && doc.lineAt(up.from).number === first) {
                owns = false;
                break;
              }
            }
            const callout = owns ? CALLOUT_RE.exec(firstLine.text) : null;
            const kind = callout ? (CALLOUT_KIND[callout[3].toLowerCase()] ?? "note") : null;
            for (let n = first; n <= last; n++) {
              let cls = "md-quote";
              if (kind) {
                cls += ` md-callout md-callout-${kind}`;
                if (n === first) cls += " md-callout-title";
                if (n === last) cls += " md-callout-last";
              }
              decos.push(Decoration.line({ class: cls }).range(doc.line(n).from));
            }
            if (kind) spaceAfter(last, "callout");
            if (callout && kind && !activeLines.has(first)) {
              const tokenFrom = firstLine.from + callout[1].length;
              const tokenTo = tokenFrom + callout[2].length;
              if (callout[5]) {
                // custom title follows — the [!type] token just disappears
                hide(tokenFrom, tokenTo + callout[4].length);
              } else {
                const raw = callout[3];
                const label = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
                pushReplace(
                  tokenFrom,
                  tokenTo,
                  Decoration.replace({ widget: new CalloutLabelWidget(label) }),
                );
              }
            }
            return;
          }

          case "QuoteMark": {
            if (!lineActive(node.from)) hideMark(node.from, node.to);
            return;
          }

          case "HorizontalRule": {
            if (!lineActive(node.from)) {
              pushReplace(node.from, node.to, Decoration.replace({ widget: new HRWidget() }));
            }
            return;
          }

          case "ListMark": {
            const isTask = node.node.parent?.getChild("Task") != null;
            const active = lineActive(node.from);
            if (isTask && !active) {
              hideMark(node.from, node.to);
            } else {
              decos.push(
                Decoration.mark({ class: "md-list-mark" }).range(node.from, node.to),
              );
            }

            /* Hanging indent: a wrapped list item continues under its own text
             * instead of sliding back under the marker. Pure presentation — the
             * offset is measured from the source, never written to it.
             * Rendered task lines are the one special case: the marker is hidden
             * and a fixed-width checkbox stands in for it, so the allowance is
             * that widget's border-box (1em wide + 0.5em gap), not the source. */
            const line = doc.lineAt(node.from);
            // on a task line the text starts past "[ ]" too, not just past "- "
            const taskMarker = isTask
              ? (node.node.parent?.getChild("Task")?.getChild("TaskMarker") ?? null)
              : null;
            let contentCol = (taskMarker ? taskMarker.to : node.to) - line.from;
            while (line.text.charAt(contentCol) === " ") contentCol++;
            const indent = line.text.slice(0, line.text.length - line.text.trimStart().length);
            const hang =
              isTask && !active
                ? textWidth(indent) + 1.5 * metricsEm
                : textWidth(line.text.slice(0, contentCol));
            decos.push(
              Decoration.line({
                class: "md-listline",
                attributes: { style: `--md-hang: ${hang.toFixed(2)}px` },
              }).range(line.from),
            );
            return;
          }

          case "TaskMarker": {
            if (lineActive(node.from)) return;
            const checked = /[xX]/.test(state.sliceDoc(node.from, node.to));
            let end = node.to;
            if (doc.sliceString(end, end + 1) === " ") end += 1;
            pushReplace(
              node.from,
              end,
              Decoration.replace({ widget: new CheckboxWidget(checked) }),
            );
            return;
          }

          case "Task": {
            const marker = node.node.getChild("TaskMarker");
            if (!marker) return;
            if (!/[xX]/.test(state.sliceDoc(marker.from, marker.to))) return;
            const from = Math.min(marker.to + 1, node.to);
            if (from < node.to) {
              decos.push(Decoration.mark({ class: "md-done" }).range(from, node.to));
            }
            return;
          }
        }
      },
    });
  }

  /* Smart typography, last: it needs to know every span the passes above
   * already claimed. Skipped inside a Ctrl+/ reveal — the raw `"` comes back
   * there like every other mark — and inside frontmatter, code, URLs and the
   * other verbatim nodes. */
  if (state.field(writingModesField, false)?.typography ?? true) {
    const blockedByLine = new Map<number, Array<[number, number]>>();
    for (const range of [...replacedRanges, ...noSmart]) {
      const first = doc.lineAt(range[0]).number;
      const last = doc.lineAt(Math.max(range[0], range[1] - 1)).number;
      for (let n = first; n <= last; n++) {
        const list = blockedByLine.get(n);
        if (list) list.push(range);
        else blockedByLine.set(n, [range]);
      }
    }

    const hits: SmartHit[] = [];
    const scanned = new Set<number>();
    for (const { from, to } of walkRanges) {
      const last = doc.lineAt(to).number;
      for (let n = doc.lineAt(from).number; n <= last; n++) {
        // a line straddling two visible ranges would otherwise be scanned twice,
        // and two identical replace ranges are a hard CM6 error
        if (activeLines.has(n) || scanned.has(n)) continue;
        scanned.add(n);
        const line = doc.line(n);
        if (fmEnd >= 0 && line.from <= fmEnd) continue;
        hits.length = 0;
        scanSmartTypography(line.text, line.from, hits);
        if (!hits.length) continue;
        const blocked = blockedByLine.get(n);
        for (const hit of hits) {
          if (blocked?.some(([f, t]) => hit.from < t && hit.to > f)) continue;
          decos.push(hit.deco.range(hit.from, hit.to));
          // atomic too, so Backspace takes the whole `--` rather than leaving `-`
          atomicOut?.push(hidden.range(hit.from, hit.to));
        }
      }
    }
  }

  return Decoration.set(decos, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** The hidden spans, for atomicRanges — see buildDecorations. */
    atomic: DecorationSet = Decoration.none;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    build(view: EditorView): DecorationSet {
      const atomic: Range<Decoration>[] = [];
      const decorations = buildDecorations(view, atomic);
      this.atomic = Decoration.set(atomic, true);
      return decorations;
    }

    update(update: ViewUpdate) {
      // IME: never rebuild during composition — freeze + map so a mid-composition
      // DOM swap can't drop the candidate window.
      const frozen = frozenDuringComposition(update, this.decorations);
      if (frozen) {
        this.decorations = frozen;
        this.atomic = this.atomic.map(update.changes);
        return;
      }
      /* Note what is *not* in this list: `update.selectionSet`. Nothing here
       * reads the selection any more, so moving the caret — including dragging
       * one out across the document — cannot change a single decoration. That
       * is what removed the old drag-freeze machinery: reveals used to reflow
       * the text under a moving pointer, the next mousemove hit-tested the
       * shifted layout, and the selection flickered. There is no loop to break
       * now. The reveal field is compared instead, since it also clears itself
       * (caret leaving the block) without an effect of its own. */
      const revealChanged =
        update.startState.field(revealedSource, false) !==
        update.state.field(revealedSource, false);
      // Widgets mounted by this rebuild may animate only if the user caused
      // it: an edit, or a Ctrl+/ reveal closing (hr-draw's moment). A rebuild
      // from scrolling never stamps, so re-entering the viewport stays still.
      if (update.docChanged || revealChanged) markEditMoment();
      if (
        update.docChanged ||
        update.viewportChanged ||
        revealChanged ||
        syntaxTree(update.state) !== syntaxTree(update.startState) ||
        update.transactions.some(isImeSafeFlushTransaction) ||
        update.transactions.some((tr) =>
          tr.effects.some(
            (e) =>
              e.is(vaultIndexChanged) ||
              // the smart-typography switch lives in this field; without it the
              // toggle would only take effect on the next unrelated edit
              e.is(applyWritingModes),
          ),
        )
      ) {
        this.decorations = this.build(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  },
);
