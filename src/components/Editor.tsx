import { useEffect, useRef, useState, useCallback } from "react";
import type { FC } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { FileText, HardDrive } from "lucide-react";

interface EditorProps {
  filePath: string | null;
  initialContent: string;
  onDebouncedSave: (filePath: string, content: string) => void;
  debounceMs?: number;
}

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

  // Track latest content and path for callback
  const latestContentRef = useRef(initialContent);
  const latestPathRef = useRef(filePath);

  useEffect(() => {
    latestPathRef.current = filePath;
  }, [filePath]);

  // Compute stats
  const updateStats = (text: string) => {
    setCharCount(text.length);
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    setWordCount(words);
  };

  // Schedule debounced disk write
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

  // Initialize CodeMirror 6 instance
  useEffect(() => {
    if (!containerRef.current) return;

    // Cleanup previous view
    if (editorViewRef.current) {
      editorViewRef.current.destroy();
      editorViewRef.current = null;
    }

    latestContentRef.current = initialContent;
    updateStats(initialContent);

    // Create CodeMirror State
    const startState = EditorState.create({
      doc: initialContent,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        markdown(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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
  }, [filePath]); // Recreate or switch when active note changes

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
      <div className="h-10 border-b border-[#21262d] px-4 flex items-center justify-between bg-[#161b22]/40 text-xs">
        <div className="flex items-center gap-2 font-mono text-zinc-300">
          <FileText className="w-3.5 h-3.5 text-sky-400" />
          <span className="font-semibold text-white">{filePath}</span>
        </div>

        <div className="flex items-center gap-3 text-zinc-400 text-[11px]">
          <div className="flex items-center gap-1.5">
            <HardDrive className="w-3 h-3 text-zinc-500" />
            <span
              className={
                saveStatus === "saving"
                  ? "text-amber-400 font-medium"
                  : "text-zinc-400"
              }
            >
              {saveStatus === "saving" ? "Writing to disk (500ms)..." : "Saved to disk (dirty worktree)"}
            </span>
          </div>

          <div className="h-3 w-[1px] bg-[#30363d]" />

          <span>{wordCount} words</span>
          <span>{charCount} chars</span>
        </div>
      </div>

      {/* CodeMirror Mounting Container */}
      <div ref={containerRef} className="flex-1 overflow-auto" />
    </div>
  );
};
