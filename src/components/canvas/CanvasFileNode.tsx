import { useState, useEffect } from "react";
import type { FC } from "react";
import { CanvasFileNode as ICanvasFileNode } from "../../types/canvas";
import { MarkdownViewer } from "../MarkdownViewer";
import { FileText, ExternalLink, AlertTriangle, Image as ImageIcon } from "lucide-react";
import { GitVaultBridge } from "../../services/gitVaultBridge";

interface CanvasFileNodeProps {
  node: ICanvasFileNode;
  vaultPath: string;
  onOpenFile?: (path: string) => void;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

export const CanvasFileNode: FC<CanvasFileNodeProps> = ({
  node,
  vaultPath,
  onOpenFile,
}) => {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const fileExt = node.file.split(".").pop()?.toLowerCase() || "";
  const isImage = IMAGE_EXTENSIONS.has(fileExt);

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

  return (
    <div
      className="w-full h-full flex flex-col overflow-hidden bg-[#161b22] select-none"
      onDoubleClick={handleOpenNote}
    >
      {/* Node Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#30363d]/60 bg-[#0d1117]/80 text-xs text-zinc-300">
        <div className="flex items-center gap-1.5 overflow-hidden min-w-0">
          {isImage ? (
            <ImageIcon className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          ) : (
            <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          )}
          <span className="truncate font-medium text-xs text-white" title={node.file}>
            {fileName}
          </span>
          {node.subpath && (
            <span className="text-[10px] text-zinc-400 font-mono truncate" title={node.subpath}>
              {node.subpath}
            </span>
          )}
        </div>
        <button
          onClick={handleOpenNote}
          title="Open note in editor (Double-click)"
          className="p-1 hover:text-sky-400 text-zinc-400 rounded transition-colors cursor-pointer shrink-0"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content Body */}
      <div className="flex-1 overflow-auto p-3 text-xs">
        {isImage ? (
          <div className="w-full h-full flex items-center justify-center p-2 bg-[#0d1117]/40 rounded">
            <img
              src={`/api/gitvault/read_file_content?full_path=${encodeURIComponent(`${vaultPath}/${node.file}`)}`}
              alt={fileName}
              className="max-w-full max-h-full object-contain rounded shadow"
              onError={(e) => {
                // If API URL image loading fails, fallback error display
                (e.target as HTMLElement).style.display = "none";
                setError("Image could not be loaded");
              }}
            />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-amber-400/90 gap-1.5 py-4">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            <span className="text-xs font-medium">{error}</span>
            <span className="text-[10px] text-zinc-500 font-mono truncate max-w-full px-2">
              {node.file}
            </span>
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center h-full text-zinc-500 text-xs">
            Loading preview...
          </div>
        ) : content ? (
          <MarkdownViewer
            content={content}
            className="text-xs"
            onNavigateFile={(target) => onOpenFile && onOpenFile(target)}
          />
        ) : (
          <div className="text-zinc-500 italic text-xs h-full flex items-center justify-center">
            Empty note
          </div>
        )}
      </div>
    </div>
  );
};
