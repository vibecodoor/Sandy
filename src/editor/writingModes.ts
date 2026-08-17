import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { frozenDuringComposition, imeBusy } from "./imeGuard";

/*
 * Writing modes — the switches on the corner panel. All three are scroll- or
 * decoration-only, so the document bytes never change under any of them:
 *   - Typewriter:  the caret line stays vertically centred as you type/navigate
 *                  (MarkText's Ctrl+Shift+G, distilled). Default OFF.
 *   - Focus:       every paragraph except the caret's recedes. Default OFF.
 *   - Typography:  “ ” « » — … rendered over plain ASCII source (Typora's
 *                  "convert on rendering"; see typography.ts). Default ON —
 *                  it costs the file nothing, so it is part of the default
 *                  beautiful page rather than something to go turn on.
 * The two focus aids default off so the calm page is never imposed uninvited.
 * State is a single StateField seeded at editor creation and flipped by an
 * effect dispatched from the corner-actions toggles (the app's quiet action
 * surface). Nothing here runs during IME composition — hard constraint.
 */

export interface WritingModes {
  typewriter: boolean;
  focus: boolean;
  typography: boolean;
}

export const DEFAULT_WRITING_MODES: WritingModes = {
  typewriter: false,
  focus: false,
  typography: true,
};

/** Replace the active writing-mode set (dispatched from the corner toggles). */
export const applyWritingModes = StateEffect.define<WritingModes>();

export const writingModesField = StateField.define<WritingModes>({
  create: () => DEFAULT_WRITING_MODES,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(applyWritingModes)) return e.value;
    return value;
  },
});

/** Did this update just flip a mode on/off? (so the aids react to the toggle). */
function modesToggled(update: ViewUpdate): boolean {
  return update.transactions.some((t) => t.effects.some((e) => e.is(applyWritingModes)));
}

/* Typewriter: keep the caret line centred. The scroll is deferred to an
 * animation frame so we never dispatch from inside an update, and skipped
 * during composition so it can never fight the input method. */
const typewriterScroll = ViewPlugin.fromClass(
  class {
    frame = 0;
    constructor(readonly view: EditorView) {}
    update(update: ViewUpdate) {
      const modes = update.state.field(writingModesField, false);
      if (!modes?.typewriter) return;
      if (!(update.docChanged || update.selectionSet || modesToggled(update))) return;
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => {
        if (!this.view.dom.isConnected || imeBusy(this.view)) return;
        const head = this.view.state.selection.main.head;
        this.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) });
      });
    }
    destroy() {
      cancelAnimationFrame(this.frame);
    }
  },
);

const dimLine = Decoration.line({ class: "cm-focus-dim" });

/* Focus: dim every visible line outside the caret's paragraph (a paragraph =
 * the run of non-blank lines around the caret). Line-class only — no text is
 * hidden or moved — and the set is frozen during composition so the IME range
 * is never disturbed. */
const focusDim = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(update: ViewUpdate) {
      /* Decorations ask the decoration-side guard, not `view.composing`: this
       * rebuild is a DOM rebuild like any other, and the set is carried across
       * the freeze mapped, not stale. */
      const frozen = frozenDuringComposition(update, this.decorations);
      if (frozen) {
        this.decorations = frozen;
        return;
      }
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        modesToggled(update)
      ) {
        this.decorations = this.build(update.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const modes = view.state.field(writingModesField, false);
      if (!modes?.focus) return Decoration.none;
      const { doc, selection } = view.state;
      const head = doc.lineAt(selection.main.head).number;
      let start = head;
      let end = head;
      while (start > 1 && doc.line(start - 1).text.trim() !== "") start--;
      while (end < doc.lines && doc.line(end + 1).text.trim() !== "") end++;
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = doc.lineAt(pos);
          if (line.number < start || line.number > end) {
            builder.add(line.from, line.from, dimLine);
          }
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

/** Editor extension: seed the writing-mode field and wire both aids. */
export function writingModes(initial: WritingModes = DEFAULT_WRITING_MODES) {
  return [writingModesField.init(() => initial), typewriterScroll, focusDim];
}
