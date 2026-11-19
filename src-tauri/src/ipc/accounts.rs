//! The IDE's own account (src-tauri/src/accounts, D140). `base` is product.json's `accountsUrl`.

use tauri::ipc::Channel;
use tauri::State;

use crate::accounts::{self, Profile};
use crate::error::{Error, Result};
use crate::AppState;

/// The signed-in profile for `base`, or null.
#[tauri::command]
pub async fn account_profile(state: State<'_, AppState>, base: String) -> Result<Option<Profile>> {
    Ok(
        accounts::profile(&accounts::session_file(&state.dirs.data), &base)
            .map(Profile::with_defaults),
    )
}

/// The profile as the server has it now (D414): re-read, with the tokens refreshed when they've
/// run out; null when the server ended the session; the saved one when it can't be reached.
#[tauri::command]
pub async fn account_check(state: State<'_, AppState>, base: String) -> Result<Option<Profile>> {
    Ok(
        accounts::check(&accounts::session_file(&state.dirs.data), &base)
            .await?
            .map(Profile::with_defaults),
    )
}

/// Signs in through the browser: `on_url` gets the page to open; resolves with the profile.
#[tauri::command]
pub async fn account_sign_in(
    state: State<'_, AppState>,
    base: String,
    on_url: Channel<String>,
) -> Result<Profile> {
    let pending = accounts::begin(&base)?;
    on_url
        .send(pending.url.clone())
        .map_err(|e| Error::Invalid(e.to_string()))?;
    let (pending, code) = tauri::async_runtime::spawn_blocking(move || {
        let code = accounts::wait_for_code(&pending);
        (pending, code)
    })
    .await
    .map_err(|e| Error::Invalid(e.to_string()))?;
    Ok(
        accounts::finish(&pending, &code?, &accounts::session_file(&state.dirs.data))
            .await?
            .with_defaults(),
    )
}

/// Signs in with a code the front end received (a page in a browser, D467): resolves with
/// the profile.
#[tauri::command]
pub async fn account_sign_in_code(
    state: State<'_, AppState>,
    base: String,
    code: String,
    verifier: String,
    redirect: String,
) -> Result<Profile> {
    Ok(accounts::finish_with_code(
        &base,
        &code,
        &verifier,
        &redirect,
        &accounts::session_file(&state.dirs.data),
    )
    .await?
    .with_defaults())
}

/// Stops waiting for a browser sign-in.
#[tauri::command]
pub async fn account_cancel() -> Result<()> {
    accounts::cancel();
    Ok(())
}

#[tauri::command]
pub async fn account_sign_out(state: State<'_, AppState>) -> Result<()> {
    accounts::sign_out(&accounts::session_file(&state.dirs.data)).await
}

/// The most a picture is read.
const AVATAR_CAP: usize = 2 * 1024 * 1024;

/// Whether a picture may be fetched from `url`: https on GitHub's two hosts or under the
/// accounts server (`base`); plain http only for this computer's own address.
fn avatar_url_allowed(url: &str, base: &str) -> bool {
    let allowed = url.starts_with("https://github.com/")
        || url.starts_with("https://avatars.githubusercontent.com/")
        || (!base.is_empty() && url.starts_with(&format!("{}/", base.trim_end_matches('/'))));
    allowed && (url.starts_with("https://") || url.starts_with("http://127.0.0.1"))
}

/// The client a picture is fetched with: a redirect is followed only to an address a picture
/// may come from (GitHub's profile picture answers with one to its picture host), a few times
/// at most. Anything else is handed back as the redirect it is.
fn avatar_client(base: &str) -> Option<reqwest::Client> {
    let base = base.to_string();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() <= 3 && avatar_url_allowed(attempt.url().as_str(), &base) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .ok()
}

/// A signed-in account's picture (the Accounts icon, like VS Code's): fetched once a day into
/// `<data>/avatars/`, then served from there (also offline). Only https URLs on known hosts
/// (GitHub, or the IDE's accounts server); at most 2 MB.
#[tauri::command]
pub async fn account_avatar(
    state: State<'_, AppState>,
    url: String,
    base: String,
) -> Result<tauri::ipc::Response> {
    if !avatar_url_allowed(&url, &base) {
        return Err(Error::Invalid(format!("not an avatar URL: {url}")));
    }
    let dir = state.dirs.data.join("avatars");
    let file = dir.join(format!("{}.img", crate::history::hash(url.as_bytes())));
    let fresh = std::fs::metadata(&file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age.as_secs() < 86_400);
    if !fresh {
        let fetched = async {
            let reply = avatar_client(&base)?
                .get(&url)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await
                .ok()?;
            // A redirect that wasn't followed (to somewhere else) is no picture.
            if !reply.status().is_success() {
                return None;
            }
            accounts::http::read_capped(reply, AVATAR_CAP).await.ok()
        }
        .await;
        if let Some(bytes) = fetched {
            std::fs::create_dir_all(&dir)?;
            crate::store::atomic_write(&file, &bytes)?;
        }
    }
    // A stale copy beats none when offline.
    Ok(tauri::ipc::Response::new(std::fs::read(&file)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn a_picture_comes_only_from_known_places() {
        let base = "https://accounts.example.test/";
        for ok in [
            "https://github.com/someone.png",
            "https://avatars.githubusercontent.com/u/1?v=4",
            "https://accounts.example.test/avatars/1.png",
        ] {
            assert!(avatar_url_allowed(ok, base), "{ok}");
        }
        assert!(avatar_url_allowed(
            "http://127.0.0.1:5000/a.png",
            "http://127.0.0.1:5000"
        ));
        for bad in [
            "https://github.com.example.test/x.png",
            "https://accounts.example.test.evil.test/x.png",
            "https://elsewhere.test/x.png",
            "http://github.com/someone.png",
            "http://169.254.169.254/latest/meta-data",
            "http://127.0.0.1:5001/a.png",
            "file:///etc/passwd",
        ] {
            assert!(!avatar_url_allowed(bad, base), "{bad}");
            assert!(!avatar_url_allowed(bad, "http://127.0.0.1:5000"), "{bad}");
        }
        // Without an accounts server nothing but GitHub's hosts.
        assert!(!avatar_url_allowed("https://x.test/a.png", ""));
        assert!(!avatar_url_allowed("/a.png", ""));
    }

    #[test]
    fn a_pictures_redirect_to_somewhere_else_is_not_followed() {
        // Where the redirect points (this computer, another port: not under `base`).
        let elsewhere = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        elsewhere.set_nonblocking(true).unwrap();
        let target = elsewhere.local_addr().unwrap().port();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer);
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target}/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                );
            }
        });
        let base = format!("http://127.0.0.1:{port}");
        let reply = tauri::async_runtime::block_on(
            avatar_client(&base)
                .unwrap()
                .get(format!("{base}/a.png"))
                .send(),
        )
        .unwrap();
        assert_eq!(reply.status().as_u16(), 302);
        assert!(
            elsewhere.accept().is_err(),
            "the redirect's target was asked"
        );
    }
}
