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
  remote_url: string | null;
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
  remote_url: string | null;
}

export interface VaultConfig {
  vault_path: string;
  remote_url: string | null;
  branch: string;
  user_name: string | null;
  user_email: string | null;
  has_token: boolean;
}

export interface VaultConfigInput {
  remote_url?: string;
  branch?: string;
  user_name?: string;
  user_email?: string;
  github_token?: string;
}

export interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string;
  email: string | null;
  html_url: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  clone_url: string;
  default_branch: string;
  description: string | null;
  updated_at: string;
}

export interface ConnectVaultInput {
  vault_path: string;
  remote_url: string;
  branch?: string;
  github_token?: string;
  user_name?: string;
  user_email?: string;
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface DeviceTokenResponse {
  status: "approved" | "pending" | "slow_down" | "expired" | "denied" | "error";
  access_token?: string;
  token_type?: string;
  scope?: string;
  interval?: number;
  error_description?: string;
}


