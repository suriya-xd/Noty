import type { FC } from "react";
import { FileText, LayoutGrid, X } from "lucide-react";

interface NoteTabsProps {
  tabs: string[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}

const label = (path: string) => (path.split("/").pop() || path).replace(/\.(md|canvas)$/, "");

/** Open notes as tabs above the editor. Shift+click a link in a note to open it in a new tab. */
export const NoteTabs: FC<NoteTabsProps> = ({ tabs, activePath, onSelect, onClose }) => {
  if (tabs.length === 0) return null;

  // Two open notes can share a file name in different folders; show the folder to tell them apart.
  const names = tabs.map(label);
  const isDuplicate = (name: string) => names.filter((n) => n === name).length > 1;

  return (
    <div
      role="tablist"
      aria-label="Open notes"
      className="h-9 shrink-0 flex items-stretch bg-[#0d1117] border-b border-[#21262d] overflow-x-auto select-none"
    >
      {tabs.map((path, i) => {
        const active = path === activePath;
        const name = names[i];
        const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        const Icon = path.endsWith(".canvas") ? LayoutGrid : FileText;
        return (
          <div
            key={path}
            role="tab"
            aria-selected={active}
            tabIndex={0}
            title={path}
            onClick={() => onSelect(path)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(path);
              }
            }}
            // Middle-click closes, as in a browser.
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(path);
              }
            }}
            className={`group relative flex items-center gap-2 pl-3 pr-1.5 min-w-0 max-w-[220px] shrink-0 border-r border-[#21262d] text-xs cursor-pointer transition-colors ${
              active ? "bg-[#161b22] text-white" : "text-zinc-400 hover:text-zinc-200 hover:bg-[#161b22]/60"
            }`}
          >
            {active && <span className="absolute inset-x-0 top-0 h-0.5 bg-sky-400" />}
            <Icon className={`w-3.5 h-3.5 shrink-0 ${path.endsWith(".canvas") ? "text-purple-400" : active ? "text-sky-400" : "text-zinc-500"}`} />
            <span className="truncate">
              {name}
              {isDuplicate(name) && folder && <span className="text-zinc-500"> — {folder}</span>}
            </span>
            <button
              type="button"
              aria-label={`Close ${name}`}
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onClose(path);
              }}
              className={`w-5 h-5 shrink-0 rounded flex items-center justify-center hover:bg-[#30363d] hover:text-white cursor-pointer ${
                active ? "text-zinc-400" : "text-zinc-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              }`}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
