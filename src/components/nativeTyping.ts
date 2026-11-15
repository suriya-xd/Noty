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

/**
 * On Android, CodeMirror normally takes typing through the browser's EditContext interface. A
 * keyboard sees that as a plain-text box, so Gboard refuses to paste images from its clipboard
 * ("Noetic doesn't support image pasting here"). Using an ordinary editable element instead lets
 * the keyboard insert images, which arrive as a normal paste the editor turns into a saved image.
 * Must run before any editor is created; importing this module does that.
 */
(EditorView as unknown as { EDIT_CONTEXT: boolean }).EDIT_CONTEXT = false;
