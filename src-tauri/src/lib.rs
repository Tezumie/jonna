//! Native side of the IDE: low-level services exposed as Tauri commands (PLAN §4).
//! The command dispatcher lives in the frontend; these are the primitives it builds on.

mod accelerators;
mod accounts;
mod acp_agents;
mod agent;
mod ai;
mod audit;
mod aux_window;
mod browser;
mod cli;
mod debug;
mod desktop;
mod diagnostics;
mod error;
mod exec;
mod extensions;
mod frame_guard;
mod fs;
mod git;
mod history;
mod index;
mod instances;
mod ipc;
mod job;
mod lsp;
mod mcp;
mod node_runtime;
mod pty;
mod remote;
mod screenshot;
mod search;
mod speech;
mod store;
mod update;
mod url_scheme;
mod user_folders;
mod watch;
mod window_bounds;
mod wsl;

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{Manager, RunEvent};

/// Shared service state, managed by Tauri and injected into commands.
pub struct AppState {
    pub dirs: store::AppDirs,
    pub workspace: fs::Workspace,
    pub watcher: watch::Watcher,
    /// Watches settings/keybindings files (config dir and `<root>/<workspace folder>`).
    pub settings_watcher: watch::Watcher,
    /// Watches the folders of open editor documents (reload from disk).
    pub docs_watcher: watch::Watcher,
    /// Watches the agent's skills folders, with what's inside (D221).
    pub skills_watcher: watch::Watcher,
    /// Watches the saved agent chats (the worktree overview follows other windows' saves, D233).
    pub agent_sessions_watcher: watch::Watcher,
    /// Workspace file list for quick open.
    pub index: index::FileIndex,
    pub search: search::SearchService,
    /// The workspace's git repository (CLI-backed).
    pub git: git::GitService,
    pub mcp: mcp::McpService,
    /// Running language servers.
    pub lsp: lsp::LspHost,
    /// Inspector sockets of debuggees (Node's --inspect, D143).
    pub debug: debug::DebugSockets,
    /// The agent's WebSocket monitors (D328).
    pub monitor_sockets: agent::socket::MonitorSockets,
    /// Model providers (agent).
    pub ai: ai::AiService,
    /// Agents' non-interactive commands.
    pub exec: std::sync::Arc<exec::ExecService>,
    pub pty: std::sync::Arc<pty::PtyManager>,
    pub audit: audit::AuditLog,
    /// Snapshots of written files and the app trash (undoable deletes).
    pub history: history::LocalHistory,
    /// Preview proxies and external browser windows.
    pub browser: browser::BrowserService,
    pub extensions: extensions::ExtensionStore,
    pub process_start_ms: f64,
    pub cli: cli::CliArgs,
    /// Paths of the last files dropped onto the window from the OS (only these can be imported).
    pub dropped: std::sync::Mutex<Vec<std::path::PathBuf>>,
    /// The session log, extensions off, the version before (D204).
    pub session: ipc::diagnostics::SessionState,
    /// The main window's bounds, remembered for the next start.
    pub window_bounds: window_bounds::Tracker,
}

/// Started as the command line (D209: `<cli> file:line`, a folder already open, `--wait`):
/// handed to a running window, the exit code; None to start as a window.
pub fn cli_forward() -> Option<i32> {
    instances::client::forward()
}

/// Started as the Ctrl+C helper (`lsp/ctrl_c.rs`, D229): the exit code after sending it.
pub fn ctrl_c_helper() -> Option<i32> {
    lsp::ctrl_c::helper()
}

/// `--help` / `--version` (D229): printed to the terminal that started the IDE, then exit 0.
/// Release builds on Windows are GUI programs with no console: they attach to the parent's (a
/// pipe or file they were given works as it is).
pub fn cli_info() -> Option<i32> {
    let info = cli::CliArgs::parse(std::env::args_os()).info?;
    let text = match info {
        cli::CliInfo::Help => cli::help_text(product_term_program(), env!("CARGO_PKG_VERSION")),
        cli::CliInfo::Version => format!(
            "{}
{}
",
            env!("CARGO_PKG_VERSION"),
            std::env::consts::ARCH
        ),
    };
    #[cfg(windows)]
    {
        use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
        // SAFETY: a plain call; it fails harmlessly when there's a console or no parent one.
        let _ = unsafe { AttachConsole(ATTACH_PARENT_PROCESS) };
    }
    use std::io::Write;
    let mut out = std::io::stdout();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
    Some(0)
}

/// Started as a remote window's relay (`--remote-relay`, D252): the program's exit code there.
pub fn remote_relay() -> Option<i32> {
    remote::relay::client()
}

/// When the binary was started as git's or ssh's sign-in prompt, the exit code after answering.
pub fn askpass_client() -> Option<i32> {
    git::askpass::client()
}

/// Started as `--mcp-stdio-proxy <url>` (an external agent's stdio MCP server, D223): bridges
/// stdin/stdout to the IDE's MCP server and exits. None when this isn't such a run.
pub fn mcp_stdio_proxy() -> Option<i32> {
    mcp::stdio_proxy::client()
}

/// Variables another editor's terminal sets for what runs inside it (D192). Started from VS Code's
/// terminal (`npm run dev`), the IDE inherited them, and every program in its own terminals then
/// believed it was inside VS Code: Claude Code installed its VS Code extension and tried to talk
/// to that window, git asked VS Code for passwords. They're removed at startup.
pub fn forget_parent_editor() {
    // git's password prompt: only the other editor's (the user's own stays).
    let editor_askpass = std::env::var_os("VSCODE_GIT_ASKPASS_NODE").is_some()
        || std::env::var_os("VSCODE_GIT_IPC_HANDLE").is_some()
        || std::env::var("GIT_ASKPASS").is_ok_and(|v| {
            let v = v.to_ascii_lowercase().replace('\\', "/");
            v.contains("vscode") || v.contains("extensions/git/dist/askpass")
        });
    let names: Vec<std::ffi::OsString> = std::env::vars_os()
        .map(|(k, _)| k)
        .filter(|k| {
            let k = k.to_string_lossy();
            inherited_editor_var(&k) || (editor_askpass && k.eq_ignore_ascii_case("GIT_ASKPASS"))
        })
        .collect();
    for k in names {
        std::env::remove_var(k);
    }
    // VS Code's JavaScript debugger hooks every node process through NODE_OPTIONS.
    if std::env::var("NODE_OPTIONS").is_ok_and(|v| v.contains("bootloader")) {
        std::env::remove_var("NODE_OPTIONS");
    }
}

/// TERM_PROGRAM for the IDE's terminals: product.json's short name, lowercase ("vscode" style).
pub fn product_term_program() -> &'static str {
    static NAME: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    NAME.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(include_str!("../../product.json"))
            .ok()
            .and_then(|v| {
                v.get("nameShort")
                    .and_then(|n| n.as_str())
                    .map(str::to_lowercase)
            })
            .unwrap_or_else(|| "ide".into())
    })
}

/// Set by an editor's integrated terminal for the programs in it (VS Code, Cursor, Windsurf…).
pub fn inherited_editor_var(name: &str) -> bool {
    let k = name.to_ascii_uppercase();
    k.starts_with("VSCODE_")
        || k.starts_with("TERM_PROGRAM")
        || k.starts_with("CURSOR_")
        || matches!(
            k.as_str(),
            "ELECTRON_RUN_AS_NODE"
                | "CLAUDECODE"
                | "WT_SESSION"
                | "WT_PROFILE_ID"
                | "TERMINAL_EMULATOR"
                | "CLAUDE_CODE_SSE_PORT"
                | "ENABLE_IDE_INTEGRATION"
                | "CLAUDE_CODE_ENTRYPOINT"
                | "COLORTERM"
        )
}

/// Variables npm adds for a script (`npm run dev` starts the IDE in development): the
/// `npm_*` settings, `INIT_CWD`, `NODE`, and the `node_modules/.bin` folders it puts on `PATH`.
/// Terminals, tasks and agents' commands must not inherit them — a project's own `npm install`
/// or `vite` would see the IDE's folder and tools instead of the project's. Called first thing,
/// before any thread starts; nothing changes when npm didn't start the IDE.
pub fn forget_npm_launcher() {
    let launched_by_npm = std::env::var_os("npm_lifecycle_event").is_some()
        || std::env::var_os("npm_execpath").is_some();
    if !launched_by_npm {
        return;
    }
    let names: Vec<std::ffi::OsString> = std::env::vars_os()
        .map(|(k, _)| k)
        .filter(|k| {
            let k = k.to_string_lossy().to_ascii_lowercase();
            k.starts_with("npm_") || k == "init_cwd" || k == "node"
        })
        .collect();
    for k in names {
        std::env::remove_var(k);
    }
    if let Some(path) = std::env::var_os("PATH") {
        let kept = std::env::split_paths(&path).filter(|p| !npm_script_path(p));
        if let Ok(joined) = std::env::join_paths(kept) {
            std::env::set_var("PATH", joined);
        }
    }
}

/// A PATH entry npm adds for scripts: `…/node_modules/.bin` or npm's `node-gyp-bin`.
fn npm_script_path(p: &std::path::Path) -> bool {
    let parts: Vec<String> = p
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect();
    let n = parts.len();
    (n >= 2 && parts[n - 1] == ".bin" && parts[n - 2] == "node_modules")
        || parts.last().is_some_and(|l| l == "node-gyp-bin")
}

/// The folder this window has open (its `.code-workspace` file when one is open), as the window
/// registry and bounds keep it.
fn window_folder(state: &AppState) -> Option<String> {
    state
        .workspace
        .location()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
}

pub fn run() {
    let process_start_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Without its click script (D253): on WebView2 it also runs inside the browser pane's
        // page frames, where it took a page's target=_blank links (and refused them, the page's
        // origin not being the IDE's) before the browser's own bridge could open them as tabs.
        // The IDE's own links open through its commands (`openUrl`).
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .setup(move |app| {
            // Updates only in builds made with an endpoint (D192): no plugin, no connection.
            if update::configured(app.handle()) {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            // As this window takes them: the first `--add` folder is its folder when none was
            // given (no window ran to add it to).
            let cli = cli::CliArgs::current().into_window();
            // Before any window: the taskbar groups windows and the jump list by this id, which
            // the installer's shortcuts carry too (D229). Test runs keep Windows' default.
            if cli.test_script.is_none() {
                instances::jump_list::set_process_app_id(&instances::jump_list::app_id(
                    &app.config().identifier,
                ));
            }
            let dirs = store::AppDirs::resolve(app.handle(), cli.user_data_dir.as_deref())?;
            if cli.test_script.is_some() {
                // A hung test run must still fail CI.
                let timeout = std::time::Duration::from_secs(cli.test_timeout_s);
                std::thread::spawn(move || {
                    std::thread::sleep(timeout);
                    // The message from a thread of its own: when the output pipe is stuck (a
                    // log reader that stopped reading, D396) writing it blocks, and the exit
                    // must not wait for it.
                    std::thread::spawn(move || {
                        eprintln!("test run timed out after {}s", timeout.as_secs());
                    });
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    std::process::exit(124);
                });
            }
            // The session log first, so a panic from here on is in it (D204).
            let log = std::sync::Arc::new(diagnostics::log::SessionLog::open(
                &dirs.logs,
                dirs.home.as_deref(),
            ));
            diagnostics::log::install_panic_hook(log.clone());
            let version = app.package_info().version.to_string();
            let extensions_off =
                diagnostics::take_extensions_off(&dirs.data, cli.disable_extensions);
            let previous_version = diagnostics::record_version(&dirs.data, &version);
            log.write(
                "info",
                "app",
                &format!(
                    "Started {version} on {} {}{}{}",
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    if cfg!(debug_assertions) {
                        " (debug build)"
                    } else {
                        ""
                    },
                    match extensions_off {
                        Some(_) => ", extensions off",
                        None => "",
                    }
                ),
            );
            let session = ipc::diagnostics::SessionState {
                log,
                extensions_off,
                previous_version,
            };
            let audit = audit::AuditLog::new(&dirs.logs);
            let history = history::LocalHistory::new(&dirs.data);
            let data_dir = dirs.data.clone();
            // What the IDE's git checks before it runs (D392).
            git::guard::init(&dirs.data);
            // The browser pane as a debugging target (D204): WebView2 reads its extra arguments
            // when the first webview is created, below.
            #[cfg(windows)]
            if let Some(port) = debug::pane_port::load(&dirs.data) {
                std::env::set_var(
                    debug::pane_port::WEBVIEW2_ARGS_VAR,
                    debug::pane_port::browser_args(port),
                );
            }
            app.manage(AppState {
                dirs,
                workspace: fs::Workspace::default(),
                watcher: watch::Watcher::default(),
                settings_watcher: watch::Watcher::default(),
                docs_watcher: watch::Watcher::default(),
                skills_watcher: watch::Watcher::recursive(),
                agent_sessions_watcher: watch::Watcher::default(),
                index: index::FileIndex::default(),
                search: search::SearchService::default(),
                git: git::GitService::default(),
                mcp: mcp::McpService::default(),
                lsp: lsp::LspHost::default(),
                debug: debug::DebugSockets::default(),
                monitor_sockets: agent::socket::MonitorSockets::default(),
                ai: ai::AiService::default(),
                exec: std::sync::Arc::new(exec::ExecService::default()),
                pty: std::sync::Arc::new(pty::PtyManager::default()),
                audit,
                history,
                browser: browser::BrowserService::default(),
                extensions: extensions::ExtensionStore::new(&data_dir),
                process_start_ms,
                cli,
                dropped: std::sync::Mutex::new(Vec::new()),
                session,
                window_bounds: window_bounds::Tracker::default(),
            });
            // A remote window (`--remote`, D252): its paths are the remote's from the first call
            // on; the frontend connects before it opens the folder. The app's own folders stay
            // local wherever the window works.
            {
                let state = app.state::<AppState>();
                let mut local = vec![
                    state.dirs.data.clone(),
                    state.dirs.config.clone(),
                    state.dirs.logs.clone(),
                    std::env::temp_dir(),
                ];
                if let Ok(exe) = std::env::current_exe() {
                    if let Some(dir) = exe.parent() {
                        local.push(dir.to_path_buf());
                    }
                }
                remote::set_local_dirs(local);
                if let Some(authority) = &state.cli.remote {
                    if let Err(e) = remote::set_window_remote(authority) {
                        state.session.log.write("warn", "remote", &e.to_string());
                    }
                }
            }
            // This window in the registry of windows (D209): other launches find it, hand it
            // files, focus it for its folder; the first window of a session may reopen the
            // last session's (window.restoreWindows).
            {
                let state = app.state::<AppState>();
                let cli = &state.cli;
                let restore =
                    !cli.wants_something() && !cli.new_window && cli.test_script.is_none();
                if let Some(dir) = instances::registry_dir(cli.user_data_dir.as_deref()) {
                    if let Err(e) = instances::server::start(
                        app.handle(),
                        dir,
                        restore,
                        cli.restore_empty.clone(),
                    ) {
                        state.session.log.write(
                            "warn",
                            "windows",
                            &format!("No window registry: {e}"),
                        );
                    }
                }
                if !cli.files.is_empty()
                    || cli.diff.is_some()
                    || !cli.add.is_empty()
                    || cli.open_url.is_some()
                {
                    let add = cli
                        .add
                        .iter()
                        .map(|p| p.to_string_lossy().into_owned())
                        .collect();
                    instances::server::open_own(
                        cli.files.clone(),
                        cli.diff.clone(),
                        add,
                        cli.open_url.clone(),
                    );
                }
                // Links to the IDE open it (D255): the scheme registered for this user, pointing
                // at this program (an installed build; a development or test build doesn't).
                #[cfg(windows)]
                if !cfg!(debug_assertions) && cli.test_script.is_none() {
                    std::thread::spawn(|| {
                        if let Err(e) = url_scheme::register() {
                            eprintln!("Couldn't register the IDE's link scheme: {e}");
                        }
                    });
                }
            }
            // The title comes from product.json (via the generated tauri.conf.json) on every OS,
            // including macOS where the platform config overrides the window definition.
            let title = app.config().product_name.clone().unwrap_or_default();
            // The main window is built here (not from config) so it can open auxiliary windows.
            let main = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .cloned();
            if let Some(config) = main {
                let handle = app.handle().clone();
                let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
                    .on_new_window(move |url, features| {
                        aux_window::on_new_window(&handle, url, features)
                    });
                // Downloads from a browser tab's frame go to the IDE's list (macOS, Linux; on
                // Windows `attach_main` below follows them).
                let builder = browser::downloads::track(
                    builder,
                    app.state::<AppState>().browser.shared.clone(),
                );
                // Where it was last time (its folder's place when known, D229); a "New window"
                // and test runs start at the default size (they would cover the first window
                // exactly, or differ from run to run). A window the restore starts is its own.
                let state = app.state::<AppState>();
                let (builder, maximized) = if (state.cli.new_window && !state.cli.restored)
                    || state.cli.test_script.is_some()
                {
                    (builder, false)
                } else {
                    let folder = state
                        .cli
                        .folder
                        .as_ref()
                        .and_then(|f| std::fs::canonicalize(f).ok())
                        .map(|f| store::simplify(f).to_string_lossy().into_owned());
                    window_bounds::restore(
                        app.handle(),
                        &state.window_bounds,
                        &state.dirs.data,
                        folder.as_deref(),
                        builder,
                    )
                };
                let window = builder.build()?;
                dev_icon(&window);
                window_bounds::finish(&window, maximized);
                aux_window::allow_script_windows(app.handle());
                browser::allow_frame_cookies(&window);
                browser::downloads::attach_main(app.handle(), &window);
            }
            if let Some(window) = app.get_webview_window("main") {
                window.set_title(&title)?;
                accelerators::disable_browser_accelerators(&window);
                frame_guard::guard_frames(&window);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let Some(state) = window.try_state::<AppState>() {
                    match event {
                        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                            state.window_bounds.follow(window);
                            state
                                .window_bounds
                                .save_soon(window_folder(&state).as_deref());
                        }
                        // Files from the command line go to the window used last (D209).
                        tauri::WindowEvent::Focused(true) => instances::server::focused(),
                        tauri::WindowEvent::CloseRequested { .. }
                        | tauri::WindowEvent::Destroyed => {
                            state.window_bounds.save(window_folder(&state).as_deref())
                        }
                        _ => {}
                    }
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                if window.label().starts_with(browser::WINDOW_PREFIX) {
                    if let Some(state) = window.try_state::<AppState>() {
                        state.browser.shared.log.send(
                            browser::netlog::BrowserEvent::WindowClosed {
                                label: window.label().to_string(),
                            },
                        );
                    }
                }
            }
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(state) = window.try_state::<AppState>() {
                    if let Ok(mut dropped) = state.dropped.lock() {
                        dropped.clone_from(paths);
                    }
                }
            }
        })
        // With Tauri's multi-webview (`unstable`, for sites inside a browser tab) a window's
        // webview reports drops as a webview event, not a window event as above.
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if webview.label().starts_with(browser::WINDOW_PREFIX) {
                    return;
                }
                if let Some(state) = webview.try_state::<AppState>() {
                    if let Ok(mut dropped) = state.dropped.lock() {
                        dropped.clone_from(paths);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ipc::app::app_info,
            ipc::app::app_refresh_path,
            ipc::app::app_show_cursor,
            ipc::app::app_request_attention,
            ipc::app::test_log,
            ipc::app::app_exit,
            ipc::app::app_new_window,
            ipc::instances::instances_listen,
            ipc::instances::instances_done,
            ipc::instances::instances_focus_folder,
            ipc::instances::instances_restorable,
            ipc::instances::instances_adopt_empty,
            ipc::instances::instances_empty_backups_load,
            ipc::instances::instances_empty_backups_save,
            ipc::instances::instances_others_running,
            ipc::instances::shell_command_plan,
            ipc::instances::shell_command_install,
            ipc::instances::shell_command_uninstall,
            ipc::instances::jump_list_set,
            ipc::app::app_windows_alive,
            ipc::accounts::account_profile,
            ipc::accounts::account_check,
            ipc::accounts::account_sign_in,
            ipc::accounts::account_cancel,
            ipc::accounts::account_sign_out,
            ipc::accounts::account_avatar,
            ipc::app::state_load,
            ipc::app::state_save,
            ipc::app::audit_append,
            ipc::fs::workspace_open,
            ipc::fs::workspace_create_folder,
            ipc::fs::workspace_close,
            ipc::fs::workspace_folders_set,
            ipc::fs::workspace_folders,
            ipc::fs::workspace_set_file,
            ipc::fs::workspace_file_read,
            ipc::fs::workspace_file_write,
            ipc::fs::workspace_untitled_path,
            ipc::fs::fs_read,
            ipc::remote_image::remote_image,
            ipc::acp_agents::acp_registry_platform,
            ipc::acp_agents::acp_registry_fetch,
            ipc::acp_agents::acp_registry_cached,
            ipc::acp_agents::acp_registry_icon,
            ipc::acp_agents::acp_agent_install,
            ipc::acp_agents::acp_agent_cancel,
            ipc::acp_agents::acp_agent_remove,
            ipc::acp_agents::acp_agents_on_disk,
            ipc::fs::fs_start_drag,
            ipc::fs::fs_write,
            ipc::fs::encoding_encode,
            ipc::fs::encoding_guess,
            ipc::fs::fs_stat,
            ipc::fs::fs_list_dir,
            ipc::fs::fs_create_file,
            ipc::fs::fs_create_dir,
            ipc::fs::fs_rename,
            ipc::fs::fs_delete,
            ipc::history::history_list,
            ipc::history::history_read,
            ipc::history::history_restore,
            ipc::history::fs_trash,
            ipc::history::fs_untrash,
            ipc::history::fs_trash_exists,
            ipc::history::fs_trash_list,
            ipc::history::fs_hash,
            ipc::browser::browser_proxy,
            ipc::browser::screenshot_window,
            ipc::desktop::desktop_info,
            ipc::desktop::desktop_capture,
            ipc::desktop::desktop_window_at,
            ipc::desktop::desktop_input,
            ipc::desktop::desktop_banner,
            ipc::desktop::desktop_take_stop,
            ipc::browser::aux_window_label,
            ipc::extensions::ext_list,
            ipc::extensions::ext_peek,
            ipc::extensions::ext_registry_save,
            ipc::extensions::ext_read,
            ipc::extensions::ext_files,
            ipc::extensions::ext_install,
            ipc::extensions::ext_uninstall,
            ipc::extensions::ext_restore_bundled,
            ipc::extensions::ext_reinstall_bundled,
            ipc::process::notebook_output_origin,
            ipc::fs::workspace_allow_file,
            ipc::fs::workspace_allow_root,
            ipc::fs::workspace_forget_root,
            update::update_check,
            update::update_install,
            ipc::diagnostics::session_info,
            ipc::diagnostics::log_write,
            ipc::diagnostics::log_recent,
            ipc::diagnostics::log_git_commands,
            ipc::diagnostics::report_save_zip,
            ipc::diagnostics::app_relaunch,
            wsl::wsl_distros,
            wsl::wsl_home,
            ipc::remote::remote_connect,
            ipc::remote::remote_askpass_answer,
            ipc::remote::remote_disconnect,
            ipc::remote::remote_status,
            ipc::remote::remote_browse,
            ipc::remote::remote_log,
            ipc::remote::remote_hosts,
            ipc::remote::remote_forward_port,
            ipc::remote::remote_unforward,
            ipc::remote::remote_forwarded,
            ipc::remote::remote_listening,
            ipc::remote::remote_docker,
            ipc::remote::remote_set_docker,
            ipc::extensions::ext_download_git,
            ipc::extensions::ext_unpack_vsix,
            ipc::extensions::ext_discard_download,
            ipc::extensions::ext_store_search,
            ipc::extensions::ext_node_host_script,
            ipc::extensions::ext_store_details,
            ipc::extensions::ext_store_file,
            ipc::extensions::ext_store_download,
            ipc::extensions::ext_github_avatar,
            ipc::extensions::ext_delete_unpacked,
            ipc::extensions::ext_storage_load,
            ipc::extensions::ext_storage_save,
            ipc::extensions::ext_secret_get,
            ipc::extensions::ext_secret_set,
            ipc::extensions::ext_fetch,
            ipc::extensions::ext_webview_proxy,
            ipc::extensions::ext_node_status,
            ipc::extensions::ext_node_install,
            ipc::speech::speech_status,
            ipc::speech::speech_install,
            ipc::speech::speech_cancel,
            ipc::speech::speech_remove,
            ipc::speech::speech_transcribe,
            ipc::extensions::ext_webview_page,
            ipc::extensions::ext_webview_roots,
            ipc::browser::aux_window_close,
            ipc::browser::browser_proxy_stop_all,
            ipc::browser::browser_window_open,
            ipc::browser::browser_window_send,
            ipc::browser::browser_window_close,
            ipc::browser::browser_embed_open,
            ipc::browser::browser_embed_place,
            ipc::browser::browser_embed_focus,
            ipc::browser::browser_downloads,
            ipc::browser::browser_download_cancel,
            ipc::browser::browser_download_open,
            ipc::browser::browser_download_reveal,
            ipc::browser::browser_downloads_clear,
            ipc::browser::browser_bridge_post,
            ipc::browser::browser_subscribe,
            ipc::browser::net_port_open,
            ipc::browser::browser_network_body,
            ipc::browser::browser_bridge_source,
            ipc::browser::browser_trusted_input,
            ipc::browser::browser_set_no_cache,
            ipc::browser::browser_overlay,
            ipc::fs::index_query,
            ipc::fs::index_watch,
            ipc::fs::docs_watch_start,
            ipc::fs::docs_watch_set_dirs,
            ipc::fs::search_start,
            ipc::mcp::mcp_start,
            ipc::mcp::mcp_stop,
            ipc::mcp::mcp_info,
            ipc::mcp::mcp_stdio_proxy,
            ipc::mcp::mcp_set_catalog,
            ipc::mcp::mcp_respond,
            ipc::fs::search_cancel,
            ipc::fs::search_replace,
            ipc::fs::fs_move,
            ipc::fs::fs_copy,
            ipc::fs::fs_import_dropped,
            ipc::fs::fs_dropped_entries,
            ipc::fs::watch_start,
            ipc::fs::watch_set_dirs,
            ipc::fs::watch_stop,
            ipc::settings::settings_paths,
            ipc::settings::user_file_delete,
            ipc::settings::profile_save,
            ipc::settings::attachment_save,
            ipc::settings::profile_open,
            ipc::settings::settings_vscode_user,
            ipc::settings::settings_editor_profiles,
            ipc::mcp::mcp_remote_post,
            ipc::agent::agent_worktree_copy,
            ipc::agent::agent_worktree_run,
            ipc::agent::agent_monitor_socket_open,
            ipc::agent::agent_monitor_socket_close,
            ipc::agent::agent_worktree_diff,
            ipc::agent::agent_worktree_apply,
            ipc::agent::docs_index_save,
            ipc::agent::docs_index_load,
            ipc::agent::docs_index_delete,
            ipc::mcp::mcp_oauth_status,
            ipc::mcp::mcp_oauth_begin,
            ipc::mcp::mcp_oauth_finish,
            ipc::mcp::mcp_oauth_sign_out,
            ipc::mcp::mcp_remote_listen,
            ipc::mcp::mcp_remote_unlisten,
            ipc::mcp::ide_integration_start,
            ipc::mcp::ide_integration_update,
            ipc::mcp::ide_integration_stop,
            ipc::mcp::ide_integration_info,
            ipc::mcp::ide_integration_notify,
            ipc::mcp::ide_integration_respond,
            ipc::settings::mcp_discover,
            ipc::git::git_diff_range,
            ipc::settings::settings_watch_start,
            ipc::settings::settings_watch_set_dirs,
            ipc::skills::skills_delete_user,
            ipc::skills::skills_watch_start,
            ipc::skills::skills_watch_set_dirs,
            ipc::process::pty_spawn,
            ipc::process::pty_write,
            ipc::process::pty_resize,
            ipc::process::pty_ack,
            ipc::process::pty_kill,
            ipc::process::pty_commands,
            ipc::process::pty_profiles,
            ipc::process::pty_path_commands,
            ipc::process::pty_list_dir,
            ipc::process::pty_shell_globals,
            ipc::process::pty_attach,
            ipc::process::pty_detach,
            ipc::process::pty_kill_detached,
            ipc::git::git_open,
            ipc::git::git_init,
            ipc::git::git_watch,
            ipc::git::git_status,
            ipc::git::git_trust_settings,
            ipc::git::git_show,
            ipc::git::git_merge_base,
            ipc::git::git_write_index,
            ipc::git::git_stage,
            ipc::git::git_unstage,
            ipc::git::git_discard,
            ipc::git::git_commit,
            ipc::git::git_branches,
            ipc::git::git_checkout,
            ipc::git::git_log,
            ipc::git::git_remote,
            ipc::git::git_blame,
            ipc::git::git_stash_list,
            ipc::git::git_stash,
            ipc::git::git_clone,
            ipc::git::git_log_range,
            ipc::git::git_graph,
            ipc::git::git_worktrees,
            ipc::git::git_worktree_op,
            ipc::git::git_rebase_plan,
            ipc::git::git_rebase_interactive,
            ipc::git::git_askpass_listen,
            ipc::git::git_askpass_reply,
            ipc::git::github_cli,
            ipc::git::git_commit_detail,
            ipc::git::git_repo_op,
            ipc::git::git_repo_state,
            ipc::git::git_diff,
            ipc::git::git_discover,
            ipc::git::git_blame_file,
            ipc::git::git_log_lines,
            ipc::git::git_diff_names,
            ipc::git::git_rev_parse,
            ipc::git::git_merge_base_of,
            ipc::process::lsp_start,
            ipc::process::lsp_send,
            ipc::process::lsp_stop,
            ipc::process::lsp_close_stdin,
            ipc::process::lsp_interrupt,
            ipc::process::debug_socket_connect,
            ipc::process::debug_socket_send,
            ipc::process::debug_inspector_targets,
            ipc::process::debug_local_get,
            ipc::process::debug_socket_close,
            ipc::process::debug_dap_connect,
            ipc::process::debug_autoattach_prepare,
            ipc::process::debug_autoattach_take,
            ipc::process::debug_autoattach_dispose,
            ipc::process::debug_list_processes,
            ipc::process::debug_find_browser,
            ipc::process::debug_set_pane_port,
            ipc::agent::ai_list_models,
            ipc::agent::ai_model_details,
            ipc::agent::ai_chat,
            ipc::agent::ai_fim,
            ipc::agent::ai_image_generate,
            ipc::agent::agent_media_put,
            ipc::agent::agent_media_get,
            ipc::agent::ai_cancel,
            ipc::agent::web_fetch,
            ipc::agent::web_search,
            ipc::agent::attach_pick,
            ipc::agent::dropped_list,
            ipc::agent::dropped_read,
            ipc::agent::ai_set_key,
            ipc::agent::ai_has_key,
            ipc::agent::ai_transcribe,
            ipc::agent::ai_embed,
            ipc::process::exec_run,
            ipc::process::exec_cancel,
            ipc::process::exec_blocked_hosts,
            ipc::process::exec_sandbox_info,
            ipc::process::exec_sandbox_unhide,
            ipc::process::page_loaded,
            ipc::process::programs_installed,
            ipc::process::format_project,
            ipc::agent::ai_rate_limits,
            ipc::agent::ai_provider_limits,
            ipc::agent::usage_append,
            ipc::agent::usage_load,
            ipc::agent::usage_clear,
            ipc::agent::agent_scratch_dir,
            ipc::agent::agent_scratch_read,
            ipc::agent::agent_scratch_write,
            ipc::agent::agent_session_save,
            ipc::agent::agent_session_load,
            ipc::agent::agent_session_stamps,
            ipc::agent::agent_session_version,
            ipc::agent::agent_session_list,
            ipc::agent::agent_session_delete,
            ipc::agent::agent_report_put,
            ipc::agent::agent_report_list,
            ipc::agent::agent_report_claim,
            ipc::plugins::plugins_save_record,
            ipc::plugins::plugins_claude_info,
            ipc::plugins::plugins_npm,
            ipc::plugins::plugins_copy,
            ipc::plugins::plugins_clone,
            ipc::plugins::plugins_remove,
            ipc::notify::notify_webhook_post,
            ipc::notify::notify_webhook_store,
            ipc::agent_windows::agent_windows_publish,
            ipc::agent_windows::agent_windows_unpublish,
            ipc::agent_windows::agent_windows_list,
            ipc::agent_windows::agent_mail_put,
            ipc::agent_windows::agent_mail_list,
            ipc::agent_windows::agent_mail_claim,
            ipc::agent::agent_sessions_watch,
            ipc::agent::agent_sessions_unwatch,
            ipc::agent::docs_render,
            ipc::agent::docs_render_post,
            ipc::agent::agent_tree_stats,
            ipc::agent::agent_checkpoint_add,
            ipc::agent::agent_checkpoint_load,
        ])
        .build(tauri::generate_context!());

    match app {
        Ok(app) => app.run(|handle, event| {
            if let RunEvent::Exit = event {
                // Gone from the registry, or (the last window) kept for the next start (D209).
                instances::server::exiting();
                if let Some(state) = handle.try_state::<AppState>() {
                    state.pty.kill_all();
                    state.exec.cancel_all();
                    state.lsp.stop_all();
                    // The remote server ends what it started when its connection closes.
                    remote::disconnect();
                    // Also removes mcp.json.
                    let _ = state.mcp.stop();
                    // Claude Code's lock file (~/.claude/ide/<port>.lock) goes too, or /ide
                    // would list an IDE that's gone, with its token on disk.
                    let _ = state.mcp.ide.stop();
                    state.mcp.streams.stop_all();
                }
            }
        }),
        Err(err) => {
            eprintln!("failed to start: {err}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod launcher_tests {
    use super::npm_script_path;
    use std::path::Path;

    #[test]
    fn npm_script_paths() {
        assert!(npm_script_path(Path::new("/home/a/ide/node_modules/.bin")));
        assert!(npm_script_path(Path::new("/home/a/node_modules/.bin")));
        assert!(npm_script_path(Path::new(
            "/usr/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin"
        )));
        assert!(!npm_script_path(Path::new("/usr/local/bin")));
        assert!(!npm_script_path(Path::new("/home/a/.bin")));
    }
}

#[cfg(test)]
mod parent_editor_tests {
    #[test]
    fn another_editors_terminal_variables_are_recognized() {
        for k in [
            "TERM_PROGRAM",
            "TERM_PROGRAM_VERSION",
            "VSCODE_IPC_HOOK_CLI",
            "CLAUDE_CODE_SSE_PORT",
            "WT_SESSION",
        ] {
            assert!(super::inherited_editor_var(k), "{k}");
        }
        for k in ["PATH", "HOME", "GIT_AUTHOR_NAME", "TERM"] {
            assert!(!super::inherited_editor_var(k), "{k}");
        }
    }
}

/// A development build (`npm run dev`, debug) shows the orange logo in the taskbar and window
/// list, so it can be told apart from the installed app at a glance (D381); release builds keep
/// the normal one. Only the window's icon: the app's own logos are unchanged.
pub(crate) fn dev_icon<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    // Raw 256×256 RGBA (from the orange logo), in debug builds only: nothing to decode, and
    // release builds carry neither the pixels nor an image decoder.
    #[cfg(debug_assertions)]
    {
        let rgba = include_bytes!("../icons/dev-icon.rgba");
        let _ = window.set_icon(tauri::image::Image::new_owned(rgba.to_vec(), 256, 256));
    }
    #[cfg(not(debug_assertions))]
    let _ = window;
}
