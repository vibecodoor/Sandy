/*
 * Print / PDF export: renders the document text to static HTML for the
 * system print dialog ("Save as PDF" / "Microsoft Print to PDF").
 * Read-only path — the editor buffer and the file on disk are never touched;
 * this renders a throwaway copy (the file's own bytes stay intact).
 */
import MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import { dominantLang, smartTypographyText } from "../editor/typography";

/* kind→accent map, mirrors src/editor/livePreview.ts so print matches the editor */
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

/** Image formats an `![[embed]]` renders; mirrors src/editor/wikiLink.ts. */
const EMBED_IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;

function buildRenderer(resolveImageSrc: (src: string) => string, smart: boolean): MarkdownIt {
  /* `breaks`: in the editor every source line is its own `.cm-line`, so a lone
   * `\n` inside a paragraph, a quote, a callout or a list item is a visible
   * break. Without this the paper silently joins them — a callout's `> [!info]
   * Title` and its `> body` print as one run of text. */
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

  /* A bare https://… is a styled, clickable link on the page (livePreview's
   * Autolink/URL case), so it is one on paper too. Fuzzy matching is off and the
   * schema list is cut down to what `externalHref` actually opens, so the two
   * renderers claim the same runs of text — markdown-it's defaults would also
   * linkify `example.com`, `ftp://…` and `//host`, none of which the editor
   * treats as a link. (Residual: GFM's `www.` form, which needs fuzzy on.) */
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  md.linkify.add("ftp:", null);
  md.linkify.add("//", null);

  /* markdown-it's `entity` rule is not gated on `options.html`, so `&copy;` printed
   * as © while the editor showed it literally — lezer gives an `Entity` node that
   * neither highlight.ts nor livePreview.ts has a case for. Disabled rather
   * than taught to the editor: paper agrees with the page, which is the
   * direction this invariant runs. */
  md.inline.ruler.disable("entity");

  /* %%comments%% never reach paper (they don't reach the rendered page either) */
  md.inline.ruler.before("emphasis", "sandy_comment", (state) => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== 37 /* % */ || src.charCodeAt(pos + 1) !== 37) return false;
    const close = src.indexOf("%%", pos + 2);
    if (close < 0 || close === pos + 2) return false;
    if (src.slice(pos + 2, close).includes("\n")) return false;
    state.pos = close + 2; // consumed, no token emitted
    return true;
  });

  /* ![[embed]] — an image renders, anything else falls back to link text */
  md.inline.ruler.before("link", "sandy_wikiembed", (state, silent) => {
    const { src, pos } = state;
    if (
      src.charCodeAt(pos) !== 33 /* ! */ ||
      src.charCodeAt(pos + 1) !== 91 ||
      src.charCodeAt(pos + 2) !== 91
    ) {
      return false;
    }
    const close = src.indexOf("]]", pos + 3);
    if (close < 0 || close === pos + 3) return false;
    const inner = src.slice(pos + 3, close);
    if (inner.includes("\n") || inner.includes("[")) return false;
    const pipe = inner.indexOf("|");
    const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).split("#")[0].trim();
    if (!silent) {
      if (EMBED_IMAGE.test(target)) {
        // src stays note-relative here; the image renderer below resolves it
        const token = state.push("image", "img", 0);
        token.attrs = [
          ["src", target],
          ["alt", ""],
        ];
        token.content = "";
        token.children = [];
      } else {
        const token = state.push("sandy_wikilink", "", 0);
        token.content = pipe >= 0 ? inner.slice(pipe + 1) : inner;
      }
    }
    state.pos = close + 2;
    return true;
  });

  /* [[wiki-links]] render as plain styled text — paper has no vault */
  md.inline.ruler.before("link", "sandy_wikilink", (state, silent) => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== 91 /* [ */ || src.charCodeAt(pos + 1) !== 91) return false;
    const close = src.indexOf("]]", pos + 2);
    if (close < 0 || close === pos + 2) return false;
    const inner = src.slice(pos + 2, close);
    if (inner.includes("\n") || inner.includes("[")) return false;
    if (!silent) {
      const token = state.push("sandy_wikilink", "", 0);
      const pipe = inner.indexOf("|");
      token.content = pipe >= 0 ? inner.slice(pipe + 1) : inner;
    }
    state.pos = close + 2;
    return true;
  });
  md.renderer.rules.sandy_wikilink = (tokens, idx) =>
    `<span class="pd-wiki">${md.utils.escapeHtml(tokens[idx].content)}</span>`;

  /* ==highlight== (same syntax the editor renders) */
  md.inline.ruler.before("emphasis", "sandy_highlight", (state, silent) => {
    const { src, pos } = state;
    if (src.charCodeAt(pos) !== 61 /* = */ || src.charCodeAt(pos + 1) !== 61) return false;
    if (src.charCodeAt(pos + 2) === 61) return false; // === run — not a highlight
    const close = src.indexOf("==", pos + 2);
    if (close < 0 || close === pos + 2) return false;
    const inner = src.slice(pos + 2, close);
    if (inner.includes("\n")) return false;
    /* Both guards are highlightMark.ts's, and they were missing here: without
     * the second, `a == b and c == d` takes a yellow stripe across `= b and c =`
     * on paper and nothing at all on screen. */
    if (/^[ \t]|[ \t]$/.test(inner)) return false;
    if (!silent) {
      const open = state.push("mark_open", "mark", 1);
      open.markup = "==";
      const text = state.push("text", "", 0);
      text.content = inner;
      const closeTok = state.push("mark_close", "mark", -1);
      closeTok.markup = "==";
    }
    state.pos = close + 2;
    return true;
  });

  /* Obsidian callouts "> [!type] Title": class the blockquote, promote the
   * title to bold, drop the [!type] token. Mirrors livePreview's CALLOUT_KIND
   * so print matches the editor. */
  md.core.ruler.push("sandy_callouts", (state: StateCore) => {
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== "blockquote_open") continue;
      const inline = toks[i + 2];
      if (toks[i + 1]?.type !== "paragraph_open" || inline?.type !== "inline") continue;
      const lines = inline.content.split("\n");
      const m = /^\[!(\w+)\][-+]?([ \t]*)(.*)$/.exec(lines[0]);
      if (!m) continue;
      const kind = CALLOUT_KIND[m[1].toLowerCase()] ?? "note";
      const label =
        m[3] && m[3].trim()
          ? m[3].trim()
          : m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      lines[0] = `**${label}**`;
      inline.content = lines.join("\n");
      inline.children = [];
      md.inline.parse(inline.content, md, state.env, inline.children);
      toks[i].attrJoin("class", `pd-callout pd-callout-${kind}`);
    }
  });

  /* task lists: strip the [ ]/[x] prefix, class the <li>, CSS draws the box */
  md.core.ruler.push("sandy_tasks", (state: StateCore) => {
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== "list_item_open") continue;
      for (let j = i + 1; j < toks.length && toks[j].type !== "list_item_close"; j++) {
        if (toks[j].type !== "inline") continue;
        const first = toks[j].children?.[0];
        if (first?.type === "text") {
          const m = /^\[([ xX])\] /.exec(first.content);
          if (m) {
            first.content = first.content.slice(m[0].length);
            toks[i].attrJoin("class", m[1] === " " ? "pd-task" : "pd-task pd-task-done");
          }
        }
        break;
      }
    }
  });

  /* Per-block `lang`, which is what makes print.css's `hyphens: auto` real:
   * Chromium picks its hyphenation dictionary from this attribute and quietly
   * produces *no breaks at all* when it picks the wrong one. `index.html` is
   * `lang="en"` document-wide, so without this every Russian paragraph would be
   * offered English patterns. The script test is the editor's own — the same
   * count that already chooses « » over “ ” for this text.
   *
   * The attribute lands on the nearest block that actually renders: in a tight
   * list markdown-it marks `paragraph_open` hidden, so the walk continues out
   * to the `<li>`. First writer wins, so a block whose parts disagree keeps the
   * language of its opening line rather than flickering per sentence. */
  md.core.ruler.push("sandy_lang", (state: StateCore) => {
    const open: typeof state.tokens = [];
    for (const token of state.tokens) {
      if (token.nesting === 1) open.push(token);
      else if (token.nesting === -1) open.pop();
      else if (token.type === "inline" && token.content.trim()) {
        for (let i = open.length - 1; i >= 0; i--) {
          if (open[i].hidden) continue;
          if (!open[i].attrGet("lang")) open[i].attrSet("lang", dominantLang(token.content));
          break;
        }
      }
    }
  });

  /* Smart typography: the editor's own scanner rather than markdown-it's
   * typographer, which converts a different set (© ™ +- ??? and *every* single
   * quote) and would put glyphs on paper the page never showed. Text tokens
   * only — a code span, one of our wiki-link tokens or an autolink's own address
   * is never one, which is the same list `NO_SMART_NODE` skips in the editor.
   * Pushed last so it sees the callout titles the rule above re-parses. */
  if (smart) {
    md.core.ruler.push("sandy_typography", (state: StateCore) => {
      for (const token of state.tokens) {
        if (token.type !== "inline" || !token.children) continue;
        let verbatim = 0;
        for (const child of token.children) {
          // an autolink/linkified link renders its own href as its label
          if (child.info === "auto") verbatim += child.nesting;
          else if (child.type === "text" && !verbatim) {
            child.content = smartTypographyText(child.content);
          }
        }
      }
    });
  }

  /* note-relative image srcs (attachments/…) need the asset-protocol mapping */
  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const src = tokens[idx].attrGet("src");
    if (src) tokens[idx].attrSet("src", resolveImageSrc(src));
    return defaultImage(tokens, idx, options, env, self);
  };

  /* The editor shows a fence's info string as the card's label (the ``` marks
   * themselves are hidden). markdown-it only writes it into a `language-…`
   * class, which no stylesheet can print — so it also goes on as an attribute
   * print.css can pull into the card's edge. */
  const defaultFence = md.renderer.rules.fence!;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const html = defaultFence(tokens, idx, options, env, self);
    const lang = tokens[idx].info.trim().split(/\s+/)[0];
    return lang ? html.replace("<pre", `<pre data-lang="${md.utils.escapeHtml(lang)}"`) : html;
  };

  return md;
}

/* Split a leading YAML frontmatter block off the body. Detection mirrors
 * src/editor/frontmatter.ts exactly — line 1 is "---" and a closing fence
 * exists — so a lone leading "---" stays an ordinary horizontal rule here too. */
function splitFrontmatter(text: string): { props: string[]; body: string } {
  const lines = text.split("\n");
  if (lines[0]?.replace(/\r$/, "") !== "---") return { props: [], body: text };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (line === "---" || line === "...") {
      return {
        props: lines.slice(1, i),
        body: lines.slice(i + 1).join("\n").replace(/^\s*\n/, ""),
      };
    }
  }
  return { props: [], body: text };
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One property's value, with the two things the card renders specially. */
function propertyValue(escaped: string, keyed: boolean): string {
  const value = escaped.trim();
  // a bare true/false is a checkbox in the card (BoolWidget) — on paper it is
  // the same box the task list already prints. Under a key only: livePreview
  // reaches BoolWidget from inside its `keyed` branch, so a keyless line that
  // happens to read "true" is plain text on screen and stays plain text here.
  if (keyed && (value === "true" || value === "false")) {
    return escaped.replace(value, `<span class="pd-bool">${value === "true" ? "☑" : "☐"}</span>`);
  }
  return escaped.replace(/\[\[([^\]\n]+)\]\]/g, (_m, inner: string) => {
    const pipe = inner.indexOf("|");
    return `<span class="pd-wiki">${pipe >= 0 ? inner.slice(pipe + 1) : inner}</span>`;
  });
}

/* The properties card, not a dropped block: the editor renders frontmatter as a
 * quiet card and print.css's own promise is that an exported page and the page
 * it came from are the same document. Same rules as livePreview's frontmatter
 * pass — keys step back, a bare true/false is a checkbox, [[links]] keep their
 * look (paper has no vault to follow them to) — and the "---" fences collapse
 * into the card's edge exactly as they do on screen. */
function renderProperties(lines: string[]): string {
  const rows = lines
    .map((raw) => {
      const line = escapeHtml(raw.replace(/\r$/, ""));
      const indent = line.length - line.trimStart().length;
      const colon = line.indexOf(":");
      const keyed = colon > indent && /^[\w.$-]+$/.test(line.slice(indent, colon));
      const key = keyed ? `<span class="pd-key">${line.slice(0, colon + 1)}</span>` : "";
      return `<div class="pd-prop">${key}${propertyValue(keyed ? line.slice(colon + 1) : line, keyed)}</div>`;
    })
    .join("");
  return rows ? `<div class="pd-props">${rows}</div>` : "";
}

/**
 * The note's name as a CSS string, for `@page`'s running head (`--pd-title`).
 * A margin box's `content` takes a string token, so the value has to arrive
 * quoted and escaped — and it is written on `:root`, because the page context
 * inherits from the document element and not from `.print-doc`.
 */
export function printTitleValue(fileName: string): string {
  const title = fileName
    .replace(/\.(md|markdown|txt)$/i, "") // same suffix list as pickPdfSavePath
    .replace(/[\\"]/g, "\\$&")
    // a CSS escape is `\` + hex digits, so `\n` here would read as the letter
    // n rather than a newline — a control character has to go, not be escaped
    .replace(/\p{Cc}/gu, " ");
  return `"${title}"`;
}

export function renderPrintHtml(
  text: string,
  resolveImageSrc: (src: string) => string,
  smartTypography = true,
): string {
  const { props, body } = splitFrontmatter(text);
  return renderProperties(props) + buildRenderer(resolveImageSrc, smartTypography).render(body);
}
