import { useEffect, useRef } from "react";
import type { FC } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  obsidianLivePreviewPlugin,
  obsidianTheme,
  livePreviewConfigFacet,
} from "../obsidianLivePreview";
import { applyFormat } from "../editorCommands";

interface CanvasMarkdownEditorProps {
  initialText: string;
  vaultPath: string;
  fontSize: number;
  onChange: (text: string) => void;
  /** Ctrl/Cmd+Enter or focus leaving the editor, with the final text. */
  onFinish: (text: string) => void;
  /** Escape: discard changes. */
  onCancel: () => void;
}

// Canvas cards size text in em from the card's font size, so headings scale with the card
// instead of using the full editor's fixed rem sizes and page padding.
const canvasCardTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "inherit", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-content": { maxWidth: "none", margin: "0", padding: "0", lineHeight: "1.4" },
  ".cm-line": { padding: "0" },
  ".cm-md-h1": { fontSize: "1.65em !important", paddingTop: "0.2em !important", paddingBottom: "0.35em !important", backgroundImage: "none !important" },
  ".cm-md-h2": { fontSize: "1.35em !important", paddingTop: "0.2em !important", paddingBottom: "0.3em !important", backgroundImage: "none !important" },
  ".cm-md-h3": { fontSize: "1.18em !important", paddingTop: "0.2em !important", paddingBottom: "0.2em !important" },
  ".cm-md-h4, .cm-md-h5, .cm-md-h6": { fontSize: "1.05em !important", paddingTop: "0.15em !important", paddingBottom: "0.15em !important" },
  ".cm-md-bullet": { color: "#94a3b8" },
  ".cm-placeholder": { color: "#71717a", fontStyle: "italic" },
});

/**
 * Text card editor. Uses the editor's live preview with every Markdown marker hidden, so the
 * card shows formatted text while typing: "# " turns the line into a heading, "**x**" into bold.
 */
export const CanvasMarkdownEditor: FC<CanvasMarkdownEditorProps> = ({
  initialText,
  vaultPath,
  fontSize,
  onChange,
  onFinish,
  onCancel,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onFinish, onCancel });
  callbacks.current = { onChange, onFinish, onCancel };
  // Finish or cancel runs once: tearing the editor down can blur it, which must not save
  // text the user just discarded with Escape.
  const endedRef = useRef(false);

  useEffect(() => {
    if (!hostRef.current) return;
    const finish = (v: EditorView) => {
      if (endedRef.current) return;
      endedRef.current = true;
      callbacks.current.onFinish(v.state.doc.toString());
    };
    const cancel = () => {
      if (endedRef.current) return;
      endedRef.current = true;
      callbacks.current.onCancel();
    };
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: initialText,
        extensions: [
          history(),
          markdown(),
          livePreviewConfigFacet.of({ vaultPath, alwaysHideMarkers: true }),
          obsidianLivePreviewPlugin,
          obsidianTheme,
          canvasCardTheme,
          placeholderExt("Type here… (# heading, **bold**, *italic*, - list)"),
          EditorView.lineWrapping,
          keymap.of([
            { key: "Mod-Enter", run: (v) => (finish(v), true) },
            { key: "Escape", run: () => (cancel(), true) },
            { key: "Mod-b", run: (v) => applyFormat(v, "bold") },
            { key: "Mod-i", run: (v) => applyFormat(v, "italic") },
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            blur: (_e, v) => {
              finish(v);
              return false;
            },
          }),
        ],
      }),
    });
    view.focus();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    return () => {
      endedRef.current = true; // a blur while tearing down is not a finish
      view.destroy();
    };
    // The editor is created once per editing session; later text comes from the editor itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={hostRef}
      className="w-full h-full rounded-lg p-2.5 bg-[#0d1117]/60 ring-1 ring-sky-500/50 focus-within:ring-sky-400 cursor-text select-text overflow-auto"
      style={{ fontSize: `${fontSize}px` }}
      // Keep canvas shortcuts (Delete, arrows, undo) and card dragging out of the editor.
      onKeyDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
};
