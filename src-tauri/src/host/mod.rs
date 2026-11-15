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

use std::ffi::OsString;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::Manager;

use crate::error::{Error, Result};
use crate::AppState;
use server::{Carrier, Ended, Server};

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
            "--stdio" => options.listen = None,
            "--listen" => {
                let text = value("an address (127.0.0.1:<port>)")?;
                let text = text.to_string_lossy();
                let address: SocketAddr = text
                    .parse()
                    .map_err(|_| format!("--listen: {text} isn't an address like 127.0.0.1:0"))?;
                if !address.ip().is_loopback() {
                    return Err(format!(
                        "--listen: {text} isn't a loopback address (127.0.0.1 or [::1])"
                    ));
                }
                options.listen = Some(address);
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
      --token-file <file>        The file with the token a TCP client must send
                                 (or the {TOKEN_VAR} variable). Required with --listen.
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
            Some((listener, token))
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
    listener: Option<(TcpListener, String)>,
    linger: Duration,
) {
    if let Some((input, output)) = pipes {
        let carrier = Carrier {
            reader: Box::new(input),
            writer: Box::new(output),
            hang_up: Box::new(|| {}),
        };
        server.serve(carrier, None).await;
        return;
    }
    let Some((listener, token)) = listener else {
        return;
    };
    match listener.local_addr() {
        // One line a launcher can parse for the port.
        Ok(address) => eprintln!("host: listening on {address}"),
        Err(e) => eprintln!("host: listening ({e})"),
    }
    // One client at a time: while one is served, others are closed at once.
    let busy = Arc::new(AtomicBool::new(false));
    let (accepted, mut clients) = tokio::sync::mpsc::unbounded_channel::<TcpStream>();
    {
        let busy = busy.clone();
        let accepting = std::thread::Builder::new()
            .name("host-accept".into())
            .spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else {
                        // Out of sockets, say: wait a moment rather than spin.
                        std::thread::sleep(Duration::from_millis(200));
                        continue;
                    };
                    if busy.swap(true, Ordering::SeqCst) {
                        drop(stream);
                        continue;
                    }
                    if accepted.send(stream).is_err() {
                        return;
                    }
                }
            });
        if let Err(e) = accepting {
            eprintln!("host: couldn't listen: {e}");
            return;
        }
    }
    let mut had_client = false;
    loop {
        let stream = if had_client {
            match tokio::time::timeout(linger, clients.recv()).await {
                Ok(Some(stream)) => stream,
                // Nobody came back.
                _ => return,
            }
        } else {
            match clients.recv().await {
                Some(stream) => stream,
                None => return,
            }
        };
        had_client = true;
        let ended = match tcp_carrier(stream) {
            Ok(carrier) => server.serve(carrier, Some(&token)).await,
            Err(e) => {
                eprintln!("host: a client's connection failed: {e}");
                Ended::Closed
            }
        };
        busy.store(false, Ordering::SeqCst);
        if ended == Ended::Shutdown {
            return;
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

/// Resolves when the process is asked to stop (Ctrl+C; SIGTERM on Unix).
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
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

    #[test]
    fn unknown_and_incomplete_arguments_are_errors() {
        assert!(args(&["--frobnicate"]).is_err());
        assert!(args(&["--listen"]).is_err());
        assert!(args(&["some-folder"]).is_err());
    }
}
