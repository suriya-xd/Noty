import { useState, useEffect, useRef } from "react";
import type { FC } from "react";
import {
  Key,
  FolderGit2,
  Lock,
  Globe,
  Search,
  Plus,
  Check,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  ExternalLink,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Folder,
  User,
  Mail,
  GitBranch,
  Copy,
  Smartphone,
  Laptop,
  RefreshCw,
} from "lucide-react";
import { GitHubService } from "../services/githubService";
import { GitVaultBridge } from "../services/gitVaultBridge";
import { DeviceCodeResponse, GitHubRepo, GitHubUser } from "../types/gitVault";

const GithubIcon: FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
    />
  </svg>
);

interface OnboardingModalProps {
  isOpen: boolean;
  defaultVaultPath: string;
  onComplete: (data: { vaultPath: string; remoteUrl: string }) => void;
  onCancel?: () => void;
}

export const OnboardingModal: FC<OnboardingModalProps> = ({
  isOpen,
  defaultVaultPath,
  onComplete,
  onCancel,
}) => {
  // Steps: 1 = Auth, 2 = Select / Create Repo, 3 = Local Vault Setup
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);

  // Step 1: Authentication State
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [isValidatingToken, setIsValidatingToken] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<GitHubUser | null>(null);

  // Step 1: Device Flow State
  const [showManualToken, setShowManualToken] = useState(false);
  const [deviceFlowData, setDeviceFlowData] = useState<DeviceCodeResponse | null>(null);
  const [isStartingDeviceFlow, setIsStartingDeviceFlow] = useState(false);
  const [isPollingDeviceToken, setIsPollingDeviceToken] = useState(false);
  const [deviceFlowError, setDeviceFlowError] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Step 2: Repository Selection State
  const [repoTab, setRepoTab] = useState<"select" | "create">("select");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [isLoadingRepos, setIsLoadingRepos] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null);

  // Step 2: Create Repository Form
  const [newRepoName, setNewRepoName] = useState("gitvault-notes");
  const [newRepoDesc, setNewRepoDesc] = useState("Personal notes synced with GitVault");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [isCreatingRepo, setIsCreatingRepo] = useState(false);
  const [createRepoError, setCreateRepoError] = useState<string | null>(null);

  // Step 3: Vault Configuration State
  const [targetVaultPath, setTargetVaultPath] = useState(defaultVaultPath);
  const [targetBranch, setTargetBranch] = useState("main");
  const [authorName, setAuthorName] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);

  // Restore stored session if exists
  useEffect(() => {
    if (!isOpen) return;

    setTargetVaultPath(defaultVaultPath);
    const stored = GitHubService.getStoredGitHubAuth();
    if (stored) {
      setToken(stored.token);
      setCurrentUser(stored.user);
      setAuthorName(stored.user.name || stored.user.login);
      setAuthorEmail(stored.user.email || "");
      setCurrentStep(2);
      loadUserRepos(stored.token);
    }
  }, [isOpen, defaultVaultPath]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  if (!isOpen) return null;

  // 1. Device Flow Start & Polling
  const handleStartDeviceFlow = async () => {
    setIsStartingDeviceFlow(true);
    setDeviceFlowError(null);
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
    }

    try {
      const data = await GitHubService.startDeviceFlow();
      setDeviceFlowData(data);

      try {
        await navigator.clipboard.writeText(data.user_code);
        setCodeCopied(true);
        setTimeout(() => setCodeCopied(false), 3000);
      } catch {}

      startDeviceTokenPolling(data.device_code, data.interval || 5);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setDeviceFlowError(msg || "Failed to initiate GitHub browser login.");
    } finally {
      setIsStartingDeviceFlow(false);
    }
  };

  const startDeviceTokenPolling = (deviceCode: string, intervalSeconds: number) => {
    setIsPollingDeviceToken(true);

    const poll = async (currInterval: number) => {
      try {
        const res = await GitHubService.pollDeviceToken(deviceCode);
        if (res.status === "approved" && res.access_token) {
          setIsPollingDeviceToken(false);
          const user = await GitHubService.validateToken(res.access_token);
          setToken(res.access_token);
          setCurrentUser(user);
          GitHubService.saveGitHubAuth(res.access_token, user);
          setAuthorName(user.name || user.login);
          setAuthorEmail(user.email || "");
          setCurrentStep(2);
          await loadUserRepos(res.access_token);
          return;
        }

        if (res.status === "pending" || res.status === "slow_down") {
          const nextInterval = res.interval || currInterval;
          pollTimerRef.current = setTimeout(() => poll(nextInterval), nextInterval * 1000);
          return;
        }

        setIsPollingDeviceToken(false);
        setDeviceFlowError(res.error_description || "Authentication was not completed.");
      } catch (err: unknown) {
        setIsPollingDeviceToken(false);
        const msg = err instanceof Error ? err.message : String(err);
        setDeviceFlowError(msg);
      }
    };

    pollTimerRef.current = setTimeout(() => poll(intervalSeconds), intervalSeconds * 1000);
  };

  const handleOpenGitHubBrowser = async () => {
    if (!deviceFlowData) return;
    try {
      await navigator.clipboard.writeText(deviceFlowData.user_code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 3000);
    } catch {}

    const url = deviceFlowData.verification_uri || "https://github.com/login/device";
    window.open(url, "_blank");
  };

  // 2. Authenticate with GitHub PAT (Manual Fallback)
  const handleAuthenticate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setAuthError("Please enter your GitHub Personal Access Token.");
      return;
    }

    setIsValidatingToken(true);
    setAuthError(null);

    try {
      const user = await GitHubService.validateToken(token.trim());
      setCurrentUser(user);
      GitHubService.saveGitHubAuth(token.trim(), user);

      setAuthorName(user.name || user.login);
      setAuthorEmail(user.email || "");

      setCurrentStep(2);
      await loadUserRepos(token.trim());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setAuthError(msg);
    } finally {
      setIsValidatingToken(false);
    }
  };

  // Load repositories
  const loadUserRepos = async (authToken: string) => {
    setIsLoadingRepos(true);
    try {
      const list = await GitHubService.listUserRepositories(authToken);
      setRepos(list);
    } catch (err) {
      console.error("Failed to list repos:", err);
    } finally {
      setIsLoadingRepos(false);
    }
  };

  // 2. Create new repository
  const handleCreateRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRepoName.trim()) {
      setCreateRepoError("Repository name cannot be empty.");
      return;
    }

    setIsCreatingRepo(true);
    setCreateRepoError(null);

    try {
      const created = await GitHubService.createRepository(token.trim(), {
        name: newRepoName.trim(),
        description: newRepoDesc.trim(),
        isPrivate: newRepoPrivate,
      });

      // Add to repos list and select it
      setRepos((prev) => [created, ...prev]);
      setSelectedRepo(created);
      setTargetBranch(created.default_branch || "main");

      // Advance to step 3
      setCurrentStep(3);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setCreateRepoError(msg);
    } finally {
      setIsCreatingRepo(false);
    }
  };

  // 3. Complete Setup & Connect Vault
  const handleFinalize = async () => {
    if (!selectedRepo) return;

    setIsFinalizing(true);
    setFinalizeError(null);

    try {
      await GitVaultBridge.connectVault({
        vault_path: targetVaultPath.trim() || defaultVaultPath,
        remote_url: selectedRepo.clone_url,
        branch: targetBranch.trim() || "main",
        github_token: token.trim(),
        user_name: authorName.trim() || currentUser?.login || "GitVault User",
        user_email: authorEmail.trim() || "vault@gitvault.local",
      });

      onComplete({
        vaultPath: targetVaultPath.trim() || defaultVaultPath,
        remoteUrl: selectedRepo.clone_url,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setFinalizeError(msg || "Failed to initialize and connect vault repository.");
    } finally {
      setIsFinalizing(false);
    }
  };

  const filteredRepos = repos.filter((r) =>
    r.full_name.toLowerCase().includes(repoSearch.toLowerCase())
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 overflow-y-auto">
      <div className="bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl w-full max-w-2xl text-zinc-100 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        {/* Header with App Branding & Stepper */}
        <div className="px-6 py-5 border-b border-[#30363d] bg-[#161b22]/90">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-sky-500 via-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-sky-500/25">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-base font-bold text-white tracking-tight flex items-center gap-2">
                  <span>GitVault Onboarding</span>
                  <span className="text-[10px] uppercase font-semibold px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-500/30">
                    Step {currentStep} of 3
                  </span>
                </h1>
                <p className="text-xs text-zinc-400">
                  Connect your GitHub account to sync notes seamlessly across devices.
                </p>
              </div>
            </div>

            {/* User Badge if authenticated */}
            {currentUser && (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#21262d] border border-[#30363d] text-xs">
                <img
                  src={currentUser.avatar_url}
                  alt={currentUser.login}
                  className="w-5 h-5 rounded-full"
                />
                <span className="font-medium text-zinc-200">@{currentUser.login}</span>
              </div>
            )}
          </div>

          {/* Stepper Progress Bar */}
          <div className="grid grid-cols-3 gap-2 mt-4">
            <div
              className={`h-1.5 rounded-full transition-all duration-300 ${
                currentStep >= 1 ? "bg-sky-500" : "bg-[#21262d]"
              }`}
            />
            <div
              className={`h-1.5 rounded-full transition-all duration-300 ${
                currentStep >= 2 ? "bg-sky-500" : "bg-[#21262d]"
              }`}
            />
            <div
              className={`h-1.5 rounded-full transition-all duration-300 ${
                currentStep >= 3 ? "bg-sky-500" : "bg-[#21262d]"
              }`}
            />
          </div>
        </div>

        {/* Modal Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* STEP 1: AUTHENTICATION */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <div className="text-center max-w-md mx-auto pt-2">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-sky-500/20 via-indigo-500/20 to-purple-500/20 border border-sky-500/30 flex items-center justify-center text-white mx-auto mb-3 shadow-lg shadow-sky-500/10">
                  <GithubIcon className="w-7 h-7" />
                </div>
                <h2 className="text-lg font-bold text-white tracking-tight">
                  Sign in with GitHub
                </h2>
                <p className="text-xs text-zinc-400 mt-1">
                  Authenticate securely in your browser. Compatible with both Windows desktop and Android mobile without passwords.
                </p>
                <div className="flex items-center justify-center gap-2 mt-2.5">
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-[#21262d] text-zinc-300 border border-[#30363d]">
                    <Laptop className="w-3 h-3 text-sky-400" /> Windows
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-[#21262d] text-zinc-300 border border-[#30363d]">
                    <Smartphone className="w-3 h-3 text-emerald-400" /> Android
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-[#21262d] text-zinc-300 border border-[#30363d]">
                    <Sparkles className="w-3 h-3 text-purple-400" /> Device Flow
                  </span>
                </div>
              </div>

              {/* Device Flow Interactive Card */}
              {!deviceFlowData ? (
                <div className="max-w-md mx-auto p-6 bg-[#161b22]/90 border border-[#30363d] rounded-2xl text-center space-y-4 shadow-xl">
                  <p className="text-xs text-zinc-300 leading-relaxed">
                    Click below to launch GitHub authorization in your browser. You will receive an 8-character confirmation code.
                  </p>

                  <button
                    type="button"
                    onClick={handleStartDeviceFlow}
                    disabled={isStartingDeviceFlow}
                    className="w-full py-3 rounded-xl bg-gradient-to-r from-sky-500 via-indigo-500 to-purple-600 hover:from-sky-400 hover:to-purple-500 text-white font-semibold text-sm shadow-lg shadow-sky-500/25 flex items-center justify-center gap-2.5 transition-all cursor-pointer disabled:opacity-50"
                  >
                    {isStartingDeviceFlow ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Connecting to GitHub...</span>
                      </>
                    ) : (
                      <>
                        <GithubIcon className="w-4 h-4" />
                        <span>Sign in with GitHub</span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>

                  {deviceFlowError && (
                    <div className="p-3 bg-rose-950/40 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-start gap-2 text-left">
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      <span>{deviceFlowError}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="max-w-md mx-auto p-6 bg-[#161b22] border border-sky-500/30 rounded-2xl space-y-5 shadow-2xl relative overflow-hidden">
                  <div className="text-center space-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-sky-400">
                      Step 1 of 2: Your Authorization Code
                    </span>
                    <p className="text-xs text-zinc-400">
                      Copy this code, open GitHub in your browser, and authorize GitVault.
                    </p>
                  </div>

                  {/* Big User Code Display */}
                  <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] text-zinc-500 uppercase font-mono tracking-wider">
                        GitHub User Code
                      </div>
                      <div className="text-2xl font-black font-mono tracking-widest text-white mt-0.5">
                        {deviceFlowData.user_code}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(deviceFlowData.user_code);
                        setCodeCopied(true);
                        setTimeout(() => setCodeCopied(false), 3000);
                      }}
                      className="px-3 py-2 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-zinc-200 border border-[#30363d] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                      title="Copy code to clipboard"
                    >
                      {codeCopied ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-400" />
                          <span className="text-emerald-400">Copied!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5 text-zinc-400" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>
                  </div>

                  {/* Open Browser Button */}
                  <button
                    type="button"
                    onClick={handleOpenGitHubBrowser}
                    className="w-full py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-sm shadow-lg shadow-sky-600/30 flex items-center justify-center gap-2 transition-all cursor-pointer"
                  >
                    <span>Open GitHub Verification Page</span>
                    <ExternalLink className="w-4 h-4" />
                  </button>

                  {/* Pulsing Status Waiting Indicator */}
                  <div className="p-3 bg-sky-950/20 border border-sky-500/20 rounded-xl flex items-center gap-3">
                    <div className="relative flex items-center justify-center">
                      <span className={`w-3 h-3 rounded-full bg-sky-400 absolute ${isPollingDeviceToken ? "animate-ping" : ""}`} />
                      <span className="w-2.5 h-2.5 rounded-full bg-sky-400 relative" />
                    </div>
                    <div className="flex-1 text-xs text-sky-200">
                      <span className="font-medium">
                        {isPollingDeviceToken ? "Waiting for your approval in browser..." : "Authorization paused"}
                      </span>
                      <div className="text-[11px] text-zinc-400 mt-0.5">
                        GitVault will automatically detect when you authorize.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={handleStartDeviceFlow}
                      disabled={isStartingDeviceFlow}
                      className="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-[#21262d]"
                      title="Restart device code"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isStartingDeviceFlow ? "animate-spin" : ""}`} />
                    </button>
                  </div>

                  {deviceFlowError && (
                    <div className="p-3 bg-rose-950/40 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-start gap-2 text-left">
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      <span>{deviceFlowError}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Manual PAT Fallback Section */}
              <div className="max-w-md mx-auto pt-2 text-center">
                <button
                  type="button"
                  onClick={() => setShowManualToken(!showManualToken)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors inline-flex items-center gap-1 cursor-pointer"
                >
                  <Key className="w-3 h-3" />
                  <span>{showManualToken ? "Hide manual token option" : "Or enter a Personal Access Token (PAT) manually"}</span>
                </button>

                {showManualToken && (
                  <form onSubmit={handleAuthenticate} className="mt-4 p-4 bg-[#161b22] border border-[#30363d] rounded-xl text-left space-y-3 animate-in fade-in duration-200">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                        <Key className="w-3.5 h-3.5 text-amber-400" />
                        Personal Access Token
                      </label>
                      <a
                        href="https://github.com/settings/tokens/new?scopes=repo&description=GitVault%20Notes"
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-sky-400 hover:text-sky-300 flex items-center gap-1 underline"
                      >
                        <span>Generate PAT</span>
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                    <div className="relative">
                      <input
                        type={showToken ? "text" : "password"}
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                        className="w-full pl-3 pr-10 py-2 bg-[#0d1117] border border-[#30363d] focus:border-sky-500 rounded-lg text-xs font-mono text-white placeholder-zinc-600 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowToken(!showToken)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200"
                      >
                        {showToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>

                    {authError && (
                      <div className="p-2.5 bg-rose-950/40 border border-rose-500/30 rounded-lg text-xs text-rose-300 flex items-start gap-2">
                        <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                        <span>{authError}</span>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={isValidatingToken || !token.trim()}
                      className="w-full py-2 rounded-lg bg-[#21262d] hover:bg-[#30363d] border border-[#30363d] text-zinc-200 hover:text-white font-medium text-xs flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                    >
                      {isValidatingToken ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>Verify Token</span>}
                    </button>
                  </form>
                )}
              </div>
            </div>
          )}

          {/* STEP 2: SELECT OR CREATE REPOSITORY */}
          {currentStep === 2 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-white">
                  Choose a Vault Repository
                </h2>
                <p className="text-xs text-zinc-400">
                  Select an existing repository to use as your vault or create a brand new one on GitHub.
                </p>
              </div>

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

              {/* TAB A: SELECT EXISTING REPO */}
              {repoTab === "select" && (
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                    <input
                      type="text"
                      value={repoSearch}
                      onChange={(e) => setRepoSearch(e.target.value)}
                      placeholder="Search repositories by name..."
                      className="w-full pl-9 pr-4 py-2 bg-[#161b22] border border-[#30363d] rounded-xl text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500"
                    />
                  </div>

                  {isLoadingRepos ? (
                    <div className="p-10 flex flex-col items-center justify-center gap-2 text-zinc-400">
                      <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
                      <span className="text-xs">Loading repositories from GitHub...</span>
                    </div>
                  ) : filteredRepos.length === 0 ? (
                    <div className="p-8 text-center text-xs text-zinc-500 bg-[#161b22] rounded-xl border border-[#30363d]">
                      No repositories found matching "{repoSearch}". You can switch to the "Create New Repository" tab.
                    </div>
                  ) : (
                    <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                      {filteredRepos.map((r) => {
                        const isSelected = selectedRepo?.id === r.id;
                        return (
                          <div
                            key={r.id}
                            onClick={() => {
                              setSelectedRepo(r);
                              setTargetBranch(r.default_branch || "main");
                            }}
                            className={`p-3 rounded-xl border cursor-pointer transition-all flex items-center justify-between ${
                              isSelected
                                ? "bg-sky-950/40 border-sky-500 text-white shadow-md shadow-sky-500/10"
                                : "bg-[#161b22] border-[#30363d] hover:border-zinc-500 text-zinc-300"
                            }`}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <div
                                className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                                  isSelected
                                    ? "bg-sky-500 text-white"
                                    : "bg-[#21262d] text-zinc-400"
                                }`}
                              >
                                <FolderGit2 className="w-4 h-4" />
                              </div>
                              <div className="min-w-0">
                                <div className="text-xs font-medium font-mono truncate text-white">
                                  {r.full_name}
                                </div>
                                <div className="text-[11px] text-zinc-500 truncate">
                                  {r.description || "No description provided"}
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#21262d] border border-[#30363d] text-zinc-400 flex items-center gap-1 font-sans">
                                {r.private ? (
                                  <>
                                    <Lock className="w-2.5 h-2.5 text-amber-400" />
                                    <span>Private</span>
                                  </>
                                ) : (
                                  <>
                                    <Globe className="w-2.5 h-2.5 text-zinc-400" />
                                    <span>Public</span>
                                  </>
                                )}
                              </span>
                              {isSelected && (
                                <CheckCircle2 className="w-4 h-4 text-sky-400 shrink-0" />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {selectedRepo && (
                    <div className="pt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => setCurrentStep(3)}
                        className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium flex items-center gap-1.5 shadow-md shadow-sky-600/30 cursor-pointer"
                      >
                        <span>Next: Configure Vault</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* TAB B: CREATE NEW REPO */}
              {repoTab === "create" && (
                <form onSubmit={handleCreateRepo} className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1">
                      Repository Name <span className="text-rose-400">*</span>
                    </label>
                    <input
                      type="text"
                      value={newRepoName}
                      onChange={(e) => setNewRepoName(e.target.value)}
                      placeholder="gitvault-notes"
                      className="w-full px-3.5 py-2 bg-[#161b22] border border-[#30363d] rounded-xl text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-sky-500 font-mono"
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
                      placeholder="My personal notes in GitVault"
                      className="w-full px-3.5 py-2 bg-[#161b22] border border-[#30363d] rounded-xl text-xs text-white placeholder-zinc-600 focus:outline-none focus:border-sky-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                      Visibility
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <div
                        onClick={() => setNewRepoPrivate(true)}
                        className={`p-3 rounded-xl border cursor-pointer transition-all flex items-center gap-2.5 ${
                          newRepoPrivate
                            ? "bg-sky-950/40 border-sky-500 text-white"
                            : "bg-[#161b22] border-[#30363d] text-zinc-400"
                        }`}
                      >
                        <Lock className="w-4 h-4 text-amber-400" />
                        <div>
                          <div className="text-xs font-medium">Private</div>
                          <div className="text-[10px] text-zinc-500">Only you can see this vault</div>
                        </div>
                      </div>

                      <div
                        onClick={() => setNewRepoPrivate(false)}
                        className={`p-3 rounded-xl border cursor-pointer transition-all flex items-center gap-2.5 ${
                          !newRepoPrivate
                            ? "bg-sky-950/40 border-sky-500 text-white"
                            : "bg-[#161b22] border-[#30363d] text-zinc-400"
                        }`}
                      >
                        <Globe className="w-4 h-4 text-zinc-400" />
                        <div>
                          <div className="text-xs font-medium">Public</div>
                          <div className="text-[10px] text-zinc-500">Anyone on GitHub can see it</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {createRepoError && (
                    <div className="p-3 bg-rose-950/40 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-start gap-2">
                      <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      <span>{createRepoError}</span>
                    </div>
                  )}

                  <div className="pt-2 flex justify-end">
                    <button
                      type="submit"
                      disabled={isCreatingRepo || !newRepoName.trim()}
                      className="px-4 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-medium flex items-center gap-1.5 shadow-md shadow-sky-600/30 cursor-pointer disabled:opacity-50"
                    >
                      {isCreatingRepo ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Creating on GitHub...</span>
                        </>
                      ) : (
                        <>
                          <span>Create & Continue</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </>
                      )}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* STEP 3: VAULT CONFIGURATION & LAUNCH */}
          {currentStep === 3 && selectedRepo && (
            <div className="space-y-5">
              <div>
                <h2 className="text-base font-semibold text-white">
                  Confirm & Initialize Vault
                </h2>
                <p className="text-xs text-zinc-400">
                  Review the repository connection and choose your local notes folder.
                </p>
              </div>

              {/* Selected Repo Card */}
              <div className="p-4 bg-gradient-to-r from-sky-950/40 to-indigo-950/40 border border-sky-500/30 rounded-xl flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-lg bg-sky-500/20 text-sky-400 flex items-center justify-center">
                    <GithubIcon className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-xs text-zinc-400">Selected GitHub Repository</div>
                    <div className="text-sm font-semibold text-white font-mono">
                      {selectedRepo.full_name}
                    </div>
                  </div>
                </div>

                <span className="text-xs px-2.5 py-1 rounded-full bg-[#21262d] border border-[#30363d] text-zinc-300 flex items-center gap-1">
                  {selectedRepo.private ? (
                    <>
                      <Lock className="w-3 h-3 text-amber-400" />
                      <span>Private</span>
                    </>
                  ) : (
                    <>
                      <Globe className="w-3 h-3 text-zinc-400" />
                      <span>Public</span>
                    </>
                  )}
                </span>
              </div>

              <div className="space-y-4">
                {/* Local Folder Location */}
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1 flex items-center gap-1.5">
                    <Folder className="w-3.5 h-3.5 text-zinc-400" />
                    Local Vault Directory
                  </label>
                  <input
                    type="text"
                    value={targetVaultPath}
                    onChange={(e) => setTargetVaultPath(e.target.value)}
                    className="w-full px-3.5 py-2 bg-[#161b22] border border-[#30363d] rounded-xl text-xs text-white font-mono focus:outline-none focus:border-sky-500"
                    required
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Your markdown notes will be stored in this directory on your computer.
                  </p>
                </div>

                {/* Branch & Author Signature */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1 flex items-center gap-1.5">
                      <GitBranch className="w-3.5 h-3.5 text-purple-400" />
                      Branch
                    </label>
                    <input
                      type="text"
                      value={targetBranch}
                      onChange={(e) => setTargetBranch(e.target.value)}
                      className="w-full px-3 py-1.5 bg-[#161b22] border border-[#30363d] rounded-xl text-xs text-white font-mono focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1 flex items-center gap-1.5">
                      <User className="w-3.5 h-3.5 text-zinc-400" />
                      Commit Name
                    </label>
                    <input
                      type="text"
                      value={authorName}
                      onChange={(e) => setAuthorName(e.target.value)}
                      placeholder="Your Name"
                      className="w-full px-3 py-1.5 bg-[#161b22] border border-[#30363d] rounded-xl text-xs text-white focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-zinc-300 mb-1 flex items-center gap-1.5">
                      <Mail className="w-3.5 h-3.5 text-zinc-400" />
                      Commit Email
                    </label>
                    <input
                      type="email"
                      value={authorEmail}
                      onChange={(e) => setAuthorEmail(e.target.value)}
                      placeholder="email@example.com"
                      className="w-full px-3 py-1.5 bg-[#161b22] border border-[#30363d] rounded-xl text-xs text-white focus:outline-none"
                    />
                  </div>
                </div>

                {finalizeError && (
                  <div className="p-3 bg-rose-950/40 border border-rose-500/30 rounded-xl text-xs text-rose-300 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                    <span>{finalizeError}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer Controls */}
        <div className="px-6 py-4 border-t border-[#30363d] bg-[#161b22] flex items-center justify-between">
          <div>
            {currentStep > 1 && (
              <button
                type="button"
                onClick={() => setCurrentStep((prev) => (prev - 1) as 1 | 2)}
                disabled={isFinalizing}
                className="px-3.5 py-1.5 rounded-lg border border-[#30363d] bg-[#21262d] text-zinc-300 hover:text-white hover:bg-[#30363d] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="px-3.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Skip for now
              </button>
            )}

            {currentStep === 3 && (
              <button
                type="button"
                onClick={handleFinalize}
                disabled={isFinalizing}
                className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-sky-500 via-indigo-500 to-purple-600 hover:from-sky-400 hover:to-purple-500 text-white font-medium text-xs shadow-lg shadow-sky-500/25 flex items-center gap-2 transition-all cursor-pointer disabled:opacity-50"
              >
                {isFinalizing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Syncing & Launching Vault...</span>
                  </>
                ) : (
                  <>
                    <Check className="w-4 h-4" />
                    <span>Complete Setup & Launch Vault</span>
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
