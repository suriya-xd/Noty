import { useMemo } from "react";
import type { FC } from "react";
import { CanvasLinkNode as ICanvasLinkNode } from "../../types/canvas";
import { Globe, ExternalLink } from "lucide-react";
import { calculateCanvasNodeFontSize } from "../../utils/canvas/math";

interface CanvasLinkNodeProps {
  node: ICanvasLinkNode;
}

export const CanvasLinkNode: FC<CanvasLinkNodeProps> = ({ node }) => {
  const dynamicFontSize = useMemo(
    () => calculateCanvasNodeFontSize(node.width, node.height),
    [node.width, node.height]
  );

  let hostname = "";
  try {
    hostname = new URL(node.url).hostname;
  } catch {
    hostname = node.url;
  }

  const handleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.url) {
      window.open(node.url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div
      className="w-full h-full flex flex-col justify-between p-4 bg-[#161b22] select-none hover:bg-[#1c222b] transition-colors rounded-lg group"
      style={{ fontSize: `${dynamicFontSize}px` }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center shrink-0">
            <Globe className="w-4 h-4 text-sky-400" />
          </div>
          <div className="overflow-hidden">
            <div
              style={{ fontSize: `${Math.min(18, Math.max(12, Math.round(dynamicFontSize * 0.88)))}px` }}
              className="font-semibold text-white truncate"
              title={node.url}
            >
              {hostname}
            </div>
            <div
              style={{ fontSize: `${Math.min(13, Math.max(10, Math.round(dynamicFontSize * 0.7)))}px` }}
              className="text-zinc-400 font-mono truncate"
              title={node.url}
            >
              {node.url}
            </div>
          </div>
        </div>

        <button
          onClick={handleOpen}
          title="Open in browser"
          className="p-1.5 rounded-md bg-[#21262d] hover:bg-sky-500/20 hover:text-sky-300 text-zinc-400 transition-all cursor-pointer shrink-0"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </button>
      </div>

      <div
        style={{ fontSize: `${Math.min(13, Math.max(10, Math.round(dynamicFontSize * 0.72)))}px` }}
        className="mt-3 pt-2 border-t border-[#30363d]/50 flex items-center justify-between text-zinc-400"
      >
        <span className="truncate">Web Link Bookmark</span>
        <button
          onClick={handleOpen}
          className="text-sky-400 hover:underline flex items-center gap-1 cursor-pointer shrink-0"
        >
          Visit site &rarr;
        </button>
      </div>
    </div>
  );
};
