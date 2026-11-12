import { useEscapeKey } from "./dialogs";
import { useState, useEffect, useRef } from "react";
import type { FC } from "react";
import { Check, AlertCircle, Loader2, ExternalLink, Sparkles, ArrowRight, Copy, RefreshCw } from "lucide-react";
import { GitHubService, pollDeviceFlow } from "../services/githubService";
import { openExternal } from "../services/noeticBridge";
import { DeviceCodeResponse } from "../types/noetic";

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
  /** Called once an account is signed in; the host continues to naming or choosing a workspace. */
  onAuthenticated: () => void;
  onCancel?: () => void;
}

export const OnboardingModal: FC<OnboardingModalProps> = ({ isOpen, onAuthenticated, onCancel }) => {
  useEscapeKey(isOpen && !!onCancel, () => onCancel?.());

  const [deviceFlowData, setDeviceFlowData] = useState<DeviceCodeResponse | null>(null);
  const [isStartingDeviceFlow, setIsStartingDeviceFlow] = useState(false);
  const [isPollingDeviceToken, setIsPollingDeviceToken] = useState(false);
  const [deviceFlowError, setDeviceFlowError] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);

  const cancelPollRef = useRef<(() => void) | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      cancelPollRef.current?.();
      cancelPollRef.current = null;
    };
  }, []);

  // Closing the modal abandons an in-progress sign-in: it must not finish later in the background.
  useEffect(() => {
    if (isOpen) return;
    cancelPollRef.current?.();
    cancelPollRef.current = null;
    setIsPollingDeviceToken(false);
    setDeviceFlowData(null);
    setDeviceFlowError(null);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleStartDeviceFlow = async () => {
    setIsStartingDeviceFlow(true);
    setDeviceFlowError(null);
    cancelPollRef.current?.();
    cancelPollRef.current = null;

    try {
      const data = await GitHubService.startDeviceFlow();
      setDeviceFlowData(data);

      try {
        await navigator.clipboard.writeText(data.user_code);
        setCodeCopied(true);
        setTimeout(() => setCodeCopied(false), 3000);
      } catch {}

      setIsPollingDeviceToken(true);
      cancelPollRef.current = pollDeviceFlow({
        deviceCode: data.device_code,
        interval: data.interval,
        expiresIn: data.expires_in,
        onApproved: async (accessToken) => {
          const user = await GitHubService.validateToken(accessToken);
          GitHubService.saveGitHubAuth(accessToken, user);
          setIsPollingDeviceToken(false);
          onAuthenticated();
        },
        onFailure: (message) => {
          setIsPollingDeviceToken(false);
          setDeviceFlowError(message);
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setDeviceFlowError(msg || "Couldn't start the sign-in. Try again.");
    } finally {
      setIsStartingDeviceFlow(false);
    }
  };

  const handleOpenGitHubBrowser = async () => {
    if (!deviceFlowData) return;
    try {
      await navigator.clipboard.writeText(deviceFlowData.user_code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 3000);
    } catch {}

    const url = deviceFlowData.verification_uri || "https://github.com/login/device";
    void openExternal(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4 overflow-y-auto">
      <div className="bg-[#0d1117] border border-[#30363d] rounded-2xl shadow-2xl w-full max-w-xl text-zinc-100 overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
        <div className="px-6 py-5 border-b border-[#30363d] bg-[#161b22]/90 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-sky-500 via-indigo-500 to-purple-500 flex items-center justify-center shadow-lg shadow-sky-500/25">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold text-white tracking-tight">Set up Noetic</h1>
            <p className="text-xs text-zinc-400">Sign in once to back up your notes and sync them across devices.</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="space-y-6">
            <div className="text-center max-w-md mx-auto pt-2">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-sky-500/20 via-indigo-500/20 to-purple-500/20 border border-sky-500/30 flex items-center justify-center text-white mx-auto mb-3 shadow-lg shadow-sky-500/10">
                <GithubIcon className="w-7 h-7" />
              </div>
              <h2 className="text-lg font-bold text-white tracking-tight">
                Sign in with GitHub
              </h2>
              <p className="text-xs text-zinc-400 mt-1">
                Approve Noetic in your browser with a one-time code. Noetic then keeps your notes backed up and in sync, privately, in your own account.
              </p>
            </div>

            {/* Device Flow Interactive Card */}
            {!deviceFlowData ? (
              <div className="max-w-md mx-auto p-6 bg-[#161b22]/90 border border-[#30363d] rounded-2xl text-center space-y-4 shadow-xl">
                <p className="text-xs text-zinc-300 leading-relaxed">
                  You'll get a short code to enter on GitHub. No password is stored in the app.
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
                    Your one-time code
                  </span>
                  <p className="text-xs text-zinc-400">
                    Copy this code, open GitHub in your browser, and approve Noetic.
                  </p>
                </div>

                {/* Big User Code Display */}
                <div className="bg-[#0d1117] border border-[#30363d] rounded-xl p-4 flex items-center justify-between">
                  <div>
                    <div className="text-[10px] text-zinc-500 uppercase font-mono tracking-wider">
                      One-time code
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
                  <span>Open GitHub</span>
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
                      {isPollingDeviceToken ? "Waiting for your approval in the browser…" : "Sign-in paused"}
                    </span>
                    <div className="text-[11px] text-zinc-400 mt-0.5">
                      Noetic continues by itself once you approve.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleStartDeviceFlow}
                    disabled={isStartingDeviceFlow}
                    className="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-[#21262d]"
                    title="Get a new code"
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
          </div>
        </div>

        <div className="px-6 py-4 border-t border-[#30363d] bg-[#161b22] flex items-center justify-end">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-3.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
            >
              Not now, keep notes on this device
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
