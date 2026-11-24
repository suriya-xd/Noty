use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use git2::{BranchType, Cred, CredentialType, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks, Repository, Status, StatusOptions};

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

        // Compute files the other devices changed: from the last common save, so saves waiting to
        // upload on this device don't count as incoming.
        let base_oid = repo.merge_base(h_oid, r_oid).unwrap_or(h_oid);
        if let (Ok(head_commit), Ok(remote_commit)) = (repo.find_commit(base_oid), repo.find_commit(r_oid)) {
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
/// 1. Commits everything on this device, so nothing that follows can lose it.
/// 2. Brings in changes from the other devices. Notes changed in only one place are combined;
///    a note changed in both is returned for the user to choose a version.
/// 3. Uploads the workspace (the save stays on this device if that fails, e.g. offline).
pub fn save_and_push(repo_path: &str, commit_message: Option<String>) -> Result<SyncResult, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    if repo.find_remote("origin").is_err() {
        return Err("Your notes are kept on this device. Sign in to back them up and sync them.".to_string());
    }
    let Some(workspace) = current_workspace(&repo) else {
        return Err("Choose or create a workspace first.".to_string());
    };

    let msg = commit_message.unwrap_or_else(|| {
        format!("Notes update: {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"))
    });
    commit_all(&repo, &msg)?;

    let not_uploaded = |e: String| {
        format!(
            "Saved on this device, but it couldn't be uploaded: {}. It will be sent the next time you save while online.",
            e
        )
    };

    // Another device can upload between the fetch and the push, so a refused push is retried once.
    let mut retried = false;
    let mut combined = false;
    loop {
        fetch_origin(&repo).map_err(not_uploaded)?;
        match integrate_remote(&repo, &workspace)? {
            Integration::Conflicted(conflicts) => return conflict_result(repo_path, conflicts),
            Integration::UpToDate => {}
            Integration::Updated => combined = true,
        }
        match push_workspace(&repo, &workspace) {
            Ok(()) => break,
            Err(_) if !retried => retried = true,
            Err(e) => return Err(not_uploaded(e)),
        }
    }

    Ok(SyncResult {
        success: true,
        message: if combined {
            "Saved, and combined with the updates from your other devices.".to_string()
        } else {
            "Saved. Your changes are backed up.".to_string()
        },
        state: get_repo_status(repo_path)?.state,
        conflicts: vec![],
    })
}

/// Manual Sync: brings in the changes from the other devices without uploading anything. When
/// there are some, edits on this device are committed first, so combining can't lose them.
pub fn sync_and_pull(repo_path: &str) -> Result<SyncResult, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
    // Sync is an explicit action, so a failed fetch is reported instead of looking like
    // "already up to date".
    fetch_origin(&repo)?;

    let status = get_repo_status(repo_path)?;
    if status.behind_count == 0 {
        return Ok(SyncResult {
            success: true,
            message: "Everything is up to date.".to_string(),
            state: status.state,
            conflicts: vec![],
        });
    }

    if status.dirty_count > 0 {
        commit_all(&repo, &format!("Saved before syncing: {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")))?;
    }
    if let Integration::Conflicted(conflicts) = integrate_remote(&repo, &status.branch)? {
        return conflict_result(repo_path, conflicts);
    }

    let post_status = get_repo_status(repo_path)?;
    Ok(SyncResult {
        success: true,
        message: if post_status.ahead_count > 0 {
            "Synced. Your edits were combined with the updates. Save to upload them.".to_string()
        } else {
            "Synced. Your notes are up to date.".to_string()
        },
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
    let workspace = current_workspace(&repo).ok_or_else(|| "Choose or create a workspace first.".to_string())?;
    for res in &resolutions {
        crate::fs_engine::resolve_in_vault(Path::new(repo_path), &res.path)?;
    }

    commit_all(&repo, &format!("Saved before syncing: {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")))?;

    // The incoming version the user was shown. A background fetch may have brought a newer one
    // since; that one is left for the next sync rather than being resolved unseen.
    let incoming = repo
        .refname_to_id(&incoming_ref(&workspace))
        .map_err(|_| "There is nothing left to resolve. Sync again.".to_string())?;
    let chosen: HashMap<String, ConflictResolution> =
        resolutions.into_iter().map(|r| (r.path.clone(), r)).collect();
    if let Integration::Conflicted(_) = integrate_commit(&repo, &workspace, incoming, &chosen)? {
        return Err("Some notes changed in the meantime. Sync again to choose their versions.".to_string());
    }
    if let Ok(mut r) = repo.find_reference(&incoming_ref(&workspace)) {
        let _ = r.delete();
    }
    get_repo_status(repo_path)
}

// ---------------------------------------------------------------------------
// Combining this device's notes with the cloud copy
// ---------------------------------------------------------------------------

enum Integration {
    UpToDate,
    Updated,
    Conflicted(Vec<ConflictFile>),
}

/// Remembers which incoming commit the open conflict resolver is about.
fn incoming_ref(workspace: &str) -> String {
    format!("refs/noetic/incoming/{}", workspace)
}

fn conflict_result(repo_path: &str, conflicts: Vec<ConflictFile>) -> Result<SyncResult, String> {
    Ok(SyncResult {
        success: false,
        message: format!(
            "{} note(s) changed both here and on another device. Choose which version to keep.",
            conflicts.len()
        ),
        state: get_repo_status(repo_path)?.state,
        conflicts,
    })
}

fn integrate_remote(repo: &Repository, workspace: &str) -> Result<Integration, String> {
    let (_, Some(remote)) = find_remote_tracking_branch(repo, workspace) else {
        return Ok(Integration::UpToDate);
    };
    let outcome = integrate_commit(repo, workspace, remote, &HashMap::new())?;
    if let Integration::Conflicted(_) = outcome {
        repo.reference(&incoming_ref(workspace), remote, true, "Noetic: conflict")
            .map_err(|e| format!("Failed to prepare the conflict: {}", e))?;
    }
    Ok(outcome)
}

type TreeFiles = BTreeMap<String, (git2::Oid, i32)>;

fn tree_files(repo: &Repository, commit: Option<git2::Oid>) -> Result<TreeFiles, String> {
    let mut files = TreeFiles::new();
    let Some(oid) = commit else { return Ok(files) };
    let tree = repo
        .find_commit(oid)
        .and_then(|c| c.tree())
        .map_err(|e| format!("Failed to read saved notes: {}", e))?;
    let mut unreadable = false;
    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        if entry.kind() != Some(git2::ObjectType::Tree) {
            match entry.name() {
                Some(name) => {
                    files.insert(format!("{}{}", dir, name), (entry.id(), entry.filemode()));
                }
                None => unreadable = true,
            }
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(|e| format!("Failed to read saved notes: {}", e))?;
    // Going on without it would look like the file had been deleted.
    if unreadable {
        return Err("A file has a name that can't be read, so nothing was synced.".to_string());
    }
    Ok(files)
}

/// The text of a file; empty when it doesn't exist, `None` when it isn't text.
fn file_text(repo: &Repository, file: Option<&(git2::Oid, i32)>) -> Option<String> {
    match file {
        None => Some(String::new()),
        Some((oid, _)) => {
            let blob = repo.find_blob(*oid).ok()?;
            std::str::from_utf8(blob.content()).ok().map(str::to_string)
        }
    }
}

/// A free name for the other device's copy of a file that can't be compared as text.
fn other_device_name(path: &str, taken: impl Fn(&str) -> bool) -> String {
    let name_start = path.rfind('/').map_or(0, |i| i + 1);
    let dot = path[name_start..].rfind('.').filter(|i| *i > 0).map_or(path.len(), |i| name_start + i);
    let (stem, ext) = path.split_at(dot);
    let mut n = 1;
    loop {
        let suffix = if n == 1 { String::new() } else { format!(" {}", n) };
        let candidate = format!("{} (other device{}){}", stem, suffix, ext);
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Brings `theirs` into the workspace. The caller has committed this device's edits. A file
/// changed on one side takes that side; a note changed differently on both needs an entry in
/// `chosen`. If one is missing nothing is changed. The result is a merge commit (or a plain
/// fast-forward), so commits made on this device are always kept.
fn integrate_commit(
    repo: &Repository,
    workspace: &str,
    theirs: git2::Oid,
    chosen: &HashMap<String, ConflictResolution>,
) -> Result<Integration, String> {
    let failed = |e: git2::Error| format!("Failed to combine your notes: {}", e.message());
    let ours = repo.head().ok().and_then(|h| h.target()).ok_or("This workspace has no notes yet.")?;
    let base = repo.merge_base(ours, theirs).ok();
    if base == Some(theirs) {
        return Ok(Integration::UpToDate);
    }
    if base == Some(ours) {
        advance_to(repo, workspace, theirs)?;
        return Ok(Integration::Updated);
    }

    let base_files = tree_files(repo, base)?;
    let our_files = tree_files(repo, Some(ours))?;
    let their_files = tree_files(repo, Some(theirs))?;

    let mut merged = TreeFiles::new();
    let mut conflicts = Vec::new();
    let mut extra_copies: Vec<(String, (git2::Oid, i32))> = Vec::new();
    let paths: BTreeSet<&String> = our_files.keys().chain(their_files.keys()).collect();
    for path in paths {
        let (b, o, t) = (base_files.get(path), our_files.get(path), their_files.get(path));
        let picked = if o == t || t == b {
            o.copied()
        } else if o == b {
            t.copied()
        } else if let Some(res) = chosen.get(path) {
            match (res.resolution_type.as_str(), &res.custom_content) {
                ("local", _) => o.copied(),
                ("remote", _) => t.copied(),
                (_, Some(text)) => Some((repo.blob(text.as_bytes()).map_err(failed)?, 0o100644)),
                _ => return Err(format!("No version was chosen for {}.", path)),
            }
        } else if let (Some(local), Some(remote)) = (file_text(repo, o), file_text(repo, t)) {
            let base_text = file_text(repo, b).unwrap_or_default();
            conflicts.push(ConflictFile {
                path: path.clone(),
                hunks: vec![ConflictHunk {
                    id: format!("hunk_{}", path.replace(['/', '\\', '.'], "_")),
                    base_lines: base_text.clone(),
                    local_lines: local.clone(),
                    remote_lines: remote.clone(),
                }],
                base_content: base_text,
                local_content: local,
                remote_content: remote,
                local_deleted: o.is_none(),
                remote_deleted: t.is_none(),
            });
            continue;
        } else {
            // An image or similar: there is no text to compare, so both copies are kept.
            if let (Some(_), Some(t)) = (o, t) {
                extra_copies.push((path.clone(), *t));
            }
            o.or(t).copied()
        };
        if let Some(file) = picked {
            merged.insert(path.clone(), file);
        }
    }
    if !conflicts.is_empty() {
        return Ok(Integration::Conflicted(conflicts));
    }
    for (path, file) in extra_copies {
        let name = other_device_name(&path, |n| merged.contains_key(n));
        merged.insert(name, file);
    }

    // A file on one device and a folder of the same name on the other can't both exist.
    for path in merged.keys() {
        for (i, _) in path.match_indices('/') {
            if merged.contains_key(&path[..i]) {
                return Err(format!(
                    "\"{}\" is a file on one device and a folder on the other. Rename it, then sync again.",
                    &path[..i]
                ));
            }
        }
    }

    let mut index = git2::Index::new().map_err(failed)?;
    for (path, (oid, mode)) in &merged {
        index
            .add(&git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: *mode as u32,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: *oid,
                flags: 0,
                flags_extended: 0,
                path: path.clone().into_bytes(),
            })
            .map_err(failed)?;
    }
    let tree = index.write_tree_to(repo).and_then(|oid| repo.find_tree(oid)).map_err(failed)?;
    let our_commit = repo.find_commit(ours).map_err(failed)?;
    let their_commit = repo.find_commit(theirs).map_err(failed)?;
    let sig = signature(repo);
    let merge = repo
        .commit(None, &sig, &sig, "Combined changes from your devices", &tree, &[&our_commit, &their_commit])
        .map_err(failed)?;
    advance_to(repo, workspace, merge)?;
    Ok(Integration::Updated)
}

/// Updates the folder and the workspace to a commit that contains everything already committed
/// here. Never forced: a file edited since the last commit stops it instead of being overwritten.
fn advance_to(repo: &Repository, workspace: &str, target: git2::Oid) -> Result<(), String> {
    let commit = repo
        .find_commit(target)
        .map_err(|e| format!("Failed to find target commit: {}", e))?;
    let mut opts = git2::build::CheckoutBuilder::new();
    opts.safe();
    repo.checkout_tree(commit.as_object(), Some(&mut opts))
        .map_err(|e| format!("A note was being edited while syncing, so nothing was changed. Try again. ({})", e.message()))?;

    let ref_name = format!("refs/heads/{}", workspace);
    repo.reference(&ref_name, target, true, "Noetic: synced")
        .map_err(|e| format!("Failed to update branch reference: {}", e))?;
    repo.set_head(&ref_name)
        .map_err(|e| format!("Failed to set HEAD: {}", e))
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
/// they are not carried into, or overwritten by, the workspace being opened. Updates waiting from
/// other devices don't prevent this: they are combined at the next save or sync of that workspace.
fn save_before_leaving(repo: &Repository, repo_path: &str, workspace: &str) -> Result<(), String> {
    let status = get_repo_status(repo_path)?;
    if status.dirty_count == 0 {
        return Ok(());
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Two devices opened on the same workspace, with a bare repository standing in for the cloud.
    struct Devices {
        mac: PathBuf,
        phone: PathBuf,
    }

    fn write(dir: &Path, name: &str, text: &str) {
        std::fs::write(dir.join(name), text).unwrap();
    }

    fn read(dir: &Path, name: &str) -> String {
        std::fs::read_to_string(dir.join(name)).unwrap()
    }

    fn path(dir: &Path) -> &str {
        dir.to_str().unwrap()
    }

    fn devices(name: &str) -> Devices {
        let root = std::env::temp_dir().join(format!("noetic-sync-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let cloud = root.join("cloud.git");
        Repository::init_bare(&cloud).unwrap();
        let (mac, phone) = (root.join("mac"), root.join("phone"));
        connect_vault(path(&mac), path(&cloud), None, None, None).unwrap();
        create_workspace(path(&mac), "Personal").unwrap();
        write(&mac, "a.md", "a\n");
        write(&mac, "b.md", "b\n");
        save_and_push(path(&mac), None).unwrap();
        connect_vault(path(&phone), path(&cloud), None, None, None).unwrap();
        switch_workspace(path(&phone), "Personal").unwrap();
        assert_eq!(read(&phone, "b.md"), "b\n");
        Devices { mac, phone }
    }

    #[test]
    fn different_notes_changed_on_two_devices_are_both_kept() {
        let d = devices("different");
        write(&d.mac, "a.md", "a from mac\n");
        save_and_push(path(&d.mac), None).unwrap();

        // The phone hasn't checked the cloud since, so it doesn't know it is behind.
        write(&d.phone, "b.md", "b from phone\n");
        let _ = save_and_push(path(&d.phone), None);
        let _ = sync_and_pull(path(&d.phone)).unwrap();
        assert_eq!(read(&d.phone, "a.md"), "a from mac\n");
        assert_eq!(read(&d.phone, "b.md"), "b from phone\n");
    }

    /// Same note edited on both devices; the phone has saved, which must ask rather than upload.
    fn conflicted(name: &str) -> Devices {
        let d = devices(name);
        write(&d.mac, "a.md", "a from mac\n");
        write(&d.mac, "b.md", "b from mac\n");
        save_and_push(path(&d.mac), None).unwrap();
        write(&d.phone, "a.md", "a from phone\n");
        let result = save_and_push(path(&d.phone), None).unwrap();
        assert!(!result.success);
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.conflicts[0].base_content, "a\n");
        assert_eq!(result.conflicts[0].local_content, "a from phone\n");
        assert_eq!(result.conflicts[0].remote_content, "a from mac\n");
        // Asking changes nothing on disk.
        assert_eq!(read(&d.phone, "a.md"), "a from phone\n");
        assert_eq!(read(&d.phone, "b.md"), "b\n");
        d
    }

    fn choose(note: &str, kind: &str, text: Option<&str>) -> Vec<ConflictResolution> {
        vec![ConflictResolution {
            path: note.into(),
            resolution_type: kind.into(),
            custom_content: text.map(Into::into),
        }]
    }

    #[test]
    fn saving_combines_different_notes_and_uploads_them() {
        let d = devices("save");
        write(&d.mac, "a.md", "a from mac\n");
        save_and_push(path(&d.mac), None).unwrap();
        write(&d.phone, "b.md", "b from phone\n");
        write(&d.phone, "new.md", "new\n");
        assert!(save_and_push(path(&d.phone), None).unwrap().success);
        assert!(sync_and_pull(path(&d.mac)).unwrap().success);
        for dir in [&d.mac, &d.phone] {
            assert_eq!(read(dir, "a.md"), "a from mac\n");
            assert_eq!(read(dir, "b.md"), "b from phone\n");
            assert_eq!(read(dir, "new.md"), "new\n");
            assert_eq!(get_repo_status(path(dir)).unwrap().state, SyncState::CleanSynced);
        }
    }

    #[test]
    fn syncing_keeps_unsaved_edits_and_commits_that_failed_to_upload() {
        let d = devices("offline");
        write(&d.mac, "a.md", "a from mac\n");
        save_and_push(path(&d.mac), None).unwrap();
        let phone = Repository::open(&d.phone).unwrap();
        write(&d.phone, "b.md", "b committed\n");
        commit_all(&phone, "offline").unwrap();
        write(&d.phone, "c.md", "c unsaved\n");
        assert!(sync_and_pull(path(&d.phone)).unwrap().success);
        assert_eq!(read(&d.phone, "a.md"), "a from mac\n");
        assert_eq!(read(&d.phone, "b.md"), "b committed\n");
        assert_eq!(read(&d.phone, "c.md"), "c unsaved\n");
        assert_eq!(get_repo_status(path(&d.phone)).unwrap().state, SyncState::AheadOffline);
    }

    #[test]
    fn the_chosen_version_is_kept() {
        for (kind, text, expected) in [
            ("local", None, "a from phone\n"),
            ("remote", None, "a from mac\n"),
            ("custom", Some("both\n"), "both\n"),
        ] {
            let d = conflicted(&format!("choose-{}", kind));
            resolve_conflicts(path(&d.phone), choose("a.md", kind, text)).unwrap();
            assert_eq!(read(&d.phone, "a.md"), expected);
            assert_eq!(read(&d.phone, "b.md"), "b from mac\n");
            assert!(save_and_push(path(&d.phone), None).unwrap().success);
            sync_and_pull(path(&d.mac)).unwrap();
            assert_eq!(read(&d.mac, "a.md"), expected);
        }
    }

    #[test]
    fn closing_the_resolver_loses_nothing_and_syncing_asks_again() {
        let d = conflicted("cancel");
        assert_eq!(sync_and_pull(path(&d.phone)).unwrap().conflicts.len(), 1);
        assert!(resolve_conflicts(path(&d.phone), vec![]).is_err());
        assert_eq!(read(&d.phone, "a.md"), "a from phone\n");
    }

    #[test]
    fn a_newer_update_than_the_one_shown_is_not_resolved_unseen() {
        let d = conflicted("newer");
        write(&d.mac, "a.md", "a from mac again\n");
        save_and_push(path(&d.mac), None).unwrap();
        fetch_remote(path(&d.phone)).unwrap();
        resolve_conflicts(path(&d.phone), choose("a.md", "local", None)).unwrap();
        let next = save_and_push(path(&d.phone), None).unwrap();
        assert_eq!(next.conflicts.len(), 1);
        assert_eq!(next.conflicts[0].remote_content, "a from mac again\n");
    }

    #[test]
    fn deleting_a_note_edited_elsewhere_asks() {
        let d = devices("delete");
        write(&d.mac, "a.md", "a from mac\n");
        save_and_push(path(&d.mac), None).unwrap();
        std::fs::remove_file(d.phone.join("a.md")).unwrap();
        let result = save_and_push(path(&d.phone), None).unwrap();
        assert!(result.conflicts[0].local_deleted && !result.conflicts[0].remote_deleted);
        resolve_conflicts(path(&d.phone), choose("a.md", "local", None)).unwrap();
        assert!(!d.phone.join("a.md").exists());
    }

    #[test]
    fn images_changed_on_both_devices_are_both_kept() {
        let d = devices("images");
        std::fs::write(d.mac.join("p.png"), [0xff, 1]).unwrap();
        save_and_push(path(&d.mac), None).unwrap();
        std::fs::write(d.phone.join("p.png"), [0xff, 2]).unwrap();
        assert!(save_and_push(path(&d.phone), None).unwrap().success);
        assert_eq!(std::fs::read(d.phone.join("p.png")).unwrap(), [0xff, 2]);
        assert_eq!(std::fs::read(d.phone.join("p (other device).png")).unwrap(), [0xff, 1]);
    }

    #[test]
    fn an_edit_made_while_syncing_is_not_overwritten() {
        let d = devices("race");
        write(&d.mac, "a.md", "a from mac\n");
        save_and_push(path(&d.mac), None).unwrap();
        let phone = Repository::open(&d.phone).unwrap();
        fetch_origin(&phone).unwrap();
        write(&d.phone, "a.md", "typed just now\n");
        assert!(integrate_remote(&phone, "Personal").is_err());
        assert_eq!(read(&d.phone, "a.md"), "typed just now\n");
    }

    #[test]
    fn switching_workspace_saves_into_the_one_being_left() {
        let d = devices("switch");
        create_workspace(path(&d.mac), "Work").unwrap();
        write(&d.mac, "w.md", "work\n");
        switch_workspace(path(&d.mac), "Personal").unwrap();
        assert!(!d.mac.join("w.md").exists());
        write(&d.mac, "a.md", "a from mac\n");
        switch_workspace(path(&d.mac), "Work").unwrap();
        assert_eq!(read(&d.mac, "w.md"), "work\n");
        assert!(!d.mac.join("a.md").exists());

        // The phone has edits and knows updates are waiting: it can still switch, and back.
        write(&d.phone, "b.md", "b from phone\n");
        fetch_remote(path(&d.phone)).unwrap();
        assert_eq!(get_repo_status(path(&d.phone)).unwrap().state, SyncState::DirtyBehind);
        switch_workspace(path(&d.phone), "Work").unwrap();
        assert_eq!(read(&d.phone, "w.md"), "work\n");
        let back = switch_workspace(path(&d.phone), "Personal").unwrap();
        assert_eq!((back.dirty_count, back.ahead_count), (0, 1));
        assert!(save_and_push(path(&d.phone), None).unwrap().success);
        assert_eq!(read(&d.phone, "a.md"), "a from mac\n");
        assert_eq!(read(&d.phone, "b.md"), "b from phone\n");
    }
}
