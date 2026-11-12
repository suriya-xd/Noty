// Command arguments: the frontend (src/services/noeticBridge.ts) sends snake_case keys, while
// Tauri 2 expects camelCase by default, so every command pins `rename_all = "snake_case"`.
// Commands marked `async` do network I/O and run off the main thread, so a slow or stuck
// connection can't freeze the UI (on Android that would be an "app not responding" dialog).
pub mod fs_engine;
pub mod git_engine;
pub mod github_auth;
pub mod models;

use github_auth::{DeviceCodeResponse, DeviceTokenResponse};
use models::{
    ConflictResolution, RepoStatusPayload, SyncResult, VaultConfig, VaultConfigInput, VaultEntry, VaultInfo, WorkspaceList,
};

#[tauri::command(rename_all = "snake_case")]
fn get_repo_status(repo_path: String) -> Result<RepoStatusPayload, String> {
    git_engine::get_repo_status(&repo_path)
}

#[tauri::command(async, rename_all = "snake_case")]
fn fetch_remote(repo_path: String) -> Result<RepoStatusPayload, String> {
    git_engine::fetch_remote(&repo_path)
}

#[tauri::command(async, rename_all = "snake_case")]
fn save_and_push(repo_path: String, commit_message: Option<String>) -> Result<RepoStatusPayload, String> {
    git_engine::save_and_push(&repo_path, commit_message)
}

#[tauri::command(async, rename_all = "snake_case")]
fn sync_and_pull(repo_path: String) -> Result<SyncResult, String> {
    git_engine::sync_and_pull(&repo_path)
}

#[tauri::command(rename_all = "snake_case")]
fn resolve_conflicts(
    repo_path: String,
    resolutions: Vec<ConflictResolution>,
) -> Result<RepoStatusPayload, String> {
    git_engine::resolve_conflicts(&repo_path, resolutions)
}

#[tauri::command(rename_all = "snake_case")]
fn get_vault_config(repo_path: String) -> Result<VaultConfig, String> {
    git_engine::get_vault_config(&repo_path)
}

#[tauri::command(rename_all = "snake_case")]
fn set_vault_config(repo_path: String, config: VaultConfigInput) -> Result<VaultConfig, String> {
    git_engine::set_vault_config(&repo_path, config)
}

#[tauri::command(async, rename_all = "snake_case")]
fn connect_vault(
    vault_path: String,
    remote_url: String,
    github_token: Option<String>,
    user_name: Option<String>,
    user_email: Option<String>,
) -> Result<WorkspaceList, String> {
    git_engine::connect_vault(&vault_path, &remote_url, github_token, user_name, user_email)
}

#[tauri::command(async, rename_all = "snake_case")]
fn list_workspaces(repo_path: String, refresh: Option<bool>) -> Result<WorkspaceList, String> {
    git_engine::list_workspaces(&repo_path, refresh.unwrap_or(false))
}

#[tauri::command(async, rename_all = "snake_case")]
fn create_workspace(repo_path: String, name: String) -> Result<RepoStatusPayload, String> {
    git_engine::create_workspace(&repo_path, &name)
}

#[tauri::command(async, rename_all = "snake_case")]
fn switch_workspace(repo_path: String, name: String) -> Result<RepoStatusPayload, String> {
    git_engine::switch_workspace(&repo_path, &name)
}

#[tauri::command(rename_all = "snake_case")]
fn list_vault_files(vault_path: String) -> Result<Vec<VaultEntry>, String> {
    fs_engine::list_vault_files(&vault_path)
}

#[tauri::command(rename_all = "snake_case")]
fn read_file_content(full_path: String) -> Result<String, String> {
    fs_engine::read_file_content(&full_path)
}

#[tauri::command(rename_all = "snake_case")]
fn write_file_content(full_path: String, content: String) -> Result<(), String> {
    fs_engine::write_file_content(&full_path, &content)
}

#[tauri::command(rename_all = "snake_case")]
fn create_file(vault_path: String, rel_path: String) -> Result<(), String> {
    fs_engine::create_file(&vault_path, &rel_path)
}

#[tauri::command(rename_all = "snake_case")]
fn create_folder(vault_path: String, rel_path: String) -> Result<(), String> {
    fs_engine::create_folder(&vault_path, &rel_path)
}

#[tauri::command(rename_all = "snake_case")]
fn delete_file(vault_path: String, rel_path: String) -> Result<(), String> {
    fs_engine::delete_file(&vault_path, &rel_path)
}

#[tauri::command(rename_all = "snake_case")]
fn rename_file(vault_path: String, old_path: String, new_path: String) -> Result<(), String> {
    fs_engine::rename_file(&vault_path, &old_path, &new_path)
}

/// Where the notes folder lives when the user hasn't chosen a place. On phones that is the app's own
/// storage folder: there is no home directory there (HOME is unset), and the fallback of a
/// relative `./Noetic` lands on the read-only filesystem root. `None` means "use the desktop
/// default" (a Noetic folder in the user's home), which fs_engine works out itself.
#[cfg(any(target_os = "android", target_os = "ios"))]
fn default_vault_dir(app: &tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("Noetic").to_string_lossy().to_string())
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn default_vault_dir(_app: &tauri::AppHandle) -> Option<String> {
    None
}

#[tauri::command(rename_all = "snake_case")]
fn init_or_open_vault(app: tauri::AppHandle, vault_path: Option<String>) -> Result<VaultInfo, String> {
    fs_engine::init_or_open_vault(vault_path.or_else(|| default_vault_dir(&app)))
}

#[tauri::command(async, rename_all = "snake_case")]
fn github_start_device_flow(client_id: Option<String>) -> Result<DeviceCodeResponse, String> {
    github_auth::start_device_flow(client_id)
}

#[tauri::command(async, rename_all = "snake_case")]
fn github_poll_device_token(
    client_id: Option<String>,
    device_code: String,
) -> Result<DeviceTokenResponse, String> {
    github_auth::poll_device_token(client_id, device_code)
}

#[tauri::command(rename_all = "snake_case")]
fn save_image_file(vault_path: String, rel_path: String, data: Vec<u8>) -> Result<(), String> {
    fs_engine::save_image_file(&vault_path, &rel_path, data)
}

/// Makes https work for git on Android. The OpenSSL bundled with the app has no certificate store
/// of its own there, so every fetch and push fails with "the SSL certificate is invalid".
///
/// Pointing OpenSSL at Android's certificate folder (SSL_CERT_DIR) does not help: OpenSSL finds a
/// certificate in a folder by a file name derived from a hash, and Android names its files with
/// the older hash that current OpenSSL no longer looks for. So the system certificates are joined
/// into one file, which is read whole and needs no file names, and git is told to use that file.
#[cfg(target_os = "android")]
fn trust_android_system_certificates(app: &tauri::AppHandle) {
    use tauri::Manager;

    // Newer Android versions keep the up-to-date set in the first folder; the second is the
    // older location. One complete set is enough.
    let mut bundle: Vec<u8> = Vec::new();
    for dir in ["/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts"] {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            if let Ok(bytes) = std::fs::read(entry.path()) {
                bundle.extend_from_slice(&bytes);
                bundle.push(b'\n');
            }
        }
        if !bundle.is_empty() {
            break;
        }
    }
    if bundle.is_empty() {
        return;
    }

    let Ok(dir) = app.path().app_cache_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let file = dir.join("system-certificates.pem");
    if std::fs::write(&file, &bundle).is_err() {
        return;
    }

    // The environment variable covers OpenSSL's own start-up; the direct call covers a git
    // library that has already started.
    std::env::set_var("SSL_CERT_FILE", &file);
    // Safety: runs once during start-up, before any command (and so any git work) can run.
    unsafe {
        let _ = git2::opts::set_ssl_cert_file(&file);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(target_os = "android")]
            trust_android_system_certificates(_app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_repo_status,
            fetch_remote,
            save_and_push,
            sync_and_pull,
            resolve_conflicts,
            get_vault_config,
            set_vault_config,
            connect_vault,
            list_workspaces,
            create_workspace,
            switch_workspace,
            list_vault_files,
            read_file_content,
            write_file_content,
            create_file,
            create_folder,
            delete_file,
            rename_file,
            init_or_open_vault,
            github_start_device_flow,
            github_poll_device_token,
            save_image_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Noetic application");
}
