# Handoff: Transcribe File Feature (Handy)

**Target Branch:** `feature/transcribe-file`
**Current Status:** Feature partially implemented, build currently failing.

## 🚀 Objective
Add a "Transcribe File" feature to Handy that:
1.  Is accessible via the system tray.
2.  Opens a **beautiful, aesthetic** dedicated window (`src/components/TranscribeFile.tsx`).
3.  Supports drag-and-drop for audio files (robust implementation via `tauri://file-drop`).
4.  Transcribes audio using the existing `Parakeet` or `Whisper` models.
5.  Displays the result in real-time.
6.  **Does NOT** force translation to English (user option).
7.  **Does NOT** force SRT output (raw text by default, user option for SRT in future).

## 🛠️ What's Done
- **UI:** Created `src/components/TranscribeFile.tsx` with Tailwind + Lucide icons.
- **Routing:** Updated `src/main.tsx` to route `?window=transcribe` to the new component.
- **Backend (Audio):** Implemented `read_audio_file` in `src-tauri/src/audio_toolkit/audio/utils.rs` using `ffmpeg` (runtime dep) and `hound` to support all formats (Opus, MP3, etc.).
- **Backend (Logic):** Updated `TranscriptionManager` (`src-tauri/src/managers/transcription.rs`) to support file transcription and event emission (`file-transcription-completed`).
- **Permissions:** Updated `capabilities` and `Info.plist`/`Entitlements.plist` to fix accessibility crashes and enable file dialogs.

## 🛑 Current Build Errors (Fix These First)

### 1. `src-tauri/src/actions.rs`
**Error:** `cannot find value 'text' in this scope`
**Fix:** The variable in the match arm was renamed to `transcription`, but the logging statement still uses `text`.
```rust
// Current (Broken):
Ok(transcription) => {
    info!("Transcription result: {}", text); // Error
}

// Fix:
Ok(transcription) => {
    info!("Transcription result: {}", transcription);
}
```

### 2. `src-tauri/src/managers/transcription.rs`
**Error:** `cannot find struct 'FileTranscriptionCompleted' in this scope`
**Context:** The struct definition seems to be missing or shadowed, even though it appears in some file reads.
**Fix:** Ensure this struct is explicitly defined `pub` at the top of the file (outside any `impl` blocks) and clearly visible.

```rust
#[derive(Clone, Debug, Serialize)]
pub struct FileTranscriptionCompleted {
    pub path: String,
    pub text: String,
}
```

## 📝 Next Steps for Antigravity
1.  **Fix the Rust compilation errors** above.
2.  **Run Build:** `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo build` (or `bun run tauri build` from root).
3.  **Test:**
    - Launch app.
    - Tray -> Transcribe File...
    - Drop `39C3.opus`.
    - Check if text appears in the window.
4.  **Refine:** Ensure `ffmpeg` is available in the user's path (maybe bundle it if needed, currently assumes `brew install ffmpeg` style availability).

## 📚 Context & Resources
- **Context7:** Used `tauri-plugin-dialog` v2 best practices.
- **Dependencies:** Added `symphonia` (audio reading), `uuid`, `tauri-plugin-dialog`.
- **Aesthetics:** UI matches the existing dark/modern theme of Handy.
