use crate::audio_toolkit::apply_custom_words;
use crate::managers::model::{EngineType, ModelManager};
use crate::settings::{get_settings, ModelUnloadTimeout};
use anyhow::Result;
use log::{debug, error, info, warn};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter};
use transcribe_rs::{
    engines::{
        parakeet::{
            ParakeetEngine, ParakeetInferenceParams, ParakeetModelParams, TimestampGranularity,
        },
        whisper::{WhisperEngine, WhisperInferenceParams},
    },
    TranscriptionEngine,
};

#[derive(Clone, Debug, Serialize)]
pub struct ModelStateEvent {
    pub event_type: String,
    pub model_id: Option<String>,
    pub model_name: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Segment {
    pub start: f32,
    pub end: f32,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct FileTranscriptionCompleted {
    pub path: String,
    pub segments: Vec<Segment>,
    pub text: String, // Kept for legacy compatibility if needed
}

#[derive(Clone, Debug, Serialize)]
pub struct TranscriptionProgress {
    pub segments: Vec<Segment>,
    pub is_partial: bool,
}

enum LoadedEngine {
    Whisper(WhisperEngine),
    Parakeet(ParakeetEngine),
}

#[derive(Clone)]
pub struct TranscriptionManager {
    engine: Arc<Mutex<Option<LoadedEngine>>>,
    model_manager: Arc<ModelManager>,
    app_handle: AppHandle,
    current_model_id: Arc<Mutex<Option<String>>>,
    last_activity: Arc<AtomicU64>,
    shutdown_signal: Arc<AtomicBool>,
    is_loading: Arc<Mutex<bool>>,
    loading_condvar: Arc<Condvar>,
    current_cancellation_token: Arc<Mutex<Option<Arc<AtomicBool>>>>,
}

impl TranscriptionManager {
    pub fn new(app_handle: &AppHandle, model_manager: Arc<ModelManager>) -> Result<Self> {
        let manager = Self {
            engine: Arc::new(Mutex::new(None)),
            model_manager,
            app_handle: app_handle.clone(),
            current_model_id: Arc::new(Mutex::new(None)),
            last_activity: Arc::new(AtomicU64::new(
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
            )),
            shutdown_signal: Arc::new(AtomicBool::new(false)),
            watcher_handle: Arc::new(Mutex::new(None)),
            is_loading: Arc::new(Mutex::new(false)),
            loading_condvar: Arc::new(Condvar::new()),
            current_cancellation_token: Arc::new(Mutex::new(None)),
        };

        // Start the idle watcher
        {
            let app_handle_cloned = app_handle.clone();
            let manager_cloned = manager.clone();
            let shutdown_signal = manager.shutdown_signal.clone();
            let handle = thread::spawn(move || {
                while !shutdown_signal.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_secs(10)); // Check every 10 seconds

                    // Check shutdown signal again after sleep
                    if shutdown_signal.load(Ordering::Relaxed) {
                        break;
                    }

                    let settings = get_settings(&app_handle_cloned);
                    let timeout_seconds = settings.model_unload_timeout.to_seconds();

                    if let Some(limit_seconds) = timeout_seconds {
                        // Skip polling-based unloading for immediate timeout since it's handled directly in transcribe()
                        if settings.model_unload_timeout == ModelUnloadTimeout::Immediately {
                            continue;
                        }

                        let last = manager_cloned.last_activity.load(Ordering::Relaxed);
                        let now_ms = SystemTime::now()
                            .duration_since(SystemTime::UNIX_EPOCH)
                            .unwrap()
                            .as_millis() as u64;

                        if now_ms.saturating_sub(last) > limit_seconds * 1000 {
                            // idle -> unload
                            if manager_cloned.is_model_loaded() {
                                let unload_start = std::time::Instant::now();
                                debug!("Starting to unload model due to inactivity");

                                if let Ok(()) = manager_cloned.unload_model() {
                                    let _ = app_handle_cloned.emit(
                                        "model-state-changed",
                                        ModelStateEvent {
                                            event_type: "unloaded".to_string(),
                                            model_id: None,
                                            model_name: None,
                                            error: None,
                                        },
                                    );
                                    let unload_duration = unload_start.elapsed();
                                    debug!(
                                        "Model unloaded due to inactivity (took {}ms)",
                                        unload_duration.as_millis()
                                    );
                                }
                            }
                        }
                    }
                }
                debug!("Idle watcher thread shutting down gracefully");
            });
            *manager.watcher_handle.lock().unwrap() = Some(handle);
        }

        Ok(manager)
    }

    pub fn cancel_current_transcription(&self) {
        let guard = self.current_cancellation_token.lock().unwrap();
        if let Some(token) = &*guard {
            info!("Requesting transcription cancellation...");
            token.store(true, Ordering::Relaxed);
        } else {
            warn!("No active transcription to cancel.");
        }
    }

    pub fn ensure_translation_capable_engine(&self) -> Result<()> {
        let needs_switch = {
             let engine = self.engine.lock().unwrap();
             if let Some(LoadedEngine::Parakeet(_)) = *engine {
                 true
             } else {
                 false
             }
        };

        if needs_switch {
             info!("Translation requested but Parakeet is loaded. Switching to a Whisper model...");
             
             // Find a suitable Whisper model
             let available = self.model_manager.get_available_models();
             let best_whisper = available.iter()
                 .filter(|m| m.engine_type == EngineType::Whisper && m.is_downloaded)
                 .max_by(|a, b| {
                     // Prefer 'turbo' > 'medium' > 'small' > 'large' (logic can be simple order)
                     let score_a = if a.id.contains("turbo") { 100 } else { a.accuracy_score as i32 };
                     let score_b = if b.id.contains("turbo") { 100 } else { b.accuracy_score as i32 };
                     score_a.cmp(&score_b)
                 });

             if let Some(model) = best_whisper {
                 info!("Auto-switching to Whisper model: {} for translation.", model.id);
                 self.load_model(&model.id)?;
             } else {
                 warn!("Translation requested but no downloaded Whisper model found. Proceeding with Parakeet (Translation will be ignored).");
             }
        }
        Ok(())
    }

    pub fn is_model_loaded(&self) -> bool {
        let engine = self.engine.lock().unwrap();
        engine.is_some()
    }

    pub fn unload_model(&self) -> Result<()> {
        let unload_start = std::time::Instant::now();
        debug!("Starting to unload model");

        {
            let mut engine = self.engine.lock().unwrap();
            if let Some(ref mut loaded_engine) = *engine {
                match loaded_engine {
                    LoadedEngine::Whisper(ref mut whisper) => whisper.unload_model(),
                    LoadedEngine::Parakeet(ref mut parakeet) => parakeet.unload_model(),
                }
            }
            *engine = None; // Drop the engine to free memory
        }
        {
            let mut current_model = self.current_model_id.lock().unwrap();
            *current_model = None;
        }

        // Emit unloaded event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "unloaded".to_string(),
                model_id: None,
                model_name: None,
                error: None,
            },
        );

        let unload_duration = unload_start.elapsed();
        debug!(
            "Model unloaded manually (took {}ms)",
            unload_duration.as_millis()
        );
        Ok(())
    }

    /// Unloads the model immediately if the setting is enabled and the model is loaded
    pub fn maybe_unload_immediately(&self, context: &str) {
        let settings = get_settings(&self.app_handle);
        if settings.model_unload_timeout == ModelUnloadTimeout::Immediately
            && self.is_model_loaded()
        {
            info!("Immediately unloading model after {}", context);
            if let Err(e) = self.unload_model() {
                warn!("Failed to immediately unload model: {}", e);
            }
        }
    }

    pub fn load_model(&self, model_id: &str) -> Result<()> {
        let load_start = std::time::Instant::now();
        debug!("Starting to load model: {}", model_id);

        // Emit loading started event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_started".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: None,
                error: None,
            },
        );

        let model_info = self
            .model_manager
            .get_model_info(model_id)
            .ok_or_else(|| anyhow::anyhow!("Model not found: {}", model_id))?;

        if !model_info.is_downloaded {
            let error_msg = "Model not downloaded";
            let _ = self.app_handle.emit(
                "model-state-changed",
                ModelStateEvent {
                    event_type: "loading_failed".to_string(),
                    model_id: Some(model_id.to_string()),
                    model_name: Some(model_info.name.clone()),
                    error: Some(error_msg.to_string()),
                },
            );
            return Err(anyhow::anyhow!(error_msg));
        }

        let model_path = self.model_manager.get_model_path(model_id)?;

        // Create appropriate engine based on model type
        let loaded_engine = match model_info.engine_type {
            EngineType::Whisper => {
                let mut engine = WhisperEngine::new();
                engine.load_model(&model_path).map_err(|e| {
                    let error_msg = format!("Failed to load whisper model {}: {}", model_id, e);
                    let _ = self.app_handle.emit(
                        "model-state-changed",
                        ModelStateEvent {
                            event_type: "loading_failed".to_string(),
                            model_id: Some(model_id.to_string()),
                            model_name: Some(model_info.name.clone()),
                            error: Some(error_msg.clone()),
                        },
                    );
                    anyhow::anyhow!(error_msg)
                })?;
                LoadedEngine::Whisper(engine)
            }
            EngineType::Parakeet => {
                let mut engine = ParakeetEngine::new();
                engine
                    .load_model_with_params(&model_path, ParakeetModelParams::int8())
                    .map_err(|e| {
                        let error_msg =
                            format!("Failed to load parakeet model {}: {}", model_id, e);
                        let _ = self.app_handle.emit(
                            "model-state-changed",
                            ModelStateEvent {
                                event_type: "loading_failed".to_string(),
                                model_id: Some(model_id.to_string()),
                                model_name: Some(model_info.name.clone()),
                                error: Some(error_msg.clone()),
                            },
                        );
                        anyhow::anyhow!(error_msg)
                    })?;
                LoadedEngine::Parakeet(engine)
            }
        };

        // Update the current engine and model ID
        {
            let mut engine = self.engine.lock().unwrap();
            *engine = Some(loaded_engine);
        }
        {
            let mut current_model = self.current_model_id.lock().unwrap();
            *current_model = Some(model_id.to_string());
        }

        // Emit loading completed event
        let _ = self.app_handle.emit(
            "model-state-changed",
            ModelStateEvent {
                event_type: "loading_completed".to_string(),
                model_id: Some(model_id.to_string()),
                model_name: Some(model_info.name.clone()),
                error: None,
            },
        );

        let load_duration = load_start.elapsed();
        debug!(
            "Successfully loaded transcription model: {} (took {}ms)",
            model_id,
            load_duration.as_millis()
        );
        Ok(())
    }

    /// Kicks off the model loading in a background thread if it's not already loaded
    pub fn initiate_model_load(&self) {
        let mut is_loading = self.is_loading.lock().unwrap();
        if *is_loading || self.is_model_loaded() {
            return;
        }

        *is_loading = true;
        let self_clone = self.clone();
        thread::spawn(move || {
            let settings = get_settings(&self_clone.app_handle);
            if let Err(e) = self_clone.load_model(&settings.selected_model) {
                error!("Failed to load model: {}", e);
            }
            let mut is_loading = self_clone.is_loading.lock().unwrap();
            *is_loading = false;
            self_clone.loading_condvar.notify_all();
        });
    }

    pub fn get_current_model(&self) -> Option<String> {
        let current_model = self.current_model_id.lock().unwrap();
        current_model.clone()
    }

    pub async fn transcribe_file(
        &self,
        path: std::path::PathBuf,
        options: Option<crate::commands::transcription::FileTranscriptionOptions>,
    ) -> Result<()> {
        info!("Transcribing file: {:?}", path);

        // Update last activity timestamp
        self.last_activity.store(
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            Ordering::Relaxed,
        );

        // Load model if not loaded
        self.initiate_model_load();

        // Wait for it to load
        {
            let mut is_loading = self.is_loading.lock().unwrap();
            while *is_loading {
                is_loading = self.loading_condvar.wait(is_loading).unwrap();
            }

            let engine_guard = self.engine.lock().unwrap();
            if engine_guard.is_none() {
                return Err(anyhow::anyhow!("Model is not loaded for transcription."));
            }
        }

        // Read audio file and convert to samples (f32, 16kHz)
        // We'll use rodio or symphonia for this. Handy already has hound and rubato.
        let samples = crate::audio_toolkit::audio::read_audio_file(&path)?;

        // Update tray icon to transcribing file
        crate::tray::change_tray_icon(
            &self.app_handle,
            crate::tray::TrayIconState::TranscribingFile,
        );

        let (result_text, final_segments) = self.transcribe(samples, options)?;

        // Emit completion event (STRUCTURED)
        let _ = self.app_handle.emit(
            "file-transcription-completed",
            FileTranscriptionCompleted {
                path: path.to_string_lossy().to_string(),
                segments: final_segments,
                text: result_text.clone(),
            },
        );

        // Generate SRT if it was a file transcription (Optional, now we emit event)
        // self.generate_srt(&path, &result)?;

        // Return tray to idle
        crate::tray::change_tray_icon(&self.app_handle, crate::tray::TrayIconState::Idle);

        Ok(())
    }

// ...

    pub fn transcribe(
        &self,
        audio: Vec<f32>,
        options: Option<crate::commands::transcription::FileTranscriptionOptions>,
    ) -> Result<(String, Vec<Segment>)> {
        // Update last activity timestamp
        self.last_activity.store(
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64,
            Ordering::Relaxed,
        );

        let st = std::time::Instant::now();

        debug!("Audio vector length: {}", audio.len());

        if audio.is_empty() {
            debug!("Empty audio vector");
            self.maybe_unload_immediately("empty audio");
            return Ok((String::new(), Vec::new()));
        }

        // Check if model is loaded, if not try to load it
        {
            // If the model is loading, wait for it to complete.
            let mut is_loading = self.is_loading.lock().unwrap();
            while *is_loading {
                is_loading = self.loading_condvar.wait(is_loading).unwrap();
            }

            let engine_guard = self.engine.lock().unwrap();
            if engine_guard.is_none() {
                return Err(anyhow::anyhow!("Model is not loaded for transcription."));
            }
        }

        // Get current settings for configuration
        let settings = get_settings(&self.app_handle);

        // Use options if provided, otherwise fallback to settings
        let (selected_language, translate_to_english) = if let Some(opts) = options {
            (
                opts.language.unwrap_or(settings.selected_language.clone()),
                opts.translate,
            )
        } else {
            (
                settings.selected_language.clone(),
                settings.translate_to_english,
            )
        };

        // Initialize cancellation token
        let cancellation_token = Arc::new(AtomicBool::new(false));
        {
            let mut guard = self.current_cancellation_token.lock().unwrap();
            *guard = Some(cancellation_token.clone());
        }
        
        // CHUNKED PROCESSING LOGIC
        // We split the audio into 5-second chunks (16000 * 5 = 80000 samples)
        // This allows us to emit progress events to simulates streaming.
        
        let chunk_size = 16000 * 5; // 5 seconds
        let mut full_text_accum = String::new();
        let mut full_segments_accum = Vec::new();
        
        let chunks: Vec<&[f32]> = audio.chunks(chunk_size).collect();
        let total_chunks = chunks.len();
        
        info!("Processing audio in {} chunks of size {}", total_chunks, chunk_size);
        
        // Accumulate timing
        let mut previous_end_time = 0.0;
        
        // Keep track if we cancelled
        let mut was_cancelled = false;

        for (i, chunk) in chunks.iter().enumerate() {
            // Check cancellation
            if cancellation_token.load(Ordering::Relaxed) {
                // We should break
                info!("Transcription cancelled by user request.");
                was_cancelled = true;
                break;
            }
            
            debug!("Processing chunk {}/{}", i + 1, total_chunks);
            let chunk_vec = chunk.to_vec(); // Copying is unavoidable if engine takes ownership or needs vec
            
             // Perform transcription with the appropriate engine (RE-USE EXISTING ENGINE LOGIC)
             // We need to capture the engine logic in a helper or closure to avoid code duplication
             // But for now, let's just inline the engine call since it's inside match
             // SMART SWITCHING: "NEVER NOT DELIVER" TRANSLATION
        if translate_to_english {
            if let Err(e) = self.ensure_translation_capable_engine() {
                 // Stick with Parakeet if switch fails (log warning)
                 error!("Smart Switch failed: {}", e);
            }
        }

        // Perform transcription with the appropriate engine
        let result = {
            let mut engine_guard = self.engine.lock().unwrap();
            let engine = engine_guard.as_mut().ok_or_else(|| {
                // If switch happened, it should be loaded. If not, maybe auto-load failed?
                anyhow::anyhow!(
                    "Model failed to load. Please check your model settings."
                )
            })?;
            
            // Re-verify engine type after potential switch
            match engine {
                LoadedEngine::Whisper(whisper_engine) => {
                    // Logic for Whisper (supports translation)
                    let whisper_language = if selected_language == "auto" {
                        None
                    } else {
                         // Normalize
                        let normalized = if selected_language == "zh-Hans" || selected_language == "zh-Hant" {
                            "zh".to_string()
                        } else {
                            selected_language.clone()
                        };
                        Some(normalized)
                    };

                    let params = WhisperInferenceParams {
                        language: whisper_language,
                        translate: translate_to_english,
                        ..Default::default()
                    };

                    whisper_engine
                        .transcribe_samples(chunk_vec, Some(params))
                        .map_err(|e| anyhow::anyhow!("Whisper transcription failed: {}", e))?
                }
                LoadedEngine::Parakeet(parakeet_engine) => {
                    // Parakeet does NOT support translation.
                    // If we are here, Smart Switch failed or no Whisper model was found.
                    if translate_to_english {
                         warn!("Parakeet engine does not support translation. Falling back to transcription only.");
                    }

                    let params = ParakeetInferenceParams {
                        timestamp_granularity: TimestampGranularity::Segment,
                        ..Default::default()
                    };

                    parakeet_engine
                        .transcribe_samples(chunk_vec, Some(params))
                        .map_err(|e| anyhow::anyhow!("Parakeet transcription failed: {}", e))?

            }
            }
        };
             // Process Result for this chunk
             // 1. Shift timestamps
             let mut chunk_segments = result.segments.unwrap_or_default();
             for segment in &mut chunk_segments {
                 segment.start += previous_end_time;
                 segment.end += previous_end_time;
             }
             
             // Update timing offset for next chunk
             // Ideally we use the duration of the chunk, or the end time of the last segment?
             // Using discrete 5s chunks:
             // previous_end_time += 5.0; -> simpler
             // Or precise: previous_end_time += chunk.len() as f32 / 16000.0;
             let duration_sec = chunk.len() as f32 / 16000.0;
             previous_end_time += duration_sec;

             // 2. Format partial text (DEPRECATED for streaming, but kept for logic)
             // We now prioritize emitting segments
             
             let mut chunk_segments_vec = Vec::new();
             if !chunk_segments.is_empty() {
                  for segment in &chunk_segments {
                      // Apply custom words
                      let text = if !settings.custom_words.is_empty() {
                           apply_custom_words(
                             &segment.text,
                              &settings.custom_words,
                              settings.word_correction_threshold
                           )
                      } else {
                          segment.text.clone()
                      };
                      
                      chunk_segments_vec.push(Segment {
                          start: segment.start,
                          end: segment.end,
                          text: text.trim().to_string(), // Trim here
                      });
                  }
             } else {
                 // Fallback if no segments but text exists? 
                 // If engine returns no segments but text, creates pseudo-segment?
                 // Usually unlikely for Whisper/Parakeet.
                 if !result.text.trim().is_empty() {
                     chunk_segments_vec.push(Segment {
                         start: previous_end_time - duration_sec, // Rough estimate
                         end: previous_end_time,
                         text: result.text.trim().to_string(),
                     });
                 }
             }
             
             // Emit Progress
             if !chunk_segments_vec.is_empty() {
                 let _ = self.app_handle.emit("transcription-progress", TranscriptionProgress {
                     segments: chunk_segments_vec.clone(),
                     is_partial: true
                 });
             }

             // Accumulate
             full_segments_accum.extend(chunk_segments); // Internal transcribe-rs/segment struct
             // Also accumulate for final result
        }

        // Final result construction
        // Map full_segments_accum to our Segment struct
        let final_segments: Vec<Segment> = full_segments_accum.iter().map(|s| {
             let text = if !settings.custom_words.is_empty() {
                  apply_custom_words(
                    &s.text,
                     &settings.custom_words,
                     settings.word_correction_threshold
                  )
             } else {
                 s.text.clone()
             };
            Segment {
                start: s.start,
                end: s.end,
                text: text.trim().to_string(),
            }
        }).collect();

        // Construct full text for legacy return? Actually we can just return empty or formatted string.
        let full_text_combined = final_segments.iter().map(|s| s.text.clone()).collect::<Vec<_>>().join(" ");
        let formatted_result = full_text_combined; // Variable expected by following code

        let et = std::time::Instant::now();
        let translation_note = if translate_to_english {
            " (translated)"
        } else {
            ""
        };
        info!(
            "Transcription completed in {}ms{}",
            (et - st).as_millis(),
            translation_note
        );

        let final_result = formatted_result.trim().to_string();

        if final_result.is_empty() {
            info!("Transcription result is empty");
        } else {
            info!("Transcription result: {}", final_result);
        }

        self.maybe_unload_immediately("transcription");

        Ok((formatted_result, final_segments))
    }
}

impl Drop for TranscriptionManager {
    fn drop(&mut self) {
        debug!("Shutting down TranscriptionManager");

        // Signal the watcher thread to shutdown
        self.shutdown_signal.store(true, Ordering::Relaxed);

        // Wait for the thread to finish gracefully
        if let Some(handle) = self.watcher_handle.lock().unwrap().take() {
            if let Err(e) = handle.join() {
                warn!("Failed to join idle watcher thread: {:?}", e);
            } else {
                debug!("Idle watcher thread joined successfully");
            }
        }
    }
}

fn format_timestamp(seconds: f32) -> String {
    let seconds_u64 = seconds as u64;
    let millis = ((seconds - seconds_u64 as f32) * 1000.0) as u64;
    let hours = seconds_u64 / 3600;
    let minutes = (seconds_u64 % 3600) / 60;
    let secs = seconds_u64 % 60;
    format!("{:02}:{:02}:{:02}.{:03}", hours, minutes, secs, millis)
}
