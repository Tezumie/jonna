//! Fetching a web page for the agent's context (`@web`, the `web.fetch` command, D130): one GET,
//! redirects followed, the body capped, text returned as is (the frontend turns HTML into text).

use crate::error::{Error, Result};
use futures_util::StreamExt;
use serde::Serialize;
use std::time::Duration;

/// Most bytes read from a page (pages are trimmed to text afterwards, far below this).
pub const MAX_BYTES: usize = 3 * 1024 * 1024;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WebPage {
    /// Where the redirects ended.
    pub url: String,
    pub status: u16,
    pub content_type: String,
    pub text: String,
    /// The body was longer than the cap.
    pub truncated: bool,
}

/// Only http(s): no file://, data: or other schemes.
pub fn check_url(url: &str) -> Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|e| Error::Invalid(format!("not a URL ({e}): {url}")))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(Error::Invalid(format!(
            "only http and https pages can be fetched, not {other}:"
        ))),
    }
}

pub async fn fetch(client: &reqwest::Client, url: &str, max_bytes: usize) -> Result<WebPage> {
    let url = check_url(url)?;
    let response = client
        .get(url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (compatible; IDE agent fetch)",
        )
        .header(
            reqwest::header::ACCEPT,
            "text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5",
        )
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(super::http_error)?;
    let status = response.status().as_u16();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let cap = max_bytes.min(MAX_BYTES);
    let mut body: Vec<u8> = Vec::new();
    let mut truncated = false;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(super::http_error)?;
        let room = cap - body.len();
        if chunk.len() > room {
            body.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        body.extend_from_slice(&chunk);
    }
    Ok(WebPage {
        url: final_url,
        status,
        content_type,
        text: String::from_utf8_lossy(&body).into_owned(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_urls() {
        assert!(check_url("https://example.com/a").is_ok());
        assert!(check_url(" http://localhost:3000 ").is_ok());
        assert!(check_url("file:///etc/passwd").is_err());
        assert!(check_url("javascript:alert(1)").is_err());
        assert!(check_url("example.com").is_err());
    }
}
