import { useEffect, useRef } from "react";
import { Annotation, EditorState, type Extension, type StateEffect } from "@codemirror/state";
import { historyField } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { editorExtensions } from "./extensions";
import { DEFAULT_WRITING_MODES, type WritingModes } from "./writingModes";
import "./editor.css";

/** This transaction carries the file's own bytes back in — not an edit to save. */
const fromDisk = Annotation.define<boolean>();

/*
 * What a note leaves behind when you go and look at another one.
 *
 * The view is built once per *path* (App keys this component by it), so every
 * note switch is a `destroy()` — and `history()` is a state field, so it died
 * with it: cut a paragraph in A, jump to B to check something, come back, and
 * Ctrl+Z did nothing. The text was in git, but nothing in the app can show you
 * git. The hazard was already written down one function up, for the same-path
 * re-read case, and simply unguarded for the switch.
 *
 * Kept as serialized state rather than the `EditorState` object, because that
 * object carries the old mount's extension instances; the JSON round trip
 * rebuilds them against the new ones. In memory only — this is not a file
 * format, and a lost history after a restart is the same as today.
 */
interface NoteMemory {
  /** `EditorState.toJSON`, with the history field named for `fromJSON`. */
  state: unknown;
  /** The text we left with. A stale history must never map onto a changed doc. */
  doc: string;
  /** Where the page was, replayable before the first paint. */
  scroll: StateEffect<unknown>;
}

const memory = new Map<string, NoteMemory>();
/** Notes remembered at once. Insertion-ordered, so the oldest falls off. */
const MEMORY_MAX = 10;
/** Past this, ten remembered notes is real memory; the undo stack is not worth it. */
const MEMORY_MAX_DOC = 2_000_000;
/** Total budget across entries. An entry retains ≈2× its doc — the JSON
 * state's copy and `doc` are independent strings — and V8 widens a whole
 * string to 2 B/char the moment one non-Latin-1 character appears, so ten
 * notes at the per-note cap could hold ≈80 MB. `doc.length * 2` tracks the
 * real retention to ~2 % (s51 #40). */
const MEMORY_MAX_BYTES = 8_000_000;

function remember(key: string, view: EditorView): void {
  const doc = view.state.doc.toString();
  memory.delete(key); // re-insert at the end = most-recently-left order
  if (doc.length > MEMORY_MAX_DOC) return;
  memory.set(key, {
    state: view.state.toJSON({ history: historyField }),
    doc,
    scroll: view.scrollSnapshot(),
  });
  let bytes = 0;
  for (const kept of memory.values()) bytes += kept.doc.length * 2;
  // oldest first; the just-inserted entry is last and alone fits the budget
  for (const stale of memory.keys()) {
    if (memory.size <= MEMORY_MAX && bytes <= MEMORY_MAX_BYTES) break;
    bytes -= memory.get(stale)!.doc.length * 2;
    memory.delete(stale);
  }
}

/** Drop every remembered note. A vault switch strands entries — their keys
 * are absolute paths in the old vault, unreachable and still resident; the
 * byte budget bounds the strand but only this removes it (s51 #40). */
export function forgetNoteMemory(): void {
  memory.clear();
}

/**
 * The remembered state for this note, or nothing. Consumed either way: a note
 * we are opening is one we are no longer away from, and an entry that no longer
 * matches the file on disk is the branch where dropping is always safe.
 */
function recall(key: string, doc: string): NoteMemory | undefined {
  const found = memory.get(key);
  memory.delete(key);
  return found && found.doc === doc ? found : undefined;
}

/**
 * Swap the document in place. A same-path re-read (the disk-conflict banner's
 * "use the file on disk", the focus-return reload) used to recreate the whole
 * EditorView, which threw the undo history and the scroll position away with
 * it. Only the differing middle is replaced, so the caret maps through the
 * change the way it would through any other edit.
 */
function replaceDoc(view: EditorView, next: string): void {
  const cur = view.state.doc.toString();
  if (cur === next) return;
  const max = Math.min(cur.length, next.length);
  let from = 0;
  while (from < max && cur.charCodeAt(from) === next.charCodeAt(from)) from++;
  let tail = 0;
  while (
    tail < max - from &&
    cur.charCodeAt(cur.length - 1 - tail) === next.charCodeAt(next.length - 1 - tail)
  ) {
    tail++;
  }
  // neither boundary may land inside a surrogate pair
  const low = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  if (from > 0 && low(cur.charCodeAt(from))) from--;
  if (low(cur.charCodeAt(cur.length - tail))) tail--;
  view.dispatch({
    changes: { from, to: cur.length - tail, insert: next.slice(from, next.length - tail) },
    annotations: fromDisk.of(true),
  });
}

interface EditorProps {
  initialDoc: string;
  /** Identity of the note this view is for — the same string App keys us by. */
  docKey: string;
  /** Seeds the writing-mode field for this editor; live toggles come via viewRef. */
  writingModes?: WritingModes;
  /**
   * `restored` says this note came back with its own undo history, selection and
   * scroll position — so the host's own reading-position restore should stand
   * aside rather than overwrite an exact answer with a remembered one.
   */
  onReady?: (view: EditorView | null, restored?: boolean) => void;
  onDocChanged?: () => void;
  onFollowWikiLink?: (inner: string) => void;
  isWikiResolved?: (inner: string) => boolean;
  onOpenUrl?: (url: string) => void;
  onAttachImage?: (data: ArrayBuffer, ext: string) => Promise<string | null>;
  resolveImageSrc?: (src: string) => string;
}

export function Editor({
  initialDoc,
  docKey,
  writingModes,
  onReady,
  onDocChanged,
  onFollowWikiLink,
  isWikiResolved,
  onOpenUrl,
  onAttachImage,
  resolveImageSrc,
}: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  /** The text this view was last handed, so a re-render can tell a real swap. */
  const appliedDoc = useRef(initialDoc);
  const callbacks = useRef({
    writingModes,
    onReady,
    onDocChanged,
    onFollowWikiLink,
    isWikiResolved,
    onOpenUrl,
    onAttachImage,
    resolveImageSrc,
  });
  callbacks.current = {
    writingModes,
    onReady,
    onDocChanged,
    onFollowWikiLink,
    isWikiResolved,
    onOpenUrl,
    onAttachImage,
    resolveImageSrc,
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const extensions: Extension = [
      editorExtensions(
        {
          onFollow: (inner) => callbacks.current.onFollowWikiLink?.(inner),
          isResolved: (inner) => callbacks.current.isWikiResolved?.(inner) ?? true,
          onOpenUrl: (url) => callbacks.current.onOpenUrl?.(url),
          onAttachImage: (data, ext) =>
            callbacks.current.onAttachImage?.(data, ext) ?? Promise.resolve(null),
          resolveImageSrc: (src) => callbacks.current.resolveImageSrc?.(src) ?? src,
        },
        callbacks.current.writingModes ?? DEFAULT_WRITING_MODES,
      ),
      EditorView.updateListener.of((update) => {
        // a doc arriving from disk already matches the file — saving it
        // back would only mean a no-op write and a wasted history commit
        if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromDisk))) {
          callbacks.current.onDocChanged?.();
        }
      }),
    ];
    /* A note we have been away from comes back whole — its undo stack, its
     * selection and, through `scrollTo`, the place it was open at. `scrollTo`
     * is the point: s39 restored by writing `scrollDOM.scrollTop` inside two
     * nested rAFs, i.e. after at least one painted frame at the top, which is
     * the jump you could see. This lands before the first paint. */
    const recalled = recall(docKey, initialDoc);
    const view = new EditorView({
      state: recalled
        ? EditorState.fromJSON(recalled.state, { extensions }, { history: historyField })
        : EditorState.create({ doc: initialDoc, extensions }),
      parent: host,
      scrollTo: recalled?.scroll,
    });
    viewRef.current = view;
    appliedDoc.current = initialDoc;
    callbacks.current.onReady?.(view, !!recalled);
    if (import.meta.env.DEV) {
      (window as unknown as { __sandyView?: EditorView }).__sandyView = view;
    }
    view.focus();
    return () => {
      viewRef.current = null;
      callbacks.current.onReady?.(null);
      remember(docKey, view);
      view.destroy();
    };
    // Creation only. A different file remounts (App keys this by path); a new
    // `initialDoc` for the *same* file is a re-read and swaps in below, because
    // rebuilding the view here would destroy the undo history with it.
  }, []);

  useEffect(() => {
    if (appliedDoc.current === initialDoc) return;
    appliedDoc.current = initialDoc;
    const view = viewRef.current;
    if (!view) return;
    replaceDoc(view, initialDoc);
    // the same view now shows a different document: the host re-runs the
    // seek/restore/uncover work it does for a freshly mounted one
    callbacks.current.onReady?.(view);
  }, [initialDoc]);

  return <div className="editor-host" ref={hostRef} />;
}
