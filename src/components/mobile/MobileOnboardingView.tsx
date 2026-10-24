import { useState, useEffect } from "react";
import type { FC } from "react";
import {
  Terminal,
  Copy,
  Check,
  ExternalLink,
  ChevronDown,
  Key,
  FolderOpen,
  ArrowRight,
  ShieldCheck,
} from "lucide-react";
import { GitVaultBridge } from "../../services/gitVaultBridge";

interface MobileOnboardingViewProps {
  isOpen: boolean;
  defaultVaultPath: string;
  onComplete: (data: { vaultPath: string; token?: string }) => void;
  onCancel: () => void;
}

export const MobileOnboardingView: FC<MobileOnboardingViewProps> = ({
  isOpen,
  defaultVaultPath,
  onComplete,
  onCancel,
}) => {
  const [deviceCode, setDeviceCode] = useState("WXYZ-9821");
  const [userCodeUrl, setUserCodeUrl] = useState("https://github.com/login/device");
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(411);
  const [patToken, setPatToken] = useState("");
  const [showPat, setShowPat] = useState(false);
  const [selectedVaultPath, setSelectedVaultPath] = useState(defaultVaultPath || "/Documents/Noty-Vault");

  useEffect(() => {
    if (!isOpen) return;
    let isSubscribed = true;

    // Trigger device code request via bridge
    GitVaultBridge.startDeviceFlow()
      .then((res) => {
        if (isSubscribed && res?.user_code) {
          setDeviceCode(res.user_code);
          if (res.verification_uri) setUserCodeUrl(res.verification_uri);
          if (res.expires_in) setSecondsLeft(res.expires_in);
        }
      })
      .catch((err) => {
        console.warn("Device flow mock fallback:", err);
      });

    return () => {
      isSubscribed = false;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCopyCode = () => {
    navigator.clipboard.writeText(deviceCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatCountdown = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `Expires in ${mins}:${secs < 10 ? "0" : ""}${secs}`;
  };

  const handleContinue = () => {
    onComplete({
      vaultPath: selectedVaultPath,
      token: patToken.trim() || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#10141a] text-[#dfe2eb] flex flex-col overflow-y-auto animate-fadeIn select-none">
      <main className="flex-1 flex flex-col relative w-full pt-safe pb-safe px-4 py-6 max-w-md mx-auto space-y-4">
        {/* Stepper Progress Bar */}
        <div className="flex flex-col space-y-2">
          <div className="flex items-center justify-between font-mono text-[11px] text-[#8b949e]">
            <span className="flex items-center gap-1.5 text-sky-400 font-semibold tracking-wider">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse"></span>
              STEP 01 OF 03
            </span>
            <span>Account Sync</span>
          </div>

          <div className="grid grid-cols-3 gap-1.5 w-full">
            <div className="h-1.5 rounded-full bg-sky-400 shadow-sm"></div>
            <div className="h-1.5 rounded-full bg-[#262a31]"></div>
            <div className="h-1.5 rounded-full bg-[#262a31]"></div>
          </div>

          <div className="flex justify-between font-mono text-[10px] text-[#8b949e] px-0.5">
            <span className="text-[#f0f6fc] font-medium">1. Connect</span>
            <span>2. Folder</span>
            <span>3. Vault</span>
          </div>
        </div>

        {/* Hero Header */}
        <div className="flex flex-col items-center text-center space-y-2 pt-1 pb-1">
          <div className="relative flex items-center justify-center w-14 h-14 rounded-full bg-[#1c2026] border border-[#30363d] shadow-lg">
            <div className="absolute inset-0 rounded-full bg-sky-400/10 animate-ping"></div>
            <Terminal className="w-7 h-7 text-sky-400" />
          </div>
          <div className="space-y-0.5">
            <h1 className="font-headline text-xl font-bold text-[#f0f6fc] tracking-tight">
              Welcome to Noty
            </h1>
            <p className="text-xs text-[#8b949e] max-w-xs mx-auto leading-relaxed">
              Connect your GitHub account to sync local markdown notes transparently with Git versioning.
            </p>
          </div>
        </div>

        {/* Device Authentication Card */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-4 shadow-xl flex flex-col space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Key className="w-4 h-4 text-sky-400" />
              <div>
                <h2 className="font-headline text-xs font-semibold text-[#f0f6fc]">
                  GitHub Device Code
                </h2>
                <p className="font-mono text-[10px] text-[#8b949e]">
                  oauth2_device_flow
                </p>
              </div>
            </div>
            <span className="px-2 py-0.5 rounded-full font-mono text-[10px] bg-sky-500/10 text-sky-400 border border-sky-500/20 font-medium">
              v2.4
            </span>
          </div>

          {/* Activation Code Box */}
          <div className="bg-[#0d1117] border border-[#21262d] rounded-xl p-3 flex items-center justify-between shadow-inner">
            <div className="flex flex-col">
              <span className="font-mono text-[9px] uppercase tracking-wider text-[#8b949e]">
                One-Time Activation Code
              </span>
              <span className="font-mono text-lg font-bold tracking-widest text-[#f0f6fc] mt-0.5 select-all">
                {deviceCode}
              </span>
            </div>
            <button
              onClick={handleCopyCode}
              aria-label="Copy Code"
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-all active:scale-95 cursor-pointer shadow-sm ${
                copied
                  ? "bg-emerald-500 text-[#0d1117]"
                  : "bg-[#21262d] text-[#f0f6fc] hover:bg-[#30363d]"
              }`}
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>

          {/* Verification Link Button */}
          <a
            href={userCodeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-full bg-sky-500 hover:bg-sky-400 text-[#0d1117] font-headline text-xs font-bold active:scale-[0.98] transition-transform shadow-md"
          >
            <span>Open Verification Page</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>

          {/* Countdown & Status */}
          <div className="flex items-center justify-between px-1 text-[11px] text-[#8b949e]">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-sky-400 animate-ping"></span>
              <span className="text-[#f0f6fc]">Waiting for authorization...</span>
            </div>
            <span className="font-mono text-[10px] text-[#8b949e]">
              {formatCountdown(secondsLeft)}
            </span>
          </div>
        </div>

        {/* PAT Accordion */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-3 flex flex-col space-y-2">
          <button
            onClick={() => setShowPat(!showPat)}
            className="flex items-center justify-between w-full text-left text-xs font-medium text-[#f0f6fc] cursor-pointer"
          >
            <span className="flex items-center gap-2">
              <Key className="w-3.5 h-3.5 text-emerald-400" />
              <span>Use Personal Access Token (PAT)</span>
            </span>
            <ChevronDown
              className={`w-4 h-4 text-[#8b949e] transition-transform ${
                showPat ? "rotate-180" : ""
              }`}
            />
          </button>

          {showPat && (
            <div className="space-y-2 pt-1 animate-fadeIn">
              <p className="text-[11px] text-[#8b949e] leading-relaxed">
                Provide a GitHub Personal Access Token with <code className="text-sky-300">repo</code> scope if device code is blocked.
              </p>
              <input
                type="password"
                placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                value={patToken}
                onChange={(e) => setPatToken(e.target.value)}
                className="w-full bg-[#0d1117] border border-[#30363d] focus:border-sky-500 rounded-full px-3.5 py-1.5 text-xs text-[#f0f6fc] outline-none font-mono"
              />
            </div>
          )}
        </div>

        {/* Mobile Vault Path */}
        <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-3.5 flex flex-col space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
              <span className="font-headline text-xs font-semibold text-[#f0f6fc]">
                Mobile Vault Path
              </span>
            </div>
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-[#21262d] text-[#8b949e]">
              Local Store
            </span>
          </div>

          <div className="flex items-center justify-between bg-[#0d1117] border border-[#21262d] rounded-full p-1 pl-3">
            <span className="font-mono text-xs text-[#f0f6fc] truncate mr-2">
              {selectedVaultPath}
            </span>
            <button
              onClick={() => {
                const p = prompt("Enter mobile vault folder path:", selectedVaultPath);
                if (p) setSelectedVaultPath(p);
              }}
              className="px-2.5 py-1 rounded-full bg-[#21262d] hover:bg-[#30363d] text-[11px] font-medium text-[#f0f6fc] transition-colors cursor-pointer shrink-0"
            >
              Browse
            </button>
          </div>

          <div className="flex items-center gap-1.5 text-[10px] text-[#8b949e]">
            <ShieldCheck className="w-3 h-3 text-emerald-400 shrink-0" />
            <span>Sandboxed document store with transparent Git staging.</span>
          </div>
        </div>

        {/* Bottom Actions */}
        <div className="flex flex-col space-y-2 pt-1">
          <button
            onClick={handleContinue}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-5 rounded-full bg-sky-500 hover:bg-sky-400 text-[#0d1117] font-headline text-xs font-bold active:scale-[0.98] transition-transform shadow-lg cursor-pointer"
          >
            <span>Continue to Notes</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onCancel}
            className="w-full py-2 text-xs text-[#8b949e] hover:text-[#f0f6fc] transition-colors cursor-pointer"
          >
            Skip for now (Local only)
          </button>
        </div>
      </main>
    </div>
  );
};
