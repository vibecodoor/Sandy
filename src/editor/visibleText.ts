import type { EditorState, Range, Text } from "@codemirror/state";
import type { Decoration, EditorView } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { buildDecorations } from "./livePreview";
import { revealedSource } from "./revealSource";
import { writingModesField, type WritingModes } from "./writingModes";

/*
 * What is actually on the page.
 *
 * Since s30 the rendered page is the only page: a link's URL, a %%comment%%,
 * every emphasis mark and a wiki-link's target half are replace-decorations —
 * text in the file that no reader ever sees. Two surfaces used to read
 * `state.doc` straight through anyway, and both said things that were not true
 * of what was on screen: Ctrl+F found "example" inside a hidden href (the
 * counter said 3/7 while the page scrolled to nothing and parked the caret
 * inside an atomic range), and the word count called one visible link four
 * words.
 *
 * The answer is not a second implementation of livePreview's hiding rules —
 * that would be a mirror to keep in sync forever. It is the *same* function:
 * `buildDecorations`' viewport bound lives in its caller's argument, not in any
 * of its rules, so it is asked here for the whole document and only the spans
 * it hid are kept. One source of truth; when a new construct starts being
 * hidden there, find and the word count learn about it the same day.
 *
 * The cost is one full-document build, so it is cached on the identity of the
 * things that can change the answer (the doc, the Ctrl+/ block, the typography
 * switch) and computed only when something asks.
 *
 * Code is the one place the two callers part ways, and that is a product call
 * (DECISIONS s44): a fenced body *is* on screen, so find matches it — while the
 * word count and the reading estimate skip code, because a note half made of
 * listings is not a twelve-minute read.
 */

type Span = [number, number];

/* Enough parse budget for any note a person writes by hand, and the only
 * reason it is finite is that a wrong number beats a frozen window. */
const PARSE_BUDGET_MS = 100;

/* Past this, we stop building at all. The build is one whole-document pass and
 * it is linear — 0.22 ms per kB, measured across six sizes (s51) — so a length
 * is a millisecond budget: 64 kB is ~14 ms, and the cache misses on every
 * keystroke, so with the find panel open a 326 kB note was costing 117 ms per
 * character. Throttling to one build per frame cannot help when one build *is*
 * four frames. Over the gate the answer is the empty set, which is the failure
 * direction PROJECT.md blesses and the one both surfaces had before this file
 * existed: a hidden match still offered, a count still too high — never a match
 * hidden that is on screen. */
const MAX_BUILD_LENGTH = 64_000;

type Snapshot = {
  doc: Text;
  revealed: unknown;
  modes: WritingModes | undefined;
  /** The tree the spans were read off — the paragraph count reads it too. */
  tree: Tree;
  /** Spans the live preview replaced — hidden markup, and widgets. */
  hidden: Span[];
  /** Code spans: excluded from the prose count, but never from find. */
  code: Span[];
  /** The two merged — built on the first ask, then reused. */
  prose: Span[] | null;
};

/* One entry: the only question ever asked is about the current document, and a
 * map keyed on Text would hold whole document versions alive for nothing. */
let snapshot: Snapshot | null = null;

function normalize(spans: Span[]): Span[] {
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Span[] = [];
  for (const [from, to] of spans) {
    if (to <= from) continue;
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/* Not a copy of any hiding rule — a plain question about node names. The three
 * container nodes cover their own marks, info string and text. */
const CODE_NODE = /^(FencedCode|CodeBlock|InlineCode)$/;

function collectCode(tree: Tree, length: number): Span[] {
  const spans: Span[] = [];
  tree.iterate({
    from: 0,
    to: length,
    enter: (node) => {
      if (!CODE_NODE.test(node.name)) return;
      spans.push([node.from, node.to]);
      return false; // its marks and text are inside it
    },
  });
  return spans;
}

function build(view: EditorView): Snapshot {
  const { state } = view;
  const { doc } = state;
  /* `syntaxTree(state)` is the state field's tree, which the background worker
   * only advances to about the viewport — and iterating past its end yields
   * nothing rather than an error. Asking about the whole document means
   * insisting on a tree that reaches it. If the budget runs out we answer from
   * the partial one, and the failure is one-directional: the tail comes back
   * *under*-hidden, so find may still offer a match the reader cannot see and
   * the count may still be too high — exactly what both did before this file
   * existed. It can never hide a match that is on screen. */
  const tree = ensureSyntaxTree(state, doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  const atomic: Range<Decoration>[] = [];
  // the decoration set is discarded: only the spans it hid are the answer here
  buildDecorations(view, atomic, { ranges: [{ from: 0, to: doc.length }], tree });
  return {
    doc,
    revealed: state.field(revealedSource, false),
    modes: state.field(writingModesField, false),
    tree,
    hidden: normalize(atomic.map((range): Span => [range.from, range.to])),
    code: normalize(collectCode(tree, doc.length)),
    prose: null,
  };
}

/** Over the gate: nothing hidden, nothing skipped, the tree we already have. */
function unbuilt(state: EditorState): Snapshot {
  return {
    doc: state.doc,
    revealed: state.field(revealedSource, false),
    modes: state.field(writingModesField, false),
    tree: syntaxTree(state),
    hidden: [],
    code: [],
    prose: [],
  };
}

function current(view: EditorView): Snapshot {
  const { state } = view;
  if (
    snapshot &&
    snapshot.doc === state.doc &&
    snapshot.revealed === state.field(revealedSource, false) &&
    snapshot.modes === state.field(writingModesField, false)
  ) {
    return snapshot;
  }
  snapshot = state.doc.length > MAX_BUILD_LENGTH ? unbuilt(state) : build(view);
  return snapshot;
}

/** First span whose end is past `pos`, by binary search. */
function firstFrom(spans: Span[], pos: number): number {
  let low = 0;
  let high = spans.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (spans[mid][1] <= pos) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Is any part of `from`–`to` hidden by the live preview?
 *
 * Any overlap counts: a match half inside a hidden URL is not a match anyone
 * can read, and selecting it would drop the caret inside an atomic range.
 *
 * `state` is the state the caller is asking about — `SearchQuery.test` hands
 * one over rather than a view. If it is not the document this view is showing,
 * the positions mean nothing here and the honest answer is "not hidden": the
 * old behaviour, a match too many rather than a match silently gone.
 */
export function isHidden(
  view: EditorView,
  state: EditorState,
  from: number,
  to: number,
): boolean {
  if (state.doc !== view.state.doc) return false;
  const { hidden } = current(view);
  const index = firstFrom(hidden, from);
  return index < hidden.length && hidden[index][0] < to;
}

function excluded(view: EditorView): Span[] {
  const snap = current(view);
  // one merge per document version, not one per call: a multi-range selection
  // asks once for the document and once for each of its ranges
  snap.prose ??= normalize([...snap.hidden, ...snap.code]);
  return snap.prose;
}

/* A word is a run starting on a letter or digit — the same shape App.tsx used
 * before this file, so the number only changes where the page does. */
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/**
 * Walk the runs of `from`–`to` that survive `spans`, in order.
 *
 * `separated` says the removed span in front of this run took a word boundary
 * with it, and getting that right is the whole difficulty of counting words on
 * a page. `**bold**face` reads as **one** word, so a span of pure punctuation
 * joins its neighbours with nothing. A table row hides `" | "` between two
 * cells — whitespace, and two boxes on screen — so `| a | b |` is **two**
 * words, not `ab`. The test is therefore the span's own text: any whitespace in
 * it (a line break included) was a boundary the reader can still see.
 */
function eachVisibleRun(
  doc: Text,
  spans: Span[],
  from: number,
  to: number,
  run: (runFrom: number, runTo: number, separated: boolean) => void,
): void {
  let pos = from;
  let separated = false;
  for (let i = firstFrom(spans, from); i < spans.length; i++) {
    const [spanFrom, spanTo] = spans[i];
    if (spanFrom >= to) break;
    const start = Math.max(spanFrom, from);
    const end = Math.min(spanTo, to);
    if (start > pos) {
      run(pos, start, separated);
      separated = false;
    }
    separated ||=
      // a multi-line span always holds one; asking first keeps a whole fenced
      // block from being sliced out just to look for a space
      doc.lineAt(start).number !== doc.lineAt(end).number ||
      /\s/.test(doc.sliceString(start, end));
    pos = Math.max(pos, end);
  }
  if (pos < to) run(pos, to, separated);
}

/** The words a reader can actually see between `from` and `to`, code excluded. */
export function visibleWordCount(view: EditorView, from = 0, to = view.state.doc.length): number {
  const { doc } = view.state;
  let text = "";
  eachVisibleRun(doc, excluded(view), from, to, (runFrom, runTo, separated) => {
    if (separated) text += " ";
    text += doc.sliceString(runFrom, runTo);
  });
  return (text.match(WORD) ?? []).length;
}

/* A paragraph, as the page shows one: a prose block. A heading is not a
 * paragraph, a table is not, a fenced block is not — and a list is *one*,
 * however many items it has, because that is what the eye sees. Node names
 * again, not a copy of any hiding rule; the two list nodes are skipped whole,
 * which also stops a nested list from counting twice. */
const PARAGRAPH_NODE = /^(Paragraph|BulletList|OrderedList)$/;

/**
 * What the corner panel says about the open document (or about a selection).
 *
 * Three numbers, two different texts, and the difference is the s44 product
 * call: `characters` measures the **page** — hidden markup gone, code counted,
 * because a listing is text you can see — while `words` and `paragraphs`
 * measure **prose**, which is what a reading time can honestly be built on. On
 * a note that is nothing but a code block the panel therefore says so: many
 * characters, no words. Line breaks are structure, not characters.
 */
export function visibleStats(
  view: EditorView,
  from = 0,
  to = view.state.doc.length,
): { words: number; characters: number; paragraphs: number } {
  const { doc } = view.state;
  const snap = current(view);

  let characters = 0;
  eachVisibleRun(doc, snap.hidden, from, to, (runFrom, runTo) => {
    for (const ch of doc.sliceString(runFrom, runTo)) if (ch !== "\n") characters++;
  });

  let paragraphs = 0;
  snap.tree.iterate({
    from,
    to,
    enter: (node) => {
      if (!PARAGRAPH_NODE.test(node.name)) return;
      /* A block whose every word is hidden — a line holding nothing but a
       * `%%comment%%` — is on the page as blank, so it is not a paragraph. */
      const start = Math.max(node.from, from);
      const end = Math.min(node.to, to);
      if (visibleWordCount(view, start, end) > 0) paragraphs++;
      return false;
    },
  });

  return { words: visibleWordCount(view, from, to), characters, paragraphs };
}
