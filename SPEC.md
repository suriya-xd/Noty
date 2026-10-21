# GitVault — Technical Specification & MVP Architecture

## 1. System Overview
GitVault is a cross-platform Markdown note-taking application (Windows, macOS, Android) built on **Tauri v2**, **React (Vite + Tailwind CSS)**, **CodeMirror 6**, and a **Rust (`git2`)** backend. A GitHub repository acts as the single source of truth and local vault.

## 2. Git Worktree State Machine
Local edits are written directly to disk (debounced 500ms) without committing. Git's native working tree and commit pointers drive the UI state.

### 2.1 State Definitions
The Rust backend periodically runs a read-only `git fetch origin` and computes the repository state:

1. **`CLEAN_SYNCED`**: Worktree clean, `HEAD == origin/main`
   - UI: 🟢 "Up to date" | Save: Disabled | Sync: Disabled
2. **`DIRTY_SYNCED`**: Worktree has modified/untracked files, `HEAD == origin/main`
   - UI: 🟡 "Unsaved changes (N)" | Save: Active | Sync: Disabled
3. **`CLEAN_BEHIND`**: Worktree clean, `HEAD < origin/main`
   - UI: 🔵 "Out of sync (N incoming)" | Save: Disabled | Sync: Active
4. **`DIRTY_BEHIND`**: Worktree dirty, `HEAD < origin/main`
   - UI: 🟠 "Out of sync + Unsaved edits" | Save: Blocked (Prompts Sync first) | Sync: Active
5. **`AHEAD_OFFLINE`**: Worktree clean/dirty, `HEAD > origin/main` (Committed while offline)
   - UI: 🟣 "Saved locally (Offline)" | Save/Push: Active when online

---

## 3. Rust Tauri Commands (`src-tauri/src/git_engine.rs`)

### 3.1 Data Structures
```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum SyncState {
    CleanSynced,
    DirtySynced,
    CleanBehind,
    DirtyBehind,
    AheadOffline,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct FileStatus {
    pub path: String,
    pub is_modified: bool,      // Local worktree modified (• badge)
    pub is_untracked: bool,     // New local file (+ badge)
    pub has_remote_update: bool // Changed between HEAD and origin/main (↓ badge)
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct RepoStatusPayload {
    pub state: SyncState,
    pub dirty_count: usize,
    pub behind_count: usize,
    pub ahead_count: usize,
    pub files: Vec<FileStatus>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ConflictHunk {
    pub base_lines: String,
    pub local_lines: String,
    pub remote_lines: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct ConflictFile {
    pub path: String,
    pub base_content: String,   // Content at HEAD
    pub local_content: String,  // Unsaved content on disk
    pub remote_content: String, // Content at origin/main
    pub hunks: Vec<ConflictHunk>,
}
```

### 3.2 Core Commands
- `get_repo_status(repo_path: String) -> Result<RepoStatusPayload, String>`
- `fetch_remote(repo_path: String) -> Result<RepoStatusPayload, String>`
- `save_and_push(repo_path: String, commit_message: Option<String>) -> Result<RepoStatusPayload, String>`
- `sync_and_pull(repo_path: String) -> Result<SyncResult, String>`
- `resolve_conflicts(repo_path: String, resolutions: Vec<ConflictResolution>) -> Result<RepoStatusPayload, String>`
- `read_file_content(file_path: String) -> Result<String, String>`
- `write_file_content(file_path: String, content: String) -> Result<(), String>`
- `list_vault_files(repo_path: String) -> Result<Vec<VaultEntry>, String>`
