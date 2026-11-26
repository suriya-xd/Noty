import { Suspense, lazy, useEffect, useMemo, useRef, useState, useCallback, useLayoutEffect } from "react";
import { Editor } from "./components/Editor";
import type { OpenFileOptions } from "./components/Editor";
import { CanvasView } from "./components/canvas/LazyCanvasView";
import { NoeticBridge } from "./services/noeticBridge";
import { GitHubService, isAuthError, SIGN_IN_AGAIN_MESSAGE } from "./services/githubService";
import {
  ConflictFile,
  ConflictResolution,
  RepoStatusPayload,
  VaultEntry,
} from "./types/noetic";
import { vaultIndex } from "./utils/wikilinks/vaultIndex";
import { recordOpened, removeFromQuickAccess, renameInQuickAccess, setQuickAccessScope } from "./utils/quickAccess";
import { backlinksGraph } from "./utils/wikilinks/backlinksGraph";
import { renameFileWithWikilinks } from "./utils/wikilinks/refactorLinks";
import { flushPendingEdits } from "./utils/pendingEdits";
import { failingForADay, loadProblem, problemFrom, storeProblem } from "./utils/syncStatus";
import type { SyncProblem } from "./utils/syncStatus";
import { isAssetPath, withoutAssets } from "./utils/assets";

// Only what every start needs is in the first script. A device uses one of the two layouts, and
// the dialogs are fetched the first time each is opened (see `useOpenedOnce`).
const TopBar = lazy(() => import("./components/TopBar").then((m) => ({ default: m.TopBar })));
const Sidebar = lazy(() => import("./components/Sidebar").then((m) => ({ default: m.Sidebar })));
const NoteTabs = lazy(() => import("./components/NoteTabs").then((m) => ({ default: m.NoteTabs })));
const Dashboard = lazy(() => import("./components/Dashboard").then((m) => ({ default: m.Dashboard })));
const ConflictResolverModal = lazy(() =>
  import("./components/ConflictResolverModal").then((m) => ({ default: m.ConflictResolverModal }))
);
const OnboardingModal = lazy(() => import("./components/OnboardingModal").then((m) => ({ default: m.OnboardingModal })));
const AccountSettingsModal = lazy(() =>
  import("./components/AccountSettingsModal").then((m) => ({ default: m.AccountSettingsModal }))
);
const WorkspaceModal = lazy(() => import("./components/WorkspaceModal").then((m) => ({ default: m.WorkspaceModal })));
const ImagePreviewModal = lazy(() =>
  import("./components/ImagePreviewModal").then((m) => ({ default: m.ImagePreviewModal }))
);
const AssetsModal = lazy(() => import("./components/AssetsModal").then((m) => ({ default: m.AssetsModal })));
const MobileShell = lazy(() => import("./components/mobile/MobileShell").then((m) => ({ default: m.MobileShell })));
const MobileConflictView = lazy(() =>
  import("./components/mobile/MobileConflictView").then((m) => ({ default: m.MobileConflictView }))
);
const MobileOnboardingView = lazy(() =>
  import("./components/mobile/MobileOnboardingView").then((m) => ({ default: m.MobileOnboardingView }))
);

/** False until `isOpen` is first true, then true for good: a dialog stays mounted once it has been used. */
function useOpenedOnce(isOpen: boolean): boolean {
  const opened = useRef(false);
  if (isOpen) opened.current = true;
  return opened.current;
}

export default function App() {
  const [vaultPath, setVaultPath] = useState<string>("/vault");
  const [files, setFiles] = useState<VaultEntry[]>([]);
  // The notes list leaves out the assets folder; uploaded files are browsed from Settings.
  const notesOnly = useMemo(() => withoutAssets(files), [files]);
  const [status, setStatus] = useState<RepoStatusPayload | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [activeFileContent, setActiveFileContent] = useState<string>("");
  // Notes open as tabs (desktop). A normal open reuses the current tab; "new tab" adds one.
  const [openTabs, setOpenTabs] = useState<string[]>([]);

  // Latest values for callbacks that outlive a render (late autosaves, tab bookkeeping).
  const activeFilePathRef = useRef<string | null>(null);
  activeFilePathRef.current = activeFilePath;
  const activeFileContentRef = useRef("");
  activeFileContentRef.current = activeFileContent;
  const filesRef = useRef<VaultEntry[]>([]);
  filesRef.current = files;
  /** What each note looked like on disk when its links were last read: `<path>` to `<modified>:<size>`. */
  const indexedNotesRef = useRef<Map<string, string>>(new Map());
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);

  // Image lightbox preview state
  const [previewImage, setPreviewImage] = useState<{ src: string; alt?: string; title?: string } | null>(null);

  // Conflict modal state
  const [isConflictModalOpen, setIsConflictModalOpen] = useState<boolean>(false);
  const [conflictedFiles, setConflictedFiles] = useState<ConflictFile[]>([]);
  /** Why the last sync didn't get through; null once one does. */
  const [syncProblem, setSyncProblemState] = useState<SyncProblem | null>(loadProblem);
  const syncProblemRef = useRef(syncProblem);
  const setSyncProblem = (problem: SyncProblem | null) => {
    syncProblemRef.current = problem;
    setSyncProblemState(problem);
    storeProblem(problem);
  };
  /** A sync is running; another request would only wait behind it and then find nothing to do. */
  const syncingRef = useRef(false);
  /** Advances when a sync changed the open note on disk, so its editor is rebuilt from the file. */
  const [editorVersion, setEditorVersion] = useState(0);

  // Onboarding wizard state
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(false);
  /** The sign-in screen was opened because the saved sign-in lapsed, not for a new account. */
  const reSigningInRef = useRef(false);
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState<boolean>(false);
  const [isAssetsOpen, setIsAssetsOpen] = useState<boolean>(false);
  const [isWorkspaceOpen, setIsWorkspaceOpen] = useState<boolean>(false);

  // Toast helper
  const showToast = (text: string, type: "success" | "error" | "info" = "info") => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

  // Responsive device view detection (Mobile vs Desktop)
  const [isMobile, setIsMobile] = useState<boolean>(
    () => typeof window !== "undefined" && window.innerWidth < 768
  );

  // Pins and recently opened items belong to the open workspace. A layout effect, so the
  // dashboard never paints the previous workspace's items.
  const quickAccessWorkspace = status?.branch ?? "";
  useLayoutEffect(() => setQuickAccessScope(vaultPath, quickAccessWorkspace), [vaultPath, quickAccessWorkspace]);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // 1. Refresh repository and file status
  const refreshStatus = useCallback(async (path = vaultPath) => {
    try {
      const currentStatus = await NoeticBridge.getRepoStatus(path);
      setStatus(currentStatus);
    } catch (err) {
      console.error("Failed to get repo status:", err);
    }
  }, [vaultPath]);

  // 2. Refresh file list from disk
  const refreshFiles = useCallback(async (path = vaultPath) => {
    try {
      const list = await NoeticBridge.listVaultFiles(path);
      setFiles(list);

      // Re-index vault files in memory
      vaultIndex.reindex(list.map((f) => f.path));

      // Keep the backlinks graph in step with the folder. Only notes that changed on disk since
      // they were last read are read again, so a refresh after one edit doesn't re-read them all.
      const indexed = indexedNotesRef.current;
      const seen = new Set<string>();
      list.forEach((entry) => {
        if (entry.is_directory || !(entry.path.endsWith(".md") || entry.path.endsWith(".canvas"))) return;
        seen.add(entry.path);
        const stamp = `${path}:${entry.modified_ms}:${entry.size_bytes}`;
        if (indexed.get(entry.path) === stamp) return;
        indexed.set(entry.path, stamp);
        NoeticBridge.readFileContent(`${path}/${entry.path}`)
          .then((content) => backlinksGraph.updateFileLinks(entry.path, content))
          .catch(() => {
            // Not read: try again on the next refresh.
            if (indexed.get(entry.path) === stamp) indexed.delete(entry.path);
          });
      });
      for (const known of indexed.keys()) {
        if (!seen.has(known)) indexed.delete(known);
      }

      // If currently active file no longer exists or is a directory, reset to dashboard
      // Read through the ref: a rename updates it right away, while this callback's own
      // `activeFilePath` would still be the old name and wrongly close the renamed note.
      const current = activeFilePathRef.current;
      if (current) {
        const stillExists = list.some((f) => f.path === current && !f.is_directory);
        if (!stillExists) {
          setActiveFilePath(null);
          setActiveFileContent("");
        }
      }
    } catch (err) {
      console.error("Failed to list vault files:", err);
    }
  }, [vaultPath, activeFilePath]);

  // 3. Initialize vault on startup
  useEffect(() => {
    const initVault = async () => {
      setIsLoading(true);
      try {
        const info = await NoeticBridge.initOrOpenVault();
        setVaultPath(info.path);
        await Promise.all([refreshFiles(info.path), refreshStatus(info.path)]);
        if (!info.remote_url) {
          setIsOnboardingOpen(true);
        } else {
          // Signed in before, but setup stopped before a workspace was created or chosen.
          const current = await NoeticBridge.getRepoStatus(info.path).catch(() => null);
          if (current && !current.branch) setIsWorkspaceOpen(true);
          // A sign-in from before automatic renewal can't renew itself; if GitHub has already
          // let it lapse, ask once for a fresh sign-in (which then never expires) instead of
          // letting saves and syncs fail.
          else if ((await GitHubService.checkSignIn()) === "needs-sign-in") {
            reSigningInRef.current = true;
            setIsOnboardingOpen(true);
            showToast("Sign in to GitHub once more to keep syncing. You won't be asked again.", "info");
          }
        }
      } catch (err) {
        console.error("Startup failed:", err);
        showToast(`Noetic couldn't open your notes folder: ${err}`, "error");
      } finally {
        setIsLoading(false);
      }
    };

    initVault();
  }, []);

  // Periodic status check (every 12 seconds) while the app is on screen; it catches up as soon as
  // the app is shown again.
  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) refreshStatus();
    }, 12000);
    const onVisible = () => {
      if (!document.hidden) refreshStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshStatus]);

  // 4. File selection and reading
  const handleSelectFile = async (relPath: string, options?: OpenFileOptions) => {
    if (!relPath) {
      setActiveFilePath(null);
      setActiveFileContent("");
      return;
    }
    // Prevent opening directories as notes
    const entry = files.find((f) => f.path === relPath);
    if (entry?.is_directory) {
      return;
    }
    try {
      const fullPath = `${vaultPath}/${relPath}`;
      const content = await NoeticBridge.readFileContent(fullPath);
      const previous = activeFilePathRef.current;
      setActiveFileContent(content);
      setActiveFilePath(relPath);
      setOpenTabs((tabs) => {
        if (tabs.includes(relPath)) return tabs;
        const slot = previous ? tabs.indexOf(previous) : -1;
        // New tab requested, or nothing to reuse: add a tab next to the current one.
        if (options?.newTab || slot === -1) {
          const next = [...tabs];
          next.splice(slot === -1 ? tabs.length : slot + 1, 0, relPath);
          return next;
        }
        return tabs.map((t, i) => (i === slot ? relPath : t));
      });
      backlinksGraph.updateFileLinks(relPath, content);
      recordOpened(relPath, false);
    } catch (err) {
      console.error("Failed to read file:", err);
      showToast(`Error reading file: ${err}`, "error");
    }
  };

  const handleCloseTab = (relPath: string) => {
    const index = openTabs.indexOf(relPath);
    if (index === -1) return;
    const remaining = openTabs.filter((t) => t !== relPath);
    setOpenTabs(remaining);
    if (activeFilePath === relPath) {
      // Closing the visible tab: show its neighbour, or the dashboard when it was the last one.
      const neighbour = remaining[Math.min(index, remaining.length - 1)];
      handleSelectFile(neighbour ?? "");
    }
  };

  // Tabs whose file is gone (deleted here, or removed by a pull) are dropped.
  useEffect(() => {
    if (files.length === 0) return;
    const existing = new Set(files.filter((f) => !f.is_directory).map((f) => f.path));
    setOpenTabs((tabs) => {
      const next = tabs.filter((t) => existing.has(t));
      return next.length === tabs.length ? tabs : next;
    });
  }, [files]);

  // 5. Debounced Disk Write (Rule 2: 500ms write directly to disk, dirtying worktree)
  const handleDebouncedSave = async (relPath: string, newContent: string) => {
    try {
      // A save can arrive just after its note was closed, switched away from, or deleted (the
      // editor flushes pending edits when it is torn down). Never recreate a deleted file, and
      // never let a background note's text replace what the visible note shows.
      const isActive = activeFilePathRef.current === relPath;
      if (!isActive && !filesRef.current.some((f) => f.path === relPath)) return;
      const fullPath = `${vaultPath}/${relPath}`;
      if (isActive) activeFileContentRef.current = newContent;
      await NoeticBridge.writeFileContent(fullPath, newContent);
      if (activeFilePathRef.current === relPath) setActiveFileContent(newContent);
      backlinksGraph.updateFileLinks(relPath, newContent);
      // Refresh the status so the unsaved indicator (`•`) shows right away
      await refreshStatus();
    } catch (err) {
      console.error("Failed to write to disk:", err);
      showToast(`Disk write failed: ${err}`, "error");
    }
  };

  /** Shows the open note as it is on disk now. Without this its editor would keep the text from
   * before the sync and write that back over the synced note with the next autosave. */
  const reloadActiveNote = async () => {
    const path = activeFilePathRef.current;
    if (!path) return;
    const content = await NoeticBridge.readFileContent(`${vaultPath}/${path}`).catch(() => null);
    // Deleted by the sync: refreshFiles closes it.
    // Same as what the editor opened or last wrote: leave it, the user may be typing.
    if (content === null || content === activeFileContentRef.current || activeFilePathRef.current !== path) return;
    setActiveFileContent(content);
    setEditorVersion((v) => v + 1);
    backlinksGraph.updateFileLinks(path, content);
  };

  /** Runs something that may change notes on disk: pending typing is written first, and typing is
   * paused while `lock` is set so an autosave can't land in the middle of it. */
  const withNotesOnDisk = async <T,>(lock: boolean, run: () => Promise<T>): Promise<T> => {
    const root = document.getElementById("root");
    if (lock) root?.setAttribute("inert", "");
    try {
      await flushPendingEdits();
      try {
        return await run();
      } finally {
        await reloadActiveNote();
        await Promise.all([refreshStatus(), refreshFiles()]);
      }
    } finally {
      if (lock) root?.removeAttribute("inert");
    }
  };

  // 6. Sync now: commits, brings in updates from other devices, combines and uploads.
  const handleSyncNow = async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setIsLoading(true);
    try {
      // Checked first so typing is only paused when there is something to bring in.
      const current = await NoeticBridge.fetchRemote(vaultPath).catch(() => null);
      const incoming = (current?.behind_count ?? 0) > 0;
      const result = await withNotesOnDisk(incoming, () => NoeticBridge.syncNow(vaultPath));
      // Reaching the cloud is what counts here: a conflict is not a connection problem.
      setSyncProblem(null);
      if (result.conflicts.length > 0) {
        setConflictedFiles(result.conflicts);
        setIsConflictModalOpen(true);
        // No toast here: the resolver that just opened is its own announcement.
      } else {
        showToast(result.message, "success");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (status?.remote_url && status.branch) {
        const signInRefused = isAuthError(err) || msg === SIGN_IN_AGAIN_MESSAGE;
        const problem = problemFrom(msg, signInRefused, syncProblemRef.current);
        setSyncProblem(problem);
        showToast(failingForADay(problem) ? `${msg} Nothing has been uploaded for over a day.` : msg, "error");
      } else {
        showToast(msg, "error");
      }
    } finally {
      syncingRef.current = false;
      setIsLoading(false);
    }
  };

  // 9. Conflict Resolution Apply
  const handleApplyResolutions = async (resolutions: ConflictResolution[]) => {
    setIsLoading(true);
    try {
      await withNotesOnDisk(true, () => NoeticBridge.resolveConflicts(vaultPath, resolutions));
      setIsConflictModalOpen(false);
      setConflictedFiles([]);
      // Continue the sync that asked, so the chosen versions are uploaded.
      await handleSyncNow();
    } catch (err) {
      showToast(`Failed to resolve conflicts: ${err}`, "error");
    } finally {
      setIsLoading(false);
    }
  };

  // 10. File & Folder Management (Create, Delete, Rename)
  const handleCreateFile = async (name: string, options?: OpenFileOptions) => {
    try {
      await NoeticBridge.createFile(vaultPath, name);
      await Promise.all([refreshFiles(), refreshStatus()]);
      handleSelectFile(name, options);
      showToast(`Created ${name}`, "success");
    } catch (err) {
      showToast(`Failed to create file: ${err}`, "error");
    }
  };

  const handleCreateFolder = async (folderPath: string) => {
    try {
      await NoeticBridge.createFolder(vaultPath, folderPath);
      await Promise.all([refreshFiles(), refreshStatus()]);
      showToast(`Created folder "${folderPath}"`, "success");
    } catch (err) {
      showToast(`Failed to create folder: ${err}`, "error");
    }
  };

  const handleDeleteFile = async (relPath: string) => {
    try {
      await NoeticBridge.deleteFile(vaultPath, relPath);
      vaultIndex.remove(relPath);
      backlinksGraph.removeFileLinks(relPath);
      removeFromQuickAccess(relPath);

      const isGone = (p: string) => p === relPath || p.startsWith(relPath + "/");
      setOpenTabs((tabs) => tabs.filter((t) => !isGone(t)));
      if (activeFilePath && isGone(activeFilePath)) {
        setActiveFilePath(null);
        setActiveFileContent("");
      }
      await Promise.all([refreshFiles(), refreshStatus()]);
      showToast(`Deleted ${relPath}`, "info");
    } catch (err) {
      showToast(`Failed to delete: ${err}`, "error");
    }
  };

  /**
   * Renames a file or folder. Returns false when refused or failed. `fromTitle` means the user
   * edited the note's inline title, so no "Renamed" toast is needed.
   */
  const handleRenameFile = async (
    oldPath: string,
    newPath: string,
    options?: { fromTitle?: boolean }
  ): Promise<boolean> => {
    if (oldPath === newPath) return true;
    // The filesystem rename overwrites silently, so a taken name must be refused here. Compared
    // case-insensitively (macOS, Windows), except for the entry being renamed itself.
    const taken = filesRef.current.some(
      (f) => f.path !== oldPath && f.path.toLowerCase() === newPath.toLowerCase()
    );
    if (taken) {
      showToast(`"${newPath}" already exists. Pick a different name.`, "error");
      return false;
    }
    try {
      const result = await renameFileWithWikilinks(oldPath, newPath, {
        readFile: (filePath) => NoeticBridge.readFileContent(`${vaultPath}/${filePath}`),
        writeFile: (filePath, content) => NoeticBridge.writeFileContent(`${vaultPath}/${filePath}`, content),
        renameFile: (oldP, newP) => NoeticBridge.renameFile(vaultPath, oldP, newP),
      });

      const renamed = (p: string) =>
        p === oldPath ? newPath : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p;
      setOpenTabs((tabs) => tabs.map(renamed));
      renameInQuickAccess(oldPath, newPath);
      if (activeFilePath) activeFilePathRef.current = renamed(activeFilePath);
      if (activeFilePath === oldPath) {
        setActiveFilePath(newPath);
      } else if (activeFilePath && activeFilePath.startsWith(oldPath + "/")) {
        setActiveFilePath(newPath + activeFilePath.slice(oldPath.length));
      }
      await Promise.all([refreshFiles(), refreshStatus()]);

      if (result.totalLinksUpdated > 0) {
        showToast(
          `Renamed to ${newPath} & updated ${result.totalLinksUpdated} wikilink${result.totalLinksUpdated === 1 ? "" : "s"} across ${result.affectedFiles.length} note${result.affectedFiles.length === 1 ? "" : "s"}!`,
          "success"
        );
      } else if (!options?.fromTitle) {
        showToast(`Renamed to ${newPath}`, "success");
      }
      return true;
    } catch (err) {
      showToast(`Failed to rename: ${err}`, "error");
      return false;
    }
  };

  // 11. Workspaces: a switch replaces every note in the folder, so open notes are closed.
  const handleWorkspaceSwitched = async (workspace: string, newStatus: RepoStatusPayload, created: boolean) => {
    setStatus(newStatus);
    setOpenTabs([]);
    setActiveFilePath(null);
    setActiveFileContent("");
    await refreshFiles();
    showToast(created ? `Workspace "${workspace}" created.` : `Switched to "${workspace}".`, "success");
  };

  /** After signing in (or changing account) this device is pointed at that account's storage. */
  const handleAccountChanged = async () => {
    if (GitHubService.getStoredGitHubAuth()) {
      try {
        const list = await GitHubService.setUpStorage(vaultPath);
        if (!list.current) setIsWorkspaceOpen(true);
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), "error");
      }
    }
    await Promise.all([refreshFiles(), refreshStatus()]);
  };

  const handleSignedIn = () => {
    setIsOnboardingOpen(false);
    if (syncProblemRef.current?.kind === "sign-in") setSyncProblem(null);
    if (reSigningInRef.current) {
      // Same account, same storage: just carry on with the renewed sign-in.
      reSigningInRef.current = false;
      showToast("Signed in. Saving and syncing are back on.", "success");
      void refreshStatus();
      return;
    }
    setIsWorkspaceOpen(true);
  };

  // 12. State simulation handler for instant testing
  const handleSimulateState = async (stateType: string) => {
    switch (stateType) {
      case "clean_synced":
        NoeticBridge.resetMockState();
        break;
      case "dirty_synced":
        NoeticBridge.resetMockState();
        if (activeFilePath) {
          await NoeticBridge.writeFileContent(`${vaultPath}/${activeFilePath}`, activeFileContent + "\n\n// Local edit");
        }
        break;
      case "clean_behind":
        NoeticBridge.resetMockState();
        NoeticBridge.simulateRemoteAhead(3);
        break;
      case "dirty_behind":
        NoeticBridge.resetMockState();
        NoeticBridge.simulateRemoteAhead(2);
        if (activeFilePath) {
          await NoeticBridge.writeFileContent(`${vaultPath}/${activeFilePath}`, activeFileContent + "\n\n// Local edit");
        }
        break;
      case "ahead_offline":
        NoeticBridge.simulateOfflineCommit();
        break;
      case "conflict_trigger":
        // Set ConflictTest.md dirty and remote ahead
        NoeticBridge.simulateRemoteAhead(1);
        await NoeticBridge.writeFileContent(
          `${vaultPath}/ConflictTest.md`,
          "# Project Roadmap\n- Milestone 1: Core Engine\n- Milestone 2: LOCAL UPDATE (Added Offline Local-First Worktree)\n- Milestone 3: Platform Release"
        );
        await handleSyncNow();
        break;
    }
    await refreshStatus();
  };

  const conflictsOpened = useOpenedOnce(isConflictModalOpen);
  const onboardingOpened = useOpenedOnce(isOnboardingOpen);
  const accountSettingsOpened = useOpenedOnce(isAccountSettingsOpen);
  const assetsOpened = useOpenedOnce(isAssetsOpen);
  const workspaceOpened = useOpenedOnce(isWorkspaceOpen);
  const previewOpened = useOpenedOnce(!!previewImage);

  return (
    <div className="flex flex-col h-app w-screen overflow-hidden bg-[#0d1117] text-white select-none">
      <Suspense fallback={null}>
        {isMobile ? (
          // ================= ANDROID MOBILE LAYOUT (STITCH REDESIGN) =================
          <>
            <MobileShell
              vaultPath={vaultPath}
              files={files}
              status={status}
              activeFilePath={activeFilePath}
              activeFileContent={activeFileContent}
              editorVersion={editorVersion}
              isLoading={isLoading}
              onSelectFile={handleSelectFile}
              onDebouncedSave={handleDebouncedSave}
              onCreateFile={handleCreateFile}
              onCreateFolder={handleCreateFolder}
              onDeleteFile={handleDeleteFile}
              onRenameFile={handleRenameFile}
              syncProblem={syncProblem}
              onSync={handleSyncNow}
              onOpenWorkspaces={() => setIsWorkspaceOpen(true)}
              onOpenOnboarding={() => setIsOnboardingOpen(true)}
              onOpenAccountSettings={() => setIsAccountSettingsOpen(true)}
              onOpenAssets={() => setIsAssetsOpen(true)}
              onSimulateState={handleSimulateState}
              onRefreshFiles={async () => {
                await refreshFiles(vaultPath);
              }}
              onPreviewImage={(src, alt, title) => setPreviewImage({ src, alt, title })}
            />


            {/* Android Conflict Resolution View */}
            {conflictsOpened ? (
              <Suspense fallback={null}>
                <MobileConflictView
                  conflicts={conflictedFiles}
                  isOpen={isConflictModalOpen}
                  onClose={() => setIsConflictModalOpen(false)}
                  onApplyResolutions={handleApplyResolutions}
                />
              </Suspense>
            ) : null}

            {/* Android sign-in */}
            {onboardingOpened ? (
              <Suspense fallback={null}>
                <MobileOnboardingView
                  isOpen={isOnboardingOpen}
                  onAuthenticated={handleSignedIn}
                  onCancel={() => setIsOnboardingOpen(false)}
                />
              </Suspense>
            ) : null}
          </>
        ) : (
          // ================= DESKTOP WORKSPACE LAYOUT =================
          <>
            {/* Top Bar with live sync status and Sync now */}
            <TopBar
              status={status}
              isLoading={isLoading}
              syncProblem={syncProblem}
              onSync={handleSyncNow}
              onOpenWorkspaces={() => setIsWorkspaceOpen(true)}
              onOpenOnboarding={() => setIsOnboardingOpen(true)}
              onSimulateState={handleSimulateState}
              onGoToDashboard={() => {
                setActiveFilePath(null);
                setActiveFileContent("");
              }}
            />

            {/* Main Workspace (Sidebar + CodeMirror Editor / Dashboard) */}
            <div className="flex-1 flex overflow-hidden">
              {/* Sidebar file tree with sync status badges */}
              <Sidebar
                vaultPath={vaultPath}
                files={files}
                fileStatuses={status?.files || []}
                activeFilePath={activeFilePath}
                onSelectFile={handleSelectFile}
                onCreateFile={handleCreateFile}
                onCreateFolder={handleCreateFolder}
                onDeleteFile={handleDeleteFile}
                onRenameFile={handleRenameFile}
                onOpenSettings={() => setIsAccountSettingsOpen(true)}
                isConnected={!!status?.remote_url}
              />

              {/* CodeMirror 6 Markdown Editor OR Dashboard when no note is opened */}
              <main className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
                <NoteTabs
                  tabs={openTabs}
                  activePath={activeFilePath}
                  onSelect={(path) => handleSelectFile(path)}
                  onClose={handleCloseTab}
                />
                {activeFilePath ? (
                  activeFilePath.endsWith(".canvas") ? (
                    <CanvasView
                      key={`${activeFilePath}:${editorVersion}`}
                      filePath={activeFilePath}
                      initialContent={activeFileContent}
                      vaultPath={vaultPath}
                      vaultFiles={files}
                      onDebouncedSave={handleDebouncedSave}
                      onOpenFile={handleSelectFile}
                      onRefreshFiles={async () => {
                        await refreshFiles(vaultPath);
                      }}
                      onPreviewImage={(src, alt, title) => setPreviewImage({ src, alt, title })}
                      onClose={() => {
                        setActiveFilePath(null);
                        setActiveFileContent("");
                      }}
                    />
                  ) : (
                    <Editor
                      key={editorVersion}
                      filePath={activeFilePath}
                      initialContent={activeFileContent}
                      onDebouncedSave={handleDebouncedSave}
                      onRenameFile={handleRenameFile}
                      onOpenFile={handleSelectFile}
                      onCreateFile={handleCreateFile}
                      vaultPath={vaultPath}
                      vaultFiles={files}
                      onRefreshFiles={async () => {
                        await refreshFiles(vaultPath);
                      }}
                      onPreviewImage={(src, alt, title) => setPreviewImage({ src, alt, title })}
                      onClose={() => {
                        setActiveFilePath(null);
                        setActiveFileContent("");
                      }}
                      debounceMs={500}
                    />
                  )
                ) : (
                  <Dashboard
                    vaultPath={vaultPath}
                    files={notesOnly}
                    fileStatuses={status?.files || []}
                    onSelectFile={handleSelectFile}
                    onCreateFile={handleCreateFile}
                    onCreateFolder={handleCreateFolder}
                    status={status}
                  />
                )}
              </main>
            </div>

            {/* Visual 3-Way Conflict Resolver Modal */}
            {conflictsOpened ? (
              <Suspense fallback={null}>
                <ConflictResolverModal
                  conflicts={conflictedFiles}
                  isOpen={isConflictModalOpen}
                  onClose={() => setIsConflictModalOpen(false)}
                  onApplyResolutions={handleApplyResolutions}
                />
              </Suspense>
            ) : null}

            {/* Sign-in (desktop) */}
            {onboardingOpened ? (
              <Suspense fallback={null}>
                <OnboardingModal
                  isOpen={isOnboardingOpen}
                  onAuthenticated={handleSignedIn}
                  onCancel={() => setIsOnboardingOpen(false)}
                />
              </Suspense>
            ) : null}
          </>
        )}

        {/* Shared Modals for both layouts */}
        {accountSettingsOpened ? (
          <Suspense fallback={null}>
            <AccountSettingsModal
              isOpen={isAccountSettingsOpen}
              onClose={() => setIsAccountSettingsOpen(false)}
              vaultPath={vaultPath}
              onAccountChanged={handleAccountChanged}
              assetCount={files.filter((f) => !f.is_directory && isAssetPath(f.path)).length}
              onOpenAssets={() => setIsAssetsOpen(true)}
            />
          </Suspense>
        ) : null}

        {/* Uploaded images (the assets folder), opened from Settings */}
        {assetsOpened ? (
          <Suspense fallback={null}>
            <AssetsModal
              isOpen={isAssetsOpen}
              onClose={() => setIsAssetsOpen(false)}
              vaultPath={vaultPath}
              files={files}
              onPreviewImage={(src, alt, title) => setPreviewImage({ src, alt, title })}
              onDeleteFile={handleDeleteFile}
            />
          </Suspense>
        ) : null}

        {workspaceOpened ? (
          <Suspense fallback={null}>
            <WorkspaceModal
              isOpen={isWorkspaceOpen}
              onClose={() => setIsWorkspaceOpen(false)}
              vaultPath={vaultPath}
              isConnected={!!status?.remote_url}
              onSwitched={handleWorkspaceSwitched}
            />
          </Suspense>
        ) : null}

        {/* Lightbox Image Preview Modal */}
        {previewOpened ? (
          <Suspense fallback={null}>
            <ImagePreviewModal
              isOpen={!!previewImage}
              src={previewImage?.src || ""}
              alt={previewImage?.alt}
              title={previewImage?.title}
              onClose={() => setPreviewImage(null)}
            />
          </Suspense>
        ) : null}
      </Suspense>

      {/* Toast Notification Pill */}
      {toastMessage && (
        <div
          role="status"
          className={`fixed z-[70] rounded-xl shadow-2xl border font-medium flex items-center gap-2 m-toast-in ${
            isMobile
              ? "left-3 right-3 top-[calc(env(safe-area-inset-top,0px)+8px)] px-4 py-3 text-sm pointer-events-none"
              : "bottom-5 left-1/2 -translate-x-1/2 max-w-[min(90vw,32rem)] px-4 py-2.5 text-xs"
          } ${
            toastMessage.type === "success"
              ? "bg-emerald-950 text-emerald-200 border-emerald-500/40"
              : toastMessage.type === "error"
              ? "bg-red-950 text-red-200 border-red-500/40"
              : "bg-sky-950 text-sky-200 border-sky-500/40"
          }`}
        >
          <span>{toastMessage.text}</span>
        </div>
      )}
    </div>
  );
}
