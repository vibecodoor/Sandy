/*
 * Session persistence: last open file (caret/scroll) + recents + sidebar expansion.
 * localStorage only — UI state, never file content (files on disk stay the only truth).
 * Every read is defensive: missing or corrupt entries degrade to "no session".
 */
import { samePath } from "./vault";

const LAST_KEY = "sandy:last";
const RECENTS_KEY = "sandy:recents";
const RECENTS_MAX = 10;

export interface NotePosition {
  line: number; // 1-based
  col: number; // 0-based chars into the line
  /* Where the page sat, as a document position and not a pixel count: the first
   * line whose top was at or below the viewport's, plus the gap under it. A raw
   * scrollTop is meaningless once the file has changed underneath — it points at
   * a height that now holds different text — while a line number degrades to the
   * right neighbourhood, which is what a reading position is for. */
  anchorLine: number; // 1-based
  offset: number; // px between the viewport top and that line's top
}

export interface LastSession extends NotePosition {
  path: string;
}

/** Coerce a parsed blob into a position; anything odd degrades to the top. */
function readPosition(v: Partial<NotePosition> | null | undefined): NotePosition {
  const line = typeof v?.line === "number" && v.line >= 1 ? Math.floor(v.line) : 1;
  return {
    line,
    col: typeof v?.col === "number" && v.col >= 0 ? Math.floor(v.col) : 0,
    // entries written before the anchor existed carried a `scrollTop` no longer
    // meaningful here; falling back to the caret's own line reopens the note in
    // the right place rather than at the top
    anchorLine:
      typeof v?.anchorLine === "number" && v.anchorLine >= 1 ? Math.floor(v.anchorLine) : line,
    offset: typeof v?.offset === "number" && v.offset >= 0 ? v.offset : 0,
  };
}

export function loadLastSession(): LastSession | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LastSession>;
    if (typeof v.path !== "string" || !v.path) return null;
    return { path: v.path, ...readPosition(v) };
  } catch {
    return null;
  }
}

/* Where the reader stopped, per note — so switching away and back lands on the
 * line you left, not at the top. `sandy:last` above answers a different
 * question (which note to reopen at launch) and only ever holds one path. */
const POS_KEY = "sandy:pos";
const POS_MAX = 200; // insertion-ordered; the oldest notes fall off the end

type PositionMap = Record<string, NotePosition>;

function loadPositionMap(): PositionMap {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const map: PositionMap = {};
    for (const [key, pos] of Object.entries(v)) {
      if (typeof pos === "object" && pos !== null) {
        map[key] = readPosition(pos as Partial<NotePosition>);
      }
    }
    return map;
  } catch {
    return {};
  }
}

/** Same case/separator-insensitive identity the rest of the vault uses. */
function pathKey(path: string): string {
  return path.replaceAll("\\", "/").toLowerCase();
}

export function loadNotePosition(path: string): NotePosition | null {
  return loadPositionMap()[pathKey(path)] ?? null;
}

export function saveNotePosition(path: string, pos: NotePosition): void {
  const map = loadPositionMap();
  const key = pathKey(path);
  delete map[key]; // re-insert at the end = most-recently-read order
  map[key] = pos;
  const keys = Object.keys(map);
  for (const stale of keys.slice(0, Math.max(0, keys.length - POS_MAX))) {
    delete map[stale];
  }
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(map));
  } catch {
    // storage full/denied — losing a reading position is non-fatal
  }
}

export function saveLastSession(session: LastSession): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(session));
  } catch {
    // storage full/denied — losing the cursor position is non-fatal
  }
}

export function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((p): p is string => typeof p === "string" && p.length > 0)
      .slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

const EXPANDED_KEY = "sandy:expanded";
const EXPANDED_VAULTS_MAX = 10;

type ExpandedMap = Record<string, string[]>;

function vaultKey(root: string): string {
  return root.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function loadExpandedMap(): ExpandedMap {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
    const map: ExpandedMap = {};
    for (const [key, dirs] of Object.entries(v)) {
      if (!Array.isArray(dirs)) continue;
      map[key] = dirs.filter((d): d is string => typeof d === "string");
    }
    return map;
  } catch {
    return {};
  }
}

/** Folders start collapsed; this returns the dirs the user opened in this vault. */
export function loadExpandedDirs(root: string): string[] {
  return loadExpandedMap()[vaultKey(root)] ?? [];
}

export function saveExpandedDirs(root: string, dirs: string[]): void {
  const map = loadExpandedMap();
  const key = vaultKey(root);
  delete map[key]; // re-insert at the end = most-recently-used order
  map[key] = dirs;
  const keys = Object.keys(map);
  for (const stale of keys.slice(0, Math.max(0, keys.length - EXPANDED_VAULTS_MAX))) {
    delete map[stale];
  }
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(map));
  } catch {
    // non-fatal; expansion state just won't survive this session
  }
}

const WRITING_MODES_KEY = "sandy:writingModes";

/* Corner-panel switches. Shape mirrors editor/writingModes.ts — kept local so
 * the vault kernel stays free of editor imports. The two focus aids are off
 * unless the user turned them on; smart typography is on unless the user turned
 * it off — hence the asymmetric `=== true` / `!== false` reads. */
interface Switches {
  typewriter: boolean;
  focus: boolean;
  typography: boolean;
}

const SWITCH_DEFAULTS: Switches = { typewriter: false, focus: false, typography: true };

export function loadWritingModes(): Switches {
  try {
    const raw = localStorage.getItem(WRITING_MODES_KEY);
    if (!raw) return { ...SWITCH_DEFAULTS };
    const v = JSON.parse(raw) as Partial<Switches>;
    return {
      typewriter: v.typewriter === true,
      focus: v.focus === true,
      typography: v.typography !== false,
    };
  } catch {
    return { ...SWITCH_DEFAULTS };
  }
}

export function saveWritingModes(m: Switches): void {
  try {
    localStorage.setItem(
      WRITING_MODES_KEY,
      JSON.stringify({
        typewriter: !!m.typewriter,
        focus: !!m.focus,
        typography: !!m.typography,
      }),
    );
  } catch {
    // non-fatal; the mode just won't survive a restart
  }
}

/** Move `path` to the head (case/separator-insensitive dedup); returns the new list. */
export function pushRecent(path: string): string[] {
  const next = [
    path,
    ...loadRecents().filter((p) => !samePath(p, path)),
  ].slice(0, RECENTS_MAX);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // non-fatal; the in-memory list still updates for this session
  }
  return next;
}
