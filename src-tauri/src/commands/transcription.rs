use crate::managers::transcription::TranscriptionManager;
use crate::settings::{get_settings, write_settings, ModelUnloadTimeout};
use serde::Serialize;
use specta::Type;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[derive(Serialize, Type)]
pub struct ModelLoadStatus {
    is_loaded: bool,
    current_model: Option<String>,
}

#[derive(serde::Deserialize, Type)]
pub struct FileTranscriptionOptions {
    pub language: Option<String>,
    pub translate: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn transcribe_file(
    _app: AppHandle,
    transcription_manager: State<'_, Arc<TranscriptionManager>>,
    path: PathBuf,
    options: Option<FileTranscriptionOptions>,
) -> Result<(), String> {
    // We'll implement the actual logic in TranscriptionManager
    // but for now let's just use the existing samples transcription if we can
    // Or we might need a new method in TranscriptionManager that takes a path.
    transcription_manager
        .transcribe_file(path, options)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn set_model_unload_timeout(app: AppHandle, timeout: ModelUnloadTimeout) {
    let mut settings = get_settings(&app);
    settings.model_unload_timeout = timeout;
    write_settings(&app, settings);
}

#[tauri::command]
#[specta::specta]
pub fn get_model_load_status(
    transcription_manager: State<TranscriptionManager>,
) -> Result<ModelLoadStatus, String> {
    Ok(ModelLoadStatus {
        is_loaded: transcription_manager.is_model_loaded(),
        current_model: transcription_manager.get_current_model(),
    })
}

#[tauri::command]
#[specta::specta]
pub fn unload_model_manually(
    transcription_manager: State<TranscriptionManager>,
) -> Result<(), String> {
    transcription_manager
        .unload_model()
        .map_err(|e| format!("Failed to unload model: {}", e))
}
