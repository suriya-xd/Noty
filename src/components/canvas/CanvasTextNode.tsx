import { useState, useRef, useEffect } from "react";
import type { FC } from "react";
import { CanvasTextNode as ICanvasTextNode } from "../../types/canvas";
import { MarkdownViewer } from "../MarkdownViewer";
import { Edit3, Check } from "lucide-react";

interface CanvasTextNodeProps {
  node: ICanvasTextNode;
  isSelected: boolean;
  onUpdateText: (newText: string) => void;
  onNavigateFile?: (filePath: string) => void;
}

export const CanvasTextNode: FC<CanvasTextNodeProps> = ({
  node,
  isSelected: _isSelected,
  onUpdateText,
  onNavigateFile,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(node.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setEditText(node.text);
  }, [node.text]);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [isEditing]);

  const handleFinishEditing = () => {
    setIsEditing(false);
    if (editText !== node.text) {
      onUpdateText(editText);
    }
  };

  return (
    <div
      className="w-full h-full flex flex-col overflow-hidden select-text"
      onDoubleClick={(e) => {
        e.stopPropagation();
        setIsEditing(true);
      }}
    >
      {/* Node Header / Action Bar on hover or editing */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#30363d]/50 bg-[#0d1117]/60 text-xs text-zinc-400 select-none">
        <span className="text-[11px] font-mono text-zinc-400 flex items-center gap-1">
          <Edit3 className="w-3 h-3 text-sky-400" />
          Text Card
        </span>
        <div className="flex items-center gap-1">
          {isEditing ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleFinishEditing();
              }}
              title="Done editing (Ctrl+Enter)"
              className="p-1 hover:text-emerald-400 text-zinc-400 rounded transition-colors cursor-pointer"
            >
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            </button>
          ) : (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsEditing(true);
              }}
              title="Edit Markdown (Double-click)"
              className="p-1 hover:text-white text-zinc-400 rounded transition-colors cursor-pointer opacity-60 hover:opacity-100"
            >
              <Edit3 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Content Area */}
      <div className="flex-1 overflow-auto p-3 bg-[#161b22]/90">
        {isEditing ? (
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={handleFinishEditing}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                setIsEditing(false);
                setEditText(node.text);
              }
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                handleFinishEditing();
              }
            }}
            placeholder="Type markdown here... (Ctrl+Enter to finish)"
            className="w-full h-full bg-transparent text-white font-mono text-xs resize-none outline-none leading-relaxed placeholder-zinc-500 selection:bg-sky-500/30"
          />
        ) : (
          <div className="w-full h-full cursor-text">
            {node.text.trim() ? (
              <MarkdownViewer
                content={node.text}
                className="text-xs"
                onNavigateFile={onNavigateFile}
              />
            ) : (
              <div className="text-zinc-500 italic text-xs h-full flex items-center justify-center">
                Double-click to write Markdown...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
