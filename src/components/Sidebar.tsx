import { useState } from "react";
import type { FC, FormEvent } from "react";
import {
  FileText,
  Folder,
  Trash2,
  Edit2,
  FilePlus,
  Check,
} from "lucide-react";
import { FileStatus, VaultEntry } from "../types/gitVault";

interface SidebarProps {
  files: VaultEntry[];
  fileStatuses: FileStatus[];
  activeFilePath: string | null;
  onSelectFile: (path: string) => void;
  onCreateFile: (name: string) => void;
  onDeleteFile: (path: string) => void;
  onRenameFile: (oldPath: string, newPath: string) => void;
}

export const Sidebar: FC<SidebarProps> = ({
  files,
  fileStatuses,
  activeFilePath,
  onSelectFile,
  onCreateFile,
  onDeleteFile,
  onRenameFile,
}) => {
  const [isCreating, setIsCreating] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handleCreateSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!newFileName.trim()) return;
    const finalName = newFileName.endsWith(".md") ? newFileName : `${newFileName}.md`;
    onCreateFile(finalName);
    setNewFileName("");
    setIsCreating(false);
  };

  const handleRenameSubmit = (oldPath: string) => {
    if (!renameValue.trim() || renameValue === oldPath) {
      setRenamingPath(null);
      return;
    }
    const finalName = renameValue.endsWith(".md") ? renameValue : `${renameValue}.md`;
    onRenameFile(oldPath, finalName);
    setRenamingPath(null);
  };

  // Status lookup for badges
  const getFileBadge = (relPath: string) => {
    const status = fileStatuses.find(
      (s) => s.path === relPath || s.path.endsWith(relPath) || relPath.endsWith(s.path)
    );
    if (!status) return null;

    if (status.is_modified) {
      return (
        <span
          title="Modified in local worktree (unsaved)"
          className="text-amber-400 font-bold text-sm leading-none flex items-center"
        >
          •
        </span>
      );
    }
    if (status.is_untracked) {
      return (
        <span
          title="New untracked file"
          className="text-emerald-400 font-bold text-xs leading-none bg-emerald-950/80 px-1 py-0.5 rounded border border-emerald-500/30"
        >
          +
        </span>
      );
    }
    if (status.has_remote_update) {
      return (
        <span
          title="Updated on remote (incoming changes)"
          className="text-sky-400 font-bold text-xs leading-none bg-sky-950/80 px-1 py-0.5 rounded border border-sky-500/30"
        >
          ↓
        </span>
      );
    }
    return null;
  };

  return (
    <aside className="w-64 border-r border-[#30363d] bg-[#0d1117] flex flex-col h-full select-none">
      {/* Vault Header */}
      <div className="p-3 border-b border-[#21262d] flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
          <Folder className="w-3.5 h-3.5 text-sky-400" />
          <span>Vault Notes</span>
        </div>

        <button
          onClick={() => setIsCreating(true)}
          title="Create New Note"
          className="p-1 rounded hover:bg-[#21262d] text-zinc-400 hover:text-white transition-colors"
        >
          <FilePlus className="w-4 h-4" />
        </button>
      </div>

      {/* New Note Form */}
      {isCreating && (
        <form onSubmit={handleCreateSubmit} className="p-2 border-b border-[#21262d] bg-[#161b22]">
          <div className="flex items-center gap-1">
            <input
              type="text"
              autoFocus
              placeholder="Note title (e.g. Ideas.md)"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-white outline-none focus:border-sky-500"
            />
            <button
              type="submit"
              className="p-1 bg-sky-600 hover:bg-sky-500 text-white rounded text-xs"
            >
              <Check className="w-3 h-3" />
            </button>
          </div>
        </form>
      )}

      {/* File List */}
      <div className="flex-1 overflow-y-auto py-2">
        {files.length === 0 ? (
          <div className="px-4 py-8 text-center text-zinc-500 text-xs">
            No notes yet. Click + to create your first note.
          </div>
        ) : (
          <ul className="space-y-0.5 px-2">
            {files.map((file) => {
              const isActive = activeFilePath === file.path;
              const badge = getFileBadge(file.path);
              const isRenaming = renamingPath === file.path;

              return (
                <li
                  key={file.path}
                  className={`group flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs cursor-pointer transition-colors ${
                    isActive
                      ? "bg-sky-950/50 text-sky-200 border border-sky-800/40"
                      : "text-zinc-400 hover:bg-[#161b22] hover:text-zinc-200"
                  }`}
                  onClick={() => !isRenaming && onSelectFile(file.path)}
                >
                  <div className="flex items-center gap-2 overflow-hidden flex-1 mr-2">
                    <FileText
                      className={`w-3.5 h-3.5 shrink-0 ${
                        isActive ? "text-sky-400" : "text-zinc-500 group-hover:text-zinc-400"
                      }`}
                    />

                    {isRenaming ? (
                      <input
                        type="text"
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => handleRenameSubmit(file.path)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleRenameSubmit(file.path);
                          if (e.key === "Escape") setRenamingPath(null);
                        }}
                        className="w-full bg-[#0d1117] border border-sky-500 text-white rounded px-1 py-0.5 text-xs outline-none"
                      />
                    ) : (
                      <span className="truncate">{file.name}</span>
                    )}
                  </div>

                  {/* Badges & Actions */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* Live Git Status Badge */}
                    {badge}

                    {/* Quick action buttons on hover */}
                    <div className="hidden group-hover:flex items-center gap-1">
                      <button
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenamingPath(file.path);
                          setRenameValue(file.name);
                        }}
                        className="p-1 hover:text-white text-zinc-500 transition-colors"
                      >
                        <Edit2 className="w-3 h-3" />
                      </button>
                      <button
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Delete ${file.name}?`)) {
                            onDeleteFile(file.path);
                          }
                        }}
                        className="p-1 hover:text-red-400 text-zinc-500 transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Legend Footer */}
      <div className="p-3 border-t border-[#21262d] bg-[#161b22]/50 text-[11px] text-zinc-400 space-y-1.5">
        <div className="font-semibold text-zinc-300 text-[10px] uppercase tracking-wider">
          Git Worktree Legend
        </div>
        <div className="flex items-center gap-2">
          <span className="text-amber-400 font-bold text-sm leading-none">•</span>
          <span>Modified in worktree</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-emerald-400 font-bold text-xs leading-none">+</span>
          <span>New untracked file</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sky-400 font-bold text-xs leading-none">↓</span>
          <span>Remote change incoming</span>
        </div>
      </div>
    </aside>
  );
};
