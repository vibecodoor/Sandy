import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { openSearchPanel } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { Editor } from "./editor/Editor";
import {
  externalHref,
  insertImageMarkdown,
  linkAt,
  vaultIndexChanged,
} from "./editor/extensions";
import { sourceRevealActive, toggleSourceReveal } from "./editor/revealSource";
import { applyWritingModes, type WritingModes } from "./editor/writingModes";
import { visibleStats, visibleWordCount } from "./editor/visibleText";
import {
  toggleBold,
  toggleInlineCode,
  toggleItalic,
  toggleLinkCommand,
  toggleStrike,
} from "./editor/markdownKeymap";
import {
  type Eol,
  basename,
  convertToMarkdown,
  copyAttachment,
  fileExists,
  forgetBom,
  gitAutocommit,
  initialFile,
  isImportable,
  isTauri,
  loadDoc,
  pickMarkdownFile,
  pickPdfSavePath,
  saveAttachment,
  saveDoc,
} from "./vault/files";
import { SaveQueue, type SaveStatus } from "./vault/saveQueue";
import {
  type LastSession,
  loadLastSession,
  loadNotePosition,
  loadRecents,
  loadWritingModes,
  pushRecent,
  saveLastSession,
  saveNotePosition,
  saveWritingModes,
} from "./vault/session";
import {
  type NoteAliases,
  attachmentRelPath,
  createNote,
  deleteNote,
  headingSlug,
  imageExt,
  isUnder,
  joinPath,
  parentDir,
  pickVaultFolder,
  renameNote,
  resolveWikiTarget,
  safeNoteRelPath,
  samePath,
  scanAliases,
  scanVault,
  wikiTargetHeading,
} from "./vault/vault";
import { frontmatterAliases } from "./editor/frontmatter";
import {
  loadActiveVault,
  loadKnownVaults,
  pushKnownVault,
  removeKnownVault,
  saveActiveVault,
} from "./vault/vaults";
import { Titlebar } from "./shell/Titlebar";
import { Sidebar } from "./shell/Sidebar";
import { QuickOpen, type DocHeading } from "./shell/QuickOpen";
import { SearchPanel } from "./shell/SearchPanel";
import { CornerActions, type DocStats } from "./shell/CornerActions";
import { ContextMenu, type MenuEntry } from "./shell/ContextMenu";
import { restoreWindowGeometry, watchWindowGeometry } from "./shell/windowState";
import "./shell/shell.css";
import "./shell/print.css";
import sampleDoc from "./sample.md?raw";

interface OpenFile {
  path: string;
  name: string;
  eol: Eol;
}

interface DocumentSession {
  file: OpenFile | null;
  doc: string;
}

type Theme = "light" | "dark";
type Overlay = null | "quickopen" | "search";

const AUTOSAVE_MS = 800;
const NOTICE_MS = 6000;
/* The window stays invisible until the first document is on screen, and the
 * read in front of that has no timeout of its own: a slow share or a sleeping
 * disk showed nothing at all, for as long as the OS took to answer. After this
 * long the window comes up anyway, wearing the same cover a file switch does. */
const STARTUP_REVEAL_MS = 1200;
/* Ctrl+N names the note itself, so the name only has to be free — the first
 * line you type is the real title, and F2 puts it on the file. */
const NEW_NOTE_NAME = "Untitled";
const WELCOME_SESSION: DocumentSession = { file: null, doc: sampleDoc };
const THEME_KEY = "sandy:theme";
const SIDEBAR_KEY = "sandy:sidebar";

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * A thrown value as something a person can read. The native commands answer
 * with a plain string and already word their refusals for a reader, so it is
 * shown as written rather than translated into a house phrase.
 */
function errorText(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err.trim();
  if (err instanceof Error && err.message) return err.message;
  return "No reason was given.";
}

/** Same file list, same order — the native walk is stable, so this is enough. */
function sameFiles(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

/**
 * Where the page sits, as something that survives the file changing: the first
 * line whose top is at or below the viewport's, and the gap under it. Anchoring
 * on a line rather than a `scrollTop` is what lets a reading position degrade
 * to the right neighbourhood instead of to a height that now holds other text.
 */
function scrollAnchor(view: EditorView, caretLine: number): { anchorLine: number; offset: number } {
  const rect = view.scrollDOM.getBoundingClientRect();
  const doc = view.state.doc;
  let line = doc.lineAt(view.posAtCoords({ x: rect.left + 1, y: rect.top + 1 }, false));
  let coords = view.coordsAtPos(line.from);
  // the line at the top edge may be half scrolled out of it; the next one starts
  // inside the viewport, so the gap below stays positive and restores exactly
  if (coords && coords.top < rect.top && line.to < doc.length) {
    line = doc.lineAt(line.to + 1);
    coords = view.coordsAtPos(line.from);
  }
  /* No coordinates means that line is outside the rendered range, so the
   * position above came from CM6's *estimated* heights and points at the wrong
   * line — measured: it named line 107 for a viewport actually showing line 170.
   * Reopening at the caret is the honest fallback; a confident wrong answer is
   * the one thing this must not return. */
  if (!coords) return { anchorLine: caretLine, offset: 0 };
  return {
    anchorLine: line.number,
    // yMargin must stay under the editor's height, and a gap never exceeds one line
    offset: Math.max(0, Math.min(Math.round(coords.top - rect.top), rect.height - 1)),
  };
}

/* 200 wpm, and deliberately never rounded up: under half a minute of prose
 * reports 0, which the corner panel prints as "under a minute". A three-word
 * selection claiming "1 min read" was the one untrue thing on that panel. */
const readingMinutes = (words: number) => Math.round(words / 200);

/** ATX headings of the open document (fenced code skipped) for quick-open `#`. */
function collectHeadings(text: string): DocHeading[] {
  const out: DocHeading[] = [];
  let fence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) out.push({ line: i + 1, level: m[1].length, text: m[2] });
  }
  return out;
}

export default function App() {
  const [session, setSession] = useState<DocumentSession | null>(() =>
    isTauri ? null : WELCOME_SESSION,
  );
  const [opening, setOpening] = useState(isTauri);
  const [vaultRoot, setVaultRoot] = useState<string | null>(() =>
    isTauri ? loadActiveVault() : null,
  );
  const [vaultFiles, setVaultFiles] = useState<string[]>([]);
  const [aliasIndex, setAliasIndex] = useState<NoteAliases[]>([]);
  const [vaults, setVaults] = useState<string[]>(() => loadKnownVaults());
  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) === "1",
  );
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(THEME_KEY) as Theme | null) ?? systemTheme(),
  );
  const [recents, setRecents] = useState<string[]>(() => loadRecents());
  const [writingModes, setWritingModesState] = useState<WritingModes>(() => loadWritingModes());

  const viewRef = useRef<EditorView | null>(null);
  const openGeneration = useRef(0);
  const fileRef = useRef<OpenFile | null>(null);
  const vaultRef = useRef<{ root: string | null; files: string[] }>({ root: null, files: [] });
  const pendingSeek = useRef<{ path: string; line: number } | null>(null);
  const pendingRestore = useRef<LastSession | null>(null);
  /* Navigation history (Alt+←/→): in-memory only, {path, line} per visited
   * note. `navigatingTo` marks an open issued by the history itself so it
   * isn't re-pushed; it self-clears if that open never lands. */
  const navRef = useRef<{
    stack: { path: string; line: number }[];
    index: number;
    navigatingTo: string | null;
  }>({ stack: [], index: -1, navigatingTo: null });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Save orchestration: single-flight queue; failures surface instead of vanishing. */
  const saveQueue = useRef<SaveQueue | null>(null);
  // `saveDoc` commits the note itself and reports back if git refused; the
  // queue only has to pass that on.
  if (!saveQueue.current) saveQueue.current = new SaveQueue(saveDoc);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>(() => saveQueue.current!.status());
  const [closeBlocked, setCloseBlocked] = useState(false);
  const closingRef = useRef(false);

  /* Everything that can go wrong away from the save path — a refused rename, a
   * note that won't open, an image that didn't land — used to reach a console
   * that release builds do not have (no devtools, no log plugin). This is the
   * one place it can say so: the save banner's own strip, borrowed for a line
   * of text that clears itself. A save failure outranks it and stays put. */
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => {
      setNotice(null);
      noticeTimer.current = null;
    }, NOTICE_MS);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  useEffect(() => {
    const queue = saveQueue.current!;
    queue.onStatus = setSaveStatus;
    /* The write landed; only its history snapshot didn't. Said once per run —
     * whatever stopped it will stop the next one too. */
    queue.onGitError = (message) =>
      showNotice(`Saved. Version history is not being kept: ${message}`);
    return () => {
      queue.onStatus = null;
      queue.onGitError = null;
    };
  }, [showNotice]);

  useEffect(() => {
    if (!saveStatus.failure) setCloseBlocked(false);
  }, [saveStatus.failure]);

  const file = session?.file ?? null;
  fileRef.current = file;
  vaultRef.current = { root: vaultRoot, files: vaultFiles };

  /* ── theme ── */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  /* Flipping the theme is the one moment the whole window changes at once, so
   * it cross-fades as a single compositor snapshot: shadows, gradient fills
   * (the table's column dividers are one), the selection layer's blend mode,
   * the icons and the native scrollbars all ride along, and not one element
   * repaints. `data-theme` and the React state are flipped together inside the
   * callback — a view transition captures the "after" frame the moment it
   * returns, so a state update left to React's own scheduling would be caught
   * half-applied and the titlebar icon would pop in after the fade.
   * Fallback for a runtime without the API: the class in index.css, which
   * fades the colour properties only and comes off after one beat, so nothing
   * carries a paint transition into ordinary editing. Duration and reduced
   * motion live in index.css for both paths. */
  const themeShiftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyTheme = useCallback((next: Theme) => {
    const flip = () => {
      document.documentElement.dataset.theme = next;
      flushSync(() => setTheme(next));
    };
    if (!document.startViewTransition) {
      const root = document.documentElement;
      root.classList.add("is-theme-shifting");
      if (themeShiftTimer.current) clearTimeout(themeShiftTimer.current);
      themeShiftTimer.current = setTimeout(() => {
        root.classList.remove("is-theme-shifting");
        themeShiftTimer.current = null;
      }, 340);
      flip();
      return;
    }
    // `ready` rejects whenever the transition is skipped rather than run — a
    // hidden or minimized window (the system dark/light listener fires there),
    // or a second flip landing on this one. The flip itself has already run in
    // every one of those cases, so the rejection is noise; a throw out of `flip`
    // still surfaces, through `finished`.
    document.startViewTransition(flip).ready.catch(() => {});
  }, []);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      // an explicit override (set any time) always wins over system changes
      if (!localStorage.getItem(THEME_KEY)) applyTheme(mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [applyTheme]);
  const toggleTheme = useCallback(() => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }, [applyTheme]);

  /* ── writing modes (typewriter / focus) ── */
  useEffect(() => {
    saveWritingModes(writingModes);
    // New editors seed from the prop at creation; this keeps a live editor in sync.
    viewRef.current?.dispatch({ effects: applyWritingModes.of(writingModes) });
  }, [writingModes]);
  const toggleWritingMode = useCallback((kind: keyof WritingModes) => {
    setWritingModesState((m) => ({ ...m, [kind]: !m[kind] }));
    viewRef.current?.focus();
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((v) => {
      localStorage.setItem(SIDEBAR_KEY, v ? "0" : "1");
      /* Closing makes the panel inert, and inert drops whatever was focused
       * inside it onto `<body>`. Hand the keyboard back to the text instead. */
      if (v && document.activeElement?.closest(".sidebar")) viewRef.current?.focus();
      return !v;
    });
  }, []);

  /* ── vault index ── */
  /**
   * Re-index the vault. The alias pass reads every note's frontmatter — a walk
   * over the vault's *contents*, not just its names — so `deep: false` runs it
   * only when the file list actually moved. That is what makes the focus-return
   * refresh affordable; a plain note open doesn't re-index at all.
   * The list keeps its identity when nothing changed: the backlinks scan,
   * quick-open's index and the decoration nudge all key off it, and an
   * unchanged rescan must not restart any of them.
   */
  const refreshVault = useCallback(
    async (root: string, deep = true) => {
      try {
        const files = await scanVault(root);
        if (vaultRef.current.root !== root) return;
        const moved = !sameFiles(vaultRef.current.files, files);
        if (moved) setVaultFiles(files);
        if (!moved && !deep) return;
        const aliases = await scanAliases(root);
        if (vaultRef.current.root === root) setAliasIndex(aliases);
      } catch (err) {
        // the index is disposable, the notes are not — the open one is untouched
        showNotice(`Couldn't read this folder. ${errorText(err)}`);
      }
    },
    [showNotice],
  );

  useEffect(() => {
    if (vaultRoot) void refreshVault(vaultRoot);
    else {
      setVaultFiles([]);
      setAliasIndex([]);
    }
  }, [vaultRoot, refreshVault]);

  /* the active vault survives relaunch (session restore re-derives it only
   * when the restored file lives outside it) */
  useEffect(() => {
    if (isTauri) saveActiveVault(vaultRoot);
  }, [vaultRoot]);

  /* unresolved wiki-marks depend on the index — nudge decorations */
  useEffect(() => {
    viewRef.current?.dispatch({ effects: vaultIndexChanged.of(null) });
  }, [vaultFiles]);

  const geometryRestored = useRef(false);
  const windowShown = useRef(false);
  const revealWindow = useCallback(async () => {
    if (!isTauri) return;
    windowShown.current = true;
    try {
      /* Geometry first, and only on the launch reveal — the window is still
       * invisible then, so the move never shows. This also runs on every
       * later file open (the editor remounts per file), where re-applying
       * the stored rect made the window jump under the user. */
      if (!geometryRestored.current) {
        geometryRestored.current = true;
        await restoreWindowGeometry();
      }
      await invoke("reveal_main_window");
    } catch {
      // No notice: if this failed there may be no window to show one in, and
      // the window is revealed again by the next open.
    }
  }, []);

  /* Launch watchdog: the reveal normally rides on the first editor being ready,
   * which is one `read_doc` away. A file that errors already recovers to the
   * welcome document — a file that simply doesn't answer left no window on
   * screen at all. Show it anyway; `is-opening` is still up, so what arrives is
   * the page waiting, and the document lands in it when the read returns. */
  useEffect(() => {
    if (!isTauri) return;
    const timer = setTimeout(() => {
      if (!windowShown.current) void revealWindow();
    }, STARTUP_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [revealWindow]);

  /* remember where the window ends up (see shell/windowState.ts) */
  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void watchWindowGeometry().then((off) => {
      if (cancelled) off();
      else stop = off;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  /** Persist last file + caret + scroll so the next launch resumes in place —
   * and the same position under the note's own key, so *switching* back to it
   * later in the day lands there too, not at the top. */
  const recordSession = useCallback(() => {
    const view = viewRef.current;
    const f = fileRef.current;
    if (!view || !f) return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const pos = {
      line: line.number,
      col: head - line.from,
      ...scrollAnchor(view, line.number),
    };
    saveLastSession({ path: f.path, ...pos });
    saveNotePosition(f.path, pos);
  }, []);

  /* teardown paths that skip onCloseRequested (dev reload, forced destroy) */
  useEffect(() => {
    window.addEventListener("pagehide", recordSession);
    return () => window.removeEventListener("pagehide", recordSession);
  }, [recordSession]);

  /** Flush pending edits to disk. Resolves false when the write failed. */
  const saveNow = useCallback(async (): Promise<boolean> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    recordSession();
    const view = viewRef.current;
    const f = fileRef.current;
    const queue = saveQueue.current!;
    if (view && f) {
      queue.request({ path: f.path, text: view.state.doc.toString(), eol: f.eol });
    }
    return queue.flush();
  }, [recordSession]);

  const scheduleSave = useCallback(() => {
    if (!fileRef.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void saveNow(), AUTOSAVE_MS);
  }, [saveNow]);

  /** Caret line of the note being left → its history entry, so Back returns
   * to where you were, not to the top. Runs before the editor remounts. */
  const snapshotNavLine = useCallback(() => {
    const nav = navRef.current;
    const view = viewRef.current;
    const f = fileRef.current;
    const cur = nav.stack[nav.index];
    if (view && f && cur && samePath(cur.path, f.path)) {
      cur.line = view.state.doc.lineAt(view.state.selection.main.head).number;
    }
  }, []);

  const recordNav = useCallback(
    (path: string) => {
      const nav = navRef.current;
      snapshotNavLine();
      if (nav.navigatingTo) {
        const wasHistory = samePath(nav.navigatingTo, path);
        nav.navigatingTo = null;
        if (wasHistory) return; // a Back/Forward landing — the index is already set
      }
      if (nav.stack[nav.index] && samePath(nav.stack[nav.index].path, path)) return;
      nav.stack.splice(nav.index + 1); // a new open discards the forward branch
      nav.stack.push({ path, line: 1 });
      if (nav.stack.length > 100) nav.stack.shift();
      nav.index = nav.stack.length - 1;
    },
    [snapshotNavLine],
  );

  const openPath = useCallback(
    async (path: string, opts?: { reload?: boolean; quiet?: boolean }) => {
      const current = fileRef.current;
      // `reload` re-reads a file that is already open, deliberately dropping the
      // in-memory edits. Only the disk-conflict banner uses it. `quiet` is for
      // the session restore, where a file that moved since last launch is an
      // expected miss and the welcome document is the whole answer.
      if (!opts?.reload && current && samePath(current.path, path) && viewRef.current) {
        // already open: same doc string would skip the editor remount and
        // strand the opening cover — just surface the window instead
        setOverlay(null);
        viewRef.current.focus();
        void revealWindow();
        return;
      }
      const generation = ++openGeneration.current;
      /* Re-reading the file already on screen swaps its text in place — the
       * editor keeps its view (and its undo history with it), so there is no
       * remount to cover and no reason to take the keyboard away. */
      const inPlace =
        !!opts?.reload && !!current && samePath(current.path, path) && !!viewRef.current;
      if (!inPlace) {
        setOpening(true);
        viewRef.current?.contentDOM.blur();
      }
      setOverlay(null);
      try {
        // a reload has already discarded the pending write — don't re-queue it
        const flushed = opts?.reload ? true : await saveNow();
        if (!flushed && fileRef.current) {
          // the open file is not safely on disk — stay on it, the banner explains
          if (generation !== openGeneration.current) return;
          setOpening(false);
          viewRef.current?.focus();
          void revealWindow();
          return;
        }
        let target = path;
        if (isTauri && isImportable(path)) {
          // Foreign document → convert to Markdown and open a sibling note. The
          // source is only read; the `.md` suffix is appended to the full name
          // (`notes.docx` → `notes.docx.md`) so a hand-written `notes.md` is
          // never clobbered. The new note is saved atomically + git-committed.
          target = `${path}.md`;
          const exists = await fileExists(target);
          if (generation !== openGeneration.current) return;
          if (!exists) {
            const md = await convertToMarkdown(path);
            if (generation !== openGeneration.current) return;
            // This is the app's only save that runs before its own loadDoc, so
            // it is the only one that can inherit a BOM flag from whatever used
            // to live at this path — a converted note never has one.
            forgetBom(target);
            // `force`: we just proved the note isn't there, so this is a
            // creation, not an overwrite. Without it the disk-authority guard
            // reads a remembered fingerprint for a path that no longer exists
            // (re-importing after deleting the note outside Sandy) as a
            // conflict. `saveDoc` commits the new note itself.
            await saveDoc(target, md, "\n", true);
          }
        }

        const loaded = await loadDoc(target);
        if (generation !== openGeneration.current) return;
        if (loaded.mixedEol) {
          // said once, when the file opens: the first save settles the file on
          // one style, and finding that out afterwards is worse
          showNotice(
            `“${basename(target)}” mixes Windows and Unix line endings. Saving writes them all in the style it mostly uses.`,
          );
        }
        recordNav(target);
        /* A note reopens where you stopped reading it. Precedence, highest
         * first: an explicit jump (a search hit, a backlink, Alt+←/→) has
         * already set pendingSeek and wins outright; the launch restore has
         * already set pendingRestore for this exact path; otherwise the
         * remembered position, or nothing. An in-place reload keeps the view
         * it has, so it asks for neither. */
        if (!inPlace) {
          const seeking = !!pendingSeek.current && samePath(pendingSeek.current.path, target);
          const restoring =
            !!pendingRestore.current && samePath(pendingRestore.current.path, target);
          if (seeking) {
            pendingRestore.current = null;
          } else if (!restoring) {
            const pos = loadNotePosition(target);
            pendingRestore.current = pos ? { path: target, ...pos } : null;
          }
        }
        setSession({
          file: { path: target, name: basename(target), eol: loaded.eol },
          doc: loaded.text,
        });
        setRecents(pushRecent(target));
        const { root, files } = vaultRef.current;
        if (!root || !isUnder(target, root)) {
          setVaultRoot(parentDir(target));
        } else if (!files.some((f) => samePath(joinPath(root, f), target))) {
          void refreshVault(root); // the note is new since the last scan
        }
      } catch (err) {
        if (generation !== openGeneration.current) return;
        // The note refused to open (encoding, permissions, a lock, a file that
        // is no longer there). Recovery is the same as it always was; what
        // changes is that it says which file and why instead of showing an
        // unexplained welcome screen.
        if (!opts?.quiet) {
          showNotice(`Couldn't open “${basename(path)}”. ${errorText(err)}`);
        }
        const view = viewRef.current;
        if (view) {
          setOpening(false);
          view.focus();
          void revealWindow();
        } else {
          setSession(WELCOME_SESSION);
        }
      }
    },
    [recordNav, refreshVault, revealWindow, saveNow, showNotice],
  );

  /* Alt+← / Alt+→ walk the visited-note history like a browser. */
  const navigateHistory = useCallback(
    (dir: -1 | 1) => {
      const nav = navRef.current;
      const next = nav.index + dir;
      const entry = nav.stack[next];
      if (!entry) return;
      snapshotNavLine();
      nav.index = next;
      nav.navigatingTo = entry.path;
      pendingSeek.current = { path: entry.path, line: entry.line };
      void openPath(entry.path);
    },
    [openPath, snapshotNavLine],
  );

  const openFile = useCallback(async () => {
    if (!isTauri) return;
    try {
      const path = await pickMarkdownFile();
      if (path) await openPath(path);
    } catch (err) {
      showNotice(`Couldn't open the file picker. ${errorText(err)}`);
    }
  }, [openPath, showNotice]);

  const openFolder = useCallback(async () => {
    if (!isTauri) return;
    try {
      const root = await pickVaultFolder();
      if (!root) return;
      setVaultRoot(root);
      setVaults(pushKnownVault(root));
      setSidebarOpen(true);
      localStorage.setItem(SIDEBAR_KEY, "1");
    } catch (err) {
      showNotice(`Couldn't open the folder picker. ${errorText(err)}`);
    }
  }, [showNotice]);

  const switchVault = useCallback((root: string) => {
    setVaultRoot(root);
    setVaults(pushKnownVault(root));
  }, []);

  const removeVault = useCallback((root: string) => {
    setVaults(removeKnownVault(root));
  }, []);

  const openRel = useCallback(
    (rel: string, line?: number) => {
      const { root } = vaultRef.current;
      if (!root) return;
      const abs = joinPath(root, rel);
      const view = viewRef.current;
      const current = fileRef.current;
      if (line && view && current && samePath(abs, current.path)) {
        // jump inside the already-open note — no reload involved
        setOverlay(null);
        const ln = Math.max(1, Math.min(line, view.state.doc.lines));
        const pos = view.state.doc.line(ln).from;
        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "center" }),
        });
        view.focus();
        return;
      }
      pendingSeek.current = line ? { path: abs, line } : null;
      void openPath(abs);
    },
    [openPath],
  );

  /* Click on [[link]]: open the note, or create it when unresolved.
   * A `#heading` fragment lands on that heading instead of the top. */
  const followWikiLink = useCallback(
    async (inner: string) => {
      const { root, files } = vaultRef.current;
      if (!root) {
        // Fresh install: the welcome document invites this click and there is
        // nowhere for it to land yet. Ask where the notes live instead of
        // quietly doing nothing.
        void openFolder();
        return;
      }
      const resolved = resolveWikiTarget(inner, files);
      if (resolved) {
        const heading = wikiTargetHeading(inner);
        if (!heading) {
          openRel(resolved);
          return;
        }
        const abs = joinPath(root, resolved);
        const current = fileRef.current;
        const view = viewRef.current;
        // the note may already be open — read its live buffer, not the disk copy
        let text: string | null =
          current && view && samePath(abs, current.path) ? view.state.doc.toString() : null;
        if (text === null) {
          try {
            text = (await loadDoc(abs)).text;
          } catch {
            // No notice: this read only locates a heading. The open below
            // still happens and reports for itself if the note won't load.
          }
        }
        const want = headingSlug(heading);
        const hit = text ? collectHeadings(text).find((h) => headingSlug(h.text) === want) : null;
        openRel(resolved, hit?.line); // heading missing → open the note at the top
        return;
      }
      const rel = safeNoteRelPath(inner);
      if (!rel) return;
      try {
        await createNote(joinPath(root, rel));
        await openPath(joinPath(root, rel));
      } catch (err) {
        showNotice(`Couldn't create “${rel}”. ${errorText(err)}`);
      }
    },
    [openFolder, openPath, openRel, showNotice],
  );

  /**
   * Ctrl+N, and "New note here" on a folder. Both go through the one creation
   * path there has ever been (`create_note`, which makes the folders it needs);
   * what is new is *where*: the folder you are already reading, rather than the
   * vault root every time. A folder row passes its own path instead.
   * The note arrives empty and focused, so the first keystroke lands in it.
   */
  const newNote = useCallback(
    async (dirRel?: string) => {
      const { root } = vaultRef.current;
      if (!root) {
        // nowhere for it to land yet — same answer as a click on an unresolved
        // link: ask where the notes live
        void openFolder();
        return;
      }
      const cur = fileRef.current;
      const dir =
        dirRel != null
          ? dirRel
            ? joinPath(root, dirRel)
            : root
          : cur && isUnder(cur.path, root)
            ? (parentDir(cur.path) ?? root)
            : root;
      try {
        /* Ask the disk, not the index: the index is a scan old enough to miss a
         * note made a second ago, and two `Untitled` in a row is exactly the
         * case this has to survive. `create_note` refuses to clobber either. */
        let abs: string | null = null;
        for (let n = 1; n <= 99 && !abs; n++) {
          const name = n === 1 ? `${NEW_NOTE_NAME}.md` : `${NEW_NOTE_NAME} ${n}.md`;
          if (!(await fileExists(joinPath(dir, name)))) abs = joinPath(dir, name);
        }
        if (!abs) {
          showNotice(`There are already 99 notes called “${NEW_NOTE_NAME}” here.`);
          return;
        }
        await createNote(abs);
        await openPath(abs);
      } catch (err) {
        showNotice(`Couldn't make a new note. ${errorText(err)}`);
      }
    },
    [openFolder, openPath, showNotice],
  );

  /* ── rename / delete (the trust core): both run through the quarantined
   * Rust commands; the sidebar stays a read-only view that asks. ── */
  const [renameTarget, setRenameTarget] = useState<string | null>(null);

  const renameNoteAction = useCallback(
    async (rel: string, newName: string) => {
      setRenameTarget(null);
      const { root } = vaultRef.current;
      if (!root) return;
      try {
        // the vault-wide rewrite must see the open buffer's bytes on disk
        const flushed = await saveNow();
        if (!flushed) return; // save banner explains why nothing happened
        // the bytes the rewrite is about to walk — anything the buffer holds
        // beyond this was typed while the rename ran
        const flushedText = viewRef.current?.state.doc.toString();
        const res = await renameNote(root, rel, newName);
        const oldAbs = joinPath(root, rel);
        const newAbs = joinPath(root, res.new_rel);
        // navigation history follows the note to its new name
        for (const entry of navRef.current.stack) {
          if (samePath(entry.path, oldAbs)) entry.path = newAbs;
        }
        /* The file is already renamed by the time the link rewrite walks the
         * vault, so any note it couldn't write — or couldn't even read — keeps
         * the old name and nothing else would ever say so. */
        const missed = [
          ...res.failed,
          ...(res.skipped ?? []).map((s) => `${s.rel} (${s.reason})`),
        ];
        const parts: string[] = [];
        if (missed.length > 0) {
          parts.push(
            `Links still point at the old name in ${missed.length} note${
              missed.length === 1 ? "" : "s"
            }: ${missed.join(", ")}`,
          );
        }
        if (res.git_error) parts.push(`It isn't in version history: ${res.git_error}`);
        /* A name with a "/" in it is a move (the rename row says so before you
         * commit it). The note leaves the place you were looking at, so that
         * one is said out loud even when everything went right — a plain rename
         * stays quiet, since the row in front of you already shows it. */
        const folderOf = (r: string) => (r.includes("/") ? r.slice(0, r.lastIndexOf("/")) : "");
        const moved = !samePath(folderOf(rel), folderOf(res.new_rel));
        const headline = moved
          ? `Moved to ${folderOf(res.new_rel) || "the top of the vault"}.`
          : "Renamed.";
        if (parts.length > 0) showNotice(`${headline} ${parts.join(" ")}`);
        else if (moved) showNotice(headline);
        const cur = fileRef.current;
        const view = viewRef.current;
        const caretLine = view
          ? view.state.doc.lineAt(view.state.selection.main.head).number
          : 1;
        if (cur && samePath(cur.path, oldAbs)) {
          /* Text typed while the rename was in flight is only in the buffer,
           * and it is filed under a name that no longer exists: the reload
           * remounts the Editor on a new key, and Editor's own memory of this
           * note is keyed by the old path — nothing can reach either again. So
           * re-file it under the new name and land it before the reload reads
           * the disk back. (Left alone, the 800 ms autosave would also fire
           * against the old path and raise a conflict banner naming a file the
           * user just renamed away.) */
          const live = view?.state.doc.toString();
          if (view && live !== undefined && live !== flushedText) {
            if (saveTimer.current) {
              clearTimeout(saveTimer.current);
              saveTimer.current = null;
            }
            const queue = saveQueue.current!;
            queue.discard(oldAbs);
            queue.request({ path: newAbs, text: live, eol: cur.eol });
            if (!(await queue.flush())) return; // the save banner explains
          }
          // the open note itself moved (its own self-links may have changed)
          pendingSeek.current = { path: newAbs, line: caretLine };
          await openPath(newAbs, { reload: true });
        } else if (cur && res.rewritten.some((r) => samePath(joinPath(root, r), cur.path))) {
          // the open note's bytes changed on disk under us — reload in place
          pendingSeek.current = { path: cur.path, line: caretLine };
          await openPath(cur.path, { reload: true });
        }
        void refreshVault(root);
      } catch (err) {
        // the native side words its refusals for a reader (reserved name,
        // already taken, forbidden character) — show what it said
        showNotice(errorText(err));
        setRenameTarget(rel); // reopen the row so the refusal is visible
      }
    },
    [openPath, refreshVault, saveNow, showNotice],
  );

  const deleteNoteAction = useCallback(
    async (rel: string) => {
      const { root } = vaultRef.current;
      if (!root) return;
      const abs = joinPath(root, rel);
      try {
        const cur = fileRef.current;
        if (cur && samePath(cur.path, abs)) {
          // the note leaves for the trash with its unsaved edits — deliberate
          if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
          }
          saveQueue.current!.discard(abs);
        }
        const res = await deleteNote(abs);
        /* Images the note was using alone leave with it (to the Recycle Bin,
         * like the note). Said out loud because nothing else on screen shows
         * it — a shared image stays behind and is never mentioned. */
        const took = res.trashed?.length ?? 0;
        const parts: string[] = [];
        if (took > 0) {
          parts.push(`Its ${took === 1 ? "image went" : `${took} images went`} with it.`);
        }
        if (res.git_error) parts.push(`It isn't in version history: ${res.git_error}`);
        if (parts.length > 0) showNotice(`Deleted “${basename(abs)}”. ${parts.join(" ")}`);
        const nav = navRef.current;
        let removedBefore = 0;
        nav.stack.forEach((entry, i) => {
          if (samePath(entry.path, abs) && i <= nav.index) removedBefore++;
        });
        nav.stack = nav.stack.filter((entry) => !samePath(entry.path, abs));
        nav.index = Math.min(nav.index - removedBefore, nav.stack.length - 1);
        /* Re-read, don't reuse `cur`: the trash + commit above is long enough
         * to open another note in, and swapping *that* one for the welcome
         * document strands everything typed since — `fileRef.current` goes
         * null and `scheduleSave` returns early, so it is never written. */
        const open = fileRef.current;
        if (open && samePath(open.path, abs)) setSession(WELCOME_SESSION);
        void refreshVault(root);
      } catch (err) {
        showNotice(`Couldn't delete “${basename(abs)}”. ${errorText(err)}`);
      }
    },
    [refreshVault, showNotice],
  );

  /* Plain click on a rendered [text](url) / <autolink> — system browser. */
  const openExternalUrl = useCallback(
    (url: string) => {
      if (isTauri) {
        void import("@tauri-apps/plugin-opener")
          .then(({ openUrl }) => openUrl(url))
          .catch((err) => showNotice(`Couldn't open that link. ${errorText(err)}`));
      } else {
        window.open(url, "_blank", "noopener");
      }
    },
    [showNotice],
  );

  /* ── image attachments (P3) ── writes go through the quarantined native
   * commands; the editor stays insert-only */
  const attachImage = useCallback(
    async (data: ArrayBuffer, ext: string): Promise<string | null> => {
      const f = fileRef.current;
      if (!isTauri || !f) return null;
      const dir = parentDir(f.path);
      if (!dir) return null;
      const rel = attachmentRelPath(f.name, ext);
      const abs = joinPath(dir, rel);
      try {
        await saveAttachment(abs, data);
        void gitAutocommit(abs);
        return rel;
      } catch (err) {
        // the paste inserts nothing on null — without this the image simply
        // never appears and nothing explains it
        showNotice(`Couldn't save the pasted image. ${errorText(err)}`);
        return null;
      }
    },
    [showNotice],
  );

  const attachDroppedImage = useCallback(
    async (src: string) => {
      const f = fileRef.current;
      const view = viewRef.current;
      const ext = imageExt(src);
      if (!isTauri || !f || !view || !ext || view.composing) return;
      const dir = parentDir(f.path);
      if (!dir) return;
      const rel = attachmentRelPath(f.name, ext);
      const abs = joinPath(dir, rel);
      try {
        await copyAttachment(src, abs);
        void gitAutocommit(abs);
        insertImageMarkdown(view, rel);
        view.focus();
      } catch (err) {
        // a dropped image that lands nowhere leaves an empty page and no clue
        showNotice(`Couldn't add “${basename(src)}”. ${errorText(err)}`);
      }
    },
    [showNotice],
  );

  /* note-relative image srcs (attachments/…) render via the asset protocol;
   * absolute/external/bundled srcs pass through untouched */
  const resolveImageSrc = useCallback((src: string): string => {
    if (!isTauri) return src;
    if (/^(https?:|data:|blob:|asset:|file:)/i.test(src) || src.startsWith("/")) return src;
    if (/^[a-zA-Z]:[\\/]/.test(src)) return convertFileSrc(src);
    const f = fileRef.current;
    if (!f) return src;
    const dir = parentDir(f.path);
    if (!dir) return src;
    let rel = src;
    try {
      rel = decodeURI(src); // foreign notes may percent-encode spaces
    } catch {
      /* malformed escape — use the raw text */
    }
    return convertFileSrc(joinPath(dir, rel));
  }, []);

  /* ── context menu: project-styled replacement for the WebView2 menu ── */
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(
    null,
  );

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      /* Shift+right-click hands the event back to WebView2. The OS
       * spellchecker's corrections live in *its* menu and nowhere else, so
       * with the squiggle now on (extensions.ts) a blanket preventDefault
       * would have made the underline decoration. Ours, or — when asked —
       * the platform's. */
      if (e.shiftKey) return;
      e.preventDefault(); // the native menu never matches the app — ours or none

      // a sidebar note row: file operations instead of editing commands
      const row = (e.target as HTMLElement).closest?.("[data-rel]");
      const rel = row instanceof HTMLElement ? row.dataset.rel : undefined;
      if (rel) {
        const { root } = vaultRef.current;
        const items: MenuEntry[] = [
          { label: "Rename…", action: () => setRenameTarget(rel) },
        ];
        if (isTauri && root) {
          items.push({
            label: "Show in Explorer",
            action: () => {
              void import("@tauri-apps/plugin-opener")
                .then(({ revealItemInDir }) => revealItemInDir(joinPath(root, rel)))
                .catch((err) => showNotice(`Couldn't open Explorer. ${errorText(err)}`));
            },
          });
        }
        items.push("sep", {
          label: "Delete",
          action: () => void deleteNoteAction(rel),
        });
        setMenu({ x: e.clientX, y: e.clientY, items });
        return;
      }

      /* A folder row. Renaming and deleting a folder are Explorer's, on
       * purpose and not for want of a command: `[[links]]` resolve by stem, so
       * a folder that moves or is renamed breaks nothing, and Sandy would be
       * re-implementing a file manager to do it a second time. What it owes is
       * the two things Explorer can't do from here — put a note inside it, and
       * get you there. */
      const dirRow = (e.target as HTMLElement).closest?.("[data-dir]");
      const dirRel = dirRow instanceof HTMLElement ? dirRow.dataset.dir : undefined;
      if (dirRel != null) {
        const { root } = vaultRef.current;
        const items: MenuEntry[] = [
          { label: "New note here", action: () => void newNote(dirRel) },
        ];
        if (isTauri && root) {
          items.push({
            label: "Show in Explorer",
            action: () => {
              void import("@tauri-apps/plugin-opener")
                .then(({ revealItemInDir }) => revealItemInDir(joinPath(root, dirRel)))
                .catch((err) => showNotice(`Couldn't open Explorer. ${errorText(err)}`));
            },
          });
        }
        setMenu({ x: e.clientX, y: e.clientY, items });
        return;
      }

      const view = viewRef.current;
      if (!view || !view.dom.contains(e.target as Node)) {
        setMenu(null);
        return;
      }
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos != null) {
        // standard behavior: right-click outside the selection moves the caret
        const inSelection = view.state.selection.ranges.some(
          (r) => pos >= r.from && pos <= r.to,
        );
        if (!inSelection) view.dispatch({ selection: { anchor: pos } });
      }
      view.focus();

      const hasSelection = view.state.selection.ranges.some((r) => !r.empty);
      const selectedText = () =>
        view.state.selection.ranges
          .filter((r) => !r.empty)
          .map((r) => view.state.sliceDoc(r.from, r.to))
          .join("\n");
      const clipboardFailed = (err: unknown) =>
        showNotice(`Couldn't reach the clipboard. ${errorText(err)}`);
      const writeClipboard = (text: string) =>
        void navigator.clipboard?.writeText(text).catch(clipboardFailed);
      const pasteFromClipboard = () =>
        void navigator.clipboard
          ?.readText()
          .then((text) => {
            if (!text || view.composing) return;
            // synthesize a real paste so the smart-URL handler applies
            const dt = new DataTransfer();
            dt.setData("text/plain", text);
            const before = view.state;
            view.contentDOM.dispatchEvent(
              new ClipboardEvent("paste", {
                clipboardData: dt,
                bubbles: true,
                cancelable: true,
              }),
            );
            if (view.state === before) {
              view.dispatch({
                ...view.state.replaceSelection(text),
                userEvent: "input.paste",
                scrollIntoView: true,
              });
            }
            view.focus();
          })
          .catch(clipboardFailed);

      const items: MenuEntry[] = [];
      const link = pos != null ? linkAt(view.state, pos) : null;
      if (link) {
        if (link.kind === "wiki") {
          items.push(
            { label: "Open note", action: () => void followWikiLink(link.inner) },
            { label: "Copy link target", action: () => writeClipboard(link.inner) },
          );
        } else {
          const href = externalHref(link.url);
          items.push(
            {
              label: "Open link",
              disabled: !href,
              action: () => href && openExternalUrl(href),
            },
            { label: "Copy link address", action: () => writeClipboard(link.url) },
          );
        }
        items.push("sep");
      }
      items.push(
        {
          label: "Cut",
          shortcut: "Ctrl+X",
          disabled: !hasSelection,
          action: () => {
            writeClipboard(selectedText());
            view.dispatch({
              ...view.state.replaceSelection(""),
              userEvent: "delete.cut",
            });
            view.focus();
          },
        },
        {
          label: "Copy",
          shortcut: "Ctrl+C",
          disabled: !hasSelection,
          action: () => writeClipboard(selectedText()),
        },
        { label: "Paste", shortcut: "Ctrl+V", action: pasteFromClipboard },
        "sep",
        { label: "Bold", shortcut: "Ctrl+B", action: () => void toggleBold(view) },
        { label: "Italic", shortcut: "Ctrl+I", action: () => void toggleItalic(view) },
        {
          label: "Strikethrough",
          shortcut: "Ctrl+Shift+X",
          action: () => void toggleStrike(view),
        },
        {
          label: "Code",
          shortcut: "Ctrl+Shift+C",
          action: () => void toggleInlineCode(view),
        },
        { label: "Link", shortcut: "Ctrl+K", action: () => void toggleLinkCommand(view) },
        "sep",
        {
          // the page never opens at the caret, so this is the way to the raw
          // Markdown of the thing under it (a link's URL, a table's grid)
          label: sourceRevealActive(view.state) ? "Hide Markdown" : "Show Markdown",
          shortcut: "Ctrl+/",
          action: () => {
            toggleSourceReveal(view);
            view.focus();
          },
        },
        "sep",
        {
          label: "Select all",
          shortcut: "Ctrl+A",
          action: () =>
            view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }),
        },
      );
      setMenu({ x: e.clientX, y: e.clientY, items });
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, [deleteNoteAction, followWikiLink, newNote, openExternalUrl, showNotice]);

  /* ── corner actions: stats, print/PDF export, reveal ── */
  const [printHtml, setPrintHtml] = useState<string | null>(null);
  const printRef = useRef<HTMLDivElement | null>(null);

  const getDocStats = useCallback((): DocStats | null => {
    const view = viewRef.current;
    if (!view) return null;
    /* Counted off the page, not off the file: hidden markup is not words, and
     * code is not prose — a note half made of listings should not claim to be
     * a twelve-minute read (visibleText.ts). */
    const { words, characters, paragraphs } = visibleStats(view);
    // When something is selected, also report the selection's own count — the
    // "counting a paragraph" moment. Vanishes when nothing is selected.
    const selected = view.state.selection.ranges.filter((r) => !r.empty);
    const selectedWords = selected.reduce(
      (sum, r) => sum + visibleWordCount(view, r.from, r.to),
      0,
    );
    return {
      words,
      characters,
      paragraphs,
      minutes: readingMinutes(words),
      selection: selected.length
        ? { words: selectedWords, minutes: readingMinutes(selectedWords) }
        : undefined,
    };
  }, []);

  // Heading outline for quick-open `#` — computed once when the palette opens,
  // not re-split from the whole document on every render.
  const quickOpenHeadings = useMemo(
    () =>
      overlay === "quickopen" ? collectHeadings(viewRef.current?.state.doc.toString() ?? "") : [],
    [overlay],
  );

  const exportPdf = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    // lazy: the print renderer (and its markdown-to-HTML walk) stays out of
    // the startup bundle until the first export
    void import("./shell/printExport")
      .then(({ renderPrintHtml, printTitleValue }) => {
        /* The running head lives in `@page`, whose context inherits from the
         * document element — not from the portaled .print-doc — so the title
         * goes on :root. Written here rather than in the effect below because
         * that would need a static import, and printExport is deliberately
         * kept out of the startup bundle. The effect's cleanup removes it. */
        document.documentElement.style.setProperty(
          "--pd-title",
          printTitleValue(fileRef.current?.name ?? ""),
        );
        setPrintHtml(
          renderPrintHtml(view.state.doc.toString(), resolveImageSrc, writingModes.typography),
        );
      })
      .catch((err) => showNotice(`Couldn't prepare the export. ${errorText(err)}`));
  }, [resolveImageSrc, showNotice, writingModes.typography]);

  /* Once the static print copy is in the DOM and its images decoded, export it.
   * Tier 2 (Windows/Tauri): write the print layout straight to a chosen .pdf via
   * WebView2 PrintToPdf — no print dialog. Off Tauri, or if the native export
   * fails, fall back to the system print dialog ("Save as PDF"). Both paths use
   * the same @media print layout, so the output is identical. */
  useEffect(() => {
    if (!printHtml) return;
    let cancelled = false;
    const done = () => setPrintHtml(null);
    window.addEventListener("afterprint", done);
    const imgs = Array.from(printRef.current?.querySelectorAll("img") ?? []);
    // an image that won't decode just prints as a gap; the export still goes
    void Promise.allSettled(imgs.map((img) => img.decode().catch(() => undefined))).then(
      async () => {
        if (cancelled) return;
        if (isTauri) {
          let outPath: string | null = null;
          try {
            outPath = await pickPdfSavePath(fileRef.current?.name);
          } catch (err) {
            // the export ends here (no path, no fallback print) — otherwise the
            // menu item would look like it simply does nothing
            showNotice(`Couldn't ask where to put the PDF. ${errorText(err)}`);
          }
          if (cancelled) return;
          if (!outPath) {
            setPrintHtml(null); // dialog cancelled — don't fall through to print
            return;
          }
          try {
            await invoke("export_pdf", { path: outPath });
            setPrintHtml(null);
            void import("@tauri-apps/plugin-opener")
              .then(({ revealItemInDir }) => revealItemInDir(outPath!))
              .catch(() => undefined); // the file is written; showing the folder is a courtesy
            return;
          } catch {
            // No notice: the print dialog opens instead, which is visible on
            // its own and produces the same page.
          }
        }
        if (!cancelled) window.print();
      },
    );
    return () => {
      cancelled = true;
      document.documentElement.style.removeProperty("--pd-title");
      window.removeEventListener("afterprint", done);
    };
  }, [printHtml, showNotice]);

  const revealFile = useCallback(() => {
    const f = fileRef.current;
    if (!isTauri || !f) return;
    void import("@tauri-apps/plugin-opener")
      .then(({ revealItemInDir }) => revealItemInDir(f.path))
      .catch((err) => showNotice(`Couldn't open Explorer. ${errorText(err)}`));
  }, [showNotice]);

  /* Aliases of the open note (from its loaded text) drive unlinked-mention
   * matching in the sidebar; edits to the aliases line apply on next open. */
  const activeAliases = useMemo(
    () => (session?.file ? frontmatterAliases(session.doc) : []),
    [session],
  );

  const isWikiResolved = useCallback((inner: string) => {
    const { root, files } = vaultRef.current;
    if (!root || files.length === 0) return true; // no index — don't flag anything
    return resolveWikiTarget(inner, files) != null;
  }, []);

  /* recents as vault-rel paths for quick-open: in this vault, still existing,
   * most-recent-first, minus the note already on screen */
  const recentRels = useMemo(() => {
    if (!vaultRoot) return [];
    const out: string[] = [];
    for (const abs of recents) {
      if (file && samePath(abs, file.path)) continue;
      if (!isUnder(abs, vaultRoot)) continue;
      const rel = vaultFiles.find((f) => samePath(joinPath(vaultRoot, f), abs));
      if (rel) out.push(rel);
    }
    return out;
  }, [recents, vaultRoot, vaultFiles, file]);

  /* quick-open `#heading` → jump inside the open document */
  const jumpToLine = useCallback((line: number) => {
    const view = viewRef.current;
    if (!view) return;
    setOverlay(null);
    const ln = Math.max(1, Math.min(line, view.state.doc.lines));
    const pos = view.state.doc.line(ln).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }, []);

  const createFromQuickOpen = useCallback(
    (name: string) => {
      const { root } = vaultRef.current;
      const rel = safeNoteRelPath(name);
      if (!root || !rel) return;
      void createNote(joinPath(root, rel))
        .then(() => openPath(joinPath(root, rel)))
        .catch((err) => showNotice(`Couldn't create “${rel}”. ${errorText(err)}`));
    },
    [openPath, showNotice],
  );

  /* file from argv (double-clicked .md) + files forwarded by second instances */
  useEffect(() => {
    if (!isTauri) return;
    const offs: (() => void)[] = [];
    let dropped = false;
    const keep = (off: () => void) => {
      if (dropped) off();
      else offs.push(off);
    };
    void initialFile()
      .then((path) => {
        if (dropped) return;
        if (path) {
          void openPath(path);
          return;
        }
        // no argv: resume the previous session; a missing/moved file falls back
        // to welcome inside openPath — silently, never an error dialog
        const last = loadLastSession();
        if (last) {
          pendingRestore.current = last;
          void openPath(last.path, { quiet: true });
        } else {
          setSession(WELCOME_SESSION);
        }
      })
      .catch((err) => {
        // a double-clicked file that never even reached openPath
        showNotice(`Couldn't work out which file to open. ${errorText(err)}`);
        if (!dropped) setSession(WELCOME_SESSION);
      });
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      keep(
        await listen<string>("sandy://open-file", (e) => {
          void openPath(e.payload);
        }),
      );
    });
    void import("@tauri-apps/api/webview").then(async ({ getCurrentWebview }) => {
      keep(
        await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type !== "drop") return;
          const md = event.payload.paths.find((p) => /\.(md|markdown|txt)$/i.test(p));
          if (md) {
            void openPath(md);
            return;
          }
          // Foreign documents (DOCX/XLSX/PDF/…) import through the same path.
          const doc = event.payload.paths.find((p) => isImportable(p));
          if (doc) {
            void openPath(doc);
            return;
          }
          const img = event.payload.paths.find((p) => imageExt(p));
          if (img) void attachDroppedImage(img);
        }),
      );
    });
    return () => {
      dropped = true;
      for (const off of offs) off();
    };
  }, [openPath, attachDroppedImage, showNotice]);

  /**
   * Reload on focus. PROJECT's Out of Scope cuts the file watcher on the trade
   * that this covers the single-writer case — you edited the note in something
   * else, or synced it, and came back. Coming back re-reads the note and the
   * folder listing; nothing else in the app ever notices.
   * Rules: never mid-composition, never over unsaved text, never a transform —
   * the text that arrives is the file's own bytes, swapped through one CM6
   * transaction so the undo history and the caret survive it.
   */
  const reloadOnFocus = useCallback(async () => {
    const root = vaultRef.current.root;
    // shallow: names only, unless the set actually moved while we were away
    if (root) void refreshVault(root, false);
    const f = fileRef.current;
    const view = viewRef.current;
    const queue = saveQueue.current!;
    if (!isTauri || !f || !view) return;
    if (view.composing) return;
    if (queue.status().failure) return; // the banner already owns this file
    if (saveTimer.current || queue.status().dirty) {
      /* Unsaved text is the user's and is never overwritten. Push it to disk
       * now instead: a file that changed underneath meets the disk-authority
       * guard there and raises the conflict banner, which is where choosing
       * between the two versions already lives. */
      void saveNow();
      return;
    }
    const generation = openGeneration.current;
    try {
      const loaded = await loadDoc(f.path);
      // an open (or an edit) started while the read was in flight — its text wins
      if (generation !== openGeneration.current || fileRef.current !== f) return;
      const live = viewRef.current;
      if (!live || live.composing || saveTimer.current || queue.status().dirty) return;
      if (loaded.text === live.state.doc.toString()) return;
      setSession({ file: { ...f, eol: loaded.eol }, doc: loaded.text });
    } catch (err) {
      // Gone, locked or unreadable underneath us. The buffer stays exactly as
      // it is — this says so rather than quietly writing it back over nothing.
      showNotice(`Couldn't re-read “${f.name}”. ${errorText(err)}`);
    }
  }, [refreshVault, saveNow, showNotice]);

  /* Focus *return*, not focus: the launch also arrives as a focus event, and
   * re-walking the vault a second time behind the opening file is exactly the
   * cost this is supposed to avoid. */
  const wasAway = useRef(false);
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let dropped = false;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const un = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused) {
          wasAway.current = true;
        } else if (wasAway.current) {
          wasAway.current = false;
          void reloadOnFocus();
        }
      });
      if (dropped) un();
      else off = un;
    });
    return () => {
      dropped = true;
      off?.();
    };
  }, [reloadOnFocus]);

  /* Alt+←/→ = history back/forward. Capture phase: CM6's defaultKeymap owns
   * Alt-Arrow for syntax motion and would consume the event first; nav history
   * deliberately wins (Obsidian muscle memory). Physical e.code, never e.key
   * (s12: non-Latin layouts). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.shiftKey || e.metaKey || e.isComposing) return;
      if (e.code === "ArrowLeft") {
        e.preventDefault();
        navigateHistory(-1);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        navigateHistory(1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [navigateHistory]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // keys the editor keymap already consumed (e.g. Ctrl+B = bold) stay its
      if (e.defaultPrevented) return;
      if (!e.ctrlKey || e.altKey) return;
      /* match the physical key (e.code), never e.key: on a non-Latin layout
       * Ctrl+F arrives as "а" etc., the shortcut silently misses, and the
       * unprevented keydown lets WebView2 fire its native accelerator
       * (browser find bar over ours) */
      const code = e.code;
      if (e.shiftKey) {
        if (code === "KeyO") {
          e.preventDefault();
          void openFolder();
        } else if (code === "KeyF") {
          e.preventDefault();
          if (vaultRef.current.root) setOverlay("search");
          else void openFolder();
        }
        return;
      }
      if (code === "KeyO") {
        e.preventDefault();
        void openFile();
      } else if (code === "KeyF") {
        // reaches here only when the editor keymap didn't consume it (focus
        // elsewhere, e.g. the sidebar or the find bar itself) — route to the
        // same in-note find bar
        e.preventDefault();
        const view = viewRef.current;
        if (view && !view.composing) openSearchPanel(view);
      } else if (code === "KeyS") {
        e.preventDefault();
        void saveNow();
      } else if (code === "KeyP") {
        e.preventDefault();
        if (vaultRef.current.root) setOverlay("quickopen");
        else void openFolder();
      } else if (code === "KeyN") {
        // always prevented: unhandled, WebView2 answers Ctrl+N with a browser
        // window of its own. Never mid-composition — a new note swaps the
        // editor out from under an IME session that hasn't committed yet.
        e.preventDefault();
        if (!e.isComposing && !viewRef.current?.composing) void newNote();
      } else if (code === "Backslash") {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newNote, openFile, openFolder, saveNow, toggleSidebar]);

  /* Close is allowed only once pending edits reach disk — the 800 ms autosave
   * debounce must never race the window teardown. */
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let dropped = false;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const un = await getCurrentWindow().onCloseRequested((event) => {
        event.preventDefault();
        if (closingRef.current) return;
        closingRef.current = true;
        void saveNow().then((ok) => {
          if (ok) {
            void getCurrentWindow().destroy();
          } else {
            closingRef.current = false;
            setCloseBlocked(true);
          }
        });
      });
      if (dropped) un();
      else off = un;
    });
    return () => {
      dropped = true;
      off?.();
    };
  }, [saveNow]);

  useEffect(() => {
    const title = file ? `${file.name} — Sandy` : "Sandy";
    const shown = saveStatus.failure ? `⚠ ${title}` : title;
    document.title = shown;
    if (isTauri) {
      void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
        getCurrentWindow().setTitle(shown),
      );
    }
  }, [file, saveStatus.failure]);

  return (
    <div className="app-shell">
      <Titlebar
        title={file?.name ?? null}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={toggleSidebar}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      {saveStatus.failure ? (
        <div className="save-banner" role="alert" title={saveStatus.failure.message}>
          {saveStatus.failure.conflict ? (
            <>
              <span className="save-banner-text">
                “{basename(saveStatus.failure.path)}” changed on disk since you opened it.
                Your edits are still here — choose which version to keep.
              </span>
              <button
                type="button"
                className="save-banner-btn"
                onClick={() => {
                  const path = saveStatus.failure!.path;
                  saveQueue.current!.discard(path);
                  // the banner goes away with the failure — hand the keyboard
                  // back to the text, since the editor no longer remounts here
                  void openPath(path, { reload: true }).then(() => viewRef.current?.focus());
                }}
              >
                Use the file on disk
              </button>
              <button
                type="button"
                className="save-banner-btn save-banner-danger"
                onClick={() => void saveQueue.current!.overwrite()}
              >
                Keep what I wrote
              </button>
            </>
          ) : (
            <>
              <span className="save-banner-text">
                Couldn't save “{basename(saveStatus.failure.path)}” — your edits are kept in
                memory and retried{closeBlocked ? "; closing is paused" : ""}.
              </span>
              <button type="button" className="save-banner-btn" onClick={() => void saveNow()}>
                Retry now
              </button>
            </>
          )}
          {closeBlocked ? (
            <button
              type="button"
              className="save-banner-btn save-banner-danger"
              onClick={() => {
                void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
                  getCurrentWindow().destroy(),
                );
              }}
            >
              Close without saving
            </button>
          ) : null}
        </div>
      ) : notice ? (
        /* Same strip, same classes: one place says the thing that went wrong,
         * and it steps aside for a save failure, which is the louder of the two
         * and does not clear itself. */
        <div className="save-banner" role="alert">
          <span className="save-banner-text">{notice}</span>
        </div>
      ) : null}
      {/* Always mounted: the panel slides out on the toggle instead of being
        * unmounted, so it leaves the way it arrives. Closed, it is `inert` —
        * out of the tab order and out of the accessibility tree. */}
      <Sidebar
        open={sidebarOpen}
        root={vaultRoot}
        files={vaultFiles}
        activePath={file?.path ?? null}
        activeAliases={activeAliases}
        vaults={vaults}
        renameTarget={renameTarget}
        onOpenRel={openRel}
        onOpenFolder={() => void openFolder()}
        onSwitchVault={switchVault}
        onRemoveVault={removeVault}
        onRenameRequest={setRenameTarget}
        onRenameSubmit={(rel, newName) => void renameNoteAction(rel, newName)}
        onRenameCancel={() => setRenameTarget(null)}
        onDeleteRel={(rel) => void deleteNoteAction(rel)}
      />
      <main className={`document-shell${opening ? " is-opening" : ""}`} aria-busy={opening}>
        {session ? (
          <Editor
            key={file?.path ?? "welcome"}
            docKey={file?.path ?? "welcome"}
            initialDoc={session.doc}
            writingModes={writingModes}
            onReady={(view, restored) => {
              viewRef.current = view;
              if (!view) return;
              const seek = pendingSeek.current;
              if (seek && file && samePath(seek.path, file.path)) {
                pendingSeek.current = null;
                const ln = Math.max(1, Math.min(seek.line, view.state.doc.lines));
                const pos = view.state.doc.line(ln).from;
                view.dispatch({
                  selection: { anchor: pos },
                  effects: EditorView.scrollIntoView(pos, { y: "center" }),
                });
              }
              const restore = pendingRestore.current;
              if (restore && file && samePath(restore.path, file.path)) {
                pendingRestore.current = null;
                /* `restored` means the view came back from memory with its own
                 * selection and scroll already replayed — an exact answer, so
                 * the remembered one stands aside rather than overwriting it. */
                if (!restored) {
                  const doc = view.state.doc;
                  const line = doc.line(Math.max(1, Math.min(restore.line, doc.lines)));
                  const pos = line.from + Math.max(0, Math.min(restore.col, line.length));
                  const anchor = doc.line(Math.max(1, Math.min(restore.anchorLine, doc.lines)));
                  /* One dispatch, and it lands before the first paint: this ran
                   * inside two nested rAFs writing `scrollDOM.scrollTop`, which
                   * is a painted frame at the top and then a visible jump. A
                   * scroll effect does its own measuring, so there is nothing
                   * left for us to wait for. */
                  view.dispatch({
                    selection: { anchor: pos },
                    effects: EditorView.scrollIntoView(anchor.from, {
                      y: "start",
                      yMargin: restore.offset,
                    }),
                  });
                }
              }
              if (opening) {
                setOpening(false);
                void revealWindow();
              }
              // remember this file even if the app dies without a close event
              requestAnimationFrame(() => requestAnimationFrame(recordSession));
            }}
            onDocChanged={scheduleSave}
            onFollowWikiLink={(inner) => void followWikiLink(inner)}
            isWikiResolved={isWikiResolved}
            onOpenUrl={openExternalUrl}
            onAttachImage={attachImage}
            resolveImageSrc={resolveImageSrc}
          />
        ) : null}
      </main>
      {session ? (
        <CornerActions
          saveStatus={saveStatus}
          filePath={file?.path ?? null}
          onSave={() => void saveNow()}
          onExportPdf={exportPdf}
          onRevealFile={isTauri && file ? revealFile : null}
          getStats={getDocStats}
          writingModes={writingModes}
          onToggleWritingMode={toggleWritingMode}
        />
      ) : null}
      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      ) : null}
      {printHtml
        ? /* portaled to <body>: print CSS hides every other body child, so the
           * paper copy must live outside the app tree (print.css contract) */
          createPortal(
            <div
              ref={printRef}
              className="print-doc"
              // static render of the open document, produced by printExport.ts
              dangerouslySetInnerHTML={{ __html: printHtml }}
            />,
            document.body,
          )
        : null}
      {overlay === "quickopen" && vaultRoot ? (
        <QuickOpen
          files={vaultFiles}
          aliases={aliasIndex}
          recents={recentRels}
          headings={quickOpenHeadings}
          onPick={openRel}
          onPickHeading={jumpToLine}
          onCreate={createFromQuickOpen}
          onClose={() => {
            // hand the keyboard straight back to the text — no dead click needed
            setOverlay(null);
            viewRef.current?.focus();
          }}
        />
      ) : null}
      {overlay === "search" && vaultRoot ? (
        <SearchPanel
          root={vaultRoot}
          onPick={(rel, line) => openRel(rel, line)}
          onClose={() => {
            // hand the keyboard straight back to the text — no dead click needed
            setOverlay(null);
            viewRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
