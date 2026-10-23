import { useState, useEffect } from "react";
import type { FC } from "react";
import {
  Key,
  Folder,
  User,
  Mail,
  GitBranch,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  Save,
  X,
  Radio,
  Sparkles,
} from "lucide-react";
import { GitVaultBridge } from "../services/gitVaultBridge";
import { VaultConfig } from "../types/gitVault";

const GithubIcon: FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
    />
  </svg>
);

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  vaultPath: string;
  onSaved: (newConfig: VaultConfig) => void;
  onOpenOnboarding?: () => void;
}

export const SettingsModal: FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  vaultPath,
  onSaved,
  onOpenOnboarding,
}) => {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [userName, setUserName] = useState("GitVault User");
  const [userEmail, setUserEmail] = useState("vault@gitvault.local");
  const [githubToken, setGithubToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  const [isLoadingConfig, setIsLoadingConfig] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  // Fetch current config whenever modal opens
  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    setIsLoadingConfig(true);
    setTestResult(null);

    GitVaultBridge.getVaultConfig(vaultPath)
      .then((cfg) => {
        if (!isMounted) return;
        setRemoteUrl(cfg.remote_url || "");
        setBranch(cfg.branch || "main");
        if (cfg.user_name) setUserName(cfg.user_name);
        if (cfg.user_email) setUserEmail(cfg.user_email);
      })
      .catch((err) => {
        console.error("Failed to load vault config:", err);
      })
      .finally(() => {
        if (isMounted) setIsLoadingConfig(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen, vaultPath]);

  if (!isOpen) return null;

  const handleTestConnection = async () => {
    if (!remoteUrl.trim()) {
      setTestResult({
        success: false,
        message: "Please enter a GitHub repository URL to test connection.",
      });
      return;
    }

    setIsTesting(true);
    setTestResult(null);

    try {
      const msg = await GitVaultBridge.testRemoteConnection(
        vaultPath,
        remoteUrl.trim(),
        githubToken.trim() || undefined
      );
      setTestResult({
        success: true,
        message: msg || "Successfully connected to GitHub repository!",
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult({
        success: false,
        message: msg || "Failed to reach remote repository.",
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);

    try {
      const updated = await GitVaultBridge.setVaultConfig(vaultPath, {
        remote_url: remoteUrl.trim() || undefined,
        branch: branch.trim() || "main",
        user_name: userName.trim() || undefined,
        user_email: userEmail.trim() || undefined,
        github_token: githubToken.trim() || undefined,
      });

      onSaved(updated);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestResult({
        success: false,
        message: `Failed to save configuration: ${msg}`,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl w-full max-w-xl text-zinc-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#30363d] bg-[#161b22]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <GithubIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">
                GitHub Sync & Vault Settings
              </h2>
              <p className="text-xs text-zinc-400">
                Configure remote repository URL and authentication for note syncing.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-[#21262d] rounded-lg transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        {isLoadingConfig ? (
          <div className="p-12 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
            <span className="text-sm">Loading vault configuration...</span>
          </div>
        ) : (
          <form onSubmit={handleSave} className="p-6 space-y-5">
            {/* Quick launch onboarding wizard */}
            {onOpenOnboarding && (
              <div className="p-3.5 bg-gradient-to-r from-sky-950/40 via-indigo-950/30 to-purple-950/30 border border-sky-500/30 rounded-xl flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-sky-500/20 border border-sky-500/30 flex items-center justify-center shrink-0 text-sky-400">
                    <Sparkles className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-white">
                      Repository Setup Wizard
                    </div>
                    <div className="text-[11px] text-zinc-400">
                      Authenticate with GitHub to pick an existing repo or create a new one.
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenOnboarding();
                  }}
                  className="shrink-0 px-3 py-1.5 bg-sky-600 hover:bg-sky-500 text-white rounded-lg text-xs font-medium shadow-md shadow-sky-600/30 transition-all cursor-pointer"
                >
                  Launch Wizard
                </button>
              </div>
            )}

            {/* Local Vault Path */}
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1.5 flex items-center gap-1.5">
                <Folder className="w-3.5 h-3.5 text-zinc-500" />
                Local Vault Directory
              </label>
              <div className="px-3 py-2 bg-[#161b22] border border-[#30363d] rounded-lg text-xs font-mono text-zinc-300 break-all select-all">
                {vaultPath}
              </div>
            </div>

            {/* Remote Repository URL */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                  <GithubIcon className="w-3.5 h-3.5 text-sky-400" />
                  GitHub Repository URL <span className="text-rose-400">*</span>
                </label>
                {remoteUrl ? (
                  <span className="text-[11px] text-emerald-400 font-medium flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Configured
                  </span>
                ) : (
                  <span className="text-[11px] text-amber-400 font-medium flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                    No remote linked
                  </span>
                )}
              </div>
              <input
                type="text"
                value={remoteUrl}
                onChange={(e) => setRemoteUrl(e.target.value)}
                placeholder="https://github.com/username/my-notes.git"
                className="w-full px-3.5 py-2.5 bg-[#0d1117] border border-[#30363d] focus:border-sky-500 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none transition-colors font-mono"
                required
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                Create an empty repository on GitHub, then paste its HTTPS or SSH URL above.
              </p>
            </div>

            {/* Branch */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-zinc-300 mb-1.5 flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5 text-purple-400" />
                  Default Branch
                </label>
                <input
                  type="text"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className="w-full px-3.5 py-2 bg-[#0d1117] border border-[#30363d] focus:border-purple-500 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none transition-colors font-mono"
                />
              </div>

              {/* GitHub Personal Access Token (PAT) */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-zinc-300 flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-amber-400" />
                    GitHub Token (PAT)
                  </label>
                  <span className="text-[10px] text-zinc-500 uppercase font-semibold">
                    Optional
                  </span>
                </div>
                <div className="relative">
                  <input
                    type={showToken ? "text" : "password"}
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxx"
                    className="w-full pl-3.5 pr-9 py-2 bg-[#0d1117] border border-[#30363d] focus:border-amber-500 rounded-lg text-sm text-white placeholder-zinc-600 focus:outline-none transition-colors font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-200"
                  >
                    {showToken ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            <p className="text-[11px] text-zinc-500 -mt-2">
              💡 <strong>Token tip:</strong> If your repository is private or you are on Android/mobile, create a GitHub token with <code>repo</code> scope. On desktop with Git Credential Manager, this can be left blank.
            </p>

            {/* Author details */}
            <div className="pt-2 border-t border-[#30363d]/50">
              <span className="text-xs font-semibold text-zinc-400 block mb-2">
                Git Commit Author Signature
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1 flex items-center gap-1.5">
                    <User className="w-3.5 h-3.5 text-zinc-500" />
                    Author Name
                  </label>
                  <input
                    type="text"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    placeholder="Your Name"
                    className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-white placeholder-zinc-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-400 mb-1 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-zinc-500" />
                    Author Email
                  </label>
                  <input
                    type="email"
                    value={userEmail}
                    onChange={(e) => setUserEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-white placeholder-zinc-600 focus:outline-none"
                  />
                </div>
              </div>
            </div>

            {/* Test Connection Results */}
            {testResult && (
              <div
                className={`p-3 rounded-lg border text-xs flex items-start gap-2.5 ${
                  testResult.success
                    ? "bg-emerald-950/40 border-emerald-500/30 text-emerald-300"
                    : "bg-rose-950/40 border-rose-500/30 text-rose-300"
                }`}
              >
                {testResult.success ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                )}
                <div className="flex-1 break-words leading-relaxed font-sans">
                  {testResult.message}
                </div>
              </div>
            )}

            {/* Footer Buttons */}
            <div className="pt-3 border-t border-[#30363d] flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={isTesting || !remoteUrl.trim()}
                className="px-3.5 py-2 text-xs font-medium rounded-lg border border-[#30363d] bg-[#21262d] text-zinc-300 hover:text-white hover:bg-[#30363d] transition-colors flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isTesting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                ) : (
                  <Radio className="w-3.5 h-3.5 text-sky-400" />
                )}
                <span>Test Connection</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-medium rounded-lg text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSaving}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-sky-600 hover:bg-sky-500 text-white shadow-md shadow-sky-600/30 transition-all flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isSaving ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Save className="w-3.5 h-3.5" />
                  )}
                  <span>Save Configuration</span>
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
