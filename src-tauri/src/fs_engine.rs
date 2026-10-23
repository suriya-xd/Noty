use std::path::Path;
use walkdir::WalkDir;
use crate::models::{VaultEntry, VaultInfo};

pub fn list_vault_files(vault_path: &str) -> Result<Vec<VaultEntry>, String> {
    let root = Path::new(vault_path);
    if !root.exists() {
        return Err(format!("Vault path does not exist: {}", vault_path));
    }

    let mut entries = Vec::new();

    for entry in WalkDir::new(root).into_iter().filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        // Ignore .git, node_modules, hidden files
        !name.starts_with('.') && name != "node_modules" && name != "dist" && name != "target"
    }) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let path = entry.path();
        if path == root {
            continue;
        }

        let rel_path = match path.strip_prefix(root) {
            Ok(p) => p.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };

        let metadata = entry.metadata().ok();
        let size_bytes = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified_ms = metadata
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        entries.push(VaultEntry {
            path: rel_path,
            name: entry.file_name().to_string_lossy().to_string(),
            is_directory: entry.file_type().is_dir(),
            size_bytes,
            modified_ms,
        });
    }

    entries.sort_by(|a, b| {
        if a.is_directory != b.is_directory {
            b.is_directory.cmp(&a.is_directory) // Folders first
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(entries)
}

pub fn read_file_content(full_path: &str) -> Result<String, String> {
    std::fs::read_to_string(full_path).map_err(|e| format!("Failed to read file: {}", e))
}

pub fn write_file_content(full_path: &str, content: &str) -> Result<(), String> {
    let path = Path::new(full_path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, content).map_err(|e| format!("Failed to write file: {}", e))
}

pub fn create_file(vault_path: &str, rel_path: &str) -> Result<(), String> {
    let full_path = Path::new(vault_path).join(rel_path);
    if full_path.exists() {
        return Err("File already exists".to_string());
    }
    if let Some(parent) = full_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let initial_content = format!("# {}\n\nCreated on {}\n", 
        full_path.file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled"),
        chrono::Local::now().format("%B %d, %Y")
    );
    std::fs::write(&full_path, initial_content).map_err(|e| format!("Failed to create file: {}", e))
}

pub fn delete_file(vault_path: &str, rel_path: &str) -> Result<(), String> {
    let full_path = Path::new(vault_path).join(rel_path);
    if !full_path.exists() {
        return Err("File does not exist".to_string());
    }
    if full_path.is_dir() {
        std::fs::remove_dir_all(full_path).map_err(|e| format!("Failed to delete folder: {}", e))
    } else {
        std::fs::remove_file(full_path).map_err(|e| format!("Failed to delete file: {}", e))
    }
}

pub fn rename_file(vault_path: &str, old_path: &str, new_path: &str) -> Result<(), String> {
    let old_full = Path::new(vault_path).join(old_path);
    let new_full = Path::new(vault_path).join(new_path);
    if !old_full.exists() {
        return Err("Source file does not exist".to_string());
    }
    if let Some(parent) = new_full.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::rename(old_full, new_full).map_err(|e| format!("Failed to rename file: {}", e))
}

pub fn init_or_open_vault(vault_path_opt: Option<String>) -> Result<VaultInfo, String> {
    let path_str = match vault_path_opt {
        Some(p) => p,
        None => {
            // Default to a folder in user home or local app data
            let home = std::env::var("USERPROFILE")
                .or_else(|_| std::env::var("HOME"))
                .unwrap_or_else(|_| ".".to_string());
            let default_dir = Path::new(&home).join("GitVault");
            default_dir.to_string_lossy().to_string()
        }
    };

    let p = Path::new(&path_str);
    if !p.exists() {
        std::fs::create_dir_all(p).map_err(|e| format!("Failed to create vault directory: {}", e))?;
    }

    let git_dir = p.join(".git");
    let is_git = git_dir.exists();
    if !is_git {
        git2::Repository::init(p).map_err(|e| format!("Failed to initialize Git repository: {}", e))?;
        
        // Write initial README.md
        let readme_path = p.join("Welcome.md");
        if !readme_path.exists() {
            let welcome = "# Welcome to GitVault\n\nGitVault is your local-first Markdown note-taking app with native GitHub repository integration.\n\n- **Manual Save & Sync**: Keystrokes are written directly to disk without auto-committing.\n- **Native Git State**: See real-time Git status badges for every file.\n- **Conflict Resolver**: In-memory 3-way merge prevents messy merge conflict markers.\n";
            let _ = std::fs::write(readme_path, welcome);
        }
    }

    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("GitVault").to_string();
    let remote_url = if let Ok(repo) = git2::Repository::open(p) {
        repo.find_remote("origin")
            .ok()
            .and_then(|remote| remote.url().map(|s| s.to_string()))
    } else {
        None
    };

    Ok(VaultInfo {
        path: path_str,
        name,
        is_git_repo: true,
        remote_url,
    })
}
