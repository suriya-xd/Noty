import { EditorView } from "@codemirror/view";

/**
 * Lets the device's keyboard behave as it does in any other text box: capitalise the first letter
 * of a sentence and of a new line, autocorrect, spell-check and offer word suggestions.
 *
 * CodeMirror turns all of these off by default (it is built for code), which on phones meant
 * every line and every sentence started in lower case. Setting them on the content element
 * overrides those defaults.
 */
export const nativeTyping = EditorView.contentAttributes.of({
  autocapitalize: "sentences",
  autocorrect: "on",
  spellcheck: "true",
  writingsuggestions: "true",
});
