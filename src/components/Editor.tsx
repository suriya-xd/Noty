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
import { FileText, HardDrive, Sparkles } from "lucide-react";
import {
  obsidianLivePreviewPlugin,
  obsidianTheme,
} from "./obsidianLivePreview";

interface EditorProps {
  filePath: string | null;
  initialContent: string;
  onDebouncedSave: (filePath: string, content: string) => void;
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
  debounceMs = 500,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [wordCount, setWordCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [saveStatus, setSaveStatus] = useState<"synced" | "saving">("synced");

  const latestContentRef = useRef(initialContent);
  const latestPathRef = useRef(filePath);

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
        <div className="flex items-center gap-2 font-mono text-zinc-300">
          <FileText className="w-3.5 h-3.5 text-sky-400" />
          <span className="font-semibold text-white">{filePath}</span>
        </div>

        <div className="flex items-center gap-3 text-zinc-400 text-[11px]">
          <div className="hidden md:flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-300 font-sans">
            <Sparkles className="w-3 h-3 text-sky-400" />
            <span>Live Preview</span>
          </div>

          <div className="h-3 w-[1px] bg-[#30363d] hidden md:block" />

          <div className="flex items-center gap-1.5">
            <HardDrive className="w-3 h-3 text-zinc-500" />
            <span
              className={
                saveStatus === "saving"
                  ? "text-amber-400 font-medium"
                  : "text-zinc-400"
              }
            >
              {saveStatus === "saving" ? "Saving..." : "Saved"}
            </span>
          </div>

          <div className="h-3 w-[1px] bg-[#30363d] hidden sm:block" />

          <span className="hidden sm:inline">{wordCount} words</span>
          <span className="hidden sm:inline">{charCount} chars</span>
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
