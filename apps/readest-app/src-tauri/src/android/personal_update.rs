use tauri::{ipc::Channel, AppHandle};
use tauri_plugin_native_bridge::NativeBridgeExt;

#[tauri::command]
pub async fn check_personal_update(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.native_bridge()
            .check_personal_update()
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn install_personal_update(
    app: AppHandle,
    version_code: u32,
    on_progress: Channel<u8>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.native_bridge()
            .install_personal_update(version_code, on_progress)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
