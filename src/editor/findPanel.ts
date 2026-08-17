import { EditorView, type KeyBinding, type Panel, type ViewUpdate } from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  search,
  searchPanelOpen,
  selectNextOccurrence,
  setSearchQuery,
} from "@codemirror/search";
import { imeBusy } from "./imeGuard";
import { isHidden } from "./visibleText";

/* In-note find (Ctrl+F): a small floating bar styled like the app's overlays.
 * Typing never moves the caret, so an active IME composition is never disturbed
 * by the panel itself; stepping happens with Enter/Shift+Enter. A replace row
 * (Ctrl+H, or the chevron) folds out of the same bar — in-file only, and every
 * replace command is IME-gated. Match highlighting is mark decorations from
 * @codemirror/search. */

const COUNT_CAP = 999;

const icon = (path: string) =>
  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" ` +
  `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

const ICON_PREV = icon('<path d="M4 10l4-4 4 4"/>');
const ICON_NEXT = icon('<path d="M4 6l4 4 4-4"/>');
const ICON_CLOSE = icon('<path d="M4 4l8 8M12 4l-8 8"/>');
const ICON_REPLACE = icon('<path d="M6 2l3 3-3 3"/><path d="M9 5H4a2 2 0 0 0-2 2v1"/><path d="M10 14l-3-3 3-3"/><path d="M7 11h5a2 2 0 0 0 2-2V8"/>');

/* Ctrl+H needs to reach the live panel instance to fold out its replace row. */
const panels = new WeakMap<EditorView, FindPanel>();

class FindPanel implements Panel {
  dom: HTMLElement;
  private input: HTMLInputElement;
  private replaceInput: HTMLInputElement;
  private replaceRow: HTMLElement;
  private count: HTMLElement;
  private query: SearchQuery;

  /* Find answers for the page, not for the file: a hit inside a hidden URL, a
   * %%comment%% or an emphasis mark is not a hit anyone can see — the counter
   * used to promise matches it then scrolled to nothing, and stepping onto one
   * parked the caret inside an atomic range. One identity per panel, because
   * `SearchQuery.eq` compares this by reference and a fresh closure per
   * keystroke would make every query look changed. */
  private readonly test = (_match: string, state: EditorState, from: number, to: number) =>
    !isHidden(this.view, state, from, to);

  constructor(private view: EditorView) {
    panels.set(view, this);
    this.query = getSearchQuery(view.state);

    this.dom = document.createElement("div");
    this.dom.className = "find-bar";

    this.input = document.createElement("input");
    this.input.className = "find-input";
    this.input.placeholder = "Find in note…";
    this.input.value = this.query.search;
    this.input.spellcheck = false;
    this.input.setAttribute("main-field", "true");
    this.input.addEventListener("input", () => this.commit());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        (e.shiftKey ? findPrevious : findNext)(this.view);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeSearchPanel(this.view);
        this.view.focus(); // straight back to the text, no dead click
      }
    });

    this.count = document.createElement("span");
    this.count.className = "find-count";

    const button = (html: string, title: string, action: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "find-btn";
      b.title = title;
      b.innerHTML = html;
      // mousedown, so the input never loses focus while stepping
      b.addEventListener("mousedown", (e) => {
        e.preventDefault();
        action();
      });
      return b;
    };

    const textButton = (label: string, title: string, action: () => void) => {
      const b = button("", title, action);
      b.classList.add("find-btn-text");
      b.textContent = label;
      return b;
    };

    const findRow = document.createElement("div");
    findRow.className = "find-row";
    findRow.append(
      this.input,
      this.count,
      button(ICON_PREV, "Previous match (Shift+Enter)", () => findPrevious(this.view)),
      button(ICON_NEXT, "Next match (Enter)", () => findNext(this.view)),
      button(ICON_CLOSE, "Close (Esc)", () => {
        closeSearchPanel(this.view);
        this.view.focus();
      }),
    );

    this.replaceInput = document.createElement("input");
    this.replaceInput.className = "find-input";
    this.replaceInput.placeholder = "Replace with…";
    this.replaceInput.spellcheck = false;
    this.replaceInput.addEventListener("input", () => this.commit());
    this.replaceInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.replace(replaceNext);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeSearchPanel(this.view);
        this.view.focus(); // straight back to the text, no dead click
      }
    });

    this.replaceRow = document.createElement("div");
    this.replaceRow.className = "find-row find-replace-row";
    this.replaceRow.hidden = true;
    this.replaceRow.append(
      this.replaceInput,
      textButton("Replace", "Replace this match (Enter)", () => this.replace(replaceNext)),
      textButton("All", "Replace every match", () => this.replace(replaceAll)),
    );

    const rows = document.createElement("div");
    rows.className = "find-rows";
    rows.append(findRow, this.replaceRow);

    this.dom.append(
      button(ICON_REPLACE, "Replace… (Ctrl+H)", () => this.toggleReplace()),
      rows,
    );
    this.refreshCount(view.state);
  }

  mount() {
    this.input.focus();
    this.input.select();
  }

  destroy() {
    if (panels.get(this.view) === this) panels.delete(this.view);
  }

  /* Replace edits the document — hard IME gate, same as every editing command. */
  private replace(command: (view: EditorView) => boolean) {
    if (imeBusy(this.view)) return;
    this.commit();
    command(this.view);
  }

  private toggleReplace() {
    this.replaceRow.hidden = !this.replaceRow.hidden;
    this.dom.classList.toggle("has-replace", !this.replaceRow.hidden);
    if (!this.replaceRow.hidden) this.replaceInput.focus();
    else this.input.focus();
  }

  /** Ctrl+H: fold the replace row out; land in the most useful field. */
  revealReplace() {
    if (this.replaceRow.hidden) {
      this.replaceRow.hidden = false;
      this.dom.classList.add("has-replace");
    }
    if (this.input.value) this.replaceInput.focus();
    else this.input.focus();
  }

  update(update: ViewUpdate) {
    const query = getSearchQuery(update.state);
    const changed = !query.eq(this.query);
    if (changed) {
      this.query = query;
      if (this.input.value !== query.search) this.input.value = query.search;
      if (this.replaceInput.value !== query.replace) this.replaceInput.value = query.replace;
    }
    if (changed || update.docChanged || update.selectionSet) this.refreshCount(update.state);
  }

  /* Typing updates the query and brings the first match into view — scroll
   * only, never a selection change, so the caret (and any live IME composition)
   * is untouched. Without this, find feels like a form you have to submit. */
  private commit() {
    const query = new SearchQuery({
      search: this.input.value,
      replace: this.replaceInput.value,
      literal: true,
      test: this.test,
    });
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    if (!query.search || imeBusy(this.view)) return;
    const { state } = this.view;
    const caret = state.selection.main.from;
    let hit = query.getCursor(state, caret).next();
    if (hit.done) hit = query.getCursor(state, 0, caret).next(); // wrap to the top
    if (hit.done) return;
    this.view.dispatch({
      effects: EditorView.scrollIntoView(hit.value.from, { y: "center" }),
    });
  }

  /** "current / total" relative to the caret; capped so huge notes stay cheap. */
  private refreshCount(state: EditorState) {
    if (!this.query.search) {
      this.count.textContent = "";
      return;
    }
    const caret = state.selection.main.from;
    const cursor = this.query.getCursor(state);
    let total = 0;
    let current = 0;
    for (let step = cursor.next(); !step.done && total < COUNT_CAP; step = cursor.next()) {
      total++;
      if (step.value.from <= caret) current = total;
    }
    this.count.textContent =
      total === 0
        ? "No matches"
        : `${current || 1} / ${total}${total === COUNT_CAP ? "+" : ""}`;
  }
}

/* IME hard constraint: no selection/focus change
 * may be dispatched while a composition is active. */
const imeSafe =
  (command: (view: EditorView) => boolean) =>
  (view: EditorView): boolean =>
    imeBusy(view) ? false : command(view);

/** Ctrl+H: the find bar with its replace row already folded out. */
const openReplacePanel = (view: EditorView): boolean => {
  openSearchPanel(view);
  panels.get(view)?.revealReplace();
  return true;
};

export const findKeymap: KeyBinding[] = [
  { key: "Mod-f", run: imeSafe(openSearchPanel), preventDefault: true },
  { key: "Mod-h", run: imeSafe(openReplacePanel), preventDefault: true },
  // select-next-occurrence (add a cursor at the next copy of the selection)
  { key: "Mod-d", run: imeSafe(selectNextOccurrence), preventDefault: true },
  { key: "F3", run: imeSafe(findNext), shift: imeSafe(findPrevious), preventDefault: true },
  { key: "Mod-g", run: imeSafe(findNext), shift: imeSafe(findPrevious), preventDefault: true },
  {
    key: "Escape",
    run: (view) => (searchPanelOpen(view.state) ? closeSearchPanel(view) : false),
  },
];

export const findBar = search({
  top: true,
  caseSensitive: false,
  literal: true,
  createPanel: (view) => new FindPanel(view),
});
