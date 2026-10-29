pub mod fs_engine;
pub mod git_engine;
pub mod github_auth;
pub mod models;

use github_auth::{DeviceCodeResponse, DeviceTokenResponse};
use models::{
    ConflictResolution, RepoStatusPayload, SyncResult, VaultConfig, VaultConfigInput, VaultEntry, VaultInfo,
};

#[tauri::command]
fn get_repo_status(repo_path: String) -> Result<RepoStatusPayload, String> {
    git_engine::get_repo_status(&repo_path)
}

#[tauri::command]
fn fetch_remote(repo_path: String) -> Result<RepoStatusPayload, String> {
    git_engine::fetch_remote(&repo_path)
}

#[tauri::command]
fn save_and_push(repo_path: String, commit_message: Option<String>) -> Result<RepoStatusPayload, String> {
    git_engine::save_and_push(&repo_path, commit_message)
}

#[tauri::command]
fn sync_and_pull(repo_path: String) -> Result<SyncResult, String> {
    git_engine::sync_and_pull(&repo_path)
}

#[tauri::command]
fn resolve_conflicts(
    repo_path: String,
    resolutions: Vec<ConflictResolution>,
) -> Result<RepoStatusPayload, String> {
    git_engine::resolve_conflicts(&repo_path, resolutions)
}

#[tauri::command]
fn get_vault_config(repo_path: String) -> Result<VaultConfig, String> {
    git_engine::get_vault_config(&repo_path)
}

#[tauri::command]
fn set_vault_config(repo_path: String, config: VaultConfigInput) -> Result<VaultConfig, String> {
    git_engine::set_vault_config(&repo_path, config)
}

#[tauri::command]
fn test_remote_connection(
    repo_path: String,
    remote_url: String,
    github_token: Option<String>,
) -> Result<String, String> {
    git_engine::test_remote_connection(&repo_path, &remote_url, github_token)
}

#[tauri::command]
fn connect_vault(
    vault_path: String,
    remote_url: String,
    branch: Option<String>,
    github_token: Option<String>,
    user_name: Option<String>,
    user_email: Option<String>,
) -> Result<RepoStatusPayload, String> {
    git_engine::connect_vault(
        &vault_path,
        &remote_url,
        branch,
        github_token,
        user_name,
        user_email,
    )
}

#[tauri::command]
fn list_vault_files(vault_path: String) -> Result<Vec<VaultEntry>, String> {
    fs_engine::list_vault_files(&vault_path)
}

#[tauri::command]
fn read_file_content(full_path: String) -> Result<String, String> {
    fs_engine::read_file_content(&full_path)
}

#[tauri::command]
fn write_file_content(full_path: String, content: String) -> Result<(), String> {
    fs_engine::write_file_content(&full_path, &content)
}

#[tauri::command]
fn create_file(vault_path: String, rel_path: String) -> Result<(), String> {
    fs_engine::create_file(&vault_path, &rel_path)
}

#[tauri::command]
fn create_folder(vault_path: String, rel_path: String) -> Result<(), String> {
    fs_engine::create_folder(&vault_path, &rel_path)
}

#[tauri::command]
fn delete_file(vault_path: String, rel_path: String) -> Result<(), String> {
    fs_engine::delete_file(&vault_path, &rel_path)
}

#[tauri::command]
fn rename_file(vault_path: String, old_path: String, new_path: String) -> Result<(), String> {
    fs_engine::rename_file(&vault_path, &old_path, &new_path)
}

#[tauri::command]
fn init_or_open_vault(vault_path: Option<String>) -> Result<VaultInfo, String> {
    fs_engine::init_or_open_vault(vault_path)
}

#[tauri::command]
fn github_start_device_flow(client_id: Option<String>) -> Result<DeviceCodeResponse, String> {
    github_auth::start_device_flow(client_id)
}

#[tauri::command]
fn github_poll_device_token(
    client_id: Option<String>,
    device_code: String,
) -> Result<DeviceTokenResponse, String> {
    github_auth::poll_device_token(client_id, device_code)
}

#[tauri::command]
fn save_image_file(vault_path: String, rel_path: String, data: Vec<u8>) -> Result<(), String> {
    fs_engine::save_image_file(&vault_path, &rel_path, data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_repo_status,
            fetch_remote,
            save_and_push,
            sync_and_pull,
            resolve_conflicts,
            get_vault_config,
            set_vault_config,
            test_remote_connection,
            connect_vault,
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
        .expect("error while running GitVault application");
}
