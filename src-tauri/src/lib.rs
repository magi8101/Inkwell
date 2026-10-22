use std::path::{Component, Path, PathBuf};

use tauri::Manager;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri_plugin_dialog::DialogExt;

/// Saves an export (PDF/PNG bytes) where the user chooses with the native "Save as" dialog.
///
/// The bytes arrive as the raw request body and the suggested file name in the
/// percent-encoded `x-file-name` header. Writing happens here rather than through a
/// file-system plugin, so the app can only write the one path the user picked.
/// Returns `false` if the user cancelled.
#[tauri::command]
async fn save_export(app: tauri::AppHandle, request: Request<'_>) -> Result<bool, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes as the request body".into());
    };
    let name = request
        .headers()
        .get("x-file-name")
        .and_then(|v| v.to_str().ok())
        .map_or_else(
            || "Inkwell".into(),
            |v| {
                percent_encoding::percent_decode_str(v)
                    .decode_utf8_lossy()
                    .into_owned()
            },
        );
    let ext = Path::new(&name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("pdf")
        .to_lowercase();

    let Some(path) = app
        .dialog()
        .file()
        .set_file_name(&name)
        .add_filter(ext.to_uppercase(), &[ext.as_str()])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not save {}: {e}", path.display()))?;
    Ok(true)
}

// --- Notebook folder ("vault") ---
//
// A notebook can live in a folder on disk, Obsidian-style: folders are directories, pages are
// `.inkwell` files, pictures sit in `attachments/`. The folder is chosen with the native dialog and
// remembered here (not by the web page), and every path is checked to stay inside it. Only the
// app's own files (`.inkwell`, `attachments/…`) can be written or deleted, so pointing it at a
// folder with other things in it can't damage them.

fn vault_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("vault-folder.txt"))
}

fn vault_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let saved = std::fs::read_to_string(vault_file(app)?)
        .map_err(|_| "no notebook folder chosen".to_string())?;
    let root = PathBuf::from(saved.trim());
    if root.is_dir() {
        Ok(root)
    } else {
        Err(format!("the notebook folder {} is missing", root.display()))
    }
}

/// `rel` (a `/`-separated path from the web side) inside the vault, refusing `..`, absolute paths
/// and drive prefixes.
fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = Path::new(rel);
    if rel.as_os_str().is_empty() || !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("invalid path {}", rel.display()));
    }
    Ok(root.join(rel))
}

fn own_file(rel: &str) -> Result<(), String> {
    if Path::new(rel).extension().is_some_and(|e| e == "inkwell") || rel.starts_with("attachments/")
    {
        Ok(())
    } else {
        Err(format!("{rel} is not an Inkwell file"))
    }
}

fn header_path(request: &Request<'_>) -> Result<String, String> {
    request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            percent_encoding::percent_decode_str(v)
                .decode_utf8_lossy()
                .into_owned()
        })
        .ok_or_else(|| "missing x-path header".to_string())
}

/// Picks the notebook folder with the native dialog. Returns its name, or `None` if cancelled.
#[tauri::command]
async fn vault_pick(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(dir) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let dir = dir.into_path().map_err(|e| e.to_string())?;
    let file = vault_file(&app)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, dir.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
    Ok(Some(dir.file_name().map_or_else(
        || dir.to_string_lossy().into_owned(),
        |n| n.to_string_lossy().into_owned(),
    )))
}

/// Forgets the notebook folder (its files stay where they are).
#[tauri::command]
async fn vault_forget(app: tauri::AppHandle) -> Result<(), String> {
    match std::fs::remove_file(vault_file(&app)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Every file (and, with a trailing `/`, every directory) in the vault, skipping hidden entries.
#[tauri::command]
async fn vault_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) -> std::io::Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || out.len() > 20_000 {
                continue;
            }
            let rel = format!("{prefix}{name}");
            if entry.file_type()?.is_dir() {
                out.push(format!("{rel}/"));
                walk(&entry.path(), &format!("{rel}/"), out)?;
            } else {
                out.push(rel);
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(&vault_root(&app)?, "", &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[tauri::command]
async fn vault_read(app: tauri::AppHandle, path: &str) -> Result<Response, String> {
    let file = inside(&vault_root(&app)?, path)?;
    std::fs::read(&file)
        .map(Response::new)
        .map_err(|e| format!("could not read {path}: {e}"))
}

/// Writes one of the app's files (bytes in the body, path in the `x-path` header).
#[tauri::command]
async fn vault_write(app: tauri::AppHandle, request: Request<'_>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the file's bytes as the request body".into());
    };
    let rel = header_path(&request)?;
    own_file(&rel)?;
    let file = inside(&vault_root(&app)?, &rel)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, bytes).map_err(|e| format!("could not save {rel}: {e}"))
}

#[tauri::command]
async fn vault_mkdir(app: tauri::AppHandle, path: &str) -> Result<(), String> {
    std::fs::create_dir_all(inside(&vault_root(&app)?, path)?).map_err(|e| e.to_string())
}

/// Deletes one of the app's files; an empty directory is removed, a non-empty one is left alone.
#[tauri::command]
async fn vault_remove(app: tauri::AppHandle, path: &str) -> Result<(), String> {
    let root = vault_root(&app)?;
    if let Some(dir) = path.strip_suffix('/') {
        let _ = std::fs::remove_dir(inside(&root, dir)?); // fails (and is fine) when not empty
        return Ok(());
    }
    own_file(path)?;
    match std::fs::remove_file(inside(&root, path)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Starts the app.
///
/// # Panics
/// Panics if the Tauri runtime fails to start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            save_export,
            vault_pick,
            vault_forget,
            vault_list,
            vault_read,
            vault_write,
            vault_mkdir,
            vault_remove
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
