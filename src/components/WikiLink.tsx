import React, { FC, useSyncExternalStore } from "react";
import { vaultIndex } from "../utils/wikilinks/vaultIndex";
import { FilePlus, Hash } from "lucide-react";

export interface WikiLinkProps {
  target: string;
  header?: string;
  alias?: string;
  sourcePath?: string;
  onNavigate?: (filePath: string, header?: string) => void;
  onCreate?: (newFilePath: string) => void;
  className?: string;
}

export const WikiLink: FC<WikiLinkProps> = ({
  target,
  header,
  alias,
  sourcePath,
  onNavigate,
  onCreate,
  className = "",
}) => {
  // Re-render when files are added, removed, or renamed in vaultIndex
  useSyncExternalStore(
    (onStoreChange) => vaultIndex.subscribe(onStoreChange),
    () => vaultIndex.getAllEntries().length
  );

  const resolved = vaultIndex.resolve(target, sourcePath);
  const isResolved = Boolean(resolved);

  const displayText = alias || (header ? `${target} > ${header}` : target);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isResolved && resolved) {
      onNavigate?.(resolved.path, header);
    } else {
      // Propose creation at target path with .md extension
      const sanitizedName = target.endsWith(".md") ? target : `${target}.md`;
      onCreate?.(sanitizedName);
    }
  };

  if (isResolved && resolved) {
    return (
      <a
        href={`#${resolved.path}`}
        onClick={handleClick}
        title={`Open "${resolved.path}"${header ? ` (Section: ${header})` : ""}`}
        className={`wikilink is-resolved inline-flex items-center gap-1 font-medium text-sky-400 hover:text-sky-300 underline underline-offset-2 decoration-sky-500/40 hover:decoration-sky-300 transition-all cursor-pointer ${className}`}
      >
        <span>{displayText}</span>
        {header && <Hash className="w-3 h-3 text-sky-400/70 inline-block" />}
      </a>
    );
  }

  // Unresolved link (Obsidian ghost link)
  return (
    <a
      href="#"
      onClick={handleClick}
      title={`Note "${target}" does not exist yet. Click to create it.`}
      className={`wikilink is-unresolved inline-flex items-center gap-1 font-medium text-zinc-400 hover:text-amber-300 border-b border-dashed border-zinc-500/80 hover:border-amber-400/80 transition-colors opacity-80 hover:opacity-100 cursor-pointer ${className}`}
    >
      <FilePlus className="w-3 h-3 text-amber-400/90 inline-block shrink-0" />
      <span>{displayText}</span>
    </a>
  );
};
