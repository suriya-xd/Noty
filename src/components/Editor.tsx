import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react";
import type { FC } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import {
  FileText,
  HardDrive,
  Edit2,
  Check,
  X,
  ArrowLeftRight,
  LayoutDashboard,
  Image as ImageIcon,
} from "lucide-react";
import {
  obsidianLivePreviewPlugin,
  obsidianTheme,
  livePreviewConfigFacet,
} from "./obsidianLivePreview";
import { BacklinksPanel } from "./BacklinksPanel";
import { InsertImageModal } from "./InsertImageModal";
import { GitVaultBridge } from "../services/gitVaultBridge";
import { VaultEntry } from "../types/gitVault";
import { backlinksGraph } from "../utils/wikilinks/backlinksGraph";
import { vaultIndex } from "../utils/wikilinks/vaultIndex";

interface EditorProps {
  filePath: string | null;
  initialContent: string;
  vaultPath?: string;
  vaultFiles?: VaultEntry[];
  onDebouncedSave: (filePath: string, content: string) => void;
  onRenameFile?: (oldPath: string, newPath: string) => void;
  onOpenFile?: (path: string) => void;
  onCreateFile?: (newFilePath: string) => void;
  onClose?: () => void;
  onRefreshFiles?: () => Promise<void>;
  onPreviewImage?: (src: string, alt?: string, title?: string) => void;
  debounceMs?: number;
}

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.strong, fontWeight: "bold", color: "#ffffff" },
  { tag: tags.emphasis, fontStyle: "italic", color: "#e2e8f0" },
  { tag: tags.link, color: "#38bdf8", textDecoration: "underline" },
  {
    tag: tags.monospace,
    color: "#7dd3fc",
    backgroundColor: "rgba(22, 27, 34, 0.8)",
    padding: "1px 4px",
    borderRadius: "4px",
  },
  { tag: tags.keyword, color: "#38bdf8" },
  { tag: tags.atom, color: "#a78bfa" },
  { tag: tags.meta, color: "#64748b" },
]);

export const Editor: FC<EditorProps> = ({
  filePath,
  initialContent,
  vaultPath,
  vaultFiles,
  onDebouncedSave,
  onRenameFile,
  onOpenFile,
  onCreateFile,
  onClose,
  onRefreshFiles,
  onPreviewImage,
  debounceMs = 500,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showBacklinks, setShowBacklinks] = useState(false);
  const [isInsertImageOpen, setIsInsertImageOpen] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [saveStatus, setSaveStatus] = useState<"synced" | "saving">("synced");

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(filePath || "");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const latestContentRef = useRef(initialContent);
  const latestPathRef = useRef(filePath);

  const handleInsertImage = useCallback(
    (imagePathOrUrl: string, altText?: string) => {
      const view = editorViewRef.current;
      const alt = altText ? altText.trim() : "";
      const imageMarkdown = `\n![${alt}](${imagePathOrUrl})\n`;
      if (view) {
        const currentPos = view.state.selection.main.head;
        view.dispatch({
          changes: { from: currentPos, insert: imageMarkdown },
          selection: { anchor: currentPos + imageMarkdown.length },
        });
        view.focus();
      } else {
        const nextContent = latestContentRef.current + imageMarkdown;
        latestContentRef.current = nextContent;
        if (filePath) {
          onDebouncedSave(filePath, nextContent);
        }
      }
    },
    [filePath, onDebouncedSave]
  );

  const saveAndInsertFile = useCallback(
    async (file: File) => {
      try {
        const reader = new FileReader();
        reader.onload = async (e) => {
          const base64 = e.target?.result as string;
          const arrayBuffer = await file.arrayBuffer();
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const relPath = `assets/${safeName}`;
          if (vaultPath) {
            await GitVaultBridge.saveImageFile(
              vaultPath,
              relPath,
              base64,
              new Uint8Array(arrayBuffer)
            );
            if (onRefreshFiles) await onRefreshFiles();
          }
          handleInsertImage(relPath, file.name.replace(/\.[^/.]+$/, ""));
        };
        reader.readAsDataURL(file);
      } catch (err) {
        console.error("Failed to save and insert image:", err);
      }
    },
    [vaultPath, onRefreshFiles, handleInsertImage]
  );

  // Subscribe to graph updates to re-render link count badges in real time
  useSyncExternalStore(
    (cb) => backlinksGraph.subscribe(cb),
    () => {
      if (!filePath) return "0-0";
      const inc = backlinksGraph.getBacklinks(filePath).length;
      const out = backlinksGraph.getForwardLinks(filePath).length;
      return `${inc}-${out}`;
    }
  );

  const incomingCount = filePath ? backlinksGraph.getBacklinks(filePath).length : 0;
  const outgoingCount = filePath ? backlinksGraph.getForwardLinks(filePath).length : 0;

  const handleWikilinkClick = useCallback(
    (target: string, _header?: string) => {
      const resolved = vaultIndex.resolve(target, latestPathRef.current || undefined);
      if (resolved) {
        if (onOpenFile) {
          onOpenFile(resolved.path);
        }
      } else {
        const sanitized = target.endsWith(".md") ? target : `${target}.md`;
        if (onCreateFile) {
          onCreateFile(sanitized);
        } else if (onOpenFile) {
          onOpenFile(sanitized);
        }
      }
    },
    [onOpenFile, onCreateFile]
  );

  const handleWikilinkClickRef = useRef(handleWikilinkClick);
  useEffect(() => {
    handleWikilinkClickRef.current = handleWikilinkClick;
  }, [handleWikilinkClick]);

  useEffect(() => {
    setIsRenaming(false);
    setRenameValue(filePath || "");
  }, [filePath]);

  const startRenaming = () => {
    if (!filePath) return;
    setIsRenaming(true);
    setRenameValue(filePath);
    setTimeout(() => {
      if (renameInputRef.current) {
        renameInputRef.current.focus();
        const dotIndex = filePath.lastIndexOf(".");
        if (dotIndex > 0) {
          renameInputRef.current.setSelectionRange(0, dotIndex);
        } else {
          renameInputRef.current.select();
        }
      }
    }, 0);
  };

  const handleRenameSubmit = () => {
    if (!isRenaming || !filePath) return;
    setIsRenaming(false);

    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === filePath) {
      setRenameValue(filePath);
      return;
    }

    const finalName = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
    if (finalName === filePath) {
      setRenameValue(filePath);
      return;
    }

    // Flush any pending debounced save before renaming
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      onDebouncedSave(filePath, latestContentRef.current);
    }

    if (onRenameFile) {
      onRenameFile(filePath, finalName);
    }
  };

  const handleRenameCancel = () => {
    setIsRenaming(false);
    setRenameValue(filePath || "");
  };

  useEffect(() => {
    latestPathRef.current = filePath;
    latestContentRef.current = initialContent;
    updateStats(initialContent);
  }, [filePath, initialContent]);

  const updateStats = (text: string) => {
    setCharCount(text.length);
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    setWordCount(words);
  };

  const scheduleSave = useCallback(
    (newContent: string) => {
      latestContentRef.current = newContent;
      setSaveStatus("saving");

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        if (latestPathRef.current) {
          onDebouncedSave(latestPathRef.current, latestContentRef.current);
          setSaveStatus("synced");
        }
      }, debounceMs);
    },
    [onDebouncedSave, debounceMs]
  );

  useEffect(() => {
    if (!containerRef.current) return;

    if (editorViewRef.current) {
      editorViewRef.current.destroy();
      editorViewRef.current = null;
    }

    latestContentRef.current = initialContent;
    updateStats(initialContent);

    const startState = EditorState.create({
      doc: initialContent,
      extensions: [
        highlightActiveLine(),
        history(),
        markdown(),
        syntaxHighlighting(markdownHighlightStyle, { fallback: true }),
        livePreviewConfigFacet.of({
          vaultPath: vaultPath || "",
          onPreviewImage,
        }),
        obsidianLivePreviewPlugin,
        obsidianTheme,
        keymap.of([
          {
            key: "Mod-Shift-i",
            run: () => {
              setIsInsertImageOpen(true);
              return true;
            },
          },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        EditorView.domEventHandlers({
          click(event) {
            const targetEl = (event.target as HTMLElement)?.closest("[data-wikilink-target]") as HTMLElement | null;
            if (targetEl && targetEl.dataset.wikilinkTarget) {
              event.preventDefault();
              event.stopPropagation();
              const target = targetEl.dataset.wikilinkTarget;
              const header = targetEl.dataset.wikilinkHeader;
              handleWikilinkClickRef.current(target, header);
              return true;
            }
            return false;
          },
          paste(event) {
            const items = event.clipboardData?.items;
            if (items) {
              for (const item of Array.from(items)) {
                if (item.type.startsWith("image/")) {
                  const file = item.getAsFile();
                  if (file) {
                    event.preventDefault();
                    saveAndInsertFile(file);
                    return true;
                  }
                }
              }
            }
            return false;
          },
          drop(event) {
            const files = event.dataTransfer?.files;
            if (files && files.length > 0) {
              const imgFile = Array.from(files).find((f) => f.type.startsWith("image/"));
              if (imgFile) {
                event.preventDefault();
                saveAndInsertFile(imgFile);
                return true;
              }
            }
            return false;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const currentText = update.state.doc.toString();
            updateStats(currentText);
            scheduleSave(currentText);
            if (latestPathRef.current) {
              backlinksGraph.updateFileLinks(latestPathRef.current, currentText);
            }
          }
        }),
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    });

    editorViewRef.current = view;

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      view.destroy();
    };
  }, [filePath, vaultPath, onPreviewImage, saveAndInsertFile]);

  if (!filePath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 bg-[#0d1117]">
        <FileText className="w-12 h-12 mb-3 stroke-[1.5] text-zinc-600" />
        <p className="text-sm font-medium">Select a note from the sidebar or create a new one</p>
        <p className="text-xs text-zinc-600 mt-1">Changes are saved directly to your local Git worktree</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0d1117] overflow-hidden">
      {/* Editor Header / Breadcrumbs */}
      <div className="h-10 border-b border-[#21262d] px-6 flex items-center justify-between bg-[#161b22]/40 text-xs shrink-0 select-none">
        <div className="flex items-center gap-1.5">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Return to Dashboard"
              className="flex items-center gap-1.5 px-2 py-1 -ml-2 mr-1 rounded-md hover:bg-[#21262d] text-zinc-400 hover:text-white transition-colors cursor-pointer text-xs font-medium"
            >
              <LayoutDashboard className="w-3.5 h-3.5 text-zinc-400 hover:text-sky-400" />
              <span className="hidden sm:inline">Dashboard</span>
            </button>
          )}
          {isRenaming ? (
            <div className="flex items-center gap-2 font-mono">
              <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleRenameSubmit();
                }}
                className="flex items-center gap-1.5"
              >
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      handleRenameCancel();
                    }
                  }}
                  onBlur={handleRenameSubmit}
                  className="bg-[#0d1117] border border-sky-500 rounded px-2 py-0.5 text-xs text-white font-mono outline-none shadow-sm focus:ring-1 focus:ring-sky-400 w-44 sm:w-60"
                  placeholder="filename.md"
                />
                <button
                  type="submit"
                  onMouseDown={(e) => e.preventDefault()}
                  title="Save (Enter)"
                  className="p-1 rounded hover:bg-[#21262d] text-emerald-400 hover:text-emerald-300 transition-colors cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={handleRenameCancel}
                  title="Cancel (Esc)"
                  className="p-1 rounded hover:bg-[#21262d] text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </form>
            </div>
          ) : (
            <button
              type="button"
              onClick={startRenaming}
              title="Click to rename note"
              className="group flex items-center gap-2 font-mono text-zinc-300 hover:text-white px-2 py-1 -mx-2 -my-1 rounded-md hover:bg-[#21262d]/80 transition-all cursor-pointer border border-transparent hover:border-[#30363d]"
            >
              <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0 group-hover:scale-110 transition-transform" />
              <span className="font-semibold text-white group-hover:text-sky-300 transition-colors">
                {filePath}
              </span>
              <Edit2 className="w-3 h-3 text-zinc-500 group-hover:text-sky-400 opacity-60 group-hover:opacity-100 transition-all ml-0.5 shrink-0" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 text-zinc-400 text-[11px]">
          {/* Insert Image Button */}
          <button
            type="button"
            onClick={() => setIsInsertImageOpen(true)}
            title="Insert Image (Ctrl+Shift+I)"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-sans border border-[#30363d] hover:border-purple-500/50 bg-[#161b22] hover:bg-[#21262d] text-zinc-300 hover:text-white transition-all cursor-pointer shadow-xs group"
          >
            <ImageIcon className="w-3.5 h-3.5 text-purple-400 group-hover:scale-110 transition-transform" />
            <span className="font-medium">Image</span>
          </button>

          <button
            type="button"
            onClick={() => setShowBacklinks(!showBacklinks)}
            title={`Toggle Links panel (${incomingCount} incoming backlinks, ${outgoingCount} outgoing links)`}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-sans border transition-all cursor-pointer ${
              showBacklinks
                ? "bg-sky-500/15 border-sky-500/40 text-sky-300 shadow-sm"
                : "hover:bg-[#21262d] border-[#30363d] text-zinc-400 hover:text-zinc-200"
            }`}
          >
            <ArrowLeftRight className="w-3.5 h-3.5 text-sky-400" />
            <span className="font-medium">Links</span>
            {filePath && (
              <span className="flex items-center gap-1 font-mono text-[10px]">
                <span className="px-1.5 py-0.2 bg-[#21262d] text-sky-400 rounded-full" title={`${incomingCount} incoming backlinks`}>
                  {incomingCount} in
                </span>
                <span className="text-zinc-600 font-sans">·</span>
                <span className="px-1.5 py-0.2 bg-[#21262d] text-indigo-400 rounded-full" title={`${outgoingCount} outgoing links`}>
                  {outgoingCount} out
                </span>
              </span>
            )}
          </button>

          <div className="h-3 w-[1px] bg-[#30363d] hidden md:block" />

          <div
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono border transition-all ${
              saveStatus === "saving"
                ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
            }`}
          >
            <HardDrive className="w-3 h-3" />
            <span>{saveStatus === "saving" ? "Saving..." : "Saved locally (500ms)"}</span>
          </div>

          <div className="h-3 w-[1px] bg-[#30363d] hidden sm:block" />

          <div className="hidden sm:flex items-center gap-1.5 font-mono text-zinc-400 text-[11px]">
            <span>{wordCount} words</span>
            <span>•</span>
            <span>{charCount} chars</span>
            <span className="hidden lg:inline">•</span>
            <span className="hidden lg:inline">{Math.max(1, Math.ceil(wordCount / 200))} min read</span>
          </div>
        </div>
      </div>

      {/* Obsidian-Style Single Live Preview Document Canvas */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto selection:bg-sky-500/25"
      />

      {/* Backlinks UI Panel */}
      {showBacklinks && (
        <BacklinksPanel
          currentFilePath={filePath}
          onOpenFile={onOpenFile || (() => {})}
          onCreateFile={onCreateFile}
        />
      )}

      {/* Insert Image Modal */}
      <InsertImageModal
        isOpen={isInsertImageOpen}
        vaultPath={vaultPath || ""}
        vaultFiles={vaultFiles || []}
        onClose={() => setIsInsertImageOpen(false)}
        onInsertImage={handleInsertImage}
        onRefreshFiles={onRefreshFiles}
        title={`Insert Image into ${filePath || "Note"}`}
      />
    </div>
  );
};
