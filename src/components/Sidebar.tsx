import { useState, useMemo, useEffect } from "react";
import type { FC, FormEvent, DragEvent } from "react";
import {
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Trash2,
  Edit2,
  FilePlus,
  Check,
  X,
  ChevronRight,
  ChevronDown,
  Settings,
  GripVertical,
  ArrowDownToLine,
  ArrowUpDown,
  Sparkles,
  RotateCcw,
  LayoutDashboard,
  LayoutGrid,
  Pin,
} from "lucide-react";
import { FileStatus, VaultEntry } from "../types/noetic";
import { withoutAssets } from "../utils/assets";
import { ConfirmDialog } from "./dialogs";
import {
  CustomOrderMap,
  SortMode,
  getStoredCustomOrder,
  subscribeCustomOrder,
  saveCustomOrder,
  getStoredSortMode,
  saveSortMode,
  getParentPath,
  getItemName,
  reorderItem,
  renameInCustomOrder,
  sortTreeNodes,
} from "../utils/customOrder";
import { childrenOnBranch } from "../utils/noteHierarchy";
import { useNoteHierarchy } from "../utils/useNoteHierarchy";
import { onRevealInSidebar, recordOpened, togglePin, useQuickAccess } from "../utils/quickAccess";

interface SidebarProps {
  vaultPath?: string;
  files: VaultEntry[];
  fileStatuses: FileStatus[];
  /** Opens the resolver for a note changed in the same place on two devices. */
  onOpenConflict?: (path: string) => void;
  activeFilePath: string | null;
  onSelectFile: (path: string) => void;
  onCreateFile: (name: string) => void;
  onCreateFolder: (path: string) => void;
  onDeleteFile: (path: string) => void;
  onRenameFile: (oldPath: string, newPath: string) => void;
  onOpenSettings: () => void;
  /** Whether this device is linked to the signed-in account's storage. */
  isConnected?: boolean;
}

export interface TreeNode {
  path: string;
  name: string;
  isDirectory: boolean;
  children: TreeNode[];
}

interface CreatingState {
  type: "file" | "folder" | "canvas";
  parentPath: string; // "" for root, or "folder/subfolder"
}

/** Where a note row sits: in its folder, or under a note that links to it. */
interface NoteBranch {
  /** Notes above this row on its branch, so a circle of links isn't drawn forever. */
  ancestors: ReadonlySet<string>;
  /** Shown under a linking note rather than at its own place in the folder. */
  linked: boolean;
}

const fileNode = (path: string): TreeNode => ({ path, name: path.split("/").pop() || path, isDirectory: false, children: [] });
const folderOfPath = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

interface DropIndicator {
  targetPath: string;
  position: "before" | "after" | "inside";
}

// Build hierarchical tree from flat VaultEntry list
export function buildFileTree(entries: VaultEntry[]): TreeNode[] {
  const rootNodes: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();

  for (const entry of entries) {
    const normalizedPath = entry.path.replace(/\\/g, "/");
    const parts = normalizedPath.split("/");
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

// Count total note files within a node
export function countNotes(node: TreeNode): number {
  if (!node.isDirectory) return 1;
  return node.children.reduce((acc, child) => acc + countNotes(child), 0);
}

export const Sidebar: FC<SidebarProps> = ({
  vaultPath = "",
  files,
  fileStatuses,
  onOpenConflict,
  activeFilePath,
  onSelectFile,
  onCreateFile,
  onCreateFolder,
  onDeleteFile,
  onRenameFile,
  onOpenSettings,
  isConnected = false,
}) => {
  const [pendingDelete, setPendingDelete] = useState<{ path: string; title: string; message: string } | null>(null);
  const [creating, setCreating] = useState<CreatingState | null>(null);
  const [creatingValue, setCreatingValue] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // A note can appear in several rows (under each note linking to it); rename only in the one clicked.
  const [renamingRow, setRenamingRow] = useState<string | null>(null);

  // Custom ordering and sort mode state
  const [customOrder, setCustomOrder] = useState<CustomOrderMap>(() =>
    getStoredCustomOrder(vaultPath)
  );
  const [sortMode, setSortMode] = useState<SortMode>(() =>
    getStoredSortMode(vaultPath)
  );
  // The order is also updated outside the sidebar (a note renamed from its heading in the editor).
  useEffect(
    () => subscribeCustomOrder(() => setCustomOrder(getStoredCustomOrder(vaultPath))),
    [vaultPath]
  );
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);

  // Drag and drop state
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

  // The assets folder (uploaded images) is browsed from Settings, not the notes list.
  const noteEntries = useMemo(() => withoutAssets(files), [files]);
  const rawTree = useMemo(() => buildFileTree(noteEntries), [noteEntries]);
  const tree = useMemo(
    () => sortTreeNodes(rawTree, "", sortMode, customOrder),
    [rawTree, sortMode, customOrder]
  );
  // Notes that link to other notes show them nested underneath (see utils/noteHierarchy).
  const hierarchy = useNoteHierarchy(noteEntries);
  const listed = (nodes: TreeNode[]) => nodes.filter((n) => n.isDirectory || !hierarchy.nested.has(n.path));
  // Linked notes start open, like folders; this holds the ones the user has closed.
  const [collapsedNotes, setCollapsedNotes] = useState<Set<string>>(new Set());
  const toggleNoteCollapse = (path: string) =>
    setCollapsedNotes((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleFolderCollapse = (folderPath: string) => {
    // Opening a folder counts as visiting it (for "Recently opened" on the dashboard).
    if (collapsedFolders.has(folderPath)) recordOpened(folderPath, true);
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
      }
      return next;
    });
  };

  // Pins (shown on the dashboard).
  const quickAccess = useQuickAccess();
  const pinned = useMemo(() => new Set(quickAccess.pins.map((p) => p.path)), [quickAccess.pins]);
  const pinButton = (path: string, isFolder: boolean, label: string) => {
    const on = pinned.has(path);
    return (
      <button
        type="button"
        title={on ? `Unpin ${label} from the dashboard` : `Pin ${label} to the dashboard`}
        aria-label={on ? `Unpin ${label} from the dashboard` : `Pin ${label} to the dashboard`}
        aria-pressed={on}
        onClick={(e) => {
          e.stopPropagation();
          togglePin(path, isFolder);
        }}
        className={`p-1 transition-colors ${on ? "text-sky-400 hover:text-sky-300" : "text-zinc-500 hover:text-white"}`}
      >
        <Pin className={`w-3 h-3 ${on ? "fill-current" : ""}`} />
      </button>
    );
  };

  // The dashboard can ask to show a folder here: open it and everything above it, then scroll to it.
  const [flashPath, setFlashPath] = useState<string | null>(null);
  useEffect(
    () =>
      onRevealInSidebar((path) => {
        setCollapsedFolders((prev) => {
          const next = new Set(prev);
          for (let p = path; p; p = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") next.delete(p);
          return next;
        });
        setFlashPath(path);
        requestAnimationFrame(() =>
          document
            .querySelector(`[data-tree-path="${CSS.escape(path)}"]`)
            ?.scrollIntoView({ block: "center", behavior: "smooth" })
        );
        setTimeout(() => setFlashPath((p) => (p === path ? null : p)), 1600);
      }),
    []
  );

  const handleStartCreate = (type: "file" | "folder" | "canvas", parentPath = "") => {
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

  const handleCreateSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!creating || !creatingValue.trim()) {
      setCreating(null);
      setCreatingValue("");
      return;
    }

    const raw = creatingValue.trim();
    if (creating.type === "canvas") {
      const finalName = raw.endsWith(".canvas") ? raw : `${raw}.canvas`;
      const fullPath = creating.parentPath ? `${creating.parentPath}/${finalName}` : finalName;
      onCreateFile(fullPath);
    } else if (creating.type === "file") {
      const finalName = raw.endsWith(".md") || raw.endsWith(".canvas") ? raw : `${raw}.md`;
      const fullPath = creating.parentPath ? `${creating.parentPath}/${finalName}` : finalName;
      onCreateFile(fullPath);
    } else {
      const fullPath = creating.parentPath ? `${creating.parentPath}/${raw}` : raw;
      onCreateFolder(fullPath);
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
    const isCanvas = oldPath.endsWith(".canvas");
    let finalName = clean;
    if (!isDirectory) {
      if (isCanvas && !clean.endsWith(".canvas")) {
        finalName = `${clean}.canvas`;
      } else if (!isCanvas && !clean.endsWith(".md") && !clean.endsWith(".canvas")) {
        finalName = `${clean}.md`;
      }
    }
    const newPath = parent ? `${parent}/${finalName}` : finalName;

    onRenameFile(oldPath, newPath);
    const updated = renameInCustomOrder(customOrder, oldPath, newPath);
    setCustomOrder(updated);
    saveCustomOrder(vaultPath, updated);
    setRenamingPath(null);
  };

  const handleDelete = (path: string, isDirectory: boolean, name: string) => {
    const msg = isDirectory
      ? "The folder and everything inside it will be removed from this device. The deletion reaches your other devices the next time you save."
      : "The file will be removed from this device. The deletion reaches your other devices the next time you save.";
    setPendingDelete({ path, title: isDirectory ? `Delete folder "${name}"?` : `Delete "${name}"?`, message: msg });
  };

  // Drag and drop validation
  const isValidDrop = (source: string | null, targetFolder: string): boolean => {
    if (!source) return false;
    // Cannot drop on itself
    if (source === targetFolder) return false;
    // Current parent of source
    const currentParent = source.includes("/")
      ? source.substring(0, source.lastIndexOf("/"))
      : "";
    if (currentParent === targetFolder) return false;
    // Cannot drop a folder into its own children
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

  // Drag over item to detect before/after/inside
  const handleNodeDragOver = (e: DragEvent<HTMLDivElement>, node: TreeNode) => {
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

  const handleNodeDragLeave = (e: DragEvent<HTMLDivElement>, node: TreeNode) => {
    if (dropIndicator?.targetPath === node.path && !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropIndicator(null);
    }
  };

  const handleNodeDrop = (
    e: DragEvent<HTMLDivElement>,
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

  // Status lookup for badges
  const getFileBadge = (relPath: string) => {
    const status = fileStatuses.find(
      (s) => s.path === relPath || s.path.endsWith(relPath) || relPath.endsWith(s.path)
    );
    if (!status) return null;

    if (status.conflict) {
      return (
        <span
          role="button"
          tabIndex={0}
          title="Changed here and on another device. Click to choose a version."
          onClick={(e) => {
            e.stopPropagation();
            onOpenConflict?.(status.path);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onOpenConflict?.(status.path);
            }
          }}
          className="cursor-pointer text-orange-400 font-semibold text-[10px] leading-tight bg-orange-500/15 border border-orange-500/40 px-1.5 py-0.5 rounded font-mono hover:bg-orange-500/25"
        >
          ! Conflict
        </span>
      );
    }
    if (status.update_waiting) {
      return (
        <span
          title="Updated on another device. Open the note to see it."
          className="text-sky-400 font-semibold text-[10px] leading-tight bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.5 rounded font-mono"
        >
          ↓ Update
        </span>
      );
    }
    if (status.is_modified) {
      return (
        <span
          title="Edited, not uploaded yet"
          className="text-amber-400 font-semibold text-[10px] leading-tight bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 rounded font-mono"
        >
          M
        </span>
      );
    }
    if (status.is_untracked) {
      return (
        <span
          title="New, not uploaded yet"
          className="text-emerald-400 font-semibold text-[10px] leading-tight bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.5 rounded font-mono"
        >
          + New
        </span>
      );
    }
    if (status.not_uploaded) {
      return (
        <span
          title="Not uploaded yet"
          className="text-amber-400 font-semibold text-[10px] leading-tight bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 rounded font-mono"
        >
          ↑
        </span>
      );
    }
    if (status.has_remote_update) {
      return (
        <span
          title="A newer version is waiting. Sync to get it."
          className="text-sky-400 font-semibold text-[10px] leading-tight bg-sky-500/15 border border-sky-500/30 px-1.5 py-0.5 rounded font-mono"
        >
          ↓ Update
        </span>
      );
    }
    return null;
  };

  // Render an inline create form
  const renderInlineCreateForm = (parentPath: string) => {
    if (!creating || creating.parentPath !== parentPath) return null;

    const isFolder = creating.type === "folder";
    const isCanvas = creating.type === "canvas";
    return (
      <form
        onSubmit={handleCreateSubmit}
        className="my-1 p-1.5 bg-[#161b22] border border-sky-500/40 rounded-md shadow-sm"
      >
        <div className="flex items-center gap-1.5">
          {isFolder ? (
            <Folder className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          ) : isCanvas ? (
            <LayoutGrid className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          ) : (
            <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0" />
          )}
          <input
            type="text"
            autoFocus
            placeholder={
              isFolder
                ? "Folder name..."
                : isCanvas
                ? "Canvas name (e.g. Roadmap)..."
                : "Note name (e.g. Ideas)..."
            }
            value={creatingValue}
            onChange={(e) => setCreatingValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setCreating(null);
                setCreatingValue("");
              }
            }}
            className="w-full text-xs bg-[#0d1117] border border-[#30363d] rounded px-2 py-1 text-white outline-none focus:border-sky-500"
          />
          <button
            type="submit"
            title="Create"
            className="p-1 bg-sky-600 hover:bg-sky-500 text-white rounded text-xs transition-colors shrink-0"
          >
            <Check className="w-3 h-3" />
          </button>
          <button
            type="button"
            title="Cancel"
            onClick={() => {
              setCreating(null);
              setCreatingValue("");
            }}
            className="p-1 hover:bg-[#21262d] text-zinc-400 hover:text-white rounded text-xs transition-colors shrink-0"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </form>
    );
  };

  // Recursive tree node renderer
  const renderTreeNode = (
    node: TreeNode,
    depth = 0,
    siblingNodes: TreeNode[] = tree,
    branch: NoteBranch = { ancestors: new Set(), linked: false }
  ) => {
    const rowKey = [...branch.ancestors, node.path].join("\n");
    const isRenaming = renamingPath === node.path && (node.isDirectory || renamingRow === rowKey);
    const isBeingDragged = draggedPath === node.path;
    // A linked copy of a note isn't a place in the folder, so nothing is dropped next to it.
    const showDropBefore = !branch.linked && dropIndicator?.targetPath === node.path && dropIndicator.position === "before";
    const showDropAfter = !branch.linked && dropIndicator?.targetPath === node.path && dropIndicator.position === "after";
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

          {/* Folder Item Header */}
          <div
            draggable={!isRenaming}
            onDragStart={(e: DragEvent<HTMLDivElement>) => {
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
            onDragOver={(e: DragEvent<HTMLDivElement>) => handleNodeDragOver(e, node)}
            onDragLeave={(e: DragEvent<HTMLDivElement>) => handleNodeDragLeave(e, node)}
            onDrop={(e: DragEvent<HTMLDivElement>) => handleNodeDrop(e, node, siblingNodes)}
            onClick={() => toggleFolderCollapse(node.path)}
            data-tree-path={node.path}
            className={`group flex items-center justify-between px-2 py-1.5 rounded-md text-xs cursor-pointer transition-all ${
              flashPath === node.path ? "ring-2 ring-sky-400/70 bg-sky-500/10 " : ""
            }${
              isDragInside || isDragTarget
                ? "bg-sky-500/25 ring-2 ring-sky-400 text-white shadow-md"
                : isBeingDragged
                ? "opacity-40 border border-dashed border-amber-400"
                : "hover:bg-[#161b22] text-zinc-300"
            }`}
          >
            <div className="flex items-center gap-1.5 overflow-hidden flex-1 mr-1">
              {/* Drag handle */}
              <GripVertical className="w-3 h-3 text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />

              {/* Expand / Collapse toggle */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFolderCollapse(node.path);
                }}
                className="text-zinc-500 hover:text-zinc-200 p-0.5"
              >
                {isCollapsed ? (
                  <ChevronRight className="w-3.5 h-3.5" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5" />
                )}
              </button>

              {/* Folder Icon */}
              {isCollapsed ? (
                <Folder className="w-3.5 h-3.5 text-amber-400/80 shrink-0" />
              ) : (
                <FolderOpen className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              )}

              {/* Folder Name / Rename Input */}
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
                  className="w-full bg-[#0d1117] border border-sky-500 text-white rounded px-1.5 py-0.5 text-xs outline-none"
                />
              ) : (
                <span className="truncate font-medium text-zinc-200">{node.name}</span>
              )}
            </div>

            {/* Folder Actions & Item Count */}
            <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
              {pinned.has(node.path) && <span className="group-hover:hidden">{pinButton(node.path, true, `folder ${node.name}`)}</span>}
              <span className="group-hover:hidden font-mono text-[10px] text-zinc-500 bg-[#21262d] px-1.5 py-0.2 rounded">
                {noteCount}
              </span>

              {/* Quick actions on hover */}
              <div className="hidden group-hover:flex items-center gap-0.5">
                {pinButton(node.path, true, `folder ${node.name}`)}
                <button
                  title="New Note inside folder"
                  onClick={() => handleStartCreate("file", node.path)}
                  className="p-1 hover:text-sky-400 text-zinc-400 transition-colors"
                >
                  <FilePlus className="w-3 h-3" />
                </button>
                <button
                  title="New Subfolder inside folder"
                  onClick={() => handleStartCreate("folder", node.path)}
                  className="p-1 hover:text-amber-400 text-zinc-400 transition-colors"
                >
                  <FolderPlus className="w-3 h-3" />
                </button>
                <button
                  title="Rename folder"
                  onClick={() => {
                    setRenamingPath(node.path);
                    setRenameValue(node.name);
                  }}
                  className="p-1 hover:text-white text-zinc-400 transition-colors"
                >
                  <Edit2 className="w-3 h-3" />
                </button>
                <button
                  title="Delete folder"
                  onClick={() => handleDelete(node.path, true, node.name)}
                  className="p-1 hover:text-red-400 text-zinc-400 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>

          {/* Expanded Children & Nested Forms */}
          {!isCollapsed && (
            <div className="pl-3 border-l border-[#21262d] ml-3.5 my-0.5 space-y-0.5">
              {/* Inline create form inside this folder */}
              {renderInlineCreateForm(node.path)}

              {/* Child Nodes */}
              {node.children.length === 0 && (!creating || creating.parentPath !== node.path) ? (
                <div className="py-1 px-2 text-[11px] text-zinc-500 italic flex items-center justify-between">
                  <span>Empty folder</span>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => handleStartCreate("file", node.path)}
                      className="text-sky-400 hover:underline not-italic cursor-pointer"
                    >
                      + note
                    </button>
                  </div>
                </div>
              ) : (
                listed(node.children).map((child) => renderTreeNode(child, depth + 1, node.children))
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

    // File Node (Draggable & Reorderable)
    const isActive = activeFilePath === node.path;
    const badge = getFileBadge(node.path);
    const linkedChildren = childrenOnBranch(hierarchy, node.path, branch.ancestors);
    const notesCollapsed = collapsedNotes.has(node.path);
    const childBranch: NoteBranch = { ancestors: new Set([...branch.ancestors, node.path]), linked: true };
    // A linked note from another folder says where it lives.
    const parentPath = [...branch.ancestors].pop();
    const elsewhere =
      branch.linked && parentPath !== undefined && folderOfPath(parentPath) !== folderOfPath(node.path)
        ? folderOfPath(node.path) || "Top level"
        : null;

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
          onDragStart={(e: DragEvent<HTMLDivElement>) => {
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
          onDragOver={(e: DragEvent<HTMLDivElement>) =>
            // Not a drop target, and not the list behind it either.
            branch.linked ? e.stopPropagation() : handleNodeDragOver(e, node)
          }
          onDragLeave={(e: DragEvent<HTMLDivElement>) => handleNodeDragLeave(e, node)}
          onDrop={(e: DragEvent<HTMLDivElement>) => !branch.linked && handleNodeDrop(e, node, siblingNodes)}
          onClick={() => !isRenaming && onSelectFile(node.path)}
          className={`group flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs cursor-pointer transition-all ${
            isBeingDragged
              ? "opacity-40 border border-dashed border-sky-400"
              : isActive
              ? "bg-[#1c2026] text-white border-l-2 border-sky-400 pl-2 shadow-sm font-medium"
              : "text-zinc-400 hover:bg-[#161b22] hover:text-zinc-200"
          }`}
        >
          <div className="flex items-center gap-1.5 overflow-hidden flex-1 mr-2">
            {/* Drag handle */}
            <GripVertical className="w-3 h-3 text-zinc-600 hover:text-zinc-400 cursor-grab active:cursor-grabbing shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />

            {/* Open / close the notes this one links to */}
            {linkedChildren.length > 0 && (
              <button
                type="button"
                title={notesCollapsed ? "Show linked notes" : "Hide linked notes"}
                aria-label={notesCollapsed ? "Show linked notes" : "Hide linked notes"}
                aria-expanded={!notesCollapsed}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleNoteCollapse(node.path);
                }}
                className="text-zinc-500 hover:text-zinc-200 p-0.5 -ml-1"
              >
                {notesCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>
            )}

            {node.name.endsWith(".canvas") ? (
              <LayoutGrid
                className={`w-3.5 h-3.5 shrink-0 ${
                  isActive ? "text-purple-400" : "text-purple-400/80 group-hover:text-purple-300"
                }`}
              />
            ) : (
              <FileText
                className={`w-3.5 h-3.5 shrink-0 ${
                  isActive ? "text-sky-400" : "text-zinc-500 group-hover:text-zinc-400"
                }`}
              />
            )}

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
                className="w-full bg-[#0d1117] border border-sky-500 text-white rounded px-1.5 py-0.5 text-xs outline-none"
              />
            ) : (
              <span className="truncate">{node.name}</span>
            )}
            {elsewhere && (
              <span className="truncate shrink-[2] text-[10px] text-zinc-600" title={`In ${elsewhere}`}>
                {elsewhere}
              </span>
            )}
          </div>

          {/* Badges & Actions */}
          <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
            {/* Sync status badge */}
            {badge}

            {pinned.has(node.path) && <span className="group-hover:hidden">{pinButton(node.path, false, node.name)}</span>}

            {/* Quick action buttons on hover */}
            <div className="hidden group-hover:flex items-center gap-0.5">
              {pinButton(node.path, false, node.name)}
              <button
                title="Rename note"
                onClick={() => {
                  setRenamingPath(node.path);
                  setRenamingRow(rowKey);
                  setRenameValue(node.name);
                }}
                className="p-1 hover:text-white text-zinc-500 transition-colors"
              >
                <Edit2 className="w-3 h-3" />
              </button>
              <button
                title="Delete note"
                onClick={() => handleDelete(node.path, false, node.name)}
                className="p-1 hover:text-red-400 text-zinc-500 transition-colors"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>

        {/* Notes this one links to */}
        {linkedChildren.length > 0 && !notesCollapsed && (
          <div className="pl-3 border-l border-[#21262d] border-dashed ml-3.5 my-0.5 space-y-0.5">
            {linkedChildren.map((child) => renderTreeNode(fileNode(child), depth + 1, [], childBranch))}
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
  };

  return (
    <aside className="w-64 border-r border-[#30363d] bg-[#0d1117] flex flex-col h-full select-none">
      {/* Notes header */}
      <div className="px-3 py-2.5 border-b border-[#21262d] flex items-center justify-between relative">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 font-mono truncate">
            Notes
          </span>
          <span
            className="bg-[#21262d] text-zinc-400 font-mono text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0"
            title="Notes and canvases in this workspace"
          >
            {noteEntries.filter((f) => !f.is_directory).length}
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* Sort Order Menu Button */}
          <button
            id="btn-sidebar-sort"
            onClick={() => setIsSortMenuOpen((prev) => !prev)}
            title={`Sort mode: ${sortMode === "custom" ? "Custom Order" : sortMode === "alpha-asc" ? "A to Z" : "Z to A"}`}
            aria-label="Sort options"
            className={`p-1.5 rounded-md transition-all cursor-pointer active:scale-95 ${
              isSortMenuOpen || sortMode === "custom"
                ? "text-sky-400 bg-sky-500/10 border border-sky-500/30"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-[#21262d] border border-transparent"
            }`}
          >
            <ArrowUpDown className="w-4 h-4" />
          </button>

          {/* New Folder Icon Button */}
          <button
            id="btn-sidebar-new-folder"
            onClick={() => handleStartCreate("folder", "")}
            title="New Folder"
            aria-label="New Folder"
            className="p-1.5 rounded-md text-zinc-400 hover:text-amber-400 hover:bg-[#21262d] border border-transparent hover:border-[#30363d] transition-all cursor-pointer active:scale-95"
          >
            <FolderPlus className="w-4 h-4" />
          </button>

          {/* New Canvas Icon Button */}
          <button
            id="btn-sidebar-new-canvas"
            onClick={() => handleStartCreate("canvas", "")}
            title="New Canvas Board"
            aria-label="New Canvas Board"
            className="p-1.5 rounded-md text-zinc-400 hover:text-purple-400 hover:bg-[#21262d] border border-transparent hover:border-[#30363d] transition-all cursor-pointer active:scale-95"
          >
            <LayoutGrid className="w-4 h-4" />
          </button>

          {/* New Note / Page Icon Button */}
          <button
            id="btn-sidebar-new-note"
            onClick={() => handleStartCreate("file", "")}
            title="New Note"
            aria-label="New Note"
            className="p-1.5 rounded-md text-zinc-400 hover:text-sky-400 hover:bg-[#21262d] border border-transparent hover:border-[#30363d] transition-all cursor-pointer active:scale-95"
          >
            <FilePlus className="w-4 h-4" />
          </button>
        </div>

        {/* Sort Dropdown Popup */}
        {isSortMenuOpen && (
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setIsSortMenuOpen(false)}
            />
            <div className="absolute right-2 top-full mt-1 w-52 bg-[#161b22] border border-[#30363d] rounded-xl shadow-2xl py-1 z-50 text-xs animate-in fade-in zoom-in-95 duration-100">
              <div className="px-3 py-1.5 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider border-b border-[#21262d]">
                Sort Order
              </div>
              <button
                onClick={() => {
                  setSortMode("custom");
                  saveSortMode(vaultPath, "custom");
                  setIsSortMenuOpen(false);
                }}
                className={`w-full px-3 py-1.5 flex items-center justify-between text-left hover:bg-[#21262d] cursor-pointer ${
                  sortMode === "custom" ? "text-sky-400 font-medium bg-sky-500/10" : "text-zinc-300"
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
                className={`w-full px-3 py-1.5 flex items-center justify-between text-left hover:bg-[#21262d] cursor-pointer ${
                  sortMode === "alpha-asc" ? "text-sky-400 font-medium bg-sky-500/10" : "text-zinc-300"
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
                className={`w-full px-3 py-1.5 flex items-center justify-between text-left hover:bg-[#21262d] cursor-pointer ${
                  sortMode === "alpha-desc" ? "text-sky-400 font-medium bg-sky-500/10" : "text-zinc-300"
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
                className="w-full px-3 py-1.5 flex items-center gap-2 text-left text-zinc-400 hover:text-amber-400 hover:bg-[#21262d] cursor-pointer"
              >
                <RotateCcw className="w-3 h-3 text-zinc-500" />
                <span>Reset Custom Order</span>
              </button>
            </div>
          </>
        )}
      </div>

      {/* Dashboard Item */}
      <div className="px-2 pt-2 pb-1 border-b border-[#21262d]">
        <button
          type="button"
          onClick={() => onSelectFile("")}
          className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all cursor-pointer ${
            !activeFilePath
              ? "bg-sky-500/15 text-sky-300 border border-sky-500/30 shadow-sm"
              : "text-zinc-400 hover:bg-[#161b22] hover:text-zinc-200 border border-transparent"
          }`}
          title="Open dashboard"
        >
          <LayoutDashboard className={`w-3.5 h-3.5 ${!activeFilePath ? "text-sky-400" : "text-zinc-500"}`} />
          <span>Dashboard</span>
        </button>
      </div>

      {/* Root Inline Create Form */}
      {creating && creating.parentPath === "" && (
        <div className="p-2 border-b border-[#21262d] bg-[#161b22]">
          {renderInlineCreateForm("")}
        </div>
      )}

      {/* File & Folder Tree with Drag and Drop */}
      <div
        onDragOver={(e) => {
          if (draggedPath && isValidDrop(draggedPath, "")) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDragEnter={(e) => {
          if (draggedPath && isValidDrop(draggedPath, "")) {
            e.preventDefault();
            setDragOverTarget("root");
          }
        }}
        onDragLeave={() => {
          if (dragOverTarget === "root") setDragOverTarget(null);
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
        className={`flex-1 overflow-y-auto py-2 px-2 space-y-0.5 transition-colors ${
          dragOverTarget === "root" ? "bg-sky-500/10 ring-1 ring-sky-500/30 rounded-lg" : ""
        }`}
      >
        {tree.length === 0 && !creating ? (
          <div className="px-4 py-8 text-center text-zinc-500 text-xs">
            No notes yet. Click + Note or + Folder to get started.
          </div>
        ) : (
          listed(tree).map((node) => renderTreeNode(node, 0, tree))
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
            className={`my-2 p-2 rounded-lg border-2 border-dashed flex items-center justify-center gap-1.5 text-xs font-medium transition-all ${
              dragOverTarget === "root"
                ? "border-sky-400 bg-sky-500/20 text-sky-300 ring-2 ring-sky-500/50"
                : "border-[#30363d] bg-[#161b22]/70 text-zinc-400 hover:border-zinc-500"
            }`}
          >
            <ArrowDownToLine className="w-3.5 h-3.5 text-sky-400" />
            <span>Drop here to move to Root (/)</span>
          </div>
        )}
      </div>


      {/* Settings / Account Button at Bottom of Sidebar */}
      <div className="p-2 border-t border-[#21262d] bg-[#161b22]">
        <button
          id="btn-sidebar-settings"
          onClick={onOpenSettings}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-medium text-zinc-300 hover:text-white hover:bg-[#21262d] border border-transparent hover:border-[#30363d] transition-all cursor-pointer group"
          title="Account & settings"
        >
          <div className="flex items-center gap-2.5">
            <Settings className="w-4 h-4 text-zinc-400 group-hover:text-sky-400 transition-colors" />
            <span className="font-medium whitespace-nowrap">Settings</span>
          </div>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded font-mono font-medium flex items-center gap-1 whitespace-nowrap shrink-0 ${
              isConnected ? "bg-emerald-500/10 text-emerald-400" : "bg-[#21262d] text-zinc-400"
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-emerald-400" : "bg-zinc-500"}`}></span>
            {isConnected ? "Connected" : "Local only"}
          </span>
        </button>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete?.title ?? ""}
        message={pendingDelete?.message ?? ""}
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDelete) onDeleteFile(pendingDelete.path);
          setPendingDelete(null);
        }}
        onClose={() => setPendingDelete(null)}
      />
    </aside>
  );
};
