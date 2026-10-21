export type SyncState =
  | "CleanSynced"
  | "DirtySynced"
  | "CleanBehind"
  | "DirtyBehind"
  | "AheadOffline";

export interface FileStatus {
  path: string;
  is_modified: boolean;
  is_untracked: boolean;
  has_remote_update: boolean;
}

export interface RepoStatusPayload {
  state: SyncState;
  dirty_count: usize;
  behind_count: usize;
  ahead_count: usize;
  branch: string;
  remote_name: string | null;
  files: FileStatus[];
  last_synced_at?: string;
}

export type usize = number;

export interface ConflictHunk {
  id: string;
  base_lines: string;
  local_lines: string;
  remote_lines: string;
}

export interface ConflictFile {
  path: string;
  base_content: string;
  local_content: string;
  remote_content: string;
  hunks: ConflictHunk[];
}

export interface SyncResult {
  success: boolean;
  message: string;
  state: SyncState;
  conflicts: ConflictFile[];
}

export interface ConflictResolution {
  path: string;
  resolution_type: "local" | "remote" | "custom";
  custom_content?: string;
}

export interface VaultEntry {
  path: string;
  name: string;
  is_directory: boolean;
  size_bytes: number;
  modified_ms: number;
}

export interface VaultInfo {
  path: string;
  name: string;
  is_git_repo: boolean;
}
