import { useState, useRef, useEffect, useMemo } from "react";
import type { FC } from "react";
import { CanvasTextNode as ICanvasTextNode } from "../../types/canvas";
import { MarkdownViewer } from "../MarkdownViewer";
import { Edit3, Check } from "lucide-react";
import { calculateCanvasTextNodeFontSize } from "../../utils/canvas/math";

interface CanvasTextNodeProps {
  node: ICanvasTextNode;
  isSelected: boolean;
  isEditing?: boolean;
  onEditingChange?: (isEditing: boolean) => void;
  onUpdateText: (newText: string) => void;
  onNavigateFile?: (filePath: string) => void;
}

export const CanvasTextNode: FC<CanvasTextNodeProps> = ({
  node,
  isSelected: _isSelected,
  isEditing: controlledIsEditing,
  onEditingChange,
  onUpdateText,
  onNavigateFile,
}) => {
  const [internalIsEditing, setInternalIsEditing] = useState(false);
  const isEditing = controlledIsEditing !== undefined ? controlledIsEditing : internalIsEditing;
  const setIsEditing = (val: boolean) => {
    onEditingChange?.(val);
    setInternalIsEditing(val);
  };

  const [editText, setEditText] = useState(node.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setEditText(node.text);
  }, [node.text]);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [isEditing]);

  const handleFinishEditing = () => {
    setIsEditing(false);
    if (editText !== node.text) {
      onUpdateText(editText);
    }
  };

  // Dynamically calculate font size tailored for Text elements, updating while typing and resizing
  const dynamicFontSize = useMemo(
    () =>
      calculateCanvasTextNodeFontSize(
        node.width,
        node.height,
        isEditing ? editText : node.text
      ),
    [node.width, node.height, isEditing, editText, node.text]
  );

  return (
    <div
      className="group/text relative w-full h-full flex flex-col overflow-hidden select-text"
      style={{ fontSize: `${dynamicFontSize}px` }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        setIsEditing(true);
      }}
    >
      {/* Edit / done control floats over the card: no title bar, so the card is all content. */}
      <div className="absolute top-1.5 right-1.5 z-10 flex items-center">
        {isEditing ? (
          <button
            // Keep focus in the textarea until the click lands. Otherwise blur finishes editing first,
            // this button is swapped for "Edit", and the same click immediately re-enters edit mode.
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              handleFinishEditing();
            }}
            title="Done editing (Ctrl+Enter)"
            className="p-1.5 rounded-md bg-[#0d1117]/80 hover:bg-[#21262d] text-emerald-400 transition-colors cursor-pointer"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsEditing(true);
            }}
            title="Edit Markdown (Double-click)"
            className="p-1.5 rounded-md bg-[#0d1117]/80 hover:bg-[#21262d] text-zinc-400 hover:text-white transition-all cursor-pointer opacity-0 group-hover/text:opacity-100 [@media(pointer:coarse)]:opacity-60"
          >
            <Edit3 className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Content Area */}
      <div
        className="flex-1 overflow-auto p-3 bg-[#161b22]/90 flex flex-col justify-start"
        style={{ fontSize: `${dynamicFontSize}px` }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          setIsEditing(true);
        }}
      >
        {isEditing ? (
          <textarea
            ref={textareaRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={handleFinishEditing}
            onMouseDown={(e) => e.stopPropagation()}
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
            placeholder="Type text or markdown here... (Ctrl+Enter to finish)"
            style={{ fontSize: `${dynamicFontSize}px`, lineHeight: 1.35 }}
            className="w-full h-full bg-[#0d1117]/60 text-white rounded-lg p-2.5 resize-none outline-none ring-1 ring-sky-500/50 focus:ring-sky-400 leading-relaxed placeholder-zinc-500 selection:bg-sky-500/30 transition-all font-sans"
          />
        ) : (
          <div className="w-full h-full cursor-text" style={{ fontSize: `${dynamicFontSize}px` }}>
            {node.text.trim() ? (
              <MarkdownViewer
                content={node.text}
                fontSize={dynamicFontSize}
                onNavigateFile={onNavigateFile}
              />
            ) : (
              <div
                style={{ fontSize: `${dynamicFontSize}px` }}
                className="text-zinc-500 italic h-full flex items-center justify-center text-center p-2"
              >
                Double-click to write Markdown...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
