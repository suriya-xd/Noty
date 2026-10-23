import {
  Save,
  RefreshCw,
  GitBranch,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Sparkles,
  WifiOff,
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
  onSave: () => void;
  onSync: () => void;
  onFetch: () => void;
  onOpenRepoSwitch: () => void;
  onOpenOnboarding: () => void;
  onSimulateState?: (stateType: string) => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  status,
  isLoading,
  onSave,
  onSync,
  onFetch,
  onOpenRepoSwitch,
  onOpenOnboarding,
  onSimulateState,
}) => {
  const syncState: SyncState = status?.state || "CleanSynced";

  // Derive Status Pill appearance based on the 5 distinct states
  const getStatusBadge = () => {
    switch (syncState) {
      case "CleanSynced":
        return {
          bg: "bg-emerald-950/60 border-emerald-500/40 text-emerald-400",
          dot: "bg-emerald-400 shadow-[0_0_8px_#34d399]",
          icon: <CheckCircle2 className="w-3.5 h-3.5" />,
          label: "Up to date",
          desc: "Local vault in sync with GitHub",
        };
      case "DirtySynced":
        return {
          bg: "bg-amber-950/60 border-amber-500/40 text-amber-400",
          dot: "bg-amber-400 shadow-[0_0_8px_#fbbf24] animate-pulse",
          icon: <Clock className="w-3.5 h-3.5" />,
          label: `Unsaved changes (${status?.dirty_count || 1})`,
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
          label: "Out of sync + Unsaved edits",
          desc: "Remote has changes & you have local edits. Click Sync to 3-way merge.",
        };
      case "AheadOffline":
        return {
          bg: "bg-purple-950/60 border-purple-500/40 text-purple-400",
          dot: "bg-purple-400 shadow-[0_0_8px_#c084fc]",
          icon: <WifiOff className="w-3.5 h-3.5" />,
          label: `Saved locally (${status?.ahead_count || 1} offline)`,
          desc: "Committed offline. Push will resume when online.",
        };
    }
  };

  const badge = getStatusBadge();

  // Button active / disabled states per SPEC.md
  // 1. CleanSynced: Save Disabled, Sync Disabled
  // 2. DirtySynced: Save Active, Sync Disabled
  // 3. CleanBehind: Save Disabled, Sync Active
  // 4. DirtyBehind: Save Blocked (Sync first), Sync Active
  // 5. AheadOffline: Save/Push Active
  const canSave = syncState === "DirtySynced" || syncState === "AheadOffline";
  const canSync = syncState === "CleanBehind" || syncState === "DirtyBehind";

  return (
    <header className="h-14 border-b border-[#30363d] bg-[#161b22]/90 backdrop-blur-md px-4 flex items-center justify-between z-20 select-none">
      {/* Left: App Title & Branch */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-sky-500 via-indigo-500 to-purple-500 flex items-center justify-center shadow-md shadow-sky-500/20">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-sm tracking-wide text-white">GitVault</span>
        </div>

        <div className="h-4 w-[1px] bg-[#30363d]" />

        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#21262d] text-xs font-mono text-zinc-300 border border-[#30363d]">
          <GitBranch className="w-3.5 h-3.5 text-zinc-400" />
          <span>{status?.branch || "main"}</span>
          {status?.ahead_count ? (
            <span className="ml-1 text-[10px] px-1 bg-purple-500/30 text-purple-300 rounded font-semibold">
              +{status.ahead_count}
            </span>
          ) : null}
          {status?.behind_count ? (
            <span className="ml-1 text-[10px] px-1 bg-sky-500/30 text-sky-300 rounded font-semibold">
              -{status.behind_count}
            </span>
          ) : null}
        </div>
      </div>

      {/* Middle: Live Sync Status Pill */}
      <div className="flex items-center gap-2">
        <div
          title={badge.desc}
          className={`flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-medium transition-all duration-300 ${badge.bg}`}
        >
          <span className={`w-2 h-2 rounded-full ${badge.dot}`} />
          <span>{badge.label}</span>
        </div>

        <button
          onClick={onFetch}
          disabled={isLoading}
          title="Fetch latest refs from remote"
          className="p-1.5 rounded-md hover:bg-[#21262d] text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Right: Manual Save & Sync Actions */}
      <div className="flex items-center gap-2">
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

        {/* Sync Button */}
        <button
          id="btn-sync"
          onClick={onSync}
          disabled={!canSync || isLoading}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            canSync
              ? "bg-sky-600 hover:bg-sky-500 text-white shadow-lg shadow-sky-600/25 cursor-pointer active:scale-95"
              : "bg-[#21262d] text-zinc-500 border border-[#30363d] cursor-not-allowed"
          }`}
          title={
            canSync
              ? "Pull changes from origin/main"
              : "Sync disabled: repository is not behind remote"
          }
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
          <span>Sync</span>
        </button>

        {/* Save Button */}
        <button
          id="btn-save"
          onClick={onSave}
          disabled={!canSave || isLoading}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
            canSave
              ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/25 cursor-pointer active:scale-95"
              : "bg-[#21262d] text-zinc-500 border border-[#30363d] cursor-not-allowed"
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
          <span>Save</span>
        </button>

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
