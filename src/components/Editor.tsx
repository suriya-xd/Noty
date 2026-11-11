import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react";
import type { FC, MutableRefObject } from "react";
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

/** Imperative formatting/commands API, used by the mobile shell's own toolbar. */
export interface EditorHandle {
  /** Wraps the selection (or inserts a selected placeholder) in `before`/`after`. */
  wrapSelection: (before: string, after: string, placeholder: string) => void;
  /** Adds `prefix` to the start of the current line, or removes it if already there. */
  toggleLinePrefix: (prefix: string) => void;
  /** Inserts a block on its own lines at the cursor. */
  insertBlock: (text: string) => void;
  openInsertImage: () => void;
  toggleLinks: () => void;
  focus: () => void;
}

interface EditorProps {
  /** "full" shows the desktop header bar; "minimal" renders only the document (host supplies chrome). */
  chrome?: "full" | "minimal";
  apiRef?: MutableRefObject<EditorHandle | null>;
  onSaveStatusChange?: (status: "synced" | "saving") => void;
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
  chrome = "full",
  apiRef,
  onSaveStatusChange,
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

  useEffect(() => {
    onSaveStatusChange?.(saveStatus);
  }, [saveStatus, onSaveStatusChange]);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      wrapSelection(before, after, placeholder) {
        const view = editorViewRef.current;
        if (!view) return;
        const { from, to } = view.state.selection.main;
        const inner = view.state.sliceDoc(from, to) || placeholder;
        view.dispatch({
          changes: { from, to, insert: `${before}${inner}${after}` },
          selection: { anchor: from + before.length, head: from + before.length + inner.length },
          scrollIntoView: true,
        });
        view.focus();
      },
      toggleLinePrefix(prefix) {
        const view = editorViewRef.current;
        if (!view) return;
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        const change = line.text.startsWith(prefix)
          ? { from: line.from, to: line.from + prefix.length, insert: "" }
          : { from: line.from, insert: prefix };
        view.dispatch({ changes: change, scrollIntoView: true });
        view.focus();
      },
      insertBlock(text) {
        const view = editorViewRef.current;
        if (!view) return;
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        const insert = `${line.text.trim() ? "\n" : ""}${text}\n`;
        view.dispatch({
          changes: { from: line.to, insert },
          selection: { anchor: line.to + insert.length },
          scrollIntoView: true,
        });
        view.focus();
      },
      openInsertImage: () => setIsInsertImageOpen(true),
      toggleLinks: () => setShowBacklinks((v) => !v),
      focus: () => editorViewRef.current?.focus(),
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

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

  // Latest callbacks for the long-lived editor instance (see the editor effect's dependency note).
  const onPreviewImageRef = useRef(onPreviewImage);
  const saveAndInsertFileRef = useRef(saveAndInsertFile);
  useEffect(() => {
    onPreviewImageRef.current = onPreviewImage;
    saveAndInsertFileRef.current = saveAndInsertFile;
  }, [onPreviewImage, saveAndInsertFile]);

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

  // Only the path is tracked here. `initialContent` is echoed back by the parent after every
  // autosave and can be older than what is in the editor; copying it into latestContentRef made a
  // pending save write stale text. The editor effect below seeds content when a note is opened.
  useEffect(() => {
    latestPathRef.current = filePath;
  }, [filePath]);

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
          onPreviewImage: (src, alt, title) => onPreviewImageRef.current?.(src, alt, title),
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
                    saveAndInsertFileRef.current(file);
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
                saveAndInsertFileRef.current(imgFile);
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
    // Rebuild only when a different note (or vault) is opened. The callbacks are read through refs:
    // the parent passes new function identities on every render (after each autosave and each status
    // poll), and rebuilding on those reset the document and threw the cursor back to the first line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, vaultPath]);

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
      <div className={chrome === "minimal" ? "hidden" : "h-10 border-b border-[#21262d] px-6 flex items-center justify-between bg-[#161b22]/40 text-xs shrink-0 select-none gap-3"}>
        <div className="flex items-center gap-1.5 min-w-0">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="Return to Dashboard"
              className="flex items-center gap-1.5 px-2 py-1 -ml-2 mr-1 rounded-md hover:bg-[#21262d] text-zinc-400 hover:text-white transition-colors cursor-pointer text-xs font-medium"
            >
              <LayoutDashboard className="w-3.5 h-3.5 text-zinc-400 hover:text-sky-400" />
              <span className="hidden xl:inline">Dashboard</span>
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
              className="group flex items-center gap-2 font-mono text-zinc-300 hover:text-white px-2 py-1 -my-1 rounded-md hover:bg-[#21262d]/80 transition-all cursor-pointer border border-transparent hover:border-[#30363d] min-w-0"
            >
              <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0 group-hover:scale-110 transition-transform" />
              <span className="font-semibold text-white group-hover:text-sky-300 transition-colors truncate">
                {filePath}
              </span>
              <Edit2 className="w-3 h-3 text-zinc-500 group-hover:text-sky-400 opacity-60 group-hover:opacity-100 transition-all ml-0.5 shrink-0" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 lg:gap-3 text-zinc-400 text-[11px] shrink-0">
          {/* Insert Image Button */}
          <button
            type="button"
            onClick={() => setIsInsertImageOpen(true)}
            title="Insert Image (Ctrl+Shift+I)"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-sans border border-[#30363d] hover:border-purple-500/50 bg-[#161b22] hover:bg-[#21262d] text-zinc-300 hover:text-white transition-all cursor-pointer shadow-xs group"
          >
            <ImageIcon className="w-3.5 h-3.5 text-purple-400 group-hover:scale-110 transition-transform" />
            <span className="font-medium hidden lg:inline">Image</span>
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
            <span className="font-medium hidden lg:inline">Links</span>
            {filePath && (
              <span className="flex items-center gap-1 font-mono text-[10px]">
                <span className="px-1.5 py-0.5 bg-[#21262d] text-sky-400 rounded-full whitespace-nowrap" title={`${incomingCount} incoming backlinks`}>
                  {incomingCount} in
                </span>
                <span className="text-zinc-600 font-sans">·</span>
                <span className="px-1.5 py-0.5 bg-[#21262d] text-indigo-400 rounded-full whitespace-nowrap" title={`${outgoingCount} outgoing links`}>
                  {outgoingCount} out
                </span>
              </span>
            )}
          </button>

          <div className="h-3 w-[1px] bg-[#30363d] hidden md:block" />

          <div
            title={saveStatus === "saving" ? "Saving to this device…" : "Saved on this device. Use Save in the top bar to push to GitHub."}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono border transition-all ${
              saveStatus === "saving"
                ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
                : "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
            }`}
          >
            <HardDrive className="w-3 h-3" />
            <span className="hidden lg:inline whitespace-nowrap">{saveStatus === "saving" ? "Saving…" : "Saved locally"}</span>
          </div>

          <div className="h-3 w-[1px] bg-[#30363d] hidden xl:block" />

          <div className="hidden xl:flex items-center gap-1.5 font-mono text-zinc-400 text-[11px] whitespace-nowrap">
            <span>{wordCount} words</span>
            <span>•</span>
            <span>{charCount} chars</span>
            <span className="hidden 2xl:inline">•</span>
            <span className="hidden 2xl:inline">{Math.max(1, Math.ceil(wordCount / 200))} min read</span>
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
