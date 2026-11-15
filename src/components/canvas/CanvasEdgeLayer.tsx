import React, { useState } from "react";
import type { FC } from "react";
import { CanvasColor, CanvasEdge, CanvasNode, Point } from "../../types/canvas";
import {
  computeBezierPath,
  getAutoSides,
  getNodeSidePoint,
} from "../../utils/canvas/math";
import { PRESET_COLOR_MAP, resolveCanvasColor } from "../../utils/canvas/parser";
import { X, Check } from "lucide-react";
import { stripMarkdownMarkers } from "../../utils/canvas/plainText";

interface CanvasEdgeLayerProps {
  edges: CanvasEdge[];
  nodesMap: Map<string, CanvasNode>;
  selectedEdgeId: string | null;
  draftEdge: {
    fromNodeId: string;
    currentPoint: Point;
  } | null;
  onSelectEdge: (e: React.MouseEvent, edgeId: string) => void;
  onDeleteEdge: (edgeId: string) => void;
  onUpdateEdgeLabel: (edgeId: string, label: string) => void;
  onUpdateEdgeColor: (edgeId: string, color?: CanvasColor) => void;
}

export const CanvasEdgeLayer: FC<CanvasEdgeLayerProps> = ({
  edges,
  nodesMap,
  selectedEdgeId,
  draftEdge,
  onSelectEdge,
  onDeleteEdge,
  onUpdateEdgeLabel,
}) => {
  const [editingLabelEdgeId, setEditingLabelEdgeId] = useState<string | null>(null);
  const [labelInput, setLabelInput] = useState("");

  const handleStartEditLabel = (edge: CanvasEdge) => {
    setEditingLabelEdgeId(edge.id);
    setLabelInput(edge.label || "");
  };

  const handleFinishEditLabel = (edgeId: string) => {
    setEditingLabelEdgeId(null);
    onUpdateEdgeLabel(edgeId, labelInput.trim());
  };

  return (
    <svg
      className="absolute inset-0 overflow-visible pointer-events-none"
      style={{ width: "100%", height: "100%", zIndex: 5 }}
    >
      <defs>
        {/* Dynamic Arrowhead Markers */}
        <marker
          id="canvas-arrow-default"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#64748b" />
        </marker>
        <marker
          id="canvas-arrow-selected"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 10 5 L 0 9 z" fill="#38bdf8" />
        </marker>

        {Object.entries(PRESET_COLOR_MAP).map(([key, item]) => (
          <marker
            key={key}
            id={`canvas-arrow-${key}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 10 5 L 0 9 z" fill={item.hex} />
          </marker>
        ))}
      </defs>

      {/* Render Existing Edges */}
      {edges.map((edge) => {
        const fromNode = nodesMap.get(edge.fromNode);
        const toNode = nodesMap.get(edge.toNode);
        if (!fromNode || !toNode) return null;

        // Auto determine sides if not explicitly provided
        let fromSide = edge.fromSide;
        let toSide = edge.toSide;
        if (!fromSide || !toSide) {
          const auto = getAutoSides(fromNode, toNode);
          if (!fromSide) fromSide = auto.fromSide;
          if (!toSide) toSide = auto.toSide;
        }

        const startPt = getNodeSidePoint(fromNode, fromSide);
        const endPt = getNodeSidePoint(toNode, toSide);
        const curve = computeBezierPath(startPt, fromSide, endPt, toSide);

        const isSelected = edge.id === selectedEdgeId;
        const colorHex = resolveCanvasColor(edge.color);
        const strokeColor = isSelected ? "#38bdf8" : colorHex || "#64748b";

        // Determine arrow marker ID
        const markerEndId = isSelected
          ? "url(#canvas-arrow-selected)"
          : edge.color && edge.color in PRESET_COLOR_MAP
          ? `url(#canvas-arrow-${edge.color})`
          : "url(#canvas-arrow-default)";

        const markerStartId = edge.fromEnd === "arrow" ? markerEndId : undefined;
        const toEndMarker = edge.toEnd !== "none" ? markerEndId : undefined;

        return (
          <g key={edge.id} className="group">
            {/* Generous invisible stroke for hit testing and hover/click. The <svg> is
                pointer-events: none, so this path must opt back in (Tailwind has no class for
                "stroke", hence the inline style). */}
            <path
              d={curve.pathString}
              fill="none"
              stroke="transparent"
              strokeWidth={26}
              style={{ pointerEvents: "stroke" }}
              className="cursor-pointer"
              onMouseDown={(e) => {
                // A left press on a line is not a press on empty canvas: don't start a marquee.
                // Other buttons (middle-drag pan) still reach the canvas.
                if (e.button === 0) e.stopPropagation();
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectEdge(e, edge.id);
              }}
            />

            {/* Visible curve */}
            <path
              d={curve.pathString}
              fill="none"
              stroke={strokeColor}
              strokeWidth={isSelected ? 3 : 2}
              markerStart={markerStartId}
              markerEnd={toEndMarker}
              className="transition-colors pointer-events-none"
            />

            {/* Midpoint: the label, and once the line is selected (one click or tap on it), an
                "x" button that removes the connection. */}
            {(edge.label || isSelected) && (
              <foreignObject
                x={curve.midpoint.x - 120}
                y={curve.midpoint.y - 20}
                width={240}
                height={40}
                className="overflow-visible pointer-events-none"
              >
                <div data-canvas-ui className="flex items-center justify-center gap-1.5 w-full h-full">
                  {editingLabelEdgeId === edge.id ? (
                    <div className="pointer-events-auto flex items-center gap-1 bg-[#161b22] border border-sky-400 rounded-full px-2 py-0.5 shadow-lg">
                      <input
                        type="text"
                        autoFocus
                        value={labelInput}
                        onChange={(e) => setLabelInput(e.target.value)}
                        onBlur={() => handleFinishEditLabel(edge.id)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") handleFinishEditLabel(edge.id);
                          if (e.key === "Escape") setEditingLabelEdgeId(null);
                        }}
                        className="bg-transparent text-white text-[11px] outline-none w-20 text-center font-medium"
                        placeholder="Label..."
                      />
                      <button
                        onClick={() => handleFinishEditLabel(edge.id)}
                        className="p-0.5 text-emerald-400 hover:text-emerald-300 cursor-pointer"
                      >
                        <Check className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    (edge.label || isSelected) && (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectEdge(e, edge.id);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          handleStartEditLabel(edge);
                        }}
                        title="Double-click to edit the label"
                        className={`pointer-events-auto px-2.5 py-0.5 rounded-full text-[11px] font-medium border shadow-md cursor-pointer backdrop-blur-sm transition-all ${
                          isSelected
                            ? "bg-sky-950/90 text-sky-300 border-sky-500/60 shadow-[0_0_10px_rgba(56,189,248,0.4)]"
                            : "bg-[#161b22]/90 text-zinc-300 border-[#30363d] hover:border-zinc-500 hover:text-white"
                        }`}
                      >
                        <span className="block truncate max-w-[110px]">
                          {(edge.label && stripMarkdownMarkers(edge.label)) || "Add label..."}
                        </span>
                      </div>
                    )
                  )}
                  {isSelected && editingLabelEdgeId !== edge.id && (
                    <button
                      type="button"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteEdge(edge.id);
                      }}
                      title="Remove connection"
                      aria-label="Remove connection"
                      className="pointer-events-auto w-8 h-8 shrink-0 rounded-full flex items-center justify-center bg-[#161b22] border border-red-500/60 text-red-400 shadow-lg shadow-black/40 hover:bg-red-500 hover:text-white active:bg-red-500 active:text-white transition-colors cursor-pointer"
                    >
                      <X className="w-4 h-4" strokeWidth={2.5} />
                    </button>
                  )}
                </div>
              </foreignObject>
            )}
          </g>
        );
      })}

      {/* Render Active Draft Edge while connecting */}
      {draftEdge &&
        (() => {
          const fromNode = nodesMap.get(draftEdge.fromNodeId);
          if (!fromNode) return null;
          // Pick both sides live, the same way a finished edge does, treating the cursor as a
          // zero-size card so the preview matches the edge it will become.
          const cursor = draftEdge.currentPoint;
          const { fromSide, toSide } = getAutoSides(fromNode, {
            x: cursor.x,
            y: cursor.y,
            width: 0,
            height: 0,
          });
          const startPt = getNodeSidePoint(fromNode, fromSide);
          const draftCurve = computeBezierPath(startPt, fromSide, cursor, toSide);

          return (
            <g className="pointer-events-none">
              <path
                d={draftCurve.pathString}
                fill="none"
                stroke="#38bdf8"
                strokeWidth={2.5}
                strokeDasharray="6,4"
                markerEnd="url(#canvas-arrow-selected)"
                className="animate-pulse"
              />
              <circle
                cx={draftEdge.currentPoint.x}
                cy={draftEdge.currentPoint.y}
                r={4}
                fill="#38bdf8"
              />
            </g>
          );
        })()}
    </svg>
  );
};
