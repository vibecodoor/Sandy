import type { MarkdownConfig } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";

/* Lezer inline parser for ==highlight== (Obsidian/Bear syntax). Same shape as
 * wikiLink.ts: one node spanning the run, mark children for the delimiters.
 * Edges must not touch whitespace so `a == b` comparisons never trigger. */
export const highlightMark: MarkdownConfig = {
  defineNodes: [
    { name: "Highlight" },
    { name: "HighlightMark", style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: "Highlight",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61) return -1;
        if (cx.char(pos + 2) === 61) return -1; // === run — not a highlight
        let end = -1;
        for (let i = pos + 2; i + 1 < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === 10 /* \n */) return -1;
          if (ch === 61 && cx.char(i + 1) === 61) {
            end = i + 2;
            break;
          }
        }
        if (end < 0 || end === pos + 4 /* empty ==== */) return -1;
        const space = (ch: number) => ch === 32 || ch === 9;
        if (space(cx.char(pos + 2)) || space(cx.char(end - 3))) return -1;
        return cx.addElement(
          cx.elt("Highlight", pos, end, [
            cx.elt("HighlightMark", pos, pos + 2),
            cx.elt("HighlightMark", end - 2, end),
          ]),
        );
      },
    },
  ],
};
