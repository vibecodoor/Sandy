import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/* Maps syntax to CSS classes; all visual styling lives in editor.css. */
export const sandyHighlightStyle = HighlightStyle.define([
  { tag: t.heading1, class: "md-h1" },
  { tag: t.heading2, class: "md-h2" },
  { tag: t.heading3, class: "md-h3" },
  { tag: t.heading4, class: "md-h4" },
  { tag: t.heading5, class: "md-h5" },
  { tag: t.heading6, class: "md-h6" },
  { tag: t.strong, class: "md-strong" },
  { tag: t.emphasis, class: "md-em" },
  { tag: t.strikethrough, class: "md-strike" },
  { tag: t.monospace, class: "md-mono" },
  { tag: t.url, class: "md-url" },
  { tag: t.labelName, class: "md-codeinfo" },
  { tag: t.contentSeparator, class: "md-mark" },
  { tag: t.processingInstruction, class: "md-mark" },
  { tag: t.meta, class: "md-mark" },
  { tag: t.atom, class: "md-mark" },
  { tag: t.quote, class: "md-quote-text" },

  /* code-block tokens */
  { tag: t.keyword, class: "tok-keyword" },
  { tag: [t.string, t.special(t.string)], class: "tok-string" },
  { tag: t.comment, class: "tok-comment" },
  { tag: [t.number, t.bool, t.null], class: "tok-atom" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "tok-func" },
  { tag: [t.typeName, t.className], class: "tok-type" },
  { tag: t.propertyName, class: "tok-prop" },
  { tag: [t.operator, t.punctuation], class: "tok-op" },
  { tag: [t.regexp, t.escape], class: "tok-string" },
]);
