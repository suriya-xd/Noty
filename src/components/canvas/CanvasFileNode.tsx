import { useState, useEffect, useMemo } from "react";
import type { FC } from "react";
import { CanvasFileNode as ICanvasFileNode } from "../../types/canvas";
import { MarkdownViewer } from "../MarkdownViewer";
import { FileText, ExternalLink, AlertTriangle, Image as ImageIcon, Maximize2 } from "lucide-react";
import { GitVaultBridge, resolveImageUrl } from "../../services/gitVaultBridge";
import { calculateCanvasNodeFontSize } from "../../utils/canvas/math";

interface CanvasFileNodeProps {
  node: ICanvasFileNode;
  vaultPath: string;
  onOpenFile?: (path: string) => void;
  onPreviewImage?: (src: string, alt?: string, title?: string) => void;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

export const CanvasFileNode: FC<CanvasFileNodeProps> = ({
  node,
  vaultPath,
  onOpenFile,
  onPreviewImage,
}) => {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

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
    if (!node.file) {
      setError("No file specified");
      return;
    }
    if (isImage) {
      return; // Handled directly via img src
    }

    let isMounted = true;
    setIsLoading(true);
    setError(null);

    const fullPath = `${vaultPath}/${node.file}`;
    GitVaultBridge.readFileContent(fullPath)
      .then((text) => {
        if (!isMounted) return;
        setContent(text);
        setError(null);
      })
      .catch((err) => {
        if (!isMounted) return;
        console.warn(`Canvas file node failed to read ${node.file}:`, err);
        setError("File not found or unreadable");
      })
      .finally(() => {
        if (isMounted) setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [node.file, vaultPath, isImage]);

  const handleOpenNote = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onOpenFile && node.file) {
      onOpenFile(node.file);
    }
  };

  const fileName = node.file.split("/").pop() || node.file;
  const resolvedSrc = isImage ? resolveImageUrl(node.file, vaultPath) : "";

  return (
    <div
      className="w-full h-full flex flex-col overflow-hidden bg-[#161b22] select-none"
      style={{ fontSize: `${dynamicFontSize}px` }}
      onDoubleClick={handleOpenNote}
    >
      {/* Node Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#30363d]/60 bg-[#0d1117]/80 text-zinc-300 shrink-0">
        <div className="flex items-center gap-1.5 overflow-hidden min-w-0">
          {isImage ? (
            <ImageIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          ) : (
            <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          )}
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
        {isImage ? (
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
        ) : (
          <button
            onClick={handleOpenNote}
            title="Open note in editor (Double-click)"
            className="p-1 hover:text-sky-400 text-zinc-400 rounded transition-colors cursor-pointer shrink-0"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Content Body */}
      <div
        className="flex-1 overflow-auto p-3.5"
        style={{ fontSize: `${dynamicFontSize}px` }}
      >
        {isImage ? (
          <div
            onClick={(e) => {
              e.stopPropagation();
              if (onPreviewImage) onPreviewImage(resolvedSrc, fileName);
            }}
            className="w-full h-full flex items-center justify-center p-2 bg-[#0d1117]/40 rounded relative group cursor-pointer overflow-hidden"
          >
            <img
              src={resolvedSrc}
              alt={fileName}
              className="max-w-full max-h-full object-contain rounded shadow group-hover:scale-[1.02] transition-transform duration-200"
              onError={() => {
                setError("Image could not be loaded");
              }}
            />
            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
              <span className="px-2.5 py-1 bg-[#161b22]/90 border border-purple-500/40 rounded-lg shadow-xl backdrop-blur-md flex items-center gap-1.5 text-purple-200 text-xs font-medium">
                <Maximize2 className="w-3.5 h-3.5 text-purple-400" />
                <span>Click to Preview</span>
              </span>
            </div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-amber-400/90 gap-1.5 py-4">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <span style={{ fontSize: `${dynamicFontSize}px` }} className="font-medium">{error}</span>
            <span
              style={{ fontSize: `${Math.max(10, Math.round(dynamicFontSize * 0.72))}px` }}
              className="text-zinc-500 font-mono truncate max-w-full px-2"
            >
              {node.file}
            </span>
          </div>
        ) : isLoading ? (
          <div style={{ fontSize: `${dynamicFontSize}px` }} className="flex items-center justify-center h-full text-zinc-500">
            Loading preview...
          </div>
        ) : content ? (
          <MarkdownViewer
            content={content}
            vaultPath={vaultPath}
            fontSize={dynamicFontSize}
            onPreviewImage={onPreviewImage}
            onNavigateFile={(target) => onOpenFile && onOpenFile(target)}
          />
        ) : (
          <div style={{ fontSize: `${dynamicFontSize}px` }} className="text-zinc-500 italic h-full flex items-center justify-center">
            Empty note
          </div>
        )}
      </div>
    </div>
  );
};
