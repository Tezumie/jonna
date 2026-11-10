//! Remote development commands (D252, `crate::remote`): connecting this window to a remote,
//! the remote folder picker, the connection's log, `~/.ssh/config` hosts and forwarded ports.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::error::{Error, Result};
use crate::fs::DirEntry;
use crate::remote::{self, RemoteEvent, RemoteInfo};

/// Runs docker (`tool` "docker") or the devcontainers CLI ("devcontainer") with `args` for a dev
/// container (D266); each output line on `on_output`, the exit code and stdout returned.
#[tauri::command]
pub async fn remote_docker(
    tool: String,
    args: Vec<String>,
    cwd: Option<String>,
    on_output: Channel<String>,
) -> Result<remote::docker::DockerRun> {
    tauri::async_runtime::spawn_blocking(move || {
        remote::docker::run(&tool, &args, cwd.as_deref(), &on_output)
    })
    .await
    .map_err(|e| Error::Exec(e.to_string()))?
}

/// The docker program for dev containers (`remote.containers.dockerPath`; None: `docker`).
#[tauri::command]
pub fn remote_set_docker(path: Option<String>) {
    remote::docker::set_program(path);
}

/// Connects this window to `authority` (`ssh:<host>` / `wsl:<distro>`): starts the transport,
/// installs the server there when needed (progress and ssh's prompts on `on_event`, which also
/// says when the connection is lost later), and returns what the remote is. Called again with
/// the same authority, it reconnects.
#[tauri::command]
pub async fn remote_connect(
    app: tauri::AppHandle,
    authority: String,
    on_event: Channel<RemoteEvent>,
) -> Result<RemoteInfo> {
    remote::connect(app, &authority, on_event).await
}

/// The answer to ssh's prompt `id` (null: cancelled). Never stored or logged.
#[tauri::command]
pub fn remote_askpass_answer(id: u64, answer: Option<String>) {
    crate::git::askpass::reply(id, answer);
}

/// Closes the connection; the window is local again (its folder must be closed first).
#[tauri::command]
pub async fn remote_disconnect() -> Result<()> {
    tauri::async_runtime::spawn_blocking(remote::disconnect)
        .await
        .map_err(|e| Error::Exec(e.to_string()))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub authority: String,
    pub label: String,
    pub connected: bool,
    pub info: Option<RemoteInfo>,
}

/// The window's remote and whether it's connected; null for a local window.
#[tauri::command]
pub async fn remote_status() -> Result<Option<RemoteStatus>> {
    Ok(remote::active().map(|r| RemoteStatus {
        authority: r.authority.as_string(),
        label: r.authority.label(),
        connected: r.is_connected(),
        info: r.info(),
    }))
}

/// A folder's entries anywhere on the remote (the folder picker; `~` is the home folder).
#[tauri::command]
pub async fn remote_browse(path: String) -> Result<Vec<DirEntry>> {
    remote::fs::browse(&path).await
}

/// What ssh and the server reported for this window's connection (never a prompt's answer).
#[tauri::command]
pub async fn remote_log() -> Result<String> {
    Ok(remote::active().map(|r| r.log.text()).unwrap_or_default())
}

/// The hosts in `~/.ssh/config` (named ones, no wildcards).
#[tauri::command]
pub async fn remote_hosts() -> Result<Vec<remote::transport::ConfigHost>> {
    tauri::async_runtime::spawn_blocking(remote::transport::config_hosts)
        .await
        .map_err(|e| Error::Exec(e.to_string()))
}

/// Forwards the remote's `port` to 127.0.0.1 here; returns the local port (the same number when
/// it was free).
#[tauri::command]
pub async fn remote_forward_port(port: u16) -> Result<u16> {
    let r = remote::active()
        .ok_or_else(|| Error::Exec("This window isn't connected to a remote.".into()))?;
    r.conn()?;
    let conn: remote::ports::ConnFn = std::sync::Arc::new(remote::conn);
    tauri::async_runtime::spawn_blocking(move || r.ports.forward(port, conn))
        .await
        .map_err(|e| Error::Exec(e.to_string()))?
}

#[tauri::command]
pub async fn remote_unforward(port: u16) -> Result<()> {
    if let Some(r) = remote::active() {
        r.ports.unforward(port);
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_forwarded() -> Result<Vec<remote::ports::Forwarded>> {
    Ok(remote::active().map(|r| r.ports.list()).unwrap_or_default())
}

/// The ports listening on the remote (`tcp.listening`): `{ port, host?, pid?, process? }`.
#[tauri::command]
pub async fn remote_listening() -> Result<Vec<Value>> {
    let v = remote::call("tcp.listening", json!({})).await?;
    Ok(v.as_array().cloned().unwrap_or_default())
}
