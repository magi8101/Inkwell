use std::path::Path;

use tauri::ipc::{InvokeBody, Request};
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

/// Starts the app.
///
/// # Panics
/// Panics if the Tauri runtime fails to start.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_export])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
