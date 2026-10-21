import { useEffect, useState, useCallback } from "react";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Editor } from "./components/Editor";
import { ConflictResolverModal } from "./components/ConflictResolverModal";
import { GitVaultBridge } from "./services/gitVaultBridge";
import {
  ConflictFile,
  ConflictResolution,
  RepoStatusPayload,
  VaultEntry,
} from "./types/gitVault";

export default function App() {
  const [vaultPath, setVaultPath] = useState<string>("/vault");
  const [files, setFiles] = useState<VaultEntry[]>([]);
  const [status, setStatus] = useState<RepoStatusPayload | null>(null);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [activeFileContent, setActiveFileContent] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: "success" | "error" | "info" } | null>(null);

  // Conflict modal state
  const [isConflictModalOpen, setIsConflictModalOpen] = useState<boolean>(false);
  const [conflictedFiles, setConflictedFiles] = useState<ConflictFile[]>([]);

  // Toast helper
  const showToast = (text: string, type: "success" | "error" | "info" = "info") => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

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

      // Default to first file if none selected
      if (!activeFilePath && list.length > 0) {
        handleSelectFile(list[0].path);
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
  const handleSelectFile = async (relPath: string) => {
    try {
      setActiveFilePath(relPath);
      const fullPath = `${vaultPath}/${relPath}`;
      const content = await GitVaultBridge.readFileContent(fullPath);
      setActiveFileContent(content);
    } catch (err) {
      console.error("Failed to read file:", err);
      showToast(`Error reading file: ${err}`, "error");
    }
  };

  // 5. Debounced Disk Write (Rule 2: 500ms write directly to disk, dirtying worktree)
  const handleDebouncedSave = async (relPath: string, newContent: string) => {
    try {
      const fullPath = `${vaultPath}/${relPath}`;
      await GitVaultBridge.writeFileContent(fullPath, newContent);
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
        showToast("Line-level conflict detected! Opened Visual Conflict Resolver.", "info");
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

  // 10. File Management (Create, Delete, Rename)
  const handleCreateFile = async (name: string) => {
    try {
      await GitVaultBridge.createFile(vaultPath, name);
      await Promise.all([refreshFiles(), refreshStatus()]);
      handleSelectFile(name);
      showToast(`Created ${name}`, "success");
    } catch (err) {
      showToast(`Failed to create file: ${err}`, "error");
    }
  };

  const handleDeleteFile = async (relPath: string) => {
    try {
      await GitVaultBridge.deleteFile(vaultPath, relPath);
      if (activeFilePath === relPath) {
        setActiveFilePath(null);
        setActiveFileContent("");
      }
      await Promise.all([refreshFiles(), refreshStatus()]);
      showToast(`Deleted ${relPath}`, "info");
    } catch (err) {
      showToast(`Failed to delete file: ${err}`, "error");
    }
  };

  const handleRenameFile = async (oldPath: string, newPath: string) => {
    try {
      await GitVaultBridge.renameFile(vaultPath, oldPath, newPath);
      if (activeFilePath === oldPath) {
        setActiveFilePath(newPath);
      }
      await Promise.all([refreshFiles(), refreshStatus()]);
      showToast(`Renamed to ${newPath}`, "success");
    } catch (err) {
      showToast(`Failed to rename: ${err}`, "error");
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
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-[#0d1117] text-white select-none">
      {/* Top Bar with Live Git Status Pill & Save/Sync Actions */}
      <TopBar
        status={status}
        isLoading={isLoading}
        onSave={handleSaveAndPush}
        onSync={handleSyncAndPull}
        onFetch={handleFetchRemote}
        onSimulateState={handleSimulateState}
      />

      {/* Main Workspace (Sidebar + CodeMirror Editor) */}
      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar File Tree with Live Git Status Badges */}
        <Sidebar
          files={files}
          fileStatuses={status?.files || []}
          activeFilePath={activeFilePath}
          onSelectFile={handleSelectFile}
          onCreateFile={handleCreateFile}
          onDeleteFile={handleDeleteFile}
          onRenameFile={handleRenameFile}
        />

        {/* CodeMirror 6 Markdown Editor */}
        <main className="flex-1 flex flex-col h-full overflow-hidden">
          <Editor
            filePath={activeFilePath}
            initialContent={activeFileContent}
            onDebouncedSave={handleDebouncedSave}
            debounceMs={500}
          />
        </main>
      </div>

      {/* Visual 3-Way Conflict Resolver Modal */}
      <ConflictResolverModal
        conflicts={conflictedFiles}
        isOpen={isConflictModalOpen}
        onClose={() => setIsConflictModalOpen(false)}
        onApplyResolutions={handleApplyResolutions}
      />

      {/* Toast Notification Notification Pill */}
      {toastMessage && (
        <div
          className={`fixed bottom-5 right-5 z-50 px-4 py-2.5 rounded-xl shadow-2xl border text-xs font-medium flex items-center gap-2 transition-all transform animate-bounce ${
            toastMessage.type === "success"
              ? "bg-emerald-950/90 text-emerald-300 border-emerald-500/40"
              : toastMessage.type === "error"
              ? "bg-red-950/90 text-red-300 border-red-500/40"
              : "bg-sky-950/90 text-sky-300 border-sky-500/40"
          }`}
        >
          <span>{toastMessage.text}</span>
        </div>
      )}
    </div>
  );
}
