import { useEscapeKey } from "./dialogs";
import { useEffect, useState } from "react";
import type { FC, FormEvent } from "react";
import { AlertCircle, Check, Layers, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { GitHubService } from "../services/githubService";
import { NoeticBridge } from "../services/noeticBridge";
import type { RepoStatusPayload } from "../types/noetic";
import { useBackLayer } from "../utils/backNavigation";

interface WorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  vaultPath: string;
  /** False until the notes folder is linked to the signed-in account; opening then sets it up. */
  isConnected: boolean;
  /** Called after a workspace is opened or created, with the new status. */
  onSwitched: (workspace: string, status: RepoStatusPayload, created: boolean) => void;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What the name will be saved as: spaces become dashes. Mirrors the backend. */
const tidyName = (name: string) => name.trim().split(/\s+/).filter(Boolean).join("-");

/**
 * Lists the user's workspaces and lets them open one or add a new one. Right after sign-in it
 * also prepares the account's storage, so this is where the first workspace gets its name.
 */
export const WorkspaceModal: FC<WorkspaceModalProps> = ({ isOpen, onClose, vaultPath, isConnected, onSwitched }) => {
  // On phones, Back closes this.
  useBackLayer(isOpen, onClose);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // workspace being opened, or "+" while creating
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  // The cloud's list couldn't be loaded. An empty list then means "unknown", not "none yet".
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0); // bumped by "Try again" to load once more

  useEscapeKey(isOpen && !busy, onClose);

  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setNewName("");
      setBusy(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setLoadFailed(false);
    (async () => {
      try {
        // Show what this device already knows straight away, then check the cloud.
        if (isConnected) {
          const known = await NoeticBridge.listWorkspaces(vaultPath);
          if (cancelled) return;
          setWorkspaces(known.workspaces);
          setCurrent(known.current);
        }
        const list = isConnected
          ? await NoeticBridge.listWorkspaces(vaultPath, true)
          : await GitHubService.setUpStorage(vaultPath);
        if (cancelled) return;
        setWorkspaces(list.workspaces);
        setCurrent(list.current);
      } catch (err) {
        if (!cancelled) {
          setError(errorText(err));
          setLoadFailed(true);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, isConnected, vaultPath, attempt]);

  if (!isOpen) return null;

  const open = async (name: string) => {
    if (busy) return;
    if (name === current) {
      onClose();
      return;
    }
    setBusy(name);
    setError(null);
    try {
      const status = await NoeticBridge.switchWorkspace(vaultPath, name);
      onSwitched(name, status, false);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !tidyName(newName)) return;
    setBusy("+");
    setError(null);
    try {
      const status = await NoeticBridge.createWorkspace(vaultPath, newName);
      onSwitched(status.branch, status, true);
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  // Nothing is known: neither this device nor the cloud could say which workspaces exist. Offering
  // to name a "first" workspace here would be wrong when the account already has some, and one
  // made now would start a history separate from theirs. So only a retry is offered.
  const isUnknown = !isLoading && loadFailed && workspaces.length === 0;
  const isFirst = !isLoading && !loadFailed && workspaces.length === 0;
  const tidy = tidyName(newName);

  return (
    <div className="app-modal fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 overflow-y-auto">
      <div className="app-modal-panel bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl w-full max-w-md text-zinc-100 overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-5 py-4 border-b border-[#30363d] bg-[#161b22] flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
              <Layers className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base font-bold text-white">
                {isFirst ? "Name your first workspace" : "Workspaces"}
              </h1>
              <p className="text-xs text-zinc-400">
                {isFirst
                  ? "A workspace is a separate set of notes. You can add more later."
                  : "Each workspace is a separate set of notes."}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={!!busy}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-[#21262d] rounded-lg transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {error && (
            <div role="alert" className="p-3 bg-rose-950/40 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {isLoading && workspaces.length === 0 ? (
            <div className="py-10 flex flex-col items-center justify-center gap-2 text-zinc-400 text-xs">
              <Loader2 className="w-5 h-5 animate-spin text-sky-400" />
              <span>{isConnected ? "Loading your workspaces…" : "Getting your notes ready…"}</span>
            </div>
          ) : isUnknown ? (
            <div className="py-4 flex flex-col items-center gap-3 text-center">
              <p className="text-xs text-zinc-400">
                Your workspaces couldn't be loaded, so none are shown. Check your connection and try again.
              </p>
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Try again</span>
              </button>
            </div>
          ) : (
            <>
              {workspaces.length > 0 && (
                <ul className="space-y-2">
                  {workspaces.map((name) => {
                    const isCurrent = name === current;
                    return (
                      <li key={name}>
                        <button
                          type="button"
                          onClick={() => open(name)}
                          disabled={!!busy}
                          aria-current={isCurrent ? "true" : undefined}
                          className={`w-full min-h-11 px-3.5 py-2.5 rounded-xl border text-left flex items-center justify-between gap-3 transition-colors cursor-pointer disabled:cursor-default ${
                            isCurrent
                              ? "bg-sky-950/40 border-sky-500 text-white"
                              : "bg-[#161b22] border-[#30363d] hover:border-zinc-500 text-zinc-200"
                          }`}
                        >
                          <span className="text-sm font-medium truncate">{name}</span>
                          {busy === name ? (
                            <Loader2 className="w-4 h-4 animate-spin text-sky-400 shrink-0" />
                          ) : isCurrent ? (
                            <span className="flex items-center gap-1 text-[11px] text-sky-300 shrink-0">
                              <Check className="w-3.5 h-3.5" /> Open
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              <form onSubmit={create} className="space-y-2">
                <label htmlFor="new-workspace-name" className="block text-xs font-medium text-zinc-300">
                  {isFirst ? "Workspace name" : "New workspace"}
                </label>
                <div className="flex gap-2">
                  <input
                    id="new-workspace-name"
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder={isFirst ? "e.g. Personal" : "e.g. Work"}
                    autoFocus={isFirst}
                    autoCapitalize="words"
                    autoComplete="off"
                    maxLength={60}
                    className="flex-1 min-w-0 px-3.5 py-2.5 bg-[#161b22] border border-[#30363d] focus:border-sky-500 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!tidy || !!busy || isLoading}
                    className="px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50 cursor-pointer whitespace-nowrap"
                  >
                    {busy === "+" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                    <span>Create</span>
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500 min-h-4">
                  {tidy && tidy !== newName.trim()
                    ? `Will be saved as "${tidy}".`
                    : isFirst
                    ? "Notes already on this device move into it."
                    : "It starts empty. Unsaved changes in the open workspace are saved first."}
                </p>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
