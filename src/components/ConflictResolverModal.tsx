import { useState } from "react";
import type { FC } from "react";
import {
  CheckCheck,
  FileCode,
  GitMerge,
  Edit3,
  X,
} from "lucide-react";
import { ConflictFile, ConflictResolution } from "../types/gitVault";

interface ConflictResolverModalProps {
  conflicts: ConflictFile[];
  isOpen: boolean;
  onClose: () => void;
  onApplyResolutions: (resolutions: ConflictResolution[]) => void;
}

export const ConflictResolverModal: FC<ConflictResolverModalProps> = ({
  conflicts,
  isOpen,
  onClose,
  onApplyResolutions,
}) => {
  if (!isOpen || conflicts.length === 0) return null;

  // Selected file index
  const [activeFileIndex, setActiveFileIndex] = useState(0);

  // Per-file resolution state: maps file path to { type, customContent }
  const [resolutions, setResolutions] = useState<
    Record<string, { type: "local" | "remote" | "custom"; content: string }>
  >(() => {
    const initial: Record<string, { type: "local" | "remote" | "custom"; content: string }> = {};
    for (const f of conflicts) {
      initial[f.path] = {
        type: "custom",
        content: `# Merged Content: ${f.path}\n\n${f.local_content}\n\n// --- Remote Changes Below ---\n${f.remote_content}`,
      };
    }
    return initial;
  });

  const activeFile = conflicts[activeFileIndex] || conflicts[0];
  const currentResolution = resolutions[activeFile.path] || {
    type: "local",
    content: activeFile.local_content,
  };

  const handleChooseLocal = (path: string) => {
    const file = conflicts.find((f) => f.path === path);
    if (!file) return;
    setResolutions((prev) => ({
      ...prev,
      [path]: { type: "local", content: file.local_content },
    }));
  };

  const handleChooseRemote = (path: string) => {
    const file = conflicts.find((f) => f.path === path);
    if (!file) return;
    setResolutions((prev) => ({
      ...prev,
      [path]: { type: "remote", content: file.remote_content },
    }));
  };

  const handleCustomChange = (path: string, newContent: string) => {
    setResolutions((prev) => ({
      ...prev,
      [path]: { type: "custom", content: newContent },
    }));
  };

  const handleFinalize = () => {
    const list: ConflictResolution[] = Object.entries(resolutions).map(([path, res]) => ({
      path,
      resolution_type: res.type,
      custom_content: res.content,
    }));
    onApplyResolutions(list);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-6 animate-fadeIn">
      <div className="w-full max-w-5xl h-[85vh] bg-[#161b22] border border-[#30363d] rounded-2xl shadow-2xl flex flex-col overflow-hidden text-zinc-100">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#30363d] flex items-center justify-between bg-[#0d1117]/80">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-orange-500/20 text-orange-400 border border-orange-500/30 flex items-center justify-center">
              <GitMerge className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-semibold text-sm text-white flex items-center gap-2">
                Visual 3-Way Conflict Resolver
                <span className="text-xs font-normal text-orange-400 px-2 py-0.5 rounded-full bg-orange-950/60 border border-orange-500/30">
                  {conflicts.length} Conflicted File(s)
                </span>
              </h2>
              <p className="text-xs text-zinc-400">
                In-memory merge detected line-level collisions between your dirty worktree and origin/main.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-[#30363d] text-zinc-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex overflow-hidden">
          {/* File Selector Sidebar */}
          <div className="w-56 border-r border-[#30363d] bg-[#0d1117] p-3 flex flex-col">
            <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-2">
              Conflicted Files
            </div>
            <div className="flex-1 overflow-y-auto space-y-1">
              {conflicts.map((file, idx) => {
                const isSelected = idx === activeFileIndex;
                const resType = resolutions[file.path]?.type;

                return (
                  <button
                    key={file.path}
                    onClick={() => setActiveFileIndex(idx)}
                    className={`w-full text-left px-2.5 py-2 rounded-lg text-xs font-mono flex items-center justify-between transition-colors ${
                      isSelected
                        ? "bg-orange-950/60 text-orange-200 border border-orange-500/40"
                        : "text-zinc-400 hover:bg-[#161b22] hover:text-zinc-200"
                    }`}
                  >
                    <span className="truncate">{file.path}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#21262d] text-zinc-300 capitalize">
                      {resType}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3-Way Diff & Resolution Panel */}
          <div className="flex-1 flex flex-col bg-[#0d1117] overflow-hidden">
            {/* Quick Actions Header */}
            <div className="px-4 py-2.5 border-b border-[#21262d] bg-[#161b22]/50 flex items-center justify-between">
              <div className="text-xs font-mono font-medium text-white flex items-center gap-2">
                <FileCode className="w-4 h-4 text-orange-400" />
                <span>{activeFile.path}</span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleChooseLocal(activeFile.path)}
                  className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
                    currentResolution.type === "local"
                      ? "bg-amber-600/30 border-amber-500 text-amber-300"
                      : "bg-[#21262d] border-[#30363d] text-zinc-300 hover:border-amber-500/50"
                  }`}
                >
                  Accept Local (Mine)
                </button>
                <button
                  onClick={() => handleChooseRemote(activeFile.path)}
                  className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
                    currentResolution.type === "remote"
                      ? "bg-sky-600/30 border-sky-500 text-sky-300"
                      : "bg-[#21262d] border-[#30363d] text-zinc-300 hover:border-sky-500/50"
                  }`}
                >
                  Accept Remote (Incoming)
                </button>
              </div>
            </div>

            {/* 3-Column Comparison View */}
            <div className="grid grid-cols-3 divide-x divide-[#21262d] flex-1 overflow-hidden">
              {/* Column 1: Local / Disk Worktree */}
              <div className="flex flex-col h-full bg-[#0d1117] overflow-hidden">
                <div className="p-2 border-b border-[#21262d] bg-amber-950/20 text-amber-300 text-xs font-semibold flex items-center justify-between">
                  <span>Local Worktree (Unsaved on Disk)</span>
                  <span className="text-[10px] text-amber-400/80 font-mono">YOUR EDITS</span>
                </div>
                <pre className="flex-1 p-3 text-xs font-mono text-zinc-300 overflow-auto whitespace-pre-wrap selection:bg-amber-500/30">
                  {activeFile.local_content}
                </pre>
              </div>

              {/* Column 2: Ancestor / Base */}
              <div className="flex flex-col h-full bg-[#0d1117] overflow-hidden">
                <div className="p-2 border-b border-[#21262d] bg-[#161b22] text-zinc-400 text-xs font-semibold flex items-center justify-between">
                  <span>Base (Ancestor / HEAD commit)</span>
                  <span className="text-[10px] text-zinc-500 font-mono">COMMON BASE</span>
                </div>
                <pre className="flex-1 p-3 text-xs font-mono text-zinc-400 overflow-auto whitespace-pre-wrap selection:bg-zinc-700">
                  {activeFile.base_content || "(empty file in ancestor commit)"}
                </pre>
              </div>

              {/* Column 3: Remote / origin/main */}
              <div className="flex flex-col h-full bg-[#0d1117] overflow-hidden">
                <div className="p-2 border-b border-[#21262d] bg-sky-950/20 text-sky-300 text-xs font-semibold flex items-center justify-between">
                  <span>Remote (origin/main)</span>
                  <span className="text-[10px] text-sky-400/80 font-mono">INCOMING</span>
                </div>
                <pre className="flex-1 p-3 text-xs font-mono text-zinc-300 overflow-auto whitespace-pre-wrap selection:bg-sky-500/30">
                  {activeFile.remote_content}
                </pre>
              </div>
            </div>

            {/* Editable Resolution Preview Pane */}
            <div className="h-44 border-t border-[#30363d] bg-[#161b22] flex flex-col">
              <div className="px-4 py-2 border-b border-[#21262d] flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 font-medium text-emerald-400">
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>Final Resolved File Preview (Editable)</span>
                </div>
                <span className="text-zinc-500 text-[11px]">
                  This content will be written directly to disk and committed.
                </span>
              </div>
              <textarea
                value={currentResolution.content}
                onChange={(e) => handleCustomChange(activeFile.path, e.target.value)}
                className="flex-1 p-3 text-xs font-mono bg-[#0d1117] text-white outline-none resize-none overflow-auto"
                placeholder="Edit or combine content manually..."
              />
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-[#30363d] bg-[#0d1117] flex items-center justify-between">
          <p className="text-xs text-zinc-400">
            Resolving will cleanly advance the Git reference without writing raw{" "}
            <code className="text-orange-400 font-mono">&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> markers to your markdown files.
          </p>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-white hover:bg-[#21262d] transition-colors"
            >
              Cancel
            </button>
            <button
              id="btn-apply-resolutions"
              onClick={handleFinalize}
              className="flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/30 cursor-pointer active:scale-95 transition-all"
            >
              <CheckCheck className="w-4 h-4" />
              <span>Apply Resolutions & Finalize Merge</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
