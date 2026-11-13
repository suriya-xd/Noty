import { EditorView, ViewPlugin } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

/**
 * Space kept below the cursor's line, so it sits comfortably above the keyboard rather than
 * against it: a quarter of the visible editor, within sensible bounds.
 */
const bottomSpace = (view: EditorView) =>
  Math.round(Math.min(160, Math.max(64, view.scrollDOM.clientHeight * 0.25)));

/**
 * For touch screens: keeps the line being written on visible with room around it.
 *
 * CodeMirror scrolls to the cursor while typing, but not when a tap moves the cursor, and not
 * when the editor gets shorter because the keyboard opened. So after either of those, and after
 * any change in the editor's height, the cursor's line is scrolled into view (only as far as
 * needed) with the margins below, which also apply to CodeMirror's own scrolling while typing.
 */
export function keepCursorClear(): Extension {
  return [
    EditorView.scrollMargins.of((view) => ({ top: 24, bottom: bottomSpace(view) })),
    ViewPlugin.fromClass(
      class {
        frame = 0;
        observer: ResizeObserver;

        constructor(readonly view: EditorView) {
          this.observer = new ResizeObserver(() => this.reveal());
          this.observer.observe(view.scrollDOM);
        }

        update(update: ViewUpdate) {
          if (!update.view.hasFocus) return;
          if (update.focusChanged || (update.selectionSet && !update.docChanged)) this.reveal();
        }

        /** Next frame (after layout, and outside the update cycle), scrolls the cursor into view. */
        reveal() {
          cancelAnimationFrame(this.frame);
          this.frame = requestAnimationFrame(() => {
            const view = this.view;
            if (!view.hasFocus) return;
            view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "nearest" }) });
          });
        }

        destroy() {
          cancelAnimationFrame(this.frame);
          this.observer.disconnect();
        }
      }
    ),
  ];
}
