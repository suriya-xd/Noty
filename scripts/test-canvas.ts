import {
  parseCanvas,
  serializeCanvas,
  resolveCanvasColor,
  getCanvasColorStyles,
} from "../src/utils/canvas/parser";
import {
  screenToWorld,
  worldToScreen,
  clampZoom,
  zoomTowardPoint,
  getNodeSidePoint,
  getAutoSides,
  computeBezierPath,
  evaluateBezier,
  distanceToCurve,
  getBoundingBox,
  getZoomToFitViewport,
  isNodeInsideGroup,
  isNodeInViewport,
  calculateCanvasNodeFontSize,
  calculateCanvasTextNodeFontSize,
} from "../src/utils/canvas/math";

async function runCanvasTests() {
  console.log("\n==========================================");
  console.log("   JSON Canvas 1.0 Specification Tests    ");
  console.log("==========================================\n");

  // 1. JSON Canvas 1.0 Round-Trip & Unknown Field Preservation
  console.log("[1/6] Testing JSON Canvas Parsing & Round-trip Serialization...");
  const rawCanvasSample = JSON.stringify({
    version: "1.0",
    customCanvasMeta: { author: "ObsidianUser", tags: ["architecture", "flow"] },
    nodes: [
      {
        id: "text-1",
        type: "text",
        x: 100,
        y: 150,
        width: 300,
        height: 200,
        color: "1",
        text: "## Welcome to Canvas\nThis is **Markdown**.",
        customNodeProp: "preserved_property_1",
      },
      {
        id: "file-1",
        type: "file",
        file: "Welcome.md",
        subpath: "# Overview",
        x: 500,
        y: 150,
        width: 320,
        height: 240,
        color: "#10b981",
        customFileProp: 12345,
      },
      {
        id: "link-1",
        type: "link",
        url: "https://jsoncanvas.org",
        x: 900,
        y: 150,
        width: 280,
        height: 140,
      },
      {
        id: "group-1",
        type: "group",
        label: "Backend Services",
        background: "bg.jpg",
        backgroundStyle: "cover",
        x: 50,
        y: 50,
        width: 1200,
        height: 500,
      },
    ],
    edges: [
      {
        id: "edge-1",
        fromNode: "text-1",
        fromSide: "right",
        toNode: "file-1",
        toSide: "left",
        fromEnd: "none",
        toEnd: "arrow",
        color: "2",
        label: "references",
        customEdgeMeta: true,
      },
    ],
  });

  const parsed = parseCanvas(rawCanvasSample);
  if (parsed.nodes.length !== 4) throw new Error(`Expected 4 nodes, got ${parsed.nodes.length}`);
  if (parsed.edges.length !== 1) throw new Error(`Expected 1 edge, got ${parsed.edges.length}`);
  if (parsed.customCanvasMeta === undefined) throw new Error("Root unknown field was lost");
  if (parsed.nodes[0].customNodeProp !== "preserved_property_1") throw new Error("Node unknown field was lost");
  if (parsed.edges[0].customEdgeMeta !== true) throw new Error("Edge unknown field was lost");

  const serialized = serializeCanvas(parsed);
  const parsedAgain = parseCanvas(serialized);
  if (parsedAgain.nodes.length !== 4 || parsedAgain.edges.length !== 1) {
    throw new Error("Serialization round-trip lost nodes or edges");
  }
  if (parsedAgain.nodes[0].customNodeProp !== "preserved_property_1") {
    throw new Error("Serialization round-trip lost custom node property");
  }
  console.log("  ✓ Parser and round-trip successfully preserved all spec and unknown fields.");

  // 2. Preset & Hex Colors
  console.log("\n[2/6] Testing Color Resolution & Palettes...");
  if (resolveCanvasColor("1") !== "#ef4444") throw new Error("Preset 1 should resolve to #ef4444");
  if (resolveCanvasColor("4") !== "#10b981") throw new Error("Preset 4 should resolve to #10b981");
  if (resolveCanvasColor("#ff00ff") !== "#ff00ff") throw new Error("Custom hex color should be preserved");
  const styles = getCanvasColorStyles("6");
  if (!styles.bg || !styles.border) throw new Error("Color styles generation failed");
  console.log("  ✓ Preset and custom hex colors resolved accurately.");

  // 3. Screen <-> World Coordinate Transformations
  console.log("\n[3/6] Testing Viewport Transformations...");
  const viewport = { panX: 200, panY: 100, zoom: 2.0 };
  const screenP = { x: 400, y: 300 };
  const worldP = screenToWorld(screenP, viewport);
  // (400 - 200) / 2 = 100, (300 - 100) / 2 = 100
  if (worldP.x !== 100 || worldP.y !== 100) {
    throw new Error(`Expected world point (100, 100), got (${worldP.x}, ${worldP.y})`);
  }
  const backToScreen = worldToScreen(worldP, viewport);
  if (backToScreen.x !== screenP.x || backToScreen.y !== screenP.y) {
    throw new Error("World to screen round trip mismatch");
  }

  // Zoom toward cursor
  const zoomed = zoomTowardPoint(viewport, { x: 400, y: 300 }, 3.0);
  const worldUnderCursorAfter = screenToWorld({ x: 400, y: 300 }, zoomed);
  if (Math.abs(worldUnderCursorAfter.x - 100) > 0.001 || Math.abs(worldUnderCursorAfter.y - 100) > 0.001) {
    throw new Error("Zoom toward cursor did not keep point under pointer fixed");
  }
  if (clampZoom(0.01) !== 0.1 || clampZoom(10) !== 4.0) {
    throw new Error("Zoom clamping failed");
  }
  console.log("  ✓ Coordinate transforms, zoom-to-cursor, and clamping validated.");

  // 4. Node Sides, Anchors & Auto Connection
  console.log("\n[4/6] Testing Side Connection Anchors & Auto Direction...");
  const nodeA = { x: 0, y: 0, width: 200, height: 100 };
  const nodeB = { x: 500, y: 0, width: 200, height: 100 };
  const topAnchor = getNodeSidePoint(nodeA, "top");
  if (topAnchor.x !== 100 || topAnchor.y !== 0) throw new Error("Top anchor incorrect");
  const rightAnchor = getNodeSidePoint(nodeA, "right");
  if (rightAnchor.x !== 200 || rightAnchor.y !== 50) throw new Error("Right anchor incorrect");
  const autoSides = getAutoSides(nodeA, nodeB);
  if (autoSides.fromSide !== "right" || autoSides.toSide !== "left") {
    throw new Error(`Expected right->left auto sides, got ${autoSides.fromSide}->${autoSides.toSide}`);
  }
  console.log("  ✓ Connection anchors and auto-sides computed accurately.");

  // 5. Cubic Bezier Curves & Hit Testing
  console.log("\n[5/6] Testing Cubic Bezier Path & Distance Hit-testing...");
  const curve = computeBezierPath({ x: 200, y: 50 }, "right", { x: 500, y: 50 }, "left");
  if (!curve.pathString.startsWith("M 200 50 C")) {
    throw new Error("Generated path string malformed");
  }
  // Midpoint should be approximately halfway between (200, 50) and (500, 50) => (350, 50)
  if (Math.abs(curve.midpoint.x - 350) > 1 || Math.abs(curve.midpoint.y - 50) > 1) {
    throw new Error(`Midpoint deviated: (${curve.midpoint.x}, ${curve.midpoint.y})`);
  }
  // Distance from point exactly on midpoint should be close to 0
  const hitDist = distanceToCurve({ x: 350, y: 50 }, curve);
  if (hitDist > 5) throw new Error(`Expected distance near 0, got ${hitDist}`);
  // Distance from far away point should be large
  const farDist = distanceToCurve({ x: 350, y: 500 }, curve);
  if (farDist < 400) throw new Error("Far point distance should be large");
  console.log("  ✓ Cubic Bezier curves, control points, and distance hit testing verified.");

  // 6. Spatial Containment & Bounding Box / Zoom-To-Fit
  console.log("\n[6/6] Testing Spatial Group Containment & Zoom-To-Fit...");
  const groupRect = { x: 50, y: 50, width: 600, height: 400 };
  const insideNode = { x: 100, y: 100, width: 200, height: 100 };
  const outsideNode = { x: 700, y: 100, width: 200, height: 100 };
  if (!isNodeInsideGroup(insideNode, groupRect)) throw new Error("Node should be inside group");
  if (isNodeInsideGroup(outsideNode, groupRect)) throw new Error("Node should NOT be inside group");

  const nodes = [
    { id: "1", type: "text" as const, x: 100, y: 100, width: 200, height: 100, text: "" },
    { id: "2", type: "text" as const, x: 800, y: 500, width: 200, height: 100, text: "" },
  ];
  const bounds = getBoundingBox(nodes);
  if (!bounds || bounds.x !== 100 || bounds.y !== 100 || bounds.width !== 900 || bounds.height !== 500) {
    throw new Error("Bounding box calculation incorrect");
  }
  const fitVp = getZoomToFitViewport(nodes, 1200, 800);
  if (fitVp.zoom <= 0 || isNaN(fitVp.panX) || isNaN(fitVp.panY)) {
    throw new Error("Zoom to fit computed invalid viewport");
  }
  console.log("  ✓ Spatial group calculations and zoom-to-fit verified.");

  // 7. Dynamic Note Font Size Calculation Based on Node Dimensions
  console.log("\n[7/7] Testing Dynamic Note Font Size Calculation...");
  // Test default note creation sizes
  const defaultTextFont = calculateCanvasNodeFontSize(320, 200);
  if (defaultTextFont < 15 || defaultTextFont > 17) {
    throw new Error(`Default text node font size should be comfortable (~16px), got ${defaultTextFont}`);
  }
  const defaultFileFont = calculateCanvasNodeFontSize(340, 260);
  if (defaultFileFont < 16 || defaultFileFont > 18) {
    throw new Error(`Default file node font size should be comfortable (~17px), got ${defaultFileFont}`);
  }

  // Test scaling down for small notes
  const smallFont = calculateCanvasNodeFontSize(160, 100);
  if (smallFont < 11 || smallFont > 13) {
    throw new Error(`Small node font should scale down gracefully, got ${smallFont}`);
  }
  const minFont = calculateCanvasNodeFontSize(50, 40);
  if (minFont !== 11) {
    throw new Error(`Minimum font size should clamp at 11px, got ${minFont}`);
  }

  // Test scaling up for large notes
  const medLargeFont = calculateCanvasNodeFontSize(600, 400);
  const largeFont = calculateCanvasNodeFontSize(1000, 700);
  const extraLargeFont = calculateCanvasNodeFontSize(1600, 1100);

  if (medLargeFont <= defaultTextFont) {
    throw new Error(`Font size must dynamically scale up with size. MedLarge: ${medLargeFont}, Default: ${defaultTextFont}`);
  }
  if (largeFont <= medLargeFont) {
    throw new Error(`Font size must dynamically scale up with size. Large: ${largeFont}, MedLarge: ${medLargeFont}`);
  }
  if (extraLargeFont > 36) {
    throw new Error(`Font size must not exceed maximum clamp (36px), got ${extraLargeFont}`);
  }

  // Test extreme aspect ratios (prevent vertical or horizontal overflow)
  const veryWideThinFont = calculateCanvasNodeFontSize(900, 60);
  if (veryWideThinFont > 15) {
    throw new Error(`Very wide but thin note should be bounded by height, got ${veryWideThinFont}`);
  }
  const veryTallNarrowFont = calculateCanvasNodeFontSize(100, 900);
  if (veryTallNarrowFont > 14) {
    throw new Error(`Very tall but narrow note should be bounded by width, got ${veryTallNarrowFont}`);
  }

  // Test explicit override
  const overrideFont = calculateCanvasNodeFontSize(300, 200, 24);
  if (overrideFont !== 24) {
    throw new Error(`Explicit custom font size should be respected, got ${overrideFont}`);
  }
  console.log(`  ✓ Dynamic font sizing validated: Default=${defaultTextFont}px, Small=${smallFont}px, MedLarge=${medLargeFont}px, Large=${largeFont}px.`);

  // Test Canvas Text Node Dynamic Scaling (Short titles vs medium vs long text)
  const shortTextSmallCard = calculateCanvasTextNodeFontSize(180, 120, "# MIND");
  const shortTextDefaultCard = calculateCanvasTextNodeFontSize(320, 200, "# MIND");
  const shortTextLargeCard = calculateCanvasTextNodeFontSize(600, 400, "# MIND");

  if (shortTextDefaultCard <= shortTextSmallCard) {
    throw new Error(`Text element font size must scale with card dimensions. Default: ${shortTextDefaultCard}, Small: ${shortTextSmallCard}`);
  }
  if (shortTextLargeCard <= shortTextDefaultCard) {
    throw new Error(`Text element font size must scale with card dimensions. Large: ${shortTextLargeCard}, Default: ${shortTextDefaultCard}`);
  }
  if (shortTextLargeCard > 60) {
    throw new Error(`Text element font size should be safely clamped, got ${shortTextLargeCard}`);
  }
  console.log(`  ✓ Text element dynamic scaling validated: SmallCard=${shortTextSmallCard}px, DefaultCard=${shortTextDefaultCard}px, LargeCard=${shortTextLargeCard}px.`);

  console.log("\n>>> ALL CANVAS TESTS PASSED SUCCESSFULLY! <<<\n");
}

runCanvasTests().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
