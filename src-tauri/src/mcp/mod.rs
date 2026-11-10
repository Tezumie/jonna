//! MCP server (Model Context Protocol, `rmcp`, Streamable HTTP) so external agents such as Claude
//! Code can drive the IDE. Off by default; when started it listens on 127.0.0.1 on a random port
//! and requires the per-session token as `Authorization: Bearer <token>`.
//!
//! Tools are dispatcher commands (`agent: "core"` listed directly; `discoverable` ones through
//! `ide_find_commands` / `ide_run_command`), resources are `ide://` state paths. Both live in the
//! frontend, so the catalog is pushed here (`mcp_set_catalog`) and every call is forwarded to the
//! webview over a Channel (`bridge.rs`) and answered with `mcp_respond`; the frontend runs it as
//! caller `{ kind: "mcp", client }` under the permission policy.

mod bridge;
mod handler;
mod http;
pub mod ide_ws;
pub mod oauth;
pub mod remote;
pub mod stdio_proxy;
pub mod stream;

use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
pub use bridge::{Bridge, BridgeRequest};

/// One command offered as a tool.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSpec {
    /// Command id, e.g. "editor.openFile" (the MCP tool name is derived: dots → underscores).
    pub command: String,
    pub title: String,
    pub description: String,
    /// JSON Schema of the input (an object schema).
    pub input_schema: serde_json::Value,
    /// "core" tools are listed; "discoverable" ones are found with `ide_find_commands`.
    pub core: bool,
    pub read_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResourceSpec {
    pub uri: String,
    pub description: String,
}

#[derive(Debug, Default)]
pub struct Catalog {
    pub tools: Vec<ToolSpec>,
    pub resources: Vec<ResourceSpec>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    pub url: String,
    pub port: u16,
    pub token: String,
}

struct Running {
    info: McpInfo,
    cancel: CancellationToken,
    info_file: std::path::PathBuf,
}

fn write_info_file(path: &std::path::Path, info: &McpInfo) -> Result<()> {
    let json = serde_json::to_vec_pretty(info)?;
    crate::store::atomic_write_private(path, &json)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[derive(Default)]
pub struct McpService {
    running: Mutex<Option<Running>>,
    catalog: Arc<RwLock<Catalog>>,
    bridge: Arc<Bridge>,
    /// OAuth sign-ins to remote MCP servers under way (D204).
    pub oauth: oauth::Flows,
    /// Claude Code's IDE integration: the lock file and its WebSocket server (D204).
    pub ide: ide_ws::IdeIntegration,
    /// Remote servers' standing GET streams (D207).
    pub streams: stream::Streams,
}

/// MCP tool names allow `[a-zA-Z0-9_-]`; command ids use dots.
pub fn tool_name(command: &str) -> String {
    command.replace('.', "_")
}

fn new_token() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| Error::Invalid(format!("no randomness: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

impl McpService {
    /// Starts the server (or returns the running one). `requests` receives forwarded calls.
    /// The URL and token are also written to `info_file` (readable only by the user on Unix) so
    /// tools on this machine can connect without copying them from the UI.
    pub async fn start(
        &self,
        requests: Channel<BridgeRequest>,
        info_file: std::path::PathBuf,
    ) -> Result<McpInfo> {
        self.bridge.set_channel(requests);
        if let Some(running) = self.lock()?.as_ref() {
            return Ok(running.info.clone());
        }
        let token = new_token()?;
        let cancel = CancellationToken::new();
        let port = http::serve(
            self.catalog.clone(),
            self.bridge.clone(),
            token.clone(),
            cancel.clone(),
        )
        .await?;
        let info = McpInfo {
            url: format!("http://127.0.0.1:{port}/mcp"),
            port,
            token,
        };
        write_info_file(&info_file, &info)?;
        *self.lock()? = Some(Running {
            info: info.clone(),
            cancel,
            info_file,
        });
        Ok(info)
    }

    pub fn stop(&self) -> Result<()> {
        if let Some(running) = self.lock()?.take() {
            running.cancel.cancel();
            let _ = std::fs::remove_file(&running.info_file);
        }
        self.bridge.fail_all("The IDE's MCP server stopped.");
        Ok(())
    }

    pub fn info(&self) -> Result<Option<McpInfo>> {
        Ok(self.lock()?.as_ref().map(|r| r.info.clone()))
    }

    pub fn set_catalog(&self, tools: Vec<ToolSpec>, resources: Vec<ResourceSpec>) -> Result<()> {
        let mut catalog = self
            .catalog
            .write()
            .map_err(|_| Error::Invalid("catalog lock poisoned".into()))?;
        *catalog = Catalog { tools, resources };
        Ok(())
    }

    pub fn respond(&self, id: u64, result: std::result::Result<serde_json::Value, String>) {
        self.bridge.respond(id, result);
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Running>>> {
        self.running
            .lock()
            .map_err(|_| Error::Invalid("mcp lock poisoned".into()))
    }
}

#[cfg(test)]
mod tests;
