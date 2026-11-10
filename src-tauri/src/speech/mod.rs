//! Dictation without a key (D384): Whisper on this computer. A model is downloaded the first
//! time it's wanted (whisper.cpp's files, MIT, pinned by commit and SHA-256) into the app's data
//! folder, read into candle (pure Rust, MIT/Apache-2.0, no C++ toolchain to build) and run on
//! the CPU. A loaded model stays in memory a few minutes after its last use, then goes.

pub mod decode;
pub mod ggml;
pub mod model;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use candle_core::Device;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

use crate::acp_agents::{self, Progress};
use crate::error::{Error, Result};

/// The Hugging Face repository whisper.cpp publishes its models in, at a fixed commit.
const REPO: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve";
const REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
/// A loaded model is dropped after this long unused.
const KEEP_LOADED: Duration = Duration::from_secs(180);

pub struct Spec {
    pub id: &'static str,
    pub file: &'static str,
    pub sha256: &'static str,
    pub bytes: u64,
}

/// The models offered: multilingual (99 languages), compressed (q5_1).
pub const MODELS: [Spec; 2] = [
    Spec {
        id: "base",
        file: "ggml-base-q5_1.bin",
        sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
        bytes: 59_707_625,
    },
    Spec {
        id: "small",
        file: "ggml-small-q5_1.bin",
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        bytes: 190_085_487,
    },
];

fn spec(id: &str) -> Result<&'static Spec> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| Error::Invalid(format!("There's no speech model called {id}.")))
}

fn folder(data: &Path) -> PathBuf {
    data.join("speech")
}

fn path_of(data: &Path, spec: &Spec) -> PathBuf {
    folder(data).join(spec.file)
}

/// Written beside a model once its download's SHA-256 matched: the file is whole and right.
fn verified_mark(model: &Path) -> PathBuf {
    model.with_extension("sha256")
}

fn installed(data: &Path, spec: &Spec) -> bool {
    let model = path_of(data, spec);
    model.is_file()
        && std::fs::read_to_string(verified_mark(&model)).is_ok_and(|s| s.trim().len() == 64)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: &'static str,
    pub bytes: u64,
    pub installed: bool,
    pub downloading: bool,
}

pub fn status(data: &Path) -> Vec<ModelStatus> {
    MODELS
        .iter()
        .map(|m| ModelStatus {
            id: m.id,
            bytes: m.bytes,
            installed: installed(data, m),
            downloading: downloads()
                .lock()
                .is_ok_and(|d| d.iter().any(|(id, _)| id == m.id)),
        })
        .collect()
}

fn downloads() -> &'static Mutex<Vec<(String, CancellationToken)>> {
    static D: OnceLock<Mutex<Vec<(String, CancellationToken)>>> = OnceLock::new();
    D.get_or_init(Default::default)
}

/// Where a download comes from. Test builds may name a local file to serve instead (`url`, with
/// its SHA-256), as the agent registry's tests do.
pub struct Source {
    pub url: String,
    pub sha256: String,
    pub bytes: Option<u64>,
}

pub fn source(id: &str, test_url: Option<(String, String)>) -> Result<Source> {
    let spec = spec(id)?;
    if let Some((url, sha256)) = test_url {
        if !cfg!(debug_assertions) {
            return Err(Error::Invalid(
                "Only test builds download from elsewhere.".into(),
            ));
        }
        return Ok(Source {
            url,
            sha256,
            bytes: None,
        });
    }
    Ok(Source {
        url: format!("{REPO}/{REVISION}/{}", spec.file),
        sha256: spec.sha256.into(),
        bytes: Some(spec.bytes),
    })
}

/// Downloads a model (checked against its SHA-256) and puts it in place; its path.
pub async fn install(
    data: &Path,
    id: &str,
    from: Source,
    progress: impl Fn(Progress) + Send + Sync + 'static,
) -> Result<String> {
    let spec = spec(id)?;
    let url = acp_agents::parse_url(&from.url)?;
    let token = CancellationToken::new();
    {
        let mut list = downloads()
            .lock()
            .map_err(|_| Error::Invalid("busy".into()))?;
        if list.iter().any(|(i, _)| i == id) {
            return Err(Error::Invalid(
                "That speech model is being downloaded already.".into(),
            ));
        }
        list.push((id.to_string(), token.clone()));
    }
    let target = path_of(data, spec);
    let partial = target.with_extension("partial");
    let result = async {
        std::fs::create_dir_all(folder(data))?;
        let (digest, received) = acp_agents::download(&url, &partial, &token, &progress).await?;
        progress(Progress {
            phase: "verify",
            received,
            total: Some(received),
        });
        if !acp_agents::sha256_matches(&digest, &from.sha256)
            || from.bytes.is_some_and(|b| b != received)
        {
            return Err(Error::Invalid(
                "The downloaded speech model isn't the expected file (its SHA-256 differs), so it wasn't kept.".into(),
            ));
        }
        let _ = std::fs::remove_file(verified_mark(&target));
        std::fs::rename(&partial, &target)?;
        crate::store::atomic_write(&verified_mark(&target), from.sha256.trim().as_bytes())?;
        progress(Progress {
            phase: "done",
            received,
            total: Some(received),
        });
        Ok(target.to_string_lossy().into_owned())
    }
    .await;
    let _ = std::fs::remove_file(&partial);
    if let Ok(mut list) = downloads().lock() {
        list.retain(|(i, _)| i != id);
    }
    result
}

/// Stops a download under way; whether there was one.
pub fn cancel(id: &str) -> bool {
    let token = downloads()
        .lock()
        .ok()
        .and_then(|l| l.iter().find(|(i, _)| i == id).map(|(_, t)| t.clone()));
    token.map(|t| t.cancel()).is_some()
}

/// Deletes a downloaded model (and lets go of it if it's loaded).
pub fn remove(data: &Path, id: &str) -> Result<bool> {
    let spec = spec(id)?;
    let mut slot = engine().lock().unwrap_or_else(|p| p.into_inner());
    if slot.as_ref().is_some_and(|e| e.id == id) {
        *slot = None;
    }
    drop(slot);
    let model = path_of(data, spec);
    let _ = std::fs::remove_file(verified_mark(&model));
    match std::fs::remove_file(model) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.into()),
    }
}

struct Engine {
    id: String,
    model: model::Whisper,
    filters: Vec<f32>,
    n_mels: usize,
    vocab: Vec<Vec<u8>>,
    used: Instant,
}

fn engine() -> &'static Mutex<Option<Engine>> {
    static E: OnceLock<Mutex<Option<Engine>>> = OnceLock::new();
    E.get_or_init(Default::default)
}

fn candle_err(e: candle_core::Error) -> Error {
    Error::Invalid(format!("Speech to text failed: {e}"))
}

/// Reads a model file into a ready network.
fn load(id: &str, file: &Path) -> Result<Engine> {
    let bytes = std::fs::read(file)?;
    let device = Device::Cpu;
    let parsed = ggml::read(&bytes, &device)?;
    drop(bytes);
    // candle's layers take their weights from a GGUF var builder: one is written in memory.
    let mut gguf = std::io::Cursor::new(Vec::new());
    let tensors: Vec<(&str, &candle_core::quantized::QTensor)> = parsed
        .tensors
        .iter()
        .map(|(n, t)| (n.as_str(), t))
        .collect();
    candle_core::quantized::gguf_file::write(&mut gguf, &[], &tensors).map_err(candle_err)?;
    let vb = candle_transformers::quantized_var_builder::VarBuilder::from_gguf_buffer(
        gguf.get_ref(),
        &device,
    )
    .map_err(candle_err)?;
    let model = model::Whisper::load(&vb, &parsed.hparams).map_err(candle_err)?;
    Ok(Engine {
        id: id.to_string(),
        model,
        filters: parsed.filters,
        n_mels: parsed.hparams.n_mels,
        vocab: parsed.vocab,
        used: Instant::now(),
    })
}

/// Turns 16 kHz mono samples into text with a downloaded model (on a worker thread: seconds of
/// CPU). `language`: a code like "en" or "de-AT"; empty, the language it hears.
pub async fn transcribe(
    data: &Path,
    id: &str,
    samples: Vec<f32>,
    language: String,
) -> Result<String> {
    let spec = spec(id)?;
    let file = path_of(data, spec);
    if !installed(data, spec) {
        return Err(Error::Invalid(format!(
            "The {id} speech model isn't downloaded."
        )));
    }
    run_on(id.to_string(), file, samples, language).await
}

/// `transcribe` with any model file (the tests' synthetic one too).
async fn run_on(id: String, file: PathBuf, samples: Vec<f32>, language: String) -> Result<String> {
    let text = tauri::async_runtime::spawn_blocking(move || -> Result<String> {
        // A panic in an earlier run (inside candle) leaves the lock poisoned: start afresh.
        let mut slot = engine().lock().unwrap_or_else(|p| {
            let mut slot = p.into_inner();
            *slot = None;
            slot
        });
        if slot.as_ref().is_none_or(|e| e.id != id) {
            *slot = None;
            *slot = Some(load(&id, &file)?);
        }
        let Some(e) = slot.as_mut() else {
            return Err(Error::Invalid("The speech model didn't load.".into()));
        };
        e.used = Instant::now();
        let text = decode::transcribe(
            &mut e.model,
            &samples,
            &e.filters,
            e.n_mels,
            &e.vocab,
            decode::language_index(&language),
        )
        .map_err(candle_err)?;
        e.used = Instant::now();
        Ok(text)
    })
    .await
    .map_err(|e| Error::Invalid(e.to_string()))??;
    // Let the memory go once it's been unused a while.
    tauri::async_runtime::spawn(async {
        tokio::time::sleep(KEEP_LOADED).await;
        {
            let mut slot = engine().lock().unwrap_or_else(|p| p.into_inner());
            if slot
                .as_ref()
                .is_some_and(|e| e.used.elapsed() >= KEEP_LOADED)
            {
                *slot = None;
            }
        }
    });
    Ok(text.trim().to_string())
}

/// Little-endian f32 samples (the page's raw body) → samples; at most `max_seconds`.
pub fn samples_from(bytes: &[u8], max_seconds: usize) -> Result<Vec<f32>> {
    if !bytes.len().is_multiple_of(4) {
        return Err(Error::Invalid("The audio isn't 32-bit samples.".into()));
    }
    if bytes.len() / 4 > max_seconds * decode::SAMPLE_RATE {
        return Err(Error::Invalid(format!(
            "The recording is longer than {} minutes.",
            max_seconds / 60
        )));
    }
    Ok(bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes(*c))
        .map(|s| {
            if s.is_finite() {
                s.clamp(-1.0, 1.0)
            } else {
                0.0
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ide-speech-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).ok();
        dir
    }

    #[test]
    fn nothing_downloaded_yet() {
        let data = scratch("status");
        let list = status(&data);
        assert_eq!(
            list.iter().map(|m| m.id).collect::<Vec<_>>(),
            ["base", "small"]
        );
        assert!(list.iter().all(|m| !m.installed && !m.downloading));
        // A partial or wrong-sized file isn't a model.
        std::fs::create_dir_all(folder(&data)).ok();
        std::fs::write(folder(&data).join("ggml-base-q5_1.bin"), b"short").ok();
        assert!(!status(&data)[0].installed);
        // Installed once a verified download left its mark; removing takes both.
        let model = folder(&data).join("ggml-base-q5_1.bin");
        std::fs::write(verified_mark(&model), "a".repeat(64)).ok();
        assert!(status(&data)[0].installed);
        assert!(!status(&data)[1].installed);
        assert_eq!(remove(&data, "base").ok(), Some(true));
        assert!(!verified_mark(&model).exists());
        assert_eq!(remove(&data, "base").ok(), Some(false));
        assert!(remove(&data, "huge").is_err());
    }

    #[test]
    fn pinned_sources() {
        let s = source("base", None).unwrap_or_else(|e| panic!("{e}"));
        assert!(s
            .url
            .starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861"));
        assert!(s.url.ends_with("/ggml-base-q5_1.bin"));
        assert_eq!(s.sha256.len(), 64);
        assert!(source("nope", None).is_err());
    }

    #[test]
    fn samples_are_checked() {
        let bytes: Vec<u8> = [0.5f32, -2.0, f32::NAN]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        assert_eq!(samples_from(&bytes, 60).ok(), Some(vec![0.5, -1.0, 0.0]));
        assert!(samples_from(&[0, 0, 0], 60).is_err());
        assert!(samples_from(&vec![0u8; 4 * 16_001], 1).is_err());
    }

    /// The whole pipeline on a synthetic model: reads, loads, encodes and decodes (the text is
    /// noise, from random weights) without an error.
    #[test]
    fn synthetic_model_runs() {
        let data = scratch("run");
        let file = data.join("model.bin");
        std::fs::write(&file, ggml::tests::synthetic(8)).ok();
        let tone: Vec<f32> = (0..decode::SAMPLE_RATE * 2)
            .map(|i| (i as f32 * 0.03).sin() * 0.3)
            .collect();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        let runtime = runtime.unwrap_or_else(|e| panic!("{e}"));
        let text = runtime.block_on(run_on("synthetic".into(), file, tone, "en".into()));
        assert!(text.is_ok(), "{text:?}");
        // Silence gives nothing, whatever the model.
        let silent = runtime.block_on(run_on(
            "synthetic".into(),
            data.join("model.bin"),
            vec![0.0; 16_000],
            String::new(),
        ));
        assert_eq!(silent.ok().as_deref(), Some(""));
    }

    /// The real base model on a spoken sentence: run by hand with
    /// IDE_TEST_WHISPER_MODEL=<ggml-base-q5_1.bin> IDE_TEST_WHISPER_WAV=<16 kHz mono 16-bit wav>
    /// cargo test --lib real_model -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_model() {
        let (Ok(model), Ok(wav)) = (
            std::env::var("IDE_TEST_WHISPER_MODEL"),
            std::env::var("IDE_TEST_WHISPER_WAV"),
        ) else {
            return;
        };
        let bytes = std::fs::read(wav).unwrap_or_default();
        let at = bytes.windows(4).position(|w| w == b"data").unwrap_or(0) + 8;
        let samples: Vec<f32> = bytes[at.min(bytes.len())..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| f32::from(i16::from_le_bytes(*c)) / 32768.0)
            .collect();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        let runtime = runtime.unwrap_or_else(|e| panic!("{e}"));
        let started = Instant::now();
        let text = runtime.block_on(run_on("base".into(), model.into(), samples, String::new()));
        println!("{text:?} in {:?}", started.elapsed());
        assert!(text.is_ok_and(|t| !t.is_empty()));
    }
}
