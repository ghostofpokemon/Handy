use anyhow::Result;
use hound::{WavReader, WavSpec, WavWriter};
use log::{debug, info};
use std::path::Path;
use std::process::Command;

/// Save audio samples as a WAV file
pub async fn save_wav_file<P: AsRef<Path>>(file_path: P, samples: &[f32]) -> Result<()> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut writer = WavWriter::create(file_path.as_ref(), spec)?;

    // Convert f32 samples to i16 for WAV
    for sample in samples {
        let sample_i16 = (sample * i16::MAX as f32) as i16;
        writer.write_sample(sample_i16)?;
    }

    writer.finalize()?;
    debug!("Saved WAV file: {:?}", file_path.as_ref());
    Ok(())
}

/// Read an audio file using ffmpeg to convert to 16kHz mono WAV first
pub fn read_audio_file<P: AsRef<Path>>(path: P) -> Result<Vec<f32>> {
    let path_ref = path.as_ref();
    info!("Reading audio file: {:?}", path_ref);

    // Create a temporary file for the converted WAV
    let temp_dir = std::env::temp_dir();
    let temp_wav = temp_dir.join(format!("handy_convert_{}.wav", uuid::Uuid::new_v4()));

    // Run ffmpeg to convert
    // -i input -ar 16000 -ac 1 -c:a pcm_s16le output.wav
    // -y to overwrite
    // -v error to silence output
    let status = Command::new("ffmpeg")
        .arg("-y")
        .arg("-v")
        .arg("error")
        .arg("-i")
        .arg(path_ref)
        .arg("-ar")
        .arg("16000")
        .arg("-ac")
        .arg("1")
        .arg("-c:a")
        .arg("pcm_s16le")
        .arg(&temp_wav)
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to execute ffmpeg: {}", e))?;

    if !status.success() {
        return Err(anyhow::anyhow!("ffmpeg conversion failed"));
    }

    // Read the converted WAV file using hound
    let mut reader = WavReader::open(&temp_wav)?;
    let samples: Vec<f32> = reader
        .samples::<i16>()
        .filter_map(|s| s.ok())
        .map(|s| s as f32 / i16::MAX as f32)
        .collect();

    // Clean up temp file
    let _ = std::fs::remove_file(temp_wav);

    info!("Read {} samples from converted audio", samples.len());
    Ok(samples)
}
