import React, { useState } from "react";
import type { FC } from "react";
import { CanvasNode, CanvasSide } from "../../types/canvas";
import { getCanvasColorStyles } from "../../utils/canvas/parser";
import { calculateCanvasNodeFontSize, getTextNodeFontSize } from "../../utils/canvas/math";
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
  /** File cards only: the referenced note is not in the vault. */
  isMissing?: boolean;
  /**
   * Touch screens: no resize handles (they sit on top of the connection dots and are too small
   * to hit); a selected card is resized by pinching it instead, and the dots are larger.
   */
  touchMode?: boolean;
  onSelect: (e: React.MouseEvent, nodeId: string) => void;
  onStartDrag: (e: React.MouseEvent, nodeId: string) => void;
  onStartResize: (e: React.MouseEvent, nodeId: string, handle: ResizeHandle) => void;
  onStartEdgeConnect: (e: React.MouseEvent, nodeId: string, side: CanvasSide) => void;
  onUpdateNode: (updatedNode: CanvasNode) => void;
  onOpenFile?: (path: string) => void;
  onPreviewImage?: (src: string, alt?: string, title?: string) => void;
}

export const CanvasNodeItem: FC<CanvasNodeItemProps> = ({
  node,
  isSelected,
  isGroup,
  zIndex,
  vaultPath,
  isMissing = false,
  touchMode = false,
  onSelect,
  onStartDrag,
  onStartResize,
  onStartEdgeConnect,
  onUpdateNode,
  onOpenFile,
  onPreviewImage,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isEditingText, setIsEditingText] = useState(false);

  const colorStyles = getCanvasColorStyles(node.color);
  const dynamicFontSize = calculateCanvasNodeFontSize(node.width, node.height);

  // Connection sides
  const sides: CanvasSide[] = ["top", "right", "bottom", "left"];

  // Connection ports float outside the card, clear of the edge (where resize handles sit).
  // Touch screens get a wider gap, since each port's finger-sized hit area reaches 14px around it.
  const portSize = touchMode ? 20 : 14;
  const portGap = touchMode ? 32 : 12;
  const portReach = portGap + portSize;

  /**
   * The strip from the card edge out to a port. On desktop it is part of the port, so the pointer
   * can cross the gap without leaving the card (which would hide the ports) and pressing anywhere
   * on it starts a connection. Touch screens have no hover, so there only the dot is touchable.
   */
  const getPortStripStyle = (side: CanvasSide): React.CSSProperties => {
    switch (side) {
      case "top":
        return { bottom: "100%", left: "50%", transform: "translateX(-50%)", width: portSize, height: portReach, alignItems: "flex-start", justifyContent: "center" };
      case "bottom":
        return { top: "100%", left: "50%", transform: "translateX(-50%)", width: portSize, height: portReach, alignItems: "flex-end", justifyContent: "center" };
      case "left":
        return { right: "100%", top: "50%", transform: "translateY(-50%)", width: portReach, height: portSize, alignItems: "center", justifyContent: "flex-start" };
      case "right":
        return { left: "100%", top: "50%", transform: "translateY(-50%)", width: portReach, height: portSize, alignItems: "center", justifyContent: "flex-end" };
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
          if (!isEditingText) {
            onStartDrag(e, node.id);
          }
        }
      }}
      onDoubleClick={(e) => {
        if (node.type === "text") {
          e.stopPropagation();
          setIsEditingText(true);
        }
      }}
      style={{
        transform: `translate3d(${node.x}px, ${node.y}px, 0)`,
        width: `${node.width}px`,
        height: `${node.height}px`,
        zIndex,
        fontSize: `${dynamicFontSize}px`,
        ["--canvas-node-font-size" as string]: `${dynamicFontSize}px`,
        ...(node.color
          ? {
              borderColor: isSelected ? undefined : colorStyles.border,
              backgroundColor: colorStyles.bg,
            }
          : {}),
      }}
      className={`absolute select-none transition-shadow rounded-xl ${
        isGroup
          ? `border-2 border-dashed ${
              node.color ? "" : "border-[#30363d]/80 bg-[#161b22]/30"
            } backdrop-blur-[1px]`
          : `border shadow-xl ${node.color ? "" : "bg-[#161b22]"}`
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
            vaultPath={vaultPath}
            isEditing={isEditingText}
            onEditingChange={setIsEditingText}
            // Store the font size with the text, so older cards stop auto-sizing as they're edited.
            onUpdateText={(text) => onUpdateNode({ ...node, text, fontSize: getTextNodeFontSize(node) })}
            onNavigateFile={onOpenFile}
          />
        )}
        {node.type === "file" && (
          <CanvasFileNode
            node={node}
            vaultPath={vaultPath}
            isMissing={isMissing}
            onOpenFile={onOpenFile}
            onPreviewImage={onPreviewImage}
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
            style={getPortStripStyle(side)}
            className={`absolute z-30 flex group/port cursor-crosshair ${touchMode ? "pointer-events-none" : ""}`}
          >
            <div
              style={{ width: portSize, height: portSize }}
              className="canvas-handle relative shrink-0 rounded-full bg-sky-400 border-2 border-[#0d1117] shadow-md group-hover/port:scale-135 group-hover/port:bg-sky-300 transition-all pointer-events-auto"
            />
          </div>
        ))}

      {/* 8 Resize Handles (Visible when selected; not on touch screens, where pinching resizes) */}
      {isSelected && !touchMode && (
        <>
          {/* Corners */}
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "nw")}
            className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border border-[#0d1117] rounded-sm cursor-nwse-resize z-40 canvas-handle hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "ne")}
            className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border border-[#0d1117] rounded-sm cursor-nesw-resize z-40 canvas-handle hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "se")}
            className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border border-[#0d1117] rounded-sm cursor-nwse-resize z-40 canvas-handle hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "sw")}
            className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border border-[#0d1117] rounded-sm cursor-nesw-resize z-40 canvas-handle hover:scale-125"
          />
          {/* Edges */}
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "n")}
            className="absolute -top-1 left-1/2 -translate-x-1/2 w-4 h-2 bg-white/70 border border-[#0d1117] rounded-xs cursor-ns-resize z-40 canvas-handle hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "s")}
            className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-4 h-2 bg-white/70 border border-[#0d1117] rounded-xs cursor-ns-resize z-40 canvas-handle hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "w")}
            className="absolute top-1/2 -left-1 -translate-y-1/2 w-2 h-4 bg-white/70 border border-[#0d1117] rounded-xs cursor-ew-resize z-40 canvas-handle hover:scale-125"
          />
          <div
            onMouseDown={(e) => onStartResize(e, node.id, "e")}
            className="absolute top-1/2 -right-1 -translate-y-1/2 w-2 h-4 bg-white/70 border border-[#0d1117] rounded-xs cursor-ew-resize z-40 canvas-handle hover:scale-125"
          />
        </>
      )}
    </div>
  );
};
