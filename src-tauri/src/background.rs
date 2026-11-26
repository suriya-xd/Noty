//! The Android background job (SPEC 4.1). When the app leaves the screen, it asks Android to run
//! `SyncJobService` (gen/android/app/src/main/java/com/noetic/app/SyncJobService.kt) once the
//! phone is online, even if the app has been closed by then. The job calls in here, and commits
//! and uploads whatever is waiting. It goes through the same queue as the app's own syncs
//! (`git_engine::enter_queue`), so the two never run at once.

use std::path::Path;
use std::sync::Mutex;

use jni::objects::{JObject, JString};
use jni::sys::jint;
use jni::JNIEnv;

/// What the job tells Android: finished, or try again later (with Android's growing delay).
const DONE: jint = 0;
const RETRY: jint = 1;

/// Set while the app runs. A job in a process Android started just for it finds the notes folder
/// where the app keeps it (`default_vault_dir`), and no note is open.
static VAULT: Mutex<Option<String>> = Mutex::new(None);
static OPEN_NOTE: Mutex<Option<String>> = Mutex::new(None);

pub fn remember_vault(path: &str) {
    if let Ok(mut v) = VAULT.lock() {
        *v = Some(path.to_string());
    }
}

/// The note on screen, so the job holds changes to it for the banner like the app does.
pub fn remember_open_note(note: Option<&str>) {
    if let Ok(mut n) = OPEN_NOTE.lock() {
        *n = note.map(str::to_string);
    }
}

fn upload(data_dir: &str) -> jint {
    crate::certificates_ready();
    let vault = VAULT
        .lock()
        .ok()
        .and_then(|v| v.clone())
        .unwrap_or_else(|| Path::new(data_dir).join("Noetic").to_string_lossy().to_string());
    if !Path::new(&vault).join(".git").exists() {
        return DONE;
    }
    let open_note = OPEN_NOTE.lock().ok().and_then(|n| n.clone());
    match crate::git_engine::upload_waiting(&vault, open_note.as_deref()) {
        Ok(()) => DONE,
        Err(e) if crate::git_engine::worth_retrying(&e) => RETRY,
        // A refused sign-in or an app update needs the user; the app says so when it is opened.
        Err(_) => DONE,
    }
}

/// `SyncJobService.uploadWaiting(dataDir)`: `dataDir` is the app's private data folder.
#[no_mangle]
pub extern "system" fn Java_com_noetic_app_SyncJobService_uploadWaiting(
    mut env: JNIEnv,
    _this: JObject,
    data_dir: JString,
) -> jint {
    match env.get_string(&data_dir) {
        Ok(dir) => upload(&String::from(dir)),
        Err(_) => RETRY,
    }
}
