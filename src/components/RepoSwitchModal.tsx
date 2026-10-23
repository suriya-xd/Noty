import { useState, useEffect } from "react";
import type { FC } from "react";
import {
  FolderGit2,
  Lock,
  Globe,
  Search,
  Plus,
  Check,
  AlertCircle,
  Loader2,
  Folder,
  User,
  Mail,
  X,
  Sparkles,
  Pencil,
} from "lucide-react";
import { GitHubService } from "../services/githubService";
import { GitVaultBridge } from "../services/gitVaultBridge";
import { GitHubRepo, GitHubUser } from "../types/gitVault";

interface RepoSwitchModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultVaultPath: string;
  onComplete: (data: { vaultPath: string; remoteUrl: string }) => void;
}

export const RepoSwitchModal: FC<RepoSwitchModalProps> = ({
  isOpen,
  onClose,
  defaultVaultPath,
  onComplete,
}) => {
  const [currentUser, setCurrentUser] = useState<GitHubUser | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // Repository selection state
  const [repoTab, setRepoTab] = useState<"select" | "create">("select");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [isSwitching, setIsSwitching] = useState(false);

  // Create Repository form state
  const [newRepoName, setNewRepoName] = useState("my-vault");
  const [newRepoDesc, setNewRepoDesc] = useState("Personal notes synced with GitVault");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [isCreatingRepo, setIsCreatingRepo] = useState(false);
  const [createRepoError, setCreateRepoError] = useState<string | null>(null);

  // Vault path customization (optional)
  const [targetVaultPath, setTargetVaultPath] = useState(defaultVaultPath);
  const [isEditingPath, setIsEditingPath] = useState(false);

  // Load repositories using existing authenticated session
  useEffect(() => {
    if (!isOpen) {
      setSelectedRepo(null);
      setLoadError(null);
      setSwitchError(null);
      setCreateRepoError(null);
      setIsEditingPath(false);
      return;
    }

    setTargetVaultPath(defaultVaultPath);
    const stored = GitHubService.getStoredGitHubAuth();
    if (!stored) {
      setLoadError("No GitHub account is currently logged in. Please connect via Settings first.");
      return;
    }

    setCurrentUser(stored.user);
    setToken(stored.token);
    loadRepos(stored.token);
  }, [isOpen, defaultVaultPath]);

  const loadRepos = async (authToken: string) => {
    setIsLoadingRepos(true);
    setLoadError(null);
    try {
      const list = await GitHubService.listUserRepositories(authToken);
      setRepos(list);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(`Failed to load repositories: ${msg}`);
    } finally {
      setIsLoadingRepos(false);
    }
  };

  if (!isOpen) return null;

  // Derive author details automatically from GitHub authentication
  const authorName = currentUser?.name || currentUser?.login || "GitVault User";
  const authorEmail =
    currentUser?.email ||
    (currentUser?.login ? `${currentUser.login}@users.noreply.github.com` : "vault@gitvault.local");

  // Handle switching to a selected repository directly
  const handleSwitchToRepo = async (repo: GitHubRepo) => {
    if (!token || !currentUser) {
      setSwitchError("No active GitHub authentication session found.");
      return;
    }

    setIsSwitching(true);
    setSwitchError(null);

    const targetPath = targetVaultPath.trim() || defaultVaultPath;
    const targetBranch = repo.default_branch || "main";

    try {
      await GitVaultBridge.connectVault({
        vault_path: targetPath,
        remote_url: repo.clone_url,
        branch: targetBranch,
        github_token: token,
        user_name: authorName,
        user_email: authorEmail,
      });

      onComplete({
        vaultPath: targetPath,
        remoteUrl: repo.clone_url,
      });
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSwitchError(msg || "Failed to switch repository.");
    } finally {
      setIsSwitching(false);
    }
  };

  // Handle creating a new repository on GitHub and switching directly to it
  const handleCreateAndSwitch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !currentUser) {
      setCreateRepoError("No active GitHub authentication session found.");
      return;
    }

    setIsCreatingRepo(true);
    setCreateRepoError(null);

    try {
      const created = await GitHubService.createRepository(token, {
        name: newRepoName.trim(),
        description: newRepoDesc.trim(),
        isPrivate: newRepoPrivate,
      });

      setRepos((prev) => [created, ...prev]);
      setSelectedRepo(created);

      const targetPath = targetVaultPath.trim() || defaultVaultPath;

      await GitVaultBridge.connectVault({
        vault_path: targetPath,
        remote_url: created.clone_url,
        branch: "main",
        github_token: token,
        user_name: authorName,
        user_email: authorEmail,
      });

      onComplete({
        vaultPath: targetPath,
        remoteUrl: created.clone_url,
      });
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setCreateRepoError(msg || "Failed to create and switch repository.");
    } finally {
      setIsCreatingRepo(false);
    }
  };

  const filteredRepos = repos.filter((r) =>
    r.full_name.toLowerCase().includes(repoSearch.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 overflow-y-auto">
      <div className="bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl w-full max-w-2xl text-zinc-100 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#30363d] bg-[#161b22]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
                <FolderGit2 className="w-4 h-4" />
              </div>
              <div>
                <h1 className="text-base font-bold text-white">
                  Switch Vault Repository
                </h1>
                <p className="text-xs text-zinc-400">
                  Select an existing repository or create a new one for your notes.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {currentUser && (
                <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-[#21262d] border border-[#30363d] text-xs">
                  <img
                    src={currentUser.avatar_url}
                    alt={currentUser.login}
                    className="w-4 h-4 rounded-full"
                  />
                  <span className="font-medium text-zinc-300">@{currentUser.login}</span>
                </div>
              )}
              <button
                onClick={onClose}
                className="p-1.5 text-zinc-400 hover:text-white hover:bg-[#21262d] rounded-lg transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {loadError && (
            <div className="p-3 bg-rose-950/40 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{loadError}</span>
            </div>
          )}

          {switchError && (
            <div className="p-3 bg-rose-950/40 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{switchError}</span>
            </div>
          )}

          {/* Tab Selector */}
          <div className="flex border-b border-[#30363d] gap-4">
            <button
              type="button"
              onClick={() => setRepoTab("select")}
              className={`pb-2.5 text-xs font-medium flex items-center gap-1.5 border-b-2 transition-all cursor-pointer ${
                repoTab === "select"
                  ? "border-sky-500 text-sky-400 font-semibold"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <FolderGit2 className="w-3.5 h-3.5" />
              <span>Select Existing Repository ({repos.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setRepoTab("create")}
              className={`pb-2.5 text-xs font-medium flex items-center gap-1.5 border-b-2 transition-all cursor-pointer ${
                repoTab === "create"
                  ? "border-sky-500 text-sky-400 font-semibold"
                  : "border-transparent text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create New Repository</span>
            </button>
          </div>

          {/* Tab 1: Select Repository */}
          {repoTab === "select" && (
            <div className="space-y-3">
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  value={repoSearch}
                  onChange={(e) => setRepoSearch(e.target.value)}
                  placeholder="Search your GitHub repositories..."
                  className="w-full pl-9 pr-4 py-2 bg-[#161b22] border border-[#30363d] focus:border-sky-500 rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none"
                />
              </div>

              {isLoadingRepos ? (
                <div className="py-12 flex flex-col items-center justify-center gap-2 text-zinc-500 text-xs">
                  <Loader2 className="w-5 h-5 animate-spin text-sky-400" />
                  <span>Fetching repositories from GitHub...</span>
                </div>
              ) : filteredRepos.length === 0 ? (
                <div className="py-12 text-center text-zinc-500 text-xs">
                  {repoSearch ? "No repositories match your search." : "No repositories found."}
                </div>
              ) : (
                <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                  {filteredRepos.map((repo) => {
                    const isSelected = selectedRepo?.id === repo.id;
                    return (
                      <div
                        key={repo.id}
                        onClick={() => setSelectedRepo(repo)}
                        onDoubleClick={() => handleSwitchToRepo(repo)}
                        className={`p-3 rounded-xl border text-left cursor-pointer transition-all flex items-center justify-between ${
                          isSelected
                            ? "bg-sky-950/40 border-sky-500 text-white shadow-md shadow-sky-950/50"
                            : "bg-[#161b22] border-[#30363d] hover:border-zinc-500 text-zinc-300"
                        }`}
                      >
                        <div className="flex-1 min-w-0 pr-3">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-xs truncate">
                              {repo.full_name}
                            </span>
                            {repo.private ? (
                              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[#21262d] text-zinc-400 border border-[#30363d]">
                                <Lock className="w-2.5 h-2.5" /> Private
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-[#21262d] text-zinc-400 border border-[#30363d]">
                                <Globe className="w-2.5 h-2.5" /> Public
                              </span>
                            )}
                          </div>
                          {repo.description && (
                            <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                              {repo.description}
                            </p>
                          )}
                        </div>

                        <div
                          className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                            isSelected
                              ? "bg-sky-500 border-sky-400 text-white"
                              : "border-zinc-600 bg-[#0d1117]"
                          }`}
                        >
                          {isSelected && <Check className="w-3 h-3 stroke-[3]" />}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Create Repository */}
          {repoTab === "create" && (
            <form id="createRepoForm" onSubmit={handleCreateAndSwitch} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Repository Name <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={newRepoName}
                  onChange={(e) => setNewRepoName(e.target.value)}
                  placeholder="e.g. personal-notes"
                  className="w-full px-3.5 py-2.5 bg-[#161b22] border border-[#30363d] focus:border-sky-500 rounded-xl text-xs font-mono text-white placeholder-zinc-500 focus:outline-none"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1">
                  Description (Optional)
                </label>
                <input
                  type="text"
                  value={newRepoDesc}
                  onChange={(e) => setNewRepoDesc(e.target.value)}
                  placeholder="Markdown notes synced with GitVault"
                  className="w-full px-3.5 py-2 bg-[#161b22] border border-[#30363d] focus:border-sky-500 rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-3 p-3 bg-[#161b22] border border-[#30363d] rounded-xl">
                <input
                  type="checkbox"
                  id="newRepoPrivateSwitch"
                  checked={newRepoPrivate}
                  onChange={(e) => setNewRepoPrivate(e.target.checked)}
                  className="rounded border-[#30363d] text-sky-500 focus:ring-0 accent-sky-500 cursor-pointer w-4 h-4"
                />
                <label htmlFor="newRepoPrivateSwitch" className="text-xs text-zinc-300 cursor-pointer">
                  <span className="font-semibold block text-white">Private Repository</span>
                  <span className="text-zinc-500 text-[11px]">Only you can view and commit notes to this repository.</span>
                </label>
              </div>

              {createRepoError && (
                <div className="p-3 bg-rose-950/40 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <span>{createRepoError}</span>
                </div>
              )}
            </form>
          )}

          {/* Automatic Commit Author & Vault Path Information (Directly from GitHub Auth) */}
          <div className="p-3 bg-[#161b22]/70 border border-[#30363d] rounded-xl space-y-2.5">
            {/* Commit Author derived from GitHub Auth */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs text-zinc-300">
                <User className="w-3.5 h-3.5 text-zinc-400" />
                <span>Commit Author:</span>
                <span className="font-semibold text-white">{authorName}</span>
                <span className="text-zinc-500 text-[11px] font-mono flex items-center gap-1">
                  <Mail className="w-3 h-3 text-zinc-500" />
                  {authorEmail}
                </span>
              </div>
              <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-2 py-0.5 rounded">
                From GitHub Auth
              </span>
            </div>

            {/* Local Vault Path */}
            <div className="flex items-center justify-between text-xs text-zinc-400 pt-2 border-t border-[#30363d]/60">
              <div className="flex items-center gap-2 flex-1 min-w-0 mr-2">
                <Folder className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span>Local Vault:</span>
                {isEditingPath ? (
                  <input
                    type="text"
                    value={targetVaultPath}
                    onChange={(e) => setTargetVaultPath(e.target.value)}
                    className="flex-1 px-2 py-0.5 bg-[#0d1117] border border-sky-500 rounded text-xs font-mono text-white outline-none"
                  />
                ) : (
                  <span className="font-mono text-zinc-300 truncate">{targetVaultPath}</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setIsEditingPath(!isEditingPath)}
                className="text-[11px] text-zinc-400 hover:text-white flex items-center gap-1 cursor-pointer shrink-0"
              >
                <Pencil className="w-3 h-3" />
                <span>{isEditingPath ? "Done" : "Edit Path"}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#30363d] bg-[#161b22] flex items-center justify-between">
          <div className="text-xs text-zinc-400">
            {repoTab === "select" && selectedRepo ? (
              <span className="text-sky-300 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                Ready to switch to <strong>{selectedRepo.name}</strong>
              </span>
            ) : repoTab === "select" ? (
              <span>Select a repository to switch</span>
            ) : (
              <span>New repository will be created and connected</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSwitching || isCreatingRepo}
              className="px-3.5 py-2 text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
            >
              Cancel
            </button>

            {repoTab === "select" ? (
              <button
                type="button"
                id="btn-confirm-switch-repo"
                onClick={() => selectedRepo && handleSwitchToRepo(selectedRepo)}
                disabled={!selectedRepo || isSwitching}
                className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-md shadow-sky-600/30 flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                {isSwitching ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Switching Vault...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    <span>Switch to this Repository</span>
                  </>
                )}
              </button>
            ) : (
              <button
                type="submit"
                form="createRepoForm"
                id="btn-confirm-create-repo"
                disabled={isCreatingRepo || !newRepoName.trim()}
                className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-md shadow-sky-600/30 flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
              >
                {isCreatingRepo ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Creating & Connecting...</span>
                  </>
                ) : (
                  <>
                    <Plus className="w-3.5 h-3.5" />
                    <span>Create & Switch</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
