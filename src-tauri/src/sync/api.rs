//! Requests to the sync service, in the signed-in account's name. A reply the caller must act
//! on (a conflict, "check your chunks again") comes back as `Reply`; everything else that
//! isn't success becomes an `Error::Sync` with a code the front end tells apart.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::accounts;
use crate::error::{Error, Result};

const TIMEOUT: Duration = Duration::from_secs(30);
/// Uploads and downloads of chunks carry megabytes.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);

pub struct Api {
    base: String,
    /// The part of the service asked: `/api/<area>/…` ("sync"; "team" for a team's library).
    area: &'static str,
    /// The saved account session (`account.json`), where the tokens come from.
    session: PathBuf,
    client: reqwest::Client,
}

pub struct Reply {
    pub status: u16,
    pub json: Value,
}

impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The server's error code ("conflict", "gc", "key_version"...), empty on success.
    pub fn error(&self) -> &str {
        self.json.get("error").and_then(Value::as_str).unwrap_or("")
    }

    /// Success, or the error this reply stands for.
    pub fn into_ok(self) -> Result<Value> {
        if self.ok() {
            return Ok(self.json);
        }
        Err(refusal(self.status, &self.json))
    }
}

pub enum Body<'a> {
    None,
    Json(&'a Value),
    Bytes(Vec<u8>),
}

fn offline(e: reqwest::Error) -> Error {
    Error::Sync(
        "SyncOffline",
        format!("The sync service can't be reached ({e})."),
    )
}

/// A success whose body isn't what it should be (cut off, a proxy's page): the same as not
/// reaching the service, so the caller tries again later and decides nothing from it.
pub fn unreadable() -> Error {
    Error::Sync(
        "SyncOffline",
        "The sync service gave an answer that couldn't be read; trying again later.".into(),
    )
}

/// What a refusal means to the person using it.
fn refusal(status: u16, json: &Value) -> Error {
    let code = json.get("error").and_then(Value::as_str).unwrap_or("");
    let text = json
        .get("error_description")
        .and_then(Value::as_str)
        .unwrap_or("The sync service refused the request.")
        .to_string();
    match (status, code) {
        (401, _) => Error::Sync("SyncSignedOut", "Sign in again to keep syncing.".into()),
        (403, "sync_unavailable") => Error::Sync("SyncUnavailable", text),
        // The subscription ended: what is synced can be read, nothing can be written.
        (402, "sync_lapsed") => Error::Sync("SyncLapsed", text),
        (403, "not_approved" | "not_a_device") => Error::Sync("SyncNotApproved", text),
        (409, "no_vault") => Error::Sync("SyncReset", text),
        // Stored data is being cleaned up: the same request works a moment later.
        (409, "gc") => Error::Sync("SyncRetry", text),
        (403, "proof_failed") => Error::Sync("SyncKeys", text),
        (429, _) => Error::Sync(
            "SyncOffline",
            "Sync is pausing for a moment (too many requests).".into(),
        ),
        (507, _) => Error::Sync("SyncFull", text),
        (413, _) => Error::Sync("SyncTooLarge", text),
        (s, _) if s >= 500 => Error::Sync(
            "SyncOffline",
            "The sync service has a problem; trying again later.".into(),
        ),
        _ => Error::Sync("Sync", text),
    }
}

impl Api {
    pub fn new(base: &str, data_dir: &Path) -> Self {
        Self::of("sync", base, data_dir)
    }

    /// The same client for another part of the accounts server (`/api/<area>/…`): the same
    /// session, the same refresh of a token that ran out.
    pub fn of(area: &'static str, base: &str, data_dir: &Path) -> Self {
        Self {
            area,
            base: base.trim_end_matches('/').to_string(),
            session: accounts::session_file(data_dir),
            client: reqwest::Client::new(),
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn token(&self) -> Result<String> {
        accounts::access_token(&self.session, &self.base)
            .ok_or_else(|| Error::Sync("SyncSignedOut", "Sign in to sync.".into()))
    }

    async fn send(
        &self,
        method: &reqwest::Method,
        path: &str,
        body: &Body<'_>,
        token: &str,
    ) -> Result<reqwest::Response> {
        let mut request = self
            .client
            .request(
                method.clone(),
                format!("{}/api/{}/{path}", self.base, self.area),
            )
            .bearer_auth(token);
        // Chunks and sweeps take as long as megabytes take; everything else is quick.
        let slow = path.starts_with("blobs") || path == "gc";
        let wait = if slow { TRANSFER_TIMEOUT } else { TIMEOUT };
        request = match body {
            Body::None => request.timeout(wait),
            Body::Json(v) => request.json(v).timeout(wait),
            Body::Bytes(b) => request
                .header("Content-Type", "application/octet-stream")
                .body(b.clone())
                .timeout(TRANSFER_TIMEOUT),
        };
        request.send().await.map_err(offline)
    }

    /// One request; a 401 refreshes the tokens once and asks again.
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Body<'_>,
    ) -> Result<reqwest::Response> {
        let mut reply = self.send(&method, path, &body, &self.token()?).await?;
        // "Slow down": waited out a few times before it is an error.
        for wait in [5, 15, 30] {
            if reply.status().as_u16() != 429 {
                break;
            }
            tokio::time::sleep(Duration::from_secs(wait)).await;
            reply = self.send(&method, path, &body, &self.token()?).await?;
        }
        if reply.status().as_u16() != 401 {
            return Ok(reply);
        }
        // `check` refreshes a token that ran out; None means the server ended the session.
        if accounts::check(&self.session, &self.base).await?.is_none() {
            return Err(Error::Sync(
                "SyncSignedOut",
                "Sign in again to keep syncing.".into(),
            ));
        }
        self.send(&method, path, &body, &self.token()?).await
    }

    pub async fn call(&self, method: reqwest::Method, path: &str, body: Body<'_>) -> Result<Reply> {
        let reply = self.request(method, path, body).await?;
        let status = reply.status().as_u16();
        let json = reply.json::<Value>().await.unwrap_or(Value::Null);
        Ok(Reply { status, json })
    }

    pub async fn get(&self, path: &str) -> Result<Value> {
        self.call(reqwest::Method::GET, path, Body::None)
            .await?
            .into_ok()
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Reply> {
        self.call(reqwest::Method::POST, path, Body::Json(body))
            .await
    }

    pub async fn put(&self, path: &str, body: &Value) -> Result<Reply> {
        self.call(reqwest::Method::PUT, path, Body::Json(body))
            .await
    }

    pub async fn delete(&self, path: &str) -> Result<Value> {
        self.call(reqwest::Method::DELETE, path, Body::None)
            .await?
            .into_ok()
    }

    /// Uploads framed chunks.
    pub async fn upload(&self, frames: Vec<u8>) -> Result<Value> {
        self.call(reqwest::Method::POST, "blobs", Body::Bytes(frames))
            .await?
            .into_ok()
    }

    /// Downloads chunks as frames.
    pub async fn download(&self, ids: &[String]) -> Result<Vec<u8>> {
        let body = serde_json::json!({ "ids": ids });
        let reply = self
            .request(reqwest::Method::POST, "blobs/get", Body::Json(&body))
            .await?;
        let status = reply.status().as_u16();
        if !(200..300).contains(&status) {
            let json = reply.json::<Value>().await.unwrap_or(Value::Null);
            return Err(refusal(status, &json));
        }
        Ok(reply.bytes().await.map_err(offline)?.to_vec())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_refused_for_an_ended_subscription_has_its_own_code() {
        let json = serde_json::json!({
            "error": "sync_lapsed",
            "error_description": "The Sync subscription ended.",
            "until": 1_800_000_000_000u64,
        });
        match refusal(402, &json) {
            Error::Sync(code, text) => {
                assert_eq!(code, "SyncLapsed");
                assert_eq!(text, "The Sync subscription ended.");
            }
            other => panic!("unexpected: {other:?}"),
        }
        // Another 402 stays a plain refusal.
        assert!(matches!(
            refusal(402, &serde_json::json!({ "error": "other" })),
            Error::Sync("Sync", _)
        ));
    }
}
