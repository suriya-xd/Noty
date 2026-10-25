import { CanvasNode, CanvasSide, Point, Rect, ViewportState } from "../../types/canvas";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4.0;
export const DEFAULT_GRID_SIZE = 16;

/**
 * Screen coordinates to World coordinates
 */
export function screenToWorld(screenPoint: Point, viewport: ViewportState): Point {
  return {
    x: (screenPoint.x - viewport.panX) / viewport.zoom,
    y: (screenPoint.y - viewport.panY) / viewport.zoom,
  };
}

/**
 * World coordinates to Screen coordinates
 */
export function worldToScreen(worldPoint: Point, viewport: ViewportState): Point {
  return {
    x: worldPoint.x * viewport.zoom + viewport.panX,
    y: worldPoint.y * viewport.zoom + viewport.panY,
  };
}

/**
 * Clamps zoom value between MIN_ZOOM and MAX_ZOOM
 */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * Computes new viewport when zooming toward a screen point (e.g. cursor location)
 */
export function zoomTowardPoint(
  currentViewport: ViewportState,
  screenPoint: Point,
  nextZoom: number
): ViewportState {
  const targetZoom = clampZoom(nextZoom);
  if (targetZoom === currentViewport.zoom) return currentViewport;

  // World coordinate currently under screenPoint
  const worldUnderCursor = screenToWorld(screenPoint, currentViewport);

  // New pan preserves the same world coordinate under the cursor
  const panX = screenPoint.x - worldUnderCursor.x * targetZoom;
  const panY = screenPoint.y - worldUnderCursor.y * targetZoom;

  return {
    panX,
    panY,
    zoom: targetZoom,
  };
}

/**
 * Snap a coordinate or dimension to the grid
 */
export function snapToGrid(value: number, gridSize = DEFAULT_GRID_SIZE): number {
  return Math.round(value / gridSize) * gridSize;
}

/**
 * Calculates connection anchor point on a node's side
 */
export function getNodeSidePoint(
  node: { x: number; y: number; width: number; height: number },
  side: CanvasSide
): Point {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

/**
 * Automatically determine best connection sides between two nodes if not specified
 */
export function getAutoSides(
  fromNode: { x: number; y: number; width: number; height: number },
  toNode: { x: number; y: number; width: number; height: number }
): { fromSide: CanvasSide; toSide: CanvasSide } {
  const fromCenter = { x: fromNode.x + fromNode.width / 2, y: fromNode.y + fromNode.height / 2 };
  const toCenter = { x: toNode.x + toNode.width / 2, y: toNode.y + toNode.height / 2 };

  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx > 0
      ? { fromSide: "right", toSide: "left" }
      : { fromSide: "left", toSide: "right" };
  } else {
    return dy > 0
      ? { fromSide: "bottom", toSide: "top" }
      : { fromSide: "top", toSide: "bottom" };
  }
}

export interface BezierCurve {
  start: Point;
  c1: Point;
  c2: Point;
  end: Point;
  midpoint: Point;
  pathString: string;
}

/**
 * Computes cubic Bezier control points and SVG path string perpendicular to the node sides
 */
export function computeBezierPath(
  start: Point,
  fromSide: CanvasSide,
  end: Point,
  toSide: CanvasSide
): BezierCurve {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);

  // Dynamic curve tension based on distance
  const curvature = Math.max(30, Math.min(220, distance * 0.45));

  const getSideOffset = (side: CanvasSide, len: number): Point => {
    switch (side) {
      case "top":
        return { x: 0, y: -len };
      case "bottom":
        return { x: 0, y: len };
      case "left":
        return { x: -len, y: 0 };
      case "right":
        return { x: len, y: 0 };
    }
  };

  const off1 = getSideOffset(fromSide, curvature);
  const off2 = getSideOffset(toSide, curvature);

  const c1: Point = { x: start.x + off1.x, y: start.y + off1.y };
  const c2: Point = { x: end.x + off2.x, y: end.y + off2.y };

  // Exact midpoint of cubic Bezier at t = 0.5:
  // B(0.5) = 0.125 * start + 0.375 * c1 + 0.375 * c2 + 0.125 * end
  const midpoint: Point = {
    x: 0.125 * start.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * end.x,
    y: 0.125 * start.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * end.y,
  };

  const pathString = `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`;

  return {
    start,
    c1,
    c2,
    end,
    midpoint,
    pathString,
  };
}

/**
 * Evaluates a point on cubic Bezier at parameter t in [0, 1]
 */
export function evaluateBezier(curve: BezierCurve, t: number): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: mt3 * curve.start.x + 3 * mt2 * t * curve.c1.x + 3 * mt * t2 * curve.c2.x + t3 * curve.end.x,
    y: mt3 * curve.start.y + 3 * mt2 * t * curve.c1.y + 3 * mt * t2 * curve.c2.y + t3 * curve.end.y,
  };
}

/**
 * Calculates approximate minimum distance from point to a Bezier curve for hit-testing
 */
export function distanceToCurve(point: Point, curve: BezierCurve, samples = 20): number {
  let minDistance = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const pt = evaluateBezier(curve, t);
    const dist = Math.hypot(point.x - pt.x, point.y - pt.y);
    if (dist < minDistance) {
      minDistance = dist;
    }
  }
  return minDistance;
}

/**
 * Calculates bounding box of all nodes
 */
export function getBoundingBox(nodes: CanvasNode[]): Rect | null {
  if (nodes.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + n.width > maxX) maxX = n.x + n.width;
    if (n.y + n.height > maxY) maxY = n.y + n.height;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Computes viewport required to fit all nodes
 */
export function getZoomToFitViewport(
  nodes: CanvasNode[],
  viewportWidth: number,
  viewportHeight: number,
  padding = 80
): ViewportState {
  const box = getBoundingBox(nodes);
  if (!box || viewportWidth <= 0 || viewportHeight <= 0) {
    return { panX: 0, panY: 0, zoom: 1 };
  }

  const availableWidth = Math.max(100, viewportWidth - padding * 2);
  const availableHeight = Math.max(100, viewportHeight - padding * 2);

  const zoomX = availableWidth / Math.max(50, box.width);
  const zoomY = availableHeight / Math.max(50, box.height);

  const targetZoom = clampZoom(Math.min(zoomX, zoomY, 1.5));

  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;

  const panX = viewportWidth / 2 - centerX * targetZoom;
  const panY = viewportHeight / 2 - centerY * targetZoom;

  return {
    panX,
    panY,
    zoom: targetZoom,
  };
}

/**
 * Fast AABB test to check if a world node is visible within the screen viewport (for node culling)
 */
export function isNodeInViewport(
  node: { x: number; y: number; width: number; height: number },
  viewport: ViewportState,
  screenWidth: number,
  screenHeight: number,
  margin = 150
): boolean {
  // Convert screen viewport to world bounds with extra margin
  const topLeft = screenToWorld({ x: -margin, y: -margin }, viewport);
  const bottomRight = screenToWorld({ x: screenWidth + margin, y: screenHeight + margin }, viewport);

  return (
    node.x + node.width >= topLeft.x &&
    node.x <= bottomRight.x &&
    node.y + node.height >= topLeft.y &&
    node.y <= bottomRight.y
  );
}

/**
 * Checks if point is inside a rectangle
 */
export function isPointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * Checks if inner rectangle is spatially contained within group rectangle
 */
export function isNodeInsideGroup(node: Rect, group: Rect): boolean {
  return (
    node.x >= group.x &&
    node.y >= group.y &&
    node.x + node.width <= group.x + group.width &&
    node.y + node.height <= group.y + group.height
  );
}
