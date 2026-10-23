import { useState, useEffect } from "react";
import type { FC } from "react";
import {
  User,
  Mail,
  LogOut,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  Copy,
  Check,
  Sparkles,
  X,
  HardDrive,
  Laptop,
} from "lucide-react";
import { GitHubService } from "../services/githubService";
import { DeviceCodeResponse, GitHubUser } from "../types/gitVault";

const GithubIcon: FC<{ className?: string }> = ({ className = "w-4 h-4" }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
    />
  </svg>
);

interface AccountSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  vaultPath: string;
  onAccountChanged?: () => void;
}

export const AccountSettingsModal: FC<AccountSettingsModalProps> = ({
  isOpen,
  onClose,
  vaultPath,
  onAccountChanged,
}) => {
  const [currentUser, setCurrentUser] = useState<GitHubUser | null>(null);

  // Switch account / Device flow state
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false);
  const [deviceFlowData, setDeviceFlowData] = useState<DeviceCodeResponse | null>(null);
  const [isStartingDeviceFlow, setIsStartingDeviceFlow] = useState(false);
  const [isPolling, setIsPolling] = useState(false);
  const [deviceFlowError, setDeviceFlowError] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setIsSwitchingAccount(false);
      setDeviceFlowData(null);
      return;
    }

    const stored = GitHubService.getStoredGitHubAuth();
    if (stored) {
      setCurrentUser(stored.user);
    } else {
      setCurrentUser(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleStartSwitchAccount = async () => {
    setIsStartingDeviceFlow(true);
    setDeviceFlowError(null);
    try {
      const data = await GitHubService.startDeviceFlow();
      setDeviceFlowData(data);
      setIsSwitchingAccount(true);

      try {
        await navigator.clipboard.writeText(data.user_code);
        setCodeCopied(true);
        setTimeout(() => setCodeCopied(false), 3000);
      } catch {}

      startPolling(data.device_code, data.interval || 5);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setDeviceFlowError(msg);
    } finally {
      setIsStartingDeviceFlow(false);
    }
  };

  const startPolling = (deviceCode: string, intervalSecs: number) => {
    setIsPolling(true);

    const poll = async (currInterval: number) => {
      try {
        const res = await GitHubService.pollDeviceToken(deviceCode);
        if (res.status === "approved" && res.access_token) {
          setIsPolling(false);
          const newUser = await GitHubService.validateToken(res.access_token);
          GitHubService.saveGitHubAuth(res.access_token, newUser);
          setCurrentUser(newUser);
          setIsSwitchingAccount(false);
          setDeviceFlowData(null);
          onAccountChanged?.();
          return;
        }

        if (res.status === "pending" || res.status === "slow_down") {
          const nextInterval = res.interval || currInterval;
          setTimeout(() => poll(nextInterval), nextInterval * 1000);
          return;
        }

        setIsPolling(false);
        setDeviceFlowError(res.error_description || "Authentication was cancelled.");
      } catch (err: unknown) {
        setIsPolling(false);
        const msg = err instanceof Error ? err.message : String(err);
        setDeviceFlowError(msg);
      }
    };

    setTimeout(() => poll(intervalSecs), intervalSecs * 1000);
  };

  const handleSignOut = () => {
    if (confirm("Sign out of your GitHub account? Local notes will remain on disk.")) {
      GitHubService.clearGitHubAuth();
      setCurrentUser(null);
      onAccountChanged?.();
    }
  };

  const handleOpenBrowser = async () => {
    if (!deviceFlowData) return;
    try {
      await navigator.clipboard.writeText(deviceFlowData.user_code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 3000);
    } catch {}
    window.open(deviceFlowData.verification_uri || "https://github.com/login/device", "_blank");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl w-full max-w-lg text-zinc-100 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#30363d] bg-[#161b22]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <GithubIcon className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white">
                Account & Settings
              </h2>
              <p className="text-xs text-zinc-400">
                Manage your connected GitHub identity and synchronization
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-[#21262d] rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-5">
          {/* Section: Connected GitHub Account */}
          <div className="space-y-3">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">
              Connected GitHub Identity
            </span>

            {currentUser ? (
              <div className="p-4 bg-[#161b22] border border-[#30363d] rounded-xl space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <img
                      src={currentUser.avatar_url}
                      alt={currentUser.login}
                      className="w-11 h-11 rounded-full border border-sky-500/40 shadow-sm"
                    />
                    <div>
                      <div className="text-sm font-bold text-white flex items-center gap-1.5">
                        <span>{currentUser.name || currentUser.login}</span>
                        <a
                          href={currentUser.html_url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-zinc-400 hover:text-sky-400"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                      <div className="text-xs text-zinc-400">
                        @{currentUser.login}
                      </div>
                    </div>
                  </div>

                  <span className="px-2.5 py-1 rounded-full bg-emerald-950/60 border border-emerald-500/30 text-emerald-400 text-[11px] font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Connected</span>
                  </span>
                </div>

                {currentUser.email && (
                  <div className="text-xs text-zinc-400 flex items-center gap-1.5 pt-2 border-t border-[#30363d]/50 font-mono">
                    <Mail className="w-3.5 h-3.5 text-zinc-500" />
                    <span>{currentUser.email}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="p-4 bg-[#161b22] border border-[#30363d] rounded-xl text-center space-y-3">
                <User className="w-8 h-8 text-zinc-500 mx-auto" />
                <p className="text-xs text-zinc-400">
                  No GitHub account currently connected.
                </p>
                <button
                  onClick={handleStartSwitchAccount}
                  disabled={isStartingDeviceFlow}
                  className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-md shadow-sky-600/30 flex items-center gap-2 mx-auto cursor-pointer"
                >
                  <GithubIcon className="w-3.5 h-3.5" />
                  <span>Connect with GitHub</span>
                </button>
              </div>
            )}
          </div>

          {/* Device Flow for Switching Account */}
          {isSwitchingAccount && deviceFlowData && (
            <div className="p-4 bg-sky-950/20 border border-sky-500/30 rounded-xl space-y-3 animate-in fade-in duration-200">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                  Authorize New GitHub Account
                </span>
                <button
                  onClick={() => setIsSwitchingAccount(false)}
                  className="text-[11px] text-zinc-400 hover:text-white"
                >
                  Cancel
                </button>
              </div>

              <div className="bg-[#0d1117] border border-[#30363d] rounded-lg p-3 flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-zinc-500 uppercase font-mono">
                    Device Code
                  </div>
                  <div className="text-lg font-black font-mono tracking-widest text-white">
                    {deviceFlowData.user_code}
                  </div>
                </div>

                <button
                  onClick={() => {
                    navigator.clipboard.writeText(deviceFlowData.user_code);
                    setCodeCopied(true);
                    setTimeout(() => setCodeCopied(false), 3000);
                  }}
                  className="px-2.5 py-1.5 rounded-md bg-[#21262d] hover:bg-[#30363d] text-zinc-300 text-xs flex items-center gap-1 cursor-pointer"
                >
                  {codeCopied ? (
                    <>
                      <Check className="w-3 h-3 text-emerald-400" />
                      <span className="text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>

              <button
                onClick={handleOpenBrowser}
                className="w-full py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold shadow-md flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <span>Open GitHub in Browser</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </button>

              {isPolling && (
                <div className="flex items-center gap-2 text-[11px] text-sky-300">
                  <Loader2 className="w-3 h-3 animate-spin text-sky-400" />
                  <span>Waiting for authorization in browser...</span>
                </div>
              )}
            </div>
          )}

          {deviceFlowError && (
            <div className="p-3 bg-rose-950/40 border border-rose-500/30 rounded-lg text-xs text-rose-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{deviceFlowError}</span>
            </div>
          )}

          {/* Account Actions: Switch Account & Sign Out */}
          {currentUser && !isSwitchingAccount && (
            <div className="flex items-center gap-2.5 pt-1">
              <button
                onClick={handleStartSwitchAccount}
                disabled={isStartingDeviceFlow}
                className="flex-1 px-3.5 py-2 rounded-lg bg-[#21262d] hover:bg-[#30363d] text-zinc-200 hover:text-white border border-[#30363d] text-xs font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isStartingDeviceFlow ? "animate-spin" : ""}`} />
                <span>Change / Switch Account</span>
              </button>

              <button
                onClick={handleSignOut}
                className="px-3.5 py-2 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <LogOut className="w-3.5 h-3.5" />
                <span>Sign Out</span>
              </button>
            </div>
          )}

          {/* Section: Application Environment */}
          <div className="pt-4 border-t border-[#30363d] space-y-2">
            <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider block">
              Vault Workspace
            </span>
            <div className="p-3 bg-[#161b22] border border-[#30363d] rounded-xl flex items-center gap-2.5 text-xs text-zinc-300 font-mono break-all select-all">
              <HardDrive className="w-4 h-4 text-zinc-500 shrink-0" />
              <span>{vaultPath}</span>
            </div>
            <div className="flex items-center justify-between text-[11px] text-zinc-500 pt-1">
              <span className="flex items-center gap-1">
                <Laptop className="w-3 h-3" /> Native Git2 Engine
              </span>
              <span>GitVault v0.1.0</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
