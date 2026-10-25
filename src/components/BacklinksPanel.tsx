import { useState, FC, useSyncExternalStore } from "react";
import { backlinksGraph } from "../utils/wikilinks/backlinksGraph";
import { vaultIndex } from "../utils/wikilinks/vaultIndex";
import {
  ArrowLeftRight,
  FileText,
  CornerDownRight,
  ArrowDownLeft,
  ArrowUpRight,
  FilePlus,
  Hash,
} from "lucide-react";

interface BacklinksPanelProps {
  currentFilePath: string | null;
  onOpenFile: (filePath: string) => void;
  onCreateFile?: (newFilePath: string) => void;
  className?: string;
}

export const BacklinksPanel: FC<BacklinksPanelProps> = ({
  currentFilePath,
  onOpenFile,
  onCreateFile,
  className = "",
}) => {
  const [activeTab, setActiveTab] = useState<"incoming" | "outgoing">("incoming");

  // Subscribe to graph changes so this panel updates live as notes are edited or saved
  useSyncExternalStore(
    (cb) => backlinksGraph.subscribe(cb),
    () => {
      if (!currentFilePath) return "0-0";
      const inc = backlinksGraph.getBacklinks(currentFilePath).length;
      const out = backlinksGraph.getForwardLinks(currentFilePath).length;
      return `${inc}-${out}`;
    }
  );

  if (!currentFilePath) return null;

  const backlinks = backlinksGraph.getBacklinks(currentFilePath);
  const forwardLinks = backlinksGraph.getForwardLinks(currentFilePath);
  const currentBaseName = currentFilePath.split("/").pop()!.replace(/\.md$/i, "");

  return (
    <div
      className={`backlinks-panel bg-[#0d1117] border-t border-[#21262d] text-zinc-300 text-xs ${className}`}
    >
      {/* Header & Tabs */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#21262d]/60 bg-[#161b22]/30">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setActiveTab("incoming")}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium transition-all cursor-pointer ${
              activeTab === "incoming"
                ? "bg-sky-500/15 text-sky-300 border border-sky-500/30"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-[#21262d]"
            }`}
          >
            <ArrowDownLeft className="w-3.5 h-3.5 text-sky-400" />
            <span>Backlinks (Incoming)</span>
            <span className="px-1.5 py-0.2 bg-[#21262d] text-sky-400 rounded-full text-[10px] font-mono">
              {backlinks.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("outgoing")}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium transition-all cursor-pointer ${
              activeTab === "outgoing"
                ? "bg-indigo-500/15 text-indigo-300 border border-indigo-500/30"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-[#21262d]"
            }`}
          >
            <ArrowUpRight className="w-3.5 h-3.5 text-indigo-400" />
            <span>Outgoing Links</span>
            <span className="px-1.5 py-0.2 bg-[#21262d] text-indigo-400 rounded-full text-[10px] font-mono">
              {forwardLinks.length}
            </span>
          </button>
        </div>

        <span className="text-[11px] text-zinc-500 font-mono hidden sm:inline">
          {currentBaseName}.md
        </span>
      </div>

      {/* Tab 1: Incoming Backlinks */}
      {activeTab === "incoming" && (
        <div className="p-3">
          {backlinks.length === 0 ? (
            <div className="py-3 px-2 text-zinc-500 text-xs flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5 text-zinc-400">
                <ArrowLeftRight className="w-3.5 h-3.5 text-zinc-500" />
                <span>
                  No other notes currently link to <strong className="text-zinc-300 font-mono">[[{currentBaseName}]]</strong>.
                </span>
              </div>
              {forwardLinks.length > 0 && (
                <p className="text-[11px] text-zinc-500">
                  This note contains {forwardLinks.length} outgoing link{forwardLinks.length === 1 ? "" : "s"}. Click the{" "}
                  <button
                    onClick={() => setActiveTab("outgoing")}
                    className="text-indigo-400 hover:underline cursor-pointer font-medium"
                  >
                    Outgoing Links tab
                  </button>{" "}
                  to view them.
                </p>
              )}
            </div>
          ) : (
            <ul className="space-y-2 max-h-48 overflow-y-auto pr-1">
              {backlinks.map((link, idx) => (
                <li
                  key={`${link.sourcePath}-${idx}`}
                  onClick={() => onOpenFile(link.sourcePath)}
                  className="p-2.5 rounded-lg bg-[#161b22] hover:bg-[#21262d] border border-[#30363d]/60 cursor-pointer transition-colors group"
                >
                  <div className="flex items-center justify-between text-xs font-medium text-sky-400 group-hover:text-sky-300 mb-1">
                    <div className="flex items-center gap-1.5 truncate">
                      <FileText className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{link.sourceBaseName}</span>
                    </div>
                    <span className="text-zinc-500 text-[10px] font-mono shrink-0">
                      line {link.lineNumber}
                    </span>
                  </div>
                  <div className="flex items-start gap-1 text-[11px] text-zinc-400 font-mono bg-[#0d1117]/70 px-2 py-1 rounded">
                    <CornerDownRight className="w-3 h-3 text-zinc-500 mt-0.5 shrink-0" />
                    <span className="truncate">{link.contextSnippet}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Tab 2: Outgoing Links */}
      {activeTab === "outgoing" && (
        <div className="p-3">
          {forwardLinks.length === 0 ? (
            <div className="py-3 px-2 text-zinc-500 text-xs">
              No outgoing wikilinks found in this note. Add one using <code className="bg-[#161b22] px-1 py-0.5 rounded text-sky-400 font-mono">[[NoteName]]</code>.
            </div>
          ) : (
            <ul className="space-y-2 max-h-48 overflow-y-auto pr-1">
              {forwardLinks.map((link, idx) => {
                const resolved = vaultIndex.resolve(link.target, currentFilePath);
                const isResolved = Boolean(resolved);

                return (
                  <li
                    key={`${link.target}-${idx}`}
                    onClick={() => {
                      if (isResolved && resolved) {
                        onOpenFile(resolved.path);
                      } else {
                        const targetPath = link.target.endsWith(".md")
                          ? link.target
                          : `${link.target}.md`;
                        onCreateFile?.(targetPath);
                      }
                    }}
                    className="p-2.5 rounded-lg bg-[#161b22] hover:bg-[#21262d] border border-[#30363d]/60 cursor-pointer transition-colors flex items-center justify-between group"
                  >
                    <div className="flex items-center gap-2 truncate">
                      {isResolved ? (
                        <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                      ) : (
                        <FilePlus className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      )}
                      <div className="truncate">
                        <span
                          className={`font-medium ${
                            isResolved
                              ? "text-sky-400 group-hover:text-sky-300"
                              : "text-zinc-400 group-hover:text-amber-300 italic"
                          }`}
                        >
                          {link.displayText}
                        </span>
                        {link.header && (
                          <span className="text-zinc-500 ml-1 text-[11px] font-mono inline-flex items-center gap-0.5">
                            <Hash className="w-2.5 h-2.5 text-sky-400/70" />
                            {link.header}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="shrink-0 ml-2">
                      {isResolved ? (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                          Resolved
                        </span>
                      ) : (
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          + Click to create
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
