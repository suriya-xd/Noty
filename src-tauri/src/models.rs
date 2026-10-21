use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub enum SyncState {
    CleanSynced,
    DirtySynced,
    CleanBehind,
    DirtyBehind,
    AheadOffline,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FileStatus {
    pub path: String,
    pub is_modified: bool,      // Local worktree modified (• badge)
    pub is_untracked: bool,     // New local file (+ badge)
    pub has_remote_update: bool, // Changed between HEAD and origin/main (↓ badge)
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RepoStatusPayload {
    pub state: SyncState,
    pub dirty_count: usize,
    pub behind_count: usize,
    pub ahead_count: usize,
    pub branch: String,
    pub remote_name: Option<String>,
    pub files: Vec<FileStatus>,
    pub last_synced_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConflictHunk {
    pub id: String,
    pub base_lines: String,
    pub local_lines: String,
    pub remote_lines: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConflictFile {
    pub path: String,
    pub base_content: String,   // Content at HEAD
    pub local_content: String,  // Unsaved content on disk
    pub remote_content: String, // Content at origin/main
    pub hunks: Vec<ConflictHunk>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncResult {
    pub success: bool,
    pub message: String,
    pub state: SyncState,
    pub conflicts: Vec<ConflictFile>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConflictResolution {
    pub path: String,
    pub resolution_type: String, // "local", "remote", "custom"
    pub custom_content: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VaultEntry {
    pub path: String,       // Relative path from vault root
    pub name: String,       // File or directory name
    pub is_directory: bool,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VaultInfo {
    pub path: String,
    pub name: String,
    pub is_git_repo: bool,
}
