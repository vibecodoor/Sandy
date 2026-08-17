import type { MarkdownConfig } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";

/* Lezer inline parser for %%comments%% (Obsidian syntax). Same shape as
 * highlightMark.ts. A comment is hidden in the rendered page and comes back
 * whole under a Ctrl+/ reveal — the bytes are never removed, so the note you
 * publish and the note you edit stay the same file.
 *
 * Single-line only, deliberately: a multi-line %% block would have to be a
 * block parser, and hiding several lines at once makes the page jump by more
 * than one reveal can put back. */
export const commentMark: MarkdownConfig = {
  defineNodes: [
    { name: "MdComment", style: t.lineComment },
    { name: "MdCommentMark", style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: "MdComment",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== 37 /* % */ || cx.char(pos + 1) !== 37) return -1;
        let end = -1;
        for (let i = pos + 2; i + 1 < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === 10 /* \n */) return -1;
          if (ch === 37 && cx.char(i + 1) === 37) {
            end = i + 2;
            break;
          }
        }
        if (end < 0 || end === pos + 4 /* empty %%%% */) return -1;
        return cx.addElement(
          cx.elt("MdComment", pos, end, [
            cx.elt("MdCommentMark", pos, pos + 2),
            cx.elt("MdCommentMark", end - 2, end),
          ]),
        );
      },
    },
  ],
};
