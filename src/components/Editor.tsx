import { useEffect, useRef, useState, useCallback, useSyncExternalStore } from "react";
import type { FC, MutableRefObject } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  highlightActiveLine,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
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
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Link2,
  Undo2,
  Redo2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  obsidianLivePreviewPlugin,
  obsidianTheme,
  livePreviewConfigFacet,
} from "./obsidianLivePreview";
import { applyFormat } from "./editorCommands";
import { MAX_UNDO_STEPS, historyStatus, limitedHistory, limitedRedo, limitedUndo } from "./editorHistory";
import type { HistoryStatus } from "./editorHistory";
import { keepCursorClear } from "./cursorVisibility";
import { useBackLayer } from "../utils/backNavigation";
import { inlineTitle } from "./inlineTitle";
import { baseNameOf, fileNameFromTitle, pathForName } from "../utils/noteTitle";
import { blockDragHandle } from "./blockDrag";
import type { FormatKind } from "./editorCommands";
import { BacklinksPanel } from "./BacklinksPanel";
import { InsertImageModal } from "./InsertImageModal";
import { NoeticBridge } from "../services/noeticBridge";
import { VaultEntry } from "../types/noetic";
import { backlinksGraph } from "../utils/wikilinks/backlinksGraph";
import { vaultIndex } from "../utils/wikilinks/vaultIndex";

/** Options for opening a note from inside the editor (e.g. Shift+click on a link). */
export interface OpenFileOptions {
  newTab?: boolean;
}

/**
 * Renames a note. Resolves to false when the rename was refused (e.g. the name is taken). Called
 * with `fromTitle` when the note's inline title was edited, so the host can skip its own feedback.
 */
export type RenameHandler = (
  oldPath: string,
  newPath: string,
  options?: { fromTitle?: boolean }
) => Promise<boolean | void> | void;

/** Imperative commands API, used by the mobile shell's own toolbar. */
export interface EditorHandle {
  /** Applies or removes a piece of Markdown formatting at the cursor / selection. */
  format: (kind: FormatKind) => void;
  openInsertImage: () => void;
  toggleLinks: () => void;
  focus: () => void;
  undo: () => void;
  redo: () => void;
}

interface EditorProps {
  /** "full" shows the desktop header bar; "minimal" renders only the document (host supplies chrome). */
  chrome?: "full" | "minimal";
  apiRef?: MutableRefObject<EditorHandle | null>;
  onSaveStatusChange?: (status: "synced" | "saving") => void;
  /** Whether Undo and Redo can be used, for a host that shows its own buttons. */
  onHistoryChange?: (status: HistoryStatus) => void;
  filePath: string | null;
  initialContent: string;
  vaultPath?: string;
  vaultFiles?: VaultEntry[];
  onDebouncedSave: (filePath: string, content: string) => void | Promise<void>;
  onRenameFile?: RenameHandler;
  onOpenFile?: (path: string, options?: OpenFileOptions) => void;
  onCreateFile?: (newFilePath: string, options?: OpenFileOptions) => void;
  onClose?: () => void;
  onRefreshFiles?: () => Promise<void>;
  onPreviewImage?: (src: string, alt?: string, title?: string) => void;
  debounceMs?: number;
}

type FormatButton = { kind: FormatKind; label: string; shortcut?: string; icon?: LucideIcon; text?: string } | "divider";

/** Toolbar order, shared by the desktop toolbar here and the mobile shell's bottom bar. */
export const FORMAT_BUTTONS: FormatButton[] = [
  { kind: "bold", label: "Bold", shortcut: "Ctrl/Cmd+B", icon: Bold },
  { kind: "italic", label: "Italic", shortcut: "Ctrl/Cmd+I", icon: Italic },
  { kind: "strike", label: "Strikethrough", icon: Strikethrough },
  { kind: "code", label: "Inline code", icon: Code },
  "divider",
  { kind: "heading", label: "Heading", icon: Heading },
  { kind: "bullet", label: "Bulleted list", icon: List },
  { kind: "numbered", label: "Numbered list", icon: ListOrdered },
  { kind: "task", label: "Task list", icon: ListChecks },
  { kind: "quote", label: "Quote", icon: Quote },
  "divider",
  { kind: "wikilink", label: "Link to a note", text: "[[ ]]" },
  { kind: "link", label: "Web link", shortcut: "Ctrl/Cmd+K", icon: Link2 },
];

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
  onHistoryChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showBacklinks, setShowBacklinks] = useState(false);
  const [isInsertImageOpen, setIsInsertImageOpen] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [saveStatus, setSaveStatus] = useState<"synced" | "saving">("synced");
  const [undoState, setUndoState] = useState<HistoryStatus>({ canUndo: false, canRedo: false });

  // On phones, Back closes the links panel before leaving the note.
  useBackLayer(chrome === "minimal" && showBacklinks, () => setShowBacklinks(false));

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(filePath || "");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const latestContentRef = useRef(initialContent);
  const latestPathRef = useRef(filePath);

  const renamingRef = useRef(false);
  const selfRenameTargetRef = useRef<string | null>(null);

  // The editor is rebuilt when a different note is opened, but not when this note is renamed
  // because its inline title was edited: a rebuild would reset the document and throw the cursor back to
  // the top while the user is typing. `key` only advances for a path change that wasn't ours.
  const sessionRef = useRef({ path: filePath, key: 0 });
  if (sessionRef.current.path !== filePath) {
    const adopted = filePath !== null && filePath === selfRenameTargetRef.current;
    sessionRef.current = { path: filePath, key: sessionRef.current.key + (adopted ? 0 : 1) };
    if (adopted) selfRenameTargetRef.current = null;
  }
  const sessionKey = sessionRef.current.key;

  useEffect(() => {
    onSaveStatusChange?.(saveStatus);
  }, [saveStatus, onSaveStatusChange]);

  useEffect(() => {
    onHistoryChange?.(undoState);
  }, [undoState, onHistoryChange]);

  const runUndo = useCallback(() => {
    const view = editorViewRef.current;
    if (view) limitedUndo(view);
  }, []);
  const runRedo = useCallback(() => {
    const view = editorViewRef.current;
    if (view) limitedRedo(view);
  }, []);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      format(kind) {
        if (editorViewRef.current) applyFormat(editorViewRef.current, kind);
      },
      openInsertImage: () => setIsInsertImageOpen(true),
      toggleLinks: () => setShowBacklinks((v) => !v),
      focus: () => editorViewRef.current?.focus(),
      undo: runUndo,
      redo: runRedo,
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, runUndo, runRedo]);

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
            await NoeticBridge.saveImageFile(
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
    (target: string, _header?: string, options?: OpenFileOptions) => {
      const resolved = vaultIndex.resolve(target, latestPathRef.current || undefined);
      if (resolved) {
        if (onOpenFile) {
          onOpenFile(resolved.path, options);
        }
      } else {
        const sanitized = target.endsWith(".md") ? target : `${target}.md`;
        if (onCreateFile) {
          onCreateFile(sanitized, options);
        } else if (onOpenFile) {
          onOpenFile(sanitized, options);
        }
      }
    },
    [onOpenFile, onCreateFile]
  );

  // Latest callbacks for the long-lived editor instance (see the editor effect's dependency note).
  const onPreviewImageRef = useRef(onPreviewImage);
  const saveAndInsertFileRef = useRef(saveAndInsertFile);
  const onDebouncedSaveRef = useRef(onDebouncedSave);
  const onRenameFileRef = useRef(onRenameFile);
  useEffect(() => {
    onPreviewImageRef.current = onPreviewImage;
    saveAndInsertFileRef.current = saveAndInsertFile;
    onDebouncedSaveRef.current = onDebouncedSave;
    onRenameFileRef.current = onRenameFile;
  }, [onPreviewImage, saveAndInsertFile, onDebouncedSave, onRenameFile]);

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
      void (async () => {
        await onDebouncedSave(filePath, latestContentRef.current);
        await onRenameFile?.(filePath, finalName);
      })();
      return;
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

      const save = () => {
        // A rename in flight moves the file under us; saving now could recreate the old name.
        if (renamingRef.current) {
          debounceTimerRef.current = setTimeout(save, 150);
          return;
        }
        if (latestPathRef.current) {
          onDebouncedSave(latestPathRef.current, latestContentRef.current);
          setSaveStatus("synced");
        }
      };
      debounceTimerRef.current = setTimeout(save, debounceMs);
    },
    [onDebouncedSave, debounceMs]
  );

  /**
   * Renames the note's file to `wanted` (the inline title was edited). Resolves to the name used,
   * or false when refused. Pending text is saved first so nothing is written to the old name after.
   */
  const renameFromTitle = async (wanted: string): Promise<string | false> => {
    const rename = onRenameFileRef.current;
    const path = latestPathRef.current;
    const name = fileNameFromTitle(wanted);
    if (!rename || !path || !name) return false;
    if (name === baseNameOf(path)) return name;
    if (renamingRef.current) return false;

    const newPath = pathForName(path, name);
    renamingRef.current = true;
    try {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        await onDebouncedSaveRef.current(path, latestContentRef.current);
        setSaveStatus("synced");
      }
      selfRenameTargetRef.current = newPath;
      const result = await rename(path, newPath, { fromTitle: true });
      if (result === false) {
        selfRenameTargetRef.current = null;
        return false;
      }
      latestPathRef.current = newPath;
      return name;
    } finally {
      renamingRef.current = false;
    }
  };
  const renameFromTitleRef = useRef(renameFromTitle);
  renameFromTitleRef.current = renameFromTitle;

  useEffect(() => {
    if (!containerRef.current) return;

    if (editorViewRef.current) {
      editorViewRef.current.destroy();
      editorViewRef.current = null;
    }

    latestContentRef.current = initialContent;
    updateStats(initialContent);
    const openedName = filePath && filePath.endsWith(".md") ? baseNameOf(filePath) : null;

    let lastLinkOpenAt = 0;

    const startState = EditorState.create({
      doc: initialContent,
      extensions: [
        highlightActiveLine(),
        limitedHistory(),
        // Phones: keep the line being written on clear of the on-screen keyboard.
        chrome === "minimal" ? keepCursorClear() : [],
        markdown(),
        syntaxHighlighting(markdownHighlightStyle, { fallback: true }),
        livePreviewConfigFacet.of({
          vaultPath: vaultPath || "",
          onPreviewImage: (src, alt, title) => onPreviewImageRef.current?.(src, alt, title),
        }),
        obsidianLivePreviewPlugin,
        obsidianTheme,
        blockDragHandle(),
        inlineTitle({
          getTitle: () => (openedName === null ? null : baseNameOf(latestPathRef.current ?? "")),
          onCommit: (name) => renameFromTitleRef.current(name),
        }),
        keymap.of([
          {
            key: "Mod-Shift-i",
            run: () => {
              setIsInsertImageOpen(true);
              return true;
            },
          },
          { key: "Mod-b", run: (v) => applyFormat(v, "bold") },
          { key: "Mod-i", run: (v) => applyFormat(v, "italic") },
          { key: "Mod-k", run: (v) => applyFormat(v, "link") },
          ...defaultKeymap,
        ]),
        EditorView.lineWrapping,
        EditorView.domEventHandlers({
          // Links are followed on mousedown, before the editor moves the cursor. Letting the press
          // through put the cursor on the link's line, which reveals that line's raw Markdown and
          // shifts the text under the pointer, so the click never landed on the link (and a slight
          // drag turned into a multi-line selection that revealed every line it touched).
          // Shift+click opens the note in a new tab.
          mousedown(event) {
            if (event.button !== 0) return false;
            const targetEl = (event.target as HTMLElement)?.closest("[data-wikilink-target]") as HTMLElement | null;
            if (!targetEl?.dataset.wikilinkTarget) return false;
            event.preventDefault();
            lastLinkOpenAt = Date.now();
            handleWikilinkClickRef.current(targetEl.dataset.wikilinkTarget, targetEl.dataset.wikilinkHeader, {
              newTab: event.shiftKey,
            });
            return true;
          },
          click(event) {
            const targetEl = (event.target as HTMLElement)?.closest("[data-wikilink-target]") as HTMLElement | null;
            if (targetEl && targetEl.dataset.wikilinkTarget) {
              event.preventDefault();
              event.stopPropagation();
              // Fallback for input that produces a click without a mousedown; skip the click that
              // belongs to a press already handled above.
              if (Date.now() - lastLinkOpenAt > 700) {
                handleWikilinkClickRef.current(targetEl.dataset.wikilinkTarget, targetEl.dataset.wikilinkHeader, {
                  newTab: event.shiftKey,
                });
              }
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
          if (update.transactions.length > 0) {
            const next = historyStatus(update.view);
            setUndoState((prev) =>
              prev.canUndo === next.canUndo && prev.canRedo === next.canRedo ? prev : next
            );
          }
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
    // A newly opened note has no history.
    setUndoState({ canUndo: false, canRedo: false });

    return () => {
      const leavingPath = latestPathRef.current;
      // Leaving this note with a save still pending: write it now instead of dropping the last
      // half-second of typing.
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        if (leavingPath) onDebouncedSaveRef.current(leavingPath, latestContentRef.current);
        setSaveStatus("synced");
      }
      view.destroy();
    };
    // Rebuild only when a different note (or vault) is opened (`sessionKey`, not the path itself). The callbacks are read through refs:
    // the parent passes new function identities on every render (after each autosave and each status
    // poll), and rebuilding on those reset the document and threw the cursor back to the first line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey, vaultPath]);

  if (!filePath) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 bg-[#0d1117]">
        <FileText className="w-12 h-12 mb-3 stroke-[1.5] text-zinc-600" />
        <p className="text-sm font-medium">Select a note from the sidebar or create a new one</p>
        <p className="text-xs text-zinc-600 mt-1">Changes are saved on this device as you type</p>
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
          {/* Undo / Redo (the last MAX_UNDO_STEPS changes) */}
          <div className="flex items-center gap-0.5">
            {(
              [
                { label: "Undo", shortcut: "Ctrl/Cmd+Z", icon: Undo2, run: runUndo, enabled: undoState.canUndo },
                { label: "Redo", shortcut: "Ctrl/Cmd+Shift+Z", icon: Redo2, run: runRedo, enabled: undoState.canRedo },
              ] as const
            ).map((b) => (
              <button
                key={b.label}
                type="button"
                title={`${b.label} (${b.shortcut}). Up to ${MAX_UNDO_STEPS} steps.`}
                aria-label={b.label}
                disabled={!b.enabled}
                // Keep the cursor in the note while the button is pressed.
                onMouseDown={(e) => e.preventDefault()}
                onClick={b.run}
                className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-zinc-400"
              >
                <b.icon className="w-3.5 h-3.5" />
              </button>
            ))}
          </div>

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
            title={saveStatus === "saving" ? "Saving to this device…" : "Saved on this device. Use Save in the top bar to back it up."}
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

      {/* Formatting toolbar (desktop chrome; the mobile shell renders its own) */}
      {chrome === "full" && (
        <div
          role="toolbar"
          aria-label="Formatting"
          className="h-9 px-4 border-b border-[#21262d] bg-[#0d1117] flex items-center gap-0.5 shrink-0 select-none overflow-x-auto"
        >
          {FORMAT_BUTTONS.map((b, i) =>
            b === "divider" ? (
              <span key={`d${i}`} className="w-px h-4 bg-[#30363d] mx-1.5 shrink-0" />
            ) : (
              <button
                key={b.kind}
                type="button"
                title={b.shortcut ? `${b.label} (${b.shortcut})` : b.label}
                aria-label={b.label}
                // Keep the selection in the editor while the button is pressed.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editorViewRef.current && applyFormat(editorViewRef.current, b.kind)}
                className="h-7 min-w-7 px-1.5 shrink-0 rounded-md flex items-center justify-center text-zinc-400 hover:text-white hover:bg-[#21262d] transition-colors cursor-pointer"
              >
                {b.icon ? <b.icon className="w-4 h-4" /> : <span className="font-mono text-[11px] font-semibold">{b.text}</span>}
              </button>
            )
          )}
        </div>
      )}

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
