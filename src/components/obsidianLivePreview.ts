import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { vaultIndex } from "../utils/wikilinks/vaultIndex";

// Interactive Checkbox Widget
class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }

  eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.pos === this.pos;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-md-checkbox-wrap";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "cm-md-checkbox";

    input.onmousedown = (e) => {
      e.stopPropagation();
    };

    input.onclick = (e) => {
      e.stopPropagation();
      const nextChar = this.checked ? " " : "x";
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 1, insert: nextChar },
      });
    };

    wrap.appendChild(input);
    return wrap;
  }

  ignoreEvent() {
    return false;
  }
}

// Visual Horizontal Rule Widget
class HrWidget extends WidgetType {
  toDOM(): HTMLElement {
    const hr = document.createElement("div");
    hr.className = "cm-md-hr-widget";
    return hr;
  }
}

// Line Decorations
const h1Line = Decoration.line({ class: "cm-md-line cm-md-h1" });
const h2Line = Decoration.line({ class: "cm-md-line cm-md-h2" });
const h3Line = Decoration.line({ class: "cm-md-line cm-md-h3" });
const h4Line = Decoration.line({ class: "cm-md-line cm-md-h4" });
const h5Line = Decoration.line({ class: "cm-md-line cm-md-h5" });
const h6Line = Decoration.line({ class: "cm-md-line cm-md-h6" });
const quoteLine = Decoration.line({ class: "cm-md-line cm-md-quote" });
const taskDoneLine = Decoration.line({ class: "cm-md-line cm-md-task-done" });
const codeBlockLine = Decoration.line({ class: "cm-md-line cm-md-codeblock" });

// Mark / Replace Decorations
const hideDeco = Decoration.replace({});
const markerActive = Decoration.mark({ class: "cm-md-marker-active" });
const boldDeco = Decoration.mark({ class: "cm-md-bold" });
const italicDeco = Decoration.mark({ class: "cm-md-italic" });
const inlineCodeDeco = Decoration.mark({ class: "cm-md-inline-code" });
const strikeDeco = Decoration.mark({ class: "cm-md-strikethrough" });

interface InlineSpan {
  from: number;
  to: number;
  deco: Decoration;
}

function collectInlineSpans(text: string, lineFrom: number): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const occupied = new Array(text.length).fill(false);

  // 1. Wikilinks (processed first before markdown inline markup)
  const wikilinkRegex = /\[\[([^[\]#|\r\n]+?)(?:#([^[\]|\r\n]+?))?(?:\|([^[\]\r\n]+?))?\]\]/g;
  let wm: RegExpExecArray | null;
  while ((wm = wikilinkRegex.exec(text)) !== null) {
    const start = wm.index;
    const end = start + wm[0].length;
    let hasClash = false;
    for (let i = start; i < end; i++) {
      if (occupied[i]) {
        hasClash = true;
        break;
      }
    }
    if (hasClash) continue;
    for (let i = start; i < end; i++) occupied[i] = true;

    const target = wm[1].trim();
    const header = wm[2]?.trim();
    const alias = wm[3]?.trim();
    const isResolved = Boolean(vaultIndex.resolve(target));

    const deco = Decoration.mark({
      class: isResolved
        ? "cm-md-wikilink text-sky-400 underline underline-offset-2 decoration-sky-500/40 font-medium cursor-pointer hover:text-sky-300"
        : "cm-md-wikilink-unresolved text-zinc-400 border-b border-dashed border-zinc-500/80 font-medium cursor-pointer hover:text-amber-300",
      attributes: {
        "data-wikilink-target": target,
        ...(header ? { "data-wikilink-header": header } : {}),
        title: isResolved
          ? `Click to open ${target}${header ? ` > ${header}` : ""}`
          : `Click to create ${target}`,
      },
    });

    if (alias) {
      spans.push({ from: lineFrom + start, to: lineFrom + start + 2, deco: hideDeco });
      const pipePos = wm[0].indexOf("|");
      spans.push({ from: lineFrom + start + 2, to: lineFrom + start + pipePos + 1, deco: hideDeco });
      spans.push({ from: lineFrom + start + pipePos + 1, to: lineFrom + end - 2, deco });
      spans.push({ from: lineFrom + end - 2, to: lineFrom + end, deco: hideDeco });
    } else {
      spans.push({ from: lineFrom + start, to: lineFrom + start + 2, deco: hideDeco });
      spans.push({ from: lineFrom + start + 2, to: lineFrom + end - 2, deco });
      spans.push({ from: lineFrom + end - 2, to: lineFrom + end, deco: hideDeco });
    }
  }

  const findMatches = (
    regex: RegExp,
    markerLen: number,
    contentDeco: Decoration
  ) => {
    let m: RegExpExecArray | null;
    regex.lastIndex = 0;
    while ((m = regex.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;

      let hasClash = false;
      for (let i = start; i < end; i++) {
        if (occupied[i]) {
          hasClash = true;
          break;
        }
      }
      if (hasClash) continue;

      for (let i = start; i < end; i++) occupied[i] = true;

      const innerLen = m[1].length;
      // Hide opening marker
      spans.push({
        from: lineFrom + start,
        to: lineFrom + start + markerLen,
        deco: hideDeco,
      });
      // Style formatted content
      spans.push({
        from: lineFrom + start + markerLen,
        to: lineFrom + start + markerLen + innerLen,
        deco: contentDeco,
      });
      // Hide closing marker
      spans.push({
        from: lineFrom + end - markerLen,
        to: lineFrom + end,
        deco: hideDeco,
      });
    }
  };

  // Inline code (highest priority)
  findMatches(/`([^`\n]+)`/g, 1, inlineCodeDeco);
  // Bold (**text**)
  findMatches(/\*\*([^*\n]+)\*\*/g, 2, boldDeco);
  // Strikethrough (~~text~~)
  findMatches(/~~([^~\n]+)~~/g, 2, strikeDeco);
  // Italic (*text*)
  findMatches(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, 1, italicDeco);

  spans.sort((a, b) => a.from - b.from);
  return spans;
}

function buildLivePreviewDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const selection = view.state.selection;

  let insideCodeBlock = false;

  for (const { from, to } of view.visibleRanges) {
    let pos = from;

    while (pos <= to) {
      const line = doc.lineAt(pos);
      const text = line.text;
      const isCursorOnLine = selection.ranges.some(
        (r) => r.from <= line.to && r.to >= line.from
      );

      // 1. Code fence check (```)
      if (/^```/.test(text.trim())) {
        insideCodeBlock = !insideCodeBlock;
        builder.add(line.from, line.from, codeBlockLine);
        pos = line.to + 1;
        continue;
      }

      if (insideCodeBlock) {
        builder.add(line.from, line.from, codeBlockLine);
        pos = line.to + 1;
        continue;
      }

      // 2. Headings (# Heading)
      const headingMatch = text.match(/^(#{1,6})\s(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const hashEnd = line.from + level + 1; // includes trailing space

        switch (level) {
          case 1:
            builder.add(line.from, line.from, h1Line);
            break;
          case 2:
            builder.add(line.from, line.from, h2Line);
            break;
          case 3:
            builder.add(line.from, line.from, h3Line);
            break;
          case 4:
            builder.add(line.from, line.from, h4Line);
            break;
          case 5:
            builder.add(line.from, line.from, h5Line);
            break;
          case 6:
            builder.add(line.from, line.from, h6Line);
            break;
        }

        // Hide "# " completely when cursor is not on this line!
        if (isCursorOnLine) {
          builder.add(line.from, hashEnd, markerActive);
        } else {
          builder.add(line.from, hashEnd, hideDeco);
        }

        pos = line.to + 1;
        continue;
      }

      // 3. Blockquotes (> Quote)
      if (/^>\s?(.*)$/.test(text)) {
        builder.add(line.from, line.from, quoteLine);
        const markerEnd = text.startsWith("> ") ? line.from + 2 : line.from + 1;

        // Hide "> " completely when cursor is not on this line!
        if (isCursorOnLine) {
          builder.add(line.from, markerEnd, markerActive);
        } else {
          builder.add(line.from, markerEnd, hideDeco);
        }

        pos = line.to + 1;
        continue;
      }

      // 4. Task lists (- [ ] or - [x])
      const taskMatch = text.match(/^(\s*[-*+]\s+)\[([ xX])\]/);
      if (taskMatch) {
        const prefixLen = taskMatch[1].length;
        const bracketFrom = line.from + prefixLen;
        const bracketTo = bracketFrom + 3;
        const isChecked = taskMatch[2].toLowerCase() === "x";

        if (isChecked) {
          builder.add(line.from, line.from, taskDoneLine);
        }

        const isCursorInsideCheckbox = selection.ranges.some(
          (r) => r.from <= bracketTo && r.to >= bracketFrom
        );

        if (!isCursorInsideCheckbox) {
          builder.add(
            bracketFrom,
            bracketTo,
            Decoration.replace({
              widget: new CheckboxWidget(isChecked, bracketFrom + 1),
            })
          );
        }

        pos = line.to + 1;
        continue;
      }

      // 5. Horizontal rules (---, ***, ___)
      if (/^(---|---|\*\*\*|___)\s*$/.test(text)) {
        if (!isCursorOnLine) {
          builder.add(
            line.from,
            line.to,
            Decoration.replace({
              widget: new HrWidget(),
            })
          );
        }
        pos = line.to + 1;
        continue;
      }

      // 6. Inline Formatting on regular text lines (bold, italic, code, strikethrough)
      // When cursor is NOT on this line, hide formatting characters (** * ~~ `) and style the text!
      if (!isCursorOnLine && text.length > 0) {
        const inlineSpans = collectInlineSpans(text, line.from);
        for (const span of inlineSpans) {
          builder.add(span.from, span.to, span.deco);
        }
      }

      pos = line.to + 1;
    }
  }

  return builder.finish();
}

export const obsidianLivePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildLivePreviewDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged
      ) {
        this.decorations = buildLivePreviewDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

// Obsidian Live Preview Theme Styles
export const obsidianTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "15px",
    backgroundColor: "#0d1117",
    color: "#e6edf3",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji"',
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    overflow: "auto",
    padding: "0",
  },
  ".cm-content": {
    maxWidth: "860px",
    margin: "0 auto",
    padding: "32px 32px 120px 32px",
    lineHeight: "1.75",
    caretColor: "#38bdf8",
  },
  ".cm-line": {
    padding: "2px 0",
    wordBreak: "break-word",
  },
  ".cm-gutters": {
    display: "none", // Clean distraction-free document layout
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
  "&.cm-focused .cm-cursor": {
    borderLeftColor: "#38bdf8",
    borderLeftWidth: "2px",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "rgba(56, 189, 248, 0.25) !important",
  },

  // Headings
  ".cm-md-h1": {
    fontSize: "2.1rem !important",
    fontWeight: "800 !important",
    color: "#ffffff !important",
    letterSpacing: "-0.025em !important",
    lineHeight: "1.3 !important",
    paddingBottom: "8px !important",
    borderBottom: "1px solid #30363d !important",
    marginTop: "28px !important",
    marginBottom: "14px !important",
  },
  ".cm-md-h2": {
    fontSize: "1.6rem !important",
    fontWeight: "700 !important",
    color: "#7dd3fc !important",
    letterSpacing: "-0.02em !important",
    lineHeight: "1.35 !important",
    paddingBottom: "6px !important",
    borderBottom: "1px solid rgba(48, 54, 61, 0.5) !important",
    marginTop: "24px !important",
    marginBottom: "12px !important",
  },
  ".cm-md-h3": {
    fontSize: "1.3rem !important",
    fontWeight: "600 !important",
    color: "#a5b4fc !important",
    letterSpacing: "-0.015em !important",
    lineHeight: "1.4 !important",
    marginTop: "20px !important",
    marginBottom: "8px !important",
  },
  ".cm-md-h4": {
    fontSize: "1.12rem !important",
    fontWeight: "600 !important",
    color: "#c4b5fd !important",
    marginTop: "16px !important",
    marginBottom: "6px !important",
  },
  ".cm-md-h5": {
    fontSize: "1.0rem !important",
    fontWeight: "600 !important",
    color: "#e2e8f0 !important",
    marginTop: "14px !important",
    marginBottom: "4px !important",
  },
  ".cm-md-h6": {
    fontSize: "0.85rem !important",
    fontWeight: "600 !important",
    color: "#94a3b8 !important",
    textTransform: "uppercase !important",
    letterSpacing: "0.06em !important",
    marginTop: "12px !important",
    marginBottom: "4px !important",
  },

  // Syntax Marker Active Pill (shown only while editing on that line)
  ".cm-md-marker-active": {
    color: "#38bdf8 !important",
    opacity: "1 !important",
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important',
    fontSize: "0.88em !important",
    fontWeight: "600 !important",
    backgroundColor: "rgba(56, 189, 248, 0.15) !important",
    padding: "1px 5px !important",
    borderRadius: "4px !important",
    marginRight: "6px !important",
  },

  // Inline formatting classes
  ".cm-md-bold": {
    fontWeight: "700 !important",
    color: "#ffffff !important",
  },
  ".cm-md-italic": {
    fontStyle: "italic !important",
    color: "#e2e8f0 !important",
  },
  ".cm-md-strikethrough": {
    textDecoration: "line-through !important",
    color: "#94a3b8 !important",
  },
  ".cm-md-inline-code": {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important',
    fontSize: "0.9em !important",
    backgroundColor: "rgba(22, 27, 34, 0.9) !important",
    border: "1px solid #30363d !important",
    color: "#7dd3fc !important",
    padding: "1.5px 5px !important",
    borderRadius: "5px !important",
  },

  // Blockquotes
  ".cm-md-quote": {
    borderLeft: "3px solid #38bdf8 !important",
    backgroundColor: "rgba(56, 189, 248, 0.04) !important",
    paddingLeft: "14px !important",
    fontStyle: "italic !important",
    color: "#cbd5e1 !important",
    borderRadius: "0 6px 6px 0 !important",
  },

  // Task List
  ".cm-md-checkbox-wrap": {
    display: "inline-flex !important",
    alignItems: "center !important",
    justifyContent: "center !important",
    marginRight: "6px !important",
    verticalAlign: "middle !important",
  },
  ".cm-md-checkbox": {
    appearance: "none !important",
    width: "16px !important",
    height: "16px !important",
    border: "1.5px solid #484f58 !important",
    borderRadius: "4px !important",
    backgroundColor: "#161b22 !important",
    cursor: "pointer !important",
    position: "relative !important",
    margin: "0 !important",
    transition: "all 0.15s ease !important",
    "&:checked": {
      backgroundColor: "#0284c7 !important",
      borderColor: "#38bdf8 !important",
      "&::after": {
        content: '"" !important',
        position: "absolute !important",
        left: "4.5px !important",
        top: "1.5px !important",
        width: "4px !important",
        height: "8px !important",
        border: "solid white !important",
        borderWidth: "0 2px 2px 0 !important",
        transform: "rotate(45deg) !important",
      },
    },
    "&:hover": {
      borderColor: "#38bdf8 !important",
      boxShadow: "0 0 8px rgba(56, 189, 248, 0.3) !important",
    },
  },
  ".cm-md-task-done": {
    color: "#8b949e !important",
    textDecoration: "line-through !important",
    textDecorationColor: "#64748b !important",
  },

  // Horizontal Rule
  ".cm-md-hr-widget": {
    height: "1px !important",
    backgroundColor: "#30363d !important",
    margin: "24px 0 !important",
    width: "100% !important",
  },

  // Code Block lines
  ".cm-md-codeblock": {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important',
    fontSize: "13.5px !important",
    backgroundColor: "#161b22 !important",
    paddingLeft: "16px !important",
    paddingRight: "16px !important",
    lineHeight: "1.6 !important",
    color: "#7dd3fc !important",
  },

  // Wikilinks
  ".cm-md-wikilink": {
    cursor: "pointer !important",
    color: "#38bdf8 !important",
    textDecoration: "underline !important",
    textUnderlineOffset: "3px !important",
    "&:hover": {
      color: "#7dd3fc !important",
      textDecorationColor: "#7dd3fc !important",
    },
  },
  ".cm-md-wikilink-unresolved": {
    cursor: "pointer !important",
    color: "#94a3b8 !important",
    borderBottom: "1px dashed #64748b !important",
    "&:hover": {
      color: "#fcd34d !important",
      borderColor: "#f59e0b !important",
    },
  },
});
