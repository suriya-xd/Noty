import { useState, useEffect, useMemo } from "react";
import type { FC } from "react";
import { CanvasFileNode as ICanvasFileNode } from "../../types/canvas";
import { ExternalLink, AlertTriangle, Image as ImageIcon, Maximize2 } from "lucide-react";
import { resolveImageUrl } from "../../services/noeticBridge";
import { calculateCanvasNodeFontSize } from "../../utils/canvas/math";
import { stripMarkdownMarkers } from "../../utils/canvas/plainText";

interface CanvasFileNodeProps {
  node: ICanvasFileNode;
  vaultPath: string;
  /** The note is not in the vault (deleted or renamed outside the canvas). */
  isMissing?: boolean;
  onOpenFile?: (path: string) => void;
  onPreviewImage?: (src: string, alt?: string, title?: string) => void;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

export const CanvasFileNode: FC<CanvasFileNodeProps> = ({
  node,
  vaultPath,
  isMissing = false,
  onOpenFile,
  onPreviewImage,
}) => {
  const [imageError, setImageError] = useState(false);

  // Dynamically calculate font size based on current note width and height
  const dynamicFontSize = useMemo(
    () => calculateCanvasNodeFontSize(node.width, node.height),
    [node.width, node.height]
  );

  const fileExt = node.file.split(".").pop()?.toLowerCase() || "";
  const isImage =
    IMAGE_EXTENSIONS.has(fileExt) ||
    node.file.startsWith("data:image/") ||
    node.file.startsWith("http://") ||
    node.file.startsWith("https://") ||
    node.file.startsWith("blob:");

  useEffect(() => {
    setImageError(false);
  }, [node.file]);

  const handleOpenNote = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onOpenFile && node.file) {
      onOpenFile(node.file);
    }
  };

  const fileName = node.file.split("/").pop() || node.file;
  const resolvedSrc = isImage ? resolveImageUrl(node.file, vaultPath) : "";
  const noteTitle = stripMarkdownMarkers(fileName.replace(/\.md$/i, "")) || fileName;

  // Size the title to the card: as large as the card height allows, shrunk for long names.
  const titleFontSize = useMemo(() => {
    const byHeight = node.height * 0.3;
    const byWidth = (node.width * 2.2) / Math.max(noteTitle.length, 6);
    return Math.round(Math.min(96, Math.max(16, Math.min(byHeight, byWidth))));
  }, [node.width, node.height, noteTitle.length]);

  return (
    <div
      className="w-full h-full flex flex-col overflow-hidden bg-[#161b22] select-none"
      style={{ fontSize: `${dynamicFontSize}px` }}
      onDoubleClick={handleOpenNote}
    >
      {/* Node Header (images only — notes show their name as the card's title) */}
      {isImage && (
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#30363d]/60 bg-[#0d1117]/80 text-zinc-300 shrink-0">
          <div className="flex items-center gap-1.5 overflow-hidden min-w-0">
            <ImageIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span
              style={{ fontSize: `${Math.min(14, Math.max(11, Math.round(dynamicFontSize * 0.78)))}px` }}
              className="truncate font-medium text-white"
              title={node.file}
            >
              {fileName}
            </span>
            {node.subpath && (
              <span
                style={{ fontSize: `${Math.min(12, Math.max(10, Math.round(dynamicFontSize * 0.68)))}px` }}
                className="text-zinc-400 font-mono truncate"
                title={node.subpath}
              >
                {node.subpath}
              </span>
            )}
          </div>
          <button
              onClick={(e) => {
                e.stopPropagation();
                if (onPreviewImage) onPreviewImage(resolvedSrc, fileName);
              }}
              title="Open image preview (Click)"
              className="p-1 hover:text-purple-400 text-zinc-400 rounded transition-colors cursor-pointer shrink-0"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
        </div>
      )}

      {/* Content Body */}
      {isImage ? (
        <div className="flex-1 overflow-hidden p-3.5">
          <div
            onClick={(e) => {
              e.stopPropagation();
              if (onPreviewImage) onPreviewImage(resolvedSrc, fileName);
            }}
            className="w-full h-full flex items-center justify-center p-2 bg-[#0d1117]/40 rounded relative group cursor-pointer overflow-hidden"
          >
            {imageError ? (
              <div className="flex flex-col items-center justify-center text-center text-amber-400/90 gap-1.5">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
                <span style={{ fontSize: `${dynamicFontSize}px` }} className="font-medium">Image could not be loaded</span>
              </div>
            ) : (
              <img
                src={resolvedSrc}
                alt={fileName}
                className="max-w-full max-h-full object-contain rounded shadow group-hover:scale-[1.02] transition-transform duration-200"
                onError={() => setImageError(true)}
              />
            )}
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
              <span className="px-2.5 py-1 bg-[#161b22]/90 border border-purple-500/40 rounded-lg shadow-xl backdrop-blur-md flex items-center gap-1.5 text-purple-200 text-xs font-medium">
                <Maximize2 className="w-3.5 h-3.5 text-purple-400" />
                <span>Click to Preview</span>
              </span>
            </div>
          </div>
        </div>
      ) : (
        // Notes show only their name, large, filling the card. The content lives in the editor.
        <div className="relative flex-1 min-h-0 flex flex-col items-center justify-center gap-1.5 px-4 py-3 text-center overflow-hidden">
          <button
            onClick={handleOpenNote}
            title="Open note in editor (Double-click)"
            className="absolute top-1.5 right-1.5 p-1 hover:text-sky-400 text-zinc-500 rounded transition-colors cursor-pointer"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
          <span
            style={{ fontSize: `${titleFontSize}px`, lineHeight: 1.15 }}
            className={`font-semibold break-words max-w-full line-clamp-3 ${isMissing ? "text-zinc-500 line-through" : "text-white"}`}
            title={node.file}
          >
            {noteTitle}
          </span>
          {isMissing && (
            <span className="flex items-center gap-1 text-amber-400/90 text-xs font-medium">
              <AlertTriangle className="w-3.5 h-3.5" />
              Note not found
            </span>
          )}
        </div>
      )}
    </div>
  );
};
