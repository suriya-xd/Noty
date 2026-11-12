import { useCallback, useEffect, useRef, useState } from "react";
import type { FC } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, FileText, RefreshCw } from "lucide-react";
import { GitHubService, pollDeviceFlow } from "../../services/githubService";
import type { PendingSignIn } from "../../services/githubService";
import { openExternal } from "../../services/noeticBridge";
import type { DeviceCodeResponse } from "../../types/noetic";

interface MobileOnboardingViewProps {
  isOpen: boolean;
  /** Called once an account is signed in; the host continues to naming or choosing a workspace. */
  onAuthenticated: () => void;
  onCancel: () => void;
}

type Step = "welcome" | "code";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const MobileOnboardingView: FC<MobileOnboardingViewProps> = ({ isOpen, onAuthenticated, onCancel }) => {
  const [step, setStep] = useState<Step>("welcome");
  const [device, setDevice] = useState<DeviceCodeResponse | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const expiresAt = useRef(0);

  const cancelPoll = useRef<(() => void) | null>(null);
  const stopPolling = useCallback(() => {
    cancelPoll.current?.();
    cancelPoll.current = null;
  }, []);

  // Reset whenever the view is closed. A sign-in the user walked away from is forgotten too.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true;
      return;
    }
    stopPolling();
    if (wasOpen.current) GitHubService.clearPendingSignIn();
    wasOpen.current = false;
    setStep("welcome");
    setDevice(null);
    setError(null);
  }, [isOpen, stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  const finish = useCallback(
    async (token: string) => {
      GitHubService.clearPendingSignIn();
      const user = await GitHubService.validateToken(token);
      GitHubService.saveGitHubAuth(token, user);
      onAuthenticated();
    },
    [onAuthenticated]
  );

  /** Shows the code and waits for it to be approved in the browser. */
  const waitForApproval = useCallback(
    (pending: PendingSignIn) => {
      stopPolling();
      expiresAt.current = pending.expiresAt;
      setDevice(pending.device);
      setSecondsLeft(Math.max(0, Math.round((pending.expiresAt - Date.now()) / 1000)));
      setStep("code");
      cancelPoll.current = pollDeviceFlow({
        deviceCode: pending.device.device_code,
        interval: pending.device.interval,
        expiresIn: pending.device.expires_in,
        expiresAt: pending.expiresAt,
        onApproved: finish,
        onFailure: (message) => {
          GitHubService.clearPendingSignIn();
          setError(message);
        },
      });
    },
    [finish, stopPolling]
  );

  // The phone may close the app while the user signs in to GitHub in the browser. If a code was
  // waiting when that happened, carry on with it instead of starting over.
  useEffect(() => {
    if (!isOpen) return;
    const pending = GitHubService.getPendingSignIn();
    if (pending) waitForApproval(pending);
  }, [isOpen, waitForApproval]);

  const startDeviceFlow = async () => {
    stopPolling();
    setError(null);
    setIsStarting(true);
    try {
      const res = await GitHubService.startDeviceFlow();
      waitForApproval(GitHubService.savePendingSignIn(res));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setIsStarting(false);
    }
  };

  // Countdown for the one-time code.
  useEffect(() => {
    if (step !== "code") return;
    // Worked out from the clock, not counted down: timers barely run while the app is in the background.
    const t = setInterval(
      () => setSecondsLeft(Math.max(0, Math.round((expiresAt.current - Date.now()) / 1000))),
      1000
    );
    return () => clearInterval(t);
  }, [step, device]);

  const expired = step === "code" && !!device && secondsLeft === 0;
  useEffect(() => {
    if (expired) stopPolling();
  }, [expired, stopPolling]);

  const copyCode = async () => {
    if (!device) return;
    try {
      await navigator.clipboard.writeText(device.user_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy automatically. Press and hold the code to copy it.");
    }
  };

  if (!isOpen) return null;

  const back = () => {
    stopPolling();
    GitHubService.clearPendingSignIn();
    setError(null);
    setStep("welcome");
  };

  const errorBox = error && (
    <p role="alert" className="rounded-xl bg-red-500/10 border border-red-500/30 px-4 py-3 text-[14px] leading-relaxed text-red-300">
      {error}
    </p>
  );

  return (
    <div className="m-shell fixed inset-0 z-50 bg-[#0d1117] text-[#e6edf3] flex flex-col m-fade-in select-none">
      <div className="pt-safe shrink-0">
        <div className="h-14 px-1.5 flex items-center">
          {step !== "welcome" && (
            <button
              type="button"
              aria-label="Back"
              onClick={back}
              className="w-11 h-11 rounded-full flex items-center justify-center text-[#8b949e] active:bg-[#21262d]"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="min-h-full w-full max-w-md mx-auto px-6 pb-6 flex flex-col">
          {step === "welcome" && (
            <>
              <div className="flex-1 flex flex-col justify-center py-8">
                <div className="w-14 h-14 rounded-2xl bg-sky-500/10 border border-sky-500/25 flex items-center justify-center">
                  <FileText className="w-7 h-7 text-sky-400" />
                </div>
                <h1 className="font-headline text-[32px] leading-[1.15] font-semibold text-[#f0f6fc] mt-6">
                  Notes that stay yours
                </h1>
                <p className="text-[16px] leading-relaxed text-[#8b949e] mt-3">
                  Noetic keeps plain Markdown files on this device and backs them up privately to your own GitHub account, so they sync across your devices.
                </p>
              </div>
              <div className="space-y-3">
                {errorBox}
                <button
                  type="button"
                  onClick={startDeviceFlow}
                  disabled={isStarting}
                  className="w-full h-[52px] rounded-xl bg-sky-500 text-[#04121d] text-[16px] font-semibold flex items-center justify-center gap-2 active:bg-sky-400 disabled:opacity-60"
                >
                  {isStarting && <RefreshCw className="w-4 h-4 animate-spin" />}
                  <span>{isStarting ? "Contacting GitHub…" : "Sign in with GitHub"}</span>
                </button>
                <button
                  type="button"
                  onClick={onCancel}
                  className="w-full h-12 text-[15px] font-medium text-[#8b949e] active:text-[#f0f6fc]"
                >
                  Not now — keep notes on this device
                </button>
              </div>
            </>
          )}

          {step === "code" && device && (
            <div className="flex-1 flex flex-col pt-2">
              <h1 className="font-headline text-[26px] font-semibold text-[#f0f6fc]">Enter this code on GitHub</h1>
              <p className="text-[15px] leading-relaxed text-[#8b949e] mt-2">
                Copy the code, open GitHub, and paste it there to approve Noetic. This screen continues by itself.
              </p>

              <div className="mt-6 rounded-2xl bg-[#161b22] border border-[#21262d] p-5">
                <p
                  className={`font-mono text-[30px] font-semibold tracking-[0.18em] text-center select-all ${
                    expired ? "text-[#6e7681] line-through" : "text-[#f0f6fc]"
                  }`}
                >
                  {device.user_code}
                </p>
                <button
                  type="button"
                  onClick={copyCode}
                  disabled={expired}
                  className="mt-4 w-full h-12 rounded-xl bg-[#21262d] text-[#f0f6fc] text-[15px] font-medium flex items-center justify-center gap-2 active:bg-[#30363d] disabled:opacity-40"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                  <span>{copied ? "Copied" : "Copy code"}</span>
                </button>
              </div>

              <a
                href={device.verification_uri}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  void openExternal(device.verification_uri);
                }}
                className={`mt-3 w-full h-[52px] rounded-xl bg-sky-500 text-[#04121d] text-[16px] font-semibold flex items-center justify-center gap-2 active:bg-sky-400 ${
                  expired ? "pointer-events-none opacity-40" : ""
                }`}
              >
                <span>Open GitHub</span>
                <ExternalLink className="w-4 h-4" />
              </a>

              <div className="mt-5 space-y-3">
                {errorBox}
                {expired || error ? (
                  <button
                    type="button"
                    onClick={startDeviceFlow}
                    disabled={isStarting}
                    className="w-full h-12 rounded-xl bg-[#161b22] border border-[#30363d] text-[#f0f6fc] text-[15px] font-medium active:bg-[#21262d] disabled:opacity-60"
                  >
                    {expired && !error ? "Code expired — get a new one" : "Get a new code"}
                  </button>
                ) : (
                  <p className="flex items-center justify-center gap-2 text-[14px] text-[#8b949e]" aria-live="polite">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>
                      Waiting for approval · code valid for {Math.floor(secondsLeft / 60)}:
                      {String(secondsLeft % 60).padStart(2, "0")}
                    </span>
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="pb-safe shrink-0" />
    </div>
  );
};
