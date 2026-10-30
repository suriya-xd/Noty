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

/**
 * Dynamically calculates the optimal font size (in pixels) for a canvas note node
 * based on its width and height.
 *
 * Scales smoothly and sub-linearly with node dimensions, ensuring that:
 * 1. Default added notes start with a comfortable, clear, readable font size (~16px-17px).
 * 2. As note cards are resized larger, the font size dynamically increases up to a safe cap (36px).
 * 3. As note cards are resized smaller, the font scales down gracefully to a legible floor (11px).
 * 4. Extreme aspect ratios (very wide or very tall) are constrained so text never overflows.
 *
 * @param width Note element width in pixels
 * @param height Note element height in pixels
 * @param customFontSize Optional override font size
 * @returns Font size in pixels (clamped to a safe, readable range)
 */
export function calculateCanvasNodeFontSize(
  width: number,
  height: number,
  customFontSize?: number
): number {
  if (typeof customFontSize === "number" && customFontSize > 0) {
    return Math.round(customFontSize);
  }

  const safeW = Math.max(80, width || 300);
  const safeH = Math.max(50, height || 200);

  // Geometric mean represents the 2D visual area of the node card
  const metric = Math.sqrt(safeW * safeH);

  // Baseline: standard card ~300w x 200h => metric ≈ 245 yields 16px base font size
  // Sub-linear exponent (~0.45) provides natural scaling so text grows with card area
  // without ballooning too quickly.
  const baselineMetric = 245;
  const baselineFontSize = 16;
  const unconstrained = baselineFontSize * Math.pow(metric / baselineMetric, 0.45);

  // Safety bounds for extreme aspect ratios:
  // Account for header bar (~36px); don't exceed what fits vertically in the card
  const maxByHeight = Math.max(11, (safeH - 36) * 0.38);
  // Don't exceed what fits comfortably across narrow widths
  const maxByWidth = Math.max(11, safeW * 0.12);

  const clamped = Math.min(unconstrained, maxByHeight, maxByWidth);

  // Hard clamp between 11px and 36px
  return Math.round(Math.min(36, Math.max(11, clamped)));
}

/**
 * Dynamically calculates the optimal font size (in pixels) for a Canvas Text Card element
 * based on its dimensions (width, height) and content volume.
 *
 * For short text (titles, concepts, mind-map nodes like "# MIND", "# BODY", single words):
 * Scales generously with card size so the text prominently and beautifully fills the card.
 *
 * For medium to long markdown text (bullet lists, paragraphs):
 * Automatically adapts so the content fits comfortably without overflowing.
 *
 * Dynamically re-adjusts in real time as the Text element is resized.
 *
 * @param width Text element width in pixels
 * @param height Text element height in pixels
 * @param text Optional text content for content-volume-aware fitting
 * @param customFontSize Optional override font size
 * @returns Font size in pixels (clamped between 12px and 60px)
 */
export function calculateCanvasTextNodeFontSize(
  width: number,
  height: number,
  text?: string,
  customFontSize?: number
): number {
  if (typeof customFontSize === "number" && customFontSize > 0) {
    return Math.round(customFontSize);
  }

  const safeW = Math.max(80, width || 260);
  const safeH = Math.max(50, height || 160);

  // Available area inside text card (subtracting ~36px header bar and ~24px padding)
  const availW = Math.max(60, safeW - 24);
  const availH = Math.max(30, safeH - 38);
  const visualMetric = Math.sqrt(availW * availH);

  const cleanText = (text || "").trim();
  const charCount = cleanText.length;
  const lines = cleanText ? cleanText.split("\n").filter((l) => l.trim().length > 0) : [];
  const lineCount = Math.max(1, lines.length);

  // 1. Empty state
  if (charCount === 0) {
    const size = 16 * Math.pow(visualMetric / 180, 0.45);
    return Math.round(Math.min(24, Math.max(12, size)));
  }

  // 2. Short titles, single words, concepts (e.g. "# MIND", "# BODY", "# SOUL", "Overview")
  if (charCount <= 30 && lineCount <= 2) {
    const maxLineLen = Math.max(...lines.map((l) => l.replace(/^#+\s*/, "").length), 1);
    const widthFit = (availW * 0.82) / Math.max(maxLineLen * 0.6, 2.5);
    const heightFit = (availH * 0.45) / lineCount;
    const dimensionFit = 24 * Math.pow(visualMetric / 180, 0.62);

    const calculated = Math.min(widthFit, heightFit, dimensionFit);
    return Math.round(Math.min(56, Math.max(14, calculated)));
  }

  // 3. Medium text (short notes, 2-4 lines)
  if (charCount <= 100 && lineCount <= 4) {
    const maxLineLen = Math.max(...lines.map((l) => l.length), 1);
    const widthFit = (availW * 0.85) / Math.max(maxLineLen * 0.55, 5);
    const heightFit = (availH * 0.72) / (lineCount * 1.35);
    const dimensionFit = 20 * Math.pow(visualMetric / 180, 0.52);

    const calculated = Math.min(widthFit, heightFit, dimensionFit);
    return Math.round(Math.min(42, Math.max(13, calculated)));
  }

  // 4. Longer markdown content (paragraphs, lists)
  const dimensionFit = 16 * Math.pow(visualMetric / 180, 0.45);
  const estLines = Math.max(lineCount, Math.ceil(charCount / Math.max(10, availW / 9)));
  const heightFit = (availH * 0.85) / Math.max(1, estLines * 1.3);

  const calculated = Math.min(dimensionFit, Math.max(11, heightFit));
  return Math.round(Math.min(32, Math.max(11, calculated)));
}


