import { StateEffect, type Extension, type Transaction } from "@codemirror/state";
import { EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";

/*
 * IME composition guard (ported from SoloMD's cm-ime-guard.ts, MIT).
 *
 * Hard constraint: structural decorations must
 * never intersect an active IME composition range. While the user is
 * mid-composition — e.g. pinyin with MS-Pinyin/Sogou, or Japanese/Korean —
 * rebuilding a decoration set on the composing line tears down and re-creates
 * that line's DOM. WebView2 reacts to the mid-composition DOM swap by silently
 * dropping the active composition (the "吃字" / lost-character symptom).
 *
 * The fix: while composing, don't rebuild decorations at all — only map the
 * existing set through the update's doc changes so its positions stay valid.
 * CodeMirror fires a normal `docChanged` update at compositionend, so the set
 * rebuilds correctly one tick later; the frozen frame is never visible because
 * it only lasts while the candidate window is open. Freezing doc-wide (not just
 * the composition range) satisfies the invariant by construction — nothing
 * changes anywhere during composition, so nothing can intersect it.
 */

let imeComposing = false;
let imeFreezeActive = false;
let imeIdleTimer: ReturnType<typeof setTimeout> | null = null;
const isWindowsImeHost =
  typeof navigator !== "undefined" && /Win/i.test(navigator.platform);

/** Dispatched when the Windows lingering-freeze lifts, forcing a stale rebuild. */
export const imeSafeFlushEffect = StateEffect.define<void>();

/**
 * Detect an active composition. `view.composing` is CodeMirror's own signal but
 * it can flip a tick late on the first keystroke, leaving a narrow window where
 * a rebuild sneaks through; the DOM-event flags below close it.
 */
export function isImeComposing(update: ViewUpdate): boolean {
  return update.view.composing || imeComposing || imeFreezeActive;
}

export function isImeSafeFlushTransaction(tr: Transaction): boolean {
  return tr.effects.some((effect) => effect.is(imeSafeFlushEffect));
}

/**
 * The command-side twin of the check above: may this keystroke dispatch at all?
 * One predicate for every input path, so a new command can't quietly ship with
 * a weaker guard than its neighbours.
 *
 * `view.composing` alone flips a tick late on the first keystroke of a
 * composition; `imeComposing` closes that window from the DOM events. It
 * deliberately leaves out the Windows lingering freeze (`imeFreezeActive`) —
 * that flag is also armed for 180 ms after *every* ordinary keypress, so a
 * command reading it would be dead while you type. The residual it leaves —
 * a commit that lands after `compositionend`, 180–240 ms late — is a named
 * Family-A case for the manual IME matrix, not something JS can decide from here.
 */
export function imeBusy(view: EditorView): boolean {
  return view.composing || imeComposing;
}

/**
 * Return the current decoration set mapped through the update's changes when a
 * composition is active (so the caller freezes instead of rebuilding), or null
 * when the caller should rebuild normally.
 */
export function frozenDuringComposition(
  update: ViewUpdate,
  current: DecorationSet,
): DecorationSet | null {
  if (!isImeComposing(update)) return null;
  return current.map(update.changes);
}

/* On Windows the composition can commit a beat after the last event; hold the
 * freeze 180–240 ms past it, then dispatch imeSafeFlushEffect so decorations
 * that went stale (e.g. an un-hidden `**bold**` marker from a fast committer)
 * rebuild once it is safe. */
function holdImeFreeze(view: EditorView, composing: boolean) {
  imeComposing = composing;
  if (!isWindowsImeHost) return;
  imeFreezeActive = true;
  if (imeIdleTimer) clearTimeout(imeIdleTimer);
  imeIdleTimer = setTimeout(
    () => {
      imeIdleTimer = null;
      if (imeComposing) return;
      imeFreezeActive = false;
      view.dispatch({ effects: imeSafeFlushEffect.of() });
    },
    composing ? 240 : 180,
  );
}

/**
 * Track native composition events so the module flags stay accurate even when
 * CodeMirror's `view.composing` lags. Also inspects `beforeinput.inputType` to
 * catch IME activity WebView2 reports without a matching composition event.
 */
export function imeCompositionGuard(): Extension {
  return EditorView.domEventHandlers({
    compositionstart(_event, view) {
      holdImeFreeze(view, true);
      return false;
    },
    beforeinput(event: InputEvent, view) {
      if (
        event.isComposing ||
        event.inputType === "insertCompositionText" ||
        event.inputType === "deleteCompositionText"
      ) {
        holdImeFreeze(view, true);
      } else if (
        event.inputType === "insertText" ||
        event.inputType === "deleteContentBackward" ||
        event.inputType === "deleteContentForward"
      ) {
        holdImeFreeze(view, false);
      }
      return false;
    },
    compositionend(_event, view) {
      imeComposing = false;
      holdImeFreeze(view, false);
      return false;
    },
    compositioncancel(_event, view) {
      imeComposing = false;
      holdImeFreeze(view, false);
      return false;
    },
  });
}
