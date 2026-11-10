//! The IDE's own account (D140), ready for the backend: OAuth 2 authorization code with PKCE
//! through the system browser and a loopback redirect (RFC 8252, what desktop apps like VS Code
//! do without a custom URL scheme). Nothing here knows a server until `product.json` gets an
//! `accountsUrl`; the expected endpoints are in docs/accounts.md:
//!
//! - `GET  {base}/oauth/authorize` — the sign-in page; redirects to `http://127.0.0.1:<port>/callback?code&state`
//! - `POST {base}/oauth/token`     — code + verifier → `{access_token, refresh_token?, expires_in?}`
//! - `GET  {base}/api/me`          — bearer token → `{id, name, email?, avatarUrl?, plan?}`
//! - `POST {base}/oauth/revoke`    — optional, on sign-out
//!
//! The saved session, its tokens (in the OS keychain) and the profile check with refresh are in
//! `session.rs` (D414). The tokens never go to the webview; the frontend sees the profile only.

mod session;

pub use session::{check, profile, session_file, sign_out};

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener};
use std::path::Path;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

pub const CLIENT_ID: &str = "desktop";
/// Set by `cancel()`: the sign-in in progress stops waiting for the browser.
static CANCELLED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn cancel() {
    CANCELLED.store(true, std::sync::atomic::Ordering::SeqCst);
}
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
}

/// A sign-in under way: the browser URL to open and what the callback must match.
pub struct Pending {
    pub url: String,
    listener: TcpListener,
    state: String,
    verifier: String,
    redirect: String,
    base: String,
}

fn random_token(bytes: usize) -> Result<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| Error::Invalid(format!("no randomness: {e}")))?;
    Ok(base64url(&buf))
}

/// Unpadded base64url (RFC 4648 §5), for PKCE.
pub fn base64url(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        let chars = chunk.len() + 1;
        for i in 0..chars {
            out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
        }
    }
    out
}

/// The PKCE S256 challenge of `verifier`.
pub fn challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                char::from(b).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                        continue;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `code` and `state` from a callback request line (`GET /callback?code=…&state=… HTTP/1.1`).
pub fn parse_callback(
    request_line: &str,
) -> Option<(Option<String>, Option<String>, Option<String>)> {
    let target = request_line.split_whitespace().nth(1)?;
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if path != "/callback" {
        return None;
    }
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k {
            "code" => code = Some(decode(v)),
            "state" => state = Some(decode(v)),
            "error" => error = Some(decode(v)),
            _ => {}
        }
    }
    Some((code, state, error))
}

/// Starts a sign-in against `base`: a loopback listener and the authorize URL to open.
pub fn begin(base: &str) -> Result<Pending> {
    let base = base.trim_end_matches('/').to_string();
    if !(base.starts_with("https://")
        || base.starts_with("http://127.0.0.1")
        || base.starts_with("http://localhost"))
    {
        return Err(Error::Invalid("the accounts URL must be https".into()));
    }
    CANCELLED.store(false, std::sync::atomic::Ordering::SeqCst);
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let state = random_token(16)?;
    let verifier = random_token(32)?;
    let url = format!(
        "{base}/oauth/authorize?response_type=code&client_id={CLIENT_ID}&redirect_uri={}&code_challenge={}&code_challenge_method=S256&state={}",
        encode(&redirect),
        challenge(&verifier),
        state
    );
    Ok(Pending {
        url,
        listener,
        state,
        verifier,
        redirect,
        base,
    })
}

/// The page the browser shows after the callback. It is self-contained (no network, no
/// scripts), follows the system's dark or light theme, and matches the accounts website.
const CALLBACK_PAGE: &str = r##"<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>{title}</title>
<style>
:root{--bg:#08080a;--fg:#f5f5f6;--muted:#a3a3ad;--wash:#12141c;--ok:#4cc38a;--bad:#f27474}
@media (prefers-color-scheme:light){:root{--bg:#fbfbfa;--fg:#121214;--muted:#55555e;--wash:#edf0f7;--ok:#18794a;--bad:#be3333}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(180deg,var(--wash),var(--bg) 70%);color:var(--fg);font:16px/1.6 "Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,Inter,Ubuntu,"Noto Sans",sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:440px;padding-bottom:8vh;text-align:center}
.ok{--tone:var(--ok)}.bad{--tone:var(--bad)}
.mark{display:grid;place-items:center;width:64px;height:64px;margin:0 auto 28px;border:1px solid color-mix(in srgb,var(--tone) 35%,transparent);border-radius:50%;background:color-mix(in srgb,var(--tone) 14%,transparent);color:var(--tone)}
h1{margin:0;font-size:36px;font-weight:600;line-height:1.1;letter-spacing:-.035em}
p{margin:12px 0 0;color:var(--muted);font-size:17px}
</style>
<main class="{tone}">
<div class="mark"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="{icon}"/></svg></div>
<h1>{heading}</h1>
<p>{text}</p>
</main>
</html>"##;

fn callback_page(ok: bool) -> String {
    let (title, tone, icon, heading, text) = if ok {
        (
            "Signed in",
            "ok",
            "M5 12.5l4.5 4.5L19 7.5",
            "You're signed in",
            "You can close this tab and go back to the IDE.",
        )
    } else {
        (
            "Sign-in failed",
            "bad",
            "M7 7l10 10M17 7L7 17",
            "Sign-in didn't complete",
            "Go back to the IDE and try again.",
        )
    };
    CALLBACK_PAGE
        .replace("{title}", title)
        .replace("{tone}", tone)
        .replace("{icon}", icon)
        .replace("{heading}", heading)
        .replace("{text}", text)
}

/// Waits for the browser to come back with the code (up to five minutes); returns the code.
pub fn wait_for_code(p: &Pending) -> Result<String> {
    p.listener.set_nonblocking(true)?;
    let started = Instant::now();
    loop {
        if started.elapsed() > SIGN_IN_TIMEOUT {
            return Err(Error::Invalid("Sign-in timed out.".into()));
        }
        if CANCELLED.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Error::Invalid("Sign-in cancelled.".into()));
        }
        let (stream, _) = match p.listener.accept() {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let mut line = String::new();
        // A connection that sends nothing in time (a browser's preconnect) or no text isn't the
        // callback: skipped, as the MCP sign-in does, rather than failing the sign-in.
        if BufReader::new(std::io::Read::take(&stream, 8192))
            .read_line(&mut line)
            .is_err()
        {
            continue;
        }
        let Some((code, state, error)) = parse_callback(&line) else {
            // A favicon request or similar: not ours.
            let _ = (&stream).write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        };
        let ok = state.as_deref() == Some(p.state.as_str()) && code.is_some() && error.is_none();
        let page = callback_page(ok);
        let _ = (&stream).write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{page}",
                page.len()
            )
            .as_bytes(),
        );
        if let Some(e) = error {
            return Err(Error::Invalid(format!("Sign-in was refused: {e}")));
        }
        return match (ok, code) {
            (true, Some(code)) => Ok(code),
            _ => Err(Error::Invalid(
                "Sign-in answer didn't match (state).".into(),
            )),
        };
    }
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

/// Exchanges the code for a token, reads the profile and saves the session.
pub async fn finish(p: &Pending, code: &str, file: &Path) -> Result<Profile> {
    let client = reqwest::Client::new();
    let net = |e: reqwest::Error| Error::Invalid(format!("Couldn't reach the account server: {e}"));
    let token: TokenReply = client
        .post(format!("{}/oauth/token", p.base))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", p.redirect.as_str()),
            ("client_id", CLIENT_ID),
            ("code_verifier", p.verifier.as_str()),
        ])
        .send()
        .await
        .map_err(net)?
        .error_for_status()
        .map_err(net)?
        .json()
        .await
        .map_err(net)?;
    let profile: Profile = client
        .get(format!("{}/api/me", p.base))
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(net)?
        .error_for_status()
        .map_err(net)?
        .json()
        .await
        .map_err(net)?;
    session::store(
        file,
        session::vault(),
        &p.base,
        &profile,
        &session::Tokens {
            access: token.access_token,
            refresh: token.refresh_token,
        },
    )?;
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_the_rfc_example() {
        // RFC 7636 appendix B.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(base64url(b"f"), "Zg");
        assert_eq!(base64url(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn callback_lines_are_parsed() {
        let (code, state, error) =
            parse_callback("GET /callback?code=a%2Bb&state=xyz HTTP/1.1").unwrap();
        assert_eq!(code.as_deref(), Some("a+b"));
        assert_eq!(state.as_deref(), Some("xyz"));
        assert_eq!(error, None);
        assert!(parse_callback("GET /favicon.ico HTTP/1.1").is_none());
    }

    #[test]
    fn begin_refuses_plain_http_and_builds_the_url() {
        assert!(begin("http://example.com").is_err());
        let p = begin("https://accounts.example.com/").unwrap();
        assert!(p
            .url
            .starts_with("https://accounts.example.com/oauth/authorize?"));
        assert!(p.url.contains("code_challenge_method=S256"));
        assert!(p.url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A"));
    }

    #[test]
    fn a_full_loopback_round_trip_returns_the_code() {
        let p = begin("http://127.0.0.1:9").unwrap();
        let port = p.listener.local_addr().unwrap().port();
        let state = p.state.clone();
        let browser = std::thread::spawn(move || {
            let mut s = std::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            s.write_all(
                format!("GET /callback?code=c0de&state={state} HTTP/1.1\r\n\r\n").as_bytes(),
            )
            .unwrap();
            let mut reply = String::new();
            let _ = std::io::Read::read_to_string(&mut s, &mut reply);
            reply
        });
        assert_eq!(wait_for_code(&p).unwrap(), "c0de");
        assert!(browser.join().unwrap().contains("You're signed in"));
    }
}
