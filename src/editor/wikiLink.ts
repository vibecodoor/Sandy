import type { InlineContext, MarkdownConfig } from "@lezer/markdown";
import { tags as t } from "@lezer/highlight";

/** Image formats an `![[embed]]` renders inline; anything else degrades to a link. */
const EMBED_IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

/** Target of an `![[…]]` embed — the part before any `|alias` or `#heading`. */
export function embedTarget(inner: string): string {
  return inner.split("|")[0].split("#")[0].trim();
}

export function isImageEmbed(inner: string): boolean {
  return EMBED_IMAGE.test(embedTarget(inner));
}

/** Position just past the closing `]]`, or -1 when the run doesn't close. */
function findClose(cx: InlineContext, from: number): number {
  for (let i = from; i + 1 < cx.end; i++) {
    const ch = cx.char(i);
    if (ch === 10 /* \n */ || ch === 91 /* [ */) return -1;
    if (ch === 93 /* ] */) return cx.char(i + 1) === 93 ? i + 2 : -1;
  }
  return -1;
}

/* Lezer inline parsers for [[Target]] / [[Target|alias]] and their `!` embed
 * form. `![[…]]` is a separate node because it means something different:
 * an image renders inline, and anything else degrades to a plain clickable
 * link rather than showing raw brackets (open-knowledge's rule — unsupported
 * syntax falls back to its nearest supported neighbour, never to noise). */
export const wikiLink: MarkdownConfig = {
  defineNodes: [
    { name: "WikiLink", style: t.link },
    { name: "WikiEmbed", style: t.link },
    { name: "WikiLinkMark", style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: "WikiEmbed",
      before: "Image",
      parse(cx, next, pos) {
        if (next !== 33 /* ! */ || cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91) return -1;
        const end = findClose(cx, pos + 3);
        if (end < 0 || end === pos + 5 /* empty ![[]] */) return -1;
        return cx.addElement(
          cx.elt("WikiEmbed", pos, end, [
            cx.elt("WikiLinkMark", pos, pos + 3),
            cx.elt("WikiLinkMark", end - 2, end),
          ]),
        );
      },
    },
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 91) return -1;
        const end = findClose(cx, pos + 2);
        if (end < 0 || end === pos + 4 /* empty [[]] */) return -1;
        return cx.addElement(
          cx.elt("WikiLink", pos, end, [
            cx.elt("WikiLinkMark", pos, pos + 2),
            cx.elt("WikiLinkMark", end - 2, end),
          ]),
        );
      },
    },
  ],
};
