//! Requests to the sync service, in the signed-in account's name. A reply the caller must act
//! on (a conflict, "check your chunks again") comes back as `Reply`; everything else that
//! isn't success becomes an `Error::Sync` with a code the front end tells apart.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::accounts;
use crate::accounts::http::{read_capped, BodyError, JSON_CAP};
use crate::error::{Error, Result};

const TIMEOUT: Duration = Duration::from_secs(30);
/// Uploads and downloads of chunks carry megabytes.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(300);

pub struct Api {
    base: String,
    /// The part of the service asked: `/api/<area>/…` ("sync"; "team" for a team's library).
    area: &'static str,
    /// What comes between the area and a call's path: empty for the account's own vault and
    /// for a team's library, `shares/<id>/` for a share (which answers a vault's calls there).
    prefix: String,
    /// The saved account session (`account.json`), where the tokens come from.
    session: PathBuf,
    client: reqwest::Client,
    /// What a record read here must pass beyond opening (`records::Checks`): the counters
    /// this computer has seen, and the key generations below which nothing is taken.
    pub checks: super::records::Checks,
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
    /// No content of its own, only proof of this device's key (`{ id, proof }`): sent as
    /// the header `X-Sync-Challenge` and as the body's `challenge`. For a DELETE, whose body
    /// not everything on the way passes on.
    Proof(&'a Value),
}

/// A proof as the header carries it: `<id>.<proof>`. None when it isn't one.
fn proof_header(proof: &Value) -> Option<String> {
    let part = |name: &str| {
        proof[name].as_str().filter(|text| {
            !text.is_empty()
                && text
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
    };
    Some(format!("{}.{}", part("id")?, part("proof")?))
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

/// The most a download of chunks is read: the service fills a reply up to 24 MB (one chunk of
/// up to 8 MB when it is alone), plus 26 bytes of frame for each of at most 2,000 chunks.
const DOWNLOAD_CAP: usize = 48 * 1024 * 1024;

/// A body that was cut off, or larger than any answer is.
fn unread(e: BodyError) -> Error {
    match e {
        BodyError::TooLarge => Error::Sync(
            "Sync",
            "The sync service gave an answer larger than any answer should be.".into(),
        ),
        BodyError::Broken(e) => Error::Sync(
            "SyncOffline",
            format!("The sync service can't be reached ({e})."),
        ),
    }
}

/// A reply's JSON, read up to the cap. A body that isn't JSON reads as null, as before (the
/// status says what happened); one past the cap is an error.
async fn json_of(reply: reqwest::Response) -> Result<Value> {
    let bytes = read_capped(reply, JSON_CAP).await.map_err(unread)?;
    Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
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
        // The service asks for proof of the device's key on this call and got none (a build
        // from before it sent one).
        (403, "proof_required") => Error::Sync(
            "SyncKeys",
            "The sync service needs a newer version of the app for this. Update the app and try again.".into(),
        ),
        (429, _) => Error::Sync(
            "SyncOffline",
            "Sync is pausing for a moment (too many requests).".into(),
        ),
        (507, _) => Error::Sync("SyncFull", text),
        (413, _) => Error::Sync("SyncTooLarge", text),
        // A team's shares (`share`): only the calls under `/api/team/` answer with these.
        (404, "no_team") => Error::Sync("ShareNoTeam", "This account isn't in a team.".into()),
        (404, "no_share") => Error::Sync(
            "ShareGone",
            "That share isn't there (it was stopped, or this account isn't in its team).".into(),
        ),
        (403, "not_member") => Error::Sync("ShareNotMember", text),
        (403, "not_sharer") => Error::Sync("ShareNotSharer", text),
        (409, "no_member_key") => Error::Sync("ShareNoMemberKey", text),
        (409, "too_many_shares") => Error::Sync("ShareTooMany", text),
        (s, _) if s >= 500 => Error::Sync(
            "SyncOffline",
            "The sync service has a problem; trying again later.".into(),
        ),
        _ => Error::Sync("Sync", text),
    }
}

/// Whether `id` can stand in an address as one part of it: letters, digits, `-`, `_` and the
/// one dot a share's id has between its two halves. Nothing that names another place.
fn share_id_fits_a_path(id: &str) -> bool {
    let plain = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    id.len() <= 200
        && id
            .split_once('.')
            .is_some_and(|(owner, project)| plain(owner) && plain(project))
}

/// Whether a call's path is made of plain parts: each of letters, digits, `.`, `_`, `-` and
/// `:`, none of them empty, `.` or `..`, with at most a plain query after them. Whatever a
/// caller put into a path (a device's id, a record's name), the address asked is then the one
/// that was written: nothing in it names another place once it is read. (The empty path is
/// the area itself.)
fn plain_path(path: &str) -> bool {
    let (parts, query) = match path.split_once('?') {
        Some((parts, query)) => (parts, Some(query)),
        None => (path, None),
    };
    let plain = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':');
    let parts_fit = parts.is_empty()
        || parts
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && part.chars().all(plain));
    let query_fits = query.is_none_or(|q| {
        !q.is_empty() && q.chars().all(|c| plain(c) || c == '=' || c == '&') && !q.contains("..")
    });
    path.len() <= 600 && parts_fit && query_fits
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
            prefix: String::new(),
            base: base.trim_end_matches('/').to_string(),
            session: accounts::session_file(data_dir),
            // No redirect is followed: the service answers where it is asked.
            client: accounts::http::client(),
            checks: super::records::Checks::of(data_dir),
        }
    }

    /// The client for what a team's share holds (`/api/team/shares/<id>/…`): its records,
    /// chunks and sweep answer the calls a vault's do, so the same code reads and writes it.
    /// `id` goes into the address, so only a share's id as the service makes them is taken.
    pub fn share(base: &str, data_dir: &Path, id: &str) -> Result<Self> {
        if !share_id_fits_a_path(id) {
            return Err(Error::Invalid("that isn't a share".into()));
        }
        let mut api = Self::of("team", base, data_dir);
        api.prefix = format!("shares/{id}/");
        // Shares came with the counters: every record of one carries its own.
        api.checks.strict = true;
        Ok(api)
    }

    /// Where a call goes. (The team's own view is the area itself: no trailing slash.)
    fn url(&self, path: &str) -> String {
        let rest = format!("{}{path}", self.prefix);
        if rest.is_empty() {
            return format!("{}/api/{}", self.base, self.area);
        }
        format!("{}/api/{}/{rest}", self.base, self.area)
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
            .request(method.clone(), self.url(path))
            .bearer_auth(token);
        // Chunks and sweeps take as long as megabytes take; everything else is quick.
        let slow = path.starts_with("blobs") || path == "gc";
        let wait = if slow { TRANSFER_TIMEOUT } else { TIMEOUT };
        request = match body {
            Body::None => request.timeout(wait),
            Body::Json(v) => request.json(v).timeout(wait),
            Body::Proof(proof) => {
                let header = proof_header(proof).ok_or_else(|| {
                    Error::Sync(
                        "SyncKeys",
                        "The proof of this device's key isn't one.".into(),
                    )
                })?;
                request
                    .header("X-Sync-Challenge", header)
                    .json(&serde_json::json!({ "challenge": proof }))
                    .timeout(wait)
            }
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
        // Every request passes here: a path that could be read as another place is never sent.
        if !plain_path(path) {
            return Err(Error::Invalid("that isn't a call of the service".into()));
        }
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
        Ok(Reply {
            status,
            json: json_of(reply).await?,
        })
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

    /// A DELETE that carries proof of this device's own key (removing a device).
    pub async fn delete_proved(&self, path: &str, proof: &Value) -> Result<Value> {
        self.call(reqwest::Method::DELETE, path, Body::Proof(proof))
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
            let json = json_of(reply).await?;
            return Err(refusal(status, &json));
        }
        read_capped(reply, DOWNLOAD_CAP).await.map_err(unread)
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

    #[test]
    fn proof_of_the_devices_key_travels_as_a_header_and_its_refusals_say_what_to_do() {
        let proof = serde_json::json!({ "id": "c-1_A", "proof": "AbC_-9" });
        assert_eq!(proof_header(&proof).as_deref(), Some("c-1_A.AbC_-9"));
        // Nothing that could end the header or start another.
        for not in [
            serde_json::json!({ "id": "c1" }),
            serde_json::json!({ "id": "", "proof": "x" }),
            serde_json::json!({ "id": "c1\r\nX: y", "proof": "x" }),
            serde_json::json!({ "id": "c.1", "proof": "x" }),
            serde_json::json!(null),
        ] {
            assert_eq!(proof_header(&not), None, "{not}");
        }
        match refusal(403, &serde_json::json!({ "error": "proof_required" })) {
            Error::Sync(code, text) => {
                assert_eq!(code, "SyncKeys");
                assert!(text.contains("newer version"), "{text}");
            }
            other => panic!("unexpected: {other:?}"),
        }
        assert!(matches!(
            refusal(403, &serde_json::json!({ "error": "proof_failed" })),
            Error::Sync("SyncKeys", _)
        ));
    }

    #[test]
    fn an_answer_past_its_cap_is_an_error_and_not_a_reason_to_ask_again() {
        // "Offline" is retried on a timer; an answer that is too large would be too large again.
        assert!(matches!(
            unread(BodyError::TooLarge),
            Error::Sync("Sync", _)
        ));
        assert!(matches!(
            unread(BodyError::Broken("reset".into())),
            Error::Sync("SyncOffline", _)
        ));
    }

    // A download's cap is above the largest reply the service makes (24 MB, or one chunk of
    // 8 MB alone, and each chunk's frame), and a JSON reply's above a page of records.
    const _: () = assert!(DOWNLOAD_CAP >= 24 * 1024 * 1024 + 8 * 1024 * 1024 + 2000 * 26);
    const _: () = assert!(JSON_CAP >= 8 * 1024 * 1024);

    #[test]
    fn a_share_answers_under_its_own_path_and_the_vault_where_it_did() {
        let data = std::path::Path::new("data");
        let vault = Api::new("https://example.test/", data);
        assert_eq!(vault.url("state"), "https://example.test/api/sync/state");
        assert_eq!(
            vault.url("records/settings/user"),
            "https://example.test/api/sync/records/settings/user"
        );
        let team = Api::of("team", "https://example.test", data);
        assert_eq!(team.url("library"), "https://example.test/api/team/library");
        assert_eq!(team.url("shares"), "https://example.test/api/team/shares");
        assert_eq!(team.url(""), "https://example.test/api/team");
        let share = Api::share("https://example.test", data, "uid_1.proj-2").unwrap();
        assert_eq!(
            share.url("records?since=0"),
            "https://example.test/api/team/shares/uid_1.proj-2/records?since=0"
        );
        assert_eq!(
            share.url("blobs/have"),
            "https://example.test/api/team/shares/uid_1.proj-2/blobs/have"
        );
        assert_eq!(
            share.url("gc"),
            "https://example.test/api/team/shares/uid_1.proj-2/gc"
        );
        // An id that would name another place is never put into an address.
        for bad in [
            "",
            "uid",
            "uid.",
            ".proj",
            "a.b.c",
            "uid/../x.proj",
            "uid.proj/keys",
            "uid.proj?x=1",
            "uid.pr oj",
            "uid.pr%2Foj",
            "..",
        ] {
            assert!(
                Api::share("https://example.test", data, bad).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_calls_path_is_made_of_plain_parts() {
        for ok in [
            "",
            "state",
            "records?since=0",
            "records/settings/user",
            "records/snap.AbC/1800000000000-abc123",
            "devices/AbC_d-1/approve",
            "blobs/have",
            "shares/proj-1",
            "library/item_1",
        ] {
            assert!(plain_path(ok), "{ok}");
        }
        for bad in [
            "records/x/../sys/member",
            "devices/../records/sys/member",
            "devices/x/../../recovery",
            "records/./sys/member",
            "records//member",
            "/records",
            "records/",
            "records/a b/c",
            "records/a%2Fb/c",
            "records/a\\b/c",
            "records/a/b#c",
            "records/a/b?x=1?y=2",
            "records?since=0/../x",
            "records?",
            "devices/a;b",
        ] {
            assert!(!plain_path(bad), "{bad}");
        }
    }

    #[test]
    fn a_shares_refusals_have_their_own_codes() {
        let code =
            |status, error: &str| match refusal(status, &serde_json::json!({ "error": error })) {
                Error::Sync(code, _) => code,
                other => panic!("unexpected: {other:?}"),
            };
        assert_eq!(code(404, "no_share"), "ShareGone");
        assert_eq!(code(404, "no_team"), "ShareNoTeam");
        assert_eq!(code(403, "not_member"), "ShareNotMember");
        assert_eq!(code(403, "not_sharer"), "ShareNotSharer");
        assert_eq!(code(409, "no_member_key"), "ShareNoMemberKey");
        assert_eq!(code(402, "sync_lapsed"), "SyncLapsed");
        assert_eq!(code(507, "storage_full"), "SyncFull");
        // What a vault answered before is what it answers now.
        assert_eq!(code(409, "no_vault"), "SyncReset");
        assert_eq!(code(409, "gc"), "SyncRetry");
        assert_eq!(code(404, "not_found"), "Sync");
        assert_eq!(code(403, "forbidden"), "Sync");
    }
}
