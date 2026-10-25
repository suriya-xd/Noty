import React, { useState } from "react";
import type { FC } from "react";
import { CanvasNode, CanvasSide } from "../../types/canvas";
import { getCanvasColorStyles } from "../../utils/canvas/parser";
import { CanvasTextNode } from "./CanvasTextNode";
import { CanvasFileNode } from "./CanvasFileNode";
import { CanvasLinkNode } from "./CanvasLinkNode";
import { CanvasGroupNode } from "./CanvasGroupNode";

export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface CanvasNodeItemProps {
  node: CanvasNode;
  isSelected: boolean;
  isGroup: boolean;
  zIndex: number;
  vaultPath: string;
  onSelect: (e: React.MouseEvent, nodeId: string) => void;
  onStartDrag: (e: React.MouseEvent, nodeId: string) => void;
  onStartResize: (e: React.MouseEvent, nodeId: string, handle: ResizeHandle) => void;
  onStartEdgeConnect: (e: React.MouseEvent, nodeId: string, side: CanvasSide) => void;
  onUpdateNode: (updatedNode: CanvasNode) => void;
  onOpenFile?: (path: string) => void;
}

export const CanvasNodeItem: FC<CanvasNodeItemProps> = ({
  node,
  isSelected,
  isGroup,
  zIndex,
  vaultPath,
  onSelect,
  onStartDrag,
  onStartResize,
  onStartEdgeConnect,
  onUpdateNode,
  onOpenFile,
}) => {
  const [isHovered, setIsHovered] = useState(false);

  const colorStyles = getCanvasColorStyles(node.color);

  // Connection sides
  const sides: CanvasSide[] = ["top", "right", "bottom", "left"];

  const getSideHandlePosition = (side: CanvasSide): string => {
    switch (side) {
      case "top":
        return "top-0 left-1/2 -translate-x-1/2 -translate-y-1/2";
      case "bottom":
        return "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2";
      case "left":
        return "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2";
      case "right":
        return "right-0 top-1/2 translate-x-1/2 -translate-y-1/2";
    }
  };

  return (
    <div
      id={`canvas-node-${node.id}`}
      data-node-id={node.id}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseDown={(e) => {
        // Prevent pan when clicking a node
        if (e.button === 0) {
          onSelect(e, node.id);
          onStartDrag(e, node.id);
        }
      }}
      style={{
        transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
        width: `${node.width}px`,
        height: `${node.height}px`,
        zIndex,
      }}
      className={`absolute select-none transition-shadow rounded-xl ${
        isGroup
          ? `border-2 border-dashed ${
              node.color ? "" : "border-[#30363d]/80"
            } bg-[#161b22]/30 backdrop-blur-[1px]`
          : `border shadow-xl ${colorStyles.bg}`
      } ${
        isSelected
          ? "ring-2 ring-sky-400 ring-offset-2 ring-offset-[#0d1117] shadow-[0_0_20px_rgba(56,189,248,0.3)] !border-sky-400"
          : isHovered
          ? "shadow-[0_0_15px_rgba(0,0,0,0.5)] border-zinc-500/80"
          : node.color
          ? ""
          : "border-[#30363d]"
      }`}
    >
      {/* Node Inner Body */}
      <div className="w-full h-full overflow-hidden rounded-xl">
        {node.type === "text" && (
          <CanvasTextNode
            node={node}
            isSelected={isSelected}
            onUpdateText={(text) => onUpdateNode({ ...node, text })}
            onNavigateFile={onOpenFile}
          />
        )}
        {node.type === "file" && (
          <CanvasFileNode
            node={node}
            vaultPath={vaultPath}
            onOpenFile={onOpenFile}
          />
        )}
        {node.type === "link" && <CanvasLinkNode node={node} />}
        {node.type === "group" && (
          <CanvasGroupNode
            node={node}
            onUpdateLabel={(label) => onUpdateNode({ ...node, label })}
          />
        )}
      </div>

      {/* 4-Side Connection Ports (Visible on hover or selection) */}
      {(isHovered || isSelected) &&
        sides.map((side) => (
          <div
            key={side}
            title={`Connect from ${side}`}
            onMouseDown={(e) => {
              e.stopPropagation();
              onStartEdgeConnect(e, node.id, side);
            }}
            className={`absolute z-30 w-3.5 h-3.5 rounded-full bg-sky-400 border-2 border-[#0d1117] shadow-md hover:scale-135 hover:bg-sky-300 transition-all cursor-crosshair ${getSideHandlePosition(
              side
            )}`}
          />
        ))}

      {/* 8 Resize Handles (Visible when selected) */}
      {isSelected && (
        <>
          {/* Corners */}
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "nw")}
            className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border border-[#0d1117] rounded-sm cursor-nwse-resize z-40 hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "ne")}
            className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border border-[#0d1117] rounded-sm cursor-nesw-resize z-40 hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "se")}
            className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border border-[#0d1117] rounded-sm cursor-nwse-resize z-40 hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "sw")}
            className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border border-[#0d1117] rounded-sm cursor-nesw-resize z-40 hover:scale-125"
          />
          {/* Edges */}
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "n")}
            className="absolute -top-1 left-1/2 -translate-x-1/2 w-4 h-2 bg-white/70 border border-[#0d1117] rounded-xs cursor-ns-resize z-40 hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "s")}
            className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-2 bg-white/70 border border-[#0d1117] rounded-xs cursor-ns-resize z-40 hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "w")}
            className="absolute top-1/2 -left-1 -translate-y-1/2 w-2 h-4 bg-white/70 border border-[#0d1117] rounded-xs cursor-ew-resize z-40 hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "e")}
            className="absolute top-1/2 -right-1 -translate-y-1/2 w-2 h-4 bg-white/70 border border-[#0d1117] rounded-xs cursor-ew-resize z-40 hover:scale-125"
          />
        </>
      )}
    </div>
  );
};
