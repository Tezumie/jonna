//! Notifications to the user's phone (D360): the agent's notify message posted to the webhook the
//! user set (ntfy, Discord, Slack or any JSON endpoint). The frontend builds the request body (one
//! short line, checked there); the URL comes with the call, or, when it's a secret (a topic or a
//! webhook URL anyone could post to), from the secrets file, so it never sits in settings. https
//! only (http to this machine), a few headers, a small body and a timeout.

use std::time::Duration;

use tauri::State;

use crate::ai::secrets;
use crate::error::{Error, Result};
use crate::AppState;

/// The secrets file's id for the webhook URL.
pub const SECRET_ID: &str = "notify.webhook";
const MAX_BODY: usize = 8 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);
/// The only extra headers sent (ntfy's).
const HEADERS: [&str; 3] = ["Title", "Tags", "Priority"];

/// The URL, when it's one a notification may go to: https, or http to this machine.
pub fn allowed(url: &str) -> Result<reqwest::Url> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| Error::Invalid("The webhook isn't a URL.".into()))?;
    let local = matches!(
        parsed.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    match parsed.scheme() {
        "https" => Ok(parsed),
        "http" if local => Ok(parsed),
        _ => Err(Error::Invalid(
            "The webhook must be https (plain http only to localhost).".into(),
        )),
    }
}

/// Posts `body` to the webhook (`url`, else the stored one); the answer's status.
#[tauri::command]
pub async fn notify_webhook_post(
    state: State<'_, AppState>,
    url: Option<String>,
    body: String,
    content_type: String,
    headers: Vec<(String, String)>,
) -> Result<u16> {
    let url = match url {
        Some(u) => u,
        None => secrets::get(&state.dirs.data.join("secrets.json"), SECRET_ID)
            .ok_or_else(|| Error::Invalid("No webhook is set.".into()))?,
    };
    let url = allowed(&url)?;
    if body.len() > MAX_BODY {
        return Err(Error::Invalid("The notification is too long.".into()));
    }
    let content_type = if content_type.starts_with("application/json") {
        "application/json"
    } else {
        "text/plain; charset=utf-8"
    };
    let mut request = state
        .ai
        .client()
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .timeout(TIMEOUT)
        .body(body);
    for (name, value) in headers {
        if HEADERS.contains(&name.as_str()) && value.chars().all(|c| (' '..='~').contains(&c)) {
            request = request.header(name, value);
        }
    }
    let response = request.send().await.map_err(crate::ai::http_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(Error::Invalid(format!(
            "The webhook answered {} {}.",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        )));
    }
    Ok(status.as_u16())
}

/// Keeps (or with null removes) the webhook URL in the secrets file.
#[tauri::command]
pub async fn notify_webhook_store(state: State<'_, AppState>, url: Option<String>) -> Result<()> {
    if let Some(u) = url.as_deref() {
        allowed(u)?;
    }
    secrets::set(
        &state.dirs.data.join("secrets.json"),
        SECRET_ID,
        url.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_or_local_http_only() {
        assert!(allowed("https://ntfy.sh/topic").is_ok());
        assert!(allowed("http://127.0.0.1:11998/hook").is_ok());
        assert!(allowed("http://localhost/hook").is_ok());
        assert!(allowed("http://[::1]:8/x").is_ok());
        assert!(allowed("http://example.com/hook").is_err());
        assert!(allowed("file:///etc/passwd").is_err());
        assert!(allowed("not a url").is_err());
    }
}
