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
} from "../../utils/canvas/math";
import { LayoutDashboard, LayoutGrid } from "lucide-react";
import { CanvasHistory } from "../../utils/canvas/history";
import { CanvasNodeItem, ResizeHandle } from "./CanvasNodeItem";
import { CanvasEdgeLayer } from "./CanvasEdgeLayer";
import { CanvasToolbar } from "./CanvasToolbar";
import { CanvasContextMenu, ContextMenuState } from "./CanvasContextMenu";
import { CanvasAddNoteModal } from "./CanvasAddNoteModal";
import { InsertImageModal } from "../InsertImageModal";
import { GitVaultBridge } from "../../services/gitVaultBridge";
import { VaultEntry } from "../../types/gitVault";

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
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

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

  // Center or fit on initial load if nodes exist
  const hasInitializedViewport = useRef(false);
  useEffect(() => {
    if (!hasInitializedViewport.current && canvasData.nodes.length > 0 && containerRef.current) {
      const fit = getZoomToFitViewport(
        canvasData.nodes,
        containerRef.current.clientWidth || 1200,
        containerRef.current.clientHeight || 800
      );
      setViewport(fit);
      hasInitializedViewport.current = true;
    }
  }, [canvasData.nodes]);

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
      const { nodeId, handle, initialRect, startWorld } = resizingNode;
      const dx = currentWorld.x - startWorld.x;
      const dy = currentWorld.y - startWorld.y;

      let newX = initialRect.x;
      let newY = initialRect.y;
      let newW = initialRect.width;
      let newH = initialRect.height;

      const minW = 120;
      const minH = 60;

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
      newNode = { id, type: "text", x, y, width: 320, height: 200, text: "# New Note\n\nWrite here...", ...extra };
    } else if (type === "file") {
      newNode = { id, type: "file", x, y, width: 340, height: 260, file: (extra.file as string) || "Welcome.md", ...extra };
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
            await GitVaultBridge.saveImageFile(vaultPath, relPath, base64, new Uint8Array(buf));
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
      className={`relative w-full h-full overflow-hidden bg-[#0d1117] select-none ${
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
      <div className="absolute top-4 left-5 z-40 flex items-center gap-2 p-1.5 bg-[#161b22]/90 border border-[#30363d] backdrop-blur-md rounded-xl shadow-xl text-xs select-none">
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
          const url = prompt("Enter web URL:", "https://");
          if (url && url.trim()) {
            const center = screenToWorld(
              { x: viewportSize.width / 2 - 150, y: viewportSize.height / 2 - 70 },
              viewport
            );
            addNodeAtPosition("link", center, { url: url.trim() });
          }
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
          onAddLinkNode={() => {
            const url = prompt("Enter web URL:", "https://");
            if (url && url.trim()) {
              addNodeAtPosition("link", addNoteTargetWorldPos.current, { url: url.trim() });
            }
          }}
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
    </div>
  );
};
