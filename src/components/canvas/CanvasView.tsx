import { PromptDialog } from "../dialogs";
import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import type { FC } from "react";
import {
  CanvasColor,
  CanvasData,
  CanvasEdge,
  CanvasNode,
  CanvasSide,
  Point,
  Rect,
  ViewportState,
} from "../../types/canvas";
import {
  parseCanvas,
  serializeCanvas,
} from "../../utils/canvas/parser";
import {
  screenToWorld,
  clampZoom,
  zoomTowardPoint,
  snapToGrid,
  getZoomToFitViewport,
  isNodeInsideGroup,
  isNodeInViewport,
  isPointInRect,
  scaleRectAboutCenter,
  scaleRectFromCorner,
  clampTextNodeFontSize,
  getTextNodeFontSize,
  measureTextCardHeight,
  TEXT_NODE_DEFAULT_FONT_SIZE,
  MIN_NODE_WIDTH,
  MIN_NODE_HEIGHT,
} from "../../utils/canvas/math";
import { LayoutDashboard, LayoutGrid } from "lucide-react";
import { CanvasHistory } from "../../utils/canvas/history";
import { CanvasNodeItem, ResizeHandle } from "./CanvasNodeItem";
import { CanvasEdgeLayer } from "./CanvasEdgeLayer";
import { CanvasToolbar } from "./CanvasToolbar";
import { CanvasContextMenu, ContextMenuState } from "./CanvasContextMenu";
import { CanvasAddNoteModal } from "./CanvasAddNoteModal";
import { InsertImageModal } from "../InsertImageModal";
import { NoeticBridge } from "../../services/noeticBridge";
import { VaultEntry } from "../../types/noetic";

interface CanvasViewProps {
  filePath: string;
  initialContent: string;
  vaultPath: string;
  vaultFiles: VaultEntry[];
  onDebouncedSave: (filePath: string, content: string) => void;
  onOpenFile?: (path: string) => void;
  onClose?: () => void;
  onRefreshFiles?: () => Promise<void>;
  onPreviewImage?: (src: string, alt?: string, title?: string) => void;
  /** Touch screens (the mobile app): cards have no resize handles and are resized by pinching. */
  touchMode?: boolean;
}

export const CanvasView: FC<CanvasViewProps> = ({
  filePath,
  initialContent,
  vaultPath,
  vaultFiles,
  onDebouncedSave,
  onOpenFile,
  onClose,
  onRefreshFiles,
  onPreviewImage,
  touchMode = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  // Latest values for the touch handlers below, which are attached once.
  const touchStateRef = useRef<{
    touchMode: boolean;
    selected: Set<string>;
    nodes: CanvasNode[];
    snapGrid: boolean;
    setNodeRect: (nodeId: string, rect: Rect & { fontSize?: number }) => void;
    finishResize: () => void;
  } | null>(null);

  // 1. Core Canvas Data State
  const [canvasData, setCanvasData] = useState<CanvasData>(() =>
    parseCanvas(initialContent)
  );

  // Autosave debounce timer
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // History stack
  const historyRef = useRef<CanvasHistory>(new CanvasHistory());
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Update undo/redo availability
  const updateHistoryState = () => {
    setCanUndo(historyRef.current.canUndo());
    setCanRedo(historyRef.current.canRedo());
  };

  // 2. Viewport Navigation State
  const [viewport, setViewport] = useState<ViewportState>({
    panX: 0,
    panY: 0,
    zoom: 1,
  });

  const [snapGrid, setSnapGrid] = useState(true);

  // Viewport dimensions
  const [viewportSize, setViewportSize] = useState({ width: 1200, height: 800 });

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setViewportSize({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  // Touch support. The canvas is driven by mouse handlers; on touch screens a one-finger drag is
  // replayed as the equivalent mouse gesture (drag a card or handle, or pan on empty space) and
  // two fingers pinch-zoom and pan. Taps are left alone so the browser's own click / double-click
  // still reach cards, and toolbars and text fields are never intercepted.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    type Mode = "idle" | "pending" | "drag" | "pinch" | "resize";
    let mode: Mode = "idle";
    let target: Element | null = null;
    let button = 0;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let pinchDist = 0;
    let pinchMid = { x: 0, y: 0 };
    // Pinching a selected card resizes it (touch mode only).
    let resizeId: string | null = null;
    let resizeFrom: Rect | null = null;
    let resizeDist = 0;
    let resizeFont: number | undefined; // text cards scale their font with the pinch

    /** The selected card under a two-finger touch: one a finger is on, or one the pinch is centred on. */
    const selectedCardUnder = (touches: TouchList, mid: { x: number; y: number }): string | null => {
      const st = touchStateRef.current;
      if (!st?.touchMode || st.selected.size === 0) return null;
      for (const touch of [touches[0], touches[1]]) {
        const id = (touch.target as Element | null)?.closest?.("[data-node-id]")?.getAttribute("data-node-id");
        if (id && st.selected.has(id)) return id;
      }
      for (const id of st.selected) {
        const r = document.getElementById(`canvas-node-${id}`)?.getBoundingClientRect();
        if (r && mid.x >= r.left && mid.x <= r.right && mid.y >= r.top && mid.y <= r.bottom) return id;
      }
      return null;
    };
    const endResize = () => {
      const st = touchStateRef.current;
      if (resizeId && st) {
        const node = st.nodes.find((n) => n.id === resizeId);
        if (node && st.snapGrid) {
          // Text cards keep their pinched size: snapping it would break the text/card proportion.
          const isText = node.type === "text";
          st.setNodeRect(resizeId, {
            x: snapToGrid(node.x),
            y: snapToGrid(node.y),
            width: isText ? node.width : snapToGrid(node.width),
            height: isText ? node.height : snapToGrid(node.height),
          });
        }
        st.finishResize();
      }
      resizeId = null;
      resizeFrom = null;
    };

    const fire = (type: "mousedown" | "mousemove" | "mouseup", x: number, y: number) => {
      target?.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: x,
          clientY: y,
          button,
          buttons: type === "mouseup" ? 0 : button === 1 ? 4 : 1,
        })
      );
    };
    const isControl = (t: Element) =>
      !!t.closest("button, input, textarea, select, a, [contenteditable='true'], [data-canvas-ui]");
    const measure = (touches: TouchList) => {
      const [a, b] = [touches[0], touches[1]];
      return {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        mid: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
      };
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        if (mode === "drag") fire("mouseup", lastX, lastY);
        const m = measure(e.touches);
        const cardId = selectedCardUnder(e.touches, m.mid);
        const card = cardId ? touchStateRef.current?.nodes.find((n) => n.id === cardId) : undefined;
        if (card && m.dist > 0) {
          resizeId = card.id;
          resizeFrom = { x: card.x, y: card.y, width: card.width, height: card.height };
          resizeDist = m.dist;
          resizeFont = card.type === "text" ? getTextNodeFontSize(card) : undefined;
          mode = "resize";
          e.preventDefault();
          return;
        }
        pinchDist = m.dist;
        pinchMid = m.mid;
        mode = "pinch";
        e.preventDefault();
        return;
      }
      if (e.touches.length !== 1) return;
      const t = e.target as Element;
      if (isControl(t)) {
        mode = "idle";
        return;
      }
      target = t;
      // On a card: left-button drag (move / resize / connect). On empty space: middle-button drag, i.e. pan.
      button = t.closest("[data-node-id]") ? 0 : 1;
      startX = lastX = e.touches[0].clientX;
      startY = lastY = e.touches[0].clientY;
      mode = "pending";
    };

    const onMove = (e: TouchEvent) => {
      if (mode === "resize") {
        if (e.touches.length < 2 || !resizeId || !resizeFrom) return;
        e.preventDefault();
        const m = measure(e.touches);
        const rect = scaleRectAboutCenter(resizeFrom, m.dist / resizeDist);
        touchStateRef.current?.setNodeRect(resizeId, {
          ...rect,
          ...(resizeFont !== undefined
            ? { fontSize: clampTextNodeFontSize((resizeFont * rect.width) / resizeFrom.width) }
            : {}),
        });
        return;
      }
      if (mode === "pinch") {
        if (e.touches.length < 2) return;
        e.preventDefault();
        const m = measure(e.touches);
        const rect = el.getBoundingClientRect();
        const scale = pinchDist > 0 ? m.dist / pinchDist : 1;
        const dx = m.mid.x - pinchMid.x;
        const dy = m.mid.y - pinchMid.y;
        setViewport((prev) => {
          const zoomed = zoomTowardPoint(
            prev,
            { x: m.mid.x - rect.left, y: m.mid.y - rect.top },
            clampZoom(prev.zoom * scale)
          );
          return { ...zoomed, panX: zoomed.panX + dx, panY: zoomed.panY + dy };
        });
        pinchDist = m.dist;
        pinchMid = m.mid;
        return;
      }
      if (mode !== "pending" && mode !== "drag") return;
      const { clientX, clientY } = e.touches[0];
      if (mode === "pending") {
        if (Math.hypot(clientX - startX, clientY - startY) < 6) return;
        mode = "drag";
        fire("mousedown", startX, startY);
      }
      e.preventDefault();
      lastX = clientX;
      lastY = clientY;
      fire("mousemove", clientX, clientY);
    };

    const onEnd = (e: TouchEvent) => {
      if (mode === "drag") {
        // Also stops the browser from sending its own mouse events / click for this gesture.
        e.preventDefault();
        fire("mouseup", lastX, lastY);
      }
      if (mode === "resize") {
        // Lifting either finger ends the resize; the other one must lift too before a new gesture.
        e.preventDefault();
        if (resizeId) endResize();
        if (e.touches.length === 0) mode = "idle";
        return;
      }
      // After a pinch, wait for every finger to lift before starting a new gesture.
      if (e.touches.length === 0 || mode !== "pinch") mode = "idle";
    };

    // Focusing a text field in a card that pokes past the edge makes the browser scroll this
    // (overflow-hidden) box to reveal it, which drags the toolbars off-screen. Pin it in place.
    const pin = (e: Event) => {
      const box = e.currentTarget as HTMLElement;
      if (box.scrollLeft !== 0) box.scrollLeft = 0;
      if (box.scrollTop !== 0) box.scrollTop = 0;
    };
    const parent = el.parentElement;
    el.addEventListener("scroll", pin);
    parent?.addEventListener("scroll", pin);

    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: false });
    el.addEventListener("touchcancel", onEnd, { passive: false });
    return () => {
      el.removeEventListener("scroll", pin);
      parent?.removeEventListener("scroll", pin);
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  // Center or fit on initial load if nodes exist
  // (The view is keyed by file path, so this runs once per opened canvas. Fitting later, when the
  // first card is added to an empty board, would zoom in on that card and throw off new placements.)
  useEffect(() => {
    if (canvasData.nodes.length > 0 && containerRef.current) {
      const fit = getZoomToFitViewport(
        canvasData.nodes,
        containerRef.current.clientWidth || 1200,
        containerRef.current.clientHeight || 800
      );
      // Never open zoomed in past 100%.
      setViewport(fit.zoom > 1 ? zoomTowardPoint(fit, {
        x: (containerRef.current.clientWidth || 1200) / 2,
        y: (containerRef.current.clientHeight || 800) / 2,
      }, 1) : fit);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external file content updates if file changed on disk
  const lastSavedContentRef = useRef(initialContent);
  useEffect(() => {
    if (initialContent !== lastSavedContentRef.current) {
      lastSavedContentRef.current = initialContent;
      const parsed = parseCanvas(initialContent);
      setCanvasData(parsed);
    }
  }, [initialContent]);

  // Push state to history & debounce save
  const commitCanvasChange = useCallback(
    (updater: (prev: CanvasData) => CanvasData, pushToHistory = true) => {
      setCanvasData((prev) => {
        if (pushToHistory) {
          historyRef.current.pushState(prev);
          updateHistoryState();
        }
        const next = updater(prev);
        const serialized = serializeCanvas(next);
        lastSavedContentRef.current = serialized;

        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          onDebouncedSave(filePath, serialized);
        }, 500);

        return next;
      });
    },
    [filePath, onDebouncedSave]
  );

  // 3. Selection State
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // 4. Interactive Action States
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef<{ mouseX: number; mouseY: number; panX: number; panY: number } | null>(null);
  const [isSpacePressed, setIsSpacePressed] = useState(false);

  // Dragging nodes
  const [isDraggingNodes, setIsDraggingNodes] = useState(false);
  const dragStartRef = useRef<{
    startScreen: Point;
    startWorld: Point;
    nodeInitialPositions: Map<string, Point>;
    hasMoved: boolean;
  } | null>(null);

  // Resizing a node
  const [resizingNode, setResizingNode] = useState<{
    nodeId: string;
    handle: ResizeHandle;
    initialRect: Rect;
    startWorld: Point;
    /** Text cards: font size at the start, scaled by corner handles. */
    initialFontSize?: number;
    /** Text cards: card height needed to show all the text, by card width (cached per resize). */
    fitHeights?: Map<number, number | null>;
  } | null>(null);

  // Marquee selection
  const [marquee, setMarquee] = useState<{ startWorld: Point; currentWorld: Point } | null>(null);

  // Draft edge connection
  const [draftEdge, setDraftEdge] = useState<{
    fromNodeId: string;
    fromSide: CanvasSide;
    currentPoint: Point;
  } | null>(null);

  // Context Menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Add Note & Image Modals
  const [isAddNoteModalOpen, setIsAddNoteModalOpen] = useState(false);
  const [isAddImageModalOpen, setIsAddImageModalOpen] = useState(false);
  const addNoteTargetWorldPos = useRef<Point>({ x: 100, y: 100 });
  const [isAddLinkOpen, setIsAddLinkOpen] = useState(false);

  // Vault note paths, to flag cards whose note was deleted or renamed outside the canvas
  const vaultFilePaths = useMemo(
    () => new Set(vaultFiles.filter((f) => !f.is_directory).map((f) => f.path)),
    [vaultFiles]
  );

  // Map of nodes by ID for fast edge lookup
  const nodesMap = useMemo(() => {
    const map = new Map<string, CanvasNode>();
    canvasData.nodes.forEach((n) => map.set(n.id, n));
    return map;
  }, [canvasData.nodes]);

  // --------------------------------------------------------------------------
  // Keyboard Shortcuts (Space, Del, Undo/Redo, Duplicate, Select All, Nudge)
  // --------------------------------------------------------------------------
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing inside an input or textarea
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }

      if (e.code === "Space" && !e.repeat) {
        setIsSpacePressed(true);
      }

      // Undo: Ctrl/Cmd + Z
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        const prev = historyRef.current.undo(canvasData);
        if (prev) {
          setCanvasData(prev);
          updateHistoryState();
          onDebouncedSave(filePath, serializeCanvas(prev));
        }
      }

      // Redo: Ctrl/Cmd + Shift + Z or Ctrl + Y
      if (
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z") ||
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y")
      ) {
        e.preventDefault();
        const next = historyRef.current.redo(canvasData);
        if (next) {
          setCanvasData(next);
          updateHistoryState();
          onDebouncedSave(filePath, serializeCanvas(next));
        }
      }

      // Select All: Ctrl/Cmd + A
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelectedNodeIds(new Set(canvasData.nodes.map((n) => n.id)));
      }

      // Duplicate: Ctrl/Cmd + D
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        handleDuplicateSelected();
      }

      // Delete: Delete or Backspace
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        handleDeleteSelected();
      }

      // Escape: Deselect all / cancel draft
      if (e.key === "Escape") {
        setSelectedNodeIds(new Set());
        setSelectedEdgeId(null);
        setDraftEdge(null);
        setContextMenu(null);
      }

      // Arrow Keys: Nudge selected nodes
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key) && selectedNodeIds.size > 0) {
        e.preventDefault();
        const step = e.shiftKey ? 1 : snapGrid ? 16 : 8;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;

        commitCanvasChange((prev) => ({
          ...prev,
          nodes: prev.nodes.map((node) => {
            if (selectedNodeIds.has(node.id)) {
              return { ...node, x: node.x + dx, y: node.y + dy };
            }
            return node;
          }),
        }));
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setIsSpacePressed(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [canvasData, selectedNodeIds, selectedEdgeId, snapGrid, commitCanvasChange, filePath, onDebouncedSave]);

  // --------------------------------------------------------------------------
  // Wheel Zoom (Ctrl+Wheel) & Pan (2-finger / Wheel)
  // --------------------------------------------------------------------------
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const mouseScreen: Point = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    if (e.ctrlKey || e.metaKey) {
      // Zoom toward mouse pointer
      const zoomFactor = Math.pow(0.998, e.deltaY * 1.5);
      const nextZoom = clampZoom(viewport.zoom * zoomFactor);
      const nextVp = zoomTowardPoint(viewport, mouseScreen, nextZoom);
      setViewport(nextVp);
    } else {
      // 2-finger scroll / standard pan
      setViewport((prev) => ({
        ...prev,
        panX: prev.panX - e.deltaX,
        panY: prev.panY - e.deltaY,
      }));
    }
  };

  // --------------------------------------------------------------------------
  // Mouse Down on Canvas (Pan / Marquee / Deselect)
  // --------------------------------------------------------------------------
  const handleCanvasMouseDown = (e: React.MouseEvent) => {
    if (contextMenu) setContextMenu(null);

    // The toolbars sit inside the canvas, so pressing one of their buttons arrives here too.
    // That is not a press on empty canvas: treating it as one cleared the selection, which
    // removed the selection toolbar before its button could act.
    if ((e.target as Element).closest?.("[data-canvas-ui]")) return;

    // Middle mouse button or Space + left click => Pan
    if (e.button === 1 || (e.button === 0 && isSpacePressed)) {
      e.preventDefault();
      setIsPanning(true);
      panStartRef.current = {
        mouseX: e.clientX,
        mouseY: e.clientY,
        panX: viewport.panX,
        panY: viewport.panY,
      };
      return;
    }

    // Left click on empty canvas
    if (e.button === 0) {
      if (!e.shiftKey) {
        setSelectedNodeIds(new Set());
        setSelectedEdgeId(null);
      }

      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const worldPt = screenToWorld(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        viewport
      );

      // Start marquee selection
      setMarquee({ startWorld: worldPt, currentWorld: worldPt });
    }
  };

  // --------------------------------------------------------------------------
  touchStateRef.current = {
    touchMode,
    selected: selectedNodeIds,
    nodes: canvasData.nodes,
    snapGrid,
    setNodeRect: (nodeId, rect) =>
      setCanvasData((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, ...rect } : n)),
      })),
    // Records the resize in the undo history and saves it, as a handle resize does.
    finishResize: () => commitCanvasChange((prev) => prev),
  };

  // Global Mouse Move (Pan, Drag Nodes, Resize, Marquee, Draft Edge)
  // --------------------------------------------------------------------------
  const handleMouseMove = (e: React.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const screenPt: Point = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const currentWorld = screenToWorld(screenPt, viewport);

    // 1. Panning
    if (isPanning && panStartRef.current) {
      const panStart = panStartRef.current;
      const dx = e.clientX - panStart.mouseX;
      const dy = e.clientY - panStart.mouseY;
      setViewport((prev) => ({
        ...prev,
        panX: panStart.panX + dx,
        panY: panStart.panY + dy,
      }));
      return;
    }

    // 2. Draft Edge Connecting
    if (draftEdge) {
      setDraftEdge((prev) => (prev ? { ...prev, currentPoint: currentWorld } : null));
      return;
    }

    // 3. Resizing Node
    if (resizingNode) {
      const { nodeId, handle, initialRect, startWorld, initialFontSize, fitHeights } = resizingNode;
      const dx = currentWorld.x - startWorld.x;
      const dy = currentWorld.y - startWorld.y;

      // Text cards: corners scale the card and its text together; sides reshape the card at the
      // same font size, but never so small that text is cut off.
      if (initialFontSize !== undefined && fitHeights) {
        let next: Rect;
        let fontSize = initialFontSize;
        if (handle.length === 2) {
          const scaled = scaleRectFromCorner(
            initialRect,
            handle as "nw" | "ne" | "sw" | "se",
            dx,
            dy,
            initialFontSize
          );
          next = scaled.rect;
          fontSize = clampTextNodeFontSize(initialFontSize * scaled.scale);
        } else {
          next = resizeTextCardFromSide(initialRect, handle, dx, dy, (width) => {
            const key = Math.round(width);
            if (!fitHeights.has(key)) fitHeights.set(key, measureTextCardHeight(nodeId, key));
            return fitHeights.get(key) ?? null;
          });
        }
        setCanvasData((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) => (n.id === nodeId ? { ...n, ...next, fontSize } : n)),
        }));
        return;
      }

      let newX = initialRect.x;
      let newY = initialRect.y;
      let newW = initialRect.width;
      let newH = initialRect.height;

      const minW = MIN_NODE_WIDTH;
      const minH = MIN_NODE_HEIGHT;

      if (handle.includes("e")) newW = Math.max(minW, initialRect.width + dx);
      if (handle.includes("s")) newH = Math.max(minH, initialRect.height + dy);
      if (handle.includes("w")) {
        const potentialW = initialRect.width - dx;
        if (potentialW >= minW) {
          newX = initialRect.x + dx;
          newW = potentialW;
        }
      }
      if (handle.includes("n")) {
        const potentialH = initialRect.height - dy;
        if (potentialH >= minH) {
          newY = initialRect.y + dy;
          newH = potentialH;
        }
      }

      if (snapGrid) {
        newX = snapToGrid(newX);
        newY = snapToGrid(newY);
        newW = snapToGrid(newW);
        newH = snapToGrid(newH);
      }

      setCanvasData((prev) => ({
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.id === nodeId ? { ...n, x: newX, y: newY, width: newW, height: newH } : n
        ),
      }));
      return;
    }

    // 4. Dragging Nodes (Multi-drag & Spatial Group Drag)
    if (dragStartRef.current) {
      const dragStart = dragStartRef.current;
      if (!dragStart.hasMoved) {
        const dist = Math.hypot(
          e.clientX - dragStart.startScreen.x,
          e.clientY - dragStart.startScreen.y
        );
        if (dist < 4) {
          // Below threshold: ignore mouse jitter during clicks
          return;
        }
        dragStart.hasMoved = true;
        setIsDraggingNodes(true);
      }

      const { startWorld, nodeInitialPositions } = dragStart;
      const dx = currentWorld.x - startWorld.x;
      const dy = currentWorld.y - startWorld.y;

      setCanvasData((prev) => ({
        ...prev,
        nodes: prev.nodes.map((node) => {
          const initialPos = nodeInitialPositions.get(node.id);
          if (initialPos) {
            let nextX = initialPos.x + dx;
            let nextY = initialPos.y + dy;
            if (snapGrid) {
              nextX = snapToGrid(nextX);
              nextY = snapToGrid(nextY);
            }
            return { ...node, x: nextX, y: nextY };
          }
          return node;
        }),
      }));
      return;
    }

    // 5. Marquee Selection
    if (marquee) {
      setMarquee((prev) => (prev ? { ...prev, currentWorld } : null));

      // Calculate marquee box
      const minX = Math.min(marquee.startWorld.x, currentWorld.x);
      const maxX = Math.max(marquee.startWorld.x, currentWorld.x);
      const minY = Math.min(marquee.startWorld.y, currentWorld.y);
      const maxY = Math.max(marquee.startWorld.y, currentWorld.y);
      const marqueeRect: Rect = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };

      const intersecting = new Set<string>();
      for (const node of canvasData.nodes) {
        const nodeRect: Rect = { x: node.x, y: node.y, width: node.width, height: node.height };
        if (
          nodeRect.x < marqueeRect.x + marqueeRect.width &&
          nodeRect.x + nodeRect.width > marqueeRect.x &&
          nodeRect.y < marqueeRect.y + marqueeRect.height &&
          nodeRect.y + nodeRect.height > marqueeRect.y
        ) {
          intersecting.add(node.id);
        }
      }
      setSelectedNodeIds(intersecting);
    }
  };

  // --------------------------------------------------------------------------
  // Global Mouse Up (End Pan, Drag, Resize, Marquee, Edge Connect)
  // --------------------------------------------------------------------------
  const handleMouseUp = (e: React.MouseEvent) => {
    if (isPanning) {
      setIsPanning(false);
      panStartRef.current = null;
    }

    if (resizingNode) {
      commitCanvasChange((prev) => prev); // Record history on resize complete
      setResizingNode(null);
    }

    if (dragStartRef.current) {
      if (dragStartRef.current.hasMoved) {
        commitCanvasChange((prev) => prev); // Record history on drag complete
        setIsDraggingNodes(false);
      }
      dragStartRef.current = null;
    }

    if (marquee) {
      setMarquee(null);
    }

    // Draft edge completed
    if (draftEdge) {
      // Check if dropped onto a node
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        const dropWorld = screenToWorld(
          { x: e.clientX - rect.left, y: e.clientY - rect.top },
          viewport
        );

        const targetNode = canvasData.nodes.find(
          (n) => n.id !== draftEdge.fromNodeId && isPointInRect(dropWorld, n)
        );

        if (targetNode) {
          // Connected to an existing node!
          const newEdge: CanvasEdge = {
            id: `edge_${Math.random().toString(36).slice(2, 10)}`,
            fromNode: draftEdge.fromNodeId,
            fromSide: draftEdge.fromSide,
            toNode: targetNode.id,
            toEnd: "arrow",
          };
          commitCanvasChange((prev) => ({
            ...prev,
            edges: [...prev.edges, newEdge],
          }));
        } else {
          // Dropped on empty canvas => Spawn new connected text card!
          const newCardId = `node_${Math.random().toString(36).slice(2, 10)}`;
          const newCard: CanvasNode = {
            id: newCardId,
            type: "text",
            x: snapGrid ? snapToGrid(dropWorld.x) : dropWorld.x,
            y: snapGrid ? snapToGrid(dropWorld.y) : dropWorld.y,
            width: 250,
            height: 160,
            text: "",
            fontSize: TEXT_NODE_DEFAULT_FONT_SIZE,
          };
          const newEdge: CanvasEdge = {
            id: `edge_${Math.random().toString(36).slice(2, 10)}`,
            fromNode: draftEdge.fromNodeId,
            fromSide: draftEdge.fromSide,
            toNode: newCardId,
            toEnd: "arrow",
          };
          commitCanvasChange((prev) => ({
            ...prev,
            nodes: [...prev.nodes, newCard],
            edges: [...prev.edges, newEdge],
          }));
          setSelectedNodeIds(new Set([newCardId]));
        }
      }
      setDraftEdge(null);
    }
  };

  // --------------------------------------------------------------------------
  // Node Selection, Drag & Resize Start
  // --------------------------------------------------------------------------
  const handleSelectNode = (e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    setSelectedEdgeId(null);

    if (e.shiftKey) {
      setSelectedNodeIds((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) {
          next.delete(nodeId);
        } else {
          next.add(nodeId);
        }
        return next;
      });
    } else {
      if (!selectedNodeIds.has(nodeId)) {
        setSelectedNodeIds(new Set([nodeId]));
      }
    }
  };

  const handleStartDragNode = (e: React.MouseEvent, nodeId: string) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const startWorld = screenToWorld(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      viewport
    );

    // Determine nodes to drag (selected nodes + any nodes inside a selected group)
    const activeSelected = selectedNodeIds.has(nodeId)
      ? selectedNodeIds
      : new Set([nodeId]);

    const nodePositions = new Map<string, Point>();
    const allDragIds = new Set<string>(activeSelected);

    // If any selected node is a Group, find all nodes inside its bounds
    for (const id of activeSelected) {
      const node = nodesMap.get(id);
      if (node && node.type === "group") {
        for (const candidate of canvasData.nodes) {
          if (candidate.id !== node.id && isNodeInsideGroup(candidate, node)) {
            allDragIds.add(candidate.id);
          }
        }
      }
    }

    allDragIds.forEach((id) => {
      const n = nodesMap.get(id);
      if (n) nodePositions.set(id, { x: n.x, y: n.y });
    });

    dragStartRef.current = {
      startScreen: { x: e.clientX, y: e.clientY },
      startWorld,
      nodeInitialPositions: nodePositions,
      hasMoved: false,
    };
  };

  /**
   * Resizes a text card from a side handle. The font stays the same, so the card can shrink only
   * until its text would no longer fit (a card that already overflows can't shrink further).
   * `fitHeight(width)` is the card height its text needs at that width, or null if unknown.
   */
  const resizeTextCardFromSide = (
    initial: Rect,
    handle: ResizeHandle,
    dx: number,
    dy: number,
    fitHeight: (width: number) => number | null
  ): Rect => {
    let { x, y, width, height } = initial;
    if (handle === "n" || handle === "s") {
      height = Math.max(MIN_NODE_HEIGHT, handle === "s" ? initial.height + dy : initial.height - dy);
      if (snapGrid) height = snapToGrid(height);
      const needed = fitHeight(initial.width);
      if (needed !== null) height = Math.max(height, Math.min(needed, initial.height));
      if (handle === "n") y = initial.y + initial.height - height;
    } else {
      width = Math.max(MIN_NODE_WIDTH, handle === "e" ? initial.width + dx : initial.width - dx);
      if (snapGrid) width = snapToGrid(width);
      const fits = (w: number) => {
        const needed = fitHeight(w);
        return needed === null || needed <= initial.height;
      };
      if (width < initial.width && !fits(width)) {
        if (!fits(initial.width)) {
          width = initial.width; // already overflowing: don't make it worse
        } else {
          // Narrowest width (to the pixel) at which the text still fits.
          let lo = width;
          let hi = initial.width;
          while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (fits(mid)) hi = mid;
            else lo = mid;
          }
          width = hi;
        }
      }
      if (handle === "w") x = initial.x + initial.width - width;
    }
    return { x, y, width, height };
  };

  const handleStartResize = (e: React.MouseEvent, nodeId: string, handle: ResizeHandle) => {
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const startWorld = screenToWorld(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      viewport
    );

    const node = nodesMap.get(nodeId);
    if (!node) return;

    setResizingNode({
      nodeId,
      handle,
      initialRect: { x: node.x, y: node.y, width: node.width, height: node.height },
      startWorld,
      ...(node.type === "text"
        ? { initialFontSize: getTextNodeFontSize(node), fitHeights: new Map() }
        : {}),
    });
  };

  const handleStartEdgeConnect = (e: React.MouseEvent, nodeId: string, side: CanvasSide) => {
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const worldPt = screenToWorld(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      viewport
    );

    setDraftEdge({
      fromNodeId: nodeId,
      fromSide: side,
      currentPoint: worldPt,
    });
  };

  // --------------------------------------------------------------------------
  // Node Creation Helpers
  // --------------------------------------------------------------------------
  const addNodeAtPosition = (type: CanvasNode["type"], pos: Point, extra: Record<string, unknown> = {}) => {
    const id = `node_${Math.random().toString(36).slice(2, 10)}`;
    const x = snapGrid ? snapToGrid(pos.x) : pos.x;
    const y = snapGrid ? snapToGrid(pos.y) : pos.y;

    let newNode: CanvasNode;
    if (type === "text") {
      newNode = { id, type: "text", x, y, width: 320, height: 200, text: "# New Note\n\nWrite here...", fontSize: TEXT_NODE_DEFAULT_FONT_SIZE, ...extra };
    } else if (type === "file") {
      // Note cards only show the note's name, so they start compact (images pass their own size).
      newNode = { id, type: "file", x, y, width: 300, height: 140, file: (extra.file as string) || "Welcome.md", ...extra };
    } else if (type === "link") {
      newNode = { id, type: "link", x, y, width: 300, height: 140, url: (extra.url as string) || "https://jsoncanvas.org", ...extra };
    } else {
      newNode = { id, type: "group", x, y, width: 600, height: 400, label: "New Group", ...extra };
    }

    commitCanvasChange((prev) => ({
      ...prev,
      nodes: [...prev.nodes, newNode],
    }));
    setSelectedNodeIds(new Set([id]));
  };

  /**
   * Creates a new note in the vault and places it on the canvas. A bare name goes next to the
   * canvas file; a name with a "/" is a vault path. Throws (with a readable message) on failure.
   */
  const handleCreateNote = async (name: string) => {
    let relPath = name.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!relPath) throw new Error("Enter a note name.");
    if (!/\.md$/i.test(relPath)) relPath += ".md";
    if (!relPath.includes("/")) {
      const canvasDir = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
      if (canvasDir) relPath = `${canvasDir}/${relPath}`;
    }
    if (vaultFilePaths.has(relPath)) {
      throw new Error(`"${relPath}" already exists. Pick it from the list to add it.`);
    }
    await NoeticBridge.createFile(vaultPath, relPath);
    if (onRefreshFiles) await onRefreshFiles();
    addNodeAtPosition("file", addNoteTargetWorldPos.current, { file: relPath });
  };

  const handleDoubleClickCanvas = (e: React.MouseEvent) => {
    // Only double-click on empty canvas
    const target = e.target as HTMLElement;
    if (target !== containerRef.current && !target.classList.contains("canvas-board-bg")) {
      return;
    }
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const worldPt = screenToWorld(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      viewport
    );
    addNodeAtPosition("text", worldPt);
  };

  // Drag and drop from file tree sidebar
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (!containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const worldPt = screenToWorld(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      viewport
    );

    // If an image file is dragged and dropped from OS/desktop
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
      if (file) {
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const relPath = `assets/${safeName}`;
        file.arrayBuffer().then((buf) => {
          const reader = new FileReader();
          reader.onload = async (ev) => {
            const base64 = ev.target?.result as string;
            await NoeticBridge.saveImageFile(vaultPath, relPath, base64, new Uint8Array(buf));
            if (onRefreshFiles) await onRefreshFiles();
            addNodeAtPosition("file", worldPt, { file: relPath, width: 360, height: 260 });
          };
          reader.readAsDataURL(file);
        });
        return;
      }
    }

    const droppedPath = e.dataTransfer.getData("text/plain");
    if (!droppedPath) return;

    const ext = droppedPath.split(".").pop()?.toLowerCase() || "";
    const isImg = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"].includes(ext);

    addNodeAtPosition("file", worldPt, {
      file: droppedPath,
      ...(isImg ? { width: 360, height: 260 } : {}),
    });
  };

  // --------------------------------------------------------------------------
  // Selection Operations (Duplicate, Delete, Z-Order, Colors)
  // --------------------------------------------------------------------------
  const handleDeleteSelected = () => {
    if (selectedEdgeId) {
      commitCanvasChange((prev) => ({
        ...prev,
        edges: prev.edges.filter((ed) => ed.id !== selectedEdgeId),
      }));
      setSelectedEdgeId(null);
      return;
    }

    if (selectedNodeIds.size === 0) return;

    commitCanvasChange((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((n) => !selectedNodeIds.has(n.id)),
      // Remove attached edges
      edges: prev.edges.filter(
        (ed) => !selectedNodeIds.has(ed.fromNode) && !selectedNodeIds.has(ed.toNode)
      ),
    }));
    setSelectedNodeIds(new Set());
  };

  const handleDuplicateSelected = () => {
    if (selectedNodeIds.size === 0) return;

    const newNodes: CanvasNode[] = [];
    const newSelectedIds = new Set<string>();

    canvasData.nodes.forEach((n) => {
      if (selectedNodeIds.has(n.id)) {
        const newId = `node_${Math.random().toString(36).slice(2, 10)}`;
        newSelectedIds.add(newId);
        newNodes.push({
          ...n,
          id: newId,
          x: n.x + 40,
          y: n.y + 40,
        });
      }
    });

    commitCanvasChange((prev) => ({
      ...prev,
      nodes: [...prev.nodes, ...newNodes],
    }));
    setSelectedNodeIds(newSelectedIds);
  };

  const handleBringToFront = () => {
    if (selectedNodeIds.size === 0) return;
    commitCanvasChange((prev) => {
      const selected = prev.nodes.filter((n) => selectedNodeIds.has(n.id));
      const unselected = prev.nodes.filter((n) => !selectedNodeIds.has(n.id));
      return {
        ...prev,
        nodes: [...unselected, ...selected],
      };
    });
  };

  const handleSendToBack = () => {
    if (selectedNodeIds.size === 0) return;
    commitCanvasChange((prev) => {
      const selected = prev.nodes.filter((n) => selectedNodeIds.has(n.id));
      const unselected = prev.nodes.filter((n) => !selectedNodeIds.has(n.id));
      return {
        ...prev,
        nodes: [...selected, ...unselected],
      };
    });
  };

  const handleChangeSelectedColor = (color?: CanvasColor) => {
    if (selectedEdgeId) {
      commitCanvasChange((prev) => ({
        ...prev,
        edges: prev.edges.map((ed) => (ed.id === selectedEdgeId ? { ...ed, color } : ed)),
      }));
      return;
    }

    if (selectedNodeIds.size === 0) return;
    commitCanvasChange((prev) => ({
      ...prev,
      nodes: prev.nodes.map((n) => (selectedNodeIds.has(n.id) ? { ...n, color } : n)),
    }));
  };

  // Zoom to selection
  const handleZoomToSelection = () => {
    const selectedNodes = canvasData.nodes.filter((n) => selectedNodeIds.has(n.id));
    if (selectedNodes.length === 0 || !containerRef.current) return;
    const fit = getZoomToFitViewport(
      selectedNodes,
      containerRef.current.clientWidth,
      containerRef.current.clientHeight,
      120
    );
    setViewport(fit);
  };

  // Zoom to fit all
  const handleZoomToFitAll = () => {
    if (canvasData.nodes.length === 0 || !containerRef.current) {
      setViewport({ panX: 0, panY: 0, zoom: 1 });
      return;
    }
    const fit = getZoomToFitViewport(
      canvasData.nodes,
      containerRef.current.clientWidth,
      containerRef.current.clientHeight,
      80
    );
    setViewport(fit);
  };

  // --------------------------------------------------------------------------
  // Context Menu Handlers
  // --------------------------------------------------------------------------
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if ((e.target as Element).closest?.("[data-canvas-ui]")) return;
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const screenX = e.clientX;
    const screenY = e.clientY;

    const worldPt = screenToWorld(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      viewport
    );

    // Check if clicked over a node
    const clickedNode = canvasData.nodes.find((n) => isPointInRect(worldPt, n));
    if (clickedNode) {
      if (!selectedNodeIds.has(clickedNode.id)) {
        setSelectedNodeIds(new Set([clickedNode.id]));
      }
      setContextMenu({
        x: screenX,
        y: screenY,
        targetType: "node",
        targetNodeId: clickedNode.id,
      });
    } else {
      addNoteTargetWorldPos.current = worldPt;
      setContextMenu({
        x: screenX,
        y: screenY,
        targetType: "canvas",
      });
    }
  };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onMouseDown={handleCanvasMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onDoubleClick={handleDoubleClickCanvas}
      onContextMenu={handleContextMenu}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={`relative w-full h-full overflow-hidden bg-[#0d1117] select-none touch-none ${
        isSpacePressed || isPanning || isDraggingNodes ? "cursor-grab active:cursor-grabbing" : "cursor-default"
      }`}
    >
      {/* Dynamic Infinite Dot Grid Background */}
      <div
        className="canvas-board-bg absolute inset-0 pointer-events-none"
        style={{
          backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
          backgroundSize: `${32 * viewport.zoom}px ${32 * viewport.zoom}px`,
          backgroundImage: `radial-gradient(circle, rgba(148, 163, 184, ${Math.min(
            0.25,
            0.1 + viewport.zoom * 0.05
          )}) 1.2px, transparent 1.2px)`,
        }}
      />

      {/* Top-Left Header Breadcrumbs */}
      <div data-canvas-ui className="canvas-titlebar absolute top-4 left-5 z-40 max-w-[calc(100%-2.5rem)] lg:max-w-[calc(100%-22rem)] flex items-center gap-2 p-1.5 bg-[#161b22]/90 border border-[#30363d] backdrop-blur-md rounded-xl shadow-xl text-xs select-none">
        {onClose && (
          <button
            onClick={onClose}
            title="Return to Dashboard"
            className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-[#21262d] text-zinc-400 hover:text-white transition-colors cursor-pointer font-medium"
          >
            <LayoutDashboard className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Dashboard</span>
          </button>
        )}
        <div className="w-px h-4 bg-[#30363d]" />
        <div className="flex items-center gap-1.5 px-2 text-zinc-200 font-medium">
          <LayoutGrid className="w-3.5 h-3.5 text-purple-400" />
          <span className="truncate max-w-48 font-mono text-[11px]">{filePath.split("/").pop()}</span>
        </div>
        <span className="text-[10px] text-zinc-500 font-mono pr-2">
          {canvasData.nodes.length} nodes · {canvasData.edges.length} edges
        </span>
      </div>

      {/* Main Transformed World Container */}
      <div
        id="canvas-world-container"
        className="absolute inset-0 origin-top-left will-change-transform"
        style={{
          transform: `translate3d(${viewport.panX}px, ${viewport.panY}px, 0) scale(${viewport.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        {/* SVG Edge Layer (behind nodes) */}
        <CanvasEdgeLayer
          edges={canvasData.edges}
          nodesMap={nodesMap}
          selectedEdgeId={selectedEdgeId}
          draftEdge={draftEdge}
          onSelectEdge={(_e, edgeId) => {
            setSelectedEdgeId(edgeId);
            setSelectedNodeIds(new Set());
          }}
          onDeleteEdge={(edgeId) => {
            commitCanvasChange((prev) => ({
              ...prev,
              edges: prev.edges.filter((ed) => ed.id !== edgeId),
            }));
            setSelectedEdgeId(null);
          }}
          onUpdateEdgeLabel={(edgeId, label) => {
            commitCanvasChange((prev) => ({
              ...prev,
              edges: prev.edges.map((ed) => (ed.id === edgeId ? { ...ed, label } : ed)),
            }));
          }}
          onUpdateEdgeColor={(edgeId, color) => {
            commitCanvasChange((prev) => ({
              ...prev,
              edges: prev.edges.map((ed) => (ed.id === edgeId ? { ...ed, color } : ed)),
            }));
          }}
        />

        {/* DOM Nodes */}
        {canvasData.nodes.map((node, index) => {
          // Virtualization / Culling check for large canvases (500+ nodes)
          const isVisible = isNodeInViewport(
            node,
            viewport,
            viewportSize.width,
            viewportSize.height,
            250
          );
          if (!isVisible) {
            // Render placeholder lightweight box off-screen to preserve memory & 60fps
            return (
              <div
                key={node.id}
                style={{
                  transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
                  width: `${node.width}px`,
                  height: `${node.height}px`,
                }}
                className="absolute pointer-events-none"
              />
            );
          }

          const isGroup = node.type === "group";
          // Groups render behind standard cards
          const zIndex = isGroup ? 1 + index : 10 + index;

          return (
            <CanvasNodeItem
              key={node.id}
              node={node}
              isSelected={selectedNodeIds.has(node.id)}
              isGroup={isGroup}
              zIndex={zIndex}
              vaultPath={vaultPath}
              isMissing={
                node.type === "file" &&
                vaultFilePaths.size > 0 &&
                /\.md$/i.test(node.file) &&
                !vaultFilePaths.has(node.file)
              }
              touchMode={touchMode}
              onSelect={handleSelectNode}
              onStartDrag={handleStartDragNode}
              onStartResize={handleStartResize}
              onStartEdgeConnect={handleStartEdgeConnect}
              onUpdateNode={(updated) => {
                commitCanvasChange((prev) => ({
                  ...prev,
                  nodes: prev.nodes.map((n) => (n.id === updated.id ? updated : n)),
                }));
              }}
              onOpenFile={onOpenFile}
              onPreviewImage={onPreviewImage}
            />
          );
        })}

        {/* Marquee Drag Box */}
        {marquee && (
          <div
            style={{
              left: `${Math.min(marquee.startWorld.x, marquee.currentWorld.x)}px`,
              top: `${Math.min(marquee.startWorld.y, marquee.currentWorld.y)}px`,
              width: `${Math.abs(marquee.currentWorld.x - marquee.startWorld.x)}px`,
              height: `${Math.abs(marquee.currentWorld.y - marquee.startWorld.y)}px`,
            }}
            className="absolute border border-sky-400 bg-sky-500/10 pointer-events-none z-50 rounded"
          />
        )}
      </div>

      {/* Floating Toolbar & Action Bar */}
      <CanvasToolbar
        zoom={viewport.zoom}
        snapGrid={snapGrid}
        canUndo={canUndo}
        canRedo={canRedo}
        selectedCount={selectedNodeIds.size}
        selectedColor={
          selectedNodeIds.size === 1
            ? nodesMap.get(Array.from(selectedNodeIds)[0])?.color
            : undefined
        }
        onZoomIn={() =>
          setViewport((prev) =>
            zoomTowardPoint(
              prev,
              { x: viewportSize.width / 2, y: viewportSize.height / 2 },
              prev.zoom * 1.2
            )
          )
        }
        onZoomOut={() =>
          setViewport((prev) =>
            zoomTowardPoint(
              prev,
              { x: viewportSize.width / 2, y: viewportSize.height / 2 },
              prev.zoom / 1.2
            )
          )
        }
        onResetZoom={() =>
          setViewport((prev) =>
            zoomTowardPoint(
              prev,
              { x: viewportSize.width / 2, y: viewportSize.height / 2 },
              1.0
            )
          )
        }
        onZoomToFit={handleZoomToFitAll}
        onZoomToSelection={selectedNodeIds.size > 0 ? handleZoomToSelection : undefined}
        onToggleSnapGrid={() => setSnapGrid((prev) => !prev)}
        onUndo={() => {
          const prev = historyRef.current.undo(canvasData);
          if (prev) {
            setCanvasData(prev);
            updateHistoryState();
            onDebouncedSave(filePath, serializeCanvas(prev));
          }
        }}
        onRedo={() => {
          const next = historyRef.current.redo(canvasData);
          if (next) {
            setCanvasData(next);
            updateHistoryState();
            onDebouncedSave(filePath, serializeCanvas(next));
          }
        }}
        onAddTextNode={() => {
          const center = screenToWorld(
            { x: viewportSize.width / 2 - 160, y: viewportSize.height / 2 - 100 },
            viewport
          );
          addNodeAtPosition("text", center);
        }}
        onAddFileNode={() => {
          const center = screenToWorld(
            { x: viewportSize.width / 2 - 160, y: viewportSize.height / 2 - 120 },
            viewport
          );
          addNoteTargetWorldPos.current = center;
          setIsAddNoteModalOpen(true);
        }}
        onAddImageNode={() => {
          const center = screenToWorld(
            { x: viewportSize.width / 2 - 180, y: viewportSize.height / 2 - 130 },
            viewport
          );
          addNoteTargetWorldPos.current = center;
          setIsAddImageModalOpen(true);
        }}
        onAddLinkNode={() => {
          addNoteTargetWorldPos.current = screenToWorld(
            { x: viewportSize.width / 2 - 150, y: viewportSize.height / 2 - 70 },
            viewport
          );
          setIsAddLinkOpen(true);
        }}
        onAddGroupNode={() => {
          const center = screenToWorld(
            { x: viewportSize.width / 2 - 300, y: viewportSize.height / 2 - 200 },
            viewport
          );
          addNodeAtPosition("group", center);
        }}
        onDeleteSelected={handleDeleteSelected}
        onDuplicateSelected={handleDuplicateSelected}
        onBringToFront={handleBringToFront}
        onSendToBack={handleSendToBack}
        onChangeColor={handleChangeSelectedColor}
      />

      {/* Right-Click Context Menu */}
      {contextMenu && (
        <CanvasContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onAddTextNode={() => {
            addNodeAtPosition("text", addNoteTargetWorldPos.current);
          }}
          onAddFileNode={() => {
            setIsAddNoteModalOpen(true);
          }}
          onAddImageNode={() => {
            setIsAddImageModalOpen(true);
          }}
          onAddLinkNode={() => setIsAddLinkOpen(true)}
          onAddGroupNode={() => {
            addNodeAtPosition("group", addNoteTargetWorldPos.current);
          }}
          onDuplicateNode={handleDuplicateSelected}
          onBringToFront={handleBringToFront}
          onSendToBack={handleSendToBack}
          onDeleteNode={handleDeleteSelected}
          onChangeColor={handleChangeSelectedColor}
        />
      )}

      {/* Add Note from Vault Modal */}
      <CanvasAddNoteModal
        isOpen={isAddNoteModalOpen}
        files={vaultFiles}
        onClose={() => setIsAddNoteModalOpen(false)}
        onSelectNote={(notePath) => {
          addNodeAtPosition("file", addNoteTargetWorldPos.current, { file: notePath });
        }}
        onCreateNote={handleCreateNote}
      />

      {/* Add Image Modal */}
      <InsertImageModal
        isOpen={isAddImageModalOpen}
        vaultPath={vaultPath}
        vaultFiles={vaultFiles}
        onClose={() => setIsAddImageModalOpen(false)}
        onInsertImage={(imagePathOrUrl) => {
          addNodeAtPosition("file", addNoteTargetWorldPos.current, {
            file: imagePathOrUrl,
            width: 360,
            height: 260,
          });
        }}
        onRefreshFiles={onRefreshFiles}
        title="Add Image to Canvas"
      />
      <PromptDialog
        open={isAddLinkOpen}
        title="Add web link"
        label="URL"
        initialValue="https://"
        placeholder="https://example.com"
        confirmLabel="Add link"
        onSubmit={(url) => {
          setIsAddLinkOpen(false);
          addNodeAtPosition("link", addNoteTargetWorldPos.current, { url });
        }}
        onClose={() => setIsAddLinkOpen(false)}
      />
    </div>
  );
};
