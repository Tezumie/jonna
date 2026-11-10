//! Third-party extensions (crate::extensions, D102): list, install from a folder, uninstall,
//! read their files, per-extension storage, network requests on their behalf (the frontend has
//! checked the extension's network permission), and a static server for webview panels.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::State;

use crate::browser::{self, ProxyInfo};
use crate::error::{Error, Result};
use crate::extensions::ExtEntry;
use crate::store::atomic_write;
use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtList {
    entries: Vec<ExtEntry>,
    /// registry.json as written by the frontend ("{}" when missing).
    registry: String,
}

#[tauri::command]
pub async fn ext_list(state: State<'_, AppState>) -> Result<ExtList> {
    if let Err(e) = state.extensions.seed_bundled() {
        eprintln!("bundled extensions: {e}");
    }
    Ok(ExtList {
        entries: state.extensions.list(),
        registry: state.extensions.registry_text(),
    })
}

/// The manifest of a folder the user picked (before installing or loading it).
#[tauri::command]
pub async fn ext_peek(folder: String) -> Result<ExtEntry> {
    crate::extensions::peek(std::path::Path::new(&folder))
}

#[tauri::command]
pub async fn ext_registry_save(state: State<'_, AppState>, json: String) -> Result<()> {
    state.extensions.save_registry(&json)
}

/// A file of an extension (raw bytes).
#[tauri::command]
pub async fn ext_read(state: State<'_, AppState>, root: String, path: String) -> Result<Response> {
    Ok(Response::new(state.extensions.read(&root, &path)?))
}

/// The files of an extension folder (for its page's Files tab).
#[tauri::command]
pub async fn ext_files(
    state: State<'_, AppState>,
    root: String,
) -> Result<Vec<crate::extensions::ExtFile>> {
    state.extensions.files(&root)
}

/// Copies the extension folder `source` into the installed extensions as `id`.
#[tauri::command]
pub async fn ext_install(state: State<'_, AppState>, source: String, id: String) -> Result<String> {
    state.extensions.install(std::path::Path::new(&source), &id)
}

/// Deletes an unpacked extension's folder (after the user confirmed).
#[tauri::command]
pub async fn ext_delete_unpacked(state: State<'_, AppState>, root: String) -> Result<()> {
    state.extensions.delete_unpacked(&root)
}

#[derive(Serialize)]
pub struct Download {
    folder: String,
    /// The extension folders in it, relative ("" for the top).
    extensions: Vec<String>,
}

/// A shallow copy of a git repository's files in a scratch folder (D185) and the extensions in
/// it: the frontend installs one, then discards the folder.
#[tauri::command]
pub async fn ext_download_git(
    state: State<'_, AppState>,
    url: String,
    reference: Option<String>,
) -> Result<Download> {
    let store = state.extensions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .download_git(&url, reference.as_deref())
            .map(|p| Download {
                extensions: crate::extensions::download::find_manifests(&p),
                folder: p.to_string_lossy().into_owned(),
            })
    })
    .await
    .map_err(|e| Error::Invalid(e.to_string()))?
}

/// A `.vsix` file unpacked into a scratch folder, and the extension folders in it (`extension`
/// in a VS Code package); installed and discarded like a download.
#[tauri::command]
pub async fn ext_unpack_vsix(state: State<'_, AppState>, file: String) -> Result<Download> {
    let store = state.extensions.clone();
    tauri::async_runtime::spawn_blocking(move || {
        store
            .unpack_vsix(std::path::Path::new(&file))
            .map(|p| Download {
                extensions: crate::extensions::download::find_manifests(&p),
                folder: p.to_string_lossy().into_owned(),
            })
    })
    .await
    .map_err(|e| Error::Invalid(e.to_string()))?
}

/// The Node extension host's script (D255): the frontend's bundled copy written to the data
/// folder (Node runs files, not the app's assets), once per version (its SHA-256 names it); its
/// path.
#[tauri::command]
pub async fn ext_node_host_script(state: State<'_, AppState>, text: String) -> Result<String> {
    use sha2::{Digest, Sha256};
    if text.is_empty() || text.len() > 8 * 1024 * 1024 {
        return Err(Error::Invalid("not a host script".into()));
    }
    let digest: String = Sha256::digest(text.as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect();
    let dir = state.dirs.data.join("extension-host");
    std::fs::create_dir_all(&dir)?;
    let name = format!("node-host-{digest}.cjs");
    let file = dir.join(&name);
    if !file.exists() {
        crate::store::atomic_write(&file, text.as_bytes())?;
        // Earlier versions' copies (D261: one was left behind per update), once a week old
        // (D285): another version may still be running beside this one (an update installed while
        // a window stayed open, a dev build), and its next Node start reads its copy. It also
        // asks for it before each start, so a copy removed anyway is written again.
        const STALE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let other = entry.file_name().to_string_lossy().into_owned();
                let old = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .is_some_and(|age| age > STALE);
                if old
                    && other != name
                    && other.starts_with("node-host-")
                    && other.ends_with(".cjs")
                {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
    Ok(file.to_string_lossy().into_owned())
}

/// Open VSX's search (D254): its JSON as is.
#[tauri::command]
pub async fn ext_store_search(
    query: String,
    category: Option<String>,
    offset: Option<u32>,
    size: Option<u32>,
    sort_by: Option<String>,
) -> Result<String> {
    crate::extensions::store::search(
        &query,
        category.as_deref(),
        offset.unwrap_or(0),
        size.unwrap_or(20),
        sort_by.as_deref(),
    )
    .await
}

/// An extension's details on Open VSX (the latest version without `version`): its JSON.
#[tauri::command]
pub async fn ext_store_details(
    namespace: String,
    name: String,
    version: Option<String>,
) -> Result<String> {
    crate::extensions::store::details(&namespace, &name, version.as_deref()).await
}

/// A file of an extension on Open VSX as bytes: `kind` "icon" (512 KB), "image" (a README's
/// picture, 5 MB) or "text" (README, changelog, package.json; 2 MB). Open VSX's hosts only.
#[tauri::command]
pub async fn ext_store_file(url: String, kind: String) -> Result<Response> {
    use crate::extensions::store::{file, FileKind};
    Ok(Response::new(file(&url, FileKind::parse(&kind)?).await?))
}

/// Downloads an extension's `.vsix` from Open VSX, checked against its SHA-256: the file (in the
/// downloads folder, for `ext_unpack_vsix`, then `ext_discard_download`) and its version.
#[tauri::command]
pub async fn ext_store_download(
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    version: Option<String>,
) -> Result<StoreDownload> {
    let (file, version) = state
        .extensions
        .download_from_store(&namespace, &name, version.as_deref())
        .await?;
    Ok(StoreDownload {
        file: file.to_string_lossy().into_owned(),
        version,
    })
}

#[derive(serde::Serialize)]
pub struct StoreDownload {
    file: String,
    version: String,
}

#[tauri::command]
pub async fn ext_discard_download(state: State<'_, AppState>, folder: String) -> Result<()> {
    state.extensions.discard_download(&folder)
}

/// A GitHub user's picture for an extension's authors (D185): 64 px, cached for a week (an old
/// copy is used when GitHub can't be reached).
#[tauri::command]
pub async fn ext_github_avatar(state: State<'_, AppState>, login: String) -> Result<Response> {
    use crate::extensions::download::{AVATAR_MAX_AGE, AVATAR_MAX_BYTES};
    let path = state.extensions.avatar_path(&login)?;
    let cached = std::fs::read(&path).ok();
    let fresh = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < AVATAR_MAX_AGE);
    if let (Some(bytes), true) = (&cached, fresh) {
        return Ok(Response::new(bytes.clone()));
    }
    let fetched = async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let response = client
            .get(format!("https://github.com/{login}.png?size=64"))
            .send()
            .await
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let is_image = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.starts_with("image/"));
        if !response.status().is_success() || !is_image {
            return Err(Error::Invalid(format!("no picture for {login}")));
        }
        let mut bytes: Vec<u8> = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| Error::Invalid(e.to_string()))?;
            if bytes.len() + chunk.len() > AVATAR_MAX_BYTES {
                return Err(Error::Invalid("the picture is too large".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    .await;
    match (fetched, cached) {
        (Ok(bytes), _) => {
            let _ = atomic_write(&path, &bytes);
            Ok(Response::new(bytes))
        }
        (Err(_), Some(old)) => Ok(Response::new(old)),
        (Err(e), None) => Err(e),
    }
}

/// One bundled extension's own files back, replacing the user's changed copy (D189).
#[tauri::command]
pub async fn ext_reinstall_bundled(state: State<'_, AppState>, id: String) -> Result<()> {
    state.extensions.reinstall_bundled(&id)
}

/// Brings back bundled extensions the user uninstalled (D183); their ids.
#[tauri::command]
pub async fn ext_restore_bundled(state: State<'_, AppState>) -> Result<Vec<String>> {
    state.extensions.restore_bundled()
}

#[tauri::command]
pub async fn ext_uninstall(state: State<'_, AppState>, id: String) -> Result<()> {
    state.extensions.uninstall(&id)
}

/// The extension's storage (a JSON object), "{}" when empty.
#[tauri::command]
pub async fn ext_storage_load(state: State<'_, AppState>, id: String) -> Result<String> {
    let path = state.extensions.storage_path(&id)?;
    Ok(std::fs::read_to_string(path).unwrap_or_else(|_| "{}".into()))
}

#[tauri::command]
pub async fn ext_storage_save(state: State<'_, AppState>, id: String, json: String) -> Result<()> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| Error::Invalid(e.to_string()))?;
    if json.len() > 5 * 1024 * 1024 {
        return Err(Error::Invalid(
            "extension storage is limited to 5 MB".into(),
        ));
    }
    atomic_write(&state.extensions.storage_path(&id)?, json.as_bytes())
}

/// The secret id of extension `id`'s `key` (D233: `ide.secrets`, its authentication sessions):
/// `ext.<id>::<key>`. Built here, so an extension can only reach its own secrets, never a model
/// provider's key or an MCP server's token.
pub fn ext_secret_id(id: &str, key: &str) -> Result<String> {
    crate::extensions::check_id(id)?;
    if key.is_empty() || key.len() > 200 || key.chars().any(|c| c.is_control()) {
        return Err(Error::Invalid(
            "a secret's key is 1-200 characters, without control characters".into(),
        ));
    }
    Ok(format!("ext.{id}::{key}"))
}

/// An extension's own secret. Unlike the IDE's keys, it goes back to the page: it is the
/// extension's data, and its worker runs there (the host passes only its own id).
#[tauri::command]
pub async fn ext_secret_get(
    state: State<'_, AppState>,
    id: String,
    key: String,
) -> Result<Option<String>> {
    let secret = ext_secret_id(&id, &key)?;
    Ok(crate::ai::secrets::get(
        &state.dirs.data.join("secrets.json"),
        &secret,
    ))
}

/// Stores (or with `null`, removes) an extension's own secret.
#[tauri::command]
pub async fn ext_secret_set(
    state: State<'_, AppState>,
    id: String,
    key: String,
    value: Option<String>,
) -> Result<()> {
    let secret = ext_secret_id(&id, &key)?;
    if value.as_ref().is_some_and(|v| v.len() > 64 * 1024) {
        return Err(Error::Invalid("a secret is limited to 64 KB".into()));
    }
    crate::ai::secrets::set(
        &state.dirs.data.join("secrets.json"),
        &secret,
        value.as_deref(),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    url: String,
    method: Option<String>,
    headers: Option<Vec<(String, String)>>,
    body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

const MAX_BODY: usize = 10 * 1024 * 1024;

/// An http(s) request for an extension (`ide.net.fetch`): text body, at most 10 MB.
#[tauri::command]
pub async fn ext_fetch(request: FetchRequest) -> Result<FetchResponse> {
    let url = reqwest::Url::parse(&request.url).map_err(|e| Error::Invalid(e.to_string()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Error::Invalid("only http and https requests".into()));
    }
    let method = reqwest::Method::from_bytes(request.method.as_deref().unwrap_or("GET").as_bytes())
        .map_err(|e| Error::Invalid(e.to_string()))?;
    // Redirects aren't followed here: the IDE checks each new address against the extension's
    // network permission before asking again (a redirect to 127.0.0.1 or a LAN host would
    // otherwise be read with a permission for one public domain; D203 audit).
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    let mut builder = client.request(method, url);
    for (k, v) in request.headers.unwrap_or_default() {
        builder = builder.header(k, v);
    }
    if let Some(body) = request.body {
        builder = builder.body(body);
    }
    let response = builder
        .send()
        .await
        .map_err(|e| Error::Invalid(e.to_string()))?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    // Enforce the cap while receiving: `bytes()` would buffer a response of any size first.
    let too_large = || Error::Invalid("the response is larger than 10 MB".into());
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BODY as u64)
    {
        return Err(too_large());
    }
    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| Error::Invalid(e.to_string()))?;
        if bytes.len() + chunk.len() > MAX_BODY {
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(FetchResponse {
        status,
        headers,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// Serves an extension's folder for its webview panels (a separate origin from the IDE).
#[tauri::command]
pub async fn ext_webview_proxy(
    state: State<'_, AppState>,
    root: String,
    embed: Option<bool>,
) -> Result<ProxyInfo> {
    let dir = state.extensions.root(&root)?;
    state
        .browser
        .proxy(browser::webview_target(dir, embed.unwrap_or(false)))
        .await
}

/// Folders an extension's webview pages may read files from besides its own (VS Code's
/// localResourceRoots, served at `/__fs/<absolute path>` on the folder's origin): each must be
/// inside the open workspace (fs scope) or the extension's own folder; others are left out.
/// Replaces the extension's list; returns the folders kept.
#[tauri::command]
pub async fn ext_webview_roots(
    state: State<'_, AppState>,
    root: String,
    roots: Vec<String>,
) -> Result<Vec<String>> {
    let dir = state.extensions.root(&root)?;
    let own = std::fs::canonicalize(&dir)?;
    let mut kept: Vec<std::path::PathBuf> = Vec::new();
    for path in roots.iter().take(50) {
        // Inside the workspace (the fs scope's own check), or the extension's folder.
        let inside = state
            .workspace
            .resolve(path)
            .ok()
            .and_then(|p| std::fs::canonicalize(p).ok());
        let canonical = match inside {
            Some(p) => p,
            // An extension's network path isn't looked at (Windows would connect and offer the
            // user's credentials, D161); its own folder on a share still is.
            None if crate::fs::is_unc(path) && !crate::fs::is_unc(&own.to_string_lossy()) => {
                continue
            }
            None => match std::fs::canonicalize(path) {
                Ok(p) if p.starts_with(&own) => p,
                _ => continue,
            },
        };
        if canonical.is_dir() && !kept.contains(&canonical) {
            kept.push(canonical);
        }
    }
    let shown = kept
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let mut all = state
        .browser
        .shared
        .webview_roots
        .lock()
        .map_err(|_| Error::Invalid("lock poisoned".into()))?;
    if kept.is_empty() {
        all.remove(&dir);
    } else {
        all.insert(dir, kept);
    }
    Ok(shown)
}

/// The page of a webview panel an extension made at run time (`ide.ui.createWebviewPanel`, its
/// `webview.html`): served on the extension folder's origin at `/__webview-<name>.html`, with
/// the same CSP as its files. `html: null` removes it (the panel closed).
#[tauri::command]
pub async fn ext_webview_page(
    state: State<'_, AppState>,
    root: String,
    name: String,
    html: Option<String>,
) -> Result<()> {
    let dir = state.extensions.root(&root)?;
    if !browser::proxy::is_webview_page_name(&name) {
        return Err(Error::Invalid(
            "a panel page name is 1-64 letters, digits, - or _".into(),
        ));
    }
    if html.as_ref().is_some_and(|h| h.len() > 8 * 1024 * 1024) {
        return Err(Error::Invalid("a panel's HTML is limited to 8 MB".into()));
    }
    let mut pages = state
        .browser
        .shared
        .webview_pages
        .lock()
        .map_err(|_| Error::Invalid("lock poisoned".into()))?;
    match html {
        Some(text) => {
            // At most 200 pages per folder: a panel that never closes its old pages can't grow it.
            let count = pages.keys().filter(|(d, _)| *d == dir).count();
            if count >= 200 && !pages.contains_key(&(dir.clone(), name.clone())) {
                return Err(Error::Invalid("too many webview panels".into()));
            }
            pages.insert((dir, name), text.into_bytes());
        }
        None => {
            pages.remove(&(dir, name));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::ext_secret_id;

    #[test]
    fn extension_secrets_stay_under_their_own_prefix() {
        assert_eq!(
            ext_secret_id("acme.auth", "session").ok().as_deref(),
            Some("ext.acme.auth::session")
        );
        // Another id can't be named through the key, nor an invalid extension id used.
        assert!(ext_secret_id("acme.auth", "").is_err());
        assert!(ext_secret_id("acme.auth", "a\nb").is_err());
        assert!(ext_secret_id("../openai", "x").is_err());
        assert!(ext_secret_id("", "x").is_err());
    }
}

/// The pinned Node.js for extensions' code (D267): the downloaded program, if any.
#[tauri::command]
pub fn ext_node_status(state: State<'_, AppState>) -> crate::node_runtime::Status {
    crate::node_runtime::status(&state.dirs.data)
}

/// Downloads the pinned Node.js (checked against its SHA-256); the program's path.
#[tauri::command]
pub async fn ext_node_install(
    state: State<'_, AppState>,
    on_progress: tauri::ipc::Channel<crate::acp_agents::Progress>,
) -> Result<String> {
    crate::node_runtime::install(&state.dirs.data, move |p| {
        let _ = on_progress.send(p);
    })
    .await
}
