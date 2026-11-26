# Noetic — Technical Specification & MVP Architecture

## 1. System Overview
Noetic is a cross-platform Markdown note-taking application (Windows, macOS, Android) built on **Tauri v2**, **React (Vite + Tailwind CSS)**, **CodeMirror 6**, and a **Rust (`git2`)** backend. One private GitHub repository per account (`noetic-notes`) is the single source of truth; see section 1.1.

### 1.1 Storage and Workspaces
- After sign-in the app finds or creates a private repository named `noetic-notes` in the user's account. The repository is fixed: the UI offers no way to pick or switch it.
- `main` holds a single empty commit and is never written to again.
- A **workspace** is a branch created from that empty commit and named by the user (spaces become dashes; `main` is reserved). The UI only ever says "workspace".
- The local notes folder is one clone. Switching workspace commits (and, when online, uploads) the open one, then checks out the other. Incoming updates don't block a switch; they are combined the next time that workspace is saved or synced.
- The first workspace created on a device adopts notes already in the folder; later workspaces start blank.
- In the state definitions below, `origin/main` means the open workspace's branch on origin (`origin/<workspace>`).
- Commands: `connect_vault` (link the folder, ensure `main`), `list_workspaces`, `create_workspace`, `switch_workspace`.

## 2. Git Worktree State Machine
> Section 4 is replacing this section. Save and Sync are already one **Sync now**, and the status shown is the one in 4.8.

Local edits are written directly to disk (debounced 500ms) without committing. Git's native working tree and commit pointers drive the UI state.

### 2.1 State Definitions
The Rust backend computes the repository state from the working tree and the last fetched `origin`; the UI refreshes it every 12 seconds without using the network:

1. **`CLEAN_SYNCED`**: Worktree clean, `HEAD == origin/main`
   - UI: 🟢 "Up to date" | Save: Disabled | Sync: Disabled
2. **`DIRTY_SYNCED`**: Worktree has modified/untracked files, `HEAD == origin/main`
   - UI: 🟡 "Unsaved changes (N)" | Save: Active | Sync: Disabled
3. **`CLEAN_BEHIND`**: Worktree clean, `HEAD < origin/main`
   - UI: 🔵 "Out of sync (N incoming)" | Save: Disabled | Sync: Active
4. **`DIRTY_BEHIND`**: Worktree dirty, `HEAD < origin/main`
   - UI: 🟠 "Out of sync + Unsaved edits" | Save: Active (combines first; asks if the same note changed in both places) | Sync: Active
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
    pub base_content: String,   // Content before either change
    pub local_content: String,  // Content on this device
    pub remote_content: String, // Content in the cloud copy
    pub local_deleted: bool,
    pub remote_deleted: bool,
    pub hunks: Vec<ConflictHunk>,
}
```

### 3.2 Core Commands
- `get_repo_status(repo_path: String) -> Result<RepoStatusPayload, String>`
- `fetch_remote(repo_path: String) -> Result<RepoStatusPayload, String>`
- `sync_now(repo_path: String) -> Result<SyncResult, String>`
- `resolve_conflicts(repo_path: String, resolutions: Vec<ConflictResolution>) -> Result<RepoStatusPayload, String>`
- `read_file_content(file_path: String) -> Result<String, String>`
- `write_file_content(file_path: String, content: String) -> Result<(), String>`
- `list_vault_files(repo_path: String) -> Result<Vec<VaultEntry>, String>`

---

## 4. Autosave and Autosync (steps 1 to 4 of 4.11 are built)
Replaces manual Save and Sync. Decided 2026-11-25. Where this differs from section 2, this section is the target.

### 4.1 Saving and uploading
- Typing is still written to disk after 500ms. A commit, then an upload, happens **on leave**: closing a note, backgrounding or leaving the app, or switching workspace.
- A note left open is also committed and uploaded after **5 minutes without typing**. Switching to another app window counts as leaving.
- The commit comes first and works offline. Nothing is committed when nothing changed.
- A failed upload is retried on launch, on return and on reconnect. On Android a native **background job** also retries it when internet returns, even if the app is closed.
- Retries use increasing random delays and must be safe to repeat (a push may have succeeded without its reply arriving).
- The Android job (`SyncJobService.kt`, calling `src-tauri/src/background.rs`) is scheduled whenever the app leaves the screen and runs once the phone is online. It checks locally first and only syncs when something is waiting; Android retries it with growing delays after a connection failure. A refused sign-in or a newer notes format stops it until the app is opened. It does not survive a restart of the phone; the next launch uploads instead.
- `tauri android init` doesn't register services, so `scripts/patch-android-manifest.mjs` adds the job to the generated manifest (CI and `npm run android:init`).

### 4.2 Receiving
- The app fetches and combines on launch, on return (including returning to the app's window) and on reconnect. There is no interval polling.
- Commits waiting in **every** workspace are uploaded; updates are brought in only for the **open** one. A closed workspace that has diverged waits until it is opened.
- Opening another workspace counts as a launch: it is brought up to date.
- Returning within 15 seconds of the last sync doesn't check again, so quick window switches don't sync twice. Leaving syncs only when something is waiting to upload.
- Automatic syncs are quiet: they report new conflicts, notes that came back, a refused sign-in or an unexpected error once, and being offline only after a day. The pill always shows the state.
- Quitting the desktop app doesn't wait for an upload. Nothing is lost (typing is on disk within 500ms); it is committed and uploaded at the next launch.
- **Sync now** replaces the Save and Sync buttons: commit, fetch, combine, upload.

### 4.3 Combining
| Case | Result |
|---|---|
| Different files changed | Both kept |
| Markdown, different lines changed | Merged |
| Markdown, same lines changed | Conflict |
| Renamed on one device, edited on another | The edit follows the rename (by similarity; a heavy rewrite may leave two notes) |
| Deleted on one device, edited on another | The edited note is kept, with a short notice that it came back |
| Canvas | Merged by card and connection ID; conflict only if the same one changed on both |
| Image or other binary changed on both | Both kept, one named `(other device)` |

- Before an automatic merge rewrites a note, this device's version is kept locally so the merge can be undone from the app. The open note shows "Combined with changes from another device" with Undo and Keep; undo is offered only while the note is still as the merge left it.
- Neighbouring lines changed on both sides, with no unchanged line between them, count as the same lines (a conflict).
- Held notes and pre-merge versions are kept per workspace in `.git/noetic/held-<workspace>.json` and `merged-<workspace>.json`, so they never sync.
- Checkout is never forced, and commits made on a device are never dropped.

### 4.4 Conflicts
- This device's version stays on disk, the note gets a badge, and everything else keeps syncing. Tapping the badge opens the resolver; it never opens by itself.
- A conflicted note is **held**: the merge commit takes the cloud version of that path, and this device's version is stored in a local ref and left out of later commits until resolved. Uploading it would replace the other device's version unseen.
- Held versions are per workspace and survive a restart and a workspace switch.

### 4.5 The open note
- An incoming change to the open note shows an **"Updated on another device"** banner and is applied when tapped. Typing is not paused. A sync never rewrites the open note; one deleted on another device is still removed.
- Until then the note is held as in 4.4. Text typed meanwhile is merged with the update by the rules in 4.3, when the banner is tapped or the note is closed.

### 4.6 Recovery
- A list of deleted notes, read from the Git history on the device, can be restored offline.
- There is no per-note version history. The pre-merge version (4.3) is the only exception.

### 4.7 Large files and network use
- Large photos are compressed when added.
- Files over **25 MB** are left out of commits and marked "not synced". They are not tracked, so a workspace switch must put them aside and restore them, or they would appear in the next workspace.
- On Android, syncing uses any connection, but an upload with more than about **5 MB** of images waits for Wi-Fi. Notes in the same commits wait with it.

### 4.8 Status
- A pill shows Synced, Not uploaded (N), Updates (N), Offline, Conflict or Sign in needed. Sign-in and network problems are never shown as conflicts.
- Notes not yet uploaded, held notes and unsynced files are each marked in the list.
- A warning appears only after uploads have failed for a day.

### 4.9 Safety
- One queue runs every commit, fetch, merge, upload and workspace switch, one at a time. The Android job uses the same lock.
- A Git lock file left by a crash is removed on start, only when no sync is running.
- Names differing only by capital letters trigger a warning, since macOS usually treats them as one file.

### 4.10 Rollout
- Every device is updated before autosync is turned on; builds from before commit `0435f5b` can drop local commits and can't be changed remotely.
- A format version is kept in `.noetic/format.json` in each workspace (`main` stays empty) and hidden from the notes list. A build that finds a newer version stops syncing and asks to be updated.

### 4.11 Build order
1. Sync queue, Sync now and status
2. Merging, held notes, conflict badges and the banner
3. Autosave and the launch/return/reconnect checks
4. Android background job
5. Deleted notes and large files

The version check (4.10) ships with step 1. Autosave is not turned on before step 2 is done.

The dev-server backend (`vite-noetic-plugin.ts`) follows step 2 with git's own merge: it holds conflicts the same way, but merges a canvas by line, doesn't hold updates to the open note and can't undo merges.
