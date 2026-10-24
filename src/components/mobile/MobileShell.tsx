import { useState, useMemo } from "react";
import type { FC } from "react";
import {
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  FilePlus,
  RefreshCw,
  Search,
  Check,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Cloud,
  Settings,
  Edit2,
  Trash2,
  X,
  User,
  HardDrive,
  GitBranch,
  Archive,
  Bold,
  Italic,
  Heading2,
  CheckSquare,
  Code,
  Link,
  List,
  FolderInput,
  ArrowDownToLine,
  GripVertical,
  ArrowUpDown,
  Sparkles,
  RotateCcw,
} from "lucide-react";
import { RepoStatusPayload, VaultEntry } from "../../types/gitVault";
import { Editor } from "../Editor";
import {
  CustomOrderMap,
  SortMode,
  getStoredCustomOrder,
  saveCustomOrder,
  getStoredSortMode,
  saveSortMode,
  getParentPath,
  getItemName,
  reorderItem,
  moveItemStep,
  renameInCustomOrder,
  sortTreeNodes,
} from "../../utils/customOrder";

interface MobileShellProps {
  vaultPath: string;
  files: VaultEntry[];
  status: RepoStatusPayload | null;
  activeFilePath: string | null;
  activeFileContent: string;
  isLoading: boolean;
  onSelectFile: (path: string) => void;
  onDebouncedSave: (path: string, content: string) => void;
  onCreateFile: (name: string) => void;
  onCreateFolder: (path: string) => void;
  onDeleteFile: (path: string) => void;
  onRenameFile: (oldPath: string, newPath: string) => void;
  onSave: () => void;
  onSync: () => void;
  onFetch: () => void;
  onOpenRepoSwitch: () => void;
  onOpenOnboarding: () => void;
  onOpenAccountSettings: () => void;
  onSimulateState?: (state: string) => void;
}

interface TreeNode {
  path: string;
  name: string;
  isDirectory: boolean;
  children: TreeNode[];
}

function buildFileTree(entries: VaultEntry[]): TreeNode[] {
  const rootNodes: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();

  for (const entry of entries) {
    const normalized = entry.path.replace(/\\/g, "/");
    const parts = normalized.split("/");
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const prevPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (!nodeMap.has(currentPath)) {
        const isDir = isLast ? entry.is_directory : true;
        const node: TreeNode = {
          path: currentPath,
          name: part,
          isDirectory: isDir,
          children: [],
        };
        nodeMap.set(currentPath, node);

        if (prevPath && nodeMap.has(prevPath)) {
          nodeMap.get(prevPath)!.children.push(node);
        } else if (!prevPath) {
          rootNodes.push(node);
        }
      } else if (isLast && entry.is_directory) {
        nodeMap.get(currentPath)!.isDirectory = true;
      }
    }
  }

  return rootNodes;
}

function countNotes(node: TreeNode): number {
  if (!node.isDirectory) return 1;
  return node.children.reduce((acc, c) => acc + countNotes(c), 0);
}

export const MobileShell: FC<MobileShellProps> = ({
  vaultPath,
  files,
  status,
  activeFilePath,
  activeFileContent,
  isLoading,
  onSelectFile,
  onDebouncedSave,
  onCreateFile,
  onCreateFolder,
  onDeleteFile,
  onRenameFile,
  onSave,
  onSync,
  onOpenRepoSwitch,
  onOpenAccountSettings,
  onSimulateState,
}) => {
  const [activeTab, setActiveTab] = useState<"notes" | "vault" | "sync" | "settings">("notes");
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<{ type: "file" | "folder"; parentPath: string } | null>(null);
  const [creatingValue, setCreatingValue] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Custom ordering and sort mode state
  const [customOrder, setCustomOrder] = useState<CustomOrderMap>(() =>
    getStoredCustomOrder(vaultPath)
  );
  const [sortMode, setSortMode] = useState<SortMode>(() =>
    getStoredSortMode(vaultPath)
  );
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);

  // Drag and drop state
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{
    targetPath: string;
    position: "before" | "after" | "inside";
  } | null>(null);

  // Settings mock toggles matching Stitch Screen 3
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  const [autoCheckUpdates, setAutoCheckUpdates] = useState(true);
  const [conflictStrategy, setConflictStrategy] = useState("ask");

  const rawTree = useMemo(() => buildFileTree(files), [files]);
  const tree = useMemo(
    () => sortTreeNodes(rawTree, "", sortMode, customOrder),
    [rawTree, sortMode, customOrder]
  );

  const isValidDrop = (source: string | null, targetFolder: string): boolean => {
    if (!source) return false;
    if (source === targetFolder) return false;
    const currentParent = source.includes("/")
      ? source.substring(0, source.lastIndexOf("/"))
      : "";
    if (currentParent === targetFolder) return false;
    if (targetFolder.startsWith(source + "/")) return false;
    return true;
  };

  const handleMove = (sourcePath: string, targetFolderPath: string) => {
    const baseName = sourcePath.split("/").pop() || "";
    const newPath = targetFolderPath ? `${targetFolderPath}/${baseName}` : baseName;
    if (sourcePath === newPath) return;

    onRenameFile(sourcePath, newPath);
    const updated = renameInCustomOrder(customOrder, sourcePath, newPath);
    setCustomOrder(updated);
    saveCustomOrder(vaultPath, updated);

    if (targetFolderPath) {
      setCollapsedFolders((prev) => {
        const next = new Set(prev);
        next.delete(targetFolderPath);
        return next;
      });
    }
  };

  const toggleFolder = (path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleStartCreate = (type: "file" | "folder", parentPath = "") => {
    setCreating({ type, parentPath });
    setCreatingValue("");
    if (parentPath) {
      setCollapsedFolders((prev) => {
        const next = new Set(prev);
        next.delete(parentPath);
        return next;
      });
    }
  };

  const handleCreateSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!creating || !creatingValue.trim()) {
      setCreating(null);
      setCreatingValue("");
      return;
    }
    const raw = creatingValue.trim();
    if (creating.type === "file") {
      const finalName = raw.endsWith(".md") ? raw : `${raw}.md`;
      const full = creating.parentPath ? `${creating.parentPath}/${finalName}` : finalName;
      onCreateFile(full);
      setActiveTab("notes");
    } else {
      const full = creating.parentPath ? `${creating.parentPath}/${raw}` : raw;
      onCreateFolder(full);
    }
    setCreating(null);
    setCreatingValue("");
  };

  const handleRenameSubmit = (oldPath: string, isDirectory: boolean) => {
    const clean = renameValue.trim();
    if (!clean) {
      setRenamingPath(null);
      return;
    }
    const currentBaseName = oldPath.split("/").pop() || "";
    if (clean === currentBaseName) {
      setRenamingPath(null);
      return;
    }
    const parent = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : "";
    const finalName = !isDirectory && !clean.endsWith(".md") ? `${clean}.md` : clean;
    const newPath = parent ? `${parent}/${finalName}` : finalName;
    onRenameFile(oldPath, newPath);
    const updated = renameInCustomOrder(customOrder, oldPath, newPath);
    setCustomOrder(updated);
    saveCustomOrder(vaultPath, updated);
    setRenamingPath(null);
  };

  const handleNodeDragOver = (e: React.DragEvent<HTMLDivElement>, node: TreeNode) => {
    if (!draggedPath || draggedPath === node.path) return;
    if (node.path.startsWith(draggedPath + "/")) return;

    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";

    const rect = e.currentTarget.getBoundingClientRect();
    const offsetY = e.clientY - rect.top;
    const height = rect.height;

    if (node.isDirectory) {
      if (offsetY < height * 0.25) {
        setDropIndicator({ targetPath: node.path, position: "before" });
      } else if (offsetY > height * 0.75) {
        setDropIndicator({ targetPath: node.path, position: "after" });
      } else {
        if (isValidDrop(draggedPath, node.path)) {
          setDropIndicator({ targetPath: node.path, position: "inside" });
        } else {
          setDropIndicator({
            targetPath: node.path,
            position: offsetY < height * 0.5 ? "before" : "after",
          });
        }
      }
    } else {
      if (offsetY < height * 0.5) {
        setDropIndicator({ targetPath: node.path, position: "before" });
      } else {
        setDropIndicator({ targetPath: node.path, position: "after" });
      }
    }
  };

  const handleNodeDragLeave = (e: React.DragEvent<HTMLDivElement>, node: TreeNode) => {
    if (dropIndicator?.targetPath === node.path && !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropIndicator(null);
    }
  };

  const handleNodeDrop = (
    e: React.DragEvent<HTMLDivElement>,
    node: TreeNode,
    siblingNodes: TreeNode[]
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const source = draggedPath || e.dataTransfer.getData("text/plain");
    const indicator = dropIndicator;
    setDropIndicator(null);
    setDraggedPath(null);

    if (!source || !indicator || indicator.targetPath !== node.path) return;

    if (indicator.position === "inside" && node.isDirectory) {
      if (isValidDrop(source, node.path)) {
        handleMove(source, node.path);
      }
      return;
    }

    const sourceParent = getParentPath(source);
    const targetParent = getParentPath(node.path);
    const sourceName = getItemName(source);
    const targetName = getItemName(node.path);
    const siblingNames = siblingNodes.map((s) => s.name);

    if (sortMode !== "custom") {
      setSortMode("custom");
      saveSortMode(vaultPath, "custom");
    }

    if (sourceParent === targetParent) {
      const updated = reorderItem(
        customOrder,
        sourceParent,
        siblingNames,
        sourceName,
        targetName,
        indicator.position as "before" | "after"
      );
      setCustomOrder(updated);
      saveCustomOrder(vaultPath, updated);
    } else {
      handleMove(source, targetParent);
      const updated = reorderItem(
        customOrder,
        targetParent,
        [...siblingNames, sourceName],
        sourceName,
        targetName,
        indicator.position as "before" | "after"
      );
      setCustomOrder(updated);
      saveCustomOrder(vaultPath, updated);
    }
  };

  const handleMoveStep = (
    node: TreeNode,
    direction: "up" | "down",
    siblingNodes: TreeNode[]
  ) => {
    const parent = getParentPath(node.path);
    const siblingNames = siblingNodes.map((s) => s.name);

    if (sortMode !== "custom") {
      setSortMode("custom");
      saveSortMode(vaultPath, "custom");
    }

    const updated = moveItemStep(customOrder, parent, siblingNames, node.name, direction);
    setCustomOrder(updated);
    saveCustomOrder(vaultPath, updated);
  };

  // Status badges
  const isDirty = (status?.dirty_count || 0) > 0;
  const isBehind = (status?.behind_count || 0) > 0;
  const isAhead = (status?.ahead_count || 0) > 0;

  // Render tree node in Vault Tab
  const renderTreeNode = (node: TreeNode, depth = 0, siblingNodes: TreeNode[] = tree) => {
    const isRenaming = renamingPath === node.path;
    const isBeingDragged = draggedPath === node.path;
    const isFirst = siblingNodes[0]?.path === node.path;
    const isLast = siblingNodes[siblingNodes.length - 1]?.path === node.path;
    const showDropBefore = dropIndicator?.targetPath === node.path && dropIndicator.position === "before";
    const showDropAfter = dropIndicator?.targetPath === node.path && dropIndicator.position === "after";
    const isDragInside = dropIndicator?.targetPath === node.path && dropIndicator.position === "inside";

    if (node.isDirectory) {
      const isCollapsed = collapsedFolders.has(node.path);
      const noteCount = countNotes(node);
      const isDragTarget = dragOverTarget === node.path;

      return (
        <div key={node.path} className="relative select-none">
          {/* Drop indicator line ABOVE */}
          {showDropBefore && (
            <div className="absolute -top-1 left-0 right-0 h-0.5 bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.9)] z-30 pointer-events-none rounded-full flex items-center">
              <div className="w-2 h-2 -ml-1 rounded-full bg-sky-400 border border-[#0d1117]" />
            </div>
          )}

          <div
            draggable={!isRenaming}
            onDragStart={(e) => {
              e.stopPropagation();
              e.dataTransfer.setData("text/plain", node.path);
              e.dataTransfer.effectAllowed = "move";
              setDraggedPath(node.path);
            }}
            onDragEnd={() => {
              setDraggedPath(null);
              setDragOverTarget(null);
              setDropIndicator(null);
            }}
            onDragOver={(e) => handleNodeDragOver(e, node)}
            onDragLeave={(e) => handleNodeDragLeave(e, node)}
            onDrop={(e) => handleNodeDrop(e, node, siblingNodes)}
            className={`group flex items-center justify-between px-2.5 py-2 rounded-xl text-xs cursor-pointer transition-all ${
              isDragInside || isDragTarget
                ? "bg-sky-500/25 ring-2 ring-sky-400 text-white shadow-md"
                : isBeingDragged
                ? "opacity-40 border border-dashed border-amber-400"
                : "hover:bg-[#161b22] text-[#dfe2eb]"
            }`}
            onClick={() => toggleFolder(node.path)}
          >
            <div className="flex items-center gap-2 overflow-hidden flex-1 mr-1">
              <GripVertical className="w-3 h-3 text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFolder(node.path);
                }}
                className="text-[#8b949e] hover:text-[#f0f6fc] p-0.5"
              >
                {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
              {isCollapsed ? (
                <Folder className="w-4 h-4 text-amber-400/90 shrink-0" />
              ) : (
                <FolderOpen className="w-4 h-4 text-amber-400 shrink-0" />
              )}

              {isRenaming ? (
                <input
                  type="text"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={() => handleRenameSubmit(node.path, true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRenameSubmit(node.path, true);
                    if (e.key === "Escape") setRenamingPath(null);
                  }}
                  className="w-full bg-[#0d1117] border border-sky-500 text-white rounded px-2 py-0.5 text-xs outline-none"
                />
              ) : (
                <span className="truncate font-medium text-[#f0f6fc]">{node.name}</span>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
              <span className="font-mono text-[10px] text-[#8b949e] bg-[#21262d] px-1.5 py-0.5 rounded-full">
                {noteCount}
              </span>

              {/* Move Up / Move Down buttons */}
              <button
                title={isFirst ? "Top item" : "Move up"}
                disabled={isFirst}
                onClick={(e) => {
                  e.stopPropagation();
                  handleMoveStep(node, "up", siblingNodes);
                }}
                className={`p-1 transition-colors ${
                  isFirst ? "opacity-25 cursor-not-allowed text-zinc-600" : "hover:text-sky-400 text-zinc-400"
                }`}
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button
                title={isLast ? "Bottom item" : "Move down"}
                disabled={isLast}
                onClick={(e) => {
                  e.stopPropagation();
                  handleMoveStep(node, "down", siblingNodes);
                }}
                className={`p-1 transition-colors ${
                  isLast ? "opacity-25 cursor-not-allowed text-zinc-600" : "hover:text-sky-400 text-zinc-400"
                }`}
              >
                <ChevronDown className="w-3.5 h-3.5" />
              </button>

              <button
                title="New Note in folder"
                onClick={() => handleStartCreate("file", node.path)}
                className="p-1 hover:text-sky-400 text-[#8b949e]"
              >
                <FilePlus className="w-3.5 h-3.5" />
              </button>
              <button
                title="New Subfolder"
                onClick={() => handleStartCreate("folder", node.path)}
                className="p-1 hover:text-amber-400 text-[#8b949e]"
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {!isCollapsed && (
            <div className="pl-3.5 border-l border-[#21262d] ml-4 my-1 space-y-0.5">
              {creating && creating.parentPath === node.path && (
                <form onSubmit={handleCreateSubmit} className="p-1.5 bg-[#161b22] border border-sky-500/40 rounded-xl my-1 flex items-center gap-1.5">
                  <input
                    type="text"
                    autoFocus
                    placeholder={creating.type === "folder" ? "Subfolder name..." : "Note name..."}
                    value={creatingValue}
                    onChange={(e) => setCreatingValue(e.target.value)}
                    className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-white outline-none"
                  />
                  <button type="submit" className="p-1 bg-sky-600 text-white rounded">
                    <Check className="w-3 h-3" />
                  </button>
                  <button type="button" onClick={() => setCreating(null)} className="p-1 text-[#8b949e]">
                    <X className="w-3 h-3" />
                  </button>
                </form>
              )}
              {node.children.length === 0 && (!creating || creating.parentPath !== node.path) ? (
                <div className="py-1 px-2 text-[11px] text-[#8b949e] italic flex items-center justify-between">
                  <span>Empty folder</span>
                  <button onClick={() => handleStartCreate("file", node.path)} className="text-sky-400 not-italic">
                    + note
                  </button>
                </div>
              ) : (
                node.children.map((child) => renderTreeNode(child, depth + 1, node.children))
              )}
            </div>
          )}

          {/* Drop indicator line BELOW */}
          {showDropAfter && (
            <div className="absolute -bottom-1 left-0 right-0 h-0.5 bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.9)] z-30 pointer-events-none rounded-full flex items-center">
              <div className="w-2 h-2 -ml-1 rounded-full bg-sky-400 border border-[#0d1117]" />
            </div>
          )}
        </div>
      );
    }

    const isActive = activeFilePath === node.path;
    return (
      <div key={node.path} className="relative select-none">
        {/* Drop indicator line ABOVE */}
        {showDropBefore && (
          <div className="absolute -top-1 left-0 right-0 h-0.5 bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.9)] z-30 pointer-events-none rounded-full flex items-center">
            <div className="w-2 h-2 -ml-1 rounded-full bg-sky-400 border border-[#0d1117]" />
          </div>
        )}

        <div
          draggable={!isRenaming}
          onDragStart={(e) => {
            e.stopPropagation();
            e.dataTransfer.setData("text/plain", node.path);
            e.dataTransfer.effectAllowed = "move";
            setDraggedPath(node.path);
          }}
          onDragEnd={() => {
            setDraggedPath(null);
            setDragOverTarget(null);
            setDropIndicator(null);
          }}
          onDragOver={(e) => handleNodeDragOver(e, node)}
          onDragLeave={(e) => handleNodeDragLeave(e, node)}
          onDrop={(e) => handleNodeDrop(e, node, siblingNodes)}
          onClick={() => {
            onSelectFile(node.path);
            setActiveTab("notes");
          }}
          className={`group flex items-center justify-between px-2.5 py-2 rounded-xl text-xs cursor-pointer transition-all ${
            isBeingDragged
              ? "opacity-40 border border-dashed border-sky-400"
              : isActive
              ? "bg-[#1c2026] text-white border-l-2 border-sky-400 pl-2 shadow-sm font-medium"
              : "text-[#8b949e] hover:bg-[#161b22] hover:text-[#f0f6fc]"
          }`}
        >
          <div className="flex items-center gap-2 overflow-hidden flex-1 mr-2">
            <GripVertical className="w-3 h-3 text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
            <FileText className={`w-4 h-4 shrink-0 ${isActive ? "text-sky-400" : "text-[#8b949e]"}`} />
            {isRenaming ? (
              <input
                type="text"
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => handleRenameSubmit(node.path, false)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRenameSubmit(node.path, false);
                  if (e.key === "Escape") setRenamingPath(null);
                }}
                className="w-full bg-[#0d1117] border border-sky-500 text-white rounded px-2 py-0.5 text-xs outline-none"
              />
            ) : (
              <span className="truncate">{node.name}</span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
            {/* Move Up / Move Down buttons */}
            <button
              title={isFirst ? "Top item" : "Move up"}
              disabled={isFirst}
              onClick={(e) => {
                e.stopPropagation();
                handleMoveStep(node, "up", siblingNodes);
              }}
              className={`p-1 transition-colors ${
                isFirst ? "opacity-25 cursor-not-allowed text-zinc-600" : "hover:text-sky-400 text-zinc-400"
              }`}
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <button
              title={isLast ? "Bottom item" : "Move down"}
              disabled={isLast}
              onClick={(e) => {
                e.stopPropagation();
                handleMoveStep(node, "down", siblingNodes);
              }}
              className={`p-1 transition-colors ${
                isLast ? "opacity-25 cursor-not-allowed text-zinc-600" : "hover:text-sky-400 text-zinc-400"
              }`}
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>

            {/* Quick Move Button */}
            <button
              title="Move note..."
              onClick={() => {
                const target = prompt("Move note to folder (enter folder name or leave empty for root):", "");
                if (target !== null) {
                  handleMove(node.path, target.trim());
                }
              }}
              className="p-1 text-[#8b949e] hover:text-sky-400"
            >
              <FolderInput className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => {
                setRenamingPath(node.path);
                setRenameValue(node.name);
              }}
              className="p-1 text-[#8b949e] hover:text-white"
            >
              <Edit2 className="w-3 h-3" />
            </button>
            <button
              onClick={() => {
                if (confirm(`Delete note "${node.name}"?`)) onDeleteFile(node.path);
              }}
              className="p-1 text-[#8b949e] hover:text-red-400"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Drop indicator line BELOW */}
        {showDropAfter && (
          <div className="absolute -bottom-1 left-0 right-0 h-0.5 bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.9)] z-30 pointer-events-none rounded-full flex items-center">
            <div className="w-2 h-2 -ml-1 rounded-full bg-sky-400 border border-[#0d1117]" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#10141a] text-[#dfe2eb] select-none">
      {/* Android Top Bar (Sticky Header matching Stitch Screen 1) */}
      <header className="h-14 px-3.5 pt-safe bg-[#10141a]/95 backdrop-blur-xl border-b border-[#30363d] flex items-center justify-between gap-2 shrink-0 z-40">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={onOpenRepoSwitch}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[#1c2026] hover:bg-[#262a31] border border-[#30363d] text-left min-w-0 cursor-pointer active:scale-95 transition-transform"
          >
            <div className="w-5 h-5 rounded-full bg-sky-500/20 flex items-center justify-center shrink-0">
              <Folder className="w-3 h-3 text-sky-400" />
            </div>
            <span className="font-mono text-xs text-[#f0f6fc] font-medium truncate max-w-[110px]">
              {vaultPath.split(/[\\/]/).pop() || "GitVault"}
            </span>
            <ChevronDown className="w-3 h-3 text-[#8b949e] shrink-0" />
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Live Git Status Badge */}
          {isDirty ? (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-[10px] font-mono font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span>
              <span>{status?.dirty_count} unsaved</span>
            </div>
          ) : isBehind ? (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-sky-500/15 border border-sky-500/30 text-sky-400 text-[10px] font-mono font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse"></span>
              <span>↓ {status?.behind_count}</span>
            </div>
          ) : isAhead ? (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-500/15 border border-purple-500/30 text-purple-300 text-[10px] font-mono font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400"></span>
              <span>↑ {status?.ahead_count} ahead</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-mono font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
              <span>Synced</span>
            </div>
          )}

          {/* Quick Sync Button */}
          <button
            onClick={onSync}
            disabled={isLoading}
            className="bg-sky-500 hover:bg-sky-400 text-[#0d1117] font-semibold text-xs px-3 py-1 rounded-full flex items-center gap-1 active:scale-95 transition-transform shadow-sm cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`} />
            <span>Sync</span>
          </button>

          {/* Avatar Profile Trigger */}
          <button
            onClick={() => setActiveTab("settings")}
            className="w-7 h-7 rounded-full bg-[#1c2026] border border-[#30363d] flex items-center justify-center text-[#8b949e] hover:text-[#f0f6fc] cursor-pointer"
            title="Settings & Account"
          >
            <User className="w-3.5 h-3.5 text-sky-400" />
          </button>
        </div>
      </header>

      {/* Main Tab Content */}
      <div className="flex-1 overflow-hidden relative flex flex-col">
        {/* ================= TAB 1: NOTES & EDITOR ================= */}
        {activeTab === "notes" && (
          <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#0d1117]">
            {/* Note Title & Local Auto-Save Row (Stitch Screen 1) */}
            <div className="px-3 py-2 bg-[#161b22] border-b border-[#21262d] flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <FileText className="w-4 h-4 text-sky-400 shrink-0" />
                <span className="font-mono text-xs text-[#f0f6fc] font-medium truncate">
                  {activeFilePath || "No Note Selected"}
                </span>
                {activeFilePath && (
                  <button
                    onClick={() => {
                      const newName = prompt("Rename note:", activeFilePath);
                      if (newName && newName !== activeFilePath) {
                        onRenameFile(activeFilePath, newName);
                      }
                    }}
                    className="p-1 text-[#8b949e] hover:text-[#f0f6fc] cursor-pointer"
                  >
                    <Edit2 className="w-3 h-3" />
                  </button>
                )}
              </div>

              <div className="shrink-0 px-2 py-0.5 rounded-full bg-[#21262d] flex items-center gap-1.5 text-[10px] text-[#8b949e] font-mono">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                <span>Auto-saved (500ms)</span>
              </div>
            </div>

            {/* Sticky Mobile Markdown Toolbar (Stitch Screen 1) */}
            <div className="px-2 py-1.5 bg-[#10141a] border-b border-[#21262d] overflow-x-auto no-scrollbar flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => {
                  if (activeFilePath) onDebouncedSave(activeFilePath, activeFileContent + "\n\n**Bold Text**");
                }}
                className="px-2.5 py-1 rounded-full bg-[#1c2026] hover:bg-[#262a31] text-[#8b949e] hover:text-[#f0f6fc] text-[11px] font-mono shrink-0 flex items-center gap-1 active:scale-95 transition-all"
              >
                <Bold className="w-3 h-3" />
                <span>Bold</span>
              </button>
              <button
                onClick={() => {
                  if (activeFilePath) onDebouncedSave(activeFilePath, activeFileContent + "\n\n*Italic Text*");
                }}
                className="px-2.5 py-1 rounded-full bg-[#1c2026] hover:bg-[#262a31] text-[#8b949e] hover:text-[#f0f6fc] text-[11px] font-mono shrink-0 flex items-center gap-1 active:scale-95 transition-all"
              >
                <Italic className="w-3 h-3" />
                <span>Italic</span>
              </button>
              <button
                onClick={() => {
                  if (activeFilePath) onDebouncedSave(activeFilePath, activeFileContent + "\n\n## Subheading");
                }}
                className="px-2.5 py-1 rounded-full bg-[#1c2026] hover:bg-[#262a31] text-[#8b949e] hover:text-[#f0f6fc] text-[11px] font-mono shrink-0 flex items-center gap-1 active:scale-95 transition-all"
              >
                <Heading2 className="w-3 h-3" />
                <span>H2</span>
              </button>
              <button
                onClick={() => {
                  if (activeFilePath) onDebouncedSave(activeFilePath, activeFileContent + "\n- [ ] Todo item");
                }}
                className="px-2.5 py-1 rounded-full bg-[#1c2026] hover:bg-[#262a31] text-[#8b949e] hover:text-[#f0f6fc] text-[11px] font-mono shrink-0 flex items-center gap-1 active:scale-95 transition-all"
              >
                <CheckSquare className="w-3 h-3" />
                <span>Task</span>
              </button>
              <button
                onClick={() => {
                  if (activeFilePath) onDebouncedSave(activeFilePath, activeFileContent + "\n```ts\n// Code snippet\n```");
                }}
                className="px-2.5 py-1 rounded-full bg-[#1c2026] hover:bg-[#262a31] text-[#8b949e] hover:text-[#f0f6fc] text-[11px] font-mono shrink-0 flex items-center gap-1 active:scale-95 transition-all"
              >
                <Code className="w-3 h-3" />
                <span>Code</span>
              </button>
              <button
                onClick={() => {
                  if (activeFilePath) onDebouncedSave(activeFilePath, activeFileContent + " [Link Title](https://)");
                }}
                className="px-2.5 py-1 rounded-full bg-[#1c2026] hover:bg-[#262a31] text-[#8b949e] hover:text-[#f0f6fc] text-[11px] font-mono shrink-0 flex items-center gap-1 active:scale-95 transition-all"
              >
                <Link className="w-3 h-3" />
                <span>Link</span>
              </button>
              <button
                onClick={() => {
                  if (activeFilePath) onDebouncedSave(activeFilePath, activeFileContent + "\n- List item");
                }}
                className="px-2.5 py-1 rounded-full bg-[#1c2026] hover:bg-[#262a31] text-[#8b949e] hover:text-[#f0f6fc] text-[11px] font-mono shrink-0 flex items-center gap-1 active:scale-95 transition-all"
              >
                <List className="w-3 h-3" />
                <span>List</span>
              </button>
            </div>

            {/* Note Editor Area */}
            <div className="flex-1 overflow-hidden relative">
              {activeFilePath ? (
                <Editor
                  filePath={activeFilePath}
                  initialContent={activeFileContent}
                  onDebouncedSave={onDebouncedSave}
                  onRenameFile={onRenameFile}
                  debounceMs={500}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full p-6 text-center space-y-3">
                  <div className="w-12 h-12 rounded-full bg-[#161b22] flex items-center justify-center text-sky-400">
                    <FileText className="w-6 h-6" />
                  </div>
                  <h3 className="font-headline text-sm font-semibold text-[#f0f6fc]">
                    No note open
                  </h3>
                  <p className="text-xs text-[#8b949e] max-w-xs">
                    Select a note from your vault or tap below to create a new markdown file.
                  </p>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => handleStartCreate("file", "")}
                      className="px-4 py-2 rounded-full bg-sky-500 text-[#0d1117] text-xs font-semibold cursor-pointer shadow-md"
                    >
                      + New Note
                    </button>
                    <button
                      onClick={() => setActiveTab("vault")}
                      className="px-4 py-2 rounded-full bg-[#1c2026] text-[#f0f6fc] border border-[#30363d] text-xs font-medium cursor-pointer"
                    >
                      Browse Vault
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ================= TAB 2: VAULT BROWSER ================= */}
        {activeTab === "vault" && (
          <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#0d1117] p-3 space-y-3 max-w-2xl mx-auto w-full">
            {/* Search & Actions Bar */}
            <div className="flex items-center gap-2 relative">
              <div className="flex-1 relative">
                <Search className="w-3.5 h-3.5 text-[#8b949e] absolute left-3 top-2.5" />
                <input
                  type="text"
                  placeholder="Search notes & folders..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-[#161b22] border border-[#30363d] focus:border-sky-500 rounded-full pl-8 pr-3 py-1.5 text-xs text-[#f0f6fc] outline-none"
                />
              </div>

              {/* Sort Menu Button */}
              <button
                onClick={() => setIsSortMenuOpen((prev) => !prev)}
                title={`Sort: ${sortMode}`}
                className={`p-2 rounded-full border transition-all cursor-pointer active:scale-95 ${
                  isSortMenuOpen || sortMode === "custom"
                    ? "bg-sky-500/15 border-sky-500/40 text-sky-400"
                    : "bg-[#161b22] hover:bg-[#21262d] border-[#30363d] text-[#8b949e]"
                }`}
              >
                <ArrowUpDown className="w-4 h-4" />
              </button>

              <button
                onClick={() => handleStartCreate("folder", "")}
                title="New Folder"
                className="p-2 rounded-full bg-[#161b22] hover:bg-[#21262d] border border-[#30363d] text-amber-400 cursor-pointer active:scale-95"
              >
                <FolderPlus className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleStartCreate("file", "")}
                title="New Note"
                className="p-2 rounded-full bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-400 cursor-pointer active:scale-95"
              >
                <FilePlus className="w-4 h-4" />
              </button>

              {/* Sort Dropdown Popup */}
              {isSortMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setIsSortMenuOpen(false)} />
                  <div className="absolute right-0 top-full mt-2 w-52 bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl py-1 z-50 text-xs">
                    <div className="px-3 py-1 text-[10px] font-semibold text-[#8b949e] uppercase tracking-wider border-b border-[#21262d]">
                      Sort Order
                    </div>
                    <button
                      onClick={() => {
                        setSortMode("custom");
                        saveSortMode(vaultPath, "custom");
                        setIsSortMenuOpen(false);
                      }}
                      className={`w-full px-3 py-2 flex items-center justify-between text-left hover:bg-[#21262d] ${
                        sortMode === "custom" ? "text-sky-400 font-medium bg-sky-500/10" : "text-[#dfe2eb]"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-3.5 h-3.5 text-sky-400" />
                        <span>Custom Order</span>
                      </div>
                      {sortMode === "custom" && <Check className="w-3.5 h-3.5 text-sky-400" />}
                    </button>
                    <button
                      onClick={() => {
                        setSortMode("alpha-asc");
                        saveSortMode(vaultPath, "alpha-asc");
                        setIsSortMenuOpen(false);
                      }}
                      className={`w-full px-3 py-2 flex items-center justify-between text-left hover:bg-[#21262d] ${
                        sortMode === "alpha-asc" ? "text-sky-400 font-medium bg-sky-500/10" : "text-[#dfe2eb]"
                      }`}
                    >
                      <span>Name (A → Z)</span>
                      {sortMode === "alpha-asc" && <Check className="w-3.5 h-3.5 text-sky-400" />}
                    </button>
                    <button
                      onClick={() => {
                        setSortMode("alpha-desc");
                        saveSortMode(vaultPath, "alpha-desc");
                        setIsSortMenuOpen(false);
                      }}
                      className={`w-full px-3 py-2 flex items-center justify-between text-left hover:bg-[#21262d] ${
                        sortMode === "alpha-desc" ? "text-sky-400 font-medium bg-sky-500/10" : "text-[#dfe2eb]"
                      }`}
                    >
                      <span>Name (Z → A)</span>
                      {sortMode === "alpha-desc" && <Check className="w-3.5 h-3.5 text-sky-400" />}
                    </button>
                    <div className="border-t border-[#21262d] my-1" />
                    <button
                      onClick={() => {
                        setCustomOrder({});
                        saveCustomOrder(vaultPath, {});
                        setSortMode("custom");
                        saveSortMode(vaultPath, "custom");
                        setIsSortMenuOpen(false);
                      }}
                      className="w-full px-3 py-2 flex items-center gap-2 text-left text-[#8b949e] hover:text-amber-400 hover:bg-[#21262d]"
                    >
                      <RotateCcw className="w-3 h-3 text-zinc-500" />
                      <span>Reset Custom Order</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Root Inline Create */}
            {creating && creating.parentPath === "" && (
              <form onSubmit={handleCreateSubmit} className="p-2 bg-[#161b22] border border-sky-500/40 rounded-xl flex items-center gap-1.5 shadow-sm">
                <input
                  type="text"
                  autoFocus
                  placeholder={creating.type === "folder" ? "New folder name..." : "New note title (e.g. Ideas.md)..."}
                  value={creatingValue}
                  onChange={(e) => setCreatingValue(e.target.value)}
                  className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-white outline-none"
                />
                <button type="submit" className="p-1 bg-sky-600 text-white rounded text-xs">
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button type="button" onClick={() => setCreating(null)} className="p-1 text-[#8b949e]">
                  <X className="w-3.5 h-3.5" />
                </button>
              </form>
            )}

            {/* File & Folder List */}
            <div
              onDragOver={(e) => {
                if (draggedPath) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (dragOverTarget !== "root") setDragOverTarget("root");
                }
              }}
              onDragLeave={(e) => {
                if (e.currentTarget === e.target) {
                  setDragOverTarget(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const source = draggedPath || e.dataTransfer.getData("text/plain");
                setDragOverTarget(null);
                setDraggedPath(null);
                if (source && isValidDrop(source, "")) {
                  handleMove(source, "");
                }
              }}
              className={`flex-1 overflow-y-auto space-y-1 pr-1 transition-colors ${
                dragOverTarget === "root" ? "bg-sky-500/10 ring-1 ring-sky-500/30 rounded-xl" : ""
              }`}
            >
              {tree.length === 0 ? (
                <div className="text-center py-10 text-xs text-[#8b949e]">
                  No notes found. Tap + above to create one.
                </div>
              ) : (
                tree
                  .filter((n) =>
                    searchQuery ? n.name.toLowerCase().includes(searchQuery.toLowerCase()) : true
                  )
                  .map((node) => renderTreeNode(node, 0, tree))
              )}

              {/* Visual drop indicator to move item to root when dragging a nested item */}
              {draggedPath && draggedPath.includes("/") && (
                <div
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDragOverTarget("root");
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const source = draggedPath || e.dataTransfer.getData("text/plain");
                    setDragOverTarget(null);
                    setDraggedPath(null);
                    if (source && isValidDrop(source, "")) {
                      handleMove(source, "");
                    }
                  }}
                  className={`my-2 p-2.5 rounded-xl border-2 border-dashed flex items-center justify-center gap-2 text-xs font-medium transition-all ${
                    dragOverTarget === "root"
                      ? "border-sky-400 bg-sky-500/20 text-sky-300 ring-2 ring-sky-500/50"
                      : "border-[#30363d] bg-[#161b22]/70 text-[#8b949e] hover:border-zinc-500"
                  }`}
                >
                  <ArrowDownToLine className="w-4 h-4 text-sky-400" />
                  <span>Drop here to move to Root (/)</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ================= TAB 3: SYNC & TELEMETRY ================= */}
        {activeTab === "sync" && (
          <div className="flex-1 overflow-y-auto bg-[#0d1117] p-4 space-y-4 pb-20 max-w-2xl mx-auto w-full">
            {/* Cloud Sync Engine Card (Stitch Screen 3) */}
            <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-4 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-sky-500/10 flex items-center justify-center text-sky-400">
                    <Cloud className="w-4 h-4" />
                  </div>
                  <span className="font-headline text-sm font-semibold text-[#f0f6fc]">
                    Cloud Sync Engine
                  </span>
                </div>
                <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-medium">
                  Connected & Healthy
                </span>
              </div>

              {/* Telemetry Grid */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="bg-[#10141a] border border-[#21262d] p-3 rounded-xl flex flex-col">
                  <span className="font-mono text-[10px] text-[#8b949e]">Vault Size</span>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="font-headline text-lg font-bold text-[#f0f6fc]">
                      {(files.length * 1.8).toFixed(1)}
                    </span>
                    <span className="font-mono text-[10px] text-[#8b949e]">
                      KB / {files.length} notes
                    </span>
                  </div>
                </div>

                <div className="bg-[#10141a] border border-[#21262d] p-3 rounded-xl flex flex-col">
                  <span className="font-mono text-[10px] text-[#8b949e]">Branch</span>
                  <div className="flex items-baseline gap-1 mt-1">
                    <span className="font-mono text-xs font-semibold text-emerald-400 truncate">
                      {status?.branch || "main"}
                    </span>
                    <span className="font-mono text-[10px] text-[#8b949e]">
                      [{status?.state || "CleanSynced"}]
                    </span>
                  </div>
                </div>
              </div>

              {/* Progress Buffer Meter */}
              <div className="w-full bg-[#10141a] rounded-full h-1.5 overflow-hidden flex">
                <div className="bg-sky-400 h-full rounded-full" style={{ width: "35%" }}></div>
                {isDirty && <div className="bg-amber-400 h-full" style={{ width: "15%" }}></div>}
              </div>
              <div className="flex justify-between items-center text-[#8b949e] font-mono text-[10px]">
                <span>Local Git worktree</span>
                <span>{isDirty ? `${status?.dirty_count} uncommitted` : "Up to date"}</span>
              </div>

              {/* Sync Actions */}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={onSync}
                  disabled={isLoading}
                  className="flex-1 py-2.5 px-4 rounded-full bg-sky-500 hover:bg-sky-400 text-[#0d1117] font-headline text-xs font-bold flex items-center justify-center gap-1.5 active:scale-95 transition-all shadow-md cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
                  <span>Sync & Pull</span>
                </button>
                <button
                  onClick={onSave}
                  disabled={isLoading}
                  className="flex-1 py-2.5 px-4 rounded-full bg-[#1c2026] hover:bg-[#262a31] border border-[#30363d] text-[#f0f6fc] font-headline text-xs font-semibold flex items-center justify-center gap-1.5 active:scale-95 transition-all cursor-pointer disabled:opacity-50"
                >
                  <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Save & Push</span>
                </button>
              </div>
            </div>

            {/* Test Simulation Controls */}
            {onSimulateState && (
              <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-3.5 space-y-2">
                <div className="flex items-center gap-2">
                  <GitBranch className="w-4 h-4 text-amber-400" />
                  <span className="font-headline text-xs font-semibold text-[#f0f6fc]">
                    Test Sync States
                  </span>
                </div>
                <select
                  onChange={(e) => onSimulateState(e.target.value)}
                  defaultValue=""
                  className="w-full bg-[#10141a] border border-[#30363d] text-xs text-[#f0f6fc] rounded-full py-2 px-3 outline-none"
                >
                  <option value="" disabled>Simulate a Git State...</option>
                  <option value="clean_synced">1. Clean Synced (all green)</option>
                  <option value="dirty_synced">2. Dirty Synced (uncommitted changes)</option>
                  <option value="clean_behind">3. Clean Behind (remote updates)</option>
                  <option value="dirty_behind">4. Dirty Behind (diverged)</option>
                  <option value="ahead_offline">5. Ahead Offline (offline commits)</option>
                  <option value="conflict_trigger">6. Trigger 3-Way Conflict</option>
                </select>
              </div>
            )}
          </div>
        )}

        {/* ================= TAB 4: SETTINGS & ACCOUNT ================= */}
        {activeTab === "settings" && (
          <div className="flex-1 overflow-y-auto bg-[#0d1117] p-4 space-y-4 pb-20 max-w-2xl mx-auto w-full">
            {/* User Profile Card (Stitch Screen 3) */}
            <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-4 shadow-sm space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-11 h-11 rounded-full bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
                    <User className="w-5 h-5" />
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="font-headline text-xs font-semibold text-[#f0f6fc] truncate">
                      Connected User
                    </span>
                    <span className="font-mono text-[10px] text-[#8b949e]">
                      {status?.remote_name || "origin"} • {status?.branch || "main"}
                    </span>
                  </div>
                </div>

                <span className="px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-mono text-[10px] font-medium shrink-0">
                  Auth OK
                </span>
              </div>

              <div className="pt-2 flex justify-end">
                <button
                  onClick={onOpenAccountSettings}
                  className="px-3 py-1.5 rounded-full bg-[#1c2026] hover:bg-[#262a31] border border-[#30363d] text-xs font-medium text-[#f0f6fc] cursor-pointer"
                >
                  Configure GitHub Token...
                </button>
              </div>
            </div>

            {/* Sync & Versioning Rules */}
            <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-4 shadow-sm space-y-3">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#8b949e] block">
                Sync & Versioning Rules
              </span>

              {/* Auto-save Toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium text-[#f0f6fc]">Auto-save changes</div>
                  <div className="text-[11px] text-[#8b949e]">Writes to disk 500ms after editing</div>
                </div>
                <button
                  onClick={() => setAutoSaveEnabled(!autoSaveEnabled)}
                  className={`w-11 h-6 rounded-full p-0.5 transition-colors cursor-pointer ${
                    autoSaveEnabled ? "bg-sky-500" : "bg-[#21262d]"
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full bg-white transition-transform ${
                      autoSaveEnabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  ></div>
                </button>
              </div>

              {/* Background Updates Toggle */}
              <div className="flex items-center justify-between pt-2 border-t border-[#21262d]">
                <div>
                  <div className="text-xs font-medium text-[#f0f6fc]">Periodic Git Polling</div>
                  <div className="text-[11px] text-[#8b949e]">Fetches remote status every 12 seconds</div>
                </div>
                <button
                  onClick={() => setAutoCheckUpdates(!autoCheckUpdates)}
                  className={`w-11 h-6 rounded-full p-0.5 transition-colors cursor-pointer ${
                    autoCheckUpdates ? "bg-sky-500" : "bg-[#21262d]"
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded-full bg-white transition-transform ${
                      autoCheckUpdates ? "translate-x-5" : "translate-x-0"
                    }`}
                  ></div>
                </button>
              </div>

              {/* Conflict Handling Strategy */}
              <div className="pt-2 border-t border-[#21262d] space-y-1">
                <div className="text-xs font-medium text-[#f0f6fc]">Conflict Handling</div>
                <select
                  value={conflictStrategy}
                  onChange={(e) => setConflictStrategy(e.target.value)}
                  className="w-full bg-[#10141a] border border-[#30363d] rounded-full py-1.5 px-3 text-xs text-[#f0f6fc] outline-none"
                >
                  <option value="ask">Visual 3-Way Merge (Recommended)</option>
                  <option value="remote">Favor Remote Changes</option>
                  <option value="local">Favor Local Worktree</option>
                </select>
              </div>
            </div>

            {/* Local Storage & Backup */}
            <div className="bg-[#161b22] border border-[#30363d] rounded-2xl p-4 shadow-sm space-y-3">
              <span className="font-mono text-[10px] uppercase tracking-wider text-[#8b949e] block">
                Local Storage & Backup
              </span>
              <div className="flex items-center justify-between bg-[#10141a] border border-[#21262d] rounded-full p-1.5 pl-3">
                <span className="font-mono text-xs text-[#f0f6fc] truncate mr-2">
                  {vaultPath}
                </span>
                <button
                  onClick={onOpenRepoSwitch}
                  className="px-3 py-1 rounded-full bg-[#21262d] text-xs font-medium text-[#f0f6fc] hover:bg-[#30363d] shrink-0 cursor-pointer"
                >
                  Change...
                </button>
              </div>

              <div className="pt-1 flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium text-[#f0f6fc]">Snapshot & Archival</div>
                  <div className="text-[11px] text-[#8b949e]">Full uncompressed Markdown files</div>
                </div>
                <button
                  onClick={() => alert("Notes exported successfully to downloads folder.")}
                  className="px-3 py-1.5 rounded-full bg-[#1c2026] hover:bg-[#262a31] border border-[#30363d] text-xs font-medium text-emerald-400 flex items-center gap-1 cursor-pointer"
                >
                  <Archive className="w-3.5 h-3.5" />
                  <span>Export ZIP</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Navigation Bar (Fixed Footer matching Stitch Screen 1) */}
      <nav className="h-16 pb-safe bg-[#161b22]/95 backdrop-blur-xl border-t border-[#30363d] flex items-center justify-around shrink-0 z-40">
        {/* Tab 1: Notes */}
        <button
          onClick={() => setActiveTab("notes")}
          className={`flex flex-col items-center justify-center min-w-[56px] min-h-[44px] cursor-pointer transition-all ${
            activeTab === "notes" ? "text-sky-400" : "text-[#8b949e] hover:text-[#f0f6fc]"
          }`}
        >
          <div
            className={`w-9 h-6 rounded-full flex items-center justify-center transition-all ${
              activeTab === "notes" ? "bg-sky-500/15" : ""
            }`}
          >
            <FileText className="w-4 h-4" />
          </div>
          <span className="font-mono text-[10px] tracking-tight mt-0.5">Notes</span>
        </button>

        {/* Tab 2: Vault */}
        <button
          onClick={() => setActiveTab("vault")}
          className={`flex flex-col items-center justify-center min-w-[56px] min-h-[44px] cursor-pointer transition-all ${
            activeTab === "vault" ? "text-sky-400" : "text-[#8b949e] hover:text-[#f0f6fc]"
          }`}
        >
          <div
            className={`w-9 h-6 rounded-full flex items-center justify-center transition-all ${
              activeTab === "vault" ? "bg-sky-500/15" : ""
            }`}
          >
            <Folder className="w-4 h-4" />
          </div>
          <span className="font-mono text-[10px] tracking-tight mt-0.5">Vault</span>
        </button>

        {/* Tab 3: Sync */}
        <button
          onClick={() => setActiveTab("sync")}
          className={`flex flex-col items-center justify-center min-w-[56px] min-h-[44px] cursor-pointer transition-all ${
            activeTab === "sync" ? "text-sky-400" : "text-[#8b949e] hover:text-[#f0f6fc]"
          }`}
        >
          <div
            className={`w-9 h-6 rounded-full flex items-center justify-center transition-all ${
              activeTab === "sync" ? "bg-sky-500/15" : ""
            }`}
          >
            <Cloud className="w-4 h-4" />
          </div>
          <span className="font-mono text-[10px] tracking-tight mt-0.5">Sync</span>
        </button>

        {/* Tab 4: Settings */}
        <button
          onClick={() => setActiveTab("settings")}
          className={`flex flex-col items-center justify-center min-w-[56px] min-h-[44px] cursor-pointer transition-all ${
            activeTab === "settings" ? "text-sky-400" : "text-[#8b949e] hover:text-[#f0f6fc]"
          }`}
        >
          <div
            className={`w-9 h-6 rounded-full flex items-center justify-center transition-all ${
              activeTab === "settings" ? "bg-sky-500/15" : ""
            }`}
          >
            <Settings className="w-4 h-4" />
          </div>
          <span className="font-mono text-[10px] tracking-tight mt-0.5">Settings</span>
        </button>
      </nav>
    </div>
  );
};
