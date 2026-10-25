import { useState } from "react";
import type { FC } from "react";
import { CanvasGroupNode as ICanvasGroupNode } from "../../types/canvas";
import { Folder, Edit2, Check } from "lucide-react";

interface CanvasGroupNodeProps {
  node: ICanvasGroupNode;
  onUpdateLabel: (newLabel: string) => void;
}

export const CanvasGroupNode: FC<CanvasGroupNodeProps> = ({
  node,
  onUpdateLabel,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [labelValue, setLabelValue] = useState(node.label || "Group");

  const handleFinish = () => {
    setIsEditing(false);
    if (labelValue.trim() !== (node.label || "")) {
      onUpdateLabel(labelValue.trim());
    }
  };

  return (
    <div
      className="w-full h-full relative select-none rounded-xl pointer-events-none"
      style={{
        backgroundImage: node.background ? `url(${node.background})` : undefined,
        backgroundSize: node.backgroundStyle || "cover",
      }}
    >
      {/* Group Header Label */}
      <div className="absolute top-2 left-3 pointer-events-auto flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#161b22]/90 border border-[#30363d] backdrop-blur-sm shadow-sm group">
        <Folder className="w-3.5 h-3.5 text-zinc-400" />
        {isEditing ? (
          <div className="flex items-center gap-1">
            <input
              type="text"
              autoFocus
              value={labelValue}
              onChange={(e) => setLabelValue(e.target.value)}
              onBlur={handleFinish}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") handleFinish();
                if (e.key === "Escape") {
                  setIsEditing(false);
                  setLabelValue(node.label || "Group");
                }
              }}
              className="bg-[#0d1117] border border-sky-500 rounded px-1.5 py-0.5 text-xs text-white outline-none w-36 font-semibold"
            />
            <button
              onClick={handleFinish}
              className="p-0.5 text-emerald-400 hover:text-emerald-300 cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <div
            className="flex items-center gap-1.5 cursor-pointer"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setIsEditing(true);
            }}
          >
            <span className="text-xs font-semibold text-zinc-200">
              {node.label || "Untitled Group"}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsEditing(true);
              }}
              title="Rename group"
              className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-400 hover:text-white transition-opacity"
            >
              <Edit2 className="w-2.5 h-2.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
