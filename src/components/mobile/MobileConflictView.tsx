import { useState } from "react";
import type { FC } from "react";
import {
  ArrowLeft,
  Smartphone,
  Cloud,
  Columns,
  Check,
  AlertTriangle,
  CheckCheck,
} from "lucide-react";
import { ConflictFile, ConflictResolution } from "../../types/gitVault";

interface MobileConflictViewProps {
  conflicts: ConflictFile[];
  isOpen: boolean;
  onClose: () => void;
  onApplyResolutions: (resolutions: ConflictResolution[]) => void;
}

export const MobileConflictView: FC<MobileConflictViewProps> = ({
  conflicts,
  isOpen,
  onClose,
  onApplyResolutions,
}) => {
  const [activeTab, setActiveTab] = useState<"mine" | "cloud" | "split">("split");
  // Per-file resolution state: map from filePath to "local" | "remote" | "custom"
  const [resolutions, setResolutions] = useState<Record<string, "local" | "remote">>({});

  if (!isOpen || conflicts.length === 0) return null;

  const currentConflict = conflicts[0];
  const fileResolution = resolutions[currentConflict.path] || "local";

  const handleResolveSingle = (type: "local" | "remote") => {
    setResolutions((prev) => ({ ...prev, [currentConflict.path]: type }));
  };

  const handleResolveAll = (type: "local" | "remote") => {
    const next: Record<string, "local" | "remote"> = {};
    for (const c of conflicts) {
      next[c.path] = type;
    }
    setResolutions(next);
  };

  const handleApply = () => {
    const payload: ConflictResolution[] = conflicts.map((c) => {
      const type = resolutions[c.path] || "local";
      const customContent = type === "local" ? c.local_content : c.remote_content;
      return {
        path: c.path,
        resolution_type: type,
        custom_content: customContent,
      };
    });
    onApplyResolutions(payload);
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#10141a] text-[#dfe2eb] flex flex-col overflow-hidden animate-fadeIn">
      {/* Mobile Header */}
      <header className="h-14 px-4 bg-[#10141a]/90 backdrop-blur-xl border-b border-[#30363d] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onClose}
            aria-label="Go Back"
            className="w-9 h-9 rounded-full flex items-center justify-center text-[#8b949e] hover:text-[#f0f6fc] hover:bg-[#21262d] transition-colors -ml-1 cursor-pointer"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="font-headline text-base font-semibold text-[#f0f6fc] tracking-tight truncate">
            Conflict Resolution
          </h1>
        </div>
        <span className="font-mono text-xs text-[#fb923c] bg-[#fb923c]/10 border border-[#fb923c]/20 px-2 py-0.5 rounded-full">
          {conflicts.length} conflict{conflicts.length > 1 ? "s" : ""}
        </span>
      </header>

      {/* Main Scrollable Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 pb-32">
        {/* Amber Alert Card */}
        <div className="relative overflow-hidden rounded-2xl bg-[#181c22] border border-[#fb923c]/30 p-3.5 shadow-md">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-full bg-[#fb923c]/15 text-[#fb923c] flex items-center justify-center shrink-0 mt-0.5">
              <AlertTriangle className="w-4 h-4 text-[#fb923c]" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-headline text-sm font-semibold text-[#f0f6fc]">
                Sync Overlap Detected
              </h3>
              <p className="text-xs text-[#8b949e] mt-0.5 leading-relaxed">
                Changes from remote conflict with local edits in{" "}
                <span className="font-mono text-sky-400 font-medium">
                  {currentConflict.path}
                </span>
                . Select which version to keep before committing.
              </p>
            </div>
          </div>
        </div>

        {/* Segmented View Toggle */}
        <div className="flex p-1 bg-[#0a0e14] rounded-full gap-1 border border-[#30363d]">
          <button
            onClick={() => setActiveTab("mine")}
            className={`flex-1 py-1.5 px-3 rounded-full text-xs font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === "mine"
                ? "bg-[#1c2026] text-[#f0f6fc] shadow-sm"
                : "text-[#8b949e] hover:text-[#f0f6fc]"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#fbbf24]"></span>
            <span>This Phone</span>
          </button>
          <button
            onClick={() => setActiveTab("cloud")}
            className={`flex-1 py-1.5 px-3 rounded-full text-xs font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === "cloud"
                ? "bg-[#1c2026] text-[#f0f6fc] shadow-sm"
                : "text-[#8b949e] hover:text-[#f0f6fc]"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#38bdf8]"></span>
            <span>Cloud</span>
          </button>
          <button
            onClick={() => setActiveTab("split")}
            className={`flex-1 py-1.5 px-3 rounded-full text-xs font-medium transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
              activeTab === "split"
                ? "bg-[#1c2026] text-[#f0f6fc] shadow-sm"
                : "text-[#8b949e] hover:text-[#f0f6fc]"
            }`}
          >
            <Columns className="w-3.5 h-3.5" />
            <span>Side-by-Side</span>
          </button>
        </div>

        {/* This Phone (Local) Card */}
        {(activeTab === "mine" || activeTab === "split") && (
          <div
            className={`rounded-2xl bg-[#161b22] border p-3.5 shadow-sm transition-all ${
              fileResolution === "local"
                ? "border-[#fbbf24] ring-1 ring-[#fbbf24]/30"
                : "border-[#30363d]"
            }`}
          >
            <div className="flex items-center justify-between pb-2">
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[#fbbf24]/10 text-[#fbbf24] flex items-center gap-1">
                <Smartphone className="w-3 h-3" />
                This Phone (Local Draft)
              </span>
              <span className="font-mono text-[10px] text-emerald-400 font-medium">
                Local changes
              </span>
            </div>
            <pre className="mt-2 bg-[#0d1117] border border-[#21262d] rounded-xl p-3 font-mono text-xs text-[#f0f6fc] overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-48">
              {currentConflict.local_content}
            </pre>
            <div className="mt-3 flex justify-end">
              <button
                onClick={() => handleResolveSingle("local")}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all ${
                  fileResolution === "local"
                    ? "bg-[#fbbf24] text-[#0d1117]"
                    : "bg-[#21262d] text-[#8b949e] hover:text-[#f0f6fc]"
                }`}
              >
                <Check className="w-3.5 h-3.5" />
                <span>Keep This Version</span>
              </button>
            </div>
          </div>
        )}

        {/* Cloud (Remote) Card */}
        {(activeTab === "cloud" || activeTab === "split") && (
          <div
            className={`rounded-2xl bg-[#161b22] border p-3.5 shadow-sm transition-all ${
              fileResolution === "remote"
                ? "border-[#38bdf8] ring-1 ring-[#38bdf8]/30"
                : "border-[#30363d]"
            }`}
          >
            <div className="flex items-center justify-between pb-2">
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-[#38bdf8]/10 text-[#38bdf8] flex items-center gap-1">
                <Cloud className="w-3 h-3" />
                Cloud Version (Remote)
              </span>
              <span className="font-mono text-[10px] text-sky-400 font-medium">
                Incoming
              </span>
            </div>
            <pre className="mt-2 bg-[#0d1117] border border-[#21262d] rounded-xl p-3 font-mono text-xs text-[#f0f6fc] overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-48">
              {currentConflict.remote_content}
            </pre>
            <div className="mt-3 flex justify-end">
              <button
                onClick={() => handleResolveSingle("remote")}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all ${
                  fileResolution === "remote"
                    ? "bg-[#38bdf8] text-[#0d1117]"
                    : "bg-[#21262d] text-[#8b949e] hover:text-[#f0f6fc]"
                }`}
              >
                <Check className="w-3.5 h-3.5" />
                <span>Keep Cloud Version</span>
              </button>
            </div>
          </div>
        )}

        {/* Result Preview Card */}
        <div className="rounded-2xl bg-[#181c22] border border-[#30363d] p-3.5 shadow-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <h4 className="font-headline text-xs font-semibold text-[#f0f6fc]">
                Resolved Preview
              </h4>
            </div>
            <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400">
              {fileResolution === "local" ? "Using Local" : "Using Remote"}
            </span>
          </div>
          <pre className="mt-2.5 bg-[#0d1117] border border-[#21262d] rounded-xl p-3 font-mono text-xs text-[#f0f6fc] overflow-x-auto whitespace-pre-wrap leading-relaxed max-h-36">
            {fileResolution === "local"
              ? currentConflict.local_content
              : currentConflict.remote_content}
          </pre>
        </div>
      </div>

      {/* Sticky Bottom Mobile Action Dock */}
      <div className="fixed bottom-0 left-0 right-0 p-3 bg-[#10141a]/95 backdrop-blur-xl border-t border-[#30363d] z-50">
        <div className="max-w-md mx-auto space-y-2">
          {/* Quick Batch Select Pills */}
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={() => handleResolveAll("local")}
              className="flex-1 py-1.5 px-3 rounded-full bg-[#1c2026] hover:bg-[#262a31] text-[#8b949e] hover:text-[#f0f6fc] text-xs font-medium transition-colors flex items-center justify-center gap-1 cursor-pointer active:scale-95 border border-[#30363d]"
            >
              <Smartphone className="w-3 h-3 text-[#fbbf24]" />
              <span>Keep All Mine</span>
            </button>
            <button
              onClick={() => handleResolveAll("remote")}
              className="flex-1 py-1.5 px-3 rounded-full bg-[#1c2026] hover:bg-[#262a31] text-[#8b949e] hover:text-[#f0f6fc] text-xs font-medium transition-colors flex items-center justify-center gap-1 cursor-pointer active:scale-95 border border-[#30363d]"
            >
              <Cloud className="w-3 h-3 text-[#38bdf8]" />
              <span>Keep All Cloud</span>
            </button>
          </div>

          {/* Primary Apply CTA */}
          <button
            onClick={handleApply}
            className="w-full py-2.5 px-4 rounded-full bg-emerald-500 hover:bg-emerald-400 text-[#0d1117] font-headline text-xs font-bold flex items-center justify-center gap-2 shadow-lg transition-transform active:scale-98 cursor-pointer"
          >
            <CheckCheck className="w-4 h-4" />
            <span>Save & Apply Resolution</span>
          </button>
        </div>
      </div>
    </div>
  );
};
