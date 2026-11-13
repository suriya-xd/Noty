import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FC, ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowLeftRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CloudOff,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Layers,
  Home,
  Image as ImageIcon,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  MoreHorizontal,
  MoreVertical,
  Pencil,
  Plus,
  Redo2,
  RefreshCw,
  Search,
  Trash2,
  Undo2,
  UploadCloud,
  User,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { RepoStatusPayload, VaultEntry } from "../../types/noetic";
import { Editor, FORMAT_BUTTONS } from "../Editor";
import type { EditorHandle, RenameHandler } from "../Editor";
import { CanvasView } from "../canvas/CanvasView";
import { GitHubService } from "../../services/githubService";
import { backlinksGraph } from "../../utils/wikilinks/backlinksGraph";
import {
  CustomOrderMap,
  SortMode,
  getStoredCustomOrder,
  saveCustomOrder,
  getStoredSortMode,
  saveSortMode,
  getParentPath,
  moveItemStep,
  renameInCustomOrder,
  sortTreeNodes,
} from "../../utils/customOrder";
import { ConfirmSheet, Sheet, SheetAction, TextPromptSheet } from "./mobileUi";
import { goBack, pushBackEntry, useBackLayer, useBackNavigation } from "../../utils/backNavigation";
import type { HistoryStatus } from "../editorHistory";

/**
 * How much of the page the on-screen keyboard covers, for browsers that draw the keyboard over
 * the page instead of making the page shorter. (The Android app makes the page shorter itself,
 * see MainActivity.kt, so there this stays 0.) Pinch-zooming also shrinks the visible area, so
 * it's ignored while zoomed.
 */
function useKeyboardOverlap(): number {
  const [overlap, setOverlap] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      setOverlap(Math.abs(vv.scale - 1) < 0.01 && covered > 60 ? Math.round(covered) : 0);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return overlap;
}

/** Releases (takes off the history) every Back entry in a trail. */
function releaseAll(trail: { current: (() => void)[] }) {
  const releases = trail.current;
  trail.current = [];
  releases.forEach((release) => release());
}

interface MobileShellProps {
  vaultPath: string;
  files: VaultEntry[];
  status: RepoStatusPayload | null;
  activeFilePath: string | null;
  activeFileContent: string;
  isLoading: boolean;
  onSelectFile: (path: string) => void;
  onDebouncedSave: (path: string, content: string) => void | Promise<void>;
  onCreateFile: (name: string) => void;
  onCreateFolder: (path: string) => void;
  onDeleteFile: (path: string) => void;
  onRenameFile: RenameHandler;
  onSave: () => void;
  onSync: () => void;
  onFetch: () => void;
  onOpenWorkspaces: () => void;
  onOpenOnboarding: () => void;
  onOpenAccountSettings: () => void;
  onSimulateState?: (state: string) => void;
  onRefreshFiles?: () => Promise<void>;
  onPreviewImage?: (src: string, alt?: string, title?: string) => void;
}

interface TreeNode {
  path: string;
  name: string;
  isDirectory: boolean;
  children: TreeNode[];
}

type Tab = "dashboard" | "notes" | "sync";

function buildFileTree(entries: VaultEntry[]): TreeNode[] {
  const rootNodes: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();

  for (const entry of entries) {
    const parts = entry.path.replace(/\\/g, "/").split("/");
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const prevPath = currentPath;
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];

      const existing = nodeMap.get(currentPath);
      if (!existing) {
        const node: TreeNode = {
          path: currentPath,
          name: parts[i],
          isDirectory: isLast ? entry.is_directory : true,
          children: [],
        };
        nodeMap.set(currentPath, node);
        if (prevPath) nodeMap.get(prevPath)?.children.push(node);
        else rootNodes.push(node);
      } else if (isLast && entry.is_directory) {
        existing.isDirectory = true;
      }
    }
  }
  return rootNodes;
}

function countNotes(node: TreeNode): number {
  if (!node.isDirectory) return 1;
  return node.children.reduce((acc, c) => acc + countNotes(c), 0);
}

const isCanvasPath = (p: string) => p.endsWith(".canvas");
const fileExt = (name: string) => (name.endsWith(".canvas") ? ".canvas" : name.endsWith(".md") ? ".md" : "");
const displayName = (name: string) => name.replace(/\.(md|canvas)$/, "");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------------------
// Sync state → what to tell the user and which single action to offer
// ---------------------------------------------------------------------------
type SyncTone = "ok" | "warn" | "info" | "ahead" | "off";
type SyncAction = "save" | "pull" | "fetch" | "connect";

interface SyncSummary {
  tone: SyncTone;
  chip: string;
  headline: string;
  detail: string;
  action: SyncAction;
  actionLabel: string;
  icon: LucideIcon;
}

function summarizeSync(status: RepoStatusPayload | null): SyncSummary {
  const dirty = status?.dirty_count ?? 0;
  const behind = status?.behind_count ?? 0;
  const ahead = status?.ahead_count ?? 0;

  if (status && !status.remote_url) {
    return {
      tone: "off",
      chip: dirty > 0 ? `${dirty} local` : "Local only",
      headline: "Not signed in",
      detail: "Your notes are saved on this device only. Sign in to back them up and sync across devices.",
      action: "connect",
      actionLabel: "Sign in",
      icon: CloudOff,
    };
  }
  if (behind > 0 && dirty > 0) {
    return {
      tone: "warn",
      chip: `${behind} incoming`,
      headline: "Sync before you save",
      detail: `There ${behind === 1 ? "is" : "are"} ${plural(behind, "update")} from your other devices and you have ${plural(dirty, "unsaved change")}. Sync first; if the same note changed in both places you choose which version to keep.`,
      action: "pull",
      actionLabel: "Sync now",
      icon: AlertTriangle,
    };
  }
  if (behind > 0) {
    return {
      tone: "info",
      chip: `${behind} incoming`,
      headline: `${plural(behind, "update")} available`,
      detail: "Changes from your other devices are waiting. Sync to bring this device up to date.",
      action: "pull",
      actionLabel: "Sync now",
      icon: ArrowDownToLine,
    };
  }
  if (ahead > 0) {
    return {
      tone: "ahead",
      chip: `${ahead} to upload`,
      headline: `${plural(ahead, "save")} waiting to upload`,
      detail: "These were saved while offline. Upload them when you have a connection.",
      action: "save",
      actionLabel: "Upload now",
      icon: ArrowUpFromLine,
    };
  }
  if (dirty > 0) {
    return {
      tone: "warn",
      chip: `${dirty} unsaved`,
      headline: `${plural(dirty, "unsaved change")}`,
      detail: "Edits are on this device but not backed up yet.",
      action: "save",
      actionLabel: "Save",
      icon: UploadCloud,
    };
  }
  return {
    tone: "ok",
    chip: "Synced",
    headline: "Everything is up to date",
    detail: "This device matches your backup.",
    action: "fetch",
    actionLabel: "Check for updates",
    icon: CheckCircle2,
  };
}

const TONE: Record<SyncTone, { text: string; dot: string; chip: string; iconWrap: string }> = {
  ok: {
    text: "text-emerald-400",
    dot: "bg-emerald-400",
    chip: "bg-emerald-500/10 border-emerald-500/30 text-emerald-300",
    iconWrap: "bg-emerald-500/10 text-emerald-400",
  },
  warn: {
    text: "text-amber-400",
    dot: "bg-amber-400",
    chip: "bg-amber-500/10 border-amber-500/30 text-amber-300",
    iconWrap: "bg-amber-500/10 text-amber-400",
  },
  info: {
    text: "text-sky-400",
    dot: "bg-sky-400",
    chip: "bg-sky-500/10 border-sky-500/30 text-sky-300",
    iconWrap: "bg-sky-500/10 text-sky-400",
  },
  ahead: {
    text: "text-purple-300",
    dot: "bg-purple-400",
    chip: "bg-purple-500/10 border-purple-500/30 text-purple-300",
    iconWrap: "bg-purple-500/10 text-purple-300",
  },
  off: {
    text: "text-[#8b949e]",
    dot: "bg-[#6e7681]",
    chip: "bg-[#21262d] border-[#30363d] text-[#c9d1d9]",
    iconWrap: "bg-[#21262d] text-[#8b949e]",
  },
};

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------
const IconButton: FC<{
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  className?: string;
}> = ({ icon: Icon, label, onClick, className = "" }) => (
  <button
    type="button"
    aria-label={label}
    onClick={onClick}
    className={`w-11 h-11 shrink-0 rounded-full flex items-center justify-center text-[#8b949e] active:bg-[#21262d] active:text-[#f0f6fc] transition-colors ${className}`}
  >
    <Icon className="w-5 h-5" />
  </button>
);

const SectionLabel: FC<{ children: ReactNode }> = ({ children }) => (
  <h3 className="px-1 pb-2 text-[13px] font-semibold text-[#8b949e]">{children}</h3>
);

const SettingsRow: FC<{
  icon: LucideIcon;
  label: string;
  value?: string;
  mono?: boolean;
  onClick?: () => void;
}> = ({ icon: Icon, label, value, mono, onClick }) => {
  const body = (
    <>
      <Icon className="w-5 h-5 text-[#8b949e] shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="block text-[15px] text-[#f0f6fc]">{label}</span>
        {value && (
          <span className={`block text-[13px] text-[#8b949e] truncate ${mono ? "font-mono" : ""}`}>{value}</span>
        )}
      </span>
      {onClick && <ChevronRight className="w-4 h-4 text-[#6e7681] shrink-0" />}
    </>
  );
  const cls = "w-full min-h-[60px] px-4 py-2.5 flex items-center gap-3.5 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={`${cls} active:bg-[#1c2128] transition-colors`}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
};

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
  onFetch,
  onOpenWorkspaces,
  onOpenOnboarding,
  onOpenAccountSettings,
  onSimulateState,
  onRefreshFiles,
  onPreviewImage,
}) => {
  const [tab, setTabState] = useState<Tab>("dashboard");
  const [query, setQuery] = useState("");

  // ---- Back navigation -----------------------------------------------------
  // Android's Back returns to the previously visited page instead of closing the app (see
  // utils/backNavigation). Tabs and notes keep a trail of where the user came from.
  useBackNavigation();
  const tabTrail = useRef<(() => void)[]>([]);
  const noteTrail = useRef<(() => void)[]>([]);

  /** Shows a tab. Back returns to the tab before; the dashboard is home, so going there clears that trail. */
  const setTab = (next: Tab) => {
    if (next === tab) return;
    if (next === "dashboard") {
      releaseAll(tabTrail);
    } else {
      const previous = tab;
      const release: () => void = pushBackEntry(() => {
        tabTrail.current = tabTrail.current.filter((r) => r !== release);
        setTabState(previous);
      });
      tabTrail.current.push(release);
    }
    setTabState(next);
  };

  // Back from a note: to the note it was opened from (by a link), else to the page underneath.
  const activePathRef = useRef(activeFilePath);
  activePathRef.current = activeFilePath;
  const openFile = useCallback(
    (path: string) => {
      const previous = activePathRef.current;
      if (previous && path && path !== previous) {
        const release: () => void = pushBackEntry(() => {
          noteTrail.current = noteTrail.current.filter((r) => r !== release);
          onSelectFile(previous);
        });
        noteTrail.current.push(release);
      }
      onSelectFile(path);
    },
    [onSelectFile]
  );
  useBackLayer(!!activeFilePath, () => onSelectFile(""));
  useEffect(() => {
    if (!activeFilePath) releaseAll(noteTrail);
  }, [activeFilePath]);
  /** The editor's back arrow does what the device's Back does. */
  const leaveNote = () => {
    if (!goBack()) onSelectFile("");
  };

  const keyboardOverlap = useKeyboardOverlap();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const [customOrder, setCustomOrder] = useState<CustomOrderMap>(() => getStoredCustomOrder(vaultPath));
  const [sortMode, setSortModeState] = useState<SortMode>(() => getStoredSortMode(vaultPath));

  // Sheets
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [sortSheetOpen, setSortSheetOpen] = useState(false);
  const [editorMenuOpen, setEditorMenuOpen] = useState(false);
  const [itemSheet, setItemSheet] = useState<{ node: TreeNode; siblings: TreeNode[] } | null>(null);
  const [creating, setCreating] = useState<{ type: "note" | "folder" | "canvas"; parent: string } | null>(null);
  const [renaming, setRenaming] = useState<{ path: string; name: string; isDirectory: boolean } | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ path: string; name: string; isDirectory: boolean } | null>(null);

  // Editor screen
  const editorApi = useRef<EditorHandle | null>(null);
  const [saveState, setSaveState] = useState<"synced" | "saving">("synced");
  const handleSaveStatus = useCallback((s: "synced" | "saving") => setSaveState(s), []);
  const [undoState, setUndoState] = useState<HistoryStatus>({ canUndo: false, canRedo: false });

  // Link counts on the dashboard come from the backlinks index, which fills in asynchronously.
  const [, setLinksVersion] = useState(0);
  useEffect(() => backlinksGraph.subscribe(() => setLinksVersion((v) => v + 1)), []);

  const sync = summarizeSync(status);
  const tone = TONE[sync.tone];
  const isSignedOut = !!status && !status.remote_url;
  const workspaceName = status?.branch || (isSignedOut ? "My notes" : "Choose workspace");
  const account = useMemo(() => GitHubService.getStoredGitHubAuth(), [status?.remote_url, tab]);

  const fileStatus = useMemo(() => {
    const map = new Map<string, "modified" | "new" | "incoming">();
    for (const f of status?.files ?? []) {
      if (f.has_remote_update) map.set(f.path, "incoming");
      else if (f.is_untracked) map.set(f.path, "new");
      else if (f.is_modified) map.set(f.path, "modified");
    }
    return map;
  }, [status]);

  const tree = useMemo(() => buildFileTree(files), [files]);
  const sorted = useCallback(
    (nodes: TreeNode[], parent: string) => sortTreeNodes(nodes, parent, sortMode, customOrder),
    [sortMode, customOrder]
  );

  const folders = useMemo(
    () => files.filter((f) => f.is_directory).map((f) => f.path).sort((a, b) => a.localeCompare(b)),
    [files]
  );
  const noteCount = useMemo(() => files.filter((f) => !f.is_directory).length, [files]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return files
      .filter((f) => !f.is_directory && f.path.toLowerCase().includes(q))
      .sort((a, b) => {
        const an = a.name.toLowerCase().includes(q) ? 0 : 1;
        const bn = b.name.toLowerCase().includes(q) ? 0 : 1;
        return an - bn || a.path.localeCompare(b.path);
      });
  }, [files, query]);

  // ---- actions -----------------------------------------------------------
  const setSortMode = (mode: SortMode) => {
    setSortModeState(mode);
    saveSortMode(vaultPath, mode);
  };

  const applyOrder = (next: CustomOrderMap) => {
    setCustomOrder(next);
    saveCustomOrder(vaultPath, next);
  };

  const toggleFolder = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const runSyncAction = (action: SyncAction) => {
    if (action === "save") onSave();
    else if (action === "pull") onSync();
    else if (action === "fetch") onFetch();
    else onOpenOnboarding();
  };

  const submitCreate = (raw: string) => {
    if (!creating) return;
    const prefix = creating.parent ? `${creating.parent}/` : "";
    if (creating.type === "folder") {
      onCreateFolder(`${prefix}${raw}`);
    } else {
      const ext = creating.type === "canvas" ? ".canvas" : ".md";
      onCreateFile(`${prefix}${raw.endsWith(ext) ? raw : raw + ext}`);
    }
    if (creating.parent) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        next.delete(creating.parent);
        return next;
      });
    }
    setCreating(null);
  };

  const submitRename = (raw: string) => {
    if (!renaming) return;
    const ext = renaming.isDirectory ? "" : fileExt(renaming.name) || ".md";
    const finalName = renaming.isDirectory || raw.endsWith(ext) ? raw : raw + ext;
    const parent = getParentPath(renaming.path);
    const newPath = parent ? `${parent}/${finalName}` : finalName;
    if (newPath !== renaming.path) {
      onRenameFile(renaming.path, newPath);
      applyOrder(renameInCustomOrder(customOrder, renaming.path, newPath));
    }
    setRenaming(null);
  };

  const moveTo = (source: string, targetFolder: string) => {
    const base = source.split("/").pop() || "";
    const newPath = targetFolder ? `${targetFolder}/${base}` : base;
    if (newPath !== source) {
      onRenameFile(source, newPath);
      applyOrder(renameInCustomOrder(customOrder, source, newPath));
    }
    setMoving(null);
  };

  const moveStep = (node: TreeNode, siblings: TreeNode[], direction: "up" | "down") => {
    // Reordering starts from what is on screen, so an A→Z list keeps its order apart from the moved item.
    const names = siblings.map((s) => s.name);
    const parent = getParentPath(node.path);
    const base = sortMode === "custom" ? customOrder : { ...customOrder, [parent]: names };
    if (sortMode !== "custom") setSortMode("custom");
    applyOrder(moveItemStep(base, parent, names, node.name, direction));
  };

  // ---- notes list --------------------------------------------------------
  const StatusDot: FC<{ path: string }> = ({ path }) => {
    const s = fileStatus.get(path);
    if (!s) return null;
    const cfg = {
      modified: { cls: "bg-amber-400", label: "Unsaved changes" },
      new: { cls: "bg-emerald-400", label: "New, not backed up yet" },
      incoming: { cls: "bg-sky-400", label: "Update available" },
    }[s];
    return <span role="img" aria-label={cfg.label} className={`w-2 h-2 rounded-full shrink-0 ${cfg.cls}`} />;
  };

  const renderNode = (node: TreeNode, depth: number, siblings: TreeNode[]): ReactNode => {
    const indent = { paddingLeft: 4 + depth * 20 };
    const openMenu = () => setItemSheet({ node, siblings });

    if (node.isDirectory) {
      const isCollapsed = collapsed.has(node.path);
      const children = sorted(node.children, node.path);
      return (
        <li key={node.path}>
          <div className="flex items-center" style={indent}>
            <button
              type="button"
              onClick={() => toggleFolder(node.path)}
              aria-expanded={!isCollapsed}
              className="flex-1 min-w-0 min-h-[52px] flex items-center gap-2.5 pl-2 pr-1 rounded-xl text-left active:bg-[#161b22] transition-colors"
            >
              <ChevronRight
                className={`w-4 h-4 text-[#6e7681] shrink-0 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
              />
              {isCollapsed ? (
                <Folder className="w-5 h-5 text-amber-400/90 shrink-0" />
              ) : (
                <FolderOpen className="w-5 h-5 text-amber-400 shrink-0" />
              )}
              <span className="flex-1 min-w-0 truncate text-[16px] font-medium text-[#f0f6fc]">{node.name}</span>
              <span className="text-[13px] text-[#6e7681] tabular-nums shrink-0">{countNotes(node)}</span>
            </button>
            <IconButton icon={MoreHorizontal} label={`Actions for folder ${node.name}`} onClick={openMenu} />
          </div>
          {!isCollapsed &&
            (children.length === 0 ? (
              <div className="flex items-center min-h-[44px] text-[14px] text-[#6e7681]" style={{ paddingLeft: 56 + depth * 20 }}>
                <span>Empty folder</span>
                <button
                  type="button"
                  onClick={() => setCreating({ type: "note", parent: node.path })}
                  className="ml-2 px-2 h-11 text-sky-400 font-medium active:text-sky-300"
                >
                  Add a note
                </button>
              </div>
            ) : (
              <ul>{children.map((c) => renderNode(c, depth + 1, children))}</ul>
            ))}
        </li>
      );
    }

    const canvas = isCanvasPath(node.name);
    return (
      <li key={node.path} className="flex items-center" style={indent}>
        <button
          type="button"
          onClick={() => openFile(node.path)}
          className="flex-1 min-w-0 min-h-[52px] flex items-center gap-2.5 pl-2 pr-1 rounded-xl text-left active:bg-[#161b22] transition-colors"
        >
          <span className="w-4 shrink-0" />
          {canvas ? (
            <LayoutGrid className="w-5 h-5 text-purple-400 shrink-0" />
          ) : (
            <FileText className="w-5 h-5 text-[#8b949e] shrink-0" />
          )}
          <span className="flex-1 min-w-0 truncate text-[16px] text-[#e6edf3]">{displayName(node.name)}</span>
          <StatusDot path={node.path} />
        </button>
        <IconButton icon={MoreHorizontal} label={`Actions for ${displayName(node.name)}`} onClick={openMenu} />
      </li>
    );
  };

  const rootNodes = sorted(tree, "");
  const sortLabel = sortMode === "custom" ? "Custom order" : sortMode === "alpha-asc" ? "Name A–Z" : "Name Z–A";

  const syncChip = (
    <button
      type="button"
      onClick={() => setTab("sync")}
      aria-label={`Sync status: ${sync.headline}`}
      className={`h-9 px-3 rounded-full border flex items-center gap-2 text-[13px] font-medium shrink-0 ${tone.chip}`}
    >
      {isLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <span className={`w-2 h-2 rounded-full ${tone.dot}`} />}
      <span>{sync.chip}</span>
    </button>
  );

  // ---- dashboard tab -----------------------------------------------------
  const topFolders = rootNodes.filter((n) => n.isDirectory);
  const topFiles = rootNodes.filter((n) => !n.isDirectory);
  const markdownCount = files.filter((f) => !f.is_directory && f.path.endsWith(".md")).length;
  const canvasCount = files.filter((f) => !f.is_directory && isCanvasPath(f.path)).length;
  const hasTopCanvas = topFiles.some((n) => isCanvasPath(n.name));

  const openFolder = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    setQuery("");
    setTab("notes");
  };

  const dashboardTab = (
    <>
      <header className="pt-safe bg-[#0d1117] shrink-0">
        <div className="h-14 pl-4 pr-3 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={account ? onOpenWorkspaces : onOpenOnboarding}
            className="min-w-0 h-11 -ml-2 px-2 rounded-xl flex items-center gap-1.5 active:bg-[#161b22]"
            aria-label={`Workspace ${workspaceName}. Switch workspace`}
          >
            <span className="font-headline text-[22px] font-semibold text-[#f0f6fc] truncate">{workspaceName}</span>
            <ChevronDown className="w-4 h-4 text-[#8b949e] shrink-0 mt-1" />
          </button>
          {syncChip}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-8 space-y-6">
        {/* Workspace at a glance */}
        <section aria-label="Workspace summary" className="grid grid-cols-3 gap-2.5">
          {[
            { value: String(markdownCount), label: markdownCount === 1 ? "Note" : "Notes" },
            { value: String(folders.length), label: folders.length === 1 ? "Folder" : "Folders" },
            canvasCount > 0
              ? { value: String(canvasCount), label: canvasCount === 1 ? "Canvas" : "Canvases" }
              : { value: status?.branch || "None", label: "Workspace", mono: true },
          ].map((stat) => (
            <div key={stat.label} className="rounded-2xl bg-[#161b22] border border-[#21262d] px-3.5 py-3 min-w-0">
              <div
                className={`text-[#f0f6fc] font-semibold truncate ${
                  "mono" in stat ? "font-mono text-[17px] leading-7" : "font-headline text-[22px] leading-7"
                }`}
              >
                {stat.value}
              </div>
              <div className="text-[13px] text-[#8b949e]">{stat.label}</div>
            </div>
          ))}
        </section>

        <section className="flex gap-2.5">
          <button
            type="button"
            onClick={() => setCreating({ type: "note", parent: "" })}
            className="flex-1 h-12 rounded-xl bg-sky-500 text-[#04121d] text-[15px] font-semibold flex items-center justify-center gap-2 active:bg-sky-400"
          >
            <FilePlus className="w-[18px] h-[18px]" />
            <span>New note</span>
          </button>
          <button
            type="button"
            onClick={() => setCreating({ type: "folder", parent: "" })}
            className="flex-1 h-12 rounded-xl bg-[#161b22] border border-[#30363d] text-[#f0f6fc] text-[15px] font-medium flex items-center justify-center gap-2 active:bg-[#21262d]"
          >
            <FolderPlus className="w-[18px] h-[18px] text-amber-400" />
            <span>New folder</span>
          </button>
        </section>

        {rootNodes.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[#30363d] px-5 py-8 text-center text-[15px] text-[#8b949e]">
            This workspace is empty. Create a note to get started.
          </p>
        ) : (
          <>
            {topFolders.length > 0 && (
              <section>
                <SectionLabel>Folders</SectionLabel>
                <ul className="grid grid-cols-2 gap-2.5">
                  {topFolders.map((folder) => {
                    const count = countNotes(folder);
                    return (
                      <li key={folder.path} className="min-w-0">
                        <button
                          type="button"
                          onClick={() => openFolder(folder.path)}
                          className="w-full min-h-[76px] rounded-2xl bg-[#161b22] border border-[#21262d] p-3.5 text-left active:bg-[#1c2128]"
                        >
                          <Folder className="w-5 h-5 text-amber-400" />
                          <span className="block mt-2 text-[15px] font-medium text-[#f0f6fc] truncate">{folder.name}</span>
                          <span className="block text-[13px] text-[#8b949e]">
                            {count === 0 ? "Empty" : plural(count, "item")}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {topFiles.length > 0 && (
              <section>
                <SectionLabel>{hasTopCanvas ? "Notes & canvases" : "Notes"}</SectionLabel>
                <ul className="rounded-2xl bg-[#161b22] border border-[#21262d] divide-y divide-[#21262d] overflow-hidden">
                  {topFiles.map((note) => {
                    const canvas = isCanvasPath(note.name);
                    const incoming = backlinksGraph.getBacklinks(note.path).length;
                    const outgoing = backlinksGraph.getForwardLinks(note.path).length;
                    return (
                      <li key={note.path}>
                        <button
                          type="button"
                          onClick={() => openFile(note.path)}
                          className="w-full min-h-[64px] px-4 py-2.5 flex items-center gap-3 text-left active:bg-[#1c2128]"
                        >
                          {canvas ? (
                            <LayoutGrid className="w-5 h-5 text-purple-400 shrink-0" />
                          ) : (
                            <FileText className="w-5 h-5 text-sky-400 shrink-0" />
                          )}
                          <span className="flex-1 min-w-0">
                            <span className="block truncate text-[16px] text-[#f0f6fc]">{displayName(note.name)}</span>
                            <span className="block text-[13px] text-[#8b949e]">
                              {canvas ? "Canvas" : `${incoming} linking here · ${plural(outgoing, "link")} out`}
                            </span>
                          </span>
                          <StatusDot path={note.path} />
                          <ChevronRight className="w-4 h-4 text-[#6e7681] shrink-0" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <button
              type="button"
              onClick={() => setTab("notes")}
              className="w-full h-12 rounded-xl text-[15px] font-medium text-sky-400 active:bg-[#161b22]"
            >
              Browse all notes
            </button>
          </>
        )}
      </div>
    </>
  );

  const notesTab = (
    <>
      <header className="pt-safe bg-[#0d1117] shrink-0">
        <div className="h-14 pl-4 pr-3 flex items-center justify-between gap-3">
          <h1 className="font-headline text-[22px] font-semibold text-[#f0f6fc]">Notes</h1>
          {syncChip}
        </div>
        <div className="px-4 pb-3">
          <div className="h-11 rounded-xl bg-[#161b22] border border-[#21262d] focus-within:border-sky-500 flex items-center gap-2.5 px-3.5">
            <Search className="w-[18px] h-[18px] text-[#6e7681] shrink-0" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search notes"
              aria-label="Search notes"
              enterKeyHint="search"
              className="flex-1 min-w-0 bg-transparent text-[#f0f6fc] placeholder:text-[#6e7681] outline-none select-text [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
                className="w-11 h-11 -mr-3.5 flex items-center justify-center text-[#8b949e]"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto overscroll-contain px-2 pb-28">
        {query.trim() ? (
          searchResults.length === 0 ? (
            <div className="px-6 pt-16 text-center">
              <p className="text-[16px] text-[#f0f6fc] font-medium">No notes match “{query.trim()}”</p>
              <p className="text-[14px] text-[#8b949e] mt-1.5">Search looks at note names and folder paths.</p>
            </div>
          ) : (
            <ul>
              <li className="px-3 pb-1 text-[13px] text-[#8b949e]">{plural(searchResults.length, "result")}</li>
              {searchResults.map((f) => {
                const parent = getParentPath(f.path);
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      onClick={() => openFile(f.path)}
                      className="w-full min-h-[56px] px-3 rounded-xl flex items-center gap-3 text-left active:bg-[#161b22]"
                    >
                      {isCanvasPath(f.name) ? (
                        <LayoutGrid className="w-5 h-5 text-purple-400 shrink-0" />
                      ) : (
                        <FileText className="w-5 h-5 text-[#8b949e] shrink-0" />
                      )}
                      <span className="flex-1 min-w-0">
                        <span className="block truncate text-[16px] text-[#e6edf3]">{displayName(f.name)}</span>
                        {parent && <span className="block truncate text-[13px] text-[#6e7681]">{parent}</span>}
                      </span>
                      <StatusDot path={f.path} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : rootNodes.length === 0 ? (
          <div className="px-6 pt-20 flex flex-col items-center text-center">
            <div className="w-14 h-14 rounded-2xl bg-[#161b22] border border-[#21262d] flex items-center justify-center">
              <FileText className="w-6 h-6 text-sky-400" />
            </div>
            <p className="font-headline text-[19px] font-semibold text-[#f0f6fc] mt-5">No notes yet</p>
            <p className="text-[15px] text-[#8b949e] mt-1.5 max-w-[260px]">
              Notes are plain Markdown files stored on this device.
            </p>
            <button
              type="button"
              onClick={() => setCreating({ type: "note", parent: "" })}
              className="mt-6 h-12 px-6 rounded-xl bg-sky-500 text-[#04121d] text-[15px] font-semibold active:bg-sky-400"
            >
              Write your first note
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between pl-3 pr-1">
              <span className="text-[13px] text-[#8b949e]">{plural(noteCount, canvasCount > 0 ? "item" : "note")}</span>
              <button
                type="button"
                onClick={() => setSortSheetOpen(true)}
                className="h-11 px-2.5 rounded-lg flex items-center gap-1.5 text-[13px] font-medium text-[#8b949e] active:bg-[#161b22]"
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
                <span>{sortLabel}</span>
              </button>
            </div>
            <ul>{rootNodes.map((n) => renderNode(n, 0, rootNodes))}</ul>
          </>
        )}
      </div>

      <button
        type="button"
        aria-label="Create new"
        onClick={() => setCreateMenuOpen(true)}
        className="absolute right-4 bottom-4 w-14 h-14 rounded-2xl bg-sky-500 text-[#04121d] shadow-lg shadow-black/50 flex items-center justify-center active:scale-95 active:bg-sky-400 transition-transform"
      >
        <Plus className="w-6 h-6" strokeWidth={2.5} />
      </button>
    </>
  );

  // ---- sync tab ----------------------------------------------------------
  const changedFiles = (status?.files ?? []).filter((f) => f.is_modified || f.is_untracked || f.has_remote_update);
  const syncTab = (
    <>
      <header className="pt-safe bg-[#0d1117] shrink-0">
        <div className="h-14 px-4 flex items-center">
          <h1 className="font-headline text-[22px] font-semibold text-[#f0f6fc]">Sync</h1>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 pb-8 space-y-6">
        <section className="rounded-2xl bg-[#161b22] border border-[#21262d] p-5">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${tone.iconWrap}`}>
            <sync.icon className="w-6 h-6" />
          </div>
          <h2 className="font-headline text-[20px] font-semibold text-[#f0f6fc] mt-4">{sync.headline}</h2>
          <p className="text-[15px] leading-relaxed text-[#8b949e] mt-1.5">{sync.detail}</p>
          <button
            type="button"
            disabled={isLoading}
            onClick={() => runSyncAction(sync.action)}
            className={`mt-5 w-full h-12 rounded-xl text-[15px] font-semibold flex items-center justify-center gap-2 disabled:opacity-60 transition-colors ${
              sync.action === "fetch"
                ? "bg-[#21262d] text-[#f0f6fc] active:bg-[#30363d]"
                : "bg-sky-500 text-[#04121d] active:bg-sky-400"
            }`}
          >
            {isLoading && <RefreshCw className="w-4 h-4 animate-spin" />}
            <span>{isLoading ? "Working…" : sync.actionLabel}</span>
          </button>
          {sync.action !== "fetch" && sync.action !== "connect" && (
            <button
              type="button"
              disabled={isLoading}
              onClick={onFetch}
              className="mt-1 w-full h-11 text-[14px] font-medium text-[#8b949e] active:text-[#f0f6fc] disabled:opacity-60"
            >
              Check for updates
            </button>
          )}
        </section>

        {changedFiles.length > 0 && (
          <section>
            <SectionLabel>Changed files</SectionLabel>
            <ul className="rounded-2xl bg-[#161b22] border border-[#21262d] divide-y divide-[#21262d] overflow-hidden">
              {changedFiles.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    onClick={() => openFile(f.path)}
                    className="w-full min-h-[56px] px-4 flex items-center gap-3 text-left active:bg-[#1c2128]"
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-[15px] text-[#e6edf3]">
                        {displayName(f.path.split("/").pop() || f.path)}
                      </span>
                      <span className="block text-[13px] text-[#8b949e]">
                        {f.has_remote_update ? "Update waiting" : f.is_untracked ? "New" : "Edited"}
                      </span>
                    </span>
                    <StatusDot path={f.path} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <SectionLabel>Workspace</SectionLabel>
          <div className="rounded-2xl bg-[#161b22] border border-[#21262d] divide-y divide-[#21262d] overflow-hidden">
            <SettingsRow
              icon={Layers}
              label="Workspace"
              value={workspaceName}
              onClick={account ? onOpenWorkspaces : onOpenOnboarding}
            />
            <SettingsRow icon={Link2} label="Backup" value={isSignedOut ? "Off (not signed in)" : "On"} />
            {status?.last_synced_at && (
              <SettingsRow icon={RefreshCw} label="Last checked" value={status.last_synced_at} />
            )}
          </div>
        </section>

        {import.meta.env.DEV && onSimulateState && (
          <section>
            <SectionLabel>Developer · simulate a sync state</SectionLabel>
            <select
              onChange={(e) => {
                if (e.target.value) onSimulateState(e.target.value);
                e.target.value = "";
              }}
              defaultValue=""
              aria-label="Simulate a sync state"
              className="w-full h-12 rounded-xl bg-[#161b22] border border-dashed border-[#30363d] text-[#c9d1d9] px-3 outline-none"
            >
              <option value="" disabled>
                Choose a state…
              </option>
              <option value="clean_synced">Clean, synced</option>
              <option value="dirty_synced">Unsaved changes</option>
              <option value="clean_behind">Updates waiting</option>
              <option value="dirty_behind">Updates waiting + unsaved changes</option>
              <option value="ahead_offline">Offline saves</option>
              <option value="conflict_trigger">Trigger a conflict</option>
            </select>
          </section>
        )}

        {/* Settings: below the sync features on the same page. */}
        <h2 className="pt-4 border-t border-[#21262d] font-headline text-[18px] font-semibold text-[#f0f6fc]">
          Settings
        </h2>

        <section>
          <SectionLabel>Account</SectionLabel>
          <button
            type="button"
            onClick={account ? onOpenAccountSettings : onOpenOnboarding}
            className="w-full rounded-2xl bg-[#161b22] border border-[#21262d] p-4 flex items-center gap-3.5 text-left active:bg-[#1c2128]"
          >
            {account?.user.avatar_url ? (
              <img src={account.user.avatar_url} alt="" className="w-12 h-12 rounded-full bg-[#21262d] shrink-0" />
            ) : (
              <span className="w-12 h-12 rounded-full bg-[#21262d] flex items-center justify-center shrink-0">
                <User className="w-5 h-5 text-[#8b949e]" />
              </span>
            )}
            <span className="flex-1 min-w-0">
              <span className="block text-[16px] font-medium text-[#f0f6fc] truncate">
                {account ? account.user.name || account.user.login : "Not signed in"}
              </span>
              <span className="block text-[14px] text-[#8b949e] truncate">
                {account ? `@${account.user.login} on GitHub` : "Sign in to back up and sync"}
              </span>
            </span>
            <ChevronRight className="w-4 h-4 text-[#6e7681] shrink-0" />
          </button>
        </section>

        <section>
          <SectionLabel>Notes</SectionLabel>
          <div className="rounded-2xl bg-[#161b22] border border-[#21262d] divide-y divide-[#21262d] overflow-hidden">
            <SettingsRow icon={Folder} label="Location on this device" value={vaultPath} mono />
            <SettingsRow icon={ArrowUpDown} label="Note order" value={sortLabel} onClick={() => setSortSheetOpen(true)} />
          </div>
        </section>

        <section>
          <SectionLabel>How saving works</SectionLabel>
          <p className="rounded-2xl bg-[#161b22] border border-[#21262d] p-4 text-[14px] leading-relaxed text-[#8b949e]">
            Notes save to this device as you type. They are backed up, and reach your other devices, when you
            tap <span className="text-[#e6edf3]">Save</span> at the top of this page.
          </p>
        </section>

        <p className="text-center text-[13px] text-[#6e7681]">Noetic 0.1.0</p>
      </div>
    </>
  );

  // ---- editor screen -----------------------------------------------------
  const activeName = activeFilePath ? activeFilePath.split("/").pop() || activeFilePath : "";
  const activeParent = activeFilePath ? getParentPath(activeFilePath) : "";
  const activeIsCanvas = !!activeFilePath && isCanvasPath(activeFilePath);

  const formatButtons = FORMAT_BUTTONS.filter((b) => b !== "divider");

  const editorScreen = activeFilePath && (
    // Ends where the keyboard begins, so the formatting bar sits right above it (see useKeyboardOverlap).
    <div className="absolute inset-0 z-30 flex flex-col bg-[#0d1117] m-screen-in" style={{ bottom: keyboardOverlap }}>
      <header className="pt-safe bg-[#0d1117] border-b border-[#21262d] shrink-0">
        <div className="h-14 px-1.5 flex items-center gap-0.5">
          <IconButton icon={ArrowLeft} label="Back" onClick={leaveNote} />
          <button
            type="button"
            onClick={() => setRenaming({ path: activeFilePath, name: activeName, isDirectory: false })}
            aria-label={`${displayName(activeName)}. Rename`}
            className="flex-1 min-w-0 h-11 px-2 rounded-xl text-left active:bg-[#161b22]"
          >
            <span className="block truncate text-[16px] font-semibold text-[#f0f6fc] leading-tight">
              {displayName(activeName)}
            </span>
            <span className="block truncate text-[12px] text-[#8b949e] leading-tight mt-0.5" aria-live="polite">
              {activeIsCanvas
                ? activeParent || "Canvas"
                : saveState === "saving"
                ? "Saving…"
                : `Saved on device${activeParent ? ` · ${activeParent}` : ""}`}
            </span>
          </button>
          {!activeIsCanvas &&
            (
              [
                { label: "Undo", icon: Undo2, enabled: undoState.canUndo, run: () => editorApi.current?.undo() },
                { label: "Redo", icon: Redo2, enabled: undoState.canRedo, run: () => editorApi.current?.redo() },
              ] as const
            ).map((b) => (
              <button
                key={b.label}
                type="button"
                aria-label={b.label}
                disabled={!b.enabled}
                // Keep the editor focused (and the keyboard open) while tapping.
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={b.run}
                className="w-11 h-11 shrink-0 rounded-full flex items-center justify-center text-[#c9d1d9] active:bg-[#21262d] active:text-[#f0f6fc] disabled:text-[#484f58] disabled:active:bg-transparent transition-colors"
              >
                <b.icon className="w-5 h-5" />
              </button>
            ))}
          <IconButton icon={MoreVertical} label="Note options" onClick={() => setEditorMenuOpen(true)} />
        </div>
      </header>

      <div className="flex-1 min-h-0 relative overflow-hidden">
        {activeIsCanvas ? (
          <CanvasView
            key={activeFilePath}
            filePath={activeFilePath}
            initialContent={activeFileContent}
            vaultPath={vaultPath}
            vaultFiles={files}
            onDebouncedSave={onDebouncedSave}
            onOpenFile={openFile}
            onRefreshFiles={onRefreshFiles}
            onPreviewImage={onPreviewImage}
            touchMode
          />
        ) : (
          <Editor
            chrome="minimal"
            apiRef={editorApi}
            onSaveStatusChange={handleSaveStatus}
            onHistoryChange={setUndoState}
            filePath={activeFilePath}
            initialContent={activeFileContent}
            onDebouncedSave={onDebouncedSave}
            onRenameFile={onRenameFile}
            onOpenFile={openFile}
            onCreateFile={onCreateFile}
            vaultPath={vaultPath}
            vaultFiles={files}
            onRefreshFiles={onRefreshFiles}
            onPreviewImage={onPreviewImage}
            debounceMs={500}
          />
        )}
      </div>

      {!activeIsCanvas && (
        <div className="shrink-0 bg-[#161b22] border-t border-[#21262d] pb-safe">
          <div role="toolbar" aria-label="Formatting" className="h-12 px-1 flex items-center overflow-x-auto no-scrollbar">
            {formatButtons.map((b) => (
              <button
                key={b.kind}
                type="button"
                aria-label={b.label}
                // Keep the editor focused (and the keyboard open) while tapping toolbar buttons.
                onPointerDown={(e) => e.preventDefault()}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editorApi.current?.format(b.kind)}
                className="min-w-11 h-11 px-1 shrink-0 rounded-lg flex items-center justify-center text-[#c9d1d9] active:bg-[#30363d] active:text-white"
              >
                {b.icon ? <b.icon className="w-5 h-5" /> : <span className="font-mono text-[13px] font-semibold">{b.text}</span>}
              </button>
            ))}
            <button
              type="button"
              aria-label="Insert image"
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editorApi.current?.openInsertImage()}
              className="w-11 h-11 shrink-0 rounded-lg flex items-center justify-center text-[#c9d1d9] active:bg-[#30363d] active:text-white"
            >
              <ImageIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );

  // ---- shell -------------------------------------------------------------
  const tabs: { id: Tab; label: string; icon: LucideIcon }[] = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "notes", label: "Notes", icon: FileText },
    { id: "sync", label: "Sync", icon: RefreshCw },
  ];
  const sheetNode = itemSheet?.node;
  const sheetIndex = itemSheet ? itemSheet.siblings.findIndex((s) => s.path === itemSheet.node.path) : -1;
  const closeItemSheet = () => setItemSheet(null);
  const moveTargets = moving
    ? ["", ...folders].filter(
        (f) => f !== getParentPath(moving) && f !== moving && !f.startsWith(`${moving}/`)
      )
    : [];

  return (
    <div className="m-shell relative flex flex-col h-app w-screen overflow-hidden bg-[#0d1117] text-[#e6edf3] select-none">
      <main className="flex-1 min-h-0 relative flex flex-col">
        {tab === "dashboard" && dashboardTab}
        {tab === "notes" && notesTab}
        {tab === "sync" && syncTab}
      </main>

      <nav aria-label="Primary" className="shrink-0 bg-[#161b22] border-t border-[#21262d] pb-safe">
        <div className="h-16 flex items-stretch">
          {tabs.map((t) => {
            const active = tab === t.id;
            const showBadge = t.id === "sync" && sync.tone !== "ok" && sync.tone !== "off";
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                aria-current={active ? "page" : undefined}
                className={`flex-1 flex flex-col items-center justify-center gap-1 transition-colors ${
                  active ? "text-sky-400" : "text-[#8b949e] active:text-[#f0f6fc]"
                }`}
              >
                <span className={`relative w-14 h-7 rounded-full flex items-center justify-center ${active ? "bg-sky-500/15" : ""}`}>
                  <t.icon className="w-5 h-5" />
                  {showBadge && <span className={`absolute top-0.5 right-3 w-2 h-2 rounded-full ${tone.dot}`} />}
                </span>
                <span className={`text-[12px] ${active ? "font-semibold" : "font-medium"}`}>{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {editorScreen}

      {/* Create menu */}
      <Sheet open={createMenuOpen} onClose={() => setCreateMenuOpen(false)} title="Create">
        <SheetAction
          icon={FilePlus}
          label="Note"
          hint="A Markdown document"
          onClick={() => {
            setCreateMenuOpen(false);
            setCreating({ type: "note", parent: "" });
          }}
        />
        <SheetAction
          icon={FolderPlus}
          label="Folder"
          hint="Group related notes"
          onClick={() => {
            setCreateMenuOpen(false);
            setCreating({ type: "folder", parent: "" });
          }}
        />
        <SheetAction
          icon={LayoutGrid}
          label="Canvas"
          hint="A freeform board of cards and notes"
          onClick={() => {
            setCreateMenuOpen(false);
            setCreating({ type: "canvas", parent: "" });
          }}
        />
      </Sheet>

      {/* Sort order */}
      <Sheet open={sortSheetOpen} onClose={() => setSortSheetOpen(false)} title="Note order">
        {(
          [
            ["custom", "Custom order", "Arrange with Move up / Move down"],
            ["alpha-asc", "Name A–Z", undefined],
            ["alpha-desc", "Name Z–A", undefined],
          ] as const
        ).map(([mode, label, hint]) => (
          <SheetAction
            key={mode}
            icon={sortMode === mode ? Check : ArrowUpDown}
            label={label}
            hint={hint}
            selected={sortMode === mode}
            onClick={() => {
              setSortMode(mode);
              setSortSheetOpen(false);
            }}
          />
        ))}
      </Sheet>

      {/* Row actions */}
      <Sheet
        open={!!sheetNode}
        onClose={closeItemSheet}
        title={sheetNode ? (sheetNode.isDirectory ? sheetNode.name : displayName(sheetNode.name)) : undefined}
        subtitle={sheetNode ? getParentPath(sheetNode.path) || undefined : undefined}
      >
        {sheetNode && itemSheet && (
          <>
            {sheetNode.isDirectory && (
              <>
                <SheetAction
                  icon={FilePlus}
                  label="New note here"
                  onClick={() => {
                    closeItemSheet();
                    setCreating({ type: "note", parent: sheetNode.path });
                  }}
                />
                <SheetAction
                  icon={FolderPlus}
                  label="New folder here"
                  onClick={() => {
                    closeItemSheet();
                    setCreating({ type: "folder", parent: sheetNode.path });
                  }}
                />
              </>
            )}
            <SheetAction
              icon={Pencil}
              label="Rename"
              onClick={() => {
                closeItemSheet();
                setRenaming({ path: sheetNode.path, name: sheetNode.name, isDirectory: sheetNode.isDirectory });
              }}
            />
            <SheetAction
              icon={FolderInput}
              label="Move to folder"
              onClick={() => {
                closeItemSheet();
                setMoving(sheetNode.path);
              }}
            />
            <SheetAction
              icon={ArrowUp}
              label="Move up"
              disabled={sheetIndex <= 0}
              onClick={() => {
                moveStep(sheetNode, itemSheet.siblings, "up");
                closeItemSheet();
              }}
            />
            <SheetAction
              icon={ArrowDown}
              label="Move down"
              disabled={sheetIndex === -1 || sheetIndex >= itemSheet.siblings.length - 1}
              onClick={() => {
                moveStep(sheetNode, itemSheet.siblings, "down");
                closeItemSheet();
              }}
            />
            <SheetAction
              icon={Trash2}
              label="Delete"
              tone="danger"
              onClick={() => {
                closeItemSheet();
                setDeleting({ path: sheetNode.path, name: sheetNode.name, isDirectory: sheetNode.isDirectory });
              }}
            />
          </>
        )}
      </Sheet>

      {/* Editor overflow menu */}
      <Sheet open={editorMenuOpen} onClose={() => setEditorMenuOpen(false)} title={displayName(activeName)}>
        {!activeIsCanvas && (
          <>
            <SheetAction
              icon={ArrowLeftRight}
              label="Links & backlinks"
              hint="Notes this one links to, and notes linking here"
              onClick={() => {
                setEditorMenuOpen(false);
                editorApi.current?.toggleLinks();
              }}
            />
            <SheetAction
              icon={ImageIcon}
              label="Insert image"
              onClick={() => {
                setEditorMenuOpen(false);
                editorApi.current?.openInsertImage();
              }}
            />
          </>
        )}
        <SheetAction
          icon={Pencil}
          label="Rename"
          onClick={() => {
            setEditorMenuOpen(false);
            if (activeFilePath) setRenaming({ path: activeFilePath, name: activeName, isDirectory: false });
          }}
        />
        <SheetAction
          icon={FolderInput}
          label="Move to folder"
          onClick={() => {
            setEditorMenuOpen(false);
            if (activeFilePath) setMoving(activeFilePath);
          }}
        />
        <SheetAction
          icon={Trash2}
          label="Delete"
          tone="danger"
          onClick={() => {
            setEditorMenuOpen(false);
            if (activeFilePath) setDeleting({ path: activeFilePath, name: activeName, isDirectory: false });
          }}
        />
      </Sheet>

      {/* Move destination picker */}
      <Sheet
        open={!!moving}
        onClose={() => setMoving(null)}
        title="Move to"
        subtitle={moving ? displayName(moving.split("/").pop() || moving) : undefined}
      >
        {moveTargets.length === 0 ? (
          <p className="px-3 py-4 text-[15px] text-[#8b949e]">
            There's nowhere else to move this yet. Create a folder first.
          </p>
        ) : (
          moveTargets.map((f) => (
            <SheetAction
              key={f || "/"}
              icon={f ? Folder : Home}
              label={f ? f.split("/").pop() || f : "Top level"}
              hint={f.includes("/") ? getParentPath(f) : undefined}
              onClick={() => moving && moveTo(moving, f)}
            />
          ))
        )}
      </Sheet>

      <TextPromptSheet
        open={!!creating}
        title={
          creating?.type === "folder" ? "New folder" : creating?.type === "canvas" ? "New canvas" : "New note"
        }
        subtitle={creating?.parent ? `In ${creating.parent}` : undefined}
        placeholder={creating?.type === "folder" ? "Folder name" : creating?.type === "canvas" ? "Canvas name" : "Note title"}
        suffix={creating?.type === "folder" ? undefined : creating?.type === "canvas" ? ".canvas" : ".md"}
        confirmLabel="Create"
        onSubmit={submitCreate}
        onClose={() => setCreating(null)}
      />

      <TextPromptSheet
        open={!!renaming}
        title={renaming?.isDirectory ? "Rename folder" : "Rename"}
        initialValue={renaming ? (renaming.isDirectory ? renaming.name : displayName(renaming.name)) : ""}
        suffix={renaming && !renaming.isDirectory ? fileExt(renaming.name) || ".md" : undefined}
        confirmLabel="Rename"
        onSubmit={submitRename}
        onClose={() => setRenaming(null)}
      />

      <ConfirmSheet
        open={!!deleting}
        title={deleting?.isDirectory ? `Delete folder “${deleting.name}”?` : `Delete “${displayName(deleting?.name ?? "")}”?`}
        message={
          deleting?.isDirectory
            ? "The folder and everything inside it will be removed from this device. The deletion reaches your other devices the next time you save."
            : "This removes the file from this device. The deletion reaches your other devices the next time you save."
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (deleting) onDeleteFile(deleting.path);
          setDeleting(null);
        }}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
};
