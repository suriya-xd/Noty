import { useState, useMemo } from "react";
import type { FC, FormEvent } from "react";
import {
  FileText,
  Folder,
  FolderPlus,
  FilePlus,
  Search,
  Sparkles,
  ArrowRight,
  GitBranch,
  ArrowLeftRight,
  Plus,
  X,
  LayoutGrid,
} from "lucide-react";
import { FileStatus, RepoStatusPayload, VaultEntry } from "../types/gitVault";
import { buildFileTree, countNotes } from "./Sidebar";
import { backlinksGraph } from "../utils/wikilinks/backlinksGraph";

interface DashboardProps {
  vaultPath?: string;
  files: VaultEntry[];
  fileStatuses?: FileStatus[];
  onSelectFile: (path: string) => void;
  onCreateFile: (name: string) => void;
  onCreateFolder: (path: string) => void;
  status?: RepoStatusPayload | null;
}

export const Dashboard: FC<DashboardProps> = ({
  vaultPath = "",
  files,
  fileStatuses = [],
  onSelectFile,
  onCreateFile,
  onCreateFolder,
  status,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [creatingType, setCreatingType] = useState<"file" | "folder" | null>(null);
  const [creatingParent, setCreatingParent] = useState<string>("");
  const [createInputValue, setCreateInputValue] = useState("");

  // Derive human-readable vault name
  const vaultName = vaultPath
    ? vaultPath.split(/[/\\]/).filter(Boolean).pop() || "personal-vault"
    : "personal-vault";

  // Build root hierarchy
  const rootNodes = useMemo(() => buildFileTree(files), [files]);

  // Map file status by path for quick lookup
  const statusMap = useMemo(() => {
    const map = new Map<string, FileStatus>();
    fileStatuses.forEach((s) => map.set(s.path, s));
    return map;
  }, [fileStatuses]);

  // Separate top-level folders and top-level notes
  const topFolders = useMemo(
    () =>
      rootNodes.filter((node) => {
        if (!node.isDirectory) return false;
        if (!searchQuery.trim()) return true;
        return node.name.toLowerCase().includes(searchQuery.toLowerCase());
      }),
    [rootNodes, searchQuery]
  );

  const topNotes = useMemo(
    () =>
      rootNodes.filter((node) => {
        if (node.isDirectory) return false;
        if (!searchQuery.trim()) return true;
        return node.name.toLowerCase().includes(searchQuery.toLowerCase());
      }),
    [rootNodes, searchQuery]
  );

  // Total statistics
  const totalNotesCount = useMemo(() => {
    return files.filter((f) => !f.is_directory && f.path.endsWith(".md")).length;
  }, [files]);

  const totalFoldersCount = useMemo(() => {
    return rootNodes.filter((n) => n.isDirectory).length;
  }, [rootNodes]);

  const handleStartCreate = (type: "file" | "folder", parent = "") => {
    setCreatingType(type);
    setCreatingParent(parent);
    setCreateInputValue("");
  };

  const handleCancelCreate = () => {
    setCreatingType(null);
    setCreatingParent("");
    setCreateInputValue("");
  };

  const handleCreateSubmit = (e: FormEvent) => {
    e.preventDefault();
    const clean = createInputValue.trim();
    if (!clean || !creatingType) return;

    if (creatingType === "file") {
      const finalName = clean.endsWith(".md") || clean.endsWith(".canvas") ? clean : `${clean}.md`;
      const fullPath = creatingParent ? `${creatingParent}/${finalName}` : finalName;
      onCreateFile(fullPath);
    } else {
      const fullPath = creatingParent ? `${creatingParent}/${clean}` : clean;
      onCreateFolder(fullPath);
    }

    handleCancelCreate();
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-[#0d1117] text-zinc-100 select-none">
      {/* Hero / Vault Header Banner */}
      <div className="border-b border-[#30363d]/70 bg-gradient-to-b from-[#161b22] to-[#0d1117]/60 px-8 py-7">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            {/* Title & Branding */}
            <div>
              <div className="flex items-center gap-2.5 mb-1.5">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-sky-500 via-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-sky-500/20">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <h1 className="font-headline font-bold text-2xl tracking-tight text-white flex items-center gap-2">
                  <span>{vaultName}</span>
                  <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/20">
                    Vault Dashboard
                  </span>
                </h1>
              </div>
              <p className="text-xs text-zinc-400">
                Explore your notes hierarchy, browse folders, or jump directly into any note.
              </p>
            </div>

            {/* Quick Action Buttons */}
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => handleStartCreate("file")}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white shadow-md shadow-sky-600/20 hover:scale-[1.02] active:scale-95 transition-all cursor-pointer"
                title="Create a new note at root"
              >
                <FilePlus className="w-3.5 h-3.5" />
                <span>New Note</span>
              </button>
              <button
                type="button"
                onClick={() => handleStartCreate("folder")}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium bg-[#21262d] hover:bg-[#30363d] text-zinc-200 border border-[#30363d] hover:scale-[1.02] active:scale-95 transition-all cursor-pointer"
                title="Create a new folder at root"
              >
                <FolderPlus className="w-3.5 h-3.5 text-amber-400" />
                <span>New Folder</span>
              </button>
            </div>
          </div>

          {/* Quick Metrics Bar & Search Filter */}
          <div className="mt-6 flex flex-col md:flex-row md:items-center justify-between gap-4 pt-4 border-t border-[#30363d]/40">
            {/* Quick Stats Badges */}
            <div className="flex items-center flex-wrap gap-2 text-xs">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#161b22] border border-[#30363d] text-zinc-300">
                <FileText className="w-3.5 h-3.5 text-sky-400" />
                <span className="font-semibold text-white">{totalNotesCount}</span>
                <span className="text-zinc-400">{totalNotesCount === 1 ? "note" : "notes"}</span>
              </div>

              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#161b22] border border-[#30363d] text-zinc-300">
                <Folder className="w-3.5 h-3.5 text-amber-400" />
                <span className="font-semibold text-white">{totalFoldersCount}</span>
                <span className="text-zinc-400">{totalFoldersCount === 1 ? "folder" : "folders"}</span>
              </div>

              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#161b22] border border-[#30363d] text-zinc-300">
                <GitBranch className="w-3.5 h-3.5 text-purple-400" />
                <span className="font-medium">{status?.branch || "main"}</span>
              </div>
            </div>

            {/* Search Filter */}
            <div className="relative w-full md:w-64">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter top hierarchy..."
                className="w-full bg-[#161b22] border border-[#30363d] focus:border-sky-500 text-xs rounded-lg pl-8 pr-3 py-1.5 text-zinc-200 placeholder-zinc-500 outline-none transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 p-0.5"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          </div>

          {/* Inline creation input bar if active */}
          {creatingType && (
            <form
              onSubmit={handleCreateSubmit}
              className="mt-4 p-3 rounded-lg bg-[#161b22] border border-sky-500/50 flex items-center gap-2 animate-fadeIn"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-sky-400 px-2 py-1 rounded bg-sky-500/10 border border-sky-500/20">
                {creatingType === "file" ? <FilePlus className="w-3.5 h-3.5" /> : <FolderPlus className="w-3.5 h-3.5" />}
                <span>New {creatingType === "file" ? "Note" : "Folder"}</span>
                {creatingParent && <span className="text-zinc-400 font-mono">in /{creatingParent}</span>}
              </div>

              <input
                type="text"
                autoFocus
                value={createInputValue}
                onChange={(e) => setCreateInputValue(e.target.value)}
                placeholder={creatingType === "file" ? "e.g. Daily Standup.md" : "e.g. Research"}
                className="flex-1 bg-[#0d1117] border border-[#30363d] focus:border-sky-500 text-xs text-white rounded px-2.5 py-1.5 outline-none font-mono"
                onKeyDown={(e) => {
                  if (e.key === "Escape") handleCancelCreate();
                }}
              />

              <button
                type="submit"
                className="px-3 py-1.5 rounded text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white cursor-pointer"
              >
                Create
              </button>
              <button
                type="button"
                onClick={handleCancelCreate}
                className="p-1.5 rounded hover:bg-[#21262d] text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Main Content Area: Top Hierarchy Sections */}
      <div className="flex-1 max-w-6xl w-full mx-auto p-8 space-y-10">
        {/* Section 1: Top-Level Folders */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Folder className="w-4 h-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-white tracking-wide uppercase">
                Folders
              </h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-[#161b22] border border-[#30363d] text-zinc-400 font-mono">
                {topFolders.length}
              </span>
            </div>

            <button
              type="button"
              onClick={() => handleStartCreate("folder")}
              className="text-xs text-zinc-400 hover:text-amber-300 flex items-center gap-1 transition-colors cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              <span>Add Folder</span>
            </button>
          </div>

          {topFolders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#30363d] bg-[#161b22]/30 p-6 text-center text-xs text-zinc-500">
              No top-level folders found. Click <span className="text-amber-400 font-medium">Add Folder</span> to organize your notes.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {topFolders.map((folder) => {
                const noteCount = countNotes(folder);
                const hasChildren = folder.children && folder.children.length > 0;

                return (
                  <div
                    key={folder.path}
                    className="group bg-[#161b22]/70 hover:bg-[#1c2128] border border-[#30363d]/80 hover:border-amber-500/40 rounded-xl p-4 transition-all duration-200 flex flex-col justify-between shadow-sm"
                  >
                    <div>
                      {/* Folder Title & Note Counter */}
                      <div className="flex items-start justify-between gap-3 mb-2.5">
                        <div className="flex items-center gap-2.5">
                          <div className="w-9 h-9 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 group-hover:scale-105 transition-transform">
                            <Folder className="w-4 h-4" />
                          </div>
                          <div>
                            <h3 className="text-sm font-semibold text-white group-hover:text-amber-300 transition-colors">
                              {folder.name}
                            </h3>
                            <p className="text-[11px] text-zinc-400">
                              {noteCount} {noteCount === 1 ? "note" : "notes"}
                            </p>
                          </div>
                        </div>

                        {/* Quick Add Note inside folder */}
                        <button
                          type="button"
                          onClick={() => handleStartCreate("file", folder.path)}
                          title={`Create note inside ${folder.name}`}
                          className="opacity-0 group-hover:opacity-100 flex items-center gap-1 text-[11px] font-medium text-amber-400 hover:text-amber-300 px-2 py-1 rounded bg-[#21262d] hover:bg-[#30363d] transition-all cursor-pointer"
                        >
                          <Plus className="w-3 h-3" />
                          <span>note</span>
                        </button>
                      </div>

                      {/* Sub-notes preview chips */}
                      <div className="mt-3 pt-3 border-t border-[#30363d]/40">
                        {hasChildren ? (
                          <div className="space-y-1">
                            <div className="text-[10px] uppercase font-mono text-zinc-500 mb-1">
                              Contents:
                            </div>
                            <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                              {folder.children.map((child) => (
                                <button
                                  key={child.path}
                                  type="button"
                                  onClick={() => !child.isDirectory && onSelectFile(child.path)}
                                  className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono transition-colors truncate max-w-full ${
                                    child.isDirectory
                                      ? "bg-[#21262d] text-amber-400/80 cursor-default"
                                      : "bg-[#0d1117] hover:bg-sky-500/20 text-zinc-300 hover:text-sky-300 border border-[#30363d] hover:border-sky-500/40 cursor-pointer"
                                  }`}
                                  title={child.path}
                                >
                                  {child.isDirectory ? (
                                    <Folder className="w-2.5 h-2.5 text-amber-400" />
                                  ) : (
                                    <FileText className="w-2.5 h-2.5 text-sky-400" />
                                  )}
                                  <span className="truncate">{child.name}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="text-[11px] text-zinc-500 italic">
                            Empty folder · No notes yet
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Section 2: Top-Level Notes */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-sky-400" />
              <h2 className="text-sm font-semibold text-white tracking-wide uppercase">
                Notes
              </h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-[#161b22] border border-[#30363d] text-zinc-400 font-mono">
                {topNotes.length}
              </span>
            </div>

            <button
              type="button"
              onClick={() => handleStartCreate("file")}
              className="text-xs text-zinc-400 hover:text-sky-300 flex items-center gap-1 transition-colors cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              <span>Add Note</span>
            </button>
          </div>

          {topNotes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#30363d] bg-[#161b22]/30 p-8 text-center text-xs text-zinc-500">
              No top-level notes found. Click <span className="text-sky-400 font-medium">Add Note</span> to start writing.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {topNotes.map((note) => {
                const fileStat = statusMap.get(note.path);
                const incomingLinks = backlinksGraph.getBacklinks(note.path).length;
                const outgoingLinks = backlinksGraph.getForwardLinks(note.path).length;

                return (
                  <div
                    key={note.path}
                    onClick={() => onSelectFile(note.path)}
                    className="group bg-[#161b22]/70 hover:bg-[#1c2128] border border-[#30363d]/80 hover:border-sky-500/50 hover:shadow-lg hover:shadow-sky-500/5 rounded-xl p-4 transition-all duration-200 cursor-pointer flex flex-col justify-between min-h-[125px]"
                  >
                    <div>
                      {/* Note Header & Status Badge */}
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2.5">
                          {note.name.endsWith(".canvas") ? (
                            <div className="w-9 h-9 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-400 group-hover:scale-105 transition-transform">
                              <LayoutGrid className="w-4 h-4" />
                            </div>
                          ) : (
                            <div className="w-9 h-9 rounded-lg bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-400 group-hover:scale-105 transition-transform">
                              <FileText className="w-4 h-4" />
                            </div>
                          )}
                          <div>
                            <h3 className="text-sm font-semibold text-white group-hover:text-sky-300 transition-colors">
                              {note.name.replace(/\.(md|canvas)$/, "")}
                            </h3>
                            <span className="font-mono text-[10px] text-zinc-500">
                              {note.name.endsWith(".canvas") ? "Canvas Board" : note.name}
                            </span>
                          </div>
                        </div>

                        {/* Git Status Indicator */}
                        {fileStat?.is_modified ? (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                            Modified
                          </span>
                        ) : fileStat?.is_untracked ? (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                            New
                          </span>
                        ) : null}
                      </div>

                      {/* Links Metadata */}
                      <div className="flex items-center gap-2 mt-3 pt-2 text-[11px] font-mono text-zinc-400">
                        <div className="flex items-center gap-1" title={`${incomingLinks} incoming backlinks, ${outgoingLinks} outgoing links`}>
                          <ArrowLeftRight className="w-3 h-3 text-sky-400" />
                          <span>{incomingLinks} in · {outgoingLinks} out</span>
                        </div>
                      </div>
                    </div>

                    {/* Bottom Action Footer */}
                    <div className="mt-4 pt-2.5 border-t border-[#30363d]/40 flex items-center justify-between text-xs text-zinc-400 group-hover:text-sky-300 transition-colors">
                      <span className="text-[11px] font-medium">Open note</span>
                      <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
