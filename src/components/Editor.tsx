import { useEffect, useRef, useState, useCallback } from "react";
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
import { FileText, HardDrive, Sparkles, Edit2, Check, X } from "lucide-react";
import {
  obsidianLivePreviewPlugin,
  obsidianTheme,
} from "./obsidianLivePreview";

interface EditorProps {
  filePath: string | null;
  initialContent: string;
  onDebouncedSave: (filePath: string, content: string) => void;
  onRenameFile?: (oldPath: string, newPath: string) => void;
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
  onDebouncedSave,
  onRenameFile,
  debounceMs = 500,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [saveStatus, setSaveStatus] = useState<"synced" | "saving">("synced");

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(filePath || "");
  const renameInputRef = useRef<HTMLInputElement>(null);

  const latestContentRef = useRef(initialContent);
  const latestPathRef = useRef(filePath);

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
        obsidianLivePreviewPlugin,
        obsidianTheme,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const currentText = update.state.doc.toString();
            updateStats(currentText);
            scheduleSave(currentText);
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
  }, [filePath]);

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
        <div className="flex items-center">
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
          <div className="hidden md:flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-sky-300 font-sans">
            <Sparkles className="w-3 h-3 text-sky-400" />
            <span className="font-medium">Live Preview</span>
          </div>

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
    </div>
  );
};
