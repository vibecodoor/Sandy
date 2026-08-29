import { EditorSelection } from "@codemirror/state";
import { EditorView, RectangleMarker, layer } from "@codemirror/view";

/* Sandy's selection painter — and mostly what it *doesn't* paint.
 *
 * The page is not a text flow: markup is replace-decorated away (doc offsets
 * are not pixels), a table row is a grid (a .cm-line is 2-D), and block air is
 * padding inside line boxes (margins desync CM6's height map). Every painter
 * that reconstructs text geometry — CM6's drawSelection included — assumes all
 * three away, so three sessions of rewriting one produced three different sets
 * of artefacts. The model is in specs/selection-model.md; the short version:
 *
 *   1. Text is painted by the browser. Native ::selection is re-enabled in
 *      editor.css and CM6's own selection layer is display:none. Hidden spans
 *      aren't in the DOM so they wash nothing, line padding isn't text so the
 *      air between blocks stays clean, and every future card inherits it free.
 *   2. A rendered table row is painted here, by cells — Chromium only does
 *      cell-filling selection for a real <table>, which a .cm-line can't be.
 *      Native ::selection is suppressed inside those rows so nothing double-
 *      paints.
 *   3. Secondary ranges are painted here too: the DOM carries one selection, so
 *      ::selection can only ever show state.selection.main. Ctrl+D and Alt+drag
 *      column select are the callers; stock rectangles are right for them. */

const SELECTION_CLASS = "cm-selectionBackground";

type Point = { left: number; top: number };
type Box = { left: number; top: number; width: number; height: number };

/* Layer markers are document-relative; mirrors CM6's internal getBase (LTR). */
const layerBase = (view: EditorView): Point => {
  const rect = view.scrollDOM.getBoundingClientRect();
  return {
    left: rect.left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  };
};

const marker = (base: Point, box: Box) =>
  new RectangleMarker(
    SELECTION_CLASS,
    box.left - base.left,
    box.top - base.top,
    box.width,
    box.height,
  );

/* One rendered table row, for the part of a selection that covers it.
 * `from`/`to` are clamped to the row's own line, so both ends are rendered. */
const rowMarkers = (
  view: EditorView,
  row: HTMLElement,
  base: Point,
  line: { from: number; to: number },
  from: number,
  to: number,
): RectangleMarker[] => {
  /* Start from the row's own DOM bounds: an end that reaches the line's edge
   * has to leave the edge cell *open*, and the doc position there is not a DOM
   * point inside it — the row's trailing "|" is replace-decorated, so
   * domAtPos(line.to) lands before the cell ends and the last cell of a
   * whole-row selection would cut at its last glyph instead of filling. */
  const range = document.createRange();
  range.selectNodeContents(row);
  try {
    if (from > line.from) {
      const a = view.domAtPos(from);
      range.setStart(a.node, a.offset);
    }
    if (to < line.to) {
      const b = view.domAtPos(to);
      range.setEnd(b.node, b.offset);
    }
  } catch {
    /* domAtPos can throw mid-update (a position measured against a DOM the
     * decorations are still rebuilding). No marker this frame is the honest
     * answer — the next measure pass repaints from settled geometry, and a
     * thrown frame here would take the whole selection layer down with it. */
    return [];
  }

  /* Which cells hold covered glyphs, and where. Clamping each cell's own
   * contents to the selection and letting the browser measure the result is
   * the whole test: a cell outside the selection collapses to nothing, and one
   * whose covered part is all delimiter measures nothing either, because a
   * replace-decorated span is not in the DOM to have a width. */
  const covered: { box: DOMRect; rects: DOMRect[] }[] = [];
  for (const cell of row.querySelectorAll<HTMLElement>(".md-table-cell")) {
    const span = document.createRange();
    span.selectNodeContents(cell);
    if (range.compareBoundaryPoints(Range.START_TO_START, span) > 0)
      span.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, span) < 0)
      span.setEnd(range.endContainer, range.endOffset);
    const rects = Array.from(span.getClientRects()).filter((r) => r.width >= 0.5 && r.height >= 0.5);
    if (rects.length) covered.push({ box: cell.getBoundingClientRect(), rects });
  }

  return covered.flatMap(({ box, rects }, i) => {
    /* A cell is open on a side when the selection carries on past it there:
     * another covered cell, or the row's own edge. That is asked of the
     * neighbours, never of the endpoint's DOM position — the delimiter between
     * two cells is decorated away, so a doc position on a cell boundary
     * resolves into the *start of the next cell*, and an endpoint read straight
     * off `domAtPos` reports its own cell as open and swallows it whole. */
    const openLeft = i > 0 || from <= line.from;
    const openRight = i < covered.length - 1 || to >= line.to;
    // Passed through: the whole box, so covered cells tile into one band.
    if (openLeft && openRight) return [marker(base, box)];
    // The selection lives inside this one cell: wash the glyphs, like any text.
    if (!openLeft && !openRight) return rects.map((r) => marker(base, r));
    /* An endpoint of a wider selection: cut at the glyph on the closed side,
     * run to the box on the open one, and take the box's height so the band it
     * meets has no notch at the cell's vertical padding. */
    const left = openLeft ? box.left : Math.min(...rects.map((r) => r.left));
    const right = openRight ? box.right : Math.max(...rects.map((r) => r.right));
    return [marker(base, { left, top: box.top, width: Math.max(0, right - left), height: box.height })];
  });
};

/* A secondary range away from a table row: stock rectangles, minus the ones
 * that paint nothing. `forRange` crosses a fully hidden line — a replace-
 * decorated `| --- |`, a blank — as a zero-height, full-width sliver, and a
 * rect with no area is a DOM node for nothing. A *null* width is deliberate
 * (CM6 means "assign no width style"), so only a real zero is dropped. */
const stockMarkers = (view: EditorView, from: number, to: number) =>
  RectangleMarker.forRange(view, SELECTION_CLASS, EditorSelection.range(from, to)).filter(
    (m) => m.height >= 0.5 && (m.width === null || m.width >= 0.5),
  );

const selectionMarkers = (view: EditorView): RectangleMarker[] => {
  // The common case is a lone caret: nothing for this layer to paint, and the
  // row scan below (querySelectorAll + posAtDOM per row) runs on every
  // keystroke and scroll step otherwise (s51 #43).
  if (view.state.selection.ranges.every((r) => r.empty)) return [];
  const out: RectangleMarker[] = [];
  const doc = view.state.doc;
  // A Ctrl+/-revealed row is plain text again and the browser paints it.
  const rows = Array.from(
    view.contentDOM.querySelectorAll<HTMLElement>(".cm-line.md-table-row:not(.md-table-source)"),
    (el) => {
      const line = doc.lineAt(view.posAtDOM(el, 0));
      return { el, from: line.from, to: line.to };
    },
  );
  const base = layerBase(view);
  const { main, ranges } = view.state.selection;

  for (const range of ranges) {
    if (range.empty) continue;
    // Off a table row the main range is the browser's; the others have no
    // native selection to be painted by.
    const ours = range !== main;
    let gapStart = range.from;
    for (const row of rows) {
      if (row.to < range.from) continue;
      if (row.from > range.to) break;
      if (ours && gapStart < row.from - 1) out.push(...stockMarkers(view, gapStart, row.from - 1));
      for (const m of rowMarkers(
        view,
        row.el,
        base,
        row,
        Math.max(range.from, row.from),
        Math.min(range.to, row.to),
      ))
        out.push(m);
      gapStart = row.to + 1;
    }
    if (ours && gapStart < range.to) out.push(...stockMarkers(view, gapStart, range.to));
  }
  return out;
};

export const sandySelectionLayer = () =>
  layer({
    above: false,
    class: "sandy-selection-layer",
    update: (update) => update.docChanged || update.selectionSet || update.viewportChanged,
    markers: selectionMarkers,
  });
