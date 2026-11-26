import {
  RefreshCw,
  Layers,
  Sparkles,
  ChevronDown,
} from "lucide-react";
import { describeSync } from "../utils/syncStatus";
import type { SyncKind, SyncProblem } from "../utils/syncStatus";
import { RepoStatusPayload } from "../types/noetic";

const GithubIcon: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
    />
  </svg>
);

const BADGE: Record<SyncKind, { bg: string; dot: string }> = {
  synced: { bg: "bg-emerald-950/60 border-emerald-500/40 text-emerald-400", dot: "bg-emerald-400" },
  waiting: { bg: "bg-amber-950/60 border-amber-500/40 text-amber-400", dot: "bg-amber-400 animate-pulse" },
  updates: { bg: "bg-sky-950/60 border-sky-500/40 text-sky-400", dot: "bg-sky-400" },
  conflict: { bg: "bg-orange-950/60 border-orange-500/40 text-orange-400", dot: "bg-orange-400 animate-pulse" },
  offline: { bg: "bg-purple-950/60 border-purple-500/40 text-purple-400", dot: "bg-purple-400" },
  "sign-in": { bg: "bg-red-950/60 border-red-500/40 text-red-400", dot: "bg-red-400" },
  "signed-out": { bg: "bg-[#21262d] border-[#30363d] text-zinc-300", dot: "bg-zinc-500" },
};

interface TopBarProps {
  status: RepoStatusPayload | null;
  isLoading: boolean;
  syncProblem: SyncProblem | null;
  onSync: () => void;
  /** Opens the resolver on the notes waiting for a version to be chosen. */
  onOpenConflicts: () => void;
  onOpenWorkspaces: () => void;
  onOpenOnboarding: () => void;
  onSimulateState?: (stateType: string) => void;
  onGoToDashboard?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  status,
  isLoading,
  syncProblem,
  onSync,
  onOpenConflicts,
  onOpenWorkspaces,
  onOpenOnboarding,
  onSimulateState,
  onGoToDashboard,
}) => {
  const isSignedOut = !!status && !status.remote_url;
  const workspaceName = status?.branch || (isSignedOut ? "My notes" : "Choose workspace");

  const sync = describeSync(status, syncProblem);
  const badge = BADGE[sync.kind];

  return (
    <header className="h-14 border-b border-[#30363d]/70 bg-[#161b22]/95 backdrop-blur-xl px-4 flex items-center justify-between z-20 select-none">
      {/* Left: branding and the workspace switcher */}
      <div className="flex-1 min-w-0 flex items-center gap-3">
        {/* Noetic Brand */}
        <button
          type="button"
          onClick={onGoToDashboard}
          title="Return to Dashboard"
          className="flex items-center gap-2 group cursor-pointer border-none bg-transparent p-0 text-left shrink-0"
        >
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-sky-500 via-indigo-500 to-purple-500 flex items-center justify-center shadow-md shadow-sky-500/20 group-hover:scale-105 transition-transform">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="font-headline font-bold text-sm tracking-tight text-white group-hover:text-sky-300 transition-colors">Noetic</span>
        </button>

        <div className="h-4 w-[1px] bg-[#30363d] shrink-0" />

        {/* Workspace switcher */}
        <button
          id="btn-workspaces"
          onClick={isSignedOut ? onOpenOnboarding : onOpenWorkspaces}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#21262d] hover:bg-[#30363d] text-xs text-zinc-300 border border-[#30363d] transition-colors cursor-pointer group min-w-0"
          title={isSignedOut ? "Sign in to use workspaces" : "Switch workspace"}
        >
          <Layers className="w-3.5 h-3.5 text-sky-400 group-hover:scale-105 transition-transform shrink-0" />
          <span className="font-medium text-white truncate">{workspaceName}</span>
          <ChevronDown className="w-3 h-3 text-zinc-500 group-hover:text-zinc-300 shrink-0" />
        </button>
      </div>

      {/* Middle: sync status and Sync now */}
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onClick={sync.kind === "sign-in" ? onOpenOnboarding : sync.kind === "conflict" ? onOpenConflicts : undefined}
          title={sync.detail}
          className={`flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-medium transition-all duration-300 ${badge.bg} ${
            sync.kind === "sign-in" || sync.kind === "conflict" ? "cursor-pointer" : "cursor-default"
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${badge.dot}`} />
          <span>{sync.label}</span>
        </button>

        <button
          id="btn-sync"
          type="button"
          onClick={onSync}
          disabled={isLoading || isSignedOut}
          title="Sync now: upload your changes and get the ones from your other devices"
          aria-label="Sync now"
          className="p-1.5 rounded-md transition-colors cursor-pointer text-sky-400 hover:text-sky-300 hover:bg-sky-500/15 disabled:text-zinc-600 disabled:hover:bg-transparent disabled:cursor-not-allowed"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Right: state simulation and sign-in */}
      <div className="flex-1 min-w-0 flex items-center justify-end gap-2">
        {/* Simulation testing menu: development builds only, and only when there is room for it */}
        {import.meta.env.DEV && onSimulateState && (
          <select
            onChange={(e) => onSimulateState(e.target.value)}
            value=""
            className="hidden xl:block max-w-[170px] text-xs bg-[#21262d] border border-dashed border-[#30363d] text-zinc-300 rounded px-2 py-1 outline-none cursor-pointer hover:border-zinc-500"
            title="Simulate sync states"
          >
            <option value="" disabled>
              ⚡ Test Sync States
            </option>
            <option value="clean_synced">1. Clean Synced (Up to date)</option>
            <option value="dirty_synced">2. Dirty Synced (Unsaved Edits)</option>
            <option value="clean_behind">3. Clean Behind (Updates waiting)</option>
            <option value="dirty_behind">4. Dirty Behind (Out of Sync + Edits)</option>
            <option value="ahead_offline">5. Ahead Offline (Saved offline)</option>
            <option value="conflict_trigger">💥 Trigger 3-Way Conflict</option>
          </select>
        )}

        {/* Sign-in prompt, only while this device isn't linked to an account. */}
        {!status?.remote_url && (
          <button
            onClick={onOpenOnboarding}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-500/40 text-amber-300 hover:text-white hover:border-amber-400 transition-all cursor-pointer shadow-sm shadow-amber-500/10 shrink-0 whitespace-nowrap"
            title="Sign in to back up your notes and sync them across devices"
          >
            <GithubIcon className="w-3.5 h-3.5" />
            <span>Sign in to sync</span>
          </button>
        )}
      </div>
    </header>
  );
};
