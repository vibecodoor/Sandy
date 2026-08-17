import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import type { Command, KeyBinding } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { frontmatterInfo } from "./frontmatter";
import { imeBusy } from "./imeGuard";

/*
 * Reveal-on-demand.
 *
 * The page stays rendered while you write in it: putting the caret in a table,
 * a bold word or a link no longer tears that construct open into raw Markdown.
 * The cost of that promise is that some syntax carries information the rendered
 * page cannot show — a link's URL, a callout's [!type], a table's column
 * grid — so there has to be one deliberate way to look at the source of the
 * thing under the caret. That is this field, and Ctrl+/ is the way.
 *
 * The reveal is a *block*, not a selection: the table, the quote, the code
 * fence, the frontmatter card, or (for everything else) the line. It closes
 * itself the moment the caret leaves — nothing to remember to turn off.
 *
 * Decoration-only, like the rest of the editor: revealing changes no bytes.
 */

export interface RevealedBlock {
  from: number;
  to: number;
}

/** Show this block's raw Markdown (null = back to the rendered page). */
export const revealSourceEffect = StateEffect.define<RevealedBlock | null>();

export const revealedSource = StateField.define<RevealedBlock | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(revealSourceEffect)) return effect.value;
    if (!value) return null;
    /* Follow edits made inside the revealed block, then re-extend to whole
     * lines: the block is line-granular and typing into it must not shave the
     * ends off. `tr.state` is off limits inside a field update (it would
     * recurse), so the new doc/selection come from the transaction itself. */
    const doc = tr.newDoc;
    const from = doc.lineAt(Math.min(tr.changes.mapPos(value.from, -1), doc.length)).from;
    const to = doc.lineAt(Math.min(tr.changes.mapPos(value.to, 1), doc.length)).to;
    const head = tr.newSelection.main.head;
    if (head < from || head > to) return null; // the caret walked out — close it
    // identity is meaningful: livePreview rebuilds when this value changes
    return from === value.from && to === value.to ? value : { from, to };
  },
});

/** Is any part of [from, to] inside the block currently showing its source? */
export function isSourceRevealed(state: EditorState, from: number, to: number): boolean {
  const revealed = state.field(revealedSource, false);
  return revealed != null && revealed.from <= to && revealed.to >= from;
}

/* Constructs whose source is worth seeing whole rather than a line at a time:
 * one table row's pipes are meaningless without the rows above it, and a
 * callout's [!type] lives on a line you may not be standing on. */
const WHOLE_BLOCK = /^(Table|Blockquote|FencedCode|CodeBlock)$/;

/** The block whose raw Markdown `pos` belongs to, snapped to whole lines. */
export function sourceBlockAt(state: EditorState, pos: number): RevealedBlock {
  const { doc } = state;
  // frontmatter isn't in the syntax tree (the card is drawn by hand) and its
  // fences are collapsed to a hairline, so the whole card reveals as one
  const fm = frontmatterInfo(state);
  if (fm && pos <= fm.to) return { from: 0, to: fm.to };

  let outermost: SyntaxNode | null = null;
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 0); node; node = node.parent) {
    if (WHOLE_BLOCK.test(node.name)) outermost = node;
  }
  if (!outermost) {
    const line = doc.lineAt(pos);
    return { from: line.from, to: line.to };
  }
  // a block node's `to` can sit on the following line's start; step back one
  return {
    from: doc.lineAt(outermost.from).from,
    to: doc.lineAt(Math.max(outermost.from, outermost.to - 1)).to,
  };
}

/** Ctrl+/ — show the source of the block under the caret, or hide it again. */
export const toggleSourceReveal: Command = (view) => {
  if (imeBusy(view)) return false; // never restructure the page mid-composition
  const { state } = view;
  const head = state.selection.main.head;
  const current = state.field(revealedSource, false);
  const next =
    current && head >= current.from && head <= current.to ? null : sourceBlockAt(state, head);
  view.dispatch({ effects: revealSourceEffect.of(next) });
  return true;
};

/** Is the caret inside a block that is currently showing its source? */
export function sourceRevealActive(state: EditorState): boolean {
  const revealed = state.field(revealedSource, false);
  if (!revealed) return false;
  const head = state.selection.main.head;
  return head >= revealed.from && head <= revealed.to;
}

export const revealSourceKeymap: KeyBinding[] = [{ key: "Mod-/", run: toggleSourceReveal }];
