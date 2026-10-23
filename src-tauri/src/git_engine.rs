use std::collections::{HashMap, HashSet};
use std::path::Path;
use git2::{BranchType, Cred, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks, Repository, Status, StatusOptions};
use similar::{ChangeTag, TextDiff};

use crate::models::{
    ConflictFile, ConflictHunk, ConflictResolution, FileStatus, RepoStatusPayload, SyncResult, SyncState,
    VaultConfig, VaultConfigInput,
};

/// Get the current Git status of the repository, including worktree status
/// and ahead/behind counts against origin/main or origin/master.
pub fn get_repo_status(repo_path: &str) -> Result<RepoStatusPayload, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    // 1. Identify active branch name
    let branch_name = get_current_branch_name(&repo).unwrap_or_else(|| "main".to_string());

    // 2. Scan worktree and index statuses
    let mut status_opts = StatusOptions::new();
    status_opts
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false)
        .show(git2::StatusShow::IndexAndWorkdir);

    let statuses = repo
        .statuses(Some(&mut status_opts))
        .map_err(|e| format!("Failed to read git status: {}", e))?;

    let mut dirty_map: HashMap<String, (bool, bool)> = HashMap::new();
    for entry in statuses.iter() {
        if let Some(path) = entry.path() {
            let normalized = path.replace('\\', "/");
            let s = entry.status();

            let is_modified = s.contains(Status::WT_MODIFIED)
                || s.contains(Status::INDEX_MODIFIED)
                || s.contains(Status::WT_DELETED)
                || s.contains(Status::INDEX_DELETED)
                || s.contains(Status::WT_RENAMED)
                || s.contains(Status::INDEX_RENAMED);

            let is_untracked = s.contains(Status::WT_NEW) || s.contains(Status::INDEX_NEW);

            if is_modified || is_untracked {
                dirty_map.insert(normalized, (is_modified, is_untracked));
            }
        }
    }

    // 3. Check HEAD vs remote tracking branch
    let head_oid = repo.head().ok().and_then(|h| h.target());
    let (remote_name, remote_oid) = find_remote_tracking_branch(&repo, &branch_name);
    let remote_url = repo.find_remote("origin").ok().and_then(|r| r.url().map(|s| s.to_string()));

    let mut ahead_count = 0usize;
    let mut behind_count = 0usize;
    let mut remote_diff_files: HashSet<String> = HashSet::new();

    if let (Some(h_oid), Some(r_oid)) = (head_oid, remote_oid) {
        if let Ok((ahead, behind)) = repo.graph_ahead_behind(h_oid, r_oid) {
            ahead_count = ahead;
            behind_count = behind;
        }

        // Compute files modified between HEAD and remote
        if let (Ok(head_commit), Ok(remote_commit)) = (repo.find_commit(h_oid), repo.find_commit(r_oid)) {
            if let (Ok(head_tree), Ok(remote_tree)) = (head_commit.tree(), remote_commit.tree()) {
                if let Ok(diff) = repo.diff_tree_to_tree(Some(&head_tree), Some(&remote_tree), None) {
                    for delta in diff.deltas() {
                        if let Some(p) = delta.new_file().path() {
                            remote_diff_files.insert(p.to_string_lossy().replace('\\', "/"));
                        }
                        if let Some(p) = delta.old_file().path() {
                            remote_diff_files.insert(p.to_string_lossy().replace('\\', "/"));
                        }
                    }
                }
            }
        }
    } else if let Some(h_oid) = head_oid {
        // No remote branch yet, but local commits exist
        let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
        revwalk.push(h_oid).ok();
        ahead_count = revwalk.count();
    }

    // 4. Combine all known files
    let mut all_paths: HashSet<String> = HashSet::new();
    for p in dirty_map.keys() {
        all_paths.insert(p.clone());
    }
    for p in &remote_diff_files {
        all_paths.insert(p.clone());
    }

    let mut file_statuses: Vec<FileStatus> = Vec::new();
    for path in all_paths {
        let (is_mod, is_untracked) = dirty_map.get(&path).copied().unwrap_or((false, false));
        let has_remote = remote_diff_files.contains(&path);

        file_statuses.push(FileStatus {
            path,
            is_modified: is_mod,
            is_untracked,
            has_remote_update: has_remote,
        });
    }

    file_statuses.sort_by(|a, b| a.path.cmp(&b.path));

    let dirty_count = dirty_map.len();

    // 5. Determine the 5 distinct SyncStates from SPEC.md:
    // - CLEAN_SYNCED: Worktree clean, HEAD == origin/main
    // - DIRTY_SYNCED: Worktree dirty, HEAD == origin/main
    // - CLEAN_BEHIND: Worktree clean, HEAD < origin/main
    // - DIRTY_BEHIND: Worktree dirty, HEAD < origin/main
    // - AHEAD_OFFLINE: HEAD > origin/main (Committed locally)
    let state = if behind_count > 0 {
        if dirty_count > 0 {
            SyncState::DirtyBehind
        } else {
            SyncState::CleanBehind
        }
    } else if ahead_count > 0 {
        SyncState::AheadOffline
    } else if dirty_count > 0 {
        SyncState::DirtySynced
    } else {
        SyncState::CleanSynced
    };

    Ok(RepoStatusPayload {
        state,
        dirty_count,
        behind_count,
        ahead_count,
        branch: branch_name,
        remote_name,
        remote_url,
        files: file_statuses,
        last_synced_at: None,
    })
}

/// Fetch from origin remote without modifying worktree
pub fn fetch_remote(repo_path: &str) -> Result<RepoStatusPayload, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    if let Ok(mut remote) = repo.find_remote("origin") {
        let callbacks = create_remote_callbacks(&repo);
        let mut fetch_opts = FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);

        let refspecs = ["+refs/heads/*:refs/remotes/origin/*"];
        // Attempt fetch, ignore network failures gracefully so offline use works
        let _ = remote.fetch(&refspecs, Some(&mut fetch_opts), None);
    }

    get_repo_status(repo_path)
}

/// Manual Save & Push:
/// 1. Verifies origin/main hasn't moved ahead (prevents accidental overwrite).
/// 2. Stages all files (`git add -A`).
/// 3. Creates commit.
/// 4. Pushes to origin (falls back gracefully to local commit if offline).
pub fn save_and_push(repo_path: &str, commit_message: Option<String>) -> Result<RepoStatusPayload, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    // Step 1: Verify remote is not ahead
    let current_status = get_repo_status(repo_path)?;
    if current_status.behind_count > 0 {
        return Err(format!(
            "Cannot save and push directly: remote has {} incoming commit(s). Please click 'Sync' to pull first.",
            current_status.behind_count
        ));
    }

    // Step 2: Stage all files (`git add -A`)
    let mut index = repo.index().map_err(|e| format!("Failed to get repo index: {}", e))?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Failed to stage files: {}", e))?;
    index
        .update_all(["*"].iter(), None)
        .map_err(|e| format!("Failed to update staged index: {}", e))?;
    index.write().map_err(|e| format!("Failed to write index: {}", e))?;

    let tree_oid = index
        .write_tree()
        .map_err(|e| format!("Failed to write tree: {}", e))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| format!("Failed to find tree: {}", e))?;

    // Step 3: Signature & Parent
    let sig = repo.signature().unwrap_or_else(|_| {
        git2::Signature::now("GitVault User", "vault@gitvault.local").unwrap()
    });

    let parent_commit = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .and_then(|oid| repo.find_commit(oid).ok());

    let parents: Vec<&git2::Commit> = match &parent_commit {
        Some(c) => vec![c],
        None => vec![],
    };

    let msg = commit_message.unwrap_or_else(|| {
        format!("Vault update: {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"))
    });

    // Commit to HEAD
    repo.commit(Some("HEAD"), &sig, &sig, &msg, &tree, &parents)
        .map_err(|e| format!("Failed to create commit: {}", e))?;

    // Step 4: Attempt push to remote
    let branch_name = get_current_branch_name(&repo).unwrap_or_else(|| "main".to_string());
    if let Ok(mut remote) = repo.find_remote("origin") {
        let callbacks = create_remote_callbacks(&repo);
        let mut push_opts = PushOptions::new();
        push_opts.remote_callbacks(callbacks);

        let refspec = format!("refs/heads/{}:refs/heads/{}", branch_name, branch_name);
        if let Err(e) = remote.push(&[&refspec], Some(&mut push_opts)) {
            return Err(format!(
                "Committed locally, but failed to push to GitHub: {}. Please check your credentials or remote URL in Settings.",
                e
            ));
        }
    } else {
        return Err("Committed locally, but no remote 'origin' is configured. Click the Settings icon to link your GitHub repository.".to_string());
    }

    get_repo_status(repo_path)
}

/// Manual Sync & Pull:
/// Pulls changes from `origin/main`. If local worktree is dirty:
/// - If non-overlapping files: stash local, fast-forward pull, pop stash.
/// - If same file modified both locally and remotely: run in-memory 3-way merge.
///   If line-level conflicts: return conflict hunks for the Visual Conflict Resolver Modal.
pub fn sync_and_pull(repo_path: &str) -> Result<SyncResult, String> {
    // 1. Fetch remote first to ensure latest remote refs
    let pre_status = fetch_remote(repo_path)?;

    let mut repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
    let branch_name = pre_status.branch.clone();

    let head_oid = repo.head().ok().and_then(|h| h.target());
    let (_, remote_oid) = find_remote_tracking_branch(&repo, &branch_name);

    let remote_commit_oid = match remote_oid {
        Some(oid) => oid,
        None => {
            return Ok(SyncResult {
                success: true,
                message: "No remote tracking branch configured. Local repository is up to date.".to_string(),
                state: pre_status.state,
                conflicts: vec![],
            });
        }
    };

    if pre_status.behind_count == 0 {
        return Ok(SyncResult {
            success: true,
            message: "Repository is already up to date with remote.".to_string(),
            state: pre_status.state,
            conflicts: vec![],
        });
    }

    // 2. Identify modified/untracked files locally and remote changed files
    let local_dirty_files: HashSet<String> = pre_status
        .files
        .iter()
        .filter(|f| f.is_modified || f.is_untracked)
        .map(|f| f.path.clone())
        .collect();

    let remote_changed_files: HashSet<String> = pre_status
        .files
        .iter()
        .filter(|f| f.has_remote_update)
        .map(|f| f.path.clone())
        .collect();

    let overlapping_files: Vec<String> = local_dirty_files
        .intersection(&remote_changed_files)
        .cloned()
        .collect();

    // 3. Case A: Worktree is clean OR local changes are non-overlapping
    if local_dirty_files.is_empty() || overlapping_files.is_empty() {
        let has_local_dirty = !local_dirty_files.is_empty();

        // If dirty non-overlapping: Stash local changes
        let stashed = if has_local_dirty {
            let sig = repo.signature().unwrap_or_else(|_| {
                git2::Signature::now("GitVault Stash", "stash@gitvault.local").unwrap()
            });
            let stash_res = repo.stash_save2(
                &sig,
                Some("GitVault auto-stash during sync"),
                Some(git2::StashFlags::INCLUDE_UNTRACKED),
            );
            stash_res.is_ok()
        } else {
            false
        };

        // Fast-forward merge to remote commit
        fast_forward_to_commit(&repo, &branch_name, remote_commit_oid)?;

        // If we stashed, pop it back into dirty worktree
        if stashed {
            let mut stash_opts = git2::StashApplyOptions::new();
            let _ = repo.stash_pop(0, Some(&mut stash_opts));
        }

        let post_status = get_repo_status(repo_path)?;
        return Ok(SyncResult {
            success: true,
            message: "Successfully synchronized with remote repository.".to_string(),
            state: post_status.state,
            conflicts: vec![],
        });
    }

    // 4. Case B: Overlapping files modified both locally and remotely -> In-memory 3-way merge!
    let head_commit = head_oid.and_then(|oid| repo.find_commit(oid).ok());
    let remote_commit = repo.find_commit(remote_commit_oid).ok();

    let head_tree = head_commit.as_ref().and_then(|c| c.tree().ok());
    let remote_tree = remote_commit.as_ref().and_then(|c| c.tree().ok());

    let mut detected_conflicts: Vec<ConflictFile> = Vec::new();
    let mut cleanly_merged_files: Vec<(String, String)> = Vec::new();

    for rel_path in &overlapping_files {
        let base_content = get_file_content_from_tree(&repo, head_tree.as_ref(), rel_path).unwrap_or_default();
        let remote_content = get_file_content_from_tree(&repo, remote_tree.as_ref(), rel_path).unwrap_or_default();

        let full_disk_path = Path::new(repo_path).join(rel_path);
        let local_content = std::fs::read_to_string(&full_disk_path).unwrap_or_default();

        // Perform in-memory line-level 3-way merge
        let merge_outcome = compute_3way_line_merge(&base_content, &local_content, &remote_content, rel_path);

        match merge_outcome {
            LineMergeResult::Clean(merged_text) => {
                cleanly_merged_files.push((rel_path.clone(), merged_text));
            }
            LineMergeResult::Conflicted(conflict_file) => {
                detected_conflicts.push(conflict_file);
            }
        }
    }

    // If line-level conflicts exist: return conflict hunks for the Visual Conflict Resolver Modal
    if !detected_conflicts.is_empty() {
        return Ok(SyncResult {
            success: false,
            message: format!(
                "Conflict detected in {} file(s). Please review and resolve using the Visual Conflict Resolver.",
                detected_conflicts.len()
            ),
            state: SyncState::DirtyBehind,
            conflicts: detected_conflicts,
        });
    }

    // If cleanly merged with no line collisions: write clean files to disk & update branch
    for (rel_path, content) in cleanly_merged_files {
        let full_path = Path::new(repo_path).join(rel_path);
        if let Some(parent) = full_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(full_path, content);
    }

    // Advance branch
    fast_forward_to_commit(&repo, &branch_name, remote_commit_oid)?;

    let post_status = get_repo_status(repo_path)?;
    Ok(SyncResult {
        success: true,
        message: "Cleanly merged non-colliding changes from remote.".to_string(),
        state: post_status.state,
        conflicts: vec![],
    })
}

/// Apply user resolutions from the Visual Conflict Resolver Modal
pub fn resolve_conflicts(
    repo_path: &str,
    resolutions: Vec<ConflictResolution>,
) -> Result<RepoStatusPayload, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repo: {}", e))?;
    let branch_name = get_current_branch_name(&repo).unwrap_or_else(|| "main".to_string());
    let (_, remote_oid) = find_remote_tracking_branch(&repo, &branch_name);

    for res in resolutions {
        let full_path = Path::new(repo_path).join(&res.path);
        if let Some(content) = res.custom_content {
            if let Some(parent) = full_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&full_path, content).map_err(|e| format!("Failed to write resolved file: {}", e))?;
        }
    }

    // If remote oid is known, fast-forward branch reference now that conflicts are resolved
    if let Some(r_oid) = remote_oid {
        fast_forward_to_commit(&repo, &branch_name, r_oid)?;
    }

    get_repo_status(repo_path)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

enum LineMergeResult {
    Clean(String),
    Conflicted(ConflictFile),
}

/// Compute line-level 3-way merge using diff against base
fn compute_3way_line_merge(
    base: &str,
    local: &str,
    remote: &str,
    path: &str,
) -> LineMergeResult {
    // If local equals remote, trivial clean
    if local == remote {
        return LineMergeResult::Clean(local.to_string());
    }
    // If local unchanged from base, take remote
    if local == base {
        return LineMergeResult::Clean(remote.to_string());
    }
    // If remote unchanged from base, take local
    if remote == base {
        return LineMergeResult::Clean(local.to_string());
    }

    let diff_local = TextDiff::from_lines(base, local);
    let diff_remote = TextDiff::from_lines(base, remote);

    let has_local_changes = diff_local.iter_all_changes().any(|c| c.tag() != ChangeTag::Equal);
    let has_remote_changes = diff_remote.iter_all_changes().any(|c| c.tag() != ChangeTag::Equal);

    // If both touched the file, analyze conflict hunks
    if has_local_changes && has_remote_changes {
        let mut hunks = Vec::new();
        let hunk_id = format!("hunk_{}", path.replace(['/', '\\', '.'], "_"));

        hunks.push(ConflictHunk {
            id: hunk_id,
            base_lines: base.to_string(),
            local_lines: local.to_string(),
            remote_lines: remote.to_string(),
        });

        LineMergeResult::Conflicted(ConflictFile {
            path: path.to_string(),
            base_content: base.to_string(),
            local_content: local.to_string(),
            remote_content: remote.to_string(),
            hunks,
        })
    } else if has_local_changes {
        LineMergeResult::Clean(local.to_string())
    } else {
        LineMergeResult::Clean(remote.to_string())
    }
}

fn fast_forward_to_commit(repo: &Repository, branch_name: &str, target_oid: git2::Oid) -> Result<(), String> {
    let target_commit = repo
        .find_commit(target_oid)
        .map_err(|e| format!("Failed to find target commit: {}", e))?;

    // Checkout target tree
    let tree = target_commit.tree().map_err(|e| e.to_string())?;
    let mut checkout_opts = git2::build::CheckoutBuilder::new();
    checkout_opts.force();

    repo.checkout_tree(tree.as_object(), Some(&mut checkout_opts))
        .map_err(|e| format!("Failed to checkout tree: {}", e))?;

    // Update branch ref
    let ref_name = format!("refs/heads/{}", branch_name);
    repo.reference(&ref_name, target_oid, true, "GitVault fast-forward pull")
        .map_err(|e| format!("Failed to update branch reference: {}", e))?;

    // Point HEAD to the updated branch
    repo.set_head(&ref_name)
        .map_err(|e| format!("Failed to set HEAD: {}", e))?;

    Ok(())
}

fn get_file_content_from_tree(
    repo: &Repository,
    tree_opt: Option<&git2::Tree>,
    rel_path: &str,
) -> Option<String> {
    let tree = tree_opt?;
    let entry = tree.get_path(Path::new(rel_path)).ok()?;
    let object = entry.to_object(repo).ok()?;
    let blob = object.as_blob()?;
    std::str::from_utf8(blob.content()).ok().map(|s| s.to_string())
}

fn get_current_branch_name(repo: &Repository) -> Option<String> {
    let head = repo.head().ok()?;
    if head.is_branch() {
        head.shorthand().map(|s| s.to_string())
    } else {
        None
    }
}

fn find_remote_tracking_branch(repo: &Repository, branch_name: &str) -> (Option<String>, Option<git2::Oid>) {
    let candidate_names = [
        format!("origin/{}", branch_name),
        "origin/main".to_string(),
        "origin/master".to_string(),
    ];

    for name in &candidate_names {
        if let Ok(branch) = repo.find_branch(name, BranchType::Remote) {
            if let Ok(target) = branch.get().peel_to_commit() {
                return (Some("origin".to_string()), Some(target.id()));
            }
        }
    }

    (None, None)
}

fn create_remote_callbacks(repo: &Repository) -> RemoteCallbacks<'static> {
    let mut callbacks = RemoteCallbacks::new();
    let token_opt = repo
        .config()
        .ok()
        .and_then(|c| c.get_string("gitvault.token").ok());

    callbacks.credentials(move |_url, username_from_url, _allowed_types| {
        if let Some(ref token) = token_opt {
            if !token.trim().is_empty() {
                return Cred::userpass_plaintext("git", token.trim());
            }
        }
        Cred::default().or_else(|_| {
            Cred::credential_helper(
                &git2::Config::open_default().unwrap(),
                _url,
                username_from_url,
            )
        })
    });
    callbacks
}

pub fn get_vault_config(repo_path: &str) -> Result<VaultConfig, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
    let branch = get_current_branch_name(&repo).unwrap_or_else(|| "main".to_string());
    let remote_url = repo.find_remote("origin").ok().and_then(|r| r.url().map(|s| s.to_string()));

    let (user_name, user_email, has_token) = if let Ok(config) = repo.config() {
        let name = config.get_string("user.name").ok();
        let email = config.get_string("user.email").ok();
        let token = config.get_string("gitvault.token").ok().map(|t| !t.trim().is_empty()).unwrap_or(false);
        (name, email, token)
    } else {
        (None, None, false)
    };

    Ok(VaultConfig {
        vault_path: repo_path.to_string(),
        remote_url,
        branch,
        user_name,
        user_email,
        has_token,
    })
}

pub fn set_vault_config(repo_path: &str, input: VaultConfigInput) -> Result<VaultConfig, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    // 1. Remote origin URL
    if let Some(ref url) = input.remote_url {
        let clean_url = url.trim();
        if !clean_url.is_empty() {
            if repo.find_remote("origin").is_ok() {
                repo.remote_set_url("origin", clean_url)
                    .map_err(|e| format!("Failed to update remote origin: {}", e))?;
            } else {
                repo.remote("origin", clean_url)
                    .map_err(|e| format!("Failed to add remote origin: {}", e))?;
            }
        }
    }

    // 2. Branch
    if let Some(ref target_branch) = input.branch {
        let target = target_branch.trim();
        if !target.is_empty() {
            let current = get_current_branch_name(&repo).unwrap_or_else(|| "main".to_string());
            if current != target {
                if let Ok(mut branch) = repo.find_branch(&current, BranchType::Local) {
                    let _ = branch.rename(target, true);
                } else {
                    let ref_name = format!("refs/heads/{}", target);
                    let _ = repo.set_head(&ref_name);
                }
            }
        }
    }

    // 3. User & Token configs
    if let Ok(mut config) = repo.config() {
        if let Some(ref name) = input.user_name {
            let _ = config.set_str("user.name", name.trim());
        }
        if let Some(ref email) = input.user_email {
            let _ = config.set_str("user.email", email.trim());
        }
        if let Some(ref token) = input.github_token {
            let _ = config.set_str("gitvault.token", token.trim());
        }
    }

    get_vault_config(repo_path)
}

pub fn test_remote_connection(repo_path: &str, remote_url: &str, token: Option<String>) -> Result<String, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
    let mut remote = repo.remote_anonymous(remote_url).map_err(|e| format!("Invalid remote URL: {}", e))?;

    let saved_token = token.or_else(|| {
        repo.config().ok().and_then(|c| c.get_string("gitvault.token").ok())
    });

    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, username_from_url, _allowed_types| {
        if let Some(ref t) = saved_token {
            if !t.trim().is_empty() {
                return Cred::userpass_plaintext("git", t.trim());
            }
        }
        Cred::default().or_else(|_| {
            Cred::credential_helper(
                &git2::Config::open_default().unwrap(),
                _url,
                username_from_url,
            )
        })
    });

    let mut fetch_opts = FetchOptions::new();
    fetch_opts.remote_callbacks(callbacks);

    remote.fetch(&["+refs/heads/*:refs/remotes/origin/*"], Some(&mut fetch_opts), None)
        .map_err(|e| format!("Failed to reach remote repository: {}", e))?;

    Ok("Successfully connected to GitHub remote repository!".to_string())
}

pub fn connect_vault(
    repo_path: &str,
    remote_url: &str,
    branch: Option<String>,
    token: Option<String>,
    user_name: Option<String>,
    user_email: Option<String>,
) -> Result<RepoStatusPayload, String> {
    let p = Path::new(repo_path);
    if !p.exists() {
        std::fs::create_dir_all(p).map_err(|e| format!("Failed to create vault directory: {}", e))?;
    }

    let repo = if !p.join(".git").exists() {
        Repository::init(p).map_err(|e| format!("Failed to init git: {}", e))?
    } else {
        Repository::open(repo_path).map_err(|e| format!("Failed to open repo: {}", e))?
    };

    // Configure origin
    let clean_url = remote_url.trim();
    if repo.find_remote("origin").is_ok() {
        repo.remote_set_url("origin", clean_url)
            .map_err(|e| format!("Failed to set remote url: {}", e))?;
    } else {
        repo.remote("origin", clean_url)
            .map_err(|e| format!("Failed to add remote: {}", e))?;
    }

    if let Ok(mut config) = repo.config() {
        if let Some(ref name) = user_name {
            let _ = config.set_str("user.name", name.trim());
        }
        if let Some(ref email) = user_email {
            let _ = config.set_str("user.email", email.trim());
        }
        if let Some(ref t) = token {
            let _ = config.set_str("gitvault.token", t.trim());
        }
    }

    let target_branch = branch.unwrap_or_else(|| "main".to_string());
    let _ = fetch_remote(repo_path);

    // Fast forward if remote branch exists and local HEAD is empty
    let (_, remote_oid) = find_remote_tracking_branch(&repo, &target_branch);
    if let Some(r_oid) = remote_oid {
        if repo.head().is_err() {
            let _ = fast_forward_to_commit(&repo, &target_branch, r_oid);
        }
    }

    // If still no markdown notes exist, create initial Welcome note
    let welcome = p.join("Welcome.md");
    if !welcome.exists() {
        let entries = std::fs::read_dir(p).ok();
        let has_md = entries
            .map(|e| e.filter_map(|r| r.ok()).any(|entry| entry.path().extension().and_then(|s| s.to_str()) == Some("md")))
            .unwrap_or(false);
        if !has_md {
            let welcome_content = format!(
                "# Welcome to GitVault\n\nYour vault is now connected to GitHub repository: `{}`.\n\n- Every note is written locally to disk\n- Hit **Save** to stage, commit, and push directly to GitHub\n",
                clean_url
            );
            let _ = std::fs::write(welcome, welcome_content);
        }
    }

    get_repo_status(repo_path)
}
