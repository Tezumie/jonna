//! Child-process commands: terminals (pty), agents' one-shot commands (exec), and the stdio JSON-RPC
//! host (language servers, MCP servers, ACP agents).

use crate::error::{Error, Result};
use crate::exec::{workdir, ExecResult};
use crate::lsp::{LspEvent, ServerSpec};
use crate::pty::profiles::{DetectedProfile, ProfileSpec};
use crate::pty::suggest::DirEntryName;
use crate::pty::{PtyInfo, RunSpec};
use crate::AppState;
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

/// Spawns the default shell in `cwd` (must be inside one of the workspace's folders; defaults
/// to the first, the root).
/// Output arrives on `on_output` as raw bytes; a final JSON message `{ "exit": code }` ends it.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // a Tauri command's arguments are its IPC fields
pub async fn pty_spawn(
    state: State<'_, AppState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    shell_integration: Option<bool>,
    run: Option<RunSpec>,
    profile: Option<ProfileSpec>,
    // Variables for an interactive shell too (a JavaScript debug terminal, D204).
    env: Option<std::collections::HashMap<String, String>>,
    // The page's token (`page_loaded` keeps this page's terminals when it detaches the others).
    page: Option<String>,
) -> Result<PtyInfo> {
    // A remote window's terminal starts there (D252): in its folder, else the remote's home.
    let remote_home = crate::remote::active()
        .and_then(|r| r.info())
        .map(|i| std::path::PathBuf::from(i.home))
        .filter(|h| !h.as_os_str().is_empty());
    let fallback = || {
        state
            .workspace
            .root()
            .or_else(|e| remote_home.clone().ok_or(e))
            .or_else(|_| state.dirs.home())
    };
    // A restored terminal may remember a folder that is gone or outside the workspace (the user
    // cd'ed there); start in the workspace root instead of failing.
    let cwd = match cwd {
        Some(dir) => match state.workspace.resolve(&dir) {
            Ok(path) if crate::remote::is_remote_path(&dir) => {
                if crate::remote::is_dir_async(&crate::remote::posix(&path)).await {
                    path
                } else {
                    fallback()?
                }
            }
            Ok(path) if path.is_dir() => path,
            _ => fallback()?,
        },
        None => fallback()?,
    };
    let integration = shell_integration
        .unwrap_or(true)
        .then(|| crate::pty::integration::integration_dir(&state.dirs.data));
    // Starting a shell blocks (ConPTY, process creation, sometimes antivirus scans), and on Windows
    // it has been seen to hang now and then: run it off the async runtime and give up after 10 s;
    // the terminal retries once. A start that finishes after the timeout is killed.
    let pty = state.pty.clone();
    let mut job = tauri::async_runtime::spawn_blocking(move || {
        pty.spawn(
            cwd,
            cols,
            rows,
            channel_sink(on_output),
            crate::pty::SpawnOptions {
                integration_dir: integration,
                run,
                profile,
                extra_env: env.unwrap_or_default(),
                page,
            },
        )
    });
    match tokio::time::timeout(Duration::from_secs(10), &mut job).await {
        Ok(Ok(result)) => result,
        Ok(Err(e)) => Err(Error::Pty(format!("the shell start failed: {e}"))),
        Err(_) => {
            // Nobody waits for this terminal any more: if it does start, close it.
            let late = state.pty.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(Ok(info)) = job.await {
                    let _ = late.kill(info.id);
                }
            });
            Err(Error::Pty(
                "the shell didn't start within 10 seconds (StartTimeout)".into(),
            ))
        }
    }
}

/// A terminal's output as Channel messages: raw bytes, and `{ "exit": code }` at the end.
fn channel_sink(channel: Channel<InvokeResponseBody>) -> crate::pty::Sink {
    Box::new(move |message| match message {
        crate::pty::Output::Data(bytes) => channel.send(InvokeResponseBody::Raw(bytes)).is_ok(),
        crate::pty::Output::Exit(code) => channel
            .send(InvokeResponseBody::Json(format!("{{\"exit\":{code}}}")))
            .is_ok(),
    })
}

/// A reloaded page takes back a terminal its previous page had (VS Code's process revival):
/// `id` and `key` from that page's saved tab, `since` the output offset of its saved screen.
/// The output after it comes first on `on_output`, then the live output. Fails with "Gone" when
/// the terminal ended (or belongs to another run of the IDE) and "AlreadyAttached" while a page
/// shows it.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // a Tauri command's arguments are its IPC fields
pub async fn pty_attach(
    state: State<'_, AppState>,
    id: u32,
    key: String,
    on_output: Channel<InvokeResponseBody>,
    since: Option<u64>,
    cols: Option<u16>,
    rows: Option<u16>,
    page: Option<String>,
) -> Result<crate::pty::Attached> {
    let size = cols.zip(rows);
    state
        .pty
        .attach(id, &key, page, channel_sink(on_output), since, size)
}

/// Lets terminal `id` go without ending it (a view dropped before it was shown, mid-reload): it
/// waits for a page to reattach it, and ends after the grace period.
#[tauri::command]
pub async fn pty_detach(state: State<'_, AppState>, id: u32) -> Result<()> {
    state.pty.detach(id)
}

/// Ends the terminals no page holds (revival off: a reloaded page doesn't take them back).
#[tauri::command]
pub async fn pty_kill_detached(app: tauri::AppHandle) -> Result<usize> {
    // `taskkill` per terminal on Windows takes a while: not on an async worker (D293).
    tauri::async_runtime::spawn_blocking(move || {
        tauri::Manager::state::<AppState>(&app).pty.kill_detached()
    })
    .await
    .map_err(|e| Error::Invalid(format!("ending terminals failed: {e}")))
}

/// The shells installed here (terminal profiles) and which ConPTY the terminals use.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShells {
    pub profiles: Vec<DetectedProfile>,
    /// Windows: "bundled" when the terminals use the conpty.dll and OpenConsole.exe next to the
    /// app (`pty::conpty`), else "system"; null elsewhere.
    pub conpty: Option<&'static str>,
}

#[tauri::command]
pub async fn pty_profiles() -> Result<TerminalShells> {
    let profiles = tauri::async_runtime::spawn_blocking(crate::pty::profiles::detect)
        .await
        .map_err(|e| Error::Pty(e.to_string()))?;
    #[cfg(windows)]
    let conpty = Some(crate::pty::conpty::kind());
    #[cfg(not(windows))]
    let conpty = None;
    Ok(TerminalShells { profiles, conpty })
}

/// Program names on PATH, for the terminal's command suggestions (cached in Rust).
#[tauri::command]
pub async fn pty_path_commands() -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(crate::pty::suggest::path_commands)
        .await
        .map_err(|e| Error::Pty(e.to_string()))
}

/// The aliases and functions of the shell terminal `id` runs (D229), as that shell prints them
/// (`pty::globals`); empty for a shell that has none we can read. Only for a live terminal's own
/// shell, so this starts nothing the terminal didn't.
#[tauri::command]
pub async fn pty_shell_globals(state: State<'_, AppState>, id: u32) -> Result<String> {
    let shell = state.pty.shell_program(id)?;
    tauri::async_runtime::spawn_blocking(move || crate::pty::globals::shell_globals(&shell))
        .await
        .map_err(|e| Error::Pty(e.to_string()))
}

/// Entry names of a folder, for the path suggestions of terminal `id`: `dir` is absolute or
/// relative to the folder that terminal's shell is in. Only while that terminal lives (its shell
/// can list the folder anyway); names and kinds only.
#[tauri::command]
pub async fn pty_list_dir(
    state: State<'_, AppState>,
    id: u32,
    dir: String,
    hidden: Option<bool>,
) -> Result<Vec<DirEntryName>> {
    let base = state.pty.current_dir(id)?;
    let hidden = hidden.unwrap_or(false);
    // A remote terminal's folders are listed there (D252).
    if let Some(base) = crate::remote::of_dir(&base) {
        let target = if dir.starts_with('/') {
            dir.clone()
        } else {
            crate::remote::join(&base, &dir)
        };
        let entries = crate::remote::fs::browse(&target).await.unwrap_or_default();
        return Ok(entries
            .into_iter()
            .filter(|e| hidden || !e.name.starts_with('.'))
            .map(|e| DirEntryName {
                dir: e.kind == crate::fs::EntryKind::Dir,
                name: e.name,
            })
            .take(2000)
            .collect());
    }
    let path = std::path::Path::new(&dir);
    let target = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    tauri::async_runtime::spawn_blocking(move || crate::pty::suggest::list_dir(&target, hidden))
        .await
        .map_err(|e| Error::Pty(e.to_string()))
}

/// Shell-integration command records of a terminal (`ide://terminals/<id>/commands`).
#[tauri::command]
pub async fn pty_commands(
    state: State<'_, AppState>,
    id: u32,
    limit: Option<usize>,
) -> Result<crate::pty::TerminalCommands> {
    state.pty.commands(id, limit.unwrap_or(50))
}

// Writes and resizes are synchronous commands, so they're handled one at a time in the order
// they were sent (async commands each run as their own task and could overtake each other:
// swapped keystrokes, an older size applied last). Neither blocks: a write only queues the
// bytes for the session's writer thread, and a resize is one quick call to the pty.
#[tauri::command]
pub fn pty_write(state: State<'_, AppState>, id: u32, data: String) -> Result<()> {
    state.pty.write(id, &data)
}

#[tauri::command]
pub fn pty_resize(state: State<'_, AppState>, id: u32, cols: u16, rows: u16) -> Result<()> {
    state.pty.resize(id, cols, rows)
}

/// Flow control: the frontend reports how many output bytes it has rendered.
#[tauri::command]
pub async fn pty_ack(state: State<'_, AppState>, id: u32, bytes: usize) -> Result<()> {
    state.pty.ack(id, bytes)
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, AppState>, id: u32) -> Result<()> {
    state.pty.kill(id)
}

// `exec_run`: a non-interactive command in a workspace folder (agents' run_command).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn exec_run(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    id: String,
    command: String,
    cwd: Option<String>,
    timeout_ms: Option<u64>,
    stdin: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    // In the command sandbox (D336): writes only in the command's workspace folder and a temp one.
    sandbox: Option<bool>,
    // Its secrets to hide and the project's allowances (D349, D350).
    sandbox_policy: Option<crate::exec::sandbox::SandboxPolicy>,
    on_output: Channel<String>,
) -> Result<ExecResult> {
    // An external agent's command in its chat's private folder (no folder open, D208).
    let scratch = cwd
        .as_deref()
        .and_then(|c| crate::agent::scratch::within(&state.dirs.data, std::path::Path::new(c)));
    let mut writable_root: Option<std::path::PathBuf> = scratch.clone();
    let dir = match scratch {
        Some(dir) => dir,
        None => {
            let cwd = cwd.map(|c| state.workspace.resolve(&c)).transpose()?;
            // The workspace folder holding `cwd` (the root or another one), or the extra root
            // (a headless helper's worktree); no `cwd`: the root.
            let root = match &cwd {
                Some(c) => state.workspace.root_of(c)?,
                None => state.workspace.root()?,
            };
            writable_root = Some(root.clone());
            workdir(&root, cwd)?
        }
    };
    let app_name = state
        .dirs
        .data
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let sandbox = match (sandbox, writable_root) {
        (Some(true), Some(root)) => Some(
            crate::exec::sandbox::Sandbox::for_root(&root, &app_name)
                .with_policy(&sandbox_policy.unwrap_or_default(), &state.dirs.data),
        ),
        _ => None,
    };
    // Up to a week: the agent's background commands (dev servers, watchers, D201) run until
    // killed; foreground callers pass their own, shorter limits.
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(120_000)
            .clamp(1_000, 7 * 24 * 3_600_000),
    );
    let exec = state.exec.clone();
    exec.set_owner(&id, webview.label());
    tauri::async_runtime::spawn_blocking(move || {
        let sink = on_output.clone();
        // Only variables of the agent's hooks (CLAUDE_PROJECT_DIR, D227) and a headless
        // helper's worktree port block (PORT, WORKTREE_*, as its window would have) come this way.
        let vars: Vec<(String, String)> = env
            .unwrap_or_default()
            .into_iter()
            .filter(|(k, _)| k.starts_with("CLAUDE_") || k.starts_with("WORKTREE_") || k == "PORT")
            .collect();
        let send = move |chunk| {
            let _ = sink.send(chunk);
        };
        let result = match &sandbox {
            Some(sb) => {
                // The repositories it may write: their git settings as they are now (D392).
                crate::git::guard::arm(&sb.writable);
                exec.run_sandboxed_with(&id, &command, &dir, timeout, &vars, sb, send)
            }
            None => exec.run_with_input(&id, &command, &dir, timeout, &vars, stdin, send),
        };
        // End-of-output marker: the command's result can reach the webview before the last
        // output chunks, so the client waits for this (EXEC_END in src/core/ipc/process.ts).
        let _ = on_output.send(EXEC_END.to_string());
        result
    })
    .await
    .map_err(|e| crate::error::Error::Exec(e.to_string()))?
}

/// What the command sandbox does on this system (D336): the agent's tool row and permission
/// card say it.
#[tauri::command]
pub fn exec_sandbox_info() -> crate::exec::sandbox::SandboxInfo {
    crate::exec::sandbox::info()
}

/// Shows the secrets the sandbox hid on Windows to sandboxed commands again (D349): each path the
/// sandbox labelled gets its label from before back. The paths done; nothing elsewhere (macOS and
/// Linux hide them per command, nothing stays).
#[tauri::command]
pub fn exec_sandbox_unhide(state: State<'_, AppState>) -> Result<Vec<String>> {
    #[cfg(windows)]
    {
        crate::exec::sandbox_read::windows_hide::unhide_all(&state.dirs.data)
            .map_err(|e| crate::error::Error::Exec(e.to_string()))
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        Ok(Vec::new())
    }
}

/// Sent once after a command's last output chunk.
pub(crate) const EXEC_END: &str = "\u{0}end";

#[tauri::command]
pub async fn exec_cancel(state: State<'_, AppState>, id: String) -> Result<()> {
    state.exec.cancel(&id)
}

/// The hosts a running sandboxed command's network filter refused so far (D372).
#[tauri::command]
pub async fn exec_blocked_hosts(state: State<'_, AppState>, id: String) -> Result<Vec<String>> {
    Ok(state.exec.blocked_hosts(&id))
}

/// A page (re)loaded: what the window's previous page left running — the agent's model requests,
/// commands and servers — is stopped; nothing would read their output any more. Terminals wait to
/// be reattached (m7.12; D163, D180).
#[tauri::command]
pub async fn page_loaded(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    // The new page's token: terminals it already started or reattached stay with it.
    page: Option<String>,
) -> Result<()> {
    state.ai.cancel_owner(webview.label());
    state.exec.cancel_owner(webview.label());
    // Sites shown inside the old page's tabs (browser.embedSites) would stay drawn over it.
    crate::browser::embed::close_embedded_in(
        &tauri::Manager::app_handle(&webview).clone(),
        webview.window().label(),
    );
    // Remote MCP servers' GET streams (D207) would reconnect forever for a page that's gone.
    if webview.label() == "main" {
        state.mcp.streams.stop_all();
    }
    // The main page reloaded (Ctrl+R, Developer: Reload window, a dev rebuild): its stdio servers
    // (language, MCP, external agents) can't be reattached, so they'd run on unseen, each with a
    // console host on Windows (D180). Its terminals can: they wait for the new page to take them
    // back (VS Code's process revival, `pty::revive`) and end after the grace period otherwise.
    // Every other IDE window is a process of its own.
    if webview.label() == "main" {
        state.pty.detach_except(page.as_deref());
        // Debugger connections (Node's inspector) were the old page's: closed (D293).
        state.debug.close_all();
        state
            .lsp
            .blocking(|host| {
                host.stop_all();
                Ok(())
            })
            .await?;
        // Extension pages the old page wrote (`ext_webview_page`): its runtimes never said
        // they're done, and the new page writes its own (D261: at 200 a view stayed blank).
        if let Ok(mut pages) = state.browser.shared.webview_pages.lock() {
            pages.clear();
        }
        // …and the folders its pages could read (the new page's runtimes allow theirs again).
        if let Ok(mut roots) = state.browser.shared.webview_roots.lock() {
            roots.clear();
        }
    }
    Ok(())
}

// Language-server host commands (`crate::lsp`). Server specs come from the `lsp.servers` setting
// (user and workspace settings — workspace ones only for trusted folders in M6) or a built-in
// extension; the working directory must be inside the open folder, or (D202: a program an
// extension ships) inside an extension's own folder. With no folder open, only the latter (D268:
// the Node extension host runs in an empty window, as VS Code's does).
#[tauri::command]
pub async fn lsp_start(
    state: State<'_, AppState>,
    id: String,
    spec: ServerSpec,
    on_event: Channel<LspEvent>,
) -> Result<u32> {
    // An external agent of a chat with no folder open runs in the chat's private folder (D208);
    // everything else needs the folder.
    let cwd = match crate::agent::scratch::within(&state.dirs.data, &spec.cwd) {
        Some(dir) => dir,
        None if state.workspace.root().is_err() => state
            .extensions
            .folder_within(&spec.cwd)
            .ok_or(Error::NoWorkspace)?,
        None => {
            match state.workspace.resolve(&spec.cwd.to_string_lossy()) {
                // Inside any workspace folder (or a helper's worktree), not a file let in alone.
                Ok(cwd) if state.workspace.root_of(&cwd).is_ok() => cwd,
                _ => state
                    .extensions
                    .folder_within(&spec.cwd)
                    .ok_or_else(|| Error::OutsideScope(spec.cwd.to_string_lossy().into_owned()))?,
            }
        }
    };
    // `${secret:mcp.…}` in an MCP server's arguments or environment: its password inputs
    // (D193), filled in here so they never pass through the webview.
    let secrets = state.dirs.data.join("secrets.json");
    let server = id.strip_prefix("mcp:");
    let expand = |s: &String| crate::ai::secrets::expand(&secrets, s, server);
    let args = spec.args.iter().map(expand).collect::<Result<Vec<_>>>()?;
    let env = spec
        .env
        .iter()
        .map(|(k, v)| Ok((k.clone(), expand(v)?)))
        .collect::<Result<std::collections::HashMap<_, _>>>()?;
    let spec = ServerSpec {
        cwd,
        args,
        env,
        ..spec
    };
    // Starting stops an earlier instance (kill and reap) and spawns: off the async workers.
    state
        .lsp
        .blocking(move |host| host.start(&id, spec, on_event))
        .await
}

/// The stdio host's calls block (a full pipe, killing and reaping a process tree), so they run
/// on blocking threads (D218). Messages to one program keep their order: the webview sends
/// each after the one before it has returned (`src/core/ipc/ordered.ts`).
#[tauri::command]
pub async fn lsp_send(state: State<'_, AppState>, id: String, body: String) -> Result<()> {
    state.lsp.blocking(move |host| host.send(&id, &body)).await
}

#[tauri::command]
pub async fn lsp_stop(state: State<'_, AppState>, id: String) -> Result<()> {
    state.lsp.blocking(move |host| host.stop(&id)).await
}

/// Closes a stdio program's input (D203: extensions' `process.closeStdin`).
#[tauri::command]
pub async fn lsp_close_stdin(state: State<'_, AppState>, id: String) -> Result<()> {
    // Waits for a send in progress (the input's lock).
    state.lsp.blocking(move |host| host.close_stdin(&id)).await
}

/// Ctrl+C for a stdio program (D203: extensions' `process.interrupt`; not on Windows).
#[tauri::command]
pub async fn lsp_interrupt(state: State<'_, AppState>, id: String) -> Result<()> {
    // It waits up to seconds for the server to stop on Windows: on the blocking pool (D293).
    state.lsp.blocking(move |host| host.interrupt(&id)).await
}

// Debugger inspector sockets (D143): local ws:// only (checked in `crate::debug`).
#[tauri::command]
pub async fn debug_socket_connect(
    state: State<'_, AppState>,
    id: String,
    url: String,
    on_event: Channel<crate::debug::SocketEvent>,
) -> Result<()> {
    state.debug.connect(&id, &url, on_event).await
}

#[tauri::command]
pub async fn debug_inspector_targets(host: String, port: u16) -> Result<String> {
    crate::debug::inspector_targets(&host, port).await
}

/// A text file from a server on this machine (a debugged page's source map, D196).
#[tauri::command]
pub async fn debug_local_get(url: String) -> Result<String> {
    let (host, port, path) = crate::debug::parse_local_http(&url)?;
    crate::debug::local_get(&host, port, &path).await
}

#[tauri::command]
pub async fn debug_socket_send(state: State<'_, AppState>, id: String, body: String) -> Result<()> {
    state.debug.send(&id, body)
}

#[tauri::command]
pub async fn debug_socket_close(state: State<'_, AppState>, id: String) -> Result<()> {
    state.debug.close(&id);
    Ok(())
}

/// A debug adapter listening on a local port (Delve's `dlv dap`, D204), on the same channel as
/// inspector sockets: DAP messages' JSON in, `debug_socket_send` out.
#[tauri::command]
pub async fn debug_dap_connect(
    state: State<'_, AppState>,
    id: String,
    host: String,
    port: u16,
    on_event: Channel<crate::debug::SocketEvent>,
) -> Result<()> {
    state.debug.connect_dap(&id, &host, port, on_event).await
}

/// A fresh auto-attach registration folder and the bootloader's path (D204).
#[tauri::command]
pub async fn debug_autoattach_prepare(
    state: State<'_, AppState>,
) -> Result<crate::debug::autoattach::Prepared> {
    crate::debug::autoattach::prepare(&state.dirs.data)
}

/// Processes registered since the last call (their JSON), keeping the folder alive.
#[tauri::command]
pub async fn debug_autoattach_take(state: State<'_, AppState>, id: String) -> Result<Vec<String>> {
    crate::debug::autoattach::take(&state.dirs.data, &id)
}

#[tauri::command]
pub async fn debug_autoattach_dispose(state: State<'_, AppState>, id: String) -> Result<()> {
    crate::debug::autoattach::dispose(&state.dirs.data, &id)
}

/// Every process on this machine, for attaching (`${command:pickProcess}`, D204).
#[tauri::command]
pub async fn debug_list_processes() -> Result<crate::debug::processes::ProcessListing> {
    crate::debug::processes::list().await
}

/// Where Chrome (`kind` "chrome") or Edge ("edge") is installed, for the browser launcher; null
/// when neither the usual folders, Windows' App Paths nor PATH have it.
#[tauri::command]
pub async fn debug_find_browser(kind: String) -> Result<Option<String>> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::debug::browsers::find(&kind).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| crate::error::Error::Exec(e.to_string()))
}

/// The browser pane's debugging port for the next start (WebView2 only; 0 turns it off, D204).
#[tauri::command]
pub async fn debug_set_pane_port(state: State<'_, AppState>, port: u16) -> Result<()> {
    crate::debug::pane_port::save(&state.dirs.data, port)
}

/// Formats `text` (the file `path`'s unsaved content) with the project's own formatter (D140);
/// null when the project has none for this file (the editor's formatter applies).
#[tauri::command]
pub async fn format_project(
    state: State<'_, AppState>,
    path: String,
    text: String,
) -> Result<Option<crate::exec::format::Formatted>> {
    use crate::exec::format;
    // A remote window's project formatter would be found and run on the remote: not yet
    // (D252), so the editor's own formatter (or a language server's, which runs there) applies.
    if crate::remote::is_remote_path(&path) {
        return Ok(None);
    }
    let file = state.workspace.resolve(&path)?;
    // The folder holding the file (a multi-root workspace's other folder has its own tools);
    // a file let in from outside the folders is looked at from the root, as before.
    let root = match state.workspace.root_of(&file) {
        Ok(folder) => folder,
        Err(_) => state.workspace.root()?,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let Some(f) = format::detect(&root, &file, &format::find_program) else {
            return Ok(None);
        };
        let text = format::run(&f, &text, Duration::from_secs(10))?;
        Ok(Some(format::Formatted {
            formatter: f.name,
            text,
        }))
    })
    .await
    .map_err(|e| crate::error::Error::Exec(e.to_string()))?
}

/// A Windows app execution alias (`%LOCALAPPDATA%\Microsoft\WindowsApps`): a launcher for a
/// Store app, not a CLI. Windows 11's own Copilot app has one named `copilot`, which made the
/// GitHub Copilot CLI look installed (D190).
fn is_store_alias(path: &std::path::Path) -> bool {
    let parts: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect();
    parts
        .windows(2)
        .any(|w| w[0] == "microsoft" && w[1] == "windowsapps")
}

/// Which of `names` are installed programs (on PATH, or found through the login shell): the AI
/// setup page shows whether Ollama and the agent CLIs are there (D164). At most 16 names.
#[tauri::command]
pub async fn programs_installed(names: Vec<String>) -> Result<Vec<bool>> {
    tauri::async_runtime::spawn_blocking(move || {
        names
            .iter()
            .take(16)
            .map(|n| {
                // A bare program name only: no paths or arguments.
                !n.is_empty()
                    && n.chars()
                        .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
                    && crate::exec::format::find_program(n).is_some_and(|p| !is_store_alias(&p))
            })
            .collect()
    })
    .await
    .map_err(|e| crate::error::Error::Exec(e.to_string()))
}

/// The page interactive notebook outputs run in (D189: HTML with scripts, Plotly, Bokeh,
/// ipywidgets): written to the app's data folder and served on a local origin of its own, so
/// an output's code can never reach the IDE (the frame is sandboxed too). Its origin.
#[tauri::command]
pub async fn notebook_output_origin(state: State<'_, AppState>) -> Result<String> {
    const FILES: &[(&str, &str)] = &[
        (
            "index.html",
            include_str!("../../notebook/output/index.html"),
        ),
        ("output.js", include_str!("../../notebook/output/output.js")),
        // Shared by both pages: the network limit and hardening (D204).
        ("harden.js", include_str!("../../notebook/output/harden.js")),
        // A VS Code controller's notebook: one page for all its outputs (D295).
        (
            "notebook.html",
            include_str!("../../notebook/output/notebook.html"),
        ),
        (
            "notebook.js",
            include_str!("../../notebook/output/notebook.js"),
        ),
        // The agent's inline widgets (D334): no network at all (the page's own policy).
        (
            "widget.html",
            include_str!("../../notebook/output/widget.html"),
        ),
        ("widget.js", include_str!("../../notebook/output/widget.js")),
    ];
    let dir = state.dirs.data.join("notebook").join("output");
    for (name, text) in FILES {
        let path = dir.join(name);
        if std::fs::read_to_string(&path).ok().as_deref() != Some(*text) {
            crate::store::atomic_write(&path, text.as_bytes())?;
        }
    }
    let info = state
        .browser
        .proxy(crate::browser::Target::Static {
            root: dir,
            csp: Some(crate::browser::NOTEBOOK_OUTPUT_CSP),
        })
        .await?;
    Ok(info.origin)
}

#[cfg(test)]
mod store_alias_tests {
    #[test]
    fn store_app_aliases_are_not_programs() {
        use std::path::Path;
        assert!(super::is_store_alias(Path::new(
            "C:/Users/a/AppData/Local/Microsoft/WindowsApps/copilot.exe"
        )));
        assert!(!super::is_store_alias(Path::new(
            "C:/Users/a/AppData/Roaming/npm/copilot.cmd"
        )));
    }
}
