import { useCallback, useState } from "react";
import type { SaveStatus } from "../vault/saveQueue";
import type { WritingModes } from "../editor/writingModes";

export interface DocStats {
  words: number;
  characters: number;
  paragraphs: number;
  /** Reading minutes at 200 wpm; 0 means "under a minute", never rounded up. */
  minutes: number;
  /** The same, for the current selection — absent when nothing is selected. */
  selection?: { words: number; minutes: number };
}

const count = (n: number, unit: string) =>
  `${n.toLocaleString("en-US")} ${unit}${n === 1 ? "" : "s"}`;

/* A note under a hundred words is not "1 min read" — it is a glance. Rounding
 * up to keep a tidy number would be the panel's only untrue line. */
const readTime = (minutes: number) =>
  minutes === 0 ? "under a minute" : `${minutes.toLocaleString("en-US")} min read`;

interface CornerActionsProps {
  saveStatus: SaveStatus;
  /** null when no real file is open (welcome document). */
  filePath: string | null;
  onSave: () => void;
  onExportPdf: () => void;
  onRevealFile: (() => void) | null;
  /** Snapshot of the open document, computed lazily on hover. */
  getStats: () => DocStats | null;
  /** Opt-in focus aids; both default off. */
  writingModes: WritingModes;
  onToggleWritingMode: (kind: keyof WritingModes) => void;
}

/* Three stacked rules with the middle one lit — the typed line, held centre. */
const ICON_TYPEWRITER = (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M2.5 4h9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity="0.4" />
    <path d="M2.5 7h6.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M2.5 10h9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" opacity="0.4" />
  </svg>
);

/* A lit middle band between two receding ones — the focus dimming, in miniature. */
const ICON_FOCUS = (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <rect x="2.5" y="2.6" width="9" height="1.6" rx="0.8" fill="currentColor" opacity="0.32" />
    <rect x="2.5" y="6" width="9" height="2" rx="1" fill="currentColor" />
    <rect x="2.5" y="9.8" width="9" height="1.6" rx="0.8" fill="currentColor" opacity="0.32" />
  </svg>
);

/* A curly quote — the thing the switch actually produces. */
const ICON_TYPOGRAPHY = (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <text
      x="7"
      y="11"
      textAnchor="middle"
      fontSize="13"
      fontFamily="Georgia, serif"
      fill="currentColor"
    >
      “”
    </text>
  </svg>
);

/* All icons render 14-over-14: a 13/14 (or 12/14) box scaled every coordinate
 * by a fraction, so every axis-aligned stroke in the panel was AA mush. */
const ICON_CHECK = (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* A quiet dot in the bottom-right corner; hovering unfolds a small stack of
 * document actions. Deliberately invisible until wanted — the page stays calm. */
export function CornerActions({
  saveStatus,
  filePath,
  onSave,
  onExportPdf,
  onRevealFile,
  getStats,
  writingModes,
  onToggleWritingMode,
}: CornerActionsProps) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<DocStats | null>(null);

  const enter = useCallback(() => {
    setStats(getStats());
    setOpen(true);
  }, [getStats]);
  const leave = useCallback(() => setOpen(false), []);

  /* React's onBlur is focusout, which also fires when focus steps from one row
   * of the panel to the next. Closing on that would drop every item back to
   * tabIndex -1 halfway through a Tab sweep and strand the keyboard on <body>;
   * the panel only leaves when focus has actually left the corner. */
  const blur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget)) leave();
    },
    [leave],
  );

  /* The welcome document is not a file and cannot become one, so "Saved" was a
   * reassurance about something that had never happened. The button is
   * already disabled without a path; now it says why. */
  const saveLabel = !filePath
    ? "No file to save"
    : saveStatus.failure
      ? "Retry save"
      : saveStatus.dirty
        ? "Save"
        : "Saved";

  return (
    /* open from the trigger only — the (invisible) panel area above it must
     * not catch stray hovers while collapsed. The trigger comes FIRST in source
     * and the corner lays itself out `column-reverse` (shell.css): on screen the
     * panel is still above the dot, but a forward Tab now reaches the dot and
     * then its contents, instead of skipping the panel entirely. */
    <div
      className={`corner${open ? " is-open" : ""}`}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={blur}
    >
      <button
        type="button"
        className="corner-trigger"
        aria-label="Document actions"
        aria-expanded={open}
        onMouseEnter={enter}
        /* a pointer that never hovers — touch, pen — still gets in */
        onClick={enter}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="3" cy="7" r="1.05" fill="currentColor" />
          <circle cx="7" cy="7" r="1.05" fill="currentColor" />
          <circle cx="11" cy="7" r="1.05" fill="currentColor" />
        </svg>
      </button>
      <div className="corner-panel" aria-hidden={!open}>
        {/* Two short lines rather than one long one: the panel is sized by its
            widest row, and a single run of four numbers would have widened the
            whole surface by a third. Size first, then shape and time — and the
            selection speaks only when there is one. */}
        {stats ? (
          <div className="corner-stats">
            <span>
              {count(stats.words, "word")} · {count(stats.characters, "character")}
            </span>
            <span>
              {count(stats.paragraphs, "paragraph")} · {readTime(stats.minutes)}
            </span>
            {stats.selection ? (
              <span className="corner-stats-selection">
                {count(stats.selection.words, "word")} selected ·{" "}
                {readTime(stats.selection.minutes)}
              </span>
            ) : null}
          </div>
        ) : null}
        <button
          type="button"
          className="corner-item"
          disabled={!filePath || (!saveStatus.dirty && !saveStatus.failure)}
          tabIndex={open ? 0 : -1}
          onClick={onSave}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M2 1.5h8l2.5 2.5v8.5h-10.5z M4.5 1.5v3.5h5v-3.5 M4 12.5v-4h6v4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinejoin="round"
            />
          </svg>
          <span>{saveLabel}</span>
          <i
            className={`corner-dot${
              saveStatus.failure ? " is-failed" : saveStatus.dirty ? " is-dirty" : ""
            }`}
          />
        </button>
        <button
          type="button"
          className="corner-item"
          tabIndex={open ? 0 : -1}
          onClick={onExportPdf}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M3 .75h6l2.5 2.5v10h-8.5z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.1"
              strokeLinejoin="round"
            />
            <path d="M9 .75v2.5h2.5" fill="none" stroke="currentColor" strokeWidth="1.1" />
            <text
              x="7"
              y="10.6"
              textAnchor="middle"
              fontSize="4.6"
              fontFamily="inherit"
              fill="currentColor"
              stroke="none"
            >
              PDF
            </text>
          </svg>
          <span>Export PDF…</span>
        </button>
        {onRevealFile ? (
          <button
            type="button"
            className="corner-item"
            tabIndex={open ? 0 : -1}
            onClick={onRevealFile}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M1 3.5h4l1.5 1.5h6.5v7h-12z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinejoin="round"
              />
            </svg>
            <span>Show in Explorer</span>
          </button>
        ) : null}
        <div className="corner-sep" />
        <button
          type="button"
          className={`corner-item corner-toggle${writingModes.typewriter ? " is-on" : ""}`}
          role="switch"
          aria-checked={writingModes.typewriter}
          tabIndex={open ? 0 : -1}
          onClick={() => onToggleWritingMode("typewriter")}
        >
          {ICON_TYPEWRITER}
          <span>Typewriter</span>
          {writingModes.typewriter ? <i className="corner-check">{ICON_CHECK}</i> : null}
        </button>
        <button
          type="button"
          className={`corner-item corner-toggle${writingModes.focus ? " is-on" : ""}`}
          role="switch"
          aria-checked={writingModes.focus}
          tabIndex={open ? 0 : -1}
          onClick={() => onToggleWritingMode("focus")}
        >
          {ICON_FOCUS}
          <span>Focus</span>
          {writingModes.focus ? <i className="corner-check">{ICON_CHECK}</i> : null}
        </button>
        <button
          type="button"
          className={`corner-item corner-toggle${writingModes.typography ? " is-on" : ""}`}
          role="switch"
          aria-checked={writingModes.typography}
          tabIndex={open ? 0 : -1}
          title={"Render “ ” « » — … over plain ASCII source; the file keeps what you typed"}
          onClick={() => onToggleWritingMode("typography")}
        >
          {ICON_TYPOGRAPHY}
          <span>Smart typography</span>
          {writingModes.typography ? <i className="corner-check">{ICON_CHECK}</i> : null}
        </button>
      </div>
    </div>
  );
}
