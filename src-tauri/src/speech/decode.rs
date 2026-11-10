//! Speech to text with a loaded Whisper (D384): the audio as 30-second log-mel segments, each
//! encoded, then decoded greedily (the most likely token each step) in the language asked for or
//! the one it hears. Whisper's multilingual vocabulary: these ids hold for tiny, base and small.

use candle_core::{Device, IndexOp, Tensor};
use candle_transformers::models::whisper::audio::log_mel_spectrogram_;

use super::model::Whisper;

pub const SAMPLE_RATE: usize = 16_000;
const N_FFT: usize = 400;
const HOP: usize = 160;
/// 30 seconds of mel frames: one segment, what Whisper was trained on.
const SEGMENT_FRAMES: usize = 3000;

const EOT: u32 = 50257;
const SOT: u32 = 50258;
const TRANSCRIBE: u32 = 50359;
const NO_SPEECH: u32 = 50362;
const NO_TIMESTAMPS: u32 = 50363;
/// A space at the start (Whisper's own rule: the text doesn't begin with one or end at once).
const SPACE: u32 = 220;

/// Whisper's languages in token order: `<|en|>` is SOT + 1, `<|zh|>` SOT + 2 …
pub const LANGUAGES: [&str; 99] = [
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it",
    "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur",
    "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
    "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si",
    "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
    "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln",
    "ha", "ba", "jw", "su",
];

/// Symbols and special tokens Whisper never writes in a transcript (its `suppress_tokens`).
const SUPPRESS: [u32; 88] = [
    1, 2, 7, 8, 9, 10, 14, 25, 26, 27, 28, 29, 31, 58, 59, 60, 61, 62, 63, 90, 91, 92, 93, 359,
    503, 522, 542, 873, 893, 902, 918, 922, 931, 1350, 1853, 1982, 2460, 2627, 3246, 3253, 3268,
    3536, 3846, 3961, 4183, 4667, 6585, 6647, 7273, 9061, 9383, 10428, 10929, 11938, 12033, 12331,
    12562, 13793, 14157, 14635, 15265, 15618, 16553, 16604, 18362, 18956, 20075, 21675, 22520,
    26130, 26161, 26435, 28279, 29464, 31650, 32302, 32470, 36865, 42863, 47425, 49870, 50254,
    50258, 50358, 50359, 50360, 50361, 50362,
];

/// Above this, a segment is taken as silence (Whisper's own threshold).
const NO_SPEECH_THRESHOLD: f32 = 0.6;
/// Tokens at most per segment (Whisper's: half the text context).
const MAX_TOKENS: usize = 224;

/// "de", "DE", "de-AT" → Whisper's language index; anything else (auto) → None.
pub fn language_index(code: &str) -> Option<usize> {
    let base = code.trim().split(['-', '_']).next()?.to_ascii_lowercase();
    LANGUAGES.iter().position(|l| *l == base)
}

/// Whether the recording is (nearly) silent: no 25 ms window louder than a whisper. Whisper
/// tends to invent "Thank you." for silence.
pub fn is_silent(samples: &[f32]) -> bool {
    samples.chunks(SAMPLE_RATE / 40).all(|w| {
        let power = w.iter().map(|s| s * s).sum::<f32>() / w.len().max(1) as f32;
        power.sqrt() < 0.004
    })
}

/// The token to write next: the highest score that isn't suppressed (the first step also can't
/// end the text or start with a space). None: the text ends.
pub fn next_token(scores: &[f32], first: bool) -> Option<u32> {
    let mut best: Option<(u32, f32)> = None;
    for (id, score) in scores.iter().enumerate() {
        let id = id as u32;
        let blocked = SUPPRESS.binary_search(&id).is_ok()
            || id >= NO_TIMESTAMPS
            || (first && (id == EOT || id == SPACE));
        if blocked || best.is_some_and(|(_, b)| *score <= b) {
            continue;
        }
        best = Some((id, *score));
    }
    best.map(|(id, _)| id).filter(|id| *id != EOT)
}

/// The same token over and over (a greedy decoder's loop on noise): time to stop.
pub fn looping(tokens: &[u32]) -> bool {
    const RUN: usize = 12;
    tokens.len() >= RUN
        && tokens[tokens.len() - RUN..]
            .iter()
            .all(|t| *t == tokens[tokens.len() - 1])
}

/// The text of these token ids (only text tokens have bytes).
pub fn text_of(tokens: &[u32], vocab: &[Vec<u8>]) -> String {
    let bytes: Vec<u8> = tokens
        .iter()
        .filter_map(|t| vocab.get(*t as usize))
        .flatten()
        .copied()
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn softmax_at(scores: &[f32], id: u32) -> f32 {
    let max = scores.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let sum: f32 = scores.iter().map(|s| (s - max).exp()).sum();
    scores
        .get(id as usize)
        .map_or(0.0, |s| (s - max).exp() / sum)
}

type R<T> = candle_core::Result<T>;

/// One segment's text: language (asked or heard), then greedy decoding. Empty: no speech.
fn segment(
    model: &mut Whisper,
    mel: &Tensor,
    vocab: &[Vec<u8>],
    language: Option<usize>,
) -> R<String> {
    let audio = model.encode(mel)?;
    model.reset();
    // Start of transcript: its scores give the language and how likely there's no speech.
    let start: Vec<f32> = model.decode(&[SOT], &audio)?.i(0)?.to_vec1()?;
    if softmax_at(&start, NO_SPEECH) > NO_SPEECH_THRESHOLD {
        return Ok(String::new());
    }
    let lang = language.unwrap_or_else(|| {
        (0..LANGUAGES.len())
            .max_by(|a, b| {
                let score = |i: usize| start.get(SOT as usize + 1 + i).copied().unwrap_or(f32::MIN);
                score(*a).total_cmp(&score(*b))
            })
            .unwrap_or(0)
    });
    let prompt = [SOT + 1 + lang as u32, TRANSCRIBE, NO_TIMESTAMPS];
    let mut scores = model.decode(&prompt, &audio)?;
    let mut out = Vec::new();
    for step in 0..MAX_TOKENS {
        if model.seen() >= model.text_ctx {
            break;
        }
        let last = scores.dim(0)? - 1;
        let row: Vec<f32> = scores.i(last)?.to_vec1()?;
        let Some(token) = next_token(&row, step == 0) else {
            break;
        };
        out.push(token);
        if looping(&out) {
            break;
        }
        scores = model.decode(&[token], &audio)?;
    }
    Ok(text_of(&out, vocab))
}

/// 16 kHz mono samples → text. `filters`: the model file's mel filters.
pub fn transcribe(
    model: &mut Whisper,
    samples: &[f32],
    filters: &[f32],
    n_mels: usize,
    vocab: &[Vec<u8>],
    language: Option<usize>,
) -> R<String> {
    if samples.is_empty() || is_silent(samples) {
        return Ok(String::new());
    }
    let mel = log_mel_spectrogram_(samples, filters, N_FFT, HOP, n_mels, false);
    let frames = mel.len() / n_mels;
    let mel = Tensor::from_vec(mel, (1, n_mels, frames), &Device::Cpu)?;
    // The spectrogram is padded past the end; only frames with sound are decoded.
    let content = samples.len() / HOP;
    let mut parts: Vec<String> = Vec::new();
    let mut seek = 0;
    while seek < content {
        let size = (frames - seek).min(SEGMENT_FRAMES);
        if size == 0 {
            break;
        }
        let text = segment(model, &mel.narrow(2, seek, size)?, vocab, language)?;
        let text = text.trim();
        if !text.is_empty() {
            parts.push(text.to_string());
        }
        seek += size;
    }
    Ok(parts.join(" "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn languages_by_code() {
        assert_eq!(language_index("en"), Some(0));
        assert_eq!(language_index("DE"), Some(2));
        assert_eq!(language_index("pt-BR"), Some(8));
        assert_eq!(language_index("haw"), Some(93));
        assert_eq!(language_index(""), None);
        assert_eq!(language_index("auto"), None);
        assert_eq!(LANGUAGES.len(), 99);
        // <|su|> is the last language token, just before <|translate|>.
        assert_eq!(SOT + 1 + 98, 50357);
    }

    #[test]
    fn suppressed_and_special_tokens_are_skipped() {
        assert!(
            SUPPRESS.windows(2).all(|w| w[0] < w[1]),
            "sorted for binary_search"
        );
        let mut scores = vec![0.0f32; 51865];
        scores[1] = 9.0; // a suppressed symbol
        scores[50364] = 9.0; // a timestamp
        scores[EOT as usize] = 8.0;
        scores[SPACE as usize] = 7.0;
        scores[400] = 5.0;
        // First step: no end, no leading space.
        assert_eq!(next_token(&scores, true), Some(400));
        // Later: the end of the text wins.
        assert_eq!(next_token(&scores, false), None);
        scores[EOT as usize] = 0.0;
        assert_eq!(next_token(&scores, false), Some(SPACE));
    }

    #[test]
    fn silence_and_loops() {
        assert!(is_silent(&vec![0.0; SAMPLE_RATE]));
        assert!(is_silent(&vec![0.001; SAMPLE_RATE]));
        let tone: Vec<f32> = (0..SAMPLE_RATE)
            .map(|i| (i as f32 * 0.05).sin() * 0.2)
            .collect();
        assert!(!is_silent(&tone));
        assert!(looping(&[5; 12]));
        assert!(!looping(&[5; 11]));
        assert!(!looping(&[1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2]));
    }

    #[test]
    fn text_from_bytes() {
        let vocab = vec![b"Hel".to_vec(), b"lo".to_vec(), vec![0xC3], vec![0xA9]];
        assert_eq!(text_of(&[0, 1], &vocab), "Hello");
        // A character split across tokens comes back whole; special ids have no text.
        assert_eq!(text_of(&[2, 3, EOT], &vocab), "é");
    }
}
