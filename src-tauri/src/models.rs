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
    pub not_uploaded: bool,     // Changed here and not in the cloud copy yet
    pub has_remote_update: bool, // Changed between HEAD and the cloud copy (↓ badge)
    /// Changed here and on another device in the same lines; held until a version is chosen.
    pub conflict: bool,
    /// The note was open when another device changed it; the update waits for the banner.
    pub update_waiting: bool,
    /// Combined automatically with another device's changes; this device's version can be restored.
    pub merged: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RepoStatusPayload {
    pub state: SyncState,
    pub dirty_count: usize,
    pub behind_count: usize,
    pub ahead_count: usize,
    /// A note changed here and on another device; a version has to be chosen.
    pub has_conflict: bool,
    /// Other workspaces with commits that aren't in the cloud yet.
    pub other_workspaces_not_uploaded: Vec<String>,
    /// The open workspace (a branch). Empty until one is created or chosen.
    pub branch: String,
    pub remote_name: Option<String>,
    pub remote_url: Option<String>,
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
    pub base_content: String,   // Content before either change
    pub local_content: String,  // Content on this device
    pub remote_content: String, // Content in the cloud copy
    pub local_deleted: bool,    // Deleted on this device
    pub remote_deleted: bool,   // Deleted on another device
    /// Which cloud version was shown, so a newer one is never resolved unseen.
    pub remote_id: String,
    pub hunks: Vec<ConflictHunk>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncResult {
    pub success: bool,
    pub message: String,
    pub state: SyncState,
    /// Notes waiting for a version to be chosen. The resolver opens only when the user asks.
    pub conflicts: Vec<ConflictFile>,
    /// Things worth telling the user, such as a deleted note that came back.
    pub notices: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ConflictResolution {
    pub path: String,
    pub resolution_type: String, // "local", "remote", "custom"
    pub custom_content: Option<String>,
    /// The `remote_id` of the conflict that was shown.
    #[serde(default)]
    pub remote_id: Option<String>,
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
    pub remote_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VaultConfig {
    pub vault_path: String,
    pub remote_url: Option<String>,
    pub branch: String,
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    pub has_token: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorkspaceList {
    /// The open workspace; `None` until one is created or chosen.
    pub current: Option<String>,
    pub workspaces: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct VaultConfigInput {
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    pub github_token: Option<String>,
}
