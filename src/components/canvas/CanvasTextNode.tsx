import { useState, useEffect } from "react";
import type { FC } from "react";
import { CanvasTextNode as ICanvasTextNode } from "../../types/canvas";
import { MarkdownViewer } from "../MarkdownViewer";
import { CanvasMarkdownEditor } from "./CanvasMarkdownEditor";
import { Edit3, Check } from "lucide-react";
import { getTextNodeFontSize } from "../../utils/canvas/math";

interface CanvasTextNodeProps {
  node: ICanvasTextNode;
  isSelected: boolean;
  vaultPath: string;
  isEditing?: boolean;
  onEditingChange?: (isEditing: boolean) => void;
  onUpdateText: (newText: string) => void;
  onNavigateFile?: (filePath: string) => void;
}

export const CanvasTextNode: FC<CanvasTextNodeProps> = ({
  node,
  isSelected: _isSelected,
  vaultPath,
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

  useEffect(() => {
    setEditText(node.text);
  }, [node.text]);

  const handleFinishEditing = (finalText: string = editText) => {
    setIsEditing(false);
    if (finalText !== node.text) {
      onUpdateText(finalText);
    }
  };

  // Fixed per card: changes only when the card is scaled from a corner (or pinched), never
  // while typing or when a side handle reshapes the card.
  const dynamicFontSize = getTextNodeFontSize(node);

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
            title="Edit text (Double-click)"
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
          <CanvasMarkdownEditor
            initialText={node.text}
            vaultPath={vaultPath}
            fontSize={dynamicFontSize}
            onChange={setEditText}
            onFinish={handleFinishEditing}
            onCancel={() => {
              setEditText(node.text);
              setIsEditing(false);
            }}
          />
        ) : (
          <div className="w-full h-full cursor-text" style={{ fontSize: `${dynamicFontSize}px` }}>
            {node.text.trim() ? (
              // Measured (cloned at other widths) to stop side handles from hiding the text.
              <div data-canvas-text-measure>
                <MarkdownViewer
                  content={node.text}
                  fontSize={dynamicFontSize}
                  onNavigateFile={onNavigateFile}
                />
              </div>
            ) : (
              <div
                style={{ fontSize: `${dynamicFontSize}px` }}
                className="text-zinc-500 italic h-full flex items-center justify-center text-center p-2"
              >
                Double-click to write...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
