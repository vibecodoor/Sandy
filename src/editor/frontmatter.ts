import type { EditorState } from "@codemirror/state";

/*
 * YAML frontmatter → a quiet "properties" card.
 *
 * A "---" fence on line 1, a matching "---" (or "...") fence below, and
 * key/value lines between. Sandy renders it decoration-only, so the bytes on
 * disk never change, and the raw source reveals under
 * the cursor like every other construct.
 *
 * Detection is deliberately strict: the opening fence must be exactly "---" on
 * the very first line, and a closing fence must exist — otherwise a lone
 * leading "---" stays an ordinary horizontal rule.
 */
export interface FrontmatterInfo {
  /** closing-fence line number (the opening fence is always line 1) */
  toLine: number;
  /** document position at the end of the closing fence line */
  to: number;
}

export function frontmatterInfo(state: EditorState): FrontmatterInfo | null {
  const { doc } = state;
  if (doc.lines < 2 || doc.line(1).text !== "---") return null;
  for (let n = 2; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (text === "---" || text === "...") {
      return { toLine: n, to: doc.line(n).to };
    }
  }
  return null;
}

/**
 * Frontmatter `aliases:` (or `alias:`) values of a document — inline `[a, b]`,
 * a `- item` block list, or a comma-separated string; quotes stripped.
 * Empty when there is no (closed) frontmatter block. Mirrors the Rust
 * `parse_frontmatter_aliases` in lib.rs, which indexes the whole vault.
 */
export function frontmatterAliases(text: string): string[] {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines[0] !== "---") return [];
  const out: string[] = [];
  const push = (raw: string) => {
    const a = raw.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    if (a) out.push(a);
  };
  let inList = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === "---" || line === "...") return out;
    if (inList) {
      const lt = line.trimStart();
      if (lt.startsWith("- ")) {
        push(lt.slice(2));
        continue;
      }
      if (lt === "-") continue;
      inList = false;
    }
    const m = /^alias(?:es)?:(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[1].trim();
    if (!rest) inList = true;
    else if (rest.startsWith("[") && rest.endsWith("]"))
      rest.slice(1, -1).split(",").forEach(push);
    else rest.split(",").forEach(push);
  }
  return []; // no closing fence — a lone leading "---" is just a rule
}

/** The [[wiki-link]] under `pos` inside the frontmatter block, if any. */
export function frontmatterWikiLinkAt(
  state: EditorState,
  pos: number,
): { inner: string; from: number; to: number } | null {
  const fm = frontmatterInfo(state);
  if (!fm) return null;
  const line = state.doc.lineAt(pos);
  if (line.number > fm.toLine) return null;
  const re = /\[\[([^\]\n]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line.text))) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    if (pos >= from && pos <= to) return { inner: m[1], from, to };
  }
  return null;
}
