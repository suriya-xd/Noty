import {
  Save,
  RefreshCw,
  GitBranch,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Sparkles,
  WifiOff,
  FolderOpen,
  ChevronDown,
} from "lucide-react";
import { RepoStatusPayload, SyncState } from "../types/gitVault";

const GithubIcon: React.FC<{ className?: string }> = ({ className = "w-3.5 h-3.5" }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
    />
  </svg>
);

interface TopBarProps {
  status: RepoStatusPayload | null;
  isLoading: boolean;
  vaultPath?: string;
  onSave: () => void;
  onSync: () => void;
  onFetch: () => void;
  onOpenRepoSwitch: () => void;
  onOpenOnboarding: () => void;
  onSimulateState?: (stateType: string) => void;
  onGoToDashboard?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  status,
  isLoading,
  vaultPath,
  onSave,
  onSync,
  onFetch,
  onOpenRepoSwitch,
  onOpenOnboarding,
  onSimulateState,
  onGoToDashboard,
}) => {
  const syncState: SyncState = status?.state || "CleanSynced";

  // Derive vault display name
  const vaultName = vaultPath
    ? vaultPath.split(/[/\\]/).filter(Boolean).pop() || "personal-vault"
    : "personal-vault";

  // Derive Status Pill appearance based on the 5 distinct states
  const getStatusBadge = () => {
    switch (syncState) {
      case "CleanSynced":
        return {
          bg: "bg-emerald-950/60 border-emerald-500/40 text-emerald-400",
          dot: "bg-emerald-400 shadow-[0_0_8px_#34d399]",
          icon: <CheckCircle2 className="w-3.5 h-3.5" />,
          label: "Synced",
          desc: "Local vault in sync with GitHub",
        };
      case "DirtySynced":
        return {
          bg: "bg-amber-950/60 border-amber-500/40 text-amber-400",
          dot: "bg-amber-400 shadow-[0_0_8px_#fbbf24] animate-pulse",
          icon: <Clock className="w-3.5 h-3.5" />,
          label: `Unsaved (${status?.dirty_count || 1})`,
          desc: "Edits written to disk. Click Save to stage & commit.",
        };
      case "CleanBehind":
        return {
          bg: "bg-sky-950/60 border-sky-500/40 text-sky-400",
          dot: "bg-sky-400 shadow-[0_0_8px_#38bdf8]",
          icon: <RefreshCw className="w-3.5 h-3.5" />,
          label: `Out of sync (${status?.behind_count || 1} incoming)`,
          desc: "Remote ahead. Click Sync to pull updates.",
        };
      case "DirtyBehind":
        return {
          bg: "bg-orange-950/60 border-orange-500/40 text-orange-400",
          dot: "bg-orange-400 shadow-[0_0_8px_#fb923c] animate-pulse",
          icon: <AlertTriangle className="w-3.5 h-3.5" />,
          label: "Dirty Behind",
          desc: "Remote has changes & you have local edits. Click Sync to 3-way merge.",
        };
      case "AheadOffline":
        return {
          bg: "bg-purple-950/60 border-purple-500/40 text-purple-400",
          dot: "bg-purple-400 shadow-[0_0_8px_#c084fc]",
          icon: <WifiOff className="w-3.5 h-3.5" />,
          label: `Ahead (+${status?.ahead_count || 1} offline)`,
          desc: "Committed offline. Push will resume when online.",
        };
    }
  };

  const badge = getStatusBadge();

  // Button active / disabled states per SPEC.md
  const canSave = syncState === "DirtySynced" || syncState === "AheadOffline";
  const canSync = syncState === "CleanBehind" || syncState === "DirtyBehind";

  return (
    <header className="h-14 border-b border-[#30363d]/70 bg-[#161b22]/95 backdrop-blur-xl px-4 flex items-center justify-between z-20 select-none">
      {/* Left: Desktop Controls, Branding & Vault / Branch */}
      <div className="flex-1 flex items-center gap-3">
        {/* Subtle desktop window dots */}
        <div className="flex items-center gap-1.5 mr-1">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500/40 hover:bg-red-500 transition-colors cursor-pointer" />
          <span className="w-2.5 h-2.5 rounded-full bg-amber-500/40 hover:bg-amber-500 transition-colors cursor-pointer" />
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/40 hover:bg-emerald-500 transition-colors cursor-pointer" />
        </div>

        <div className="h-4 w-[1px] bg-[#30363d]" />

        {/* Noty Brand */}
        <button
          type="button"
          onClick={onGoToDashboard}
          title="Return to Dashboard"
          className="flex items-center gap-2 group cursor-pointer border-none bg-transparent p-0 text-left"
        >
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-sky-500 via-indigo-500 to-purple-500 flex items-center justify-center shadow-md shadow-sky-500/20 group-hover:scale-105 transition-transform">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="font-headline font-bold text-sm tracking-tight text-white group-hover:text-sky-300 transition-colors">Noty</span>
        </button>

        <div className="h-4 w-[1px] bg-[#30363d]" />

        {/* Vault Switcher Pill */}
        <button
          onClick={onOpenRepoSwitch}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#21262d] hover:bg-[#30363d] text-xs font-mono text-zinc-300 border border-[#30363d] transition-colors cursor-pointer group"
          title="Switch Active Vault"
        >
          <FolderOpen className="w-3.5 h-3.5 text-sky-400 group-hover:scale-105 transition-transform" />
          <span className="font-medium text-white">{vaultName}</span>
          <ChevronDown className="w-3 h-3 text-zinc-500 group-hover:text-zinc-300" />
        </button>

        {/* Git Branch & Ahead/Behind Badges */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#21262d] text-xs font-mono text-zinc-300 border border-[#30363d]">
          <GitBranch className="w-3.5 h-3.5 text-purple-400" />
          <span className="font-medium">{status?.branch || "main"}</span>
          {status?.ahead_count ? (
            <span className="ml-0.5 text-[10px] px-1 bg-purple-500/25 text-purple-300 rounded font-semibold" title={`${status.ahead_count} commits ahead of remote`}>
              +{status.ahead_count}
            </span>
          ) : null}
          {status?.behind_count ? (
            <span className="ml-0.5 text-[10px] px-1 bg-sky-500/25 text-sky-300 rounded font-semibold" title={`${status.behind_count} commits behind remote`}>
              -{status.behind_count}
            </span>
          ) : null}
        </div>
      </div>

      {/* Middle: Live Sync Status Pill Flanked by Sync & Save Icon Buttons */}
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Sync Icon Button (Left of Pill) */}
        <button
          id="btn-sync"
          onClick={canSync ? onSync : onFetch}
          disabled={isLoading}
          title={
            canSync
              ? "Pull changes from origin/main"
              : "Fetch latest refs from remote"
          }
          className={`p-1.5 rounded-md transition-colors cursor-pointer ${
            canSync
              ? "text-sky-400 hover:text-sky-300 hover:bg-sky-500/15"
              : "text-zinc-400 hover:text-zinc-200 hover:bg-[#21262d]"
          }`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </button>

        {/* Live Sync Status Pill */}
        <div
          title={badge.desc}
          className={`flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-medium transition-all duration-300 ${badge.bg}`}
        >
          <span className={`w-2 h-2 rounded-full ${badge.dot}`} />
          <span>{badge.label}</span>
        </div>

        {/* Save Icon Button (Right of Pill) */}
        <button
          id="btn-save"
          onClick={onSave}
          disabled={!canSave || isLoading}
          className={`p-1.5 rounded-md transition-colors ${
            canSave
              ? "text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/15 cursor-pointer active:scale-95"
              : "text-zinc-600 hover:text-zinc-600 cursor-not-allowed"
          }`}
          title={
            canSave
              ? "Stage all files (`git add -A`), commit, and push to origin/main"
              : syncState === "DirtyBehind"
              ? "Blocked: Remote is ahead! Please Sync first."
              : "Save disabled: worktree is already clean"
          }
        >
          <Save className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Right: State Simulation & Repo Actions */}
      <div className="flex-1 flex items-center justify-end gap-2">
        {/* Simulation testing menu (for quick state testing) */}
        {onSimulateState && (
          <select
            onChange={(e) => onSimulateState(e.target.value)}
            value=""
            className="text-xs bg-[#21262d] border border-[#30363d] text-zinc-300 rounded px-2 py-1 outline-none cursor-pointer hover:border-zinc-500"
            title="Simulate Git Worktree States"
          >
            <option value="" disabled>
              ⚡ Test Sync States
            </option>
            <option value="clean_synced">1. Clean Synced (Up to date)</option>
            <option value="dirty_synced">2. Dirty Synced (Unsaved Edits)</option>
            <option value="clean_behind">3. Clean Behind (Remote Ahead)</option>
            <option value="dirty_behind">4. Dirty Behind (Out of Sync + Edits)</option>
            <option value="ahead_offline">5. Ahead Offline (Committed)</option>
            <option value="conflict_trigger">💥 Trigger 3-Way Conflict</option>
          </select>
        )}

        {/* Link GitHub Prompt (if remote not set) */}
        {!status?.remote_url ? (
          <button
            onClick={onOpenOnboarding}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-amber-500/20 to-orange-500/20 border border-amber-500/40 text-amber-300 hover:text-white hover:border-amber-400 transition-all cursor-pointer animate-pulse shadow-sm shadow-amber-500/10"
            title="No GitHub repository linked! Click to launch Setup Wizard."
          >
            <GithubIcon className="w-3.5 h-3.5" />
            <span>Connect GitHub</span>
          </button>
        ) : (
          <button
            id="btn-switch-repo"
            onClick={onOpenRepoSwitch}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-zinc-300 hover:text-white bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] transition-colors cursor-pointer"
            title="Switch repository or create new repository"
          >
            <GithubIcon className="w-3.5 h-3.5 text-sky-400" />
            <span>Switch Repo</span>
          </button>
        )}
      </div>
    </header>
  );
};
