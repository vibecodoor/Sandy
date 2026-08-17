import { useEffect, useMemo, useRef, useState } from "react";
import { Fzf } from "fzf";
import { type NoteAliases, noteStem } from "../vault/vault";

export interface DocHeading {
  line: number; // 1-based
  level: number;
  text: string;
}

interface QuickOpenProps {
  files: string[];
  /** Frontmatter aliases — extra search corpus rows resolving to their note. */
  aliases?: NoteAliases[];
  /** Vault-rel paths, most-recent-first (App pre-filters to this vault). */
  recents?: string[];
  /** Headings of the open document — a `#` query jumps instead of opening. */
  headings?: DocHeading[];
  onPick: (rel: string) => void;
  onPickHeading?: (line: number) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}

const MAX_RESULTS = 50;

/** Empty-query listing: recent notes first, then the rest of the vault. */
export function emptyQueryOrder(files: string[], recents: string[]): string[] {
  const seen = new Set(recents.map((r) => r.toLowerCase()));
  return [...recents, ...files.filter((f) => !seen.has(f.toLowerCase()))].slice(
    0,
    MAX_RESULTS,
  );
}

/** One searchable corpus entry: a note path, or one of its aliases. */
interface Entry {
  rel: string;
  label: string; // what fzf matches: the rel path, or the alias text
  alias?: string;
}

interface Row {
  rel: string | null; // null = "create note" or heading row
  label: string;
  positions?: Set<number>;
  /** Set on alias rows — shown as the name, resolving to `rel`. */
  alias?: string;
  /** Set on heading rows — activating jumps to this line. */
  headingLine?: number;
  headingLevel?: number;
}

/** Render `text` with `positions` (char indices) wrapped in <mark>. */
function highlight(text: string, positions: Set<number> | undefined) {
  if (!positions || positions.size === 0) return text;
  const out: React.ReactNode[] = [];
  let run = "";
  let marked = false;
  for (let i = 0; i <= text.length; i++) {
    const m = i < text.length && positions.has(i);
    if (m !== marked || i === text.length) {
      if (run) out.push(marked ? <mark key={i}>{run}</mark> : run);
      run = "";
      marked = m;
    }
    if (i < text.length) run += text[i];
  }
  return out;
}

export function QuickOpen({
  files,
  aliases = [],
  recents = [],
  headings = [],
  onPick,
  onPickHeading,
  onCreate,
  onClose,
}: QuickOpenProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = files.map((rel) => ({ rel, label: rel }));
    for (const note of aliases)
      for (const a of note.aliases) out.push({ rel: note.rel, label: a, alias: a });
    return out;
  }, [files, aliases]);

  const fzf = useMemo(
    () =>
      new Fzf(entries, {
        casing: "case-insensitive",
        limit: MAX_RESULTS,
        selector: (e) => e.label,
      }),
    [entries],
  );
  const headingFzf = useMemo(
    () =>
      new Fzf(headings, {
        casing: "case-insensitive",
        limit: MAX_RESULTS,
        selector: (h) => h.text,
      }),
    [headings],
  );

  const headingMode = onPickHeading != null && query.startsWith("#");

  const rows = useMemo<Row[]>(() => {
    if (headingMode) {
      const q = query.slice(1).trim();
      const toRow = (h: DocHeading, positions?: Set<number>): Row => ({
        rel: null,
        label: h.text,
        positions,
        headingLine: h.line,
        headingLevel: h.level,
      });
      return q
        ? headingFzf.find(q).map((e) => toRow(e.item, e.positions))
        : headings.slice(0, MAX_RESULTS).map((h) => toRow(h));
    }
    const q = query.trim();
    const out: Row[] = q
      ? fzf.find(q).map((e) => ({
          rel: e.item.rel,
          label: e.item.label,
          alias: e.item.alias,
          positions: e.positions,
        }))
      : emptyQueryOrder(files, recents).map((rel) => ({ rel, label: rel }));
    const exists = out.some(
      (r) =>
        r.rel &&
        (noteStem(r.rel).toLowerCase() === q.toLowerCase() ||
          r.alias?.toLowerCase() === q.toLowerCase()),
    );
    if (q && !exists) out.push({ rel: null, label: q });
    return out;
  }, [headingMode, headingFzf, headings, fzf, files, recents, query]);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    listRef.current
      ?.querySelector(".is-selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const activate = (row: Row) => {
    if (row.headingLine != null) onPickHeading?.(row.headingLine);
    else if (row.rel) onPick(row.rel);
    else onCreate(row.label);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (rows[selected]) activate(rows[selected]);
    }
  };

  return (
    <div className="overlay-backdrop" onMouseDown={onClose}>
      <div className="overlay-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="overlay-input"
          placeholder={onPickHeading ? "Open a note…  (# jumps to a heading)" : "Open a note…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <div className="overlay-list" ref={listRef}>
          {rows.map((row, i) => (
            <button
              key={
                row.headingLine != null
                  ? `#${row.headingLine}`
                  : row.rel
                    ? `${row.rel}\u0000${row.alias ?? ""}`
                    : "@@create"
              }
              type="button"
              className={`overlay-row${i === selected ? " is-selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => activate(row)}
            >
              {row.headingLine != null ? (
                <span
                  className="overlay-row-name overlay-row-heading"
                  style={{ paddingLeft: ((row.headingLevel ?? 1) - 1) * 14 }}
                >
                  <span className="overlay-heading-hash">{"#".repeat(row.headingLevel ?? 1)}</span>{" "}
                  {highlight(row.label, row.positions)}
                </span>
              ) : row.rel ? (
                <>
                  <span className="overlay-row-name">
                    {row.alias ? highlight(row.alias, row.positions) : noteStem(row.rel)}
                  </span>
                  <span className="overlay-row-detail">
                    {row.alias ? `→ ${row.rel}` : highlight(row.label, row.positions)}
                  </span>
                </>
              ) : (
                <span className="overlay-row-name is-create">
                  Create note “{row.label}”
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
