//! Updates (D192): a release build made with an update endpoint and its public key in
//! product.json checks the endpoint (a `latest.json` the release workflow publishes), and with
//! the user's go-ahead downloads the signed installer, verifies its signature, installs it and
//! restarts. Builds without an endpoint (development, forks) have no updates and never connect.

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Runtime};
use tauri_plugin_updater::UpdaterExt;

use crate::error::{Error, Result};

/// The beta channel's `latest.json` (D204): the release workflow's `IDE_UPDATE_BETA_ENDPOINT` at
/// build time, else product.json `updates.betaEndpoint`. Empty: no beta channel (stable is used).
fn beta_endpoint() -> Option<String> {
    let built = option_env!("IDE_UPDATE_BETA_ENDPOINT").unwrap_or("").trim();
    if !built.is_empty() {
        return Some(built.to_string());
    }
    serde_json::from_str::<serde_json::Value>(include_str!("../../../product.json"))
        .ok()?
        .get("updates")?
        .get("betaEndpoint")?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The updater for `channel` ("stable" or "beta"), and the channel it really uses: beta needs an
/// endpoint; without one it's stable.
fn updater_for<R: Runtime>(
    app: &AppHandle<R>,
    channel: Option<&str>,
) -> Result<(tauri_plugin_updater::Updater, &'static str)> {
    if channel == Some("beta") {
        if let Some(url) = beta_endpoint() {
            let url = tauri::Url::parse(&url).map_err(err)?;
            let updater = app
                .updater_builder()
                .endpoints(vec![url])
                .map_err(err)?
                .build()
                .map_err(err)?;
            return Ok((updater, "beta"));
        }
    }
    Ok((app.updater().map_err(err)?, "stable"))
}

/// Whether this build was made with an update endpoint (the generated config has the plugin).
pub fn configured<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .is_some_and(|k| !k.trim().is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// False for a build without updates (nothing was checked).
    pub configured: bool,
    pub current: String,
    /// The newer version, when there is one.
    pub available: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    /// The channel checked: "stable", or "beta" when asked for and this build has a beta endpoint.
    pub channel: &'static str,
    /// Whether this build has a beta channel.
    pub beta_available: bool,
}

fn err(e: impl std::fmt::Display) -> Error {
    Error::Invalid(e.to_string())
}

#[tauri::command]
pub async fn update_check<R: Runtime>(
    app: AppHandle<R>,
    channel: Option<String>,
) -> Result<UpdateInfo> {
    let current = app.package_info().version.to_string();
    let beta_available = beta_endpoint().is_some();
    if !configured(&app) {
        return Ok(UpdateInfo {
            configured: false,
            current,
            available: None,
            notes: None,
            date: None,
            channel: "stable",
            beta_available,
        });
    }
    let (updater, used) = updater_for(&app, channel.as_deref())?;
    let update = updater.check().await.map_err(err)?;
    Ok(UpdateInfo {
        configured: true,
        current,
        available: update.as_ref().map(|u| u.version.clone()),
        notes: update.as_ref().and_then(|u| u.body.clone()),
        date: update.as_ref().and_then(|u| u.date.map(|d| d.to_string())),
        channel: used,
        beta_available,
    })
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum UpdateProgress {
    Started { total: Option<u64> },
    Progress { downloaded: u64 },
    Installing,
}

/// Downloads, verifies (the signature against the build's public key) and installs the update,
/// then restarts. On Windows the installer closes the app itself.
#[tauri::command]
pub async fn update_install<R: Runtime>(
    app: AppHandle<R>,
    channel: Option<String>,
    on_progress: Channel<UpdateProgress>,
) -> Result<()> {
    if !configured(&app) {
        return Err(Error::Invalid("This build has no updates.".into()));
    }
    let (updater, _) = updater_for(&app, channel.as_deref())?;
    let Some(update) = updater.check().await.map_err(err)? else {
        return Err(Error::Invalid("There's no newer version.".into()));
    };
    let mut downloaded: u64 = 0;
    let mut started = false;
    let progress = on_progress.clone();
    update
        .download_and_install(
            move |chunk, total| {
                if !started {
                    started = true;
                    let _ = progress.send(UpdateProgress::Started { total });
                }
                downloaded += chunk as u64;
                let _ = progress.send(UpdateProgress::Progress { downloaded });
            },
            move || {
                let _ = on_progress.send(UpdateProgress::Installing);
            },
        )
        .await
        .map_err(err)?;
    app.restart();
}
