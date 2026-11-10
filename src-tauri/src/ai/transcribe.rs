//! Speech to text for the agent's voice input (D180): OpenAI-compatible `/audio/transcriptions`
//! (OpenAI, Groq, a local Whisper server). The audio comes base64-encoded from the page; the
//! request is a hand-built multipart body (no extra reqwest feature for one form).

use super::{error_body, http_error, openai_api};
use crate::error::{Error, Result};

/// OpenAI's own limit for one file.
pub const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;

/// `base` may or may not end with "/v1" (people paste both), like the chat client.
fn endpoint(base: &str) -> String {
    openai_api(base, "audio/transcriptions")
}

/// Standard base64 (with or without padding) to bytes; anything else is an error.
pub fn decode_base64(text: &str) -> Result<Vec<u8>> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let clean: Vec<u8> = text
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
        .collect();
    let mut out = Vec::with_capacity(clean.len() * 3 / 4);
    for chunk in clean.chunks(4) {
        let mut acc = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            let v = value(*c).ok_or_else(|| Error::Invalid("bad base64 audio".into()))?;
            acc |= v << (18 - 6 * i);
        }
        let bytes = [(acc >> 16) as u8, (acc >> 8) as u8, acc as u8];
        match chunk.len() {
            4 => out.extend_from_slice(&bytes),
            3 => out.extend_from_slice(&bytes[..2]),
            2 => out.push(bytes[0]),
            _ => return Err(Error::Invalid("bad base64 audio".into())),
        }
    }
    Ok(out)
}

/// The multipart form: the audio file, the model, and optionally the language.
pub fn multipart(
    boundary: &str,
    audio: &[u8],
    mime: &str,
    model: &str,
    language: Option<&str>,
) -> Vec<u8> {
    let ext = match mime.split(';').next().unwrap_or("") {
        "audio/webm" => "webm",
        "audio/ogg" => "ogg",
        "audio/mp4" | "audio/m4a" | "audio/x-m4a" => "m4a",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/mpeg" => "mp3",
        _ => "webm",
    };
    let mut body = Vec::with_capacity(audio.len() + 512);
    let field = |body: &mut Vec<u8>, name: &str, value: &str| {
        body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
            )
            .as_bytes(),
        );
    };
    field(&mut body, "model", model);
    field(&mut body, "response_format", "json");
    if let Some(lang) = language.filter(|l| !l.is_empty()) {
        field(&mut body, "language", lang);
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"speech.{ext}\"\r\nContent-Type: {}\r\n\r\n",
            mime.split(';').next().unwrap_or("audio/webm")
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// Sends the audio for transcription; the recognized text.
pub async fn transcribe(
    client: &reqwest::Client,
    base: &str,
    key: Option<String>,
    model: &str,
    audio: &[u8],
    mime: &str,
    language: Option<&str>,
) -> Result<String> {
    if audio.is_empty() {
        return Err(Error::Invalid("no audio was recorded".into()));
    }
    if audio.len() > MAX_AUDIO_BYTES {
        return Err(Error::Invalid(
            "the recording is too long (25 MB at most)".into(),
        ));
    }
    // Unique enough: never appears in Opus/WebM data in practice, and checked below.
    let mut boundary = format!("----ide-voice-{:x}", audio.len() as u64 * 2654435761);
    while audio
        .windows(boundary.len())
        .any(|w| w == boundary.as_bytes())
    {
        boundary.push('x');
    }
    let body = multipart(&boundary, audio, mime, model, language);
    let mut request = client
        .post(endpoint(base))
        .header(
            "Content-Type",
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        // A server that hangs mustn't leave the composer waiting forever.
        .timeout(std::time::Duration::from_secs(120));
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        request = request.bearer_auth(k);
    }
    let response = request.send().await.map_err(http_error)?;
    if !response.status().is_success() {
        return Err(error_body(response).await);
    }
    let value: serde_json::Value = response.json().await.map_err(http_error)?;
    Ok(value
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim()
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_decodes_with_and_without_padding() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("aGVsbG8").unwrap(), b"hello");
        assert_eq!(decode_base64("aGk=").unwrap(), b"hi");
        assert_eq!(decode_base64("").unwrap(), b"");
        assert!(decode_base64("a$b=").is_err());
        assert!(decode_base64("a").is_err());
    }

    #[test]
    fn multipart_has_the_file_and_fields() {
        let body = multipart(
            "B",
            b"AUDIO",
            "audio/webm;codecs=opus",
            "whisper-1",
            Some("en"),
        );
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains("name=\"model\"\r\n\r\nwhisper-1\r\n"));
        assert!(text.contains("name=\"language\"\r\n\r\nen\r\n"));
        assert!(text.contains(
            "filename=\"speech.webm\"\r\nContent-Type: audio/webm\r\n\r\nAUDIO\r\n--B--"
        ));
    }

    #[test]
    fn endpoint_adds_v1_once() {
        assert_eq!(
            endpoint("https://api.groq.com/openai/v1"),
            "https://api.groq.com/openai/v1/audio/transcriptions"
        );
        assert_eq!(
            endpoint("http://127.0.0.1:8000/"),
            "http://127.0.0.1:8000/v1/audio/transcriptions"
        );
    }
}
