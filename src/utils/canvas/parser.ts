import {
  CanvasColor,
  CanvasData,
  CanvasEdge,
  CanvasNode,
  CanvasPresetColor,
} from "../../types/canvas";

export const PRESET_COLOR_MAP: Record<CanvasPresetColor, { hex: string; name: string; bg: string; border: string }> = {
  "1": { hex: "#ef4444", name: "Red", bg: "rgba(239, 68, 68, 0.15)", border: "rgba(239, 68, 68, 0.8)" },
  "2": { hex: "#f97316", name: "Orange", bg: "rgba(249, 115, 22, 0.15)", border: "rgba(249, 115, 22, 0.8)" },
  "3": { hex: "#eab308", name: "Yellow", bg: "rgba(234, 179, 8, 0.15)", border: "rgba(234, 179, 8, 0.8)" },
  "4": { hex: "#10b981", name: "Green", bg: "rgba(16, 185, 129, 0.15)", border: "rgba(16, 185, 129, 0.8)" },
  "5": { hex: "#06b6d4", name: "Cyan", bg: "rgba(6, 182, 212, 0.15)", border: "rgba(6, 182, 212, 0.8)" },
  "6": { hex: "#a855f7", name: "Purple", bg: "rgba(168, 85, 247, 0.15)", border: "rgba(168, 85, 247, 0.8)" },
};

/**
 * Resolves a canvas color (preset "1"-"6" or hex string) to an actual hex color.
 */
export function resolveCanvasColor(color?: CanvasColor): string | undefined {
  if (!color) return undefined;
  if (color in PRESET_COLOR_MAP) {
    return PRESET_COLOR_MAP[color as CanvasPresetColor].hex;
  }
  return color;
}

/**
 * Resolves background tint and border color for a given node or edge color.
 */
export function getCanvasColorStyles(color?: CanvasColor): { bg: string; border: string; text: string } {
  if (!color) {
    return {
      bg: "bg-[#161b22]",
      border: "border-[#30363d]",
      text: "text-zinc-200",
    };
  }
  if (color in PRESET_COLOR_MAP) {
    const preset = PRESET_COLOR_MAP[color as CanvasPresetColor];
    return {
      bg: preset.bg,
      border: preset.border,
      text: preset.hex,
    };
  }
  // Hex color
  return {
    bg: `${color}18`, // ~10% opacity
    border: color,
    text: color,
  };
}

/**
 * Parses and validates raw JSON Canvas 1.0 string, preserving unknown fields.
 */
export function parseCanvas(raw: string): CanvasData {
  if (!raw || !raw.trim()) {
    return { nodes: [], edges: [] };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error("Failed to parse canvas JSON:", err);
    return { nodes: [], edges: [] };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { nodes: [], edges: [] };
  }

  // Preserve all unknown root properties
  const rootResult: CanvasData = {
    ...parsed,
    nodes: [],
    edges: [],
  };

  // Parse & validate nodes
  if (Array.isArray(parsed.nodes)) {
    const validatedNodes: CanvasNode[] = [];
    for (const item of parsed.nodes) {
      if (typeof item !== "object" || item === null) continue;
      const rawNode = item as Record<string, unknown>;

      const id = typeof rawNode.id === "string" && rawNode.id.trim()
        ? rawNode.id.trim()
        : `node_${Math.random().toString(36).slice(2, 10)}`;

      const type = (rawNode.type === "file" || rawNode.type === "link" || rawNode.type === "group")
        ? rawNode.type
        : "text";

      const x = typeof rawNode.x === "number" && !isNaN(rawNode.x) ? rawNode.x : 0;
      const y = typeof rawNode.y === "number" && !isNaN(rawNode.y) ? rawNode.y : 0;
      const width = typeof rawNode.width === "number" && rawNode.width > 0 ? rawNode.width : 250;
      const height = typeof rawNode.height === "number" && rawNode.height > 0 ? rawNode.height : 160;

      const nodeBase = {
        ...rawNode,
        id,
        type,
        x,
        y,
        width,
        height,
      };

      if (type === "text") {
        validatedNodes.push({
          ...nodeBase,
          type: "text",
          text: typeof rawNode.text === "string" ? rawNode.text : "",
        });
      } else if (type === "file") {
        validatedNodes.push({
          ...nodeBase,
          type: "file",
          file: typeof rawNode.file === "string" ? rawNode.file : "",
          subpath: typeof rawNode.subpath === "string" ? rawNode.subpath : undefined,
        });
      } else if (type === "link") {
        validatedNodes.push({
          ...nodeBase,
          type: "link",
          url: typeof rawNode.url === "string" ? rawNode.url : "",
        });
      } else if (type === "group") {
        validatedNodes.push({
          ...nodeBase,
          type: "group",
          label: typeof rawNode.label === "string" ? rawNode.label : undefined,
          background: typeof rawNode.background === "string" ? rawNode.background : undefined,
          backgroundStyle: (rawNode.backgroundStyle === "ratio" || rawNode.backgroundStyle === "repeat")
            ? rawNode.backgroundStyle
            : "cover",
        });
      }
    }
    rootResult.nodes = validatedNodes;
  }

  // Parse & validate edges
  if (Array.isArray(parsed.edges)) {
    const validatedEdges: CanvasEdge[] = [];
    for (const item of parsed.edges) {
      if (typeof item !== "object" || item === null) continue;
      const rawEdge = item as Record<string, unknown>;

      const id = typeof rawEdge.id === "string" && rawEdge.id.trim()
        ? rawEdge.id.trim()
        : `edge_${Math.random().toString(36).slice(2, 10)}`;

      const fromNode = typeof rawEdge.fromNode === "string" ? rawEdge.fromNode : "";
      const toNode = typeof rawEdge.toNode === "string" ? rawEdge.toNode : "";

      if (!fromNode || !toNode) continue;

      const validSides = new Set(["top", "right", "bottom", "left"]);
      const fromSide = (typeof rawEdge.fromSide === "string" && validSides.has(rawEdge.fromSide))
        ? (rawEdge.fromSide as CanvasEdge["fromSide"])
        : undefined;

      const toSide = (typeof rawEdge.toSide === "string" && validSides.has(rawEdge.toSide))
        ? (rawEdge.toSide as CanvasEdge["toSide"])
        : undefined;

      const fromEnd = (rawEdge.fromEnd === "arrow" || rawEdge.fromEnd === "none")
        ? rawEdge.fromEnd
        : undefined;

      const toEnd = (rawEdge.toEnd === "arrow" || rawEdge.toEnd === "none")
        ? rawEdge.toEnd
        : "arrow";

      validatedEdges.push({
        ...rawEdge,
        id,
        fromNode,
        fromSide,
        fromEnd,
        toNode,
        toSide,
        toEnd,
        label: typeof rawEdge.label === "string" ? rawEdge.label : undefined,
      });
    }
    rootResult.edges = validatedEdges;
  }

  return rootResult;
}

/**
 * Serializes CanvasData into JSON Canvas 1.0 JSON string.
 */
export function serializeCanvas(data: CanvasData): string {
  return JSON.stringify(data, null, 2);
}
