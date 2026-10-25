import { useState, useMemo } from "react";
import type { FC } from "react";
import { VaultEntry } from "../../types/gitVault";
import { Search, FileText, X } from "lucide-react";

interface CanvasAddNoteModalProps {
  isOpen: boolean;
  files: VaultEntry[];
  onClose: () => void;
  onSelectNote: (relPath: string) => void;
}

export const CanvasAddNoteModal: FC<CanvasAddNoteModalProps> = ({
  isOpen,
  files,
  onClose,
  onSelectNote,
}) => {
  const [search, setSearch] = useState("");

  const filteredNotes = useMemo(() => {
    return files
      .filter((f) => !f.is_directory && !f.path.endsWith(".canvas"))
      .filter((f) => f.path.toLowerCase().includes(search.toLowerCase().trim()));
  }, [files, search]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-100">
      <div className="w-full max-w-md bg-[#161b22] border border-[#30363d] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]">
        {/* Header */}
        <div className="px-4 py-3 border-b border-[#21262d] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-semibold text-white">Add Note to Canvas</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:text-white text-zinc-400 rounded-md transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="p-3 border-b border-[#21262d]">
          <div className="relative">
            <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search note name or folder path..."
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-zinc-500 outline-none focus:border-sky-500 transition-colors"
            />
          </div>
        </div>

        {/* File List */}
        <div className="flex-1 overflow-auto p-2 divide-y divide-[#21262d]/50">
          {filteredNotes.length === 0 ? (
            <div className="text-center py-8 text-xs text-zinc-500">
              No notes found matching "{search}"
            </div>
          ) : (
            filteredNotes.map((file) => (
              <button
                key={file.path}
                onClick={() => {
                  onSelectNote(file.path);
                  onClose();
                }}
                className="w-full px-3 py-2 text-left rounded-lg hover:bg-[#21262d] flex items-center gap-2.5 transition-colors cursor-pointer group"
              >
                <FileText className="w-4 h-4 text-zinc-400 group-hover:text-sky-400 shrink-0" />
                <div className="overflow-hidden flex-1">
                  <div className="text-xs font-medium text-zinc-200 group-hover:text-white truncate">
                    {file.name}
                  </div>
                  <div className="text-[10px] text-zinc-500 font-mono truncate">
                    {file.path}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
