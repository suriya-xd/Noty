import { useEscapeKey } from "../dialogs";
import { useState, useMemo, useEffect } from "react";
import type { FC } from "react";
import { VaultEntry } from "../../types/noetic";
import { Search, FileText, FilePlus, X } from "lucide-react";

interface CanvasAddNoteModalProps {
  isOpen: boolean;
  files: VaultEntry[];
  onClose: () => void;
  onSelectNote: (relPath: string) => void;
  /** Creates a new note from the typed name and places it on the canvas. */
  onCreateNote?: (name: string) => Promise<void>;
}

export const CanvasAddNoteModal: FC<CanvasAddNoteModalProps> = ({
  isOpen,
  files,
  onClose,
  onSelectNote,
  onCreateNote,
}) => {
  useEscapeKey(isOpen, onClose);
  const [search, setSearch] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setSearch("");
      setCreateError(null);
      setIsCreating(false);
    }
  }, [isOpen]);

  const filteredNotes = useMemo(() => {
    return files
      .filter((f) => !f.is_directory && !f.path.endsWith(".canvas"))
      .filter((f) => f.path.toLowerCase().includes(search.toLowerCase().trim()));
  }, [files, search]);

  const newName = search.trim();
  const exactMatch = useMemo(() => {
    const wanted = newName.toLowerCase().replace(/\.md$/, "");
    return filteredNotes.some(
      (f) =>
        f.path.toLowerCase().replace(/\.md$/, "") === wanted ||
        f.name.toLowerCase().replace(/\.md$/, "") === wanted
    );
  }, [filteredNotes, newName]);
  const canCreate = !!onCreateNote && newName.length > 0 && !exactMatch;

  const handleCreate = async () => {
    if (!canCreate || isCreating || !onCreateNote) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      await onCreateNote(newName);
      onClose();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : `Failed to create note: ${err}`);
    } finally {
      setIsCreating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="app-modal fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-100">
      <div className="app-modal-panel w-full max-w-md bg-[#161b22] border border-[#30363d] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh]">
        {/* Header */}
        <div className="px-4 py-3 border-b border-[#21262d] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-semibold text-white">Add or Create Note</span>
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
              onChange={(e) => {
                setSearch(e.target.value);
                setCreateError(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (canCreate) {
                  void handleCreate();
                } else if (newName && filteredNotes.length > 0) {
                  onSelectNote(filteredNotes[0].path);
                  onClose();
                }
              }}
              placeholder="Search notes, or type a name to create one..."
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-zinc-500 outline-none focus:border-sky-500 transition-colors"
            />
          </div>
          {createError && <div className="mt-2 text-[11px] text-amber-400">{createError}</div>}
        </div>

        {/* File List */}
        <div className="flex-1 overflow-auto p-2 divide-y divide-[#21262d]/50">
          {canCreate && (
            <button
              onClick={() => void handleCreate()}
              disabled={isCreating}
              className="w-full px-3 py-2 text-left rounded-lg hover:bg-[#21262d] flex items-center gap-2.5 transition-colors cursor-pointer group disabled:opacity-60 disabled:cursor-wait"
            >
              <FilePlus className="w-4 h-4 text-emerald-400 shrink-0" />
              <div className="overflow-hidden flex-1">
                <div className="text-xs font-medium text-zinc-200 group-hover:text-white truncate">
                  {isCreating ? "Creating..." : <>Create note “{newName.replace(/\.md$/i, "")}”</>}
                </div>
                <div className="text-[10px] text-zinc-500 truncate">
                  New note, placed on the canvas (Enter)
                </div>
              </div>
            </button>
          )}
          {filteredNotes.length === 0 ? (
            !canCreate && (
              <div className="text-center py-8 text-xs text-zinc-500">
                No notes found matching "{search}"
              </div>
            )
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
