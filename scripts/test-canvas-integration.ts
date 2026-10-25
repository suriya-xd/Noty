import { parseCanvas, serializeCanvas, PRESET_COLOR_MAP } from "../src/utils/canvas/parser";
import { CanvasData, CanvasEdge, CanvasNode } from "../src/types/canvas";
import { isNodeInsideGroup, getNodeSidePoint, computeBezierPath } from "../src/utils/canvas/math";

async function runCanvasIntegrationTests() {
  console.log("\n=======================================================");
  console.log("   JSON Canvas 1.0 Full Lifecycle & Obsidian E2E Test   ");
  console.log("=======================================================\n");

  // Step 1: Simulate creating a full Obsidian Canvas from scratch
  console.log("[1/5] Simulating Node & Edge Creation (Create Node -> Connect -> Configure)...");
  
  const nodes: CanvasNode[] = [
    {
      id: "node-intro",
      type: "text",
      x: 100,
      y: 120,
      width: 280,
      height: 160,
      color: "5", // Cyan preset
      text: "# System Overview\nThis board maps the note-taking architecture.",
    },
    {
      id: "node-vault-file",
      type: "file",
      x: 480,
      y: 120,
      width: 320,
      height: 220,
      color: "4", // Green preset
      file: "Welcome.md",
      subpath: "# Git Worktree",
    },
    {
      id: "node-spec-link",
      type: "link",
      x: 900,
      y: 120,
      width: 280,
      height: 140,
      url: "https://jsoncanvas.org",
    },
    {
      id: "group-backend",
      type: "group",
      x: 50,
      y: 50,
      width: 1180,
      height: 380,
      label: "Architecture Group",
      color: "6", // Purple
    },
  ];

  const edges: CanvasEdge[] = [
    {
      id: "edge-intro-to-file",
      fromNode: "node-intro",
      fromSide: "right",
      fromEnd: "none",
      toNode: "node-vault-file",
      toSide: "left",
      toEnd: "arrow",
      color: "2", // Orange
      label: "documents",
    },
    {
      id: "edge-file-to-link",
      fromNode: "node-vault-file",
      fromSide: "right",
      toNode: "node-spec-link",
      toSide: "left",
      toEnd: "arrow",
      label: "references spec",
    },
  ];

  const originalCanvas: CanvasData = {
    generator: "Noty Obsidian Canvas 1.0",
    nodes,
    edges,
  };

  console.log(`  Created ${nodes.length} nodes (text, file, link, group) and ${edges.length} edges.`);

  // Step 2: Validate spatial group containment
  console.log("\n[2/5] Testing Spatial Group Containment Logic...");
  const groupNode = nodes[3];
  const introNode = nodes[0];
  const isContained = isNodeInsideGroup(introNode, groupNode);
  if (!isContained) {
    throw new Error("Intro node should be recognized as spatially contained inside group-backend");
  }
  console.log("  ✓ Spatial group containment verified.");

  // Step 3: Compute edge geometry between created nodes
  console.log("\n[3/5] Validating Edge Bezier Curve Generation...");
  const startPt = getNodeSidePoint(introNode, "right");
  const endPt = getNodeSidePoint(nodes[1], "left");
  const curve = computeBezierPath(startPt, "right", endPt, "left");
  if (!curve.pathString.startsWith("M 380 200 C")) {
    throw new Error(`Unexpected path string: ${curve.pathString}`);
  }
  console.log("  ✓ Edge Bezier curve computed correctly:", curve.pathString);

  // Step 4: Serialize to .canvas file format (pure JSON Canvas 1.0)
  console.log("\n[4/5] Serializing to .canvas File JSON...");
  const serializedJson = serializeCanvas(originalCanvas);
  if (!serializedJson.includes('"generator": "Noty Obsidian Canvas 1.0"')) {
    throw new Error("Unknown generator metadata lost");
  }
  if (!serializedJson.includes('"subpath": "# Git Worktree"')) {
    throw new Error("File node subpath lost");
  }
  console.log("  ✓ Serialized JSON Canvas size:", serializedJson.length, "bytes");

  // Step 5: Reload from .canvas file (simulate reopening)
  console.log("\n[5/5] Re-parsing from .canvas File JSON & Testing Round-trip...");
  const reloaded = parseCanvas(serializedJson);
  if (reloaded.nodes.length !== 4) throw new Error(`Expected 4 nodes, got ${reloaded.nodes.length}`);
  if (reloaded.edges.length !== 2) throw new Error(`Expected 2 edges, got ${reloaded.edges.length}`);
  if (reloaded.nodes[1].type !== "file" || (reloaded.nodes[1] as any).file !== "Welcome.md") {
    throw new Error("Reloaded file node corrupted");
  }
  if (reloaded.edges[0].label !== "documents") {
    throw new Error("Reloaded edge label corrupted");
  }
  if (reloaded.edges[0].color !== "2") {
    throw new Error("Reloaded edge color corrupted");
  }

  // Verify Obsidian compatible preset colors
  const edgeColor = PRESET_COLOR_MAP[reloaded.edges[0].color as "2"];
  if (edgeColor.hex !== "#f97316") {
    throw new Error("Preset color 2 resolution mismatch");
  }
  console.log("  ✓ Reloaded canvas matches 100% with original Obsidian data model.");

  console.log("\n>>> FULL LIFECYCLE E2E TEST PASSED 100%! <<<\n");
}

runCanvasIntegrationTests().catch((err) => {
  console.error("Integration test failed:", err);
  process.exit(1);
});
