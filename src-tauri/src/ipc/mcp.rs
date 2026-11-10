use tauri::ipc::Channel;
use tauri::State;

use crate::error::Result;
use crate::mcp::{BridgeRequest, McpInfo, ResourceSpec, ToolSpec};
use crate::AppState;

/// Starts the MCP server (127.0.0.1, random port, bearer token); calls arrive on `on_request`.
#[tauri::command]
pub async fn mcp_start(
    state: State<'_, AppState>,
    on_request: Channel<BridgeRequest>,
) -> Result<McpInfo> {
    state
        .mcp
        .start(on_request, state.dirs.data.join("mcp.json"))
        .await
}

#[tauri::command]
pub async fn mcp_stop(state: State<'_, AppState>) -> Result<()> {
    state.mcp.stop()
}

#[tauri::command]
pub async fn mcp_info(state: State<'_, AppState>) -> Result<Option<McpInfo>> {
    state.mcp.info()
}

/// How an agent that takes only stdio MCP servers reaches the IDE's (D223): this binary with
/// the proxy flag and the server's address; the token goes in the environment variable named.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StdioProxy {
    pub command: String,
    pub flag: &'static str,
    pub token_env: &'static str,
}

#[tauri::command]
pub async fn mcp_stdio_proxy() -> Result<StdioProxy> {
    let exe = std::env::current_exe()?;
    Ok(StdioProxy {
        command: exe.to_string_lossy().into_owned(),
        flag: crate::mcp::stdio_proxy::FLAG,
        token_env: crate::mcp::stdio_proxy::TOKEN_ENV,
    })
}

/// Replaces the tools (commands) and resources (state paths) the server offers.
#[tauri::command]
pub async fn mcp_set_catalog(
    state: State<'_, AppState>,
    tools: Vec<ToolSpec>,
    resources: Vec<ResourceSpec>,
) -> Result<()> {
    state.mcp.set_catalog(tools, resources)
}

/// Sends one message to a remote MCP server (Streamable HTTP, D193); the reply's messages are
/// handed to the agent's MCP client. Header values may use `${secret:mcp.…}`.
#[tauri::command]
pub async fn mcp_remote_post(
    state: State<'_, AppState>,
    server: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    session_id: Option<String>,
    body: String,
    on_message: Channel<String>,
) -> Result<crate::mcp::remote::RemoteReply> {
    // The server's requests in the reply stream (elicitation) go to the page at once (D200).
    let deliver = move |message: String| {
        let _ = on_message.send(message);
    };
    crate::mcp::remote::post(
        &state.dirs.data.join("secrets.json"),
        &server,
        &url,
        &headers,
        session_id.as_deref(),
        body,
        Some(&deliver),
    )
    .await
}

/// Whether the agent is signed in to a remote MCP server (OAuth, D204); never the tokens.
#[tauri::command]
pub async fn mcp_oauth_status(
    state: State<'_, AppState>,
    server: String,
    url: String,
) -> Result<crate::mcp::oauth::SignInStatus> {
    Ok(crate::mcp::oauth::status(
        &state.dirs.data.join("secrets.json"),
        &server,
        &url,
    ))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthBegun {
    pub flow: String,
    pub authorize_url: String,
}

/// Starts signing in to a remote MCP server: discovery, registration, PKCE and a loopback
/// listener. The page opens `authorizeUrl` in the browser, then calls `mcp_oauth_finish`.
#[tauri::command]
pub async fn mcp_oauth_begin(
    state: State<'_, AppState>,
    server: String,
    url: String,
    client_id: Option<String>,
    client_name: String,
) -> Result<OAuthBegun> {
    crate::mcp::remote::check_url(&url)?;
    let client = crate::mcp::remote::client();
    let challenge = crate::mcp::oauth::last_challenge(&server);
    // A step-up (403 insufficient_scope, D207) asks again for what the last sign-in got.
    let granted = crate::mcp::oauth::load(&state.dirs.data.join("secrets.json"), &server, &url)
        .and_then(|t| t.scope);
    let flow = crate::mcp::oauth::begin(
        &client,
        &server,
        &url,
        challenge.as_deref(),
        &client_name,
        client_id.as_deref(),
        granted.as_deref(),
    )
    .await?;
    let authorize_url = flow.authorize_url.clone();
    let id = state.mcp.oauth.add(flow).await?;
    Ok(OAuthBegun {
        flow: id,
        authorize_url,
    })
}

/// Waits (up to five minutes) for the browser to come back, exchanges the code and stores the
/// tokens. `visit`: the IDE opens the authorization page itself, without a browser (UI tests
/// only, where the mock server signs in at once).
#[tauri::command]
pub async fn mcp_oauth_finish(
    state: State<'_, AppState>,
    flow: String,
    visit: Option<bool>,
) -> Result<crate::mcp::oauth::SignInStatus> {
    use crate::mcp::oauth;
    let pending =
        state.mcp.oauth.take(&flow).await.ok_or_else(|| {
            crate::error::Error::Invalid("no sign-in under way by that id".into())
        })?;
    if visit == Some(true) {
        if state.cli.test_script.is_none() {
            return Err(crate::error::Error::Invalid(
                "visit is only for UI tests".into(),
            ));
        }
        let url = pending.authorize_url.clone();
        tauri::async_runtime::spawn(async move {
            let _ = reqwest::Client::new().get(url).send().await;
        });
    }
    let code = oauth::wait_for_code(&pending, std::time::Duration::from_secs(300)).await?;
    let client = crate::mcp::remote::client();
    let tokens = oauth::exchange(&client, &pending, &code).await?;
    let secrets = state.dirs.data.join("secrets.json");
    oauth::save(&secrets, &pending.server, &tokens)?;
    Ok(oauth::status(
        &secrets,
        &pending.server,
        &pending.server_url,
    ))
}

/// Forgets a remote MCP server's tokens (signs out).
#[tauri::command]
pub async fn mcp_oauth_sign_out(state: State<'_, AppState>, server: String) -> Result<()> {
    crate::mcp::oauth::clear(&state.dirs.data.join("secrets.json"), &server)
}

/// Opens a remote server's standing GET stream (Streamable HTTP, D207): the server's
/// notifications and requests arrive on `on_event` while no POST is open; reconnects with a
/// pause until `mcp_remote_unlisten` (or the server answers 405: it has none). `id` names it.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // a Tauri command's arguments are its IPC fields
pub async fn mcp_remote_listen(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    server: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    session_id: Option<String>,
    on_event: Channel<crate::mcp::stream::StreamEvent>,
) -> Result<()> {
    use crate::mcp::stream;
    crate::mcp::remote::check_url(&url)?;
    let (n, cancel) = state.mcp.streams.add(&id);
    let request = stream::ListenRequest {
        secrets: state.dirs.data.join("secrets.json"),
        server,
        url,
        headers,
        session_id,
    };
    tauri::async_runtime::spawn(async move {
        stream::listen(request, cancel, move |event| {
            let _ = on_event.send(event);
        })
        .await;
        use tauri::Manager;
        app.state::<AppState>().mcp.streams.ended(&id, n);
    });
    Ok(())
}

/// Closes a remote server's GET stream (its server stopped).
#[tauri::command]
pub async fn mcp_remote_unlisten(state: State<'_, AppState>, id: String) -> Result<bool> {
    Ok(state.mcp.streams.stop(&id))
}

/// Starts Claude Code's IDE integration (D204): a WebSocket MCP server and the lock file
/// `~/.claude/ide/<port>.lock` that `/ide` finds; tool calls arrive on `on_request`.
#[tauri::command]
pub async fn ide_integration_start(
    state: State<'_, AppState>,
    on_request: Channel<BridgeRequest>,
    folders: Vec<String>,
    ide_name: String,
) -> Result<crate::mcp::ide_ws::IdeInfo> {
    state
        .mcp
        .ide
        .start(on_request, folders, ide_name, None)
        .await
}

#[tauri::command]
pub async fn ide_integration_update(
    state: State<'_, AppState>,
    folders: Vec<String>,
) -> Result<()> {
    state.mcp.ide.update(folders)
}

#[tauri::command]
pub async fn ide_integration_stop(state: State<'_, AppState>) -> Result<()> {
    state.mcp.ide.stop()
}

#[tauri::command]
pub async fn ide_integration_info(
    state: State<'_, AppState>,
) -> Result<Option<crate::mcp::ide_ws::IdeInfo>> {
    Ok(state.mcp.ide.info())
}

/// A notification to the connected clients (selection_changed, at_mentioned); how many got it.
#[tauri::command]
pub async fn ide_integration_notify(
    state: State<'_, AppState>,
    method: String,
    params: serde_json::Value,
) -> Result<usize> {
    if !matches!(method.as_str(), "selection_changed" | "at_mentioned") {
        return Err(crate::error::Error::Invalid(format!(
            "not a notification the integration sends: {method}"
        )));
    }
    Ok(state.mcp.ide.notify(&method, params))
}

/// The webview's answer to a tool call from Claude Code.
#[tauri::command]
pub async fn ide_integration_respond(
    state: State<'_, AppState>,
    id: u64,
    result: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<()> {
    state.mcp.ide.bridge().respond(
        id,
        match error {
            Some(message) => Err(message),
            None => Ok(result.unwrap_or(serde_json::Value::Null)),
        },
    );
    Ok(())
}

/// The webview's answer to a forwarded call or read.
#[tauri::command]
pub async fn mcp_respond(
    state: State<'_, AppState>,
    id: u64,
    result: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<()> {
    state.mcp.respond(
        id,
        match error {
            Some(message) => Err(message),
            None => Ok(result.unwrap_or(serde_json::Value::Null)),
        },
    );
    Ok(())
}
