import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject, SyntheticEvent } from "react";
import { canDrop } from "../../utils/customOrder";
import type { DropPosition } from "../../utils/customOrder";

/**
 * Press-and-hold drag to rearrange the notes list on a touch screen.
 *
 * A row is picked up after it is held still for a moment, so a quick swipe still scrolls the
 * list. While something is being dragged the page doesn't scroll by itself; instead the list
 * scrolls when the finger nears its top or bottom edge. Rows mark themselves as drop targets
 * with `data-drop-path` (and `data-drop-dir` for folders); the top-level drop zone uses an empty
 * path.
 *
 * Where a drop lands follows the desktop sidebar: the top or bottom quarter of a folder row puts
 * the item before or after the folder, the middle puts it inside; a note's row splits in half.
 */

const HOLD_MS = 350;
/** Movement allowed while holding before it counts as a scroll instead. */
const SLOP_PX = 10;
const EDGE_PX = 64;
const MAX_SCROLL_STEP = 14;
/** Hovering over a closed folder this long opens it. */
const OPEN_FOLDER_MS = 650;

export interface DragItem {
  path: string;
  name: string;
  isDir: boolean;
}

export interface DropTarget {
  path: string;
  isDir: boolean;
  position: DropPosition;
}

export interface TreeDragState extends DragItem {
  x: number;
  y: number;
  target: DropTarget | null;
}

interface Options {
  scrollRef: RefObject<HTMLElement | null>;
  isCollapsed: (folderPath: string) => boolean;
  onOpenFolder: (folderPath: string) => void;
  onDrop: (item: DragItem, target: DropTarget) => void;
}

function targetAt(x: number, y: number, source: string): DropTarget | null {
  const el = document.elementFromPoint(x, y)?.closest("[data-drop-path]") as HTMLElement | null;
  if (!el) return null;
  const path = el.dataset.dropPath ?? "";
  if (el.dataset.dropRoot !== undefined) {
    return { path: "", isDir: true, position: "inside" };
  }
  const isDir = el.dataset.dropDir !== undefined;
  const rect = el.getBoundingClientRect();
  const f = (y - rect.top) / Math.max(1, rect.height);
  let position: DropPosition;
  if (isDir) position = f < 0.25 ? "before" : f > 0.75 ? "after" : "inside";
  else position = f < 0.5 ? "before" : "after";
  if (!canDrop(source, path, position, isDir)) {
    // Over a folder that can't take it (e.g. a folder dragged over its own child): fall back to
    // placing it beside, if that's allowed.
    if (position === "inside") {
      const beside: DropPosition = f < 0.5 ? "before" : "after";
      return canDrop(source, path, beside, isDir) ? { path, isDir, position: beside } : null;
    }
    return null;
  }
  return { path, isDir, position };
}

export function useTreeDrag({ scrollRef, isCollapsed, onOpenFolder, onDrop }: Options) {
  const [drag, setDrag] = useState<TreeDragState | null>(null);
  const dragRef = useRef<TreeDragState | null>(null);
  const pending = useRef<{ item: DragItem; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppressClick = useRef(false);
  const frame = useRef<number | null>(null);
  const openTimer = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const opts = useRef({ isCollapsed, onOpenFolder, onDrop });
  opts.current = { isCollapsed, onOpenFolder, onDrop };

  const update = useCallback((next: TreeDragState | null) => {
    dragRef.current = next;
    setDrag(next);
  }, []);

  const clearOpenTimer = () => {
    if (openTimer.current) clearTimeout(openTimer.current.timer);
    openTimer.current = null;
  };

  /** Re-reads the target under the finger (after a move or a scroll). */
  const retarget = useCallback(() => {
    const d = dragRef.current;
    if (!d) return;
    const target = targetAt(d.x, d.y, d.path);
    // Hovering inside a closed folder opens it after a moment.
    if (target?.position === "inside" && target.path && opts.current.isCollapsed(target.path)) {
      if (openTimer.current?.path !== target.path) {
        clearOpenTimer();
        const path = target.path;
        openTimer.current = { path, timer: setTimeout(() => opts.current.onOpenFolder(path), OPEN_FOLDER_MS) };
      }
    } else {
      clearOpenTimer();
    }
    const same =
      d.target?.path === target?.path && d.target?.position === target?.position && !!d.target === !!target;
    if (!same) update({ ...d, target });
  }, [update]);

  const stopAutoScroll = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const autoScroll = useCallback(() => {
    const d = dragRef.current;
    const scroller = scrollRef.current;
    if (!d || !scroller) {
      frame.current = null;
      return;
    }
    const rect = scroller.getBoundingClientRect();
    let step = 0;
    if (d.y < rect.top + EDGE_PX) step = -MAX_SCROLL_STEP * Math.min(1, (rect.top + EDGE_PX - d.y) / EDGE_PX);
    else if (d.y > rect.bottom - EDGE_PX) step = MAX_SCROLL_STEP * Math.min(1, (d.y - (rect.bottom - EDGE_PX)) / EDGE_PX);
    if (step !== 0) {
      const before = scroller.scrollTop;
      scroller.scrollTop += step;
      if (scroller.scrollTop !== before) retarget();
    }
    frame.current = requestAnimationFrame(autoScroll);
  }, [scrollRef, retarget]);

  const end = useCallback(
    (commit: boolean) => {
      if (pending.current) clearTimeout(pending.current.timer);
      pending.current = null;
      clearOpenTimer();
      stopAutoScroll();
      const d = dragRef.current;
      if (!d) return;
      // If the release didn't land on the row (so no click follows), don't swallow the next tap.
      setTimeout(() => (suppressClick.current = false), 400);
      update(null);
      if (commit && d.target) opts.current.onDrop({ path: d.path, name: d.name, isDir: d.isDir }, d.target);
    },
    [update]
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const p = pending.current;
      if (p && !dragRef.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > SLOP_PX) {
          clearTimeout(p.timer);
          pending.current = null;
        }
        return;
      }
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = { ...d, x: e.clientX, y: e.clientY };
      setDrag(dragRef.current);
      retarget();
    };
    const onUp = () => end(true);
    const onCancel = () => end(false);
    // While dragging, a finger moving must not scroll the page (the list auto-scrolls instead).
    const onTouchMove = (e: TouchEvent) => {
      if (dragRef.current && e.cancelable) e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") end(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("touchmove", onTouchMove);
      end(false);
    };
  }, [end, retarget]);

  /** Handlers for a row that can be picked up. */
  const bindRow = (item: DragItem) => ({
    onPointerDown: (e: ReactPointerEvent) => {
      if (e.button !== 0 || dragRef.current) return;
      if (pending.current) clearTimeout(pending.current.timer);
      const x = e.clientX;
      const y = e.clientY;
      pending.current = {
        item,
        x,
        y,
        timer: setTimeout(() => {
          pending.current = null;
          suppressClick.current = true;
          navigator.vibrate?.(12);
          update({ ...item, x, y, target: null });
          retarget();
          if (frame.current === null) frame.current = requestAnimationFrame(autoScroll);
        }, HOLD_MS),
      };
    },
    // The press that picked the row up must not also open it.
    onClickCapture: (e: SyntheticEvent) => {
      if (suppressClick.current) {
        suppressClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    // No long-press menu or text selection from the system.
    onContextMenu: (e: SyntheticEvent) => e.preventDefault(),
  });

  return { drag, bindRow };
}
