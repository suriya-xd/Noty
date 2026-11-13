use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use git2::{BranchType, Cred, CredentialType, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks, Repository, Status, StatusOptions};
use similar::{ChangeTag, TextDiff};

use crate::models::{
    ConflictFile, ConflictHunk, ConflictResolution, FileStatus, RepoStatusPayload, SyncResult, SyncState,
    VaultConfig, VaultConfigInput, WorkspaceList,
};

/// The branch that every notes repository keeps empty. Workspaces are the other branches.
const STORAGE_BRANCH: &str = "main";

/// Get the current Git status of the repository, including worktree status
/// and ahead/behind counts against the workspace's own branch on origin.
pub fn get_repo_status(repo_path: &str) -> Result<RepoStatusPayload, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    // 1. Identify active branch name
    let branch_name = current_workspace(&repo).unwrap_or_default();

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

/// Fetches every branch from origin into `refs/remotes/origin/*`, reporting failures. A repo with
/// no origin is not an error (nothing to fetch).
fn fetch_origin(repo: &Repository) -> Result<(), String> {
    let Ok(mut remote) = repo.find_remote("origin") else {
        return Ok(());
    };
    let mut fetch_opts = FetchOptions::new();
    fetch_opts.remote_callbacks(create_remote_callbacks(repo));
    // Prune, so a workspace removed elsewhere (or a different account's storage) doesn't linger.
    fetch_opts.prune(git2::FetchPrune::On);
    remote
        .fetch(&["+refs/heads/*:refs/remotes/origin/*"], Some(&mut fetch_opts), None)
        .map_err(|e| format!("Couldn't reach your cloud storage: {}{}", e, cert_setup_note(&e)))
}

/// What start-up did to make https certificates trusted. Only set on Android (see
/// `trust_android_system_certificates` in lib.rs), where git can't use the system's own store.
pub static CERT_SETUP: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// For a certificate error, the outcome of the certificate set-up, so a failure on a phone shows
/// which step went wrong. Empty for every other error, and on platforms with no such set-up.
fn cert_setup_note(e: &git2::Error) -> String {
    let is_cert_error = e.code() == git2::ErrorCode::Certificate || e.class() == git2::ErrorClass::Ssl;
    match CERT_SETUP.get() {
        Some(outcome) if is_cert_error => format!(" [certificate setup: {}]", outcome),
        _ => String::new(),
    }
}

/// Fetch from origin remote without modifying worktree. This runs in the background, so a failed
/// fetch is ignored and offline use keeps working; the explicit Sync and connect actions report it.
pub fn fetch_remote(repo_path: &str) -> Result<RepoStatusPayload, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
    let _ = fetch_origin(&repo);
    get_repo_status(repo_path)
}

/// Stages everything (`git add -A`) and commits it to the current branch. Returns false when
/// there was nothing new to commit.
fn commit_all(repo: &Repository, message: &str) -> Result<bool, String> {
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

    let parent_commit = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .and_then(|oid| repo.find_commit(oid).ok());

    if let Some(parent) = &parent_commit {
        if parent.tree_id() == tree_oid {
            return Ok(false);
        }
    }

    let parents: Vec<&git2::Commit> = match &parent_commit {
        Some(c) => vec![c],
        None => vec![],
    };

    let sig = signature(repo);
    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| format!("Failed to save: {}", e))?;
    Ok(true)
}

fn signature(repo: &Repository) -> git2::Signature<'static> {
    repo.signature()
        .unwrap_or_else(|_| git2::Signature::now("Noetic User", "notes@noetic.local").unwrap())
}

/// Pushes `src_ref` to `refs/heads/<branch>` on origin. libgit2 reports a push the server turned
/// down (for example because newer changes are there) only through the per-reference callback,
/// so that is turned into an error here.
fn push_ref(repo: &Repository, src_ref: &str, branch: &str) -> Result<(), String> {
    let mut remote = repo
        .find_remote("origin")
        .map_err(|_| "Sign in to back up and sync your notes.".to_string())?;
    let mut callbacks = create_remote_callbacks(repo);
    callbacks.push_update_reference(|_, status| match status {
        Some(msg) => Err(git2::Error::from_str(msg)),
        None => Ok(()),
    });
    let mut push_opts = PushOptions::new();
    push_opts.remote_callbacks(callbacks);

    let refspec = format!("{}:refs/heads/{}", src_ref, branch);
    remote
        .push(&[&refspec], Some(&mut push_opts))
        .map_err(|e| format!("{}{}", e.message(), cert_setup_note(&e)))?;

    // Record what origin now has, so the status is right without waiting for the next fetch.
    if let Ok(oid) = repo.refname_to_id(src_ref) {
        let _ = repo.reference(&format!("refs/remotes/origin/{}", branch), oid, true, "Noetic: uploaded");
    }
    Ok(())
}

fn push_workspace(repo: &Repository, workspace: &str) -> Result<(), String> {
    push_ref(repo, &format!("refs/heads/{}", workspace), workspace)
}

/// Manual Save:
/// 1. Verifies the cloud copy hasn't moved ahead (prevents accidental overwrite).
/// 2. Stages all files and commits them to the current workspace.
/// 3. Uploads the workspace (the save stays on this device if that fails, e.g. offline).
pub fn save_and_push(repo_path: &str, commit_message: Option<String>) -> Result<RepoStatusPayload, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    if repo.find_remote("origin").is_err() {
        return Err("Your notes are kept on this device. Sign in to back them up and sync them.".to_string());
    }
    let Some(workspace) = current_workspace(&repo) else {
        return Err("Choose or create a workspace first.".to_string());
    };

    let current_status = get_repo_status(repo_path)?;
    if current_status.behind_count > 0 {
        return Err(format!(
            "There {} waiting from your other devices. Sync first, then save.",
            if current_status.behind_count == 1 { "is 1 update".to_string() } else { format!("are {} updates", current_status.behind_count) }
        ));
    }

    let msg = commit_message.unwrap_or_else(|| {
        format!("Notes update: {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"))
    });
    commit_all(&repo, &msg)?;

    if let Err(e) = push_workspace(&repo, &workspace) {
        return Err(format!(
            "Saved on this device, but it couldn't be uploaded: {}. It will be sent the next time you save while online.",
            e
        ));
    }

    get_repo_status(repo_path)
}

/// Manual Sync & Pull:
/// Pulls changes from the workspace's branch on origin. If local worktree is dirty:
/// - If non-overlapping files: stash local, fast-forward pull, pop stash.
/// - If same file modified both locally and remotely: run in-memory 3-way merge.
///   If line-level conflicts: return conflict hunks for the Visual Conflict Resolver Modal.
pub fn sync_and_pull(repo_path: &str) -> Result<SyncResult, String> {
    // 1. Fetch remote first to ensure latest remote refs. Sync is an explicit action, so a failed
    // fetch is reported instead of looking like "already up to date".
    {
        let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
        fetch_origin(&repo)?;
    }
    let pre_status = get_repo_status(repo_path)?;

    let mut repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
    let branch_name = pre_status.branch.clone();

    let head_oid = repo.head().ok().and_then(|h| h.target());
    let (_, remote_oid) = find_remote_tracking_branch(&repo, &branch_name);

    let remote_commit_oid = match remote_oid {
        Some(oid) => oid,
        None => {
            return Ok(SyncResult {
                success: true,
                message: "Everything is up to date.".to_string(),
                state: pre_status.state,
                conflicts: vec![],
            });
        }
    };

    if pre_status.behind_count == 0 {
        return Ok(SyncResult {
            success: true,
            message: "Everything is up to date.".to_string(),
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
                git2::Signature::now("Noetic", "notes@noetic.local").unwrap()
            });
            let stash_res = repo.stash_save2(
                &sig,
                Some("Noetic auto-stash during sync"),
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
            message: "Synced. Your notes are up to date.".to_string(),
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
                "{} note(s) changed both here and on another device. Choose which version to keep.",
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
        message: "Synced. Your edits were combined with the updates.".to_string(),
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
    let branch_name = current_workspace(&repo).ok_or_else(|| "Choose or create a workspace first.".to_string())?;
    let (_, remote_oid) = find_remote_tracking_branch(&repo, &branch_name);

    // Take the incoming version of everything first, then put the chosen text on top of it as
    // an unsaved edit. (The other way round, the checkout replaces what the user just chose.)
    if let Some(r_oid) = remote_oid {
        fast_forward_to_commit(&repo, &branch_name, r_oid)?;
    }

    for res in resolutions {
        let full_path = Path::new(repo_path).join(&res.path);
        if let Some(content) = res.custom_content {
            if let Some(parent) = full_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&full_path, content).map_err(|e| format!("Failed to write resolved file: {}", e))?;
        }
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
    repo.reference(&ref_name, target_oid, true, "Noetic: synced")
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

/// The workspace that is open: the checked-out branch, unless there are no saves on it yet or it
/// is the storage branch that is kept empty.
fn current_workspace(repo: &Repository) -> Option<String> {
    get_current_branch_name(repo).filter(|b| b != STORAGE_BRANCH)
}

/// A workspace syncs only with the branch of the same name on origin. (Falling back to another
/// branch would compare a new workspace with the empty storage branch.)
fn find_remote_tracking_branch(repo: &Repository, branch_name: &str) -> (Option<String>, Option<git2::Oid>) {
    if branch_name.is_empty() {
        return (None, None);
    }
    if let Ok(branch) = repo.find_branch(&format!("origin/{}", branch_name), BranchType::Remote) {
        if let Ok(target) = branch.get().peel_to_commit() {
            return (Some("origin".to_string()), Some(target.id()));
        }
    }
    (None, None)
}

/// Credentials for a remote: the saved GitHub token, or whatever the system git offers.
///
/// libgit2 calls this again every time the server rejects what it was given, so answering with the
/// same token each time would retry forever (a hung push/fetch). It is offered once; a second call
/// means the server said no, and that is reported as an error the user can act on. Nothing here
/// may panic: the release build aborts on panic, which would close the whole app.
fn credentials_callback(
    token: Option<String>,
) -> impl FnMut(&str, Option<&str>, CredentialType) -> Result<Cred, git2::Error> {
    let mut offered = false;
    move |url, username_from_url, allowed| {
        if offered {
            return Err(git2::Error::from_str(
                "Your sign-in was not accepted. It may have expired or been revoked: sign in again from Settings.",
            ));
        }
        offered = true;

        if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            if let Some(t) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                return Cred::userpass_plaintext("git", t);
            }
        }
        git2::Config::open_default()
            .and_then(|cfg| Cred::credential_helper(&cfg, url, username_from_url))
            .or_else(|_| Cred::default())
    }
}

fn create_remote_callbacks(repo: &Repository) -> RemoteCallbacks<'static> {
    let mut callbacks = RemoteCallbacks::new();
    let token_opt = repo
        .config()
        .ok()
        .and_then(|c| c.get_string("noetic.token").ok());
    callbacks.credentials(credentials_callback(token_opt));
    callbacks
}


pub fn get_vault_config(repo_path: &str) -> Result<VaultConfig, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
    let branch = current_workspace(&repo).unwrap_or_default();
    let remote_url = repo.find_remote("origin").ok().and_then(|r| r.url().map(|s| s.to_string()));

    let (user_name, user_email, has_token) = if let Ok(config) = repo.config() {
        let name = config.get_string("user.name").ok();
        let email = config.get_string("user.email").ok();
        let token = config.get_string("noetic.token").ok().map(|t| !t.trim().is_empty()).unwrap_or(false);
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

/// Updates the author details and saved sign-in. Where the notes are stored and which workspace
/// is open are not settings: see `connect_vault` and `switch_workspace`.
pub fn set_vault_config(repo_path: &str, input: VaultConfigInput) -> Result<VaultConfig, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    if let Ok(mut config) = repo.config() {
        if let Some(ref name) = input.user_name {
            let _ = config.set_str("user.name", name.trim());
        }
        if let Some(ref email) = input.user_email {
            let _ = config.set_str("user.email", email.trim());
        }
        if let Some(ref token) = input.github_token {
            let _ = config.set_str("noetic.token", token.trim());
        }
    }

    get_vault_config(repo_path)
}

/// Links the notes folder to the account's notes repository and makes sure that repository has
/// its empty `main` branch. No workspace is opened here: the caller lists them and the user
/// creates or picks one.
pub fn connect_vault(
    repo_path: &str,
    remote_url: &str,
    token: Option<String>,
    user_name: Option<String>,
    user_email: Option<String>,
) -> Result<WorkspaceList, String> {
    let p = Path::new(repo_path);
    if !p.exists() {
        std::fs::create_dir_all(p).map_err(|e| format!("Failed to create notes folder: {}", e))?;
    }

    let repo = if !p.join(".git").exists() {
        Repository::init(p).map_err(|e| format!("Failed to set up the notes folder: {}", e))?
    } else {
        Repository::open(repo_path).map_err(|e| format!("Failed to open the notes folder: {}", e))?
    };

    let clean_url = remote_url.trim();
    if repo.find_remote("origin").is_ok() {
        repo.remote_set_url("origin", clean_url)
            .map_err(|e| format!("Failed to link your cloud storage: {}", e))?;
    } else {
        repo.remote("origin", clean_url)
            .map_err(|e| format!("Failed to link your cloud storage: {}", e))?;
    }

    if let Ok(mut config) = repo.config() {
        if let Some(ref name) = user_name {
            let _ = config.set_str("user.name", name.trim());
        }
        if let Some(ref email) = user_email {
            let _ = config.set_str("user.email", email.trim());
        }
        if let Some(ref t) = token {
            let _ = config.set_str("noetic.token", t.trim());
        }
    }

    // Setting up needs the network: the list of workspaces comes from this fetch.
    fetch_origin(&repo)?;
    ensure_storage_branch(&repo)?;

    Ok(collect_workspaces(&repo))
}

// ---------------------------------------------------------------------------
// Workspaces (one branch each; `main` stays empty)
// ---------------------------------------------------------------------------

/// A commit with no files and no parent.
fn empty_root_commit(repo: &Repository) -> Result<git2::Oid, String> {
    let tree_oid = repo
        .treebuilder(None)
        .and_then(|b| b.write())
        .map_err(|e| format!("Failed to prepare storage: {}", e))?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;
    let sig = signature(repo);
    repo.commit(None, &sig, &sig, "Noetic storage", &tree, &[])
        .map_err(|e| format!("Failed to prepare storage: {}", e))
}

fn storage_branch_commit(repo: &Repository) -> Option<git2::Commit<'_>> {
    repo.find_reference(&format!("refs/remotes/origin/{}", STORAGE_BRANCH))
        .ok()
        .and_then(|r| r.peel_to_commit().ok())
}

/// Creates the empty `main` branch on origin if the repository doesn't have one yet.
fn ensure_storage_branch(repo: &Repository) -> Result<(), String> {
    if storage_branch_commit(repo).is_some() {
        return Ok(());
    }
    // Pushed from a scratch reference so no local `main` branch is left behind.
    let scratch = "refs/noetic/storage";
    let oid = empty_root_commit(repo)?;
    repo.reference(scratch, oid, true, "Noetic storage")
        .map_err(|e| format!("Failed to prepare storage: {}", e))?;
    let pushed = push_ref(repo, scratch, STORAGE_BRANCH);
    if let Ok(mut r) = repo.find_reference(scratch) {
        let _ = r.delete();
    }
    pushed.map_err(|e| format!("Couldn't set up your cloud storage: {}", e))
}

/// Where a new workspace starts: the empty commit on `main`, so every workspace begins blank.
fn workspace_base(repo: &Repository) -> Result<git2::Oid, String> {
    if let Some(commit) = storage_branch_commit(repo) {
        if commit.tree().map(|t| t.is_empty()).unwrap_or(false) {
            return Ok(commit.id());
        }
    }
    empty_root_commit(repo)
}

fn collect_workspaces(repo: &Repository) -> WorkspaceList {
    let mut names: BTreeSet<String> = BTreeSet::new();
    if let Ok(branches) = repo.branches(None) {
        for (branch, kind) in branches.flatten() {
            let Ok(Some(name)) = branch.name() else { continue };
            let name = match kind {
                BranchType::Local => name,
                BranchType::Remote => match name.strip_prefix("origin/") {
                    Some(n) => n,
                    None => continue,
                },
            };
            if name != STORAGE_BRANCH && name != "HEAD" {
                names.insert(name.to_string());
            }
        }
    }
    let mut workspaces: Vec<String> = names.into_iter().collect();
    workspaces.sort_by_key(|n| n.to_lowercase());
    WorkspaceList {
        current: current_workspace(repo),
        workspaces,
    }
}

/// Lists the workspaces known on this device and in the cloud. `refresh` checks the cloud first;
/// being offline is not an error, the list is then what this device last saw.
pub fn list_workspaces(repo_path: &str, refresh: bool) -> Result<WorkspaceList, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open the notes folder: {}", e))?;
    if refresh {
        let _ = fetch_origin(&repo);
    }
    Ok(collect_workspaces(&repo))
}

/// Turns what the user typed into a branch name: spaces become dashes, the rest must be valid.
fn workspace_branch_name(name: &str) -> Result<String, String> {
    let cleaned = name.split_whitespace().collect::<Vec<_>>().join("-");
    if cleaned.is_empty() {
        return Err("Give the workspace a name.".to_string());
    }
    if cleaned.eq_ignore_ascii_case(STORAGE_BRANCH) || cleaned.eq_ignore_ascii_case("HEAD") {
        return Err(format!("\"{}\" is reserved. Pick a different name.", cleaned));
    }
    let valid = !cleaned.starts_with('-')
        && !cleaned.contains('/')
        && git2::Branch::name_is_valid(&cleaned).unwrap_or(false);
    if !valid {
        return Err("Workspace names can use letters, numbers, spaces, dashes and underscores.".to_string());
    }
    Ok(cleaned)
}

/// Before leaving a workspace its unsaved changes are saved (and uploaded when possible), so
/// they are not carried into, or overwritten by, the workspace being opened.
fn save_before_leaving(repo: &Repository, repo_path: &str, workspace: &str) -> Result<(), String> {
    let status = get_repo_status(repo_path)?;
    if status.dirty_count == 0 {
        return Ok(());
    }
    if status.behind_count > 0 {
        return Err(
            "This workspace has unsaved changes and updates waiting from your other devices. Sync it first, then switch."
                .to_string(),
        );
    }
    commit_all(repo, &format!("Saved before leaving workspace: {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")))?;
    let _ = push_workspace(repo, workspace);
    Ok(())
}

/// Puts a workspace's notes in the folder and makes it the open one. `force` replaces whatever
/// is in the folder; without it, a file that would be overwritten stops the switch.
fn checkout_workspace(repo: &Repository, workspace: &str, force: bool) -> Result<(), git2::Error> {
    let ref_name = format!("refs/heads/{}", workspace);
    let commit = repo.find_reference(&ref_name)?.peel_to_commit()?;
    let mut opts = git2::build::CheckoutBuilder::new();
    if force {
        opts.force();
    } else {
        opts.safe();
    }
    repo.checkout_tree(commit.as_object(), Some(&mut opts))?;
    repo.set_head(&ref_name)
}

/// Folders aren't part of a save, so empty ones would otherwise follow the user from one
/// workspace into the next.
fn remove_empty_folders(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    let mut empty = true;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && entry.file_name() != ".git" && remove_empty_folders(&path) {
            let _ = std::fs::remove_dir(&path);
        } else {
            empty = false;
        }
    }
    empty
}

fn has_notes(dir: &Path) -> bool {
    walkdir_files(dir).iter().any(|p| {
        matches!(p.extension().and_then(|e| e.to_str()), Some("md") | Some("canvas"))
    })
}

fn walkdir_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            out.extend(walkdir_files(&path));
        } else {
            out.push(path);
        }
    }
    out
}

const WELCOME_NOTE: &str = "Noetic keeps your notes as plain Markdown files on this device and backs them up to your account.\n\n- **Save** uploads your changes so your other devices can get them.\n- **Sync** brings in changes made on your other devices.\n- **Workspaces** keep separate sets of notes apart, for example Personal and Work. Switch or add one from the workspace menu.\n";

/// Creates a workspace and opens it. A new workspace starts blank, except the first one on a
/// device: notes already in the folder (written before signing in) move into it.
pub fn create_workspace(repo_path: &str, name: &str) -> Result<RepoStatusPayload, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open the notes folder: {}", e))?;
    let workspace = workspace_branch_name(name)?;

    let existing = collect_workspaces(&repo);
    if existing.workspaces.iter().any(|w| w.eq_ignore_ascii_case(&workspace)) {
        return Err(format!("A workspace named \"{}\" already exists.", workspace));
    }

    let ref_name = format!("refs/heads/{}", workspace);
    let failed = |e: git2::Error| format!("Couldn't create the workspace: {}", e.message());

    match existing.current {
        Some(current) => {
            save_before_leaving(&repo, repo_path, &current)?;
            let base = workspace_base(&repo)?;
            repo.reference(&ref_name, base, false, "Noetic: new workspace").map_err(failed)?;
            checkout_workspace(&repo, &workspace, true).map_err(failed)?;
            if let Some(root) = repo.workdir() {
                remove_empty_folders(root);
            }
        }
        None => {
            let base = workspace_base(&repo)?;
            repo.reference(&ref_name, base, false, "Noetic: new workspace").map_err(failed)?;
            repo.set_head(&ref_name).map_err(failed)?;
            // Files stay where they are; only the record of what has been saved starts blank.
            let base_object = repo.find_object(base, None).map_err(failed)?;
            repo.reset(&base_object, git2::ResetType::Mixed, None).map_err(failed)?;

            let root = Path::new(repo_path);
            if !has_notes(root) {
                let _ = std::fs::write(root.join("Welcome.md"), WELCOME_NOTE);
            }
            commit_all(&repo, "First notes in this workspace")?;
        }
    }

    // Offline is fine: the workspace is uploaded with the next save.
    let _ = push_workspace(&repo, &workspace);
    get_repo_status(repo_path)
}

/// Opens another workspace: the notes in the folder are replaced with that workspace's notes.
pub fn switch_workspace(repo_path: &str, name: &str) -> Result<RepoStatusPayload, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open the notes folder: {}", e))?;
    let workspace = name.trim();
    let current = current_workspace(&repo);
    if current.as_deref() == Some(workspace) {
        return get_repo_status(repo_path);
    }

    let gone = || format!("The workspace \"{}\" no longer exists.", workspace);
    if workspace.is_empty() || workspace == STORAGE_BRANCH {
        return Err(gone());
    }
    let ref_name = format!("refs/heads/{}", workspace);
    let failed = |e: git2::Error| format!("Couldn't open the workspace: {}", e.message());

    if let Some(current) = &current {
        save_before_leaving(&repo, repo_path, current)?;
    }

    // A workspace made on another device exists only in the cloud copy until it is opened here.
    if repo.find_reference(&ref_name).is_err() {
        let remote_oid = repo
            .find_branch(&format!("origin/{}", workspace), BranchType::Remote)
            .ok()
            .and_then(|b| b.get().target())
            .ok_or_else(gone)?;
        repo.reference(&ref_name, remote_oid, false, "Noetic: open workspace").map_err(failed)?;
    }

    if current.is_some() {
        checkout_workspace(&repo, workspace, true).map_err(failed)?;
        if let Some(root) = repo.workdir() {
            remove_empty_folders(root);
        }
    } else {
        // No workspace was open, so notes in the folder belong to none yet. They are kept and
        // join this workspace; one with the same name as a note already in it stops the switch.
        checkout_workspace(&repo, workspace, false).map_err(|_| {
            "Some notes on this device have the same names as notes in this workspace. Rename or move them, then try again."
                .to_string()
        })?;
    }

    get_repo_status(repo_path)
}
