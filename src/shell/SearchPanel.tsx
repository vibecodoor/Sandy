import { useEffect, useRef, useState } from "react";
import { type SearchHit, noteStem, searchVault } from "../vault/vault";

interface SearchPanelProps {
  root: string;
  onPick: (rel: string, line: number) => void;
  onClose: () => void;
}

const DEBOUNCE_MS = 220;

/** Wrap case-insensitive occurrences of `query` in <mark>. */
function highlight(text: string, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const lower = text.toLowerCase();
  const out: React.ReactNode[] = [];
  let pos = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, pos)) {
    if (i > pos) out.push(text.slice(pos, i));
    out.push(<mark key={i}>{text.slice(i, i + q.length)}</mark>);
    pos = i + q.length;
  }
  out.push(text.slice(pos));
  return out;
}

export function SearchPanel({ root, onPick, onClose }: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setTruncated(false);
      setSearching(false);
      return;
    }
    setSearching(true);
    setFailed(null);
    let stale = false;
    const timer = setTimeout(() => {
      searchVault(root, q)
        .then((result) => {
          if (stale) return;
          setHits(result.hits);
          setTruncated(result.truncated);
          setSelected(0);
          setSearching(false);
        })
        .catch((err) => {
          // the panel says "No matches." for an empty result either way; this
          // is the difference between "nothing there" and "couldn't look"
          if (stale) return;
          setHits([]);
          setTruncated(false);
          setSearching(false);
          setFailed(err instanceof Error ? err.message : String(err));
        });
    }, DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [root, query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(".is-selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[selected];
      if (hit) onPick(hit.rel, hit.line);
    }
  };

  return (
    <div className="overlay-backdrop" onMouseDown={onClose}>
      <div className="overlay-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="overlay-input"
          placeholder="Search in notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <div className="overlay-list" ref={listRef}>
          {hits.map((hit, i) => (
            <button
              key={`${hit.rel}:${hit.line}:${i}`}
              type="button"
              className={`overlay-row${i === selected ? " is-selected" : ""}`}
              onMouseEnter={() => setSelected(i)}
              onClick={() => onPick(hit.rel, hit.line)}
            >
              <span className="overlay-row-name">{highlight(hit.text, query)}</span>
              <span className="overlay-row-detail">
                {noteStem(hit.rel)} · {hit.line}
              </span>
            </button>
          ))}
        </div>
        {searching || !query.trim() ? null : failed ? (
          <div className="overlay-hint">Couldn't search this folder. {failed}</div>
        ) : hits.length === 0 ? (
          <div className="overlay-hint">No matches.</div>
        ) : truncated ? (
          /* the walk stops at a cap part-way through a name-ordered vault, so
           * "no more hits" would be a lie about every note after this one */
          <div className="overlay-hint">
            Showing the first {hits.length} matches, in file order. Narrow the search to
            reach the rest.
          </div>
        ) : null}
      </div>
    </div>
  );
}
