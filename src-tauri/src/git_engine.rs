use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;
use serde::{Deserialize, Serialize};
use git2::{BranchType, Cred, CredentialType, FetchOptions, IndexAddOption, PushOptions, RemoteCallbacks, Repository, Status, StatusOptions};

use crate::models::{
    ConflictFile, ConflictHunk, ConflictResolution, FileStatus, RepoStatusPayload, SyncResult, SyncState,
    VaultConfig, VaultConfigInput, WorkspaceList,
};

/// The branch that every notes repository keeps empty. Workspaces are the other branches.
const STORAGE_BRANCH: &str = "main";

/// The layout of a workspace this build understands. Raised when a change would make older builds
/// misread or damage it; they then stop syncing and ask to be updated.
const FORMAT_VERSION: u64 = 1;
const FORMAT_PATH: &str = ".noetic/format.json";

/// Every operation that changes the repository runs one at a time. The queue is for the whole
/// process; only public entry points take it, because it can't be taken twice.
static QUEUE: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn enter_queue(repo_path: &str) -> std::sync::MutexGuard<'static, ()> {
    let guard = QUEUE.lock().unwrap_or_else(|e| e.into_inner());
    remove_stale_locks(&Path::new(repo_path).join(".git"));
    guard
}

/// Removes lock files left behind when the app was killed half-way; git refuses to work until they
/// are gone. Nothing here holds one for long, so only those over a minute old are taken as stale.
fn remove_stale_locks(git_dir: &Path) {
    fn clean(path: &Path) {
        let stale = std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > std::time::Duration::from_secs(60));
        if stale {
            let _ = std::fs::remove_file(path);
        }
    }
    fn clean_refs(dir: &Path) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                clean_refs(&path);
            } else if path.extension().is_some_and(|e| e == "lock") {
                clean(&path);
            }
        }
    }
    for name in ["index.lock", "HEAD.lock", "config.lock", "packed-refs.lock"] {
        clean(&git_dir.join(name));
    }
    clean_refs(&git_dir.join("refs"));
}

/// The format version saved in a commit; 0 for a workspace from before versions were kept.
fn format_version(repo: &Repository, commit: git2::Oid) -> u64 {
    repo.find_commit(commit)
        .and_then(|c| c.tree())
        .and_then(|t| t.get_path(Path::new(FORMAT_PATH)))
        .and_then(|e| repo.find_blob(e.id()))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(b.content()).ok())
        .and_then(|v| v.get("version").and_then(|n| n.as_u64()))
        .unwrap_or(0)
}

fn check_format(repo: &Repository, commit: Option<git2::Oid>) -> Result<(), String> {
    match commit {
        Some(oid) if format_version(repo, oid) > FORMAT_VERSION => {
            Err("These notes were saved by a newer version of Noetic. Update the app on this device to keep syncing.".to_string())
        }
        _ => Ok(()),
    }
}

/// Paths that differ between two commits (`None` is an empty workspace).
fn changed_paths(repo: &Repository, from: Option<git2::Oid>, to: git2::Oid) -> HashSet<String> {
    let tree = |oid: git2::Oid| repo.find_commit(oid).and_then(|c| c.tree()).ok();
    let from_tree = from.and_then(tree);
    let mut paths = HashSet::new();
    if let Ok(diff) = repo.diff_tree_to_tree(from_tree.as_ref(), tree(to).as_ref(), None) {
        for delta in diff.deltas() {
            for file in [delta.old_file(), delta.new_file()] {
                if let Some(p) = file.path() {
                    paths.insert(p.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    paths
}

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

    // Held notes differ from what is committed on purpose; they are marked, not counted as edits.
    let held = load_held(&repo, &branch_name);
    let merged_notes = load_merged(&repo, &branch_name);

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

            if (is_modified || is_untracked) && normalized != FORMAT_PATH && !held.contains_key(&normalized) {
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
    let mut not_uploaded: HashSet<String> = HashSet::new();

    if let (Some(h_oid), Some(r_oid)) = (head_oid, remote_oid) {
        if let Ok((ahead, behind)) = repo.graph_ahead_behind(h_oid, r_oid) {
            ahead_count = ahead;
            behind_count = behind;
        }

        // Each side's changes since the last common save.
        let base_oid = repo.merge_base(h_oid, r_oid).ok();
        remote_diff_files = changed_paths(&repo, base_oid, r_oid);
        not_uploaded = changed_paths(&repo, base_oid, h_oid);
    } else if let Some(h_oid) = head_oid {
        // No remote branch yet, but local commits exist
        let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
        revwalk.push(h_oid).ok();
        ahead_count = revwalk.count();
        not_uploaded = changed_paths(&repo, None, h_oid);
    }

    not_uploaded.retain(|p| !held.contains_key(p));

    // 4. Combine all known files
    let mut all_paths: HashSet<String> = held.keys().cloned().collect();
    all_paths.extend(dirty_map.keys().cloned());
    all_paths.extend(merged_notes.keys().cloned());
    all_paths.extend(remote_diff_files.iter().cloned());
    all_paths.extend(not_uploaded.iter().cloned());
    all_paths.remove(FORMAT_PATH);

    let mut file_statuses: Vec<FileStatus> = Vec::new();
    for path in all_paths {
        let (is_mod, is_untracked) = dirty_map.get(&path).copied().unwrap_or((false, false));
        let has_remote = remote_diff_files.contains(&path);
        let waiting = held.get(&path).map(|n| n.waiting);
        let merged = merged_notes
            .get(&path)
            .is_some_and(|m| read_disk(&repo, &path).as_deref() == Some(m.after.as_str()));

        file_statuses.push(FileStatus {
            conflict: waiting == Some(Waiting::Conflict),
            update_waiting: waiting == Some(Waiting::Update),
            merged,
            not_uploaded: is_mod || is_untracked || not_uploaded.contains(&path),
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
        has_conflict: conflict_waiting(&repo, &branch_name),
        other_workspaces_not_uploaded: other_workspaces_waiting(&repo, &branch_name)
            .into_iter()
            .map(|(name, _)| name)
            .collect(),
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
    let _queue = enter_queue(repo_path);
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
    let _ = fetch_origin(&repo);
    get_repo_status(repo_path)
}

/// Stages everything (`git add -A`) and commits it to the current branch. Returns false when
/// there was nothing new to commit.
fn commit_all(repo: &Repository, message: &str) -> Result<bool, String> {
    let head = repo.head().ok().and_then(|h| h.target());
    check_format(repo, head)?;
    if let Some(root) = repo.workdir() {
        if head.is_none_or(|oid| format_version(repo, oid) < FORMAT_VERSION) || !root.join(FORMAT_PATH).exists() {
            let _ = std::fs::create_dir_all(root.join(".noetic"));
            std::fs::write(root.join(FORMAT_PATH), format!("{{\"version\":{}}}\n", FORMAT_VERSION))
                .map_err(|e| format!("Failed to save: {}", e))?;
        }
    }

    let mut index = repo.index().map_err(|e| format!("Failed to get repo index: {}", e))?;
    index
        .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
        .map_err(|e| format!("Failed to stage files: {}", e))?;
    index
        .update_all(["*"].iter(), None)
        .map_err(|e| format!("Failed to update staged index: {}", e))?;
    // Held notes keep their committed (cloud) version until they are brought together.
    if let Some(workspace) = current_workspace(repo) {
        for path in load_held(repo, &workspace).keys() {
            let result = match head_entry(repo, path) {
                Some((oid, mode)) => index.add(&index_entry(path, oid, mode)),
                None => index.remove_path(Path::new(path)).or(Ok(())),
            };
            result.map_err(|e| format!("Failed to stage files: {}", e))?;
        }
    }
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

/// Sync now:
/// 1. Commits everything on this device, so nothing that follows can lose it.
/// 2. Brings in changes from the other devices and combines them (see `integrate_commit`). A note
///    changed in the same place on both is held for the user to choose, and the rest syncs.
/// 3. Uploads the workspace (the commit stays on this device if that fails, e.g. offline).
///
/// `open_note` is the note on screen: changes to it wait for the user to tap the banner.
pub fn sync_now(repo_path: &str, open_note: Option<&str>) -> Result<SyncResult, String> {
    let _queue = enter_queue(repo_path);
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;

    if repo.find_remote("origin").is_err() {
        return Err("Your notes are kept on this device. Sign in to back them up and sync them.".to_string());
    }
    let Some(workspace) = current_workspace(&repo) else {
        return Err("Choose or create a workspace first.".to_string());
    };
    // Left by builds that asked about conflicts straight away; held notes replaced it.
    if let Ok(mut r) = repo.find_reference(&format!("refs/noetic/incoming/{}", workspace)) {
        let _ = r.delete();
    }

    let mut notices = Vec::new();
    settle_held(&repo, &workspace, open_note, &mut notices)?;
    commit_all(&repo, &format!("Notes update: {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")))?;

    let not_uploaded = |e: String| format!("Kept on this device, not uploaded yet: {}", e);
    let mut combined = false;
    let mut uploaded = false;
    let mut attempt = 0u32;
    loop {
        // Fetching first on every attempt also makes a retry safe when an earlier push got through
        // but its answer didn't: there is then nothing left to upload.
        fetch_origin(&repo).map_err(not_uploaded)?;
        let outcome = integrate_remote(&repo, &workspace, open_note)?;
        combined |= outcome.changed;
        notices.extend(outcome.notices);
        let head = repo.head().ok().and_then(|h| h.target());
        if head == find_remote_tracking_branch(&repo, &workspace).1 {
            break;
        }
        match push_workspace(&repo, &workspace) {
            Ok(()) => {
                uploaded = true;
                break;
            }
            // Another device may have uploaded in between: wait a little, differently on each
            // device, and combine again.
            Err(_) if attempt < 3 => {
                attempt += 1;
                std::thread::sleep(retry_delay(attempt));
            }
            Err(e) => return Err(not_uploaded(e)),
        }
    }

    // Commits made in other workspaces (offline, before switching) go up too. Updates for them are
    // only brought in when they are opened.
    upload_other_workspaces(&repo, &workspace);

    let conflicts = conflict_files(&repo, &workspace);
    let message = if !conflicts.is_empty() {
        format!(
            "Synced, except {} note(s) changed in the same place here and on another device. Open the marked note to choose a version.",
            conflicts.len()
        )
    } else {
        match (combined, uploaded) {
            (true, true) => "Synced. Your edits were combined with the updates from your other devices.",
            (true, false) => "Synced. Updates from your other devices were added.",
            (false, true) => "Synced. Your changes are backed up.",
            (false, false) => "Everything is up to date.",
        }
        .to_string()
    };
    Ok(SyncResult {
        success: true,
        message,
        state: get_repo_status(repo_path)?.state,
        conflicts,
        notices,
    })
}

/// For the Android background job: syncs only when something on this device is waiting to upload,
/// so a job run for nothing doesn't touch the network.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn upload_waiting(repo_path: &str, open_note: Option<&str>) -> Result<(), String> {
    let status = get_repo_status(repo_path)?;
    let waiting = status.dirty_count > 0 || status.ahead_count > 0 || !status.other_workspaces_not_uploaded.is_empty();
    if status.branch.is_empty() || status.remote_url.is_none() || !waiting {
        return Ok(());
    }
    sync_now(repo_path, open_note).map(|_| ())
}

/// Whether a failed sync may work later on its own (a connection problem), rather than needing the
/// user (a refused sign-in, an app update).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn worth_retrying(error: &str) -> bool {
    let needs_user = ["sign-in", "Sign in", "sign in", "newer version"];
    !needs_user.iter().any(|s| error.contains(s))
}

/// Workspaces other than `current` whose commits the cloud doesn't have, and whether they can be
/// uploaded as they are (the cloud has nothing newer).
fn other_workspaces_waiting(repo: &Repository, current: &str) -> Vec<(String, bool)> {
    let Ok(branches) = repo.branches(Some(BranchType::Local)) else { return vec![] };
    let mut waiting = Vec::new();
    for (branch, _) in branches.flatten() {
        let Ok(Some(name)) = branch.name() else { continue };
        if name == current || name == STORAGE_BRANCH {
            continue;
        }
        let Some(local) = branch.get().target() else { continue };
        let remote = find_remote_tracking_branch(repo, name).1;
        match remote {
            Some(r) if r == local || repo.graph_descendant_of(r, local).unwrap_or(false) => {}
            Some(r) => waiting.push((name.to_string(), repo.graph_descendant_of(local, r).unwrap_or(false))),
            None => waiting.push((name.to_string(), true)),
        }
    }
    waiting
}

/// Uploads what can go up as it is. One that diverged waits until it is opened and combined.
fn upload_other_workspaces(repo: &Repository, current: &str) {
    for (name, ready) in other_workspaces_waiting(repo, current) {
        if ready {
            let _ = push_workspace(repo, &name);
        }
    }
}

fn retry_delay(attempt: u32) -> std::time::Duration {
    let step = 250u64 << attempt;
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::from(d.subsec_nanos()) / 1000 % step);
    std::time::Duration::from_millis(step / 2 + jitter)
}

/// The notes waiting for a version to be chosen, for the resolver.
pub fn get_conflicts(repo_path: &str) -> Result<Vec<ConflictFile>, String> {
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
    Ok(current_workspace(&repo).map(|w| conflict_files(&repo, &w)).unwrap_or_default())
}

/// Applies the versions chosen in the resolver and commits them; the caller then syncs to upload
/// them. Nothing is applied if a note changed on another device since the resolver was opened.
pub fn resolve_conflicts(
    repo_path: &str,
    resolutions: Vec<ConflictResolution>,
) -> Result<RepoStatusPayload, String> {
    let _queue = enter_queue(repo_path);
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repo: {}", e))?;
    let workspace = current_workspace(&repo).ok_or_else(|| "Choose or create a workspace first.".to_string())?;
    let mut held = load_held(&repo, &workspace);
    for res in &resolutions {
        crate::fs_engine::resolve_in_vault(Path::new(repo_path), &res.path)?;
        if !held.get(&res.path).is_some_and(|n| n.waiting == Waiting::Conflict) {
            return Err(format!("\"{}\" no longer needs a choice. Sync again.", note_name(&res.path)));
        }
        if res.remote_id.as_ref().is_some_and(|id| *id != head_id(&repo, &res.path)) {
            return Err(format!(
                "\"{}\" changed again on another device. Open it again to see the newest version.",
                note_name(&res.path)
            ));
        }
    }
    for res in &resolutions {
        match (res.resolution_type.as_str(), &res.custom_content) {
            // This device's version is already on disk.
            ("local", _) => {}
            ("remote", _) => write_disk(&repo, &res.path, head_text(&repo, &res.path).as_deref())?,
            (_, Some(text)) => write_disk(&repo, &res.path, Some(text))?,
            _ => return Err(format!("No version was chosen for {}.", note_name(&res.path))),
        }
        held.remove(&res.path);
    }
    save_held(&repo, &workspace, &held)?;
    commit_all(&repo, &format!("Chose versions: {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S")))?;
    get_repo_status(repo_path)
}

/// Brings the update waiting for an open note into it (the banner was tapped, or the note closed).
/// If what was typed meanwhile changed the same lines, the note becomes a conflict instead.
pub fn apply_update(repo_path: &str, path: &str) -> Result<SyncResult, String> {
    let _queue = enter_queue(repo_path);
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
    let workspace = current_workspace(&repo).ok_or_else(|| "Choose or create a workspace first.".to_string())?;
    let mut held = load_held(&repo, &workspace);
    let mut notices = Vec::new();
    if held.get(path).is_some_and(|n| n.waiting == Waiting::Update) {
        release_update(&repo, &workspace, path, &mut held, &mut notices)?;
        save_held(&repo, &workspace, &held)?;
    }
    let conflicts = conflict_files(&repo, &workspace);
    let conflicted = conflicts.iter().any(|c| c.path == path);
    Ok(SyncResult {
        success: !conflicted,
        message: if conflicted {
            format!("\"{}\" was changed in the same place on another device. Choose a version.", note_name(path))
        } else {
            "Updated.".to_string()
        },
        state: get_repo_status(repo_path)?.state,
        conflicts,
        notices,
    })
}

/// Puts back this device's version of a note from before it was combined automatically (`undo`),
/// or keeps the combined one and forgets the earlier version.
pub fn settle_merge(repo_path: &str, path: &str, undo: bool) -> Result<RepoStatusPayload, String> {
    let _queue = enter_queue(repo_path);
    let repo = Repository::open(repo_path).map_err(|e| format!("Failed to open repository: {}", e))?;
    let workspace = current_workspace(&repo).ok_or_else(|| "Choose or create a workspace first.".to_string())?;
    let mut merged = load_merged(&repo, &workspace);
    if let Some(m) = merged.remove(path) {
        save_merged(&repo, &workspace, &merged)?;
        if undo {
            if read_disk(&repo, path).as_deref() != Some(m.after.as_str()) {
                return Err("The note has changed since it was combined, so it was left as it is.".to_string());
            }
            write_disk(&repo, path, m.before.as_deref())?;
        }
    }
    get_repo_status(repo_path)
}

// ---------------------------------------------------------------------------
// Combining this device's notes with the cloud copy
// ---------------------------------------------------------------------------

/// What bringing in the cloud copy did.
#[derive(Default)]
struct Integration {
    changed: bool,
    /// Notes newly held because they changed in the same place on both devices.
    conflicts: Vec<String>,
    notices: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Waiting {
    /// Both devices changed the same lines: the user chooses a version.
    Conflict,
    /// The note was open: the update is brought in when the banner is tapped or the note is closed.
    Update,
}

/// A held note: the workspace's commits have the cloud version, while this device's version stays
/// on disk and is left out of commits until the two are brought together. Uploading it would
/// replace the other device's version unseen.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct HeldNote {
    waiting: Waiting,
    /// The version both started from (`None`: the note didn't exist).
    base: Option<String>,
    /// This device's version, kept here while another workspace is open (`None`: deleted).
    #[serde(default)]
    local: Option<String>,
}

type Held = BTreeMap<String, HeldNote>;

/// This device's version of a note from before an automatic merge rewrote it.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct MergedNote {
    /// `None`: the note didn't exist here.
    before: Option<String>,
    /// What the merge wrote. Once the note is changed again, the merge can't be undone.
    after: String,
}

type Merged = BTreeMap<String, MergedNote>;

/// Per-workspace records kept on this device only, inside `.git` so they never sync.
fn state_file(repo: &Repository, kind: &str, workspace: &str) -> std::path::PathBuf {
    repo.path().join("noetic").join(format!("{}-{}.json", kind, workspace))
}

fn load_state<T: serde::de::DeserializeOwned>(repo: &Repository, kind: &str, workspace: &str) -> BTreeMap<String, T> {
    std::fs::read(state_file(repo, kind, workspace))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_state<T: Serialize>(repo: &Repository, kind: &str, workspace: &str, value: &BTreeMap<String, T>) -> Result<(), String> {
    let file = state_file(repo, kind, workspace);
    if value.is_empty() {
        let _ = std::fs::remove_file(&file);
        return Ok(());
    }
    let failed = |e: std::io::Error| format!("Failed to keep track of held notes: {}", e);
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
    }
    let json = serde_json::to_vec_pretty(value).map_err(|e| format!("Failed to keep track of held notes: {}", e))?;
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, json).map_err(failed)?;
    std::fs::rename(&tmp, &file).map_err(failed)
}

fn load_held(repo: &Repository, workspace: &str) -> Held {
    load_state(repo, "held", workspace)
}

fn save_held(repo: &Repository, workspace: &str, held: &Held) -> Result<(), String> {
    save_state(repo, "held", workspace, held)
}

fn load_merged(repo: &Repository, workspace: &str) -> Merged {
    load_state(repo, "merged", workspace)
}

fn save_merged(repo: &Repository, workspace: &str, merged: &Merged) -> Result<(), String> {
    save_state(repo, "merged", workspace, merged)
}

fn conflict_waiting(repo: &Repository, workspace: &str) -> bool {
    !workspace.is_empty() && load_held(repo, workspace).values().any(|n| n.waiting == Waiting::Conflict)
}

/// A note's name as the user sees it.
fn note_name(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name)
}

fn disk_path(repo: &Repository, path: &str) -> Result<std::path::PathBuf, String> {
    let root = repo.workdir().ok_or("The notes folder can't be found.")?;
    crate::fs_engine::resolve_in_vault(root, path)
}

/// A note's text on disk; `None` when it is missing or isn't text.
fn read_disk(repo: &Repository, path: &str) -> Option<String> {
    disk_path(repo, path).ok().and_then(|p| std::fs::read_to_string(p).ok())
}

/// Writes a note, or deletes it for `None`.
fn write_disk(repo: &Repository, path: &str, text: Option<&str>) -> Result<(), String> {
    let full = disk_path(repo, path)?;
    let failed = |e: std::io::Error| format!("Failed to update {}: {}", note_name(path), e);
    match text {
        Some(text) => {
            if let Some(dir) = full.parent() {
                std::fs::create_dir_all(dir).map_err(failed)?;
            }
            std::fs::write(&full, text).map_err(failed)
        }
        None if full.exists() => std::fs::remove_file(&full).map_err(failed),
        None => Ok(()),
    }
}

fn head_entry(repo: &Repository, path: &str) -> Option<(git2::Oid, i32)> {
    let tree = repo.head().ok()?.peel_to_tree().ok()?;
    let entry = tree.get_path(Path::new(path)).ok()?;
    Some((entry.id(), entry.filemode()))
}

/// The committed (cloud) version of a note; `None` when there is none or it isn't text.
fn head_text(repo: &Repository, path: &str) -> Option<String> {
    let (oid, _) = head_entry(repo, path)?;
    file_text(repo, Some(&(oid, 0)))
}

/// Identifies the committed version shown in the resolver; empty when there is none.
fn head_id(repo: &Repository, path: &str) -> String {
    head_entry(repo, path).map(|(oid, _)| oid.to_string()).unwrap_or_default()
}

fn came_back(path: &str) -> String {
    format!("\"{}\" was deleted on one device and changed on another, so it was kept.", note_name(path))
}

/// The notes waiting for the user to choose a version, as the resolver shows them.
fn conflict_files(repo: &Repository, workspace: &str) -> Vec<ConflictFile> {
    load_held(repo, workspace)
        .into_iter()
        .filter(|(_, note)| note.waiting == Waiting::Conflict)
        .map(|(path, note)| {
            let local = read_disk(repo, &path);
            let remote = head_text(repo, &path);
            let base = note.base.unwrap_or_default();
            ConflictFile {
                hunks: vec![ConflictHunk {
                    id: format!("hunk_{}", path.replace(['/', '\\', '.'], "_")),
                    base_lines: base.clone(),
                    local_lines: local.clone().unwrap_or_default(),
                    remote_lines: remote.clone().unwrap_or_default(),
                }],
                base_content: base,
                local_deleted: local.is_none(),
                remote_deleted: remote.is_none(),
                local_content: local.unwrap_or_default(),
                remote_content: remote.unwrap_or_default(),
                remote_id: head_id(repo, &path),
                path,
            }
        })
        .collect()
}

/// Brings a held update into the note on disk: what was typed meanwhile is merged with it. If
/// they changed the same lines, the note becomes a conflict for the user instead.
fn release_update(repo: &Repository, workspace: &str, path: &str, held: &mut Held, notices: &mut Vec<String>) -> Result<(), String> {
    let Some(note) = held.get(path).cloned() else { return Ok(()) };
    let local = read_disk(repo, path);
    let remote = head_text(repo, path);
    let base = note.base.as_deref();
    let result: Option<Option<String>> = match (&local, &remote) {
        (None, None) => Some(None),
        // Deleted on the other device meanwhile: gone, unless it was changed here.
        (Some(l), None) if Some(l.as_str()) == base => Some(None),
        // Edits beat deletes, whichever side made them.
        (Some(_), None) | (None, Some(_)) => {
            notices.push(came_back(path));
            Some(local.clone().or_else(|| remote.clone()))
        }
        (Some(l), Some(r)) => crate::merge::merge_text(path, base.unwrap_or(""), l, r).map(Some),
    };
    match result {
        Some(text) => {
            write_disk(repo, path, text.as_deref())?;
            let typed_meanwhile = local.as_deref() != base;
            if let (true, Some(before), Some(after)) = (typed_meanwhile && text != remote, &local, &text) {
                let mut merged = load_merged(repo, workspace);
                merged.insert(path.to_string(), MergedNote { before: Some(before.clone()), after: after.clone() });
                save_merged(repo, workspace, &merged)?;
            }
            held.remove(path);
        }
        None => {
            if let Some(n) = held.get_mut(path) {
                n.waiting = Waiting::Conflict;
            }
        }
    }
    Ok(())
}

/// Lets go of held notes that no longer need waiting: updates to a note that isn't open any more,
/// and conflicts where both versions have become the same.
fn settle_held(repo: &Repository, workspace: &str, open_note: Option<&str>, notices: &mut Vec<String>) -> Result<(), String> {
    let mut held = load_held(repo, workspace);
    let paths: Vec<(String, Waiting)> = held.iter().map(|(p, n)| (p.clone(), n.waiting)).collect();
    for (path, waiting) in paths {
        if read_disk(repo, &path) == head_text(repo, &path) {
            held.remove(&path);
        } else if waiting == Waiting::Update && Some(path.as_str()) != open_note {
            release_update(repo, workspace, &path, &mut held, notices)?;
        }
    }
    save_held(repo, workspace, &held)?;

    // A merge can only be undone while the note is as the merge left it.
    let mut merged = load_merged(repo, workspace);
    merged.retain(|path, m| read_disk(repo, path).as_deref() == Some(m.after.as_str()));
    save_merged(repo, workspace, &merged)
}

fn integrate_remote(repo: &Repository, workspace: &str, open_note: Option<&str>) -> Result<Integration, String> {
    let (_, Some(remote)) = find_remote_tracking_branch(repo, workspace) else {
        return Ok(Integration::default());
    };
    check_format(repo, Some(remote))?;
    integrate_commit(repo, workspace, remote, open_note)
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

/// Files moved to a new name between two commits, found by similarity.
fn renamed(repo: &Repository, from: Option<git2::Oid>, to: git2::Oid) -> Vec<(String, String)> {
    let tree = |oid: git2::Oid| repo.find_commit(oid).and_then(|c| c.tree()).ok();
    let (Some(a), Some(b)) = (from.and_then(tree), tree(to)) else { return vec![] };
    let Ok(mut diff) = repo.diff_tree_to_tree(Some(&a), Some(&b), None) else { return vec![] };
    let mut opts = git2::DiffFindOptions::new();
    opts.renames(true);
    if diff.find_similar(Some(&mut opts)).is_err() {
        return vec![];
    }
    let name = |f: git2::DiffFile| f.path().map(|p| p.to_string_lossy().replace('\\', "/"));
    diff.deltas()
        .filter(|d| d.status() == git2::Delta::Renamed)
        .filter_map(|d| Some((name(d.old_file())?, name(d.new_file())?)))
        .collect()
}

type File = Option<(git2::Oid, i32)>;

/// A note renamed on one device and edited on the other: the edit follows it to the new name,
/// instead of the old name coming back with the edit.
#[allow(clippy::too_many_arguments)]
fn follow_renames(
    repo: &Repository,
    base: Option<git2::Oid>,
    (ours, theirs): (git2::Oid, git2::Oid),
    base_files: &TreeFiles,
    our_files: &TreeFiles,
    their_files: &TreeFiles,
    sides: &mut BTreeMap<String, [File; 3]>,
) {
    for (old, new) in renamed(repo, base, ours) {
        let (b, t) = (base_files.get(&old).copied(), their_files.get(&old).copied());
        if t.is_some() && t != b && !their_files.contains_key(&new) {
            sides.insert(new.clone(), [b, our_files.get(&new).copied(), t]);
            sides.insert(old, [b, None, None]);
        }
    }
    for (old, new) in renamed(repo, base, theirs) {
        let (b, o) = (base_files.get(&old).copied(), our_files.get(&old).copied());
        if o.is_some() && o != b && !our_files.contains_key(&new) {
            sides.insert(new.clone(), [b, o, their_files.get(&new).copied()]);
            sides.insert(old, [b, None, None]);
        }
    }
}

fn index_entry(path: &str, oid: git2::Oid, mode: i32) -> git2::IndexEntry {
    git2::IndexEntry {
        ctime: git2::IndexTime::new(0, 0),
        mtime: git2::IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode: mode as u32,
        uid: 0,
        gid: 0,
        file_size: 0,
        id: oid,
        flags: 0,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}

/// Brings `theirs` into the workspace. The caller has committed this device's edits.
/// - A file changed on one side takes that side.
/// - A text file changed on both is merged (by line, or by card for a canvas). Where both changed
///   the same part, the note is held: the commit takes the cloud version and this device's stays
///   on disk until the user chooses.
/// - Deleted on one side and changed on the other: the changed version is kept.
/// - Other files changed on both: both copies are kept.
/// - `open_note`, if it would change on disk, is held for the banner instead.
///
/// The result is a merge commit (or a plain fast-forward), so commits made here are always kept.
fn integrate_commit(repo: &Repository, workspace: &str, theirs: git2::Oid, open_note: Option<&str>) -> Result<Integration, String> {
    let failed = |e: git2::Error| format!("Failed to combine your notes: {}", e.message());
    let ours = repo.head().ok().and_then(|h| h.target()).ok_or("This workspace has no notes yet.")?;
    let base = repo.merge_base(ours, theirs).ok();
    let mut result = Integration::default();
    if base == Some(theirs) {
        return Ok(result);
    }
    let held_before = load_held(repo, workspace);
    let mut held = held_before.clone();
    let mut merged_notes = load_merged(repo, workspace);
    let our_files = tree_files(repo, Some(ours))?;

    let target = if base == Some(ours) {
        theirs
    } else {
        let base_files = tree_files(repo, base)?;
        let their_files = tree_files(repo, Some(theirs))?;
        let mut sides: BTreeMap<String, [File; 3]> = our_files
            .keys()
            .chain(their_files.keys())
            .map(|p| (p.clone(), [base_files.get(p).copied(), our_files.get(p).copied(), their_files.get(p).copied()]))
            .collect();
        follow_renames(repo, base, (ours, theirs), &base_files, &our_files, &their_files, &mut sides);

        let mut merged = TreeFiles::new();
        let mut extra_copies: Vec<(String, (git2::Oid, i32))> = Vec::new();
        for (path, [b, o, t]) in &sides {
            let picked = if o == t || t == b {
                *o
            } else if o == b {
                *t
            } else if path == FORMAT_PATH {
                // Never a question for the user. A newer one than this build's was refused already.
                t.or(*o)
            } else if o.is_none() || t.is_none() {
                result.notices.push(came_back(path));
                o.or(*t)
            } else if let (Some(base_text), Some(local), Some(remote)) =
                (file_text(repo, b.as_ref()), file_text(repo, o.as_ref()), file_text(repo, t.as_ref()))
            {
                match crate::merge::merge_text(path, &base_text, &local, &remote) {
                    Some(text) => {
                        if Some(path.as_str()) != open_note {
                            merged_notes.insert(path.clone(), MergedNote { before: Some(local), after: text.clone() });
                        }
                        let mode = o.map_or(0o100644, |f| f.1);
                        Some((repo.blob(text.as_bytes()).map_err(failed)?, mode))
                    }
                    None => {
                        held.insert(path.clone(), HeldNote { waiting: Waiting::Conflict, base: b.map(|_| base_text), local: None });
                        result.conflicts.push(path.clone());
                        *t
                    }
                }
            } else {
                // An image or similar: there is no text to compare, so both copies are kept.
                if let Some(t) = t {
                    extra_copies.push((path.clone(), *t));
                }
                *o
            };
            if let Some(file) = picked {
                merged.insert(path.clone(), file);
            }
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
            index.add(&index_entry(path, *oid, *mode)).map_err(failed)?;
        }
        let tree = index.write_tree_to(repo).and_then(|oid| repo.find_tree(oid)).map_err(failed)?;
        let our_commit = repo.find_commit(ours).map_err(failed)?;
        let their_commit = repo.find_commit(theirs).map_err(failed)?;
        let sig = signature(repo);
        repo.commit(None, &sig, &sig, "Combined changes from your devices", &tree, &[&our_commit, &their_commit])
            .map_err(failed)?
    };

    // The open note isn't changed under the user's hands: the update waits for the banner.
    if let Some(note) = open_note.filter(|n| !held.contains_key(*n)) {
        let after = tree_files(repo, Some(target))?.get(note).copied();
        let before = our_files.get(note).copied();
        if before.is_some() && after.is_some() && before != after {
            if let Some(text) = file_text(repo, before.as_ref()) {
                held.insert(note.to_string(), HeldNote { waiting: Waiting::Update, base: Some(text), local: None });
                merged_notes.remove(note);
            }
        }
    }

    // Recorded first, so a held note is never taken for an ordinary edit and uploaded.
    save_held(repo, workspace, &held)?;
    if let Err(e) = advance_to(repo, workspace, target, &held) {
        let _ = save_held(repo, workspace, &held_before);
        return Err(e);
    }
    save_merged(repo, workspace, &merged_notes)?;
    result.changed = true;
    Ok(result)
}

/// Updates the folder and the workspace to a commit that contains everything already committed
/// here. Only files that differ are written, and held notes are left as they are on disk. Never
/// forced: if a file was edited since the last commit nothing is written at all.
fn advance_to(repo: &Repository, workspace: &str, target: git2::Oid, held: &Held) -> Result<(), String> {
    let head = repo.head().ok().and_then(|h| h.target());
    let (old_files, new_files) = (tree_files(repo, head)?, tree_files(repo, Some(target))?);
    let paths: BTreeSet<&String> = old_files
        .keys()
        .chain(new_files.keys())
        .filter(|p| old_files.get(*p) != new_files.get(*p) && !held.contains_key(*p))
        .collect();

    let edited = || "A note was being edited while syncing, so nothing was changed. Try again.".to_string();
    for path in &paths {
        let clean = match repo.status_file(Path::new(path.as_str())) {
            Ok(s) => s.is_empty(),
            Err(e) => e.code() == git2::ErrorCode::NotFound,
        };
        if !clean {
            return Err(edited());
        }
    }

    let root = repo.workdir().ok_or("The notes folder can't be found.")?.to_path_buf();
    let failed = |e: String| format!("Failed to update your notes: {}", e);
    let mut index = repo.index().map_err(|e| failed(e.to_string()))?;
    for path in &paths {
        let full = disk_path(repo, path)?;
        match new_files.get(*path) {
            Some((oid, _)) => {
                let blob = repo.find_blob(*oid).map_err(|e| failed(e.to_string()))?;
                if let Some(dir) = full.parent() {
                    std::fs::create_dir_all(dir).map_err(|e| failed(e.to_string()))?;
                }
                std::fs::write(&full, blob.content()).map_err(|e| failed(e.to_string()))?;
                index.add_path(Path::new(path.as_str())).map_err(|e| failed(e.to_string()))?;
            }
            None => {
                if full.exists() {
                    std::fs::remove_file(&full).map_err(|e| failed(e.to_string()))?;
                }
                let _ = index.remove_path(Path::new(path.as_str()));
                // Like git, a folder left empty goes too.
                let mut dir = full.parent();
                while let Some(d) = dir.filter(|d| *d != root.as_path()) {
                    if std::fs::remove_dir(d).is_err() {
                        break;
                    }
                    dir = d.parent();
                }
            }
        }
    }
    index.write().map_err(|e| failed(e.to_string()))?;

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
    let _queue = enter_queue(repo_path);
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
        let _queue = enter_queue(repo_path);
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
    // Held notes aren't committed, so this device's versions are kept aside until it comes back.
    let mut held = load_held(repo, workspace);
    if !held.is_empty() {
        for (path, note) in held.iter_mut() {
            note.local = read_disk(repo, path);
        }
        save_held(repo, workspace, &held)?;
    }
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

const WELCOME_NOTE: &str = "Noetic keeps your notes as plain Markdown files on this device and backs them up to your account.\n\n- **Sync now** uploads your changes and brings in the ones made on your other devices.\n- **Workspaces** keep separate sets of notes apart, for example Personal and Work. Switch or add one from the workspace menu.\n";

/// Creates a workspace and opens it. A new workspace starts blank, except the first one on a
/// device: notes already in the folder (written before signing in) move into it.
pub fn create_workspace(repo_path: &str, name: &str) -> Result<RepoStatusPayload, String> {
    let _queue = enter_queue(repo_path);
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
    let _queue = enter_queue(repo_path);
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
        // This device's versions of the workspace's held notes go back where they were.
        for (path, note) in load_held(&repo, workspace) {
            write_disk(&repo, &path, note.local.as_deref())?;
        }
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
        sync_now(path(&mac), None).unwrap();
        connect_vault(path(&phone), path(&cloud), None, None, None).unwrap();
        switch_workspace(path(&phone), "Personal").unwrap();
        assert_eq!(read(&phone, "b.md"), "b\n");
        Devices { mac, phone }
    }

    #[test]
    fn different_notes_changed_on_two_devices_are_both_kept() {
        let d = devices("different");
        write(&d.mac, "a.md", "a from mac\n");
        sync_now(path(&d.mac), None).unwrap();

        // The phone hasn't checked the cloud since, so it doesn't know it is behind.
        write(&d.phone, "b.md", "b from phone\n");
        let _ = sync_now(path(&d.phone), None);
        let _ = sync_now(path(&d.phone), None).unwrap();
        assert_eq!(read(&d.phone, "a.md"), "a from mac\n");
        assert_eq!(read(&d.phone, "b.md"), "b from phone\n");
    }

    /// The same line of a note edited on both devices. The phone syncs second: its version is
    /// held on disk, the rest syncs, and the cloud keeps the Mac's version until a choice is made.
    fn conflicted(name: &str) -> Devices {
        let d = devices(name);
        write(&d.mac, "a.md", "a from mac\n");
        write(&d.mac, "b.md", "b from mac\n");
        sync_now(path(&d.mac), None).unwrap();
        write(&d.phone, "a.md", "a from phone\n");
        write(&d.phone, "c.md", "c from phone\n");
        let result = sync_now(path(&d.phone), None).unwrap();
        assert!(result.success);
        assert_eq!(result.conflicts.len(), 1);
        let c = &result.conflicts[0];
        assert_eq!(
            (c.base_content.as_str(), c.local_content.as_str(), c.remote_content.as_str()),
            ("a\n", "a from phone\n", "a from mac\n")
        );
        assert_eq!(read(&d.phone, "a.md"), "a from phone\n");
        assert_eq!(read(&d.phone, "b.md"), "b from mac\n");
        let status = get_repo_status(path(&d.phone)).unwrap();
        assert!(status.has_conflict);
        assert_eq!(status.state, SyncState::CleanSynced);
        assert!(status.files.iter().any(|f| f.path == "a.md" && f.conflict && !f.not_uploaded));
        sync_now(path(&d.mac), None).unwrap();
        assert_eq!(read(&d.mac, "a.md"), "a from mac\n");
        assert_eq!(read(&d.mac, "c.md"), "c from phone\n");
        d
    }

    fn choose(note: &str, kind: &str, text: Option<&str>) -> Vec<ConflictResolution> {
        vec![ConflictResolution {
            path: note.into(),
            resolution_type: kind.into(),
            custom_content: text.map(Into::into),
            remote_id: None,
        }]
    }

    #[test]
    fn edits_to_different_lines_of_a_note_are_merged_and_can_be_undone() {
        let d = devices("lines");
        write(&d.mac, "a.md", "one\ntwo\nthree\n");
        sync_now(path(&d.mac), None).unwrap();
        sync_now(path(&d.phone), None).unwrap();
        write(&d.mac, "a.md", "ONE\ntwo\nthree\n");
        sync_now(path(&d.mac), None).unwrap();
        write(&d.phone, "a.md", "one\ntwo\nTHREE\n");
        let result = sync_now(path(&d.phone), None).unwrap();
        assert!(result.conflicts.is_empty());
        assert_eq!(read(&d.phone, "a.md"), "ONE\ntwo\nTHREE\n");
        sync_now(path(&d.mac), None).unwrap();
        assert_eq!(read(&d.mac, "a.md"), "ONE\ntwo\nTHREE\n");

        let merged = |dir: &Path| get_repo_status(path(dir)).unwrap().files.iter().any(|f| f.path == "a.md" && f.merged);
        assert!(merged(&d.phone) && !merged(&d.mac));
        settle_merge(path(&d.phone), "a.md", true).unwrap();
        assert_eq!(read(&d.phone, "a.md"), "one\ntwo\nTHREE\n");
        assert!(!merged(&d.phone));
    }

    #[test]
    fn a_held_note_is_left_out_until_a_version_is_chosen() {
        let d = conflicted("held");
        write(&d.phone, "a.md", "a from phone, more\n");
        write(&d.phone, "b.md", "b from phone\n");
        assert!(sync_now(path(&d.phone), None).unwrap().success);
        sync_now(path(&d.mac), None).unwrap();
        assert_eq!(read(&d.mac, "a.md"), "a from mac\n");
        assert_eq!(read(&d.mac, "b.md"), "b from phone\n");
        assert_eq!(get_conflicts(path(&d.phone)).unwrap()[0].local_content, "a from phone, more\n");
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
            assert!(!get_repo_status(path(&d.phone)).unwrap().has_conflict);
            assert!(sync_now(path(&d.phone), None).unwrap().success);
            sync_now(path(&d.mac), None).unwrap();
            assert_eq!(read(&d.mac, "a.md"), expected);
        }
    }

    #[test]
    fn closing_the_resolver_loses_nothing() {
        let d = conflicted("cancel");
        assert_eq!(sync_now(path(&d.phone), None).unwrap().conflicts.len(), 1);
        resolve_conflicts(path(&d.phone), vec![]).unwrap();
        assert_eq!(read(&d.phone, "a.md"), "a from phone\n");
        assert!(get_repo_status(path(&d.phone)).unwrap().has_conflict);
    }

    #[test]
    fn a_newer_update_than_the_one_shown_is_not_resolved_unseen() {
        let d = conflicted("newer");
        let shown = get_conflicts(path(&d.phone)).unwrap()[0].remote_id.clone();
        write(&d.mac, "a.md", "a from mac again\n");
        sync_now(path(&d.mac), None).unwrap();
        sync_now(path(&d.phone), None).unwrap();
        let mut res = choose("a.md", "local", None);
        res[0].remote_id = Some(shown);
        assert!(resolve_conflicts(path(&d.phone), res).unwrap_err().contains("changed again"));
        let now = &get_conflicts(path(&d.phone)).unwrap()[0];
        assert_eq!((now.local_content.as_str(), now.remote_content.as_str()), ("a from phone\n", "a from mac again\n"));
    }

    #[test]
    fn a_note_deleted_on_one_device_and_edited_on_the_other_is_kept() {
        let d = devices("delete");
        write(&d.mac, "a.md", "a from mac\n");
        std::fs::remove_file(d.mac.join("b.md")).unwrap();
        sync_now(path(&d.mac), None).unwrap();
        std::fs::remove_file(d.phone.join("a.md")).unwrap();
        write(&d.phone, "b.md", "b from phone\n");
        let result = sync_now(path(&d.phone), None).unwrap();
        assert_eq!(result.notices.len(), 2);
        assert_eq!(read(&d.phone, "a.md"), "a from mac\n");
        sync_now(path(&d.mac), None).unwrap();
        assert_eq!(read(&d.mac, "b.md"), "b from phone\n");
    }

    #[test]
    fn an_edit_follows_a_rename_made_on_the_other_device() {
        let d = devices("rename");
        write(&d.mac, "a.md", "a longer note\nwith a few lines\nso it can be recognised\n");
        sync_now(path(&d.mac), None).unwrap();
        sync_now(path(&d.phone), None).unwrap();
        std::fs::rename(d.mac.join("a.md"), d.mac.join("renamed.md")).unwrap();
        sync_now(path(&d.mac), None).unwrap();
        write(&d.phone, "a.md", "a longer note\nwith a few lines\nso it can be recognised\nand an edit\n");
        sync_now(path(&d.phone), None).unwrap();
        assert!(!d.phone.join("a.md").exists());
        assert!(read(&d.phone, "renamed.md").ends_with("and an edit\n"));
    }

    #[test]
    fn canvas_cards_changed_on_two_devices_are_merged() {
        let d = devices("canvas");
        let board = |a: &str, b: &str| format!("{{\"nodes\":[{{\"id\":\"a\",\"text\":\"{}\"}},{{\"id\":\"b\",\"text\":\"{}\"}}],\"edges\":[]}}", a, b);
        write(&d.mac, "board.canvas", &board("a", "b"));
        sync_now(path(&d.mac), None).unwrap();
        sync_now(path(&d.phone), None).unwrap();
        write(&d.mac, "board.canvas", &board("a mac", "b"));
        sync_now(path(&d.mac), None).unwrap();
        write(&d.phone, "board.canvas", &board("a", "b phone"));
        assert!(sync_now(path(&d.phone), None).unwrap().conflicts.is_empty());
        let merged: serde_json::Value = serde_json::from_str(&read(&d.phone, "board.canvas")).unwrap();
        assert_eq!((merged["nodes"][0]["text"].as_str(), merged["nodes"][1]["text"].as_str()), (Some("a mac"), Some("b phone")));
    }

    #[test]
    fn an_update_to_the_open_note_waits_for_the_banner() {
        let d = devices("banner");
        write(&d.mac, "a.md", "a\nmac\n");
        write(&d.mac, "b.md", "b from mac\n");
        sync_now(path(&d.mac), None).unwrap();
        sync_now(path(&d.phone), Some("a.md")).unwrap();
        assert_eq!(read(&d.phone, "a.md"), "a\n");
        assert_eq!(read(&d.phone, "b.md"), "b from mac\n");
        let waiting = |dir: &Path| get_repo_status(path(dir)).unwrap().files.iter().any(|f| f.path == "a.md" && f.update_waiting);
        assert!(waiting(&d.phone));

        // Typed meanwhile: kept on this device, then merged with the update.
        write(&d.phone, "a.md", "phone\na\n");
        sync_now(path(&d.phone), Some("a.md")).unwrap();
        sync_now(path(&d.mac), None).unwrap();
        assert_eq!(read(&d.mac, "a.md"), "a\nmac\n");
        assert!(apply_update(path(&d.phone), "a.md").unwrap().success);
        assert_eq!(read(&d.phone, "a.md"), "phone\na\nmac\n");
        assert!(!waiting(&d.phone));
        sync_now(path(&d.phone), None).unwrap();
        sync_now(path(&d.mac), None).unwrap();
        assert_eq!(read(&d.mac, "a.md"), "phone\na\nmac\n");
    }

    #[test]
    fn closing_the_note_brings_in_its_update() {
        let d = devices("closed");
        write(&d.mac, "a.md", "a from mac\n");
        sync_now(path(&d.mac), None).unwrap();
        sync_now(path(&d.phone), Some("a.md")).unwrap();
        assert_eq!(read(&d.phone, "a.md"), "a\n");
        sync_now(path(&d.phone), Some("b.md")).unwrap();
        assert_eq!(read(&d.phone, "a.md"), "a from mac\n");
        assert_eq!(get_repo_status(path(&d.phone)).unwrap().state, SyncState::CleanSynced);
    }

    #[test]
    fn held_notes_survive_a_workspace_switch() {
        let d = conflicted("held-switch");
        create_workspace(path(&d.phone), "Work").unwrap();
        assert!(!d.phone.join("a.md").exists());
        switch_workspace(path(&d.phone), "Personal").unwrap();
        assert_eq!(read(&d.phone, "a.md"), "a from phone\n");
        assert!(get_repo_status(path(&d.phone)).unwrap().has_conflict);
    }

    #[test]
    fn images_changed_on_both_devices_are_both_kept() {
        let d = devices("images");
        std::fs::write(d.mac.join("p.png"), [0xff, 1]).unwrap();
        sync_now(path(&d.mac), None).unwrap();
        std::fs::write(d.phone.join("p.png"), [0xff, 2]).unwrap();
        assert!(sync_now(path(&d.phone), None).unwrap().success);
        assert_eq!(std::fs::read(d.phone.join("p.png")).unwrap(), [0xff, 2]);
        assert_eq!(std::fs::read(d.phone.join("p (other device).png")).unwrap(), [0xff, 1]);
    }

    #[test]
    fn an_edit_made_while_syncing_is_not_overwritten() {
        let d = devices("race");
        write(&d.mac, "a.md", "a from mac\n");
        sync_now(path(&d.mac), None).unwrap();
        let phone = Repository::open(&d.phone).unwrap();
        fetch_origin(&phone).unwrap();
        write(&d.phone, "a.md", "typed just now\n");
        assert!(integrate_remote(&phone, "Personal", None).is_err());
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
        assert!(sync_now(path(&d.phone), None).unwrap().success);
        assert_eq!(read(&d.phone, "a.md"), "a from mac\n");
        assert_eq!(read(&d.phone, "b.md"), "b from phone\n");
    }

    #[test]
    fn notes_stay_marked_until_they_are_uploaded() {
        let d = devices("marks");
        let marked = || -> Vec<String> {
            let files = get_repo_status(path(&d.phone)).unwrap().files;
            files.into_iter().filter(|f| f.not_uploaded).map(|f| f.path).collect()
        };
        write(&d.phone, "b.md", "edited\n");
        assert_eq!(marked(), ["b.md"]);
        commit_all(&Repository::open(&d.phone).unwrap(), "offline").unwrap();
        assert_eq!(marked(), ["b.md"]);
        sync_now(path(&d.phone), None).unwrap();
        assert!(marked().is_empty());
    }

    #[test]
    fn syncing_with_nothing_new_makes_no_commits() {
        let d = devices("idle");
        let head = || Repository::open(&d.mac).unwrap().head().unwrap().target();
        let before = head();
        sync_now(path(&d.mac), None).unwrap();
        assert_eq!(head(), before);
    }

    #[test]
    fn offline_edits_are_committed_and_uploaded_later() {
        let d = devices("later");
        let cloud = d.mac.parent().unwrap().join("cloud.git");
        let away = d.mac.parent().unwrap().join("away.git");
        std::fs::rename(&cloud, &away).unwrap();
        write(&d.phone, "b.md", "offline\n");
        assert!(sync_now(path(&d.phone), None).is_err());
        assert_eq!(get_repo_status(path(&d.phone)).unwrap().state, SyncState::AheadOffline);
        std::fs::rename(&away, &cloud).unwrap();
        sync_now(path(&d.phone), None).unwrap();
        sync_now(path(&d.mac), None).unwrap();
        assert_eq!(read(&d.mac, "b.md"), "offline\n");
    }

    #[test]
    fn commits_waiting_in_other_workspaces_are_uploaded_too() {
        let d = devices("others");
        let cloud = d.mac.parent().unwrap().join("cloud.git");
        let away = d.mac.parent().unwrap().join("away.git");
        create_workspace(path(&d.mac), "Work").unwrap();
        std::fs::rename(&cloud, &away).unwrap();
        write(&d.mac, "w.md", "written offline\n");
        switch_workspace(path(&d.mac), "Personal").unwrap();
        assert_eq!(get_repo_status(path(&d.mac)).unwrap().other_workspaces_not_uploaded, ["Work"]);
        std::fs::rename(&away, &cloud).unwrap();
        sync_now(path(&d.mac), None).unwrap();
        assert!(get_repo_status(path(&d.mac)).unwrap().other_workspaces_not_uploaded.is_empty());
        list_workspaces(path(&d.phone), true).unwrap();
        switch_workspace(path(&d.phone), "Work").unwrap();
        assert_eq!(read(&d.phone, "w.md"), "written offline\n");
    }

    #[test]
    fn the_background_job_uploads_only_when_something_is_waiting() {
        let d = devices("background");
        let cloud = d.mac.parent().unwrap().join("cloud.git");
        let away = d.mac.parent().unwrap().join("away.git");
        std::fs::rename(&cloud, &away).unwrap();
        // Nothing waiting: done without trying to reach the (missing) cloud.
        upload_waiting(path(&d.phone), None).unwrap();
        write(&d.phone, "b.md", "offline\n");
        let offline = upload_waiting(path(&d.phone), None).unwrap_err();
        assert!(worth_retrying(&offline));
        std::fs::rename(&away, &cloud).unwrap();
        upload_waiting(path(&d.phone), None).unwrap();
        sync_now(path(&d.mac), None).unwrap();
        assert_eq!(read(&d.mac, "b.md"), "offline\n");
        assert!(!worth_retrying("Your sign-in was not accepted. It may have expired or been revoked: sign in again from Settings."));
    }

    #[test]
    fn notes_from_a_newer_version_are_left_alone() {
        let d = devices("format");
        let mac = Repository::open(&d.mac).unwrap();
        write(&d.mac, ".noetic/format.json", "{\"version\":99}");
        write(&d.mac, "a.md", "from the future\n");
        let mut index = mac.index().unwrap();
        index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree = mac.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = mac.head().unwrap().peel_to_commit().unwrap();
        let sig = signature(&mac);
        mac.commit(Some("HEAD"), &sig, &sig, "newer", &tree, &[&parent]).unwrap();
        push_workspace(&mac, "Personal").unwrap();

        write(&d.phone, "b.md", "b from phone\n");
        assert!(sync_now(path(&d.phone), None).unwrap_err().contains("newer version"));
        assert_eq!(read(&d.phone, "a.md"), "a\n");
        assert_eq!(read(&d.phone, "b.md"), "b from phone\n");
    }

    #[test]
    fn only_old_lock_files_are_removed() {
        let d = devices("locks");
        let (old, fresh) = (d.mac.join(".git/index.lock"), d.mac.join(".git/HEAD.lock"));
        std::fs::write(&old, "").unwrap();
        std::fs::write(&fresh, "").unwrap();
        let hour_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&old).unwrap().set_modified(hour_ago).unwrap();
        remove_stale_locks(&d.mac.join(".git"));
        assert!(!old.exists() && fresh.exists());
    }

    #[test]
    fn syncs_started_together_wait_for_each_other() {
        let d = devices("queue");
        write(&d.phone, "b.md", "once\n");
        let runs: Vec<_> = (0..4)
            .map(|_| {
                let p = d.phone.clone();
                std::thread::spawn(move || sync_now(path(&p), None).map(|r| r.success))
            })
            .collect();
        for run in runs {
            assert!(run.join().unwrap().unwrap());
        }
    }
}
