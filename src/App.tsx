import { useEffect, useRef, useState, useCallback } from "react";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import type { OpenFileOptions } from "./components/Editor";
import { NoteTabs } from "./components/NoteTabs";
import { CanvasView } from "./components/canvas/CanvasView";
import { Dashboard } from "./components/Dashboard";
import { ConflictResolverModal } from "./components/ConflictResolverModal";
import { OnboardingModal } from "./components/OnboardingModal";
import { AccountSettingsModal } from "./components/AccountSettingsModal";
import { RepoSwitchModal } from "./components/RepoSwitchModal";
import { ImagePreviewModal } from "./components/ImagePreviewModal";
import { MobileShell } from "./components/mobile/MobileShell";
import { MobileConflictView } from "./components/mobile/MobileConflictView";
import { MobileOnboardingView } from "./components/mobile/MobileOnboardingView";
import { GitVaultBridge } from "./services/gitVaultBridge";
import {
  ConflictFile,
  ConflictResolution,
  RepoStatusPayload,
  VaultEntry,
} from "./types/gitVault";
import { vaultIndex } from "./utils/wikilinks/vaultIndex";
import { backlinksGraph } from "./utils/wikilinks/backlinksGraph";
import { renameFileWithWikilinks } from "./utils/wikilinks/refactorLinks";

export default function App() {
  const [vaultPath, setVaultPath] = useState<string>("/vault");
  const [files, setFiles] = useState<VaultEntry[]>([]);
  const [status, setStatus] = useState<RepoStatusPayload | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [activeFileContent, setActiveFileContent] = useState<string>("");
  // Notes open as tabs (desktop). A normal open reuses the current tab; "new tab" adds one.
  const [openTabs, setOpenTabs] = useState<string[]>([]);

  // Latest values for callbacks that outlive a render (late autosaves, tab bookkeeping).
  const activeFilePathRef = useRef<string | null>(null);
  activeFilePathRef.current = activeFilePath;
  const filesRef = useRef<VaultEntry[]>([]);
  filesRef.current = files;
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);

  // Image lightbox preview state
  const [previewImage, setPreviewImage] = useState<{ src: string; alt?: string; title?: string } | null>(null);

  // Conflict modal state
  const [isConflictModalOpen, setIsConflictModalOpen] = useState<boolean>(false);
  const [conflictedFiles, setConflictedFiles] = useState<ConflictFile[]>([]);

  // Onboarding wizard state
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(false);
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState<boolean>(false);
  const [isRepoSwitchOpen, setIsRepoSwitchOpen] = useState<boolean>(false);

  // Toast helper
  const showToast = (text: string, type: "success" | "error" | "info" = "info") => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

  // Responsive device view detection (Mobile vs Desktop)
  const [isMobile, setIsMobile] = useState<boolean>(
    () => typeof window !== "undefined" && window.innerWidth < 768
  );

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
      const currentStatus = await GitVaultBridge.getRepoStatus(path);
      setStatus(currentStatus);
    } catch (err) {
      console.error("Failed to get repo status:", err);
    }
  }, [vaultPath]);

  // 2. Refresh file list from disk
  const refreshFiles = useCallback(async (path = vaultPath) => {
    try {
      const list = await GitVaultBridge.listVaultFiles(path);
      setFiles(list);

      // Re-index vault files in memory
      vaultIndex.reindex(list.map((f) => f.path));

      // Asynchronously populate backlinks graph for all markdown & canvas files
      list.forEach((entry) => {
        if (!entry.is_directory && (entry.path.endsWith(".md") || entry.path.endsWith(".canvas"))) {
          GitVaultBridge.readFileContent(`${path}/${entry.path}`)
            .then((content) => backlinksGraph.updateFileLinks(entry.path, content))
            .catch(() => {});
        }
      });

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
        const info = await GitVaultBridge.initOrOpenVault();
        setVaultPath(info.path);
        await Promise.all([refreshFiles(info.path), refreshStatus(info.path)]);
        if (!info.remote_url) {
          setIsOnboardingOpen(true);
          // The mobile onboarding screen is full-screen and says this itself.
          if (window.innerWidth >= 768) {
            showToast("Welcome to Noty! Connect a GitHub repository to start syncing.", "info");
          }
        }
      } catch (err) {
        console.error("Vault initialization failed:", err);
        showToast(`Initialization failed: ${err}`, "error");
      } finally {
        setIsLoading(false);
      }
    };

    initVault();
  }, []);

  // Periodic background fetch (every 12 seconds)
  useEffect(() => {
    const interval = setInterval(() => {
      refreshStatus();
    }, 12000);
    return () => clearInterval(interval);
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
      const content = await GitVaultBridge.readFileContent(fullPath);
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
      await GitVaultBridge.writeFileContent(fullPath, newContent);
      if (activeFilePathRef.current === relPath) setActiveFileContent(newContent);
      backlinksGraph.updateFileLinks(relPath, newContent);
      // Immediately refresh Git status to show the dirty worktree indicator (`•`)
      await refreshStatus();
    } catch (err) {
      console.error("Failed to write to disk:", err);
      showToast(`Disk write failed: ${err}`, "error");
    }
  };

  // 6. Manual Save & Push (Rule 4: Stages `git add -A`, commits, and pushes)
  const handleSaveAndPush = async () => {
    setIsLoading(true);
    try {
      const updatedStatus = await GitVaultBridge.saveAndPush(vaultPath);
      setStatus(updatedStatus);
      showToast("All changes staged, committed, and saved successfully!", "success");
      await refreshFiles();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(msg, "error");
    } finally {
      setIsLoading(false);
    }
  };

  // 7. Manual Sync & Pull (Rule 5: Pulls origin/main, 3-way in-memory merge)
  const handleSyncAndPull = async () => {
    setIsLoading(true);
    try {
      const result = await GitVaultBridge.syncAndPull(vaultPath);
      if (result.conflicts && result.conflicts.length > 0) {
        // Line-level collisions detected! Open Visual Conflict Resolver Modal
        setConflictedFiles(result.conflicts);
        setIsConflictModalOpen(true);
        // No toast here: the resolver that just opened is its own announcement.
      } else {
        showToast(result.message, "success");
      }
      await Promise.all([refreshStatus(), refreshFiles()]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Sync failed: ${msg}`, "error");
    } finally {
      setIsLoading(false);
    }
  };

  // 8. Manual Fetch Remote
  const handleFetchRemote = async () => {
    setIsLoading(true);
    try {
      const updatedStatus = await GitVaultBridge.fetchRemote(vaultPath);
      setStatus(updatedStatus);
      showToast("Fetched latest remote references.", "info");
    } catch (err) {
      showToast(`Fetch failed: ${err}`, "error");
    } finally {
      setIsLoading(false);
    }
  };

  // 9. Conflict Resolution Apply
  const handleApplyResolutions = async (resolutions: ConflictResolution[]) => {
    setIsLoading(true);
    try {
      const postStatus = await GitVaultBridge.resolveConflicts(vaultPath, resolutions);
      setStatus(postStatus);
      setIsConflictModalOpen(false);
      setConflictedFiles([]);
      showToast("Conflicts resolved cleanly! Merged changes applied.", "success");

      // Reload active note if it was resolved
      if (activeFilePath) {
        const fullPath = `${vaultPath}/${activeFilePath}`;
        const updated = await GitVaultBridge.readFileContent(fullPath);
        setActiveFileContent(updated);
      }
      await refreshFiles();
    } catch (err) {
      showToast(`Failed to resolve conflicts: ${err}`, "error");
    } finally {
      setIsLoading(false);
    }
  };

  // 10. File & Folder Management (Create, Delete, Rename)
  const handleCreateFile = async (name: string, options?: OpenFileOptions) => {
    try {
      await GitVaultBridge.createFile(vaultPath, name);
      await Promise.all([refreshFiles(), refreshStatus()]);
      handleSelectFile(name, options);
      showToast(`Created ${name}`, "success");
    } catch (err) {
      showToast(`Failed to create file: ${err}`, "error");
    }
  };

  const handleCreateFolder = async (folderPath: string) => {
    try {
      await GitVaultBridge.createFolder(vaultPath, folderPath);
      await Promise.all([refreshFiles(), refreshStatus()]);
      showToast(`Created folder "${folderPath}"`, "success");
    } catch (err) {
      showToast(`Failed to create folder: ${err}`, "error");
    }
  };

  const handleDeleteFile = async (relPath: string) => {
    try {
      await GitVaultBridge.deleteFile(vaultPath, relPath);
      vaultIndex.remove(relPath);
      backlinksGraph.removeFileLinks(relPath);

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
        readFile: (filePath) => GitVaultBridge.readFileContent(`${vaultPath}/${filePath}`),
        writeFile: (filePath, content) => GitVaultBridge.writeFileContent(`${vaultPath}/${filePath}`, content),
        renameFile: (oldP, newP) => GitVaultBridge.renameFile(vaultPath, oldP, newP),
      });

      const renamed = (p: string) =>
        p === oldPath ? newPath : p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p;
      setOpenTabs((tabs) => tabs.map(renamed));
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

  // 11. State simulation handler for instant testing
  const handleSimulateState = async (stateType: string) => {
    switch (stateType) {
      case "clean_synced":
        GitVaultBridge.resetMockState();
        break;
      case "dirty_synced":
        GitVaultBridge.resetMockState();
        if (activeFilePath) {
          await GitVaultBridge.writeFileContent(`${vaultPath}/${activeFilePath}`, activeFileContent + "\n\n// Local edit");
        }
        break;
      case "clean_behind":
        GitVaultBridge.resetMockState();
        GitVaultBridge.simulateRemoteAhead(3);
        break;
      case "dirty_behind":
        GitVaultBridge.resetMockState();
        GitVaultBridge.simulateRemoteAhead(2);
        if (activeFilePath) {
          await GitVaultBridge.writeFileContent(`${vaultPath}/${activeFilePath}`, activeFileContent + "\n\n// Local edit");
        }
        break;
      case "ahead_offline":
        GitVaultBridge.simulateOfflineCommit();
        break;
      case "conflict_trigger":
        // Set ConflictTest.md dirty and remote ahead
        GitVaultBridge.simulateRemoteAhead(1);
        await GitVaultBridge.writeFileContent(
          `${vaultPath}/ConflictTest.md`,
          "# Project Roadmap\n- Milestone 1: Core Engine\n- Milestone 2: LOCAL UPDATE (Added Offline Local-First Worktree)\n- Milestone 3: Platform Release"
        );
        await handleSyncAndPull();
        break;
    }
    await refreshStatus();
  };

  return (
    <div className="flex flex-col h-app w-screen overflow-hidden bg-[#0d1117] text-white select-none">
      {isMobile ? (
        // ================= ANDROID MOBILE LAYOUT (STITCH REDESIGN) =================
        <>
          <MobileShell
            vaultPath={vaultPath}
            files={files}
            status={status}
            activeFilePath={activeFilePath}
            activeFileContent={activeFileContent}
            isLoading={isLoading}
            onSelectFile={handleSelectFile}
            onDebouncedSave={handleDebouncedSave}
            onCreateFile={handleCreateFile}
            onCreateFolder={handleCreateFolder}
            onDeleteFile={handleDeleteFile}
            onRenameFile={handleRenameFile}
            onSave={handleSaveAndPush}
            onSync={handleSyncAndPull}
            onFetch={handleFetchRemote}
            onOpenRepoSwitch={() => setIsRepoSwitchOpen(true)}
            onOpenOnboarding={() => setIsOnboardingOpen(true)}
            onOpenAccountSettings={() => setIsAccountSettingsOpen(true)}
            onSimulateState={handleSimulateState}
            onRefreshFiles={async () => {
              await refreshFiles(vaultPath);
            }}
            onPreviewImage={(src, alt, title) => setPreviewImage({ src, alt, title })}
          />


          {/* Android Conflict Resolution View */}
          <MobileConflictView
            conflicts={conflictedFiles}
            isOpen={isConflictModalOpen}
            onClose={() => setIsConflictModalOpen(false)}
            onApplyResolutions={handleApplyResolutions}
          />

          {/* Android GitHub Onboarding Wizard */}
          <MobileOnboardingView
            isOpen={isOnboardingOpen}
            onAuthenticated={() => {
              // Signed in: continue to choosing (or creating) the repository to sync with.
              setIsOnboardingOpen(false);
              setIsRepoSwitchOpen(true);
            }}
            onCancel={() => setIsOnboardingOpen(false)}
          />
        </>
      ) : (
        // ================= DESKTOP WORKSPACE LAYOUT =================
        <>
          {/* Top Bar with Live Git Status Pill & Save/Sync Actions */}
          <TopBar
            status={status}
            isLoading={isLoading}
            vaultPath={vaultPath}
            onSave={handleSaveAndPush}
            onSync={handleSyncAndPull}
            onFetch={handleFetchRemote}
            onOpenRepoSwitch={() => setIsRepoSwitchOpen(true)}
            onOpenOnboarding={() => setIsOnboardingOpen(true)}
            onSimulateState={handleSimulateState}
            onGoToDashboard={() => {
              setActiveFilePath(null);
              setActiveFileContent("");
            }}
          />

          {/* Main Workspace (Sidebar + CodeMirror Editor / Dashboard) */}
          <div className="flex-1 flex overflow-hidden">
            {/* Sidebar File Tree with Live Git Status Badges */}
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
                    key={activeFilePath}
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
                  files={files}
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
          <ConflictResolverModal
            conflicts={conflictedFiles}
            isOpen={isConflictModalOpen}
            onClose={() => setIsConflictModalOpen(false)}
            onApplyResolutions={handleApplyResolutions}
          />

          {/* GitHub Authentication & Vault Setup Wizard (Desktop) */}
          <OnboardingModal
            isOpen={isOnboardingOpen}
            defaultVaultPath={vaultPath}
            onComplete={async (data) => {
              setVaultPath(data.vaultPath);
              setIsOnboardingOpen(false);
              showToast("Vault successfully connected to GitHub!", "success");
              await Promise.all([refreshFiles(data.vaultPath), refreshStatus(data.vaultPath)]);
            }}
            onCancel={() => setIsOnboardingOpen(false)}
          />
        </>
      )}

      {/* Shared Modals for both layouts */}
      <AccountSettingsModal
        isOpen={isAccountSettingsOpen}
        onClose={() => setIsAccountSettingsOpen(false)}
        vaultPath={vaultPath}
        onAccountChanged={async () => {
          await Promise.all([refreshFiles(), refreshStatus()]);
        }}
      />

      <RepoSwitchModal
        isOpen={isRepoSwitchOpen}
        onClose={() => setIsRepoSwitchOpen(false)}
        defaultVaultPath={vaultPath}
        onComplete={async (data) => {
          setVaultPath(data.vaultPath);
          showToast("Switched repository successfully!", "success");
          await Promise.all([refreshFiles(data.vaultPath), refreshStatus(data.vaultPath)]);
        }}
      />

      {/* Lightbox Image Preview Modal */}
      <ImagePreviewModal
        isOpen={!!previewImage}
        src={previewImage?.src || ""}
        alt={previewImage?.alt}
        title={previewImage?.title}
        onClose={() => setPreviewImage(null)}
      />

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
