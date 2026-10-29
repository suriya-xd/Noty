import { useState, useEffect, useRef, useCallback } from "react";
import type { FC, MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import {
  X,
  ZoomIn,
  ZoomOut,
  Maximize2,
  RotateCw,
  Download,
  Copy,
  Check,
  Image as ImageIcon,
  Scan,
} from "lucide-react";

export interface ImagePreviewModalProps {
  isOpen: boolean;
  src: string;
  alt?: string;
  title?: string;
  onClose: () => void;
}

export const ImagePreviewModal: FC<ImagePreviewModalProps> = ({
  isOpen,
  src,
  alt,
  title,
  onClose,
}) => {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; panX: number; panY: number } | null>(null);

  const [naturalDimensions, setNaturalDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // Derive readable title
  const displayTitle =
    title ||
    alt ||
    (src.startsWith("data:")
      ? "Embedded Image"
      : src.split("/").pop()?.split("?")[0] || "Image Preview");

  const ext = displayTitle.split(".").pop()?.toUpperCase() || (src.startsWith("data:image/") ? src.substring(11, 15).toUpperCase() : "IMG");

  // Reset state whenever a new image is opened
  useEffect(() => {
    if (isOpen) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setRotation(0);
      setIsLoading(true);
      setHasError(false);
      setNaturalDimensions(null);
    }
  }, [isOpen, src]);

  const handleFitToScreen = useCallback(() => {
    if (!containerRef.current || !naturalDimensions) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    const containerW = containerRef.current.clientWidth - 80;
    const containerH = containerRef.current.clientHeight - 140;

    const isRotated90or270 = rotation % 180 !== 0;
    const imgW = isRotated90or270 ? naturalDimensions.height : naturalDimensions.width;
    const imgH = isRotated90or270 ? naturalDimensions.width : naturalDimensions.height;

    const scaleW = containerW / imgW;
    const scaleH = containerH / imgH;
    const fitScale = Math.min(1, Math.min(scaleW, scaleH));

    setZoom(Number(fitScale.toFixed(2)));
    setPan({ x: 0, y: 0 });
  }, [naturalDimensions, rotation]);

  const handleResetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleZoomIn = () => {
    setZoom((prev) => Math.min(6, Number((prev * 1.25).toFixed(2))));
  };

  const handleZoomOut = () => {
    setZoom((prev) => Math.max(0.1, Number((prev / 1.25).toFixed(2))));
  };

  const handleRotate = () => {
    setRotation((prev) => (prev + 90) % 360);
  };

  // Keyboard navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        handleZoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        handleZoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        handleResetZoom();
      } else if (e.key.toLowerCase() === "f") {
        e.preventDefault();
        handleFitToScreen();
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        handleRotate();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, handleFitToScreen]);

  // Wheel zoom
  const handleWheel = (e: ReactWheelEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const factor = e.deltaY < 0 ? 1.15 : 0.85;
    setZoom((prev) => {
      const next = prev * factor;
      return Math.min(6, Math.max(0.1, Number(next.toFixed(2))));
    });
  };

  // Drag pan
  const handleMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      panX: pan.x,
      panY: pan.y,
    };
  };

  const handleMouseMove = (e: ReactMouseEvent) => {
    if (!isDragging || !dragStartRef.current) return;
    const dx = e.clientX - dragStartRef.current.mouseX;
    const dy = e.clientY - dragStartRef.current.mouseY;
    setPan({
      x: dragStartRef.current.panX + dx,
      y: dragStartRef.current.panY + dy,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    dragStartRef.current = null;
  };

  // Double click toggles between fit & 100%
  const handleDoubleClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    if (zoom === 1) {
      handleFitToScreen();
    } else {
      handleResetZoom();
    }
  };

  // Copy image or link to clipboard
  const handleCopy = async () => {
    try {
      if (src.startsWith("http://") || src.startsWith("https://")) {
        await navigator.clipboard.writeText(src);
      } else if (imageRef.current) {
        // Fetch and copy blob
        const res = await fetch(src);
        const blob = await res.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      }
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // Fallback: copy url string
      await navigator.clipboard.writeText(src);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  // Download image file
  const handleDownload = () => {
    const a = document.createElement("a");
    a.href = src;
    a.download = displayTitle.includes(".") ? displayTitle : `${displayTitle}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (!isOpen) return null;

  const zoomPercent = Math.round(zoom * 100);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-[#05070a]/90 backdrop-blur-xl animate-in fade-in duration-150 select-none overflow-hidden"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Top Controls Bar */}
      <div className="h-14 border-b border-[#30363d]/70 bg-[#0d1117]/80 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between z-10 shrink-0">
        {/* Left: Metadata */}
        <div className="flex items-center gap-3 overflow-hidden min-w-0 pr-4">
          <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
            <ImageIcon className="w-4 h-4 text-purple-400" />
          </div>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-white truncate max-w-xs sm:max-w-md" title={displayTitle}>
                {displayTitle}
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-medium bg-[#21262d] text-zinc-300 border border-[#30363d] shrink-0">
                {ext}
              </span>
            </div>
            {naturalDimensions && (
              <span className="text-[11px] text-zinc-400 font-mono">
                {naturalDimensions.width} × {naturalDimensions.height} px
              </span>
            )}
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Zoom Out */}
          <button
            type="button"
            onClick={handleZoomOut}
            title="Zoom out (-)"
            className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer"
          >
            <ZoomOut className="w-4 h-4" />
          </button>

          {/* Reset Zoom / Percent */}
          <button
            type="button"
            onClick={handleResetZoom}
            title="Reset to 100% (0)"
            className="px-2.5 py-1 rounded-lg text-zinc-300 hover:text-white hover:bg-[#21262d] font-mono text-xs transition-colors cursor-pointer min-w-14 text-center border border-transparent hover:border-[#30363d]"
          >
            {zoomPercent}%
          </button>

          {/* Zoom In */}
          <button
            type="button"
            onClick={handleZoomIn}
            title="Zoom in (+)"
            className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer"
          >
            <ZoomIn className="w-4 h-4" />
          </button>

          <div className="w-px h-5 bg-[#30363d] mx-1 hidden sm:block" />

          {/* Fit to Screen */}
          <button
            type="button"
            onClick={handleFitToScreen}
            title="Fit to window (F)"
            className="p-1.5 rounded-lg text-zinc-300 hover:text-sky-400 hover:bg-[#21262d] transition-colors cursor-pointer hidden sm:block"
          >
            <Maximize2 className="w-4 h-4" />
          </button>

          {/* Rotate */}
          <button
            type="button"
            onClick={handleRotate}
            title="Rotate 90° (R)"
            className="p-1.5 rounded-lg text-zinc-300 hover:text-purple-400 hover:bg-[#21262d] transition-colors cursor-pointer hidden sm:block"
          >
            <RotateCw className="w-4 h-4" />
          </button>

          {/* Copy Image / Link */}
          <button
            type="button"
            onClick={handleCopy}
            title="Copy Image / URL to clipboard"
            className="p-1.5 rounded-lg text-zinc-300 hover:text-emerald-400 hover:bg-[#21262d] transition-colors cursor-pointer"
          >
            {isCopied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          </button>

          {/* Download */}
          <button
            type="button"
            onClick={handleDownload}
            title="Download image file"
            className="p-1.5 rounded-lg text-zinc-300 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer hidden sm:block"
          >
            <Download className="w-4 h-4" />
          </button>

          <div className="w-px h-5 bg-[#30363d] mx-1" />

          {/* Close */}
          <button
            type="button"
            onClick={onClose}
            title="Close Preview (Esc)"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-red-500/20 hover:border-red-500/40 border border-transparent transition-all cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main Interactive Stage */}
      <div
        ref={containerRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        className={`flex-1 relative flex items-center justify-center overflow-hidden ${
          isDragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        style={{
          backgroundImage: `radial-gradient(circle, rgba(148, 163, 184, 0.08) 1px, transparent 1px)`,
          backgroundSize: "24px 24px",
        }}
      >
        {isLoading && !hasError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-400 text-xs gap-3">
            <div className="w-8 h-8 rounded-full border-2 border-purple-500/30 border-t-purple-400 animate-spin" />
            <span>Loading image...</span>
          </div>
        )}

        {hasError ? (
          <div className="flex flex-col items-center justify-center gap-3 p-8 rounded-2xl bg-[#161b22] border border-red-500/30 text-center max-w-sm">
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-400">
              <ImageIcon className="w-6 h-6" />
            </div>
            <div className="text-sm font-semibold text-white">Image Failed to Load</div>
            <div className="text-xs text-zinc-400 font-mono break-all max-h-24 overflow-auto px-2">
              {src}
            </div>
            <button
              onClick={onClose}
              className="mt-2 px-4 py-1.5 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-xs text-white transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        ) : (
          <div
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom}) rotate(${rotation}deg)`,
              transformOrigin: "center center",
              transition: isDragging ? "none" : "transform 0.15s cubic-bezier(0.2, 0, 0, 1)",
            }}
            className="relative will-change-transform max-w-none"
          >
            <img
              ref={imageRef}
              src={src}
              alt={alt || displayTitle}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNaturalDimensions({
                  width: img.naturalWidth,
                  height: img.naturalHeight,
                });
                setIsLoading(false);
              }}
              onError={() => {
                setIsLoading(false);
                setHasError(true);
              }}
              className="max-w-none rounded-lg shadow-2xl pointer-events-none select-none"
              style={{
                boxShadow: "0 25px 60px -15px rgba(0, 0, 0, 0.7), 0 0 1px 1px rgba(255, 255, 255, 0.1)",
              }}
            />
          </div>
        )}
      </div>

      {/* Bottom Floating Bar */}
      <div className="h-12 border-t border-[#30363d]/60 bg-[#0d1117]/80 backdrop-blur-md px-6 flex items-center justify-between z-10 shrink-0 text-xs text-zinc-400">
        <div className="hidden sm:flex items-center gap-1.5 text-[11px]">
          <span>Tip:</span>
          <span className="text-zinc-300">Scroll to zoom</span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-300">Drag to pan</span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-300">Double-click to toggle fit</span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-300">Esc to close</span>
        </div>

        {/* Zoom Quick Presets */}
        <div className="flex items-center gap-1.5 ml-auto">
          {[0.5, 1, 1.5, 2].map((val) => (
            <button
              key={val}
              type="button"
              onClick={() => setZoom(val)}
              className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors cursor-pointer ${
                zoom === val
                  ? "bg-purple-500/20 text-purple-300 border border-purple-500/40"
                  : "text-zinc-400 hover:text-white hover:bg-[#21262d]"
              }`}
            >
              {Math.round(val * 100)}%
            </button>
          ))}
          <button
            type="button"
            onClick={handleFitToScreen}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-zinc-400 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer"
          >
            <Scan className="w-3 h-3" />
            <span>Fit</span>
          </button>
        </div>
      </div>
    </div>
  );
};
