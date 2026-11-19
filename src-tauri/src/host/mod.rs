//! The windowless host: the IDE's services with no window, answering the same commands the
//! desktop front end calls, over a byte stream (a command-line agent, a remote editor).
//!
//! The stream is the process's stdin/stdout (the default) or one TCP connection on loopback
//! (`--listen`, with a token). `frame.rs` is the wire's frame, `server.rs` one client's
//! connection, `stdio.rs` keeps the process's own pipes clean. The commands are the common list
//! in `lib.rs` (`all_commands!`), called through the adapters the `#[tauri::command]` attribute
//! of the stand-in framework writes.
//!
//! The host uses the same app folders as the desktop app (by the app's identifier), or
//! `--user-data-dir` like it: the same settings, keys, sessions and history.

mod frame;
pub mod server;
mod stdio;
mod ws;

use std::ffi::OsString;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::error::{Error, Result};
use crate::AppState;
use server::{Carrier, Ended, Server};

/// The most WebSocket upgrades answered at once; more are closed unread.
const MAX_UPGRADES: usize = 8;

/// How long a TCP host waits for its client to come back before it exits.
const DEFAULT_LINGER: Duration = Duration::from_secs(60);

/// The token of a TCP client, when no `--token-file` is given.
const TOKEN_VAR: &str = "IDE_HOST_TOKEN";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Info {
    Help,
    Version,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Options {
    /// `--listen <address>`: serve one TCP client at a time there, not the process's pipes.
    pub listen: Option<SocketAddr>,
    /// `--listen-ws <address>`: as `--listen`, with the wire inside WebSocket messages, for a
    /// client that is a page in a browser.
    pub listen_ws: bool,
    /// `--allow-origin <origin>`: a page of this origin may connect (`--listen-ws`). Repeatable.
    pub allow_origins: Vec<String>,
    /// `--allow-host <name>`: a name this host is reached by beside loopback (`--listen-ws`):
    /// the public name of a proxy in front of it. Repeatable.
    pub allow_hosts: Vec<String>,
    /// `--token-file <path>`: the file holding the token a TCP client must send.
    pub token_file: Option<PathBuf>,
    /// `--user-data-dir <dir>`: settings and state there, as the desktop app's flag.
    pub user_data_dir: Option<PathBuf>,
    /// `--disable-extensions`: this session runs no extensions, as the desktop app's flag.
    pub disable_extensions: bool,
    /// `--linger <seconds>`: how long a TCP host outlives its client.
    pub linger: Duration,
    pub info: Option<Info>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            listen: None,
            listen_ws: false,
            allow_origins: Vec::new(),
            allow_hosts: Vec::new(),
            token_file: None,
            user_data_dir: None,
            disable_extensions: false,
            linger: DEFAULT_LINGER,
            info: None,
        }
    }
}

/// The arguments after the program's name.
pub fn parse_args(
    args: impl IntoIterator<Item = OsString>,
) -> std::result::Result<Options, String> {
    let mut options = Options::default();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let name = arg.to_string_lossy().into_owned();
        let mut value = |what: &str| {
            args.next()
                .ok_or_else(|| format!("{name} needs {what} after it"))
        };
        match name.as_str() {
            "--stdio" => {
                options.listen = None;
                options.listen_ws = false;
            }
            "--listen" | "--listen-ws" => {
                let text = value("an address (127.0.0.1:<port>)")?;
                let text = text.to_string_lossy();
                let address: SocketAddr = text
                    .parse()
                    .map_err(|_| format!("{name}: {text} isn't an address like 127.0.0.1:0"))?;
                if !address.ip().is_loopback() {
                    return Err(format!(
                        "{name}: {text} isn't a loopback address (127.0.0.1 or [::1])"
                    ));
                }
                // A page reaches this computer as 127.0.0.1 or localhost only (its content
                // policy names those), so a WebSocket host on [::1] could never be used.
                if name == "--listen-ws" && !address.is_ipv4() {
                    return Err(format!(
                        "{name}: {text} isn't 127.0.0.1 (a page in a browser reaches only that)"
                    ));
                }
                options.listen = Some(address);
                options.listen_ws = name == "--listen-ws";
            }
            "--allow-origin" => {
                let text = value("an origin (https://example.com)")?;
                let origin = text.to_string_lossy().trim_end_matches('/').to_string();
                // An origin is a scheme and a host, nothing after: a path would never match.
                let ok = ["https://", "http://"].iter().any(|scheme| {
                    origin.strip_prefix(scheme).is_some_and(|rest| {
                        !rest.is_empty() && !rest.contains(['/', '@', '?', '#'])
                    })
                });
                if !ok {
                    return Err(format!(
                        "--allow-origin: {origin} isn't an origin like https://example.com"
                    ));
                }
                options.allow_origins.push(origin);
            }
            "--allow-host" => {
                let text = value("a host name (dev.example.com)")?;
                let host = text.to_string_lossy().to_string();
                // A name or an address, as a Host header carries it without its port.
                let ok = !host.is_empty()
                    && host
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
                    && host.chars().any(|c| c.is_ascii_alphanumeric());
                if !ok {
                    return Err(format!(
                        "--allow-host: {host} isn't a host name like dev.example.com (no scheme, no port)"
                    ));
                }
                options.allow_hosts.push(host);
            }
            "--token-file" => options.token_file = Some(PathBuf::from(value("a file")?)),
            "--user-data-dir" => options.user_data_dir = Some(PathBuf::from(value("a folder")?)),
            "--disable-extensions" => options.disable_extensions = true,
            "--linger" => {
                let text = value("a number of seconds")?;
                let seconds: u64 = text
                    .to_string_lossy()
                    .parse()
                    .map_err(|_| "--linger needs a number of seconds".to_string())?;
                options.linger = Duration::from_secs(seconds);
            }
            "--help" | "-h" => options.info = Some(Info::Help),
            "--version" | "-v" => options.info = Some(Info::Version),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(options)
}

/// What `--help` prints.
pub fn help_text(name: &str, version: &str) -> String {
    format!(
        "{name} {version}

The IDE's services without a window: answers the IDE's commands over a byte stream.

Usage: {name} [options]

Options:
      --listen <127.0.0.1:port>  Serve one client at a time over TCP on loopback (port 0:
                                 any free port) instead of this process's stdin and stdout.
                                 The port is printed on stderr: \"host: listening on <address>\".
      --listen-ws <127.0.0.1:port>
                                 As --listen, for a page in a browser: the same stream inside
                                 WebSocket messages. Printed as \"host: listening on ws://<address>\".
      --allow-origin <origin>    A page of this origin may connect over --listen-ws
                                 (https://example.com). Repeatable; none: no page may.
      --allow-host <name>        A name this host is reached by beside 127.0.0.1, over
                                 --listen-ws: the public name of a proxy that carries TLS
                                 in front of it (dev.example.com). Repeatable.
      --token-file <file>        The file with the token a client must send
                                 (or the {TOKEN_VAR} variable). Required with --listen
                                 and --listen-ws.
      --linger <seconds>         How long to wait for a TCP client to reconnect before
                                 exiting (default {}).
      --user-data-dir <dir>      Use this folder for settings and state (a separate profile).
      --disable-extensions       Run this session without extensions.
  -v, --version                  Print the version.
  -h, --help                     Print this help.
",
        DEFAULT_LINGER.as_secs()
    )
}

/// product.json's identifier (the app's folders are named after it) and long name.
fn product() -> (String, String) {
    let product: serde_json::Value =
        serde_json::from_str(include_str!("../../../product.json")).unwrap_or_default();
    let text = |key: &str, fallback: &str| {
        product
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or(fallback)
            .to_string()
    };
    (text("identifier", "ide"), text("nameLong", "ide"))
}

/// The program's own name, for its messages.
fn program_name() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "ide-host".into())
}

/// The host program: parses its arguments, serves until the client is done, exits with the
/// returned code. The program's helper modes (git's prompt, the remote relay…) are answered
/// before this, in `host_program` (lib.rs).
pub fn main() -> i32 {
    let options = match parse_args(std::env::args_os().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("{}: {message} (--help lists the options)", program_name());
            return 2;
        }
    };
    let version = env!("CARGO_PKG_VERSION");
    match options.info {
        Some(Info::Help) => {
            print!("{}", help_text(&program_name(), version));
            return 0;
        }
        Some(Info::Version) => {
            println!("{version}\n{}", std::env::consts::ARCH);
            return 0;
        }
        None => {}
    }
    match run(options, version) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("host: {e}");
            1
        }
    }
}

/// The token a TCP client must send: the file's content, else the variable's (which is then
/// removed, so programs the host starts don't get it).
fn read_token(options: &Options) -> Result<String> {
    let token = match &options.token_file {
        Some(file) => std::fs::read_to_string(file)
            .map_err(|e| Error::Invalid(format!("--token-file {}: {e}", file.display())))?,
        None => {
            let token = std::env::var(TOKEN_VAR).unwrap_or_default();
            std::env::remove_var(TOKEN_VAR);
            token
        }
    };
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(Error::Invalid(format!(
            "--listen needs a token: --token-file <file> or the {TOKEN_VAR} variable"
        )));
    }
    Ok(token)
}

fn run(options: Options, version: &str) -> Result<()> {
    let started_ms = crate::now_ms();
    // The client's stream first, before anything can write to stdout or start a program.
    let pipes = match options.listen {
        None => Some(stdio::take()?),
        Some(_) => None,
    };
    let listener = match options.listen {
        Some(address) => {
            let token = read_token(&options)?;
            let listener = TcpListener::bind(address)?;
            let origins = options.listen_ws.then(|| ws::Allowed {
                origins: options.allow_origins.clone(),
                hosts: options.allow_hosts.clone(),
            });
            Some((listener, token, origins))
        }
        None => None,
    };

    let (identifier, product_name) = product();
    let app = tauri::AppHandle::new(&identifier, &product_name, version);
    // The desktop app's rule: the flag, else the variable a throwaway profile is started with.
    let user_data_dir = options.user_data_dir.clone().or_else(|| {
        std::env::var_os("IDE_USER_DATA_DIR")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    });
    let dirs = crate::store::AppDirs::resolve(&app, user_data_dir.as_deref())?;
    let cli = crate::cli::CliArgs {
        user_data_dir,
        disable_extensions: options.disable_extensions,
        ..Default::default()
    };
    let session = crate::open_session(&dirs, &cli, version);
    session
        .log
        .write("info", "app", "Running as the windowless host");
    app.manage(AppState::new(dirs, cli, started_ms, session));
    let state = app.state::<AppState>();
    state.set_local_dirs();

    let server = Server::new(app.clone(), crate::host_commands(), version);
    tauri::async_runtime::block_on(async {
        tokio::select! {
            _ = serve(&server, pipes, listener, options.linger) => {}
            _ = stop_signal() => {}
        }
    });
    // What the desktop does on exit: everything the services started ends with the host.
    state.shutdown();
    state
        .session
        .log
        .write("info", "app", "The windowless host stopped");
    Ok(())
}

/// Serves the process's pipes until they close, or TCP clients one after another until one
/// asks for shutdown or none comes back in time.
async fn serve(
    server: &Server,
    pipes: Option<(std::fs::File, std::fs::File)>,
    listener: Option<(TcpListener, String, Option<ws::Allowed>)>,
    linger: Duration,
) {
    if let Some((input, output)) = pipes {
        let carrier = Carrier {
            reader: Box::new(input),
            writer: Box::new(output),
            hang_up: Box::new(|| {}),
        };
        let _ = server.serve(carrier, None).await;
        return;
    }
    let Some((listener, token, origins)) = listener else {
        return;
    };
    match listener.local_addr() {
        // One line a launcher can parse for the port.
        Ok(address) if origins.is_some() => eprintln!("host: listening on ws://{address}"),
        Ok(address) => eprintln!("host: listening on {address}"),
        Err(e) => eprintln!("host: listening ({e})"),
    }
    // One client at a time: while one is served, others are closed at once.
    let busy = Arc::new(AtomicBool::new(false));
    let (accepted, mut clients) =
        tokio::sync::mpsc::unbounded_channel::<std::io::Result<Carrier>>();
    {
        let busy = busy.clone();
        // Upgrades being answered. Each waits on its client (five seconds at most) on a
        // thread of its own, and none of them holds the host's one place: any website can
        // open a socket here, and a request that will be refused must not keep the real
        // page out while it is read.
        let upgrading = Arc::new(AtomicUsize::new(0));
        let accepting = std::thread::Builder::new()
            .name("host-accept".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else {
                        // Out of sockets, say: wait a moment rather than spin.
                        std::thread::sleep(Duration::from_millis(200));
                        continue;
                    };
                    let Some(allowed) = origins.clone() else {
                        if busy.swap(true, Ordering::SeqCst) {
                            drop(stream);
                            continue;
                        }
                        if accepted.send(tcp_carrier(stream)).is_err() {
                            return;
                        }
                        continue;
                    };
                    // While a client is served nobody else is answered at all, as on TCP: a
                    // second tab's socket never opens, so its code is never sent.
                    if busy.load(Ordering::SeqCst) {
                        drop(stream);
                        continue;
                    }
                    if upgrading.fetch_add(1, Ordering::SeqCst) >= MAX_UPGRADES {
                        upgrading.fetch_sub(1, Ordering::SeqCst);
                        drop(stream);
                        continue;
                    }
                    let (busy, upgrading, accepted) =
                        (busy.clone(), upgrading.clone(), accepted.clone());
                    let upgrade = std::thread::Builder::new()
                        .name("host-upgrade".into())
                        .spawn({
                            let upgrading = upgrading.clone();
                            move || {
                                let made = ws::accept(stream, &allowed);
                                upgrading.fetch_sub(1, Ordering::SeqCst);
                                match made {
                                    // The place is taken only by a page that was let in.
                                    Ok(carrier) => {
                                        if busy.swap(true, Ordering::SeqCst) {
                                            (carrier.hang_up)();
                                        } else {
                                            let _ = accepted.send(Ok(carrier));
                                        }
                                    }
                                    Err(e) => eprintln!("host: a client's connection failed: {e}"),
                                }
                            }
                        });
                    if upgrade.is_err() {
                        upgrading.fetch_sub(1, Ordering::SeqCst);
                    }
                }
            });
        if let Err(e) = accepting {
            eprintln!("host: couldn't listen: {e}");
            return;
        }
    }
    // When the last client left. Only one that said `$/hello` with the token counts: another
    // connection neither starts the wait nor makes it longer.
    let mut client_left: Option<Instant> = None;
    loop {
        let carrier = match client_left {
            Some(left) => {
                let wait = linger.saturating_sub(left.elapsed());
                match tokio::time::timeout(wait, clients.recv()).await {
                    Ok(Some(carrier)) => carrier,
                    // Nobody came back.
                    _ => return,
                }
            }
            None => match clients.recv().await {
                Some(carrier) => carrier,
                None => return,
            },
        };
        let served = match carrier {
            Ok(carrier) => Some(server.serve(carrier, Some(&token)).await),
            Err(e) => {
                eprintln!("host: a client's connection failed: {e}");
                None
            }
        };
        // The place is free again, however the connection went (no hello in time, too).
        busy.store(false, Ordering::SeqCst);
        let Some(served) = served else { continue };
        if served.ended == Ended::Shutdown {
            return;
        }
        if served.greeted {
            client_left = Some(Instant::now());
        }
    }
}

fn tcp_carrier(stream: TcpStream) -> std::io::Result<Carrier> {
    let _ = stream.set_nodelay(true);
    let reader = stream.try_clone()?;
    let writer = stream.try_clone()?;
    Ok(Carrier {
        reader: Box::new(reader),
        writer: Box::new(writer),
        hang_up: Box::new(move || {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }),
    })
}

/// Resolves when the process is asked to stop: Ctrl+C; SIGTERM on Unix; on Windows also
/// Ctrl+Break and the console's end (its window closed, the user logging off, the system
/// shutting down), after which Windows gives the process a few seconds, enough for the
/// host's own shutdown.
async fn stop_signal() {
    #[cfg(windows)]
    {
        use tokio::signal::windows::{ctrl_break, ctrl_close, ctrl_logoff, ctrl_shutdown};
        // One that can't be listened for never comes: the others, and the stream's end, still
        // stop the host.
        macro_rules! heard {
            ($listen:expr) => {
                async {
                    match $listen {
                        Ok(mut events) => {
                            events.recv().await;
                        }
                        Err(_) => std::future::pending::<()>().await,
                    }
                }
            };
        }
        let interrupted = async {
            if tokio::signal::ctrl_c().await.is_err() {
                std::future::pending::<()>().await;
            }
        };
        tokio::select! {
            _ = interrupted => {}
            _ = heard!(ctrl_break()) => {}
            _ = heard!(ctrl_close()) => {}
            _ = heard!(ctrl_logoff()) => {}
            _ = heard!(ctrl_shutdown()) => {}
        }
    }
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        // A signal that can't be listened for never resolves (the stream's end stops the
        // host); resolving on the error would stop a host that was never asked to.
        let interrupt = async {
            if tokio::signal::ctrl_c().await.is_err() {
                std::future::pending::<()>().await;
            }
        };
        let terminate = async {
            match signal(SignalKind::terminate()) {
                Ok(mut terminate) => {
                    if terminate.recv().await.is_none() {
                        std::future::pending::<()>().await;
                    }
                }
                Err(_) => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = interrupt => {}
            _ = terminate => {}
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        if tokio::signal::ctrl_c().await.is_err() {
            // No way to hear it: never resolve, the stream's end stops the host.
            std::future::pending::<()>().await;
        }
    }
}

#[cfg(test)]
mod folders_tests;
#[cfg(test)]
mod shim_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> std::result::Result<Options, String> {
        parse_args(list.iter().map(OsString::from))
    }

    #[test]
    fn no_arguments_is_stdio_with_the_apps_own_folders() {
        assert_eq!(args(&[]), Ok(Options::default()));
        assert_eq!(args(&["--stdio"]), Ok(Options::default()));
    }

    #[test]
    fn the_flags_are_read() {
        let options = args(&[
            "--listen",
            "127.0.0.1:0",
            "--token-file",
            "t.txt",
            "--user-data-dir",
            "profile",
            "--linger",
            "5",
            "--disable-extensions",
        ])
        .unwrap_or_default();
        assert_eq!(options.listen, "127.0.0.1:0".parse().ok());
        assert_eq!(options.token_file, Some(PathBuf::from("t.txt")));
        assert_eq!(options.user_data_dir, Some(PathBuf::from("profile")));
        assert_eq!(options.linger, Duration::from_secs(5));
        assert!(options.disable_extensions);
        assert_eq!(args(&["-v"]).map(|o| o.info), Ok(Some(Info::Version)));
        assert_eq!(args(&["--help"]).map(|o| o.info), Ok(Some(Info::Help)));
    }

    #[test]
    fn only_loopback_addresses_are_listened_on() {
        assert!(args(&["--listen", "0.0.0.0:4000"]).is_err());
        assert!(args(&["--listen", "192.168.1.5:4000"]).is_err());
        assert!(args(&["--listen", "[::1]:4000"]).is_ok());
        assert!(args(&["--listen", "nonsense"]).is_err());
    }

    /// A TCP host with no commands, a short wait for `$/hello` and `linger`; answers its
    /// address and its thread, which ends when the host would exit.
    fn tcp_host(linger: Duration) -> (SocketAddr, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let host = std::thread::spawn(move || {
            let app = tauri::AppHandle::new("dev.example.app", "Example", "9.9.9");
            let server = Server::new(app, &[], "9.9.9")
                .with_waits(Duration::from_millis(300), Duration::from_secs(5));
            tauri::async_runtime::block_on(serve(
                &server,
                None,
                Some((listener, "secret".to_string(), None)),
                linger,
            ));
        });
        (address, host)
    }

    /// Connects and says `$/hello` with the token; the answer's header, when one came.
    fn hello(address: SocketAddr) -> Option<(TcpStream, serde_json::Value)> {
        let mut stream = TcpStream::connect(address).ok()?;
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .ok()?;
        let header = serde_json::json!({
            "id": 1, "method": "$/hello", "params": { "protocol": 1, "token": "secret" }
        });
        frame::write_frame(&mut stream, header.to_string().as_bytes(), b"").ok()?;
        let answer = frame::read_frame(&mut stream).ok()??;
        let answer = serde_json::from_slice(&answer.header).ok()?;
        Some((stream, answer))
    }

    #[test]
    fn a_silent_connection_gives_the_place_back_and_is_no_client() {
        let (address, host) = tcp_host(Duration::from_millis(400));
        // It holds the one place: the real client is closed at once.
        let silent = TcpStream::connect(address).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        assert!(hello(address).is_none());
        // Not for long, and its going doesn't start the wait for a client to come back: the
        // host is still there well past `--linger`.
        std::thread::sleep(Duration::from_millis(1200));
        assert!(!host.is_finished());
        let (stream, answer) = hello(address).expect("the place is free again");
        assert_eq!(answer["result"]["protocol"], 1);
        // The real client leaves: now the host waits, then exits.
        drop(stream);
        let left = Instant::now();
        host.join().unwrap();
        assert!(left.elapsed() >= Duration::from_millis(300));
        drop(silent);
    }

    #[test]
    fn unknown_and_incomplete_arguments_are_errors() {
        assert!(args(&["--frobnicate"]).is_err());
        assert!(args(&["--listen"]).is_err());
        assert!(args(&["some-folder"]).is_err());
    }

    #[test]
    fn a_page_is_named_by_its_origin_and_a_proxy_by_its_host_name() {
        let options = args(&[
            "--listen-ws",
            "127.0.0.1:0",
            "--allow-origin",
            "https://app.example.com/",
            "--allow-host",
            "dev.example.com",
        ])
        .unwrap();
        assert!(options.listen_ws);
        assert_eq!(options.allow_origins, ["https://app.example.com"]);
        assert_eq!(options.allow_hosts, ["dev.example.com"]);
        // An origin has no path; a host name has no scheme and no path.
        assert!(args(&["--allow-origin", "https://app.example.com/app"]).is_err());
        assert!(args(&["--allow-origin", "app.example.com"]).is_err());
        assert!(args(&["--allow-host", "https://dev.example.com"]).is_err());
        assert!(args(&["--allow-host", "dev.example.com/x"]).is_err());
        assert!(args(&["--allow-host", ""]).is_err());
    }
}
