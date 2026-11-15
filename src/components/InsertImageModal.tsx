import { useEscapeKey } from "./dialogs";
import { useState, useMemo, useRef, useEffect } from "react";
import type { FC, ChangeEvent, DragEvent } from "react";
import { VaultEntry } from "../types/noetic";
import { resolveImageUrl } from "../services/noeticBridge";
import {
  altTextFor,
  imageFromDataTransfer,
  isImageFile,
  peekClipboardImage,
  readClipboardImage,
  saveImageToAssets,
} from "../utils/imageUpload";
import {
  X,
  Upload,
  Image as ImageIcon,
  Globe,
  FolderOpen,
  Search,
  Check,
  AlertCircle,
  ClipboardPaste,
} from "lucide-react";
import { useBackLayer } from "../utils/backNavigation";

export interface InsertImageModalProps {
  isOpen: boolean;
  vaultPath: string;
  vaultFiles: VaultEntry[];
  onClose: () => void;
  onInsertImage: (imagePathOrUrl: string, altText?: string) => void;
  onRefreshFiles?: () => Promise<void>;
  title?: string;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp"]);

export const InsertImageModal: FC<InsertImageModalProps> = ({
  isOpen,
  vaultPath,
  vaultFiles,
  onClose,
  onInsertImage,
  onRefreshFiles,
  title = "Insert Image",
}) => {
  // On phones, Back closes this.
  useBackLayer(isOpen, onClose);
  useEscapeKey(isOpen, onClose);
  const [activeTab, setActiveTab] = useState<"upload" | "vault" | "url">("upload");

  // Tab 1: Upload state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [uploadAlt, setUploadAlt] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tab 2: Vault images state
  const [vaultSearch, setVaultSearch] = useState("");
  const [selectedVaultImage, setSelectedVaultImage] = useState<string | null>(null);
  const [vaultAlt, setVaultAlt] = useState("");

  // Tab 3: URL state
  const [imageUrl, setImageUrl] = useState("");
  const [urlAlt, setUrlAlt] = useState("");
  const [urlPreviewValid, setUrlPreviewValid] = useState<boolean | null>(null);

  // Error state
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  /** The chosen image came from the clipboard (shown as such). */
  const [fromClipboard, setFromClipboard] = useState(false);
  const [clipboardHint, setClipboardHint] = useState<string | null>(null);
  const acceptFileRef = useRef<(file: File, clipboard?: boolean) => void>(() => {});

  // Each time the dialog opens: start clean, take an image that's already on the clipboard when
  // that can be read without asking, and accept a paste (Ctrl/Cmd+V) at any point.
  useEffect(() => {
    if (!isOpen) return;
    setSelectedFile(null);
    setUploadPreview(null);
    setErrorMessage(null);
    setClipboardHint(null);
    setFromClipboard(false);
    let cancelled = false;
    void peekClipboardImage().then((file) => {
      if (file && !cancelled) acceptFileRef.current(file, true);
    });
    const onPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return; // already taken by the paste box
      const file = imageFromDataTransfer(e.clipboardData);
      if (!file) return;
      e.preventDefault();
      acceptFileRef.current(file, true);
    };
    window.addEventListener("paste", onPaste);
    return () => {
      cancelled = true;
      window.removeEventListener("paste", onPaste);
    };
  }, [isOpen]);

  // Filter vault files to images
  const existingImages = useMemo(() => {
    return vaultFiles
      .filter((f) => !f.is_directory)
      .filter((f) => {
        const ext = f.name.split(".").pop()?.toLowerCase() || "";
        return IMAGE_EXTENSIONS.has(ext);
      })
      .filter((f) => f.path.toLowerCase().includes(vaultSearch.toLowerCase().trim()));
  }, [vaultFiles, vaultSearch]);

  if (!isOpen) return null;

  // Handle file selection from disk or the clipboard
  const handleFileChange = (file: File, clipboard = false) => {
    if (!isImageFile(file)) {
      setErrorMessage("Please select a supported image file (PNG, JPG, GIF, WebP, SVG, BMP)");
      return;
    }
    setErrorMessage(null);
    setClipboardHint(null);
    setActiveTab("upload");
    setFromClipboard(clipboard);
    setSelectedFile(file);
    setUploadAlt(altTextFor(file));

    const reader = new FileReader();
    reader.onload = (e) => {
      setUploadPreview(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  acceptFileRef.current = handleFileChange;

  /** The Paste button: reads the clipboard (the tap counts as permission where one is needed). */
  const handlePasteButton = async () => {
    const file = await readClipboardImage();
    if (file) handleFileChange(file, true);
    else
      setClipboardHint(
        "Couldn't find an image on the clipboard. Copy one first, or long-press the box below and choose Paste."
      );
  };

  const onFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileChange(e.target.files[0]);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileChange(e.dataTransfer.files[0]);
    }
  };

  // Submit Tab 1: Upload to vault and insert
  const handleConfirmUpload = async () => {
    if (!selectedFile || !uploadPreview) return;
    setIsUploading(true);
    setErrorMessage(null);

    try {
      // Saved in the assets folder under a free name, so an existing image is never replaced.
      const relPath = await saveImageToAssets(
        vaultPath,
        selectedFile,
        vaultFiles.map((f) => f.path)
      );

      // Refresh files list in App
      if (onRefreshFiles) {
        await onRefreshFiles();
      }

      onInsertImage(relPath, uploadAlt.trim() || undefined);
      onClose();
    } catch (err) {
      console.error("Failed to save image file:", err);
      setErrorMessage(`Failed to save image: ${err}`);
    } finally {
      setIsUploading(false);
    }
  };

  // Submit Tab 2: Select from vault
  const handleConfirmVaultImage = () => {
    if (!selectedVaultImage) return;
    onInsertImage(selectedVaultImage, vaultAlt.trim() || undefined);
    onClose();
  };

  // Submit Tab 3: URL
  const handleConfirmUrl = () => {
    if (!imageUrl.trim()) return;
    onInsertImage(imageUrl.trim(), urlAlt.trim() || undefined);
    onClose();
  };

  return (
    <div className="app-modal fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4 animate-in fade-in duration-100">
      <div className="app-modal-panel w-full max-w-xl bg-[#161b22] border border-[#30363d] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
        {/* Modal Header */}
        <div className="px-5 py-3.5 border-b border-[#21262d] flex items-center justify-between bg-[#0d1117]/60">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 shrink-0 rounded-lg bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400">
              <ImageIcon className="w-4 h-4" />
            </div>
            <span className="text-sm font-semibold text-white truncate">{title}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-white rounded-md hover:bg-[#21262d] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center border-b border-[#21262d] px-3 sm:px-5 bg-[#0d1117]/30 text-xs overflow-x-auto no-scrollbar [&>button]:whitespace-nowrap [&>button]:shrink-0">
          <button
            type="button"
            onClick={() => { setActiveTab("upload"); setErrorMessage(null); }}
            className={`flex items-center gap-1.5 py-3 px-3 font-medium border-b-2 transition-all cursor-pointer ${
              activeTab === "upload"
                ? "border-purple-500 text-purple-300 bg-purple-500/5"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Upload className="w-3.5 h-3.5" />
            <span className="sm:hidden">Upload</span>
            <span className="hidden sm:inline">Upload from Device</span>
          </button>

          <button
            type="button"
            onClick={() => { setActiveTab("vault"); setErrorMessage(null); }}
            className={`flex items-center gap-1.5 py-3 px-3 font-medium border-b-2 transition-all cursor-pointer ${
              activeTab === "vault"
                ? "border-purple-500 text-purple-300 bg-purple-500/5"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>My images ({existingImages.length})</span>
          </button>

          <button
            type="button"
            onClick={() => { setActiveTab("url"); setErrorMessage(null); }}
            className={`flex items-center gap-1.5 py-3 px-3 font-medium border-b-2 transition-all cursor-pointer ${
              activeTab === "url"
                ? "border-purple-500 text-purple-300 bg-purple-500/5"
                : "border-transparent text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Web URL</span>
          </button>
        </div>

        {/* Error Alert */}
        {errorMessage && (
          <div className="mx-5 mt-3 p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 flex items-center gap-2 text-xs text-red-300">
            <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Tab Content Body */}
        <div className="flex-1 overflow-y-auto p-5 text-xs">
          {/* ================= TAB 1: UPLOAD ================= */}
          {activeTab === "upload" && (
            <div className="flex flex-col gap-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={onFileInputChange}
                className="hidden"
              />

              {!uploadPreview ? (
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center transition-all cursor-pointer ${
                    isDragOver
                      ? "border-purple-500 bg-purple-500/10"
                      : "border-[#30363d] hover:border-purple-500/60 bg-[#0d1117]/40 hover:bg-[#161b22]"
                  }`}
                >
                  <div className="w-12 h-12 rounded-full bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400 mb-3">
                    <Upload className="w-6 h-6" />
                  </div>
                  <span className="text-sm font-semibold text-zinc-200">
                    Click to choose an image or drag & drop
                  </span>
                  <span className="text-zinc-500 text-[11px] mt-1">
                    Supports PNG, JPG, GIF, WebP, SVG, BMP
                  </span>
                  <span className="text-zinc-600 font-mono text-[10px] mt-2">
                    The image is saved with your notes, in the assets folder
                  </span>
                </div>
              ) : null}

              {/* Paste an image that's on the clipboard */}
              {!uploadPreview && (
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={handlePasteButton}
                    className="h-11 rounded-xl border border-[#30363d] bg-[#0d1117]/60 hover:bg-[#21262d] active:bg-[#21262d] text-sm font-medium text-zinc-200 flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <ClipboardPaste className="w-4 h-4 text-purple-400" />
                    Paste image from clipboard
                  </button>
                  <div
                    contentEditable
                    suppressContentEditableWarning
                    role="textbox"
                    aria-label="Paste an image here"
                    inputMode="none"
                    onPaste={(e) => {
                      e.preventDefault();
                      const file = imageFromDataTransfer(e.clipboardData);
                      if (file) handleFileChange(file, true);
                      else setClipboardHint("That wasn't an image. Copy an image, then paste it here.");
                    }}
                    onBeforeInput={(e) => {
                      // Images from a phone keyboard's clipboard arrive as an input, not a paste.
                      const ev = e.nativeEvent as InputEvent;
                      e.preventDefault();
                      const file = imageFromDataTransfer(ev.dataTransfer);
                      if (file) handleFileChange(file, true);
                    }}
                    className="min-h-11 px-3 py-2.5 rounded-xl border border-dashed border-[#30363d] text-center text-[12px] text-zinc-500 outline-none focus:border-purple-500/70 focus:text-zinc-300 select-text"
                  >
                    Or press Ctrl/⌘+V — on a phone, long-press here and choose Paste
                  </div>
                  {clipboardHint && <p className="text-[11px] text-amber-300/90 px-1">{clipboardHint}</p>}
                </div>
              )}

              {uploadPreview && (
                <div className="flex flex-col gap-3">
                  <div className="relative rounded-xl overflow-hidden border border-[#30363d] bg-[#0d1117] max-h-52 flex items-center justify-center p-2 group">
                    <img
                      src={uploadPreview}
                      alt="Upload preview"
                      className="max-h-48 max-w-full object-contain rounded"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFile(null);
                        setUploadPreview(null);
                      }}
                      className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/70 hover:bg-black text-white hover:text-red-400 transition-colors"
                      title="Remove image"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="flex items-center justify-between text-zinc-400 text-[11px] px-1 font-mono">
                    <span className="truncate max-w-xs">{fromClipboard ? "Image from your clipboard" : selectedFile?.name}</span>
                    <span>{selectedFile ? (selectedFile.size / 1024).toFixed(1) + " KB" : ""}</span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-zinc-300 font-medium">Alt Text / Caption (Optional)</label>
                    <input
                      type="text"
                      value={uploadAlt}
                      onChange={(e) => setUploadAlt(e.target.value)}
                      placeholder="e.g., Application Architecture Diagram"
                      className="bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-500 outline-none focus:border-purple-500 transition-colors"
                    />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ================= TAB 2: VAULT IMAGES ================= */}
          {activeTab === "vault" && (
            <div className="flex flex-col gap-3">
              {/* Search */}
              <div className="relative">
                <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={vaultSearch}
                  onChange={(e) => setVaultSearch(e.target.value)}
                  placeholder="Filter images by name or path..."
                  className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-zinc-500 outline-none focus:border-purple-500 transition-colors"
                />
              </div>

              {existingImages.length === 0 ? (
                <div className="text-center py-12 text-zinc-500 flex flex-col items-center gap-2">
                  <ImageIcon className="w-8 h-8 text-zinc-600 stroke-[1.5]" />
                  <span>No images in this workspace yet</span>
                  <button
                    onClick={() => setActiveTab("upload")}
                    className="mt-1 text-purple-400 hover:underline text-xs"
                  >
                    Upload an image from your device
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-64 overflow-y-auto pr-1">
                  {existingImages.map((img) => {
                    const isSelected = selectedVaultImage === img.path;
                    const resolvedSrc = resolveImageUrl(img.path, vaultPath);
                    return (
                      <button
                        key={img.path}
                        type="button"
                        onClick={() => {
                          setSelectedVaultImage(img.path);
                          if (!vaultAlt) {
                            setVaultAlt(img.name.replace(/\.[^/.]+$/, ""));
                          }
                        }}
                        className={`group relative rounded-xl border p-2 flex flex-col gap-1.5 transition-all text-left cursor-pointer ${
                          isSelected
                            ? "border-purple-500 bg-purple-500/10 ring-2 ring-purple-500/40"
                            : "border-[#30363d] hover:border-zinc-500 bg-[#0d1117]/60 hover:bg-[#161b22]"
                        }`}
                      >
                        <div className="w-full h-24 rounded-lg bg-[#0d1117] overflow-hidden flex items-center justify-center relative">
                          <img
                            src={resolvedSrc}
                            alt={img.name}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                            loading="lazy"
                          />
                          {isSelected && (
                            <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-purple-500 flex items-center justify-center text-white shadow">
                              <Check className="w-3 h-3 stroke-[3]" />
                            </div>
                          )}
                        </div>
                        <span className="text-[11px] font-medium text-zinc-200 truncate group-hover:text-white" title={img.name}>
                          {img.name}
                        </span>
                        <span className="text-[9px] text-zinc-500 font-mono truncate">
                          {img.path}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {selectedVaultImage && (
                <div className="flex flex-col gap-1.5 mt-2 pt-3 border-t border-[#21262d]">
                  <label className="text-zinc-300 font-medium">Alt Text / Caption (Optional)</label>
                  <input
                    type="text"
                    value={vaultAlt}
                    onChange={(e) => setVaultAlt(e.target.value)}
                    placeholder="e.g., Note diagram illustration"
                    className="bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-500 outline-none focus:border-purple-500 transition-colors"
                  />
                </div>
              )}
            </div>
          )}

          {/* ================= TAB 3: WEB URL ================= */}
          {activeTab === "url" && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-zinc-300 font-medium">Image URL</label>
                <div className="relative">
                  <Globe className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="url"
                    value={imageUrl}
                    onChange={(e) => {
                      setImageUrl(e.target.value);
                      setUrlPreviewValid(null);
                    }}
                    placeholder="https://example.com/images/architecture.png"
                    className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-zinc-500 outline-none focus:border-purple-500 transition-colors font-mono"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-zinc-300 font-medium">Alt Text / Caption (Optional)</label>
                <input
                  type="text"
                  value={urlAlt}
                  onChange={(e) => setUrlAlt(e.target.value)}
                  placeholder="e.g., Cloud Architecture Overview"
                  className="bg-[#0d1117] border border-[#30363d] rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-500 outline-none focus:border-purple-500 transition-colors"
                />
              </div>

              {imageUrl.trim() && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] text-zinc-400 font-medium">Preview</span>
                  <div className="rounded-xl border border-[#30363d] bg-[#0d1117] p-2 flex items-center justify-center max-h-48 overflow-hidden">
                    <img
                      src={imageUrl}
                      alt="URL preview"
                      onLoad={() => setUrlPreviewValid(true)}
                      onError={() => setUrlPreviewValid(false)}
                      className="max-h-44 max-w-full object-contain rounded"
                    />
                  </div>
                  {urlPreviewValid === false && (
                    <span className="text-amber-400 text-[11px] flex items-center gap-1">
                      <AlertCircle className="w-3.5 h-3.5" />
                      Unable to load preview from this URL. Check URL or CORS settings.
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer Actions */}
        <div className="px-4 sm:px-5 py-3 border-t border-[#21262d] bg-[#0d1117]/60 flex items-center justify-end gap-2.5 [&>button]:flex-1 sm:[&>button]:flex-none [&>button]:justify-center">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-xl border border-[#30363d] text-zinc-400 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer text-xs font-medium"
          >
            Cancel
          </button>

          {activeTab === "upload" && (
            <button
              type="button"
              onClick={handleConfirmUpload}
              disabled={!selectedFile || isUploading}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-medium transition-all shadow-md ${
                selectedFile && !isUploading
                  ? "bg-purple-600 hover:bg-purple-500 text-white cursor-pointer shadow-purple-500/20"
                  : "bg-purple-900/40 text-purple-300/40 border border-purple-800/30 cursor-not-allowed"
              }`}
            >
              {isUploading ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Saving…</span>
                </>
              ) : (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Insert Image</span>
                </>
              )}
            </button>
          )}

          {activeTab === "vault" && (
            <button
              type="button"
              onClick={handleConfirmVaultImage}
              disabled={!selectedVaultImage}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-medium transition-all shadow-md ${
                selectedVaultImage
                  ? "bg-purple-600 hover:bg-purple-500 text-white cursor-pointer shadow-purple-500/20"
                  : "bg-purple-900/40 text-purple-300/40 border border-purple-800/30 cursor-not-allowed"
              }`}
            >
              <Check className="w-3.5 h-3.5" />
              <span>Insert Selected Image</span>
            </button>
          )}

          {activeTab === "url" && (
            <button
              type="button"
              onClick={handleConfirmUrl}
              disabled={!imageUrl.trim()}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-medium transition-all shadow-md ${
                imageUrl.trim()
                  ? "bg-purple-600 hover:bg-purple-500 text-white cursor-pointer shadow-purple-500/20"
                  : "bg-purple-900/40 text-purple-300/40 border border-purple-800/30 cursor-not-allowed"
              }`}
            >
              <Check className="w-3.5 h-3.5" />
              <span>Insert Image</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
