import { useState } from "react";
import type { FC } from "react";
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Undo2,
  Redo2,
  Grid,
  FileText,
  FilePlus,
  Globe,
  FolderPlus,
  Trash2,
  Copy,
  ArrowUpToLine,
  ArrowDownToLine,
  Palette,
  Crosshair,
} from "lucide-react";
import { CanvasColor, CanvasPresetColor } from "../../types/canvas";
import { PRESET_COLOR_MAP } from "../../utils/canvas/parser";

interface CanvasToolbarProps {
  zoom: number;
  snapGrid: boolean;
  canUndo: boolean;
  canRedo: boolean;
  selectedCount: number;
  selectedColor?: CanvasColor;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onZoomToFit: () => void;
  onZoomToSelection?: () => void;
  onToggleSnapGrid: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onAddTextNode: () => void;
  onAddFileNode: () => void;
  onAddLinkNode: () => void;
  onAddGroupNode: () => void;
  onDeleteSelected: () => void;
  onDuplicateSelected: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onChangeColor: (color?: CanvasColor) => void;
}

export const CanvasToolbar: FC<CanvasToolbarProps> = ({
  zoom,
  snapGrid,
  canUndo,
  canRedo,
  selectedCount,
  selectedColor: _selectedColor,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onZoomToFit,
  onZoomToSelection,
  onToggleSnapGrid,
  onUndo,
  onRedo,
  onAddTextNode,
  onAddFileNode,
  onAddLinkNode,
  onAddGroupNode,
  onDeleteSelected,
  onDuplicateSelected,
  onBringToFront,
  onSendToBack,
  onChangeColor,
}) => {
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [customHex, setCustomHex] = useState("#38bdf8");

  const zoomPercent = Math.round(zoom * 100);

  return (
    <>
      {/* 1. Main Bottom-Right Zoom & Navigation Controls */}
      <div className="absolute bottom-5 right-5 z-40 flex items-center gap-1.5 p-1.5 bg-[#161b22]/90 border border-[#30363d] backdrop-blur-md rounded-xl shadow-2xl text-xs select-none">
        <button
          onClick={onZoomOut}
          title="Zoom out (Ctrl -)"
          className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer"
        >
          <ZoomOut className="w-4 h-4" />
        </button>

        <button
          onClick={onResetZoom}
          title="Reset zoom to 100%"
          className="px-2 py-1 rounded-lg text-zinc-300 font-mono text-xs hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer min-w-12 text-center"
        >
          {zoomPercent}%
        </button>

        <button
          onClick={onZoomIn}
          title="Zoom in (Ctrl +)"
          className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer"
        >
          <ZoomIn className="w-4 h-4" />
        </button>

        <div className="w-px h-4 bg-[#30363d] mx-0.5" />

        <button
          onClick={onZoomToFit}
          title="Zoom to fit all nodes (Shift 1)"
          className="p-1.5 rounded-lg text-zinc-400 hover:text-sky-400 hover:bg-[#21262d] transition-colors cursor-pointer"
        >
          <Maximize2 className="w-4 h-4" />
        </button>

        <button
          onClick={onToggleSnapGrid}
          title={`Snap to grid: ${snapGrid ? "ON" : "OFF"}`}
          className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
            snapGrid
              ? "text-sky-400 bg-sky-500/10 border border-sky-500/30"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-[#21262d]"
          }`}
        >
          <Grid className="w-4 h-4" />
        </button>
      </div>

      {/* 2. Top-Center Creation & History Toolbar */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 p-1.5 bg-[#161b22]/90 border border-[#30363d] backdrop-blur-md rounded-xl shadow-2xl text-xs select-none">
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
          className={`p-1.5 rounded-lg transition-colors ${
            canUndo
              ? "text-zinc-300 hover:text-white hover:bg-[#21262d] cursor-pointer"
              : "text-zinc-600 cursor-not-allowed"
          }`}
        >
          <Undo2 className="w-4 h-4" />
        </button>

        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl+Shift+Z)"
          className={`p-1.5 rounded-lg transition-colors ${
            canRedo
              ? "text-zinc-300 hover:text-white hover:bg-[#21262d] cursor-pointer"
              : "text-zinc-600 cursor-not-allowed"
          }`}
        >
          <Redo2 className="w-4 h-4" />
        </button>

        <div className="w-px h-4 bg-[#30363d] mx-1" />

        <button
          onClick={onAddTextNode}
          title="Add Text Card (Double-click canvas)"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-zinc-300 hover:text-sky-300 hover:bg-[#21262d] transition-colors cursor-pointer font-medium"
        >
          <FileText className="w-3.5 h-3.5 text-sky-400" />
          <span>Text</span>
        </button>

        <button
          onClick={onAddFileNode}
          title="Add Note from Vault (Drag note or click)"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-zinc-300 hover:text-amber-300 hover:bg-[#21262d] transition-colors cursor-pointer font-medium"
        >
          <FilePlus className="w-3.5 h-3.5 text-amber-400" />
          <span>Note</span>
        </button>

        <button
          onClick={onAddLinkNode}
          title="Add Web Link Card"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-zinc-300 hover:text-emerald-300 hover:bg-[#21262d] transition-colors cursor-pointer font-medium"
        >
          <Globe className="w-3.5 h-3.5 text-emerald-400" />
          <span>Link</span>
        </button>

        <button
          onClick={onAddGroupNode}
          title="Add Group Container"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-zinc-300 hover:text-purple-300 hover:bg-[#21262d] transition-colors cursor-pointer font-medium"
        >
          <FolderPlus className="w-3.5 h-3.5 text-purple-400" />
          <span>Group</span>
        </button>
      </div>

      {/* 3. Floating Selection Toolbar (when nodes are selected) */}
      {selectedCount > 0 && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1 p-1 bg-[#161b22] border border-sky-500/40 backdrop-blur-md rounded-xl shadow-2xl text-xs select-none animate-in fade-in zoom-in-95 duration-150">
          <span className="px-2 py-1 text-zinc-400 font-mono text-[11px] font-medium border-r border-[#30363d]">
            {selectedCount} selected
          </span>

          {/* Color Picker Dropdown */}
          <div className="relative">
            <button
              onClick={() => setIsColorPickerOpen((prev) => !prev)}
              title="Set Color"
              className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-[#21262d] flex items-center gap-1 cursor-pointer"
            >
              <Palette className="w-4 h-4 text-sky-400" />
            </button>

            {isColorPickerOpen && (
              <div className="absolute top-full mt-2 left-0 p-2.5 bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl z-50 flex flex-col gap-2 min-w-44">
                <span className="text-[10px] font-semibold uppercase text-zinc-400 font-mono">
                  Preset Colors
                </span>
                <div className="grid grid-cols-6 gap-1.5">
                  {(Object.keys(PRESET_COLOR_MAP) as CanvasPresetColor[]).map((key) => {
                    const preset = PRESET_COLOR_MAP[key];
                    return (
                      <button
                        key={key}
                        onClick={() => {
                          onChangeColor(key);
                          setIsColorPickerOpen(false);
                        }}
                        title={preset.name}
                        style={{ backgroundColor: preset.hex }}
                        className="w-6 h-6 rounded-full hover:scale-115 transition-transform border border-white/20 cursor-pointer shadow-sm"
                      />
                    );
                  })}
                </div>
                <div className="border-t border-[#30363d] my-1" />
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={customHex}
                    onChange={(e) => setCustomHex(e.target.value)}
                    className="w-6 h-6 rounded border-0 cursor-pointer bg-transparent"
                  />
                  <button
                    onClick={() => {
                      onChangeColor(customHex);
                      setIsColorPickerOpen(false);
                    }}
                    className="text-[11px] text-sky-400 hover:underline cursor-pointer"
                  >
                    Apply Hex
                  </button>
                  <button
                    onClick={() => {
                      onChangeColor(undefined);
                      setIsColorPickerOpen(false);
                    }}
                    className="text-[11px] text-zinc-400 hover:text-red-400 ml-auto cursor-pointer"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>

          {onZoomToSelection && (
            <button
              onClick={onZoomToSelection}
              title="Zoom to selection"
              className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-[#21262d] cursor-pointer"
            >
              <Crosshair className="w-4 h-4" />
            </button>
          )}

          <button
            onClick={onDuplicateSelected}
            title="Duplicate (Ctrl+D)"
            className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-[#21262d] cursor-pointer"
          >
            <Copy className="w-4 h-4" />
          </button>

          <button
            onClick={onBringToFront}
            title="Bring to front"
            className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-[#21262d] cursor-pointer"
          >
            <ArrowUpToLine className="w-4 h-4" />
          </button>

          <button
            onClick={onSendToBack}
            title="Send to back"
            className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-[#21262d] cursor-pointer"
          >
            <ArrowDownToLine className="w-4 h-4" />
          </button>

          <div className="w-px h-4 bg-[#30363d] mx-0.5" />

          <button
            onClick={onDeleteSelected}
            title="Delete (Del / Backspace)"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-red-400 hover:bg-red-500/10 cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}
    </>
  );
};
