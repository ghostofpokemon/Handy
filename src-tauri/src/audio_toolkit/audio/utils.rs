use anyhow::Result;
use hound::{WavSpec, WavWriter};
use log::{debug, error, info};
use std::fs::File;
use std::path::Path;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::ReadOnlySource;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

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

/// Read an audio file and return samples as f32 at 16kHz mono
pub fn read_audio_file<P: AsRef<Path>>(path: P) -> Result<Vec<f32>> {
    let file = File::open(path.as_ref())?;

    // Create a hint to help the probe
    let mut hint = Hint::new();
    if let Some(extension) = path.as_ref().extension().and_then(|s| s.to_str()) {
        hint.with_extension(extension);
    }

    let source = Box::new(ReadOnlySource::new(file));
    let mss = symphonia::core::io::MediaSourceStream::new(source, Default::default());

    let meta_opts: MetadataOptions = Default::default();
    let fmt_opts: FormatOptions = Default::default();

    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &fmt_opts, &meta_opts)
        .expect("Unsupported format");

    let mut format = probed.format;

    // Find the first audio track
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow::anyhow!("No audio track found"))?;

    let dec_opts: DecoderOptions = Default::default();
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &dec_opts)
        .expect("Unsupported codec");

    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(44100);
    let channels = track.codec_params.channels.map(|c| c.count()).unwrap_or(1);

    info!(
        "Decoding file: {:?}, rate: {}, channels: {}",
        path.as_ref(),
        sample_rate,
        channels
    );

    let mut samples: Vec<f32> = Vec::new();

    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(Error::IoError(_)) => break,
            Err(e) => return Err(anyhow::anyhow!(e)),
        };

        if packet.track_id() != track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(decoded) => {
                match decoded {
                    AudioBufferRef::F32(buf) => {
                        // Mix to mono and collect
                        for i in 0..buf.frames() {
                            let mut mixed = 0.0;
                            for channel in 0..channels {
                                mixed += buf.chan(channel)[i];
                            }
                            samples.push(mixed / channels as f32);
                        }
                    }
                    AudioBufferRef::U8(buf) => {
                        for i in 0..buf.frames() {
                            let mut mixed = 0.0;
                            for channel in 0..channels {
                                mixed += (buf.chan(channel)[i] as f32 - 128.0) / 128.0;
                            }
                            samples.push(mixed / channels as f32);
                        }
                    }
                    AudioBufferRef::U16(buf) => {
                        for i in 0..buf.frames() {
                            let mut mixed = 0.0;
                            for channel in 0..channels {
                                mixed += (buf.chan(channel)[i] as f32 - 32768.0) / 32768.0;
                            }
                            samples.push(mixed / channels as f32);
                        }
                    }
                    AudioBufferRef::U32(buf) => {
                        for i in 0..buf.frames() {
                            let mut mixed = 0.0;
                            for channel in 0..channels {
                                mixed += (buf.chan(channel)[i] as f32 - 2147483648.0) / 2147483648.0;
                            }
                            samples.push(mixed / channels as f32);
                        }
                    }
                    AudioBufferRef::S8(buf) => {
                        for i in 0..buf.frames() {
                            let mut mixed = 0.0;
                            for channel in 0..channels {
                                mixed += buf.chan(channel)[i] as f32 / 128.0;
                            }
                            samples.push(mixed / channels as f32);
                        }
                    }
                    AudioBufferRef::S16(buf) => {
                        for i in 0..buf.frames() {
                            let mut mixed = 0.0;
                            for channel in 0..channels {
                                mixed += buf.chan(channel)[i] as f32 / 32768.0;
                            }
                            samples.push(mixed / channels as f32);
                        }
                    }
                    AudioBufferRef::S24(buf) => {
                        for i in 0..buf.frames() {
                            let mut mixed = 0.0;
                            for channel in 0..channels {
                                mixed += buf.chan(channel)[i].0 as f32 / 8388608.0;
                            }
                            samples.push(mixed / channels as f32);
                        }
                    }
                    AudioBufferRef::S32(buf) => {
                        for i in 0..buf.frames() {
                            let mut mixed = 0.0;
                            for channel in 0..channels {
                                mixed += buf.chan(channel)[i] as f32 / 2147483648.0;
                            }
                            samples.push(mixed / channels as f32);
                        }
                    }
                    AudioBufferRef::F64(buf) => {
                        for i in 0..buf.frames() {
                            let mut mixed = 0.0;
                            for channel in 0..channels {
                                mixed += buf.chan(channel)[i] as f32;
                            }
                            samples.push(mixed / channels as f32);
                        }
                    }
                    _ => return Err(anyhow::anyhow!("Unsupported audio buffer format")),
                }
            }
            Err(Error::DecodeError(e)) => {
                error!("Decode error: {}", e);
                continue;
            }
            Err(e) => return Err(anyhow::anyhow!(e)),
        }
    }

    // Resample if needed
    if sample_rate != 16000 {
        info!("Resampling from {}Hz to 16000Hz", sample_rate);
        use rubato::{Resampler, SincFixedIn};
        let params = rubato::SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: rubato::SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: rubato::WindowFunction::BlackmanHarris2,
        };

        let mut resampler = SincFixedIn::<f32>::new(
            16000 as f64 / sample_rate as f64,
            2.0,
            params,
            1024,
            1,
        )?;

        let waves_in = vec![samples];
        let mut waves_out = resampler.process(&waves_in, None)?;
        samples = waves_out.remove(0);
    }

    Ok(samples)
}
