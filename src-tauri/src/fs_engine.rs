use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;
use crate::models::{VaultEntry, VaultInfo};

const OUTSIDE_VAULT: &str = "That path is outside your notes folder.";

/// True for a name git treats as its own folder. The comparison is loose on purpose: Windows and
/// macOS ignore case, and Windows also ignores trailing dots and spaces and knows the folder by
/// its short name.
fn is_git_dir_name(name: &str) -> bool {
    let trimmed = name.trim_end_matches(['.', ' ']);
    trimmed.eq_ignore_ascii_case(".git") || trimmed.eq_ignore_ascii_case("git~1")
}

/// Turns a path the page sent (relative to the notes folder) into a path on disk, refusing
/// anything that would land outside the folder or inside its `.git` folder.
///
/// The page is the only caller of the file commands, and it shows notes that arrive from other
/// devices. If a note ever managed to run script in it, these commands are what that script could
/// reach, so they are limited to the notes themselves: no `..`, no absolute paths, no following a
/// link out of the folder, and no `.git` (which holds the saved sign-in).
pub fn resolve_in_vault(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut clean = PathBuf::new();
    for part in Path::new(rel).components() {
        match part {
            Component::Normal(name) => {
                if is_git_dir_name(&name.to_string_lossy()) {
                    return Err(OUTSIDE_VAULT.to_string());
                }
                clean.push(name);
            }
            Component::CurDir => {}
            _ => return Err(OUTSIDE_VAULT.to_string()),
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(OUTSIDE_VAULT.to_string());
    }
    let full = root.join(&clean);

    // A link inside the folder can point anywhere. Resolve the part of the path that exists
    // already and make sure it is still under the folder.
    let real_root = root.canonicalize().map_err(|e| format!("Failed to open the notes folder: {}", e))?;
    let mut existing = full.as_path();
    while existing.symlink_metadata().is_err() {
        existing = existing.parent().ok_or_else(|| OUTSIDE_VAULT.to_string())?;
    }
    let real = existing.canonicalize().map_err(|_| OUTSIDE_VAULT.to_string())?;
    if !real.starts_with(&real_root) {
        return Err(OUTSIDE_VAULT.to_string());
    }
    Ok(full)
}

/// The same check for a full path (the page builds these as `<notes folder>/<relative path>`).
pub fn resolve_full_in_vault(root: &Path, full_path: &str) -> Result<PathBuf, String> {
    let rel = Path::new(full_path)
        .strip_prefix(root)
        .map_err(|_| OUTSIDE_VAULT.to_string())?;
    resolve_in_vault(root, &rel.to_string_lossy())
}

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

pub fn read_file_content(vault_path: &str, full_path: &str) -> Result<String, String> {
    let path = resolve_full_in_vault(Path::new(vault_path), full_path)?;
    std::fs::read_to_string(path).map_err(|e| format!("Failed to read file: {}", e))
}

pub fn write_file_content(vault_path: &str, full_path: &str, content: &str) -> Result<(), String> {
    let path = resolve_full_in_vault(Path::new(vault_path), full_path)?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, content).map_err(|e| format!("Failed to write file: {}", e))
}

pub fn create_file(vault_path: &str, rel_path: &str) -> Result<(), String> {
    let full_path = resolve_in_vault(Path::new(vault_path), rel_path)?;
    if full_path.exists() {
        return Err("File already exists".to_string());
    }
    if let Some(parent) = full_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let initial_content = if rel_path.ends_with(".canvas") {
        "{\n  \"nodes\": [],\n  \"edges\": []\n}\n".to_string()
    } else {
        // The title is the file name, shown as an inline title; the note starts empty.
        String::new()
    };
    std::fs::write(&full_path, initial_content).map_err(|e| format!("Failed to create file: {}", e))
}

pub fn create_folder(vault_path: &str, rel_path: &str) -> Result<(), String> {
    let full_path = resolve_in_vault(Path::new(vault_path), rel_path)?;
    if full_path.exists() {
        return Err("Folder already exists".to_string());
    }
    std::fs::create_dir_all(&full_path).map_err(|e| format!("Failed to create folder: {}", e))
}

pub fn delete_file(vault_path: &str, rel_path: &str) -> Result<(), String> {
    let full_path = resolve_in_vault(Path::new(vault_path), rel_path)?;
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
    let old_full = resolve_in_vault(Path::new(vault_path), old_path)?;
    let new_full = resolve_in_vault(Path::new(vault_path), new_path)?;
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
            let default_dir = Path::new(&home).join("Noetic");
            default_dir.to_string_lossy().to_string()
        }
    };

    let p = Path::new(&path_str);
    if !p.exists() {
        std::fs::create_dir_all(p).map_err(|e| format!("Failed to create vault directory: {}", e))?;
    }

    let git_dir = p.join(".git");
    if !git_dir.exists() {
        // The folder starts empty: the welcome note is written when the first workspace is made.
        git2::Repository::init(p).map_err(|e| format!("Failed to set up the notes folder: {}", e))?;
    }

    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("Noetic").to_string();
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

/// Saves an image sent as base64, with or without a `data:<type>;base64,` prefix.
pub fn save_image_file(vault_path: &str, rel_path: &str, data_base64: &str) -> Result<(), String> {
    use base64::Engine;
    let encoded = data_base64.rsplit_once(',').map_or(data_base64, |(_, body)| body);
    let data = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("Failed to read the image: {}", e))?;
    let full_path = resolve_in_vault(Path::new(vault_path), rel_path)?;
    if let Some(parent) = full_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&full_path, data).map_err(|e| format!("Failed to save image file: {}", e))
}


#[cfg(test)]
mod tests {
    use super::*;

    fn temp_vault(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("noetic-test-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        dir
    }

    #[test]
    fn paths_inside_the_folder_are_allowed() {
        let root = temp_vault("inside");
        assert_eq!(resolve_in_vault(&root, "notes/a.md").unwrap(), root.join("notes/a.md"));
        assert_eq!(resolve_in_vault(&root, "./new folder/deep/b.md").unwrap(), root.join("new folder/deep/b.md"));
        let full = format!("{}/notes/a.md", root.display());
        assert_eq!(resolve_full_in_vault(&root, &full).unwrap(), root.join("notes/a.md"));
    }

    #[test]
    fn paths_outside_the_folder_are_refused() {
        let root = temp_vault("outside");
        for bad in ["", ".", "../x.md", "notes/../../x.md", "/etc/passwd", ".git/config", "notes/.GIT/x", ".git./config"] {
            assert!(resolve_in_vault(&root, bad).is_err(), "{:?} should be refused", bad);
        }
        assert!(resolve_full_in_vault(&root, "/etc/passwd").is_err());
        assert!(resolve_full_in_vault(&root, &format!("{}/../x", root.display())).is_err());
        assert!(resolve_full_in_vault(&root, &root.to_string_lossy()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn links_out_of_the_folder_are_refused() {
        let root = temp_vault("links");
        let elsewhere = temp_vault("links-target");
        std::os::unix::fs::symlink(&elsewhere, root.join("out")).unwrap();
        assert!(resolve_in_vault(&root, "out/secret.md").is_err());
        assert!(resolve_in_vault(&root, "out").is_err());
    }

    #[test]
    fn images_are_decoded_from_data_urls() {
        let root = temp_vault("images");
        let vault = root.to_string_lossy().to_string();
        save_image_file(&vault, "assets/a.bin", "data:image/png;base64,aGVsbG8=").unwrap();
        assert_eq!(std::fs::read(root.join("assets/a.bin")).unwrap(), b"hello");
        save_image_file(&vault, "assets/b.bin", "aGVsbG8=").unwrap();
        assert_eq!(std::fs::read(root.join("assets/b.bin")).unwrap(), b"hello");
        assert!(save_image_file(&vault, "../escape.bin", "aGVsbG8=").is_err());
    }
}
