import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { findBlock, moveBlock } from "./blockMove";
import type { BlockRange } from "./blockMove";

/**
 * Notion-style block dragging. Hovering a line shows a grip in the left margin; dragging the grip
 * moves that block (a line, a list item with its children, a code fence, a table) to another place
 * in the note. Uses pointer events rather than HTML5 drag and drop so it behaves the same with a
 * mouse, a pen and a finger, and inside the Tauri webviews.
 */

const HANDLE_WIDTH = 20;
const EDGE_SCROLL_ZONE = 48;
const EDGE_SCROLL_SPEED = 14;

const GRIP_SVG =
  '<svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true">' +
  [3, 8, 13].map((cy) => `<circle cx="2.5" cy="${cy}" r="1.3"/><circle cx="7.5" cy="${cy}" r="1.3"/>`).join("") +
  "</svg>";

/** Dims the lines of the block being dragged. Holds 1-based line numbers, or null when idle. */
const setDragSource = StateEffect.define<BlockRange | null>();

const dragSourceField = StateField.define<BlockRange | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setDragSource)) return effect.value;
    return value;
  },
});

const dragSourceLine = Decoration.line({ class: "cm-block-drag-source" });

/** Line decorations for the dragged block. Kept as its own plugin so it can read the document. */
const dragSourceDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      const before = update.startState.field(dragSourceField);
      const after = update.state.field(dragSourceField);
      if (before !== after || update.docChanged) this.decorations = this.build(update.view);
    }

    build(view: EditorView): DecorationSet {
      const range = view.state.field(dragSourceField);
      if (!range) return Decoration.none;
      const builder = new RangeSetBuilder<Decoration>();
      const doc = view.state.doc;
      for (let n = range.from; n <= range.to && n <= doc.lines; n++) {
        builder.add(doc.line(n).from, doc.line(n).from, dragSourceLine);
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations }
);

interface DragState {
  pointerId: number;
  /** Source block, 0-based inclusive line indices. */
  block: BlockRange;
  /** True when the source is a multi-line selection moving as a bundle. */
  bundle: boolean;
  lastX: number;
  lastY: number;
  /** Line index to insert before, or null when the pointer is not over a valid drop position. */
  insertBefore: number | null;
  raf: number;
}

/** The nearest ancestor (or the scroller itself) that actually scrolls vertically. */
function scrollerFor(view: EditorView): HTMLElement {
  let el: HTMLElement | null = view.scrollDOM;
  while (el) {
    if (el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
    el = el.parentElement;
  }
  return view.scrollDOM;
}

class BlockDragPlugin {
  private handle: HTMLDivElement;
  private indicator: HTMLDivElement;
  private drag: DragState | null = null;
  /** 0-based line index of the block the handle is attached to. */
  private hovered: number | null = null;
  private cachedDoc: Text | null = null;
  private cachedLines: string[] = [];
  private bundleDoc: Text | null = null;
  private bundleKey = "";
  private bundleValue: BlockRange | null = null;
  private readonly coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  constructor(private view: EditorView) {
    this.handle = document.createElement("div");
    this.handle.className = "cm-block-handle";
    this.handle.contentEditable = "false";
    this.handle.setAttribute("role", "button");
    this.handle.setAttribute("aria-label", "Drag to move block");
    this.handle.title = "Drag to move";
    this.handle.innerHTML = GRIP_SVG;

    this.indicator = document.createElement("div");
    this.indicator.className = "cm-block-drop-indicator";

    view.scrollDOM.append(this.handle, this.indicator);

    view.scrollDOM.addEventListener("pointermove", this.onHoverMove);
    view.scrollDOM.addEventListener("pointerleave", this.onHoverLeave);
    this.handle.addEventListener("pointerdown", this.onPointerDown);
    this.handle.addEventListener("pointermove", this.onPointerMove);
    this.handle.addEventListener("pointerup", this.onPointerUp);
    this.handle.addEventListener("pointercancel", this.onPointerCancel);
    this.handle.addEventListener("lostpointercapture", this.onPointerCancel);
    // The handle sits inside the editor, so keep CodeMirror's own press handling (cursor, selection)
    // out of it.
    this.handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  update(update: ViewUpdate) {
    if (this.drag) return;
    if (update.docChanged) {
      this.hideHandle();
    } else if (this.coarse && (update.selectionSet || update.focusChanged || update.geometryChanged)) {
      this.attachToCursor();
    } else if (update.geometryChanged && this.hovered !== null) {
      this.positionHandle(this.hovered);
    }
  }

  destroy() {
    if (this.drag) this.endDrag(false);
    const { scrollDOM } = this.view;
    scrollDOM.removeEventListener("pointermove", this.onHoverMove);
    scrollDOM.removeEventListener("pointerleave", this.onHoverLeave);
    this.handle.remove();
    this.indicator.remove();
  }

  // --- document access ------------------------------------------------------------------------

  /** Lines of the current document, cached per document version (Text is immutable). */
  private lines(): string[] {
    const doc = this.view.state.doc;
    if (this.cachedDoc !== doc) {
      this.cachedDoc = doc;
      this.cachedLines = doc.toString().split("\n");
    }
    return this.cachedLines;
  }

  /**
   * The lines covered by a multi-line selection, widened to whole blocks at both ends (so a
   * half-selected list item or code fence moves complete), or null when nothing spans lines.
   * Blank lines at the edges of the selection and a trailing line the selection only touches at
   * column 0 are left out.
   */
  private selectedBundle(): BlockRange | null {
    const { doc, selection } = this.view.state;
    const sel = selection.main;
    if (sel.empty) return null;
    const key = `${sel.from}-${sel.to}`;
    if (this.bundleDoc === doc && this.bundleKey === key) return this.bundleValue;

    const lines = this.lines();
    const a = doc.lineAt(sel.from);
    const b = doc.lineAt(sel.to);
    let first = a.number - 1;
    let last = b.number - 1;
    if (sel.to === b.from && last > first) last--;
    while (first < last && lines[first].trim() === "") first++;
    while (last > first && lines[last].trim() === "") last--;

    let result: BlockRange | null = null;
    if (first < last) {
      // Widen to whole blocks: a block that starts inside the selection (a list item whose
      // children are only partly selected, a code fence) brings its remaining lines along.
      let from = first;
      let to = last;
      const start = findBlock(lines, first);
      if (start) from = Math.min(from, start.from);
      for (let i = first; i <= last; ) {
        const block = findBlock(lines, i);
        if (block) {
          to = Math.max(to, block.to);
          i = block.to + 1;
        } else {
          i++;
        }
      }
      result = { from, to };
    }
    this.bundleDoc = doc;
    this.bundleKey = key;
    this.bundleValue = result;
    return result;
  }

  /** What the handle on line `index` drags: the selection bundle if the line is in it, else its block. */
  private unitAt(index: number): { range: BlockRange; bundle: boolean } | null {
    const bundle = this.selectedBundle();
    if (bundle && index >= bundle.from && index <= bundle.to) return { range: bundle, bundle: true };
    const block = findBlock(this.lines(), index);
    return block ? { range: block, bundle: false } : null;
  }

  /** x inside the text column, so the lookup works from the margin where the handle lives. */
  private clampX(clientX: number): number {
    const rect = this.view.contentDOM.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(this.view.contentDOM).paddingLeft) || 0;
    return Math.min(Math.max(clientX, rect.left + pad + 4), rect.right - pad - 4);
  }

  // --- hover handle (mouse and pen) -----------------------------------------------------------

  private onHoverMove = (e: PointerEvent) => {
    if (this.drag || e.pointerType === "touch" || e.buttons !== 0) return;
    if (e.target === this.handle || this.handle.contains(e.target as Node)) return;
    const pos = this.view.posAtCoords({ x: this.clampX(e.clientX), y: e.clientY });
    if (pos === null) {
      this.hideHandle();
      return;
    }
    const index = this.view.state.doc.lineAt(pos).number - 1;
    const unit = this.unitAt(index);
    if (!unit) {
      this.hideHandle();
      return;
    }
    if (this.hovered !== unit.range.from) this.positionHandle(unit.range.from);
  };

  private onHoverLeave = () => {
    if (!this.drag) this.hideHandle();
  };

  /** Touch screens have no hover: the handle follows the cursor's block instead. */
  private attachToCursor() {
    const { state } = this.view;
    if (!this.view.hasFocus) {
      this.hideHandle();
      return;
    }
    const index = state.doc.lineAt(state.selection.main.head).number - 1;
    const unit = this.unitAt(index);
    if (unit) this.positionHandle(unit.range.from);
    else this.hideHandle();
  }

  private hideHandle() {
    this.hovered = null;
    this.handle.classList.remove("cm-block-handle-visible");
  }

  private positionHandle(index: number) {
    const view = this.view;
    if (index >= view.state.doc.lines) {
      this.hideHandle();
      return;
    }
    this.hovered = index;
    const lineStart = view.state.doc.line(index + 1).from;
    view.requestMeasure({
      read: (v) => {
        const coords = v.coordsAtPos(lineStart);
        if (!coords) return null;
        const scroller = v.scrollDOM.getBoundingClientRect();
        const content = v.contentDOM.getBoundingClientRect();
        const pad = parseFloat(getComputedStyle(v.contentDOM).paddingLeft) || 0;
        return {
          top: coords.top - scroller.top + v.scrollDOM.scrollTop + (coords.bottom - coords.top - this.handle.offsetHeight) / 2,
          left: content.left - scroller.left + v.scrollDOM.scrollLeft + Math.max(0, pad - HANDLE_WIDTH - 2),
        };
      },
      write: (m) => {
        if (this.hovered !== index) return;
        if (!m) {
          this.hideHandle();
          return;
        }
        this.handle.style.top = `${m.top}px`;
        this.handle.style.left = `${m.left}px`;
        this.handle.classList.add("cm-block-handle-visible");
      },
    });
  }

  // --- dragging -------------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.drag || this.hovered === null) return;
    const unit = this.unitAt(this.hovered);
    if (!unit) return;
    const block = unit.range;
    e.preventDefault();
    e.stopPropagation();

    this.handle.setPointerCapture(e.pointerId);
    this.drag = { pointerId: e.pointerId, block, bundle: unit.bundle, lastX: e.clientX, lastY: e.clientY, insertBefore: null, raf: 0 };
    this.view.dom.classList.add("cm-block-dragging");
    this.view.dispatch({ effects: setDragSource.of({ from: block.from + 1, to: block.to + 1 }) });
    window.addEventListener("keydown", this.onKeyDown, true);
    this.drag.raf = requestAnimationFrame(this.tick);
  };

  private onPointerMove = (e: PointerEvent) => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    this.updateTarget();
  };

  private onPointerUp = (e: PointerEvent) => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    this.updateTarget();
    const { block, bundle, insertBefore } = drag;
    this.endDrag();
    if (insertBefore !== null) this.commitMove(block, insertBefore, bundle);
  };

  private onPointerCancel = (e: PointerEvent) => {
    if (this.drag && e.pointerId === this.drag.pointerId) this.cancelDrag();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    this.cancelDrag();
  };

  private cancelDrag() {
    if (this.drag) this.endDrag();
  }

  /** Tears the drag down. `reset` is false when the view itself is going away. */
  private endDrag(reset = true) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    cancelAnimationFrame(drag.raf);
    window.removeEventListener("keydown", this.onKeyDown, true);
    if (this.handle.hasPointerCapture?.(drag.pointerId)) this.handle.releasePointerCapture(drag.pointerId);
    this.indicator.classList.remove("cm-block-drop-indicator-visible");
    this.view.dom.classList.remove("cm-block-dragging");
    if (!reset) return;
    this.view.dispatch({ effects: setDragSource.of(null) });
    this.hideHandle();
  }

  /** Scrolls while the pointer rests near the top or bottom edge, then refreshes the drop target. */
  private tick = () => {
    const drag = this.drag;
    if (!drag) return;
    const scroller = scrollerFor(this.view);
    const rect = scroller.getBoundingClientRect();
    let delta = 0;
    if (drag.lastY < rect.top + EDGE_SCROLL_ZONE) {
      delta = -EDGE_SCROLL_SPEED * Math.min(1, (rect.top + EDGE_SCROLL_ZONE - drag.lastY) / EDGE_SCROLL_ZONE);
    } else if (drag.lastY > rect.bottom - EDGE_SCROLL_ZONE) {
      delta = EDGE_SCROLL_SPEED * Math.min(1, (drag.lastY - (rect.bottom - EDGE_SCROLL_ZONE)) / EDGE_SCROLL_ZONE);
    }
    if (delta !== 0) {
      scroller.scrollTop += delta;
      this.updateTarget();
    }
    drag.raf = requestAnimationFrame(this.tick);
  };

  /** Works out where the block would land for the current pointer position and draws the marker. */
  private updateTarget() {
    const drag = this.drag;
    if (!drag) return;
    const view = this.view;
    const doc = view.state.doc;

    const pos = view.posAtCoords({ x: this.clampX(drag.lastX), y: drag.lastY }, false);
    const lines = this.lines();
    const index = doc.lineAt(pos ?? doc.length).number - 1;
    // Blank lines are valid drop targets even though they are not blocks themselves.
    const over = findBlock(lines, index) ?? { from: index, to: index };

    const top = view.documentTop + view.lineBlockAt(doc.line(over.from + 1).from).top;
    const bottom = view.documentTop + view.lineBlockAt(doc.line(over.to + 1).from).bottom;
    const before = drag.lastY < (top + bottom) / 2;
    const insertBefore = before ? over.from : over.to + 1;

    const valid = moveBlock(lines, drag.block, insertBefore) !== null;
    drag.insertBefore = valid ? insertBefore : null;

    if (!valid) {
      this.indicator.classList.remove("cm-block-drop-indicator-visible");
      return;
    }
    const scroller = view.scrollDOM.getBoundingClientRect();
    const content = view.contentDOM.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0;
    const y = before ? top : bottom;
    this.indicator.style.top = `${y - scroller.top + view.scrollDOM.scrollTop - 1}px`;
    this.indicator.style.left = `${content.left - scroller.left + view.scrollDOM.scrollLeft + pad}px`;
    this.indicator.style.width = `${Math.max(0, content.width - pad * 2)}px`;
    this.indicator.classList.add("cm-block-drop-indicator-visible");
  }

  private commitMove(block: BlockRange, insertBefore: number, bundle: boolean) {
    const view = this.view;
    const oldLines = view.state.doc.toString().split("\n");
    const result = moveBlock(oldLines, block, insertBefore);
    if (!result) return;

    const oldText = oldLines.join("\n");
    const newText = result.lines.join("\n");

    // Replace only the span that differs, so the rest of the note (and its undo history entry)
    // stays small and untouched regions keep their identity.
    let start = 0;
    const maxStart = Math.min(oldText.length, newText.length);
    while (start < maxStart && oldText[start] === newText[start]) start++;
    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }

    let caret = 0;
    for (let i = 0; i < result.movedStart; i++) caret += result.lines[i].length + 1;

    // A moved bundle stays selected so it can be dragged again; a single block just gets the cursor.
    let selection = { anchor: caret, head: caret };
    if (bundle) {
      const count = block.to - block.from + 1;
      let end = caret;
      for (let i = 0; i < count; i++) end += result.lines[result.movedStart + i].length + (i < count - 1 ? 1 : 0);
      selection = { anchor: caret, head: end };
    }

    view.dispatch({
      changes: { from: start, to: oldEnd, insert: newText.slice(start, newEnd) },
      selection,
      scrollIntoView: true,
      userEvent: "move.block",
    });
  }
}

const blockDragTheme = EditorView.baseTheme({
  ".cm-block-handle": {
    position: "absolute",
    zIndex: "10",
    width: `${HANDLE_WIDTH}px`,
    height: "24px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "5px",
    color: "#6e7681",
    cursor: "grab",
    opacity: "0",
    pointerEvents: "none",
    transition: "opacity 120ms ease, background-color 120ms ease, color 120ms ease",
    userSelect: "none",
    touchAction: "none",
  },
  ".cm-block-handle-visible": {
    opacity: "1",
    pointerEvents: "auto",
  },
  ".cm-block-handle:hover": {
    color: "#e6edf3",
    backgroundColor: "#21262d",
  },
  "&.cm-block-dragging, &.cm-block-dragging *": {
    cursor: "grabbing !important",
    userSelect: "none",
  },
  ".cm-block-drag-source": {
    opacity: "0.35",
  },
  ".cm-block-drop-indicator": {
    position: "absolute",
    zIndex: "10",
    height: "2px",
    borderRadius: "1px",
    backgroundColor: "#38bdf8",
    boxShadow: "0 0 6px rgba(56, 189, 248, 0.6)",
    pointerEvents: "none",
    opacity: "0",
  },
  ".cm-block-drop-indicator-visible": {
    opacity: "1",
  },
  "@media (pointer: coarse)": {
    ".cm-block-handle": { height: "32px", color: "#8b949e" },
  },
});

export function blockDragHandle(): Extension {
  return [dragSourceField, dragSourceDecorations, ViewPlugin.fromClass(BlockDragPlugin), blockDragTheme];
}
