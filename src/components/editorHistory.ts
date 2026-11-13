import { history, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap } from "@codemirror/view";
import type { Command, ViewUpdate } from "@codemirror/view";

/** How many steps back Undo can go. */
export const MAX_UNDO_STEPS = 20;

export interface HistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Counts the undo steps that are allowed. CodeMirror's history trims old steps only now and then
 * (it keeps between `minDepth` and about `minDepth + 20`), so it can't enforce an exact limit by
 * itself. Each new step adds one (up to the limit), each undo uses one and each redo gives one back.
 */
const undoAllowance = ViewPlugin.fromClass(
  class {
    allowed = 0;
    update(update: ViewUpdate) {
      const trs = update.transactions;
      trs.forEach((tr, i) => {
        if (tr.isUserEvent("undo")) {
          this.allowed = Math.max(0, this.allowed - 1);
        } else if (tr.isUserEvent("redo")) {
          this.allowed = Math.min(MAX_UNDO_STEPS, this.allowed + 1);
        } else {
          const after: EditorState = i + 1 < trs.length ? trs[i + 1].startState : update.state;
          // A new step changes the depth: up by one, or down when CodeMirror trims old steps while
          // adding it. Typing that joins the current step leaves the depth as it is.
          if (undoDepth(after) !== undoDepth(tr.startState)) {
            this.allowed = Math.min(MAX_UNDO_STEPS, this.allowed + 1);
          }
        }
      });
    }
  }
);

const allowed = (view: EditorView) => view.plugin(undoAllowance)?.allowed ?? 0;

export const limitedUndo: Command = (view) => allowed(view) > 0 && undo(view);
export const limitedRedo: Command = (view) => redo(view);

export function historyStatus(view: EditorView): HistoryStatus {
  return {
    canUndo: allowed(view) > 0 && undoDepth(view.state) > 0,
    canRedo: redoDepth(view.state) > 0,
  };
}

/** Undo history limited to MAX_UNDO_STEPS, with the usual shortcuts. */
export function limitedHistory(): Extension {
  return [
    history({ minDepth: MAX_UNDO_STEPS }),
    undoAllowance,
    keymap.of([
      { key: "Mod-z", run: limitedUndo, preventDefault: true },
      { key: "Mod-y", mac: "Mod-Shift-z", run: limitedRedo, preventDefault: true },
      { linux: "Ctrl-Shift-z", run: limitedRedo, preventDefault: true },
    ]),
  ];
}
