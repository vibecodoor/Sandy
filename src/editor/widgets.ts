import { EditorView, WidgetType } from "@codemirror/view";

/* Mount animations (task-fill, image-develop, hr-draw) must fire only at the
 * moment the user causes them. CM6 rebuilds off-viewport widget DOM on scroll,
 * so an unconditional CSS animation replays every time a widget scrolls back
 * into view. livePreview stamps the moment of a real edit (or a Ctrl+/ reveal
 * closing); a widget mounted shortly after wears .md-anim, one mounted by
 * scrolling does not. */
let editMoment = 0;
export function markEditMoment(): void {
  editMoment = Date.now();
}
const animClass = () => (Date.now() - editMoment < 400 ? " md-anim" : "");

/* The other half of the same problem: CM6 also rebuilds off-viewport widget
 * DOM, so a bare <img> re-enters the page at zero height and every line under
 * it snaps down again when the file decodes — once per scroll-back, forever.
 * Remember each picture's natural size and hand it back as width/height
 * attributes; the browser then reserves the right box before a byte is
 * fetched, and `height: auto` scales it to the measure. Only the first sight
 * of an image still settles — there is nothing to remember yet. */
const naturalSize = new Map<string, { w: number; h: number }>();

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }
  override eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "md-image" + animClass();
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.draggable = false;
    const known = naturalSize.get(this.src);
    if (known) {
      img.width = known.w;
      img.height = known.h;
    } else {
      img.addEventListener(
        "load",
        () => {
          if (img.naturalWidth && img.naturalHeight) {
            naturalSize.set(this.src, { w: img.naturalWidth, h: img.naturalHeight });
          }
        },
        { once: true },
      );
    }
    wrap.appendChild(img);
    return wrap;
  }
  override ignoreEvent() {
    return false;
  }
}

/* Replaces a "[ ]" / "[x]" task marker; click toggles the underlying text. */
export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "md-task" + (this.checked ? " md-task-checked" + animClass() : "");
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const marker = view.state.sliceDoc(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(marker)) return;
      const checked = marker !== "[ ]";
      view.dispatch({
        changes: { from: pos, to: pos + 3, insert: checked ? "[ ]" : "[x]" },
      });
    });
    return box;
  }
  override ignoreEvent(e: Event) {
    return e.type === "mousedown";
  }
}

/* Replaces a frontmatter `true` / `false` literal; click flips the one token
 * (the same byte discipline as a task checkbox). Reuses the task styling. */
export class BoolWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: BoolWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "md-task" + (this.checked ? " md-task-checked" + animClass() : "");
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(box);
      const word = view.state.sliceDoc(pos, pos + 5);
      if (word.startsWith("true")) {
        view.dispatch({ changes: { from: pos, to: pos + 4, insert: "false" } });
      } else if (word === "false") {
        view.dispatch({ changes: { from: pos, to: pos + 5, insert: "true" } });
      }
    });
    return box;
  }
  override ignoreEvent(e: Event) {
    return e.type === "mousedown";
  }
}

/* Replaces a title-less callout marker ("> [!note]") with the type name. */
export class CalloutLabelWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  override eq(other: CalloutLabelWidget) {
    return other.label === this.label;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-callout-label";
    el.textContent = this.label;
    return el;
  }
  override ignoreEvent() {
    return false;
  }
}

export class HRWidget extends WidgetType {
  override eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "md-hr" + animClass();
    return el;
  }
  override ignoreEvent() {
    return false;
  }
}
