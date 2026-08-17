import { Decoration, WidgetType } from "@codemirror/view";

/*
 * Smart typography, render-only.
 *
 * Typora offers this two ways: "convert on input" (the glyph is written into the
 * file) and "convert on rendering" (the file keeps plain ASCII). Only the second
 * one is compatible with Sandy's core value, so it is the only one that exists
 * here: the document bytes stay `"` / `--` / `...` forever — grep-able, diff-able,
 * portable — while the rendered page shows the correct glyph. Like every other
 * mark in the editor, the raw source comes back under a Ctrl+/ on the block
 * (never at the caret).
 *
 * One scanner, two renderers: the PDF export runs the same pass over plain text
 * (`smartTypographyText`) instead of markdown-it's typographer, which converts a
 * different set (© (tm) +- and every single quote) and would print a document
 * the page never showed.
 *
 * The quote pair follows the line's script rather than a setting: a line that is
 * mostly Cyrillic gets « », everything else gets “ ”. Apostrophes convert only
 * word-internally (don't → don’t), which is the one case with no ambiguity —
 * `'90s` and quoted 'strings' are left exactly as typed.
 */

export class GlyphWidget extends WidgetType {
  constructor(readonly glyph: string) {
    super();
  }
  override eq(other: GlyphWidget) {
    return other.glyph === this.glyph;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-smart";
    el.textContent = this.glyph;
    return el;
  }
  override ignoreEvent() {
    return false;
  }
}

const glyphCache = new Map<string, Decoration>();

/** Decorations are cached per glyph so redraws reuse the same widget instance. */
function glyph(text: string): Decoration {
  let deco = glyphCache.get(text);
  if (!deco) {
    deco = Decoration.replace({ widget: new GlyphWidget(text) });
    glyphCache.set(text, deco);
  }
  return deco;
}

export interface SmartHit {
  from: number;
  to: number;
  /** What the page shows there — the print renderer splices this into the text. */
  glyph: string;
  deco: Decoration;
}

function hit(from: number, to: number, text: string): SmartHit {
  return { from, to, glyph: text, deco: glyph(text) };
}

const CYRILLIC = /[Ѐ-ӿ]/g;
const LATIN = /[A-Za-z]/g;
const LETTER = /[\p{L}\p{N}]/u;
/** Characters that can precede an opening quote: whitespace, an opening
 *  bracket or dash — and the *closing* delimiter of any inline markup. This
 *  scan reads the raw source line, so the character before the `"` in
 *  `**bold**"quoted"` is a `*`, not the `d` the reader sees; without the
 *  delimiters here the screen opened that run with a closing quote while the
 *  printed page opened it correctly. */
const BEFORE_OPEN = /[\s([{<*_~`=)\]«„“‘–—-]/;

function count(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/**
 * Which language a run of text is written in, by the only measure this codebase
 * needs: more Cyrillic letters than Latin ones. It is the decision that already
 * picks « » over “ ” below, exported because the printed page needs the same
 * answer for `lang` — Chromium chooses its hyphenation dictionary from that
 * attribute, and the wrong one fails silently, as no breaks at all.
 */
export function dominantLang(text: string): "ru" | "en" {
  return count(text, CYRILLIC) > count(text, LATIN) ? "ru" : "en";
}

/**
 * Collect the smart-typography replacements for one line of source text.
 * `offset` is the line's document position; hits come out in ascending order.
 */
export function scanSmartTypography(text: string, offset: number, out: SmartHit[]): void {
  if (!text) return;
  const cyrillic = dominantLang(text) === "ru";
  const open = cyrillic ? "«" : "“";
  const close = cyrillic ? "»" : "”";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === ".") {
      // exactly three, so "…." and longer runs of dots stay literal
      if (text[i + 1] === "." && text[i + 2] === "." && text[i + 3] !== "." && text[i - 1] !== ".") {
        out.push(hit(offset + i, offset + i + 3, "…"));
        i += 2;
      }
      continue;
    }

    if (ch === "-") {
      if (text[i - 1] === "-") continue; // mid-run; handled at the run's start
      let end = i + 1;
      while (text[end] === "-") end++;
      const run = end - i;
      if (run === 2 || run === 3) {
        out.push(hit(offset + i, offset + end, run === 3 ? "—" : "–"));
      }
      i = end - 1;
      continue;
    }

    if (ch === '"') {
      const prev = text[i - 1];
      const opening = prev === undefined || BEFORE_OPEN.test(prev);
      out.push(hit(offset + i, offset + i + 1, opening ? open : close));
      continue;
    }

    if (ch === "'") {
      // word-internal only: the unambiguous case. Leading/trailing single
      // quotes stay literal — '90s and 'quoted' are too easy to get wrong.
      if (!cyrillic && LETTER.test(text[i - 1] ?? "") && LETTER.test(text[i + 1] ?? "")) {
        out.push(hit(offset + i, offset + i + 1, "’"));
      }
    }
  }
}

/**
 * The same scan applied to plain text — the paper copy's half of it
 * (printExport.ts). Line by line, so the script that picks « » over “ ” is
 * decided exactly where the editor decides it.
 */
export function smartTypographyText(text: string): string {
  const hits: SmartHit[] = [];
  return text
    .split("\n")
    .map((line) => {
      hits.length = 0;
      scanSmartTypography(line, 0, hits);
      if (!hits.length) return line;
      let out = "";
      let at = 0;
      for (const h of hits) {
        out += line.slice(at, h.from) + h.glyph;
        at = h.to;
      }
      return out + line.slice(at);
    })
    .join("\n");
}
