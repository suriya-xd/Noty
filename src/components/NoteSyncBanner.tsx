import React from "react";
import { AlertTriangle, GitMerge, RefreshCw } from "lucide-react";
import type { FileStatus } from "../types/noetic";

interface NoteSyncBannerProps {
  /** The open note's sync status, if it has one. */
  status: FileStatus | undefined;
  busy?: boolean;
  onApplyUpdate: () => void;
  onChooseVersion: () => void;
  onUndoMerge: () => void;
  onKeepMerge: () => void;
}

/** What another device did to the open note, and what can be done about it. Shows nothing when
 * there is nothing to say. Typing is never blocked by it. */
export const NoteSyncBanner: React.FC<NoteSyncBannerProps> = ({
  status,
  busy,
  onApplyUpdate,
  onChooseVersion,
  onUndoMerge,
  onKeepMerge,
}) => {
  if (!status) return null;

  const button =
    "shrink-0 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default";

  if (status.conflict) {
    return (
      <div role="status" className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-orange-500/30 bg-orange-950/40 text-orange-200 text-xs">
        <AlertTriangle className="w-4 h-4 shrink-0 text-orange-400" />
        <span className="flex-1 min-w-0">
          Also changed on another device, in the same place. This version stays on this device until you choose.
        </span>
        <button type="button" disabled={busy} onClick={onChooseVersion} className={`${button} bg-orange-500/20 text-orange-200 hover:bg-orange-500/30`}>
          Choose version
        </button>
      </div>
    );
  }

  if (status.update_waiting) {
    return (
      <div role="status" className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-sky-500/30 bg-sky-950/40 text-sky-200 text-xs">
        <RefreshCw className="w-4 h-4 shrink-0 text-sky-400" />
        <span className="flex-1 min-w-0">Updated on another device.</span>
        <button type="button" disabled={busy} onClick={onApplyUpdate} className={`${button} bg-sky-500/20 text-sky-100 hover:bg-sky-500/30`}>
          Show update
        </button>
      </div>
    );
  }

  if (status.merged) {
    return (
      <div role="status" className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[#30363d] bg-[#161b22] text-zinc-300 text-xs">
        <GitMerge className="w-4 h-4 shrink-0 text-emerald-400" />
        <span className="flex-1 min-w-0">Combined with changes from another device.</span>
        <button type="button" disabled={busy} onClick={onUndoMerge} className={`${button} text-zinc-300 hover:bg-[#21262d]`}>
          Undo
        </button>
        <button type="button" disabled={busy} onClick={onKeepMerge} className={`${button} bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25`}>
          Keep
        </button>
      </div>
    );
  }

  return null;
};
