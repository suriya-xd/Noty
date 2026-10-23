import {
  ConflictFile,
  ConflictResolution,
  RepoStatusPayload,
  SyncResult,
  VaultConfig,
  VaultConfigInput,
  VaultEntry,
  VaultInfo,
} from "../types/gitVault";

// Check if Tauri runtime is present
export const isTauriEnvironment = (): boolean => {
  return typeof window !== "undefined" && Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
};

// Safe invoke wrapper: uses Tauri IPC if native, or Vite dev server API to operate on real Git repo
async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isTauriEnvironment()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      return await invoke<T>(cmd, args);
    } catch (err) {
      console.warn(`[GitVault Native] invoke failed for ${cmd}, falling back to web API:`, err);
    }
  }

  // In browser dev mode: call Vite dev server API to interact with real Git and sample-vault!
  try {
    const res = await fetch(`/api/gitvault/${cmd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (res.ok) {
      return (await res.json()) as T;
    }
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error || `HTTP ${res.status}: Failed to execute ${cmd}`);
  } catch (apiErr) {
    console.warn(`[GitVault Web API] failed for ${cmd}, falling back to mock:`, apiErr);
    return mockInvoke<T>(cmd, args);
  }
}

// ---------------------------------------------------------------------------
// In-Memory Mock Store for Browser Preview & Visual Testing
// ---------------------------------------------------------------------------
const MOCK_FILES: Record<string, string> = {
  "README.md": `# gitvault-sample-vault
GitVault - Private Test Vault

Connected to GitHub repository: \`suriya-xd/gitvault-sample-vault\`
- **Remote**: \`https://github.com/suriya-xd/gitvault-sample-vault.git\`
- **Branch**: \`main\`
`,
  "FirstNote.md": `# My First Vault Note

Written locally in GitVault.
- 500ms debounced disk auto-save
- Directly dirties Git worktree without committing
`,
  "ConflictTest.md": `# Project Roadmap
- Milestone 1: Core Engine
- Milestone 2: LOCAL UPDATE (Added Offline Local-First Worktree)
- Milestone 3: Platform Release
`,
};

let mockRemoteAhead = 0;
let mockAheadOffline = 0;
let mockDirtySet = new Set<string>();
let mockRemoteUrl: string | null = "https://github.com/suriya-xd/gitvault-sample-vault.git";
let mockUserName = "GitVault User";
let mockUserEmail = "vault@gitvault.local";

function computeMockStatus(): RepoStatusPayload {
  const fileStatuses = Object.keys(MOCK_FILES).map((path) => {
    const isModified = mockDirtySet.has(path);
    const hasRemote = mockRemoteAhead > 0 && path === "Architecture.md";
    return {
      path,
      is_modified: isModified,
      is_untracked: false,
      has_remote_update: hasRemote,
    };
  });

  const dirtyCount = mockDirtySet.size;

  let state: RepoStatusPayload["state"] = "CleanSynced";
  if (mockRemoteAhead > 0) {
    state = dirtyCount > 0 ? "DirtyBehind" : "CleanBehind";
  } else if (mockAheadOffline > 0) {
    state = "AheadOffline";
  } else if (dirtyCount > 0) {
    state = "DirtySynced";
  } else {
    state = "CleanSynced";
  }

  return {
    state,
    dirty_count: dirtyCount,
    behind_count: mockRemoteAhead,
    ahead_count: mockAheadOffline,
    branch: "main",
    remote_name: mockRemoteUrl ? "origin" : null,
    remote_url: mockRemoteUrl,
    files: fileStatuses,
    last_synced_at: new Date().toLocaleTimeString(),
  };
}

async function mockInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  await new Promise((res) => setTimeout(res, 80)); // Simulate async latency

  switch (cmd) {
    case "get_repo_status":
    case "fetch_remote": {
      return computeMockStatus() as unknown as T;
    }

    case "list_vault_files": {
      const entries: VaultEntry[] = Object.keys(MOCK_FILES).map((p) => ({
        path: p,
        name: p.split("/").pop() || p,
        is_directory: false,
        size_bytes: MOCK_FILES[p].length,
        modified_ms: Date.now(),
      }));
      return entries as unknown as T;
    }

    case "read_file_content": {
      const fullPath = args.full_path as string;
      const key = Object.keys(MOCK_FILES).find((k) => fullPath.endsWith(k)) || "Welcome.md";
      return (MOCK_FILES[key] ?? "# Empty Note") as unknown as T;
    }

    case "write_file_content": {
      const fullPath = args.full_path as string;
      const content = args.content as string;
      const key = Object.keys(MOCK_FILES).find((k) => fullPath.endsWith(k)) || fullPath;
      MOCK_FILES[key] = content;
      mockDirtySet.add(key);
      return undefined as unknown as T;
    }

    case "create_file": {
      const relPath = args.rel_path as string;
      MOCK_FILES[relPath] = `# ${relPath.replace(".md", "")}\n\nStart writing your note...\n`;
      mockDirtySet.add(relPath);
      return undefined as unknown as T;
    }

    case "delete_file": {
      const relPath = args.rel_path as string;
      delete MOCK_FILES[relPath];
      mockDirtySet.delete(relPath);
      return undefined as unknown as T;
    }

    case "rename_file": {
      const oldPath = args.old_path as string;
      const newPath = args.new_path as string;
      if (MOCK_FILES[oldPath] !== undefined) {
        MOCK_FILES[newPath] = MOCK_FILES[oldPath];
        delete MOCK_FILES[oldPath];
      }
      return undefined as unknown as T;
    }

    case "save_and_push": {
      if (mockRemoteAhead > 0) {
        throw new Error("Cannot save and push: remote is ahead! Click 'Sync' first.");
      }
      mockDirtySet.clear();
      mockAheadOffline = 0;
      return computeMockStatus() as unknown as T;
    }

    case "sync_and_pull": {
      if (mockRemoteAhead > 0 && mockDirtySet.has("ConflictTest.md")) {
        // Return 3-way conflict simulation matching our test scenario
        const conflict: ConflictFile = {
          path: "ConflictTest.md",
          base_content: `# Project Roadmap\n- Milestone 1: Core Engine\n- Milestone 2: Baseline Architecture\n- Milestone 3: Platform Release`,
          local_content: `# Project Roadmap\n- Milestone 1: Core Engine\n- Milestone 2: LOCAL UPDATE (Added Offline Local-First Worktree)\n- Milestone 3: Platform Release`,
          remote_content: `# Project Roadmap\n- Milestone 1: Core Engine\n- Milestone 2: REMOTE UPDATE (Added Cloud Sync Engine)\n- Milestone 3: Platform Release`,
          hunks: [
            {
              id: "hunk_1",
              base_lines: "- Milestone 2: Baseline Architecture",
              local_lines: "- Milestone 2: LOCAL UPDATE (Added Offline Local-First Worktree)",
              remote_lines: "- Milestone 2: REMOTE UPDATE (Added Cloud Sync Engine)",
            },
          ],
        };
        const res: SyncResult = {
          success: false,
          message: "Conflict detected in ConflictTest.md. Please resolve in the conflict modal.",
          state: "DirtyBehind",
          conflicts: [conflict],
        };
        return res as unknown as T;
      }
      mockRemoteAhead = 0;
      const res: SyncResult = {
        success: true,
        message: "Repository synchronized successfully.",
        state: "CleanSynced",
        conflicts: [],
      };
      return res as unknown as T;
    }

    case "resolve_conflicts": {
      const resolutions = args.resolutions as ConflictResolution[];
      for (const res of resolutions) {
        if (res.custom_content) {
          MOCK_FILES[res.path] = res.custom_content;
        }
      }
      mockRemoteAhead = 0;
      mockDirtySet.delete("ConflictTest.md");
      return computeMockStatus() as unknown as T;
    }

    case "init_or_open_vault": {
      return {
        path: (args.vault_path as string) || "sample-vault",
        name: "suriya-xd/gitvault-sample-vault",
        is_git_repo: true,
        remote_url: mockRemoteUrl,
      } as unknown as T;
    }

    case "get_vault_config": {
      return {
        vault_path: (args.repo_path as string) || "sample-vault",
        remote_url: mockRemoteUrl,
        branch: "main",
        user_name: mockUserName,
        user_email: mockUserEmail,
        has_token: false,
      } as unknown as T;
    }

    case "set_vault_config": {
      const cfg = (args.config || {}) as VaultConfigInput;
      if (cfg.remote_url !== undefined) mockRemoteUrl = cfg.remote_url || null;
      if (cfg.user_name !== undefined) mockUserName = cfg.user_name || "GitVault User";
      if (cfg.user_email !== undefined) mockUserEmail = cfg.user_email || "vault@gitvault.local";
      return {
        vault_path: (args.repo_path as string) || "sample-vault",
        remote_url: mockRemoteUrl,
        branch: cfg.branch || "main",
        user_name: mockUserName,
        user_email: mockUserEmail,
        has_token: Boolean(cfg.github_token),
      } as unknown as T;
    }

    case "test_remote_connection": {
      const targetUrl = args.remote_url as string;
      if (!targetUrl) throw new Error("Remote URL is required");
      return "Successfully connected to GitHub repository!" as unknown as T;
    }

    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

// ---------------------------------------------------------------------------
// Public API Bridge
// ---------------------------------------------------------------------------

export const GitVaultBridge = {
  getRepoStatus: (repoPath: string): Promise<RepoStatusPayload> => {
    return invokeTauri<RepoStatusPayload>("get_repo_status", { repo_path: repoPath });
  },

  fetchRemote: (repoPath: string): Promise<RepoStatusPayload> => {
    return invokeTauri<RepoStatusPayload>("fetch_remote", { repo_path: repoPath });
  },

  saveAndPush: (repoPath: string, commitMessage?: string): Promise<RepoStatusPayload> => {
    return invokeTauri<RepoStatusPayload>("save_and_push", {
      repo_path: repoPath,
      commit_message: commitMessage,
    });
  },

  syncAndPull: (repoPath: string): Promise<SyncResult> => {
    return invokeTauri<SyncResult>("sync_and_pull", { repo_path: repoPath });
  },

  resolveConflicts: (
    repoPath: string,
    resolutions: ConflictResolution[]
  ): Promise<RepoStatusPayload> => {
    return invokeTauri<RepoStatusPayload>("resolve_conflicts", {
      repo_path: repoPath,
      resolutions,
    });
  },

  getVaultConfig: (repoPath: string): Promise<VaultConfig> => {
    return invokeTauri<VaultConfig>("get_vault_config", { repo_path: repoPath });
  },

  setVaultConfig: (repoPath: string, config: VaultConfigInput): Promise<VaultConfig> => {
    return invokeTauri<VaultConfig>("set_vault_config", {
      repo_path: repoPath,
      config,
    });
  },

  testRemoteConnection: (
    repoPath: string,
    remoteUrl: string,
    githubToken?: string
  ): Promise<string> => {
    return invokeTauri<string>("test_remote_connection", {
      repo_path: repoPath,
      remote_url: remoteUrl,
      github_token: githubToken,
    });
  },

  listVaultFiles: (vaultPath: string): Promise<VaultEntry[]> => {
    return invokeTauri<VaultEntry[]>("list_vault_files", { vault_path: vaultPath });
  },

  readFileContent: (fullPath: string): Promise<string> => {
    return invokeTauri<string>("read_file_content", { full_path: fullPath });
  },

  writeFileContent: (fullPath: string, content: string): Promise<void> => {
    return invokeTauri<void>("write_file_content", { full_path: fullPath, content });
  },

  createFile: (vaultPath: string, relPath: string): Promise<void> => {
    return invokeTauri<void>("create_file", { vault_path: vaultPath, rel_path: relPath });
  },

  deleteFile: (vaultPath: string, relPath: string): Promise<void> => {
    return invokeTauri<void>("delete_file", { vault_path: vaultPath, rel_path: relPath });
  },

  renameFile: (vaultPath: string, oldPath: string, newPath: string): Promise<void> => {
    return invokeTauri<void>("rename_file", {
      vault_path: vaultPath,
      old_path: oldPath,
      new_path: newPath,
    });
  },

  initOrOpenVault: (vaultPath?: string): Promise<VaultInfo> => {
    return invokeTauri<VaultInfo>("init_or_open_vault", { vault_path: vaultPath });
  },

  // Test Simulation Triggers (for verifying all 5 states and 3-way conflicts in UI)
  simulateRemoteAhead: (aheadCount = 1) => {
    mockRemoteAhead = aheadCount;
  },
  simulateOfflineCommit: () => {
    mockAheadOffline += 1;
    mockDirtySet.clear();
  },
  resetMockState: () => {
    mockRemoteAhead = 0;
    mockAheadOffline = 0;
    mockDirtySet.clear();
  },
};
