import { useMemo, useState } from "react";
import type { FC } from "react";
import { FileIcon, ImageIcon, Trash2, X } from "lucide-react";
import type { VaultEntry } from "../types/noetic";
import { resolveImageUrl } from "../services/noeticBridge";
import { assetFiles, formatBytes, isImagePath } from "../utils/assets";
import { useBackLayer } from "../utils/backNavigation";
import { ConfirmDialog, useEscapeKey } from "./dialogs";

export interface AssetsModalProps {
  isOpen: boolean;
  onClose: () => void;
  vaultPath: string;
  /** Every entry in the notes folder; the uploaded files are picked out of it here. */
  files: VaultEntry[];
  onPreviewImage: (src: string, alt?: string, title?: string) => void;
  onDeleteFile: (relPath: string) => Promise<void> | void;
}

/**
 * Everything uploaded into notes (images pasted, dropped or inserted), which lives in the
 * `assets` folder. It's opened from Settings so the folder doesn't crowd the notes list.
 */
export const AssetsModal: FC<AssetsModalProps> = ({
  isOpen,
  onClose,
  vaultPath,
  files,
  onPreviewImage,
  onDeleteFile,
}) => {
  useBackLayer(isOpen, onClose);
  const [pendingDelete, setPendingDelete] = useState<VaultEntry | null>(null);
  useEscapeKey(isOpen && !pendingDelete, onClose);

  const assets = useMemo(() => assetFiles(files), [files]);
  const totalBytes = useMemo(() => assets.reduce((n, a) => n + a.size_bytes, 0), [assets]);

  if (!isOpen) return null;

  return (
    <div
      className="app-modal fixed inset-0 z-[60] flex items-stretch sm:items-center justify-center bg-black/80 backdrop-blur-sm sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Uploaded files"
      onMouseDown={onClose}
    >
      <div
        className="app-modal-panel flex flex-col w-full sm:max-w-2xl sm:max-h-[80vh] bg-[#0d1117] sm:border border-[#30363d] sm:rounded-2xl shadow-2xl text-zinc-100 overflow-hidden pt-[env(safe-area-inset-top,0px)] sm:pt-0"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#30363d] bg-[#161b22]">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-white">Uploaded files</h2>
            <p className="text-xs text-zinc-400 truncate">
              {assets.length === 0
                ? "Images you add to notes appear here"
                : `${assets.length} ${assets.length === 1 ? "file" : "files"} · ${formatBytes(totalBytes)}`}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="w-10 h-10 sm:w-8 sm:h-8 shrink-0 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-[#21262d] rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 pb-[calc(env(safe-area-inset-bottom,0px)+16px)]">
          {assets.length === 0 ? (
            <div className="py-16 text-center text-sm text-zinc-500">
              <ImageIcon className="w-8 h-8 mx-auto mb-3 text-zinc-600" />
              Nothing uploaded yet.
            </div>
          ) : (
            <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {assets.map((a) => {
                const url = resolveImageUrl(a.path, vaultPath);
                const image = isImagePath(a.path);
                return (
                  <li
                    key={a.path}
                    className="group relative rounded-xl overflow-hidden bg-[#161b22] border border-[#30363d]"
                  >
                    <button
                      type="button"
                      onClick={() => (image ? onPreviewImage(url, a.name, a.name) : undefined)}
                      className="block w-full aspect-square bg-[#0b0f14] cursor-pointer"
                      aria-label={`Open ${a.name}`}
                    >
                      {image ? (
                        <img src={url} alt={a.name} loading="lazy" className="w-full h-full object-cover" />
                      ) : (
                        <FileIcon className="w-8 h-8 m-auto text-zinc-600" />
                      )}
                    </button>
                    <div className="flex items-center gap-1 px-2.5 py-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-zinc-200 truncate" title={a.path}>
                          {a.name}
                        </div>
                        <div className="text-[11px] text-zinc-500">{formatBytes(a.size_bytes)}</div>
                      </div>
                      <button
                        type="button"
                        aria-label={`Delete ${a.name}`}
                        onClick={() => setPendingDelete(a)}
                        className="w-9 h-9 sm:w-7 sm:h-7 shrink-0 flex items-center justify-center rounded-md text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        title={`Delete "${pendingDelete?.name ?? ""}"?`}
        message="Notes that show this file will show a missing image instead."
        confirmLabel="Delete"
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void onDeleteFile(target.path);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
};
