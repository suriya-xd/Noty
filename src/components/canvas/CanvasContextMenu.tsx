import type { FC } from "react";
import {
  FileText,
  FilePlus,
  Globe,
  FolderPlus,
  Trash2,
  Copy,
  ArrowUpToLine,
  ArrowDownToLine,
  Palette,
} from "lucide-react";
import { CanvasColor, CanvasPresetColor } from "../../types/canvas";
import { PRESET_COLOR_MAP } from "../../utils/canvas/parser";

export interface ContextMenuState {
  x: number;
  y: number;
  targetType: "canvas" | "node";
  targetNodeId?: string;
}

interface CanvasContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  onAddTextNode: () => void;
  onAddFileNode: () => void;
  onAddLinkNode: () => void;
  onAddGroupNode: () => void;
  onDuplicateNode?: () => void;
  onBringToFront?: () => void;
  onSendToBack?: () => void;
  onDeleteNode?: () => void;
  onChangeColor?: (color?: CanvasColor) => void;
}

export const CanvasContextMenu: FC<CanvasContextMenuProps> = ({
  state,
  onClose,
  onAddTextNode,
  onAddFileNode,
  onAddLinkNode,
  onAddGroupNode,
  onDuplicateNode,
  onBringToFront,
  onSendToBack,
  onDeleteNode,
  onChangeColor,
}) => {
  return (
    <>
      <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        style={{ left: `${state.x}px`, top: `${state.y}px` }}
        className="fixed z-50 min-w-48 bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl p-1 text-xs select-none animate-in fade-in zoom-in-95 duration-100"
      >
        {state.targetType === "canvas" ? (
          <>
            <div className="px-3 py-1.5 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
              Add to Canvas
            </div>
            <button
              onClick={() => { onAddTextNode(); onClose(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-zinc-200 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer text-left"
            >
              <FileText className="w-4 h-4 text-sky-400" />
              <span>Add Text Card</span>
            </button>
            <button
              onClick={() => { onAddFileNode(); onClose(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-zinc-200 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer text-left"
            >
              <FilePlus className="w-4 h-4 text-amber-400" />
              <span>Add Note from Vault</span>
            </button>
            <button
              onClick={() => { onAddLinkNode(); onClose(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-zinc-200 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer text-left"
            >
              <Globe className="w-4 h-4 text-emerald-400" />
              <span>Add Web Link</span>
            </button>
            <button
              onClick={() => { onAddGroupNode(); onClose(); }}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-zinc-200 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer text-left"
            >
              <FolderPlus className="w-4 h-4 text-purple-400" />
              <span>Add Group</span>
            </button>
          </>
        ) : (
          <>
            <div className="px-3 py-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
              Node Actions
            </div>
            {/* Color Palette */}
            {onChangeColor && (
              <div className="px-3 py-1.5">
                <div className="flex items-center gap-1.5 mb-1 text-[11px] text-zinc-400">
                  <Palette className="w-3.5 h-3.5" />
                  <span>Color</span>
                </div>
                <div className="flex items-center gap-1">
                  {(Object.keys(PRESET_COLOR_MAP) as CanvasPresetColor[]).map((c) => (
                    <button
                      key={c}
                      onClick={() => { onChangeColor(c); onClose(); }}
                      style={{ backgroundColor: PRESET_COLOR_MAP[c].hex }}
                      className="w-4 h-4 rounded-full border border-white/20 hover:scale-125 transition-transform cursor-pointer"
                    />
                  ))}
                  <button
                    onClick={() => { onChangeColor(undefined); onClose(); }}
                    title="Remove color"
                    className="text-[10px] text-zinc-500 hover:text-zinc-300 ml-1"
                  >
                    Clear
                  </button>
                </div>
              </div>
            )}
            <div className="border-t border-[#21262d] my-1" />
            {onDuplicateNode && (
              <button
                onClick={() => { onDuplicateNode(); onClose(); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-zinc-200 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer text-left"
              >
                <Copy className="w-4 h-4 text-zinc-400" />
                <span>Duplicate</span>
                <span className="text-zinc-500 text-[10px] ml-auto font-mono">Ctrl+D</span>
              </button>
            )}
            {onBringToFront && (
              <button
                onClick={() => { onBringToFront(); onClose(); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-zinc-200 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer text-left"
              >
                <ArrowUpToLine className="w-4 h-4 text-zinc-400" />
                <span>Bring to Front</span>
              </button>
            )}
            {onSendToBack && (
              <button
                onClick={() => { onSendToBack(); onClose(); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-zinc-200 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer text-left"
              >
                <ArrowDownToLine className="w-4 h-4 text-zinc-400" />
                <span>Send to Back</span>
              </button>
            )}
            <div className="border-t border-[#21262d] my-1" />
            {onDeleteNode && (
              <button
                onClick={() => { onDeleteNode(); onClose(); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors cursor-pointer text-left"
              >
                <Trash2 className="w-4 h-4 text-red-400" />
                <span>Delete</span>
                <span className="text-zinc-500 text-[10px] ml-auto font-mono">Del</span>
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
};
