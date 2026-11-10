//! OAuth sign-in for remote MCP servers (D204), after the MCP authorization specification
//! (2025-06-18): a server that answers 401 points to its protected resource metadata (RFC 9728,
//! `WWW-Authenticate: Bearer resource_metadata="…"`, else the well-known address), which names
//! its authorization server; that server's metadata (RFC 8414, or OpenID's) gives the endpoints.
//! The IDE registers itself (dynamic client registration, RFC 7591, a public client), opens the
//! authorization page in the browser with PKCE (S256) and the `resource` parameter (RFC 8707),
//! and gets the code back on a loopback address it listens on (RFC 8252). Tokens are kept in the
//! secrets file (`mcp.oauth.<server>`), never handed to the webview, sent as the Bearer header by
//! `remote::post`, and refreshed when they expire.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::error::{Error, Result};

/// RFC 9728's metadata, the parts we use.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
pub struct ProtectedResource {
    #[serde(default)]
    pub resource: Option<String>,
    #[serde(default)]
    pub authorization_servers: Vec<String>,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
}

/// RFC 8414's metadata, the parts we use.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct AuthServer {
    #[serde(default)]
    pub issuer: Option<String>,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub scopes_supported: Vec<String>,
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
}

/// What's stored for a server (the secrets file, `mcp.oauth.<server>`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    /// Seconds since the epoch.
    #[serde(default)]
    pub expires_at: Option<u64>,
    pub token_endpoint: String,
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    pub resource: String,
    /// The server address the tokens were given for (a changed address signs in again).
    pub server_url: String,
    #[serde(default)]
    pub scope: Option<String>,
}

/// What the frontend may know about a server's sign-in (never the tokens).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SignInStatus {
    pub signed_in: bool,
    pub expires_at: Option<u64>,
    pub can_refresh: bool,
    pub scope: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---- Discovery --------------------------------------------------------------------------

/// `resource_metadata="…"` (and `scope="…"`) from a `WWW-Authenticate: Bearer …` header.
pub fn header_param(www_authenticate: &str, name: &str) -> Option<String> {
    let lower = www_authenticate.to_ascii_lowercase();
    let key = format!("{name}=");
    let mut from = 0;
    while let Some(i) = lower[from..].find(&key) {
        let at = from + i;
        // A whole parameter name (not `xresource_metadata=`).
        let ok = at == 0 || matches!(lower.as_bytes()[at - 1], b' ' | b',' | b'\t');
        let rest = &www_authenticate[at + key.len()..];
        if ok {
            return if let Some(quoted) = rest.strip_prefix('"') {
                quoted.find('"').map(|end| quoted[..end].to_string())
            } else {
                Some(
                    rest.split([',', ' '])
                        .next()
                        .unwrap_or_default()
                        .to_string(),
                )
            }
            .filter(|v| !v.is_empty());
        }
        from = at + key.len();
    }
    None
}

/// A 403's `WWW-Authenticate` asking for more scopes (`error="insufficient_scope"`, MCP's step-up
/// authorization): Some with the scopes it names (None when it names none), else None.
pub fn insufficient_scope(www_authenticate: &str) -> Option<Option<String>> {
    (header_param(www_authenticate, "error").as_deref() == Some("insufficient_scope"))
        .then(|| header_param(www_authenticate, "scope"))
}

/// The scopes to ask for in a new sign-in: those already granted plus those wanted, each once
/// and in order (a step-up keeps what the earlier sign-in gave).
pub fn merge_scopes(granted: Option<&str>, wanted: Option<&str>) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    for s in granted
        .into_iter()
        .chain(wanted)
        .flat_map(str::split_whitespace)
    {
        if !out.contains(&s) {
            out.push(s);
        }
    }
    (!out.is_empty()).then(|| out.join(" "))
}

/// The canonical resource URI of a server (RFC 8707 as MCP uses it): lower-case scheme and host,
/// no fragment, the path kept (without a trailing slash, except the root).
pub fn canonical_resource(server_url: &str) -> Result<String> {
    let mut url = reqwest::Url::parse(server_url)
        .map_err(|e| Error::Invalid(format!("{server_url}: {e}")))?;
    url.set_fragment(None);
    let mut text = url.to_string();
    if url.query().is_none() && text.ends_with('/') {
        text.pop();
    }
    Ok(text)
}

/// Whether `resource` (from a server's metadata) is the server at `server_url` or a parent of
/// it: the same origin, and the server's path under the resource's (whole segments).
pub fn resource_covers(resource: &str, server_url: &str) -> bool {
    let (Ok(r), Ok(s)) = (
        reqwest::Url::parse(resource),
        reqwest::Url::parse(server_url),
    ) else {
        return false;
    };
    if r.origin() != s.origin() {
        return false;
    }
    let rp = r.path().trim_end_matches('/');
    let sp = s.path().trim_end_matches('/');
    rp.is_empty() || sp == rp || sp.starts_with(&format!("{rp}/"))
}

/// Where the protected resource metadata may be: the header's address first, then the
/// well-known address with the server's path, then at the root (RFC 9728 §3.1).
pub fn resource_metadata_urls(server_url: &str, header: Option<&str>) -> Result<Vec<String>> {
    let url = reqwest::Url::parse(server_url)
        .map_err(|e| Error::Invalid(format!("{server_url}: {e}")))?;
    let origin = url.origin().ascii_serialization();
    let path = url.path().trim_end_matches('/');
    let mut out = Vec::new();
    if let Some(h) = header {
        out.push(h.to_string());
    }
    if !path.is_empty() {
        out.push(format!(
            "{origin}/.well-known/oauth-protected-resource{path}"
        ));
    }
    out.push(format!("{origin}/.well-known/oauth-protected-resource"));
    out.dedup();
    Ok(out)
}

/// Where an authorization server's metadata may be (RFC 8414 §3.1, then OpenID Connect's
/// two places), for an issuer with or without a path.
pub fn auth_server_metadata_urls(issuer: &str) -> Result<Vec<String>> {
    let url = reqwest::Url::parse(issuer).map_err(|e| Error::Invalid(format!("{issuer}: {e}")))?;
    let origin = url.origin().ascii_serialization();
    let path = url.path().trim_end_matches('/');
    Ok(if path.is_empty() {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server"),
            format!("{origin}/.well-known/openid-configuration"),
        ]
    } else {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server{path}"),
            format!("{origin}/.well-known/openid-configuration{path}"),
            format!("{origin}{path}/.well-known/openid-configuration"),
        ]
    })
}

async fn get_json(client: &reqwest::Client, url: &str) -> Option<Value> {
    let response = client
        .get(url)
        .header("Accept", "application/json")
        .header("MCP-Protocol-Version", "2025-06-18")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Value>().await.ok()
}

/// What sign-in needs: the authorization server, the resource and the scopes to ask for.
#[derive(Debug, Clone, PartialEq)]
pub struct Discovered {
    pub server: AuthServer,
    pub resource: String,
    pub scope: Option<String>,
}

/// Finds the authorization server for `server_url` (`www_authenticate`: the 401's header, when
/// one was seen). A server that publishes no resource metadata (the 2025-03-26 revision) is its
/// own authorization server; one without metadata at all gets the default endpoints there.
pub async fn discover(
    client: &reqwest::Client,
    server_url: &str,
    www_authenticate: Option<&str>,
) -> Result<Discovered> {
    let resource_default = canonical_resource(server_url)?;
    let header_url = www_authenticate.and_then(|h| header_param(h, "resource_metadata"));
    let header_scope = www_authenticate.and_then(|h| header_param(h, "scope"));
    let mut prm: Option<ProtectedResource> = None;
    for url in resource_metadata_urls(server_url, header_url.as_deref())? {
        if let Some(v) = get_json(client, &url).await {
            if let Ok(p) = serde_json::from_value::<ProtectedResource>(v) {
                if !p.authorization_servers.is_empty() {
                    prm = Some(p);
                    break;
                }
            }
        }
    }
    let base = reqwest::Url::parse(server_url)
        .map_err(|e| Error::Invalid(format!("{server_url}: {e}")))?
        .origin()
        .ascii_serialization();
    let issuer = prm
        .as_ref()
        .and_then(|p| p.authorization_servers.first().cloned())
        .unwrap_or_else(|| base.clone());
    let mut server: Option<AuthServer> = None;
    for url in auth_server_metadata_urls(&issuer)? {
        if let Some(v) = get_json(client, &url).await {
            if let Ok(s) = serde_json::from_value::<AuthServer>(v) {
                server = Some(s);
                break;
            }
        }
    }
    let server = match server {
        Some(s) => s,
        // No metadata: the 2025-03-26 defaults at the server's own address.
        None if prm.is_none() => AuthServer {
            issuer: Some(base.clone()),
            authorization_endpoint: format!("{base}/authorize"),
            token_endpoint: format!("{base}/token"),
            registration_endpoint: Some(format!("{base}/register")),
            ..AuthServer::default()
        },
        None => {
            return Err(Error::Ai(format!(
                "{issuer} publishes no authorization server metadata"
            )))
        }
    };
    if !server.code_challenge_methods_supported.is_empty()
        && !server
            .code_challenge_methods_supported
            .iter()
            .any(|m| m == "S256")
    {
        return Err(Error::Ai(format!(
            "{issuer} doesn't support PKCE with S256, which MCP requires"
        )));
    }
    let resource = match prm.as_ref().and_then(|p| p.resource.clone()) {
        // RFC 9728 §3.3: the metadata must be about this server; else a token for another
        // resource (another server's) would be asked for, and sent here.
        Some(r) if !resource_covers(&r, server_url) => {
            return Err(Error::Ai(format!(
                "{server_url}'s metadata names another resource ({r}); not signing in"
            )))
        }
        Some(r) => r,
        None => resource_default,
    };
    // The code, the verifier and the tokens travel to these: https (or http on this machine).
    for endpoint in [&server.authorization_endpoint, &server.token_endpoint]
        .into_iter()
        .chain(server.registration_endpoint.as_ref())
    {
        super::remote::check_url(endpoint)?;
    }
    let scope = header_scope.or_else(|| {
        let scopes = prm
            .as_ref()
            .map(|p| p.scopes_supported.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| server.scopes_supported.clone());
        (!scopes.is_empty()).then(|| scopes.join(" "))
    });
    Ok(Discovered {
        server,
        resource,
        scope,
    })
}

// ---- PKCE, registration, tokens ---------------------------------------------------------

/// Base64url without padding (RFC 4648 §5).
pub fn base64url(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        let chars = [(n >> 18) & 63, (n >> 12) & 63, (n >> 6) & 63, n & 63];
        for c in chars.iter().take(chunk.len() + 1) {
            out.push(ABC[*c as usize] as char);
        }
    }
    out
}

fn random_token(bytes: usize) -> Result<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| Error::Invalid(format!("no randomness: {e}")))?;
    Ok(base64url(&buf))
}

/// The S256 code challenge of a verifier.
pub fn code_challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// A new PKCE verifier (43 characters, RFC 7636's minimum entropy) and its challenge.
pub fn pkce_pair() -> Result<(String, String)> {
    let verifier = random_token(32)?;
    let challenge = code_challenge(&verifier);
    Ok((verifier, challenge))
}

/// Registers the IDE as a public client with a loopback redirect (RFC 7591).
pub async fn register(
    client: &reqwest::Client,
    endpoint: &str,
    redirect_uri: &str,
    client_name: &str,
) -> Result<(String, Option<String>)> {
    let response = client
        .post(endpoint)
        .timeout(Duration::from_secs(30))
        .json(&serde_json::json!({
            "client_name": client_name,
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "application_type": "native",
        }))
        .send()
        .await
        .map_err(crate::ai::http_error)?;
    if !response.status().is_success() {
        return Err(crate::ai::error_body(response).await);
    }
    let v: Value = response.json().await.map_err(crate::ai::http_error)?;
    let id = v
        .get("client_id")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Ai("the registration answer has no client_id".into()))?;
    let secret = v
        .get("client_secret")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok((id.to_string(), secret))
}

/// The authorization page's address.
#[allow(clippy::too_many_arguments)]
pub fn authorize_url(
    endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
    resource: &str,
    scope: Option<&str>,
) -> Result<String> {
    let mut url =
        reqwest::Url::parse(endpoint).map_err(|e| Error::Invalid(format!("{endpoint}: {e}")))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", state)
            .append_pair("resource", resource);
        if let Some(s) = scope.filter(|s| !s.is_empty()) {
            q.append_pair("scope", s);
        }
    }
    Ok(url.to_string())
}

/// A token request that failed: `refused` when the authorization server answered 400 or 401
/// (`invalid_grant`, a revoked client), not when it couldn't be reached.
struct TokenFailure {
    refused: bool,
    error: Error,
}

impl From<TokenFailure> for Error {
    fn from(f: TokenFailure) -> Self {
        f.error
    }
}

async fn token_request(
    client: &reqwest::Client,
    endpoint: &str,
    form: &[(&str, &str)],
) -> std::result::Result<Value, TokenFailure> {
    let other = |error: Error| TokenFailure {
        refused: false,
        error,
    };
    let response = client
        .post(endpoint)
        .timeout(Duration::from_secs(30))
        .header("Accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(|e| other(crate::ai::http_error(e)))?;
    if !response.status().is_success() {
        return Err(TokenFailure {
            refused: matches!(response.status().as_u16(), 400 | 401),
            error: crate::ai::error_body(response).await,
        });
    }
    response
        .json::<Value>()
        .await
        .map_err(|e| other(crate::ai::http_error(e)))
}

fn tokens_from(v: &Value, base: &Tokens) -> Result<Tokens> {
    let access = v
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Ai("the token answer has no access_token".into()))?;
    let expires = v.get("expires_in").and_then(Value::as_u64);
    Ok(Tokens {
        access_token: access.to_string(),
        // A refresh that doesn't send a new refresh token keeps the old one (RFC 6749 §6).
        refresh_token: v
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| base.refresh_token.clone()),
        expires_at: expires.map(|s| now() + s),
        scope: v
            .get("scope")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| base.scope.clone()),
        ..base.clone()
    })
}

/// A sign-in under way: what the callback and the code exchange need.
pub struct PendingFlow {
    pub server: String,
    pub server_url: String,
    pub listener: TcpListener,
    pub redirect_uri: String,
    pub state: String,
    pub verifier: String,
    pub client_id: String,
    pub client_secret: Option<String>,
    pub token_endpoint: String,
    pub resource: String,
    pub scope: Option<String>,
    pub authorize_url: String,
}

/// Starts a sign-in: discovery, a loopback listener, registration (unless the server has no
/// registration endpoint, then `client_id` must be given), PKCE. The caller opens
/// `authorize_url` in the browser and then calls `finish`. `granted`: the scopes of the sign-in
/// it replaces, asked for again with what a step-up challenge wants (D207).
pub async fn begin(
    client: &reqwest::Client,
    server: &str,
    server_url: &str,
    www_authenticate: Option<&str>,
    client_name: &str,
    client_id: Option<&str>,
    granted: Option<&str>,
) -> Result<PendingFlow> {
    let mut found = discover(client, server_url, www_authenticate).await?;
    if www_authenticate.is_some_and(|h| insufficient_scope(h).is_some()) {
        found.scope = merge_scopes(granted, found.scope.as_deref());
    }
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let (client_id, client_secret) = match (client_id, &found.server.registration_endpoint) {
        (Some(id), _) => (id.to_string(), None),
        (None, Some(endpoint)) => register(client, endpoint, &redirect_uri, client_name).await?,
        (None, None) => {
            return Err(Error::Ai(
                "the authorization server doesn't support dynamic client registration; give a client id (\"oauth\": { \"clientId\": … } in the server's config)".into(),
            ))
        }
    };
    let (verifier, challenge) = pkce_pair()?;
    let state = random_token(16)?;
    let authorize_url = authorize_url(
        &found.server.authorization_endpoint,
        &client_id,
        &redirect_uri,
        &challenge,
        &state,
        &found.resource,
        found.scope.as_deref(),
    )?;
    Ok(PendingFlow {
        server: server.to_string(),
        server_url: server_url.to_string(),
        listener,
        redirect_uri,
        state,
        verifier,
        client_id,
        client_secret,
        token_endpoint: found.server.token_endpoint,
        resource: found.resource,
        scope: found.scope,
        authorize_url,
    })
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Signed in</title><body style=\"font:16px system-ui;margin:3em\"><h1>Signed in</h1><p>You can close this tab and go back to the IDE.</p>";
const FAILED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Sign-in failed</title><body style=\"font:16px system-ui;margin:3em\"><h1>Sign-in failed</h1><p>Go back to the IDE and try again.</p>";

/// The query parameters of a request line's target (`/callback?code=…&state=…`).
pub fn callback_params(target: &str) -> Option<HashMap<String, String>> {
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" {
        return None;
    }
    Some(url.query_pairs().into_owned().collect())
}

/// Waits for the browser to come back with the code (other requests, such as a favicon, get a
/// 404); a wrong `state` or an `error` ends it.
pub async fn wait_for_code(flow: &PendingFlow, timeout: Duration) -> Result<String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let accepted = tokio::time::timeout_at(deadline, flow.listener.accept())
            .await
            .map_err(|_| Error::Ai("the sign-in timed out (no answer from the browser)".into()))?;
        let Ok((mut stream, _)) = accepted else {
            continue;
        };
        let mut buf = vec![0u8; 8192];
        let mut len = 0;
        // The request line and headers (the browser sends no body with a GET).
        while len < buf.len() {
            let n =
                match tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf[len..]))
                    .await
                {
                    Ok(Ok(n)) => n,
                    _ => 0,
                };
            if n == 0 {
                break;
            }
            len += n;
            if buf[..len].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let head = String::from_utf8_lossy(&buf[..len]).to_string();
        let target = head
            .lines()
            .next()
            .and_then(|l| l.strip_prefix("GET "))
            .and_then(|l| l.split(' ').next())
            .unwrap_or("");
        let reply = |status: &str, body: &str| {
            format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
                body.len()
            )
        };
        let Some(params) = callback_params(target) else {
            let _ = stream
                .write_all(reply("404 Not Found", "not found").as_bytes())
                .await;
            continue;
        };
        if params.get("state").map(String::as_str) != Some(flow.state.as_str()) {
            let _ = stream
                .write_all(reply("400 Bad Request", FAILED_PAGE).as_bytes())
                .await;
            // Someone else's request (or a stale tab): keep waiting for ours.
            continue;
        }
        if let Some(error) = params.get("error") {
            let _ = stream
                .write_all(reply("400 Bad Request", FAILED_PAGE).as_bytes())
                .await;
            let detail = params
                .get("error_description")
                .map(|d| format!(": {d}"))
                .unwrap_or_default();
            return Err(Error::Ai(format!(
                "the sign-in was refused ({error}{detail})"
            )));
        }
        let Some(code) = params.get("code").filter(|c| !c.is_empty()) else {
            let _ = stream
                .write_all(reply("400 Bad Request", FAILED_PAGE).as_bytes())
                .await;
            return Err(Error::Ai("the browser came back without a code".into()));
        };
        let _ = stream
            .write_all(reply("200 OK", DONE_PAGE).as_bytes())
            .await;
        let _ = stream.shutdown().await;
        return Ok(code.clone());
    }
}

/// Exchanges the code for tokens.
pub async fn exchange(client: &reqwest::Client, flow: &PendingFlow, code: &str) -> Result<Tokens> {
    let mut form = vec![
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", flow.redirect_uri.as_str()),
        ("client_id", flow.client_id.as_str()),
        ("code_verifier", flow.verifier.as_str()),
        ("resource", flow.resource.as_str()),
    ];
    if let Some(secret) = &flow.client_secret {
        form.push(("client_secret", secret.as_str()));
    }
    let v = token_request(client, &flow.token_endpoint, &form).await?;
    tokens_from(
        &v,
        &Tokens {
            access_token: String::new(),
            refresh_token: None,
            expires_at: None,
            token_endpoint: flow.token_endpoint.clone(),
            client_id: flow.client_id.clone(),
            client_secret: flow.client_secret.clone(),
            resource: flow.resource.clone(),
            server_url: flow.server_url.clone(),
            scope: flow.scope.clone(),
        },
    )
}

/// New tokens from the refresh token (`refused`: the server said no, sign in again).
async fn refresh_or_refused(
    client: &reqwest::Client,
    tokens: &Tokens,
) -> std::result::Result<Tokens, TokenFailure> {
    let refresh = tokens.refresh_token.as_deref().ok_or(TokenFailure {
        refused: true,
        error: Error::Ai("no refresh token".into()),
    })?;
    let mut form = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("client_id", tokens.client_id.as_str()),
        ("resource", tokens.resource.as_str()),
    ];
    if let Some(secret) = &tokens.client_secret {
        form.push(("client_secret", secret.as_str()));
    }
    let v = token_request(client, &tokens.token_endpoint, &form).await?;
    tokens_from(&v, tokens).map_err(|error| TokenFailure {
        refused: false,
        error,
    })
}

// ---- Storage ----------------------------------------------------------------------------

/// The secret id holding a server's tokens.
pub fn secret_id(server: &str) -> String {
    let prefix = crate::ai::secrets::mcp_prefix(server);
    // mcp.input.<name>:: → mcp.oauth.<name>
    format!(
        "mcp.oauth.{}",
        prefix
            .trim_start_matches("mcp.input.")
            .trim_end_matches("::")
    )
}

pub fn load(secrets: &Path, server: &str, server_url: &str) -> Option<Tokens> {
    let text = crate::ai::secrets::get(secrets, &secret_id(server))?;
    let tokens: Tokens = serde_json::from_str(&text).ok()?;
    // Tokens for another address (the config changed) aren't sent.
    (tokens.server_url == server_url).then_some(tokens)
}

pub fn save(secrets: &Path, server: &str, tokens: &Tokens) -> Result<()> {
    crate::ai::secrets::set(
        secrets,
        &secret_id(server),
        Some(&serde_json::to_string(tokens)?),
    )
}

pub fn clear(secrets: &Path, server: &str) -> Result<()> {
    crate::ai::secrets::set(secrets, &secret_id(server), None)
}

pub fn status(secrets: &Path, server: &str, server_url: &str) -> SignInStatus {
    match load(secrets, server, server_url) {
        Some(t) => SignInStatus {
            signed_in: true,
            expires_at: t.expires_at,
            can_refresh: t.refresh_token.is_some(),
            scope: t.scope,
        },
        None => SignInStatus {
            signed_in: false,
            expires_at: None,
            can_refresh: false,
            scope: None,
        },
    }
}

/// One refresh at a time (a rotated refresh token works once).
static REFRESHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The access token to send to a server: refreshed first when it expires within a minute (or
/// `force`, after a 401). None: not signed in, or the refresh failed (sign in again).
pub async fn access_token(
    client: &reqwest::Client,
    secrets: &Path,
    server: &str,
    server_url: &str,
    force: bool,
) -> Option<String> {
    let tokens = load(secrets, server, server_url)?;
    let stale = tokens.expires_at.is_some_and(|at| at <= now() + 60);
    if !force && !stale {
        return Some(tokens.access_token);
    }
    tokens.refresh_token.as_ref()?;
    let _guard = REFRESHING.lock().await;
    // Another request may have refreshed meanwhile.
    let current = load(secrets, server, server_url)?;
    if current.access_token != tokens.access_token {
        return Some(current.access_token);
    }
    match refresh_or_refused(client, &current).await {
        Ok(fresh) => {
            save(secrets, server, &fresh).ok()?;
            Some(fresh.access_token)
        }
        Err(f) => {
            // A refresh token the server refuses: sign in again. One that couldn't be tried
            // (offline, the server down) is kept for the next request.
            if f.refused {
                let _ = clear(secrets, server);
            }
            None
        }
    }
}

/// The last `WWW-Authenticate` header each server sent with a 401 (for discovery).
static CHALLENGES: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

pub fn note_challenge(server: &str, header: &str) {
    if let Ok(mut map) = CHALLENGES.lock() {
        map.get_or_insert_with(HashMap::new)
            .insert(server.to_string(), header.to_string());
    }
}

pub fn last_challenge(server: &str) -> Option<String> {
    CHALLENGES
        .lock()
        .ok()
        .and_then(|m| m.as_ref().and_then(|m| m.get(server).cloned()))
}

/// Sign-ins under way, by id (begin → finish).
#[derive(Default)]
pub struct Flows {
    pending: tokio::sync::Mutex<HashMap<String, PendingFlow>>,
}

impl Flows {
    pub async fn add(&self, flow: PendingFlow) -> Result<String> {
        let id = random_token(12)?;
        let mut all = self.pending.lock().await;
        // A server's older sign-in is replaced.
        all.retain(|_, f| f.server != flow.server);
        all.insert(id.clone(), flow);
        Ok(id)
    }

    pub async fn take(&self, id: &str) -> Option<PendingFlow> {
        self.pending.lock().await.remove(id)
    }
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;
