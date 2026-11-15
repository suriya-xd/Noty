import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import type { FC, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import {
  X,
  ZoomIn,
  ZoomOut,
  RotateCw,
  Download,
  Copy,
  Check,
  Image as ImageIcon,
  Scan,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useBackLayer } from "../utils/backNavigation";

export interface ImagePreviewModalProps {
  isOpen: boolean;
  src: string;
  alt?: string;
  title?: string;
  onClose: () => void;
}

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * Full-screen image viewer. It opens with the image fitted to the screen and stays fitted when
 * the screen changes size or the image is rotated, until the user zooms. On phones the bars keep
 * clear of the status bar and the gesture area, every action is a full-size button, and the
 * image can be dragged and pinched.
 */
export const ImagePreviewModal: FC<ImagePreviewModalProps> = ({ isOpen, src, alt, title, onClose }) => {
  // On phones, Back closes this.
  useBackLayer(isOpen, onClose);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [rotation, setRotation] = useState(0);
  /** Following the screen size ("Fit"), until the user zooms by hand. */
  const [fitMode, setFitMode] = useState(true);
  const [isDragging, setIsDragging] = useState(false);

  const [naturalDimensions, setNaturalDimensions] = useState<{ width: number; height: number } | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  /** Active pointers on the image area (one drags, two pinch). */
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startPan: { x: number; y: number }; startZoom: number; startDist: number; startMid: { x: number; y: number } } | null>(null);

  // Derive readable title
  const displayTitle =
    title ||
    alt ||
    (src.startsWith("data:") ? "Embedded Image" : src.split("/").pop()?.split("?")[0] || "Image Preview");

  const ext =
    displayTitle.split(".").pop()?.toUpperCase() ||
    (src.startsWith("data:image/") ? src.substring(11, 15).toUpperCase() : "IMG");

  // Reset state whenever a new image is opened: it always starts fitted to the screen.
  useEffect(() => {
    if (isOpen) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setRotation(0);
      setFitMode(true);
      setIsLoading(true);
      setHasError(false);
      setNaturalDimensions(null);
    }
  }, [isOpen, src]);

  const fitZoom = useCallback((): number | null => {
    const container = containerRef.current;
    if (!container || !naturalDimensions) return null;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const margin = Math.min(32, Math.max(8, Math.min(w, h) * 0.04));
    const turned = rotation % 180 !== 0;
    const imgW = turned ? naturalDimensions.height : naturalDimensions.width;
    const imgH = turned ? naturalDimensions.width : naturalDimensions.height;
    if (!imgW || !imgH) return null;
    // Large images shrink to fit; small ones aren't blown up past their real size.
    return clampZoom(Math.min(1, (w - margin * 2) / imgW, (h - margin * 2) / imgH));
  }, [naturalDimensions, rotation]);

  const handleFitToScreen = useCallback(() => {
    const z = fitZoom();
    if (z !== null) setZoom(Number(z.toFixed(3)));
    setPan({ x: 0, y: 0 });
    setFitMode(true);
  }, [fitZoom]);

  // Stay fitted: when the image loads, is rotated, or the screen changes size. Done before
  // paint, so the image never shows at the wrong size first.
  useLayoutEffect(() => {
    if (!isOpen || !fitMode) return;
    handleFitToScreen();
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => handleFitToScreen());
    ro.observe(container);
    return () => ro.disconnect();
  }, [isOpen, fitMode, handleFitToScreen]);

  const zoomBy = (factor: number) => {
    setFitMode(false);
    setZoom((prev) => Number(clampZoom(prev * factor).toFixed(3)));
  };
  const handleZoomIn = () => zoomBy(1.25);
  const handleZoomOut = () => zoomBy(1 / 1.25);
  const handleActualSize = () => {
    setFitMode(false);
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const handleRotate = () => setRotation((prev) => (prev + 90) % 360);

  // Keyboard shortcuts
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
        handleActualSize();
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
    e.stopPropagation();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  };

  // Drag to pan (mouse or one finger); pinch with two fingers.
  const startGesture = () => {
    const pts = [...pointers.current.values()];
    const mid = pts.length >= 2 ? { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 } : pts[0];
    const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { startPan: pan, startZoom: zoom, startDist: dist, startMid: mid };
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    startGesture();
    setIsDragging(true);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    const pts = [...pointers.current.values()];
    if (pts.length >= 2 && g.startDist > 0) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      setFitMode(false);
      setZoom(clampZoom(g.startZoom * (dist / g.startDist)));
      setPan({ x: g.startPan.x + mid.x - g.startMid.x, y: g.startPan.y + mid.y - g.startMid.y });
    } else {
      setPan({ x: g.startPan.x + e.clientX - g.startMid.x, y: g.startPan.y + e.clientY - g.startMid.y });
    }
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size > 0) startGesture();
    else {
      gesture.current = null;
      setIsDragging(false);
    }
  };

  // Double click / double tap toggles between fitted and actual size
  const handleDoubleClick = () => {
    if (fitMode) handleActualSize();
    else handleFitToScreen();
  };

  // Copy image or link to clipboard
  const handleCopy = async () => {
    try {
      if (src.startsWith("http://") || src.startsWith("https://")) {
        await navigator.clipboard.writeText(src);
      } else {
        const res = await fetch(src);
        const blob = await res.blob();
        // Clipboards take PNG reliably; other formats are converted.
        const png = blob.type === "image/png" ? blob : await toPng(blob);
        await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      }
    } catch {
      try {
        await navigator.clipboard.writeText(src);
      } catch {
        return;
      }
    }
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
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

  const actions: Array<{ label: string; icon: LucideIcon; onClick: () => void; active?: boolean; tint?: string }> = [
    { label: "Zoom out (-)", icon: ZoomOut, onClick: handleZoomOut },
    { label: "Zoom in (+)", icon: ZoomIn, onClick: handleZoomIn },
    { label: "Fit to screen (F)", icon: Scan, onClick: handleFitToScreen, active: fitMode },
    { label: "Rotate 90° (R)", icon: RotateCw, onClick: handleRotate },
    { label: isCopied ? "Copied" : "Copy image", icon: isCopied ? Check : Copy, onClick: handleCopy, tint: isCopied ? "text-emerald-400" : "" },
    { label: "Download image", icon: Download, onClick: handleDownload },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={displayTitle}
      className="fixed inset-0 z-[100] flex flex-col bg-[#05070a]/95 backdrop-blur-xl animate-in fade-in duration-150 select-none overflow-hidden"
    >
      {/* Top bar: what's open, and Close. Kept below the phone's status bar. */}
      <div className="pt-safe shrink-0 z-10 border-b border-[#30363d]/70 bg-[#0d1117]/90 backdrop-blur-md">
        <div className="h-14 pl-4 pr-2 sm:px-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-purple-500/10 border border-purple-500/30 flex items-center justify-center shrink-0">
              <ImageIcon className="w-4 h-4 text-purple-400" />
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-white truncate" title={displayTitle}>
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
          <button
            type="button"
            onClick={onClose}
            aria-label="Close (Esc)"
            title="Close (Esc)"
            className="w-11 h-11 sm:w-9 sm:h-9 shrink-0 rounded-xl flex items-center justify-center text-zinc-300 hover:text-white hover:bg-red-500/20 active:bg-red-500/25 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Image area */}
      <div
        ref={containerRef}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        className={`flex-1 min-h-0 relative flex items-center justify-center overflow-hidden touch-none ${
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
          <div className="flex flex-col items-center justify-center gap-3 p-8 m-4 rounded-2xl bg-[#161b22] border border-red-500/30 text-center max-w-sm">
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-400">
              <ImageIcon className="w-6 h-6" />
            </div>
            <div className="text-sm font-semibold text-white">Image Failed to Load</div>
            <div className="text-xs text-zinc-400 font-mono break-all max-h-24 overflow-auto px-2">{src}</div>
            <button
              onClick={onClose}
              className="mt-2 h-10 px-4 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-sm text-white transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        ) : (
          <div
            style={{
              transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom}) rotate(${rotation}deg)`,
              transformOrigin: "center center",
              // Zooming by hand animates; fitting (on open, resize, rotate) applies at once.
              transition: isDragging || fitMode ? "none" : "transform 0.15s cubic-bezier(0.2, 0, 0, 1)",
              // Hidden until it has been fitted, so it never flashes at full size first.
              visibility: isLoading ? "hidden" : "visible",
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
                setNaturalDimensions({ width: img.naturalWidth, height: img.naturalHeight });
                setIsLoading(false);
              }}
              onError={() => {
                setIsLoading(false);
                setHasError(true);
              }}
              className="max-w-none rounded-lg pointer-events-none select-none"
              style={{
                boxShadow: "0 25px 60px -15px rgba(0, 0, 0, 0.7), 0 0 1px 1px rgba(255, 255, 255, 0.1)",
              }}
            />
          </div>
        )}
      </div>

      {/* Actions: all reachable on every screen size, clear of the phone's gesture bar. */}
      <div className="pb-safe shrink-0 z-10 border-t border-[#30363d]/60 bg-[#0d1117]/90 backdrop-blur-md">
        <div className="h-16 sm:h-12 px-2 sm:px-6 flex items-center justify-center sm:justify-between gap-1 text-xs text-zinc-400">
          <div className="hidden lg:flex items-center gap-1.5 text-[11px]">
            <span className="text-zinc-300">Scroll to zoom</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-300">Drag to pan</span>
            <span className="text-zinc-600">·</span>
            <span className="text-zinc-300">Double-click to toggle fit</span>
          </div>

          <div className="flex items-center gap-0.5 sm:gap-1">
            {actions.slice(0, 2).map((a) => (
              <ActionButton key={a.label} {...a} />
            ))}
            <button
              type="button"
              onClick={handleActualSize}
              title="Actual size (0)"
              aria-label={`Zoom ${zoomPercent}%. Show actual size`}
              className="h-11 sm:h-8 min-w-14 px-2 rounded-xl sm:rounded-lg font-mono text-xs text-zinc-300 hover:text-white hover:bg-[#21262d] active:bg-[#21262d] transition-colors cursor-pointer"
            >
              {zoomPercent}%
            </button>
            <span className="w-px h-6 bg-[#30363d] mx-1" />
            {actions.slice(2).map((a) => (
              <ActionButton key={a.label} {...a} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const ActionButton: FC<{ label: string; icon: LucideIcon; onClick: () => void; active?: boolean; tint?: string }> = ({
  label,
  icon: Icon,
  onClick,
  active,
  tint = "",
}) => (
  <button
    type="button"
    onClick={onClick}
    title={label}
    aria-label={label}
    aria-pressed={active}
    className={`w-11 h-11 sm:w-8 sm:h-8 rounded-xl sm:rounded-lg flex items-center justify-center transition-colors cursor-pointer active:bg-[#21262d] ${
      active ? "text-sky-400 bg-sky-500/10" : "text-zinc-300 hover:text-white hover:bg-[#21262d]"
    }`}
  >
    <Icon className={`w-5 h-5 sm:w-4 sm:h-4 ${tint}`} />
  </button>
);

/** Re-encodes an image as PNG (what clipboards accept). */
async function toPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't convert the image"))), "image/png")
  );
}
