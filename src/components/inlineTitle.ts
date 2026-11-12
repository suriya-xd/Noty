import { Facet, Prec, StateField } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";

/**
 * Obsidian-style inline title: a large editable title shown above the first line of every note.
 * It is the note's file name, not text in the file. Committing a new value (Enter, or leaving the
 * field) asks the host to rename the file. It is a block widget at the top of the document, so it
 * scrolls with the note.
 */
export interface InlineTitleConfig {
  /**
   * Current title (file name without extension), or null to show no title (non-note files). Read
   * each time the field is drawn, because CodeMirror redraws it when it scrolls back into view and
   * the note may have been renamed since it was opened.
   */
  getTitle: () => string | null;
  /**
   * Renames the file to `name`. Resolves to the name actually used (illegal characters are
   * dropped), or false when refused (name taken, rename failed); the field then goes back to the
   * old title.
   */
  onCommit: (name: string) => Promise<string | false> | string | false;
}

export const inlineTitleFacet = Facet.define<InlineTitleConfig, InlineTitleConfig | null>({
  combine: (values) => values[0] ?? null,
});

const TITLE_SELECTOR = ".cm-inline-title";

function focusTitle(view: EditorView): boolean {
  const el = view.dom.querySelector<HTMLTextAreaElement>(TITLE_SELECTOR);
  if (!el) return false;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  return true;
}

function focusEditorStart(view: EditorView) {
  view.focus();
  view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
}

class TitleWidget extends WidgetType {
  constructor(private readonly config: InlineTitleConfig) {
    super();
  }

  eq(other: TitleWidget): boolean {
    return other.config === this.config;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-inline-title-wrap";

    const input = document.createElement("textarea");
    input.className = "cm-inline-title";
    input.rows = 1;
    const initial = this.config.getTitle() ?? "";
    input.value = initial;
    input.spellcheck = false;
    input.placeholder = "Untitled";
    input.setAttribute("aria-label", "Note title");
    wrap.append(input);

    const fit = () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    };
    input.addEventListener("input", () => {
      // The title is one line of text; a pasted newline would only be thrown away on commit.
      if (input.value.includes("\n")) input.value = input.value.replace(/\s*\n+\s*/g, " ");
      fit();
    });

    let committed = initial;
    const revert = () => {
      input.value = committed;
      fit();
    };
    const finish = async () => {
      const wanted = input.value.trim();
      if (!wanted || wanted === committed) {
        revert();
        return;
      }
      const used = await this.config.onCommit(wanted);
      if (used === false) {
        revert();
      } else {
        committed = used;
        revert();
      }
    };

    input.addEventListener("blur", () => void finish());
    input.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Enter" || (e.key === "ArrowDown" && input.selectionStart === input.value.length)) {
        e.preventDefault();
        e.stopPropagation();
        // Blur commits; then move on to the note text.
        input.blur();
        focusEditorStart(view);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        revert();
        focusEditorStart(view);
      }
    });

    requestAnimationFrame(fit);
    return wrap;
  }

  // Everything inside the field belongs to the field, not to the editor.
  ignoreEvent(): boolean {
    return true;
  }
}

const titleField = StateField.define<DecorationSet>({
  create: (state) => build(state.facet(inlineTitleFacet)),
  update: (value, tr) => {
    const before = tr.startState.facet(inlineTitleFacet);
    const after = tr.state.facet(inlineTitleFacet);
    return before === after ? value : build(after);
  },
  provide: (field) => EditorView.decorations.from(field),
});

function build(config: InlineTitleConfig | null): DecorationSet {
  if (!config || config.getTitle() === null) return Decoration.none;
  return Decoration.set([
    Decoration.widget({ widget: new TitleWidget(config), block: true, side: -1 }).range(0),
  ]);
}

const titleTheme = EditorView.baseTheme({
  ".cm-inline-title-wrap": {
    padding: "8px 0 14px",
  },
  ".cm-inline-title": {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    margin: "0",
    padding: "0",
    border: "none",
    outline: "none",
    resize: "none",
    overflow: "hidden",
    background: "transparent",
    color: "#ffffff",
    caretColor: "#38bdf8",
    fontFamily: "inherit",
    fontSize: "2.1rem",
    fontWeight: "800",
    letterSpacing: "-0.025em",
    lineHeight: "1.3",
    wordBreak: "break-word",
  },
  ".cm-inline-title::placeholder": {
    color: "#484f58",
  },
  ".cm-inline-title::selection": {
    backgroundColor: "rgba(56, 189, 248, 0.25)",
  },
});

export function inlineTitle(config: InlineTitleConfig): Extension {
  return [
    inlineTitleFacet.of(config),
    titleField,
    titleTheme,
    Prec.high(keymap.of([
      {
        // ArrowUp on the first line of the note moves up into the title.
        key: "ArrowUp",
        run: (view) => {
          const sel = view.state.selection.main;
          if (!sel.empty || !view.state.facet(inlineTitleFacet)?.getTitle()) return false;
          const moved = view.moveVertically(sel, false);
          return moved.head === sel.head ? focusTitle(view) : false;
        },
      },
    ])),
  ];
}
