//! Programs a remote window runs (git, tasks, the agent's commands, language servers): their
//! callers build a `Command` as they always do, and `remote::command` makes it start the IDE's
//! own binary as a relay (`<exe> --remote-relay --cwd <dir> -- <program> <args…>`). The relay
//! connects to its window over loopback (`IDE_REMOTE_RELAY`: port and a per-window token),
//! asks it to start the program on the remote (`proc.spawn`), and passes standard input, output
//! and errors through; it exits with the program's exit code (a signal: 128 + its number).
//! Killing the relay (a timeout, Stop, `taskkill /T`) closes its socket, and the window kills
//! the program there. Ctrl+C sent to the relay's console reaches the program as SIGINT.
//!
//! Between the relay and the window, frames as in the protocol (`frame.rs`): the relay sends
//! `{ token, cwd, program, args, env }`, then `{ stdin }` (base64), `{ closeStdin: true }` and
//! `{ signal }`; the window answers `{ started: { pid } }` or `{ error }`, then `{ fd, data }`
//! and finally `{ exit: { code, signal } }` (or `{ error }` when the connection is lost).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};

use super::connection::StreamEvent;
use super::frame;
use crate::error::Result;

/// The relay's flag (internal; never in `--help`).
pub const RELAY_FLAG: &str = "--remote-relay";
/// `127.0.0.1:<port> <token>`: where the relay's window listens.
pub const ENV_RELAY: &str = "IDE_REMOTE_RELAY";
/// The variables (names, comma-separated) the relay passes on to the program, as WSLENV does.
pub const ENV_SHARED: &str = "IDE_REMOTE_ENV";

/// The window's side: a loopback listener relays connect to.
pub struct Listener {
    pub port: u16,
    pub token: String,
}

/// Starts the window's relay listener. `conn` gives the current connection to the remote (an
/// error while there is none).
pub fn listen(
    conn: impl Fn() -> Result<std::sync::Arc<super::connection::RemoteConn>> + Send + Sync + 'static,
) -> Result<Listener> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|e| crate::error::Error::Invalid(format!("no randomness: {e}")))?;
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let expected = token.clone();
    let conn = std::sync::Arc::new(conn);
    std::thread::Builder::new()
        .name("remote-relay-accept".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                let conn = conn.clone();
                let expected = expected.clone();
                let _ = std::thread::Builder::new()
                    .name("remote-relay".into())
                    .spawn(move || serve(stream, &expected, &*conn));
            }
        })?;
    Ok(Listener { port, token })
}

/// One relay: its spawn request, then its program's input and output until either side ends.
fn serve(
    mut socket: TcpStream,
    token: &str,
    conn: &dyn Fn() -> Result<std::sync::Arc<super::connection::RemoteConn>>,
) {
    let _ = socket.set_nodelay(true);
    let _ = socket.set_read_timeout(Some(Duration::from_secs(10)));
    let Ok(Some(request)) = frame::read_json(&mut socket) else {
        return;
    };
    let _ = socket.set_read_timeout(None);
    // A process that isn't this window's relay knows no token: it gets nothing.
    if !same_token(
        request.get("token").and_then(Value::as_str).unwrap_or(""),
        token,
    ) {
        return;
    }
    let conn = match conn() {
        Ok(c) => c,
        Err(e) => {
            let _ = frame::write_json(&mut socket, &json!({ "error": e.to_string() }));
            return;
        }
    };
    let params = json!({
        "cwd": request.get("cwd").cloned().unwrap_or(json!("")),
        "program": request.get("program").cloned().unwrap_or(json!("")),
        "args": request.get("args").cloned().unwrap_or(json!([])),
        "env": request.get("env").cloned().unwrap_or(json!({})),
    });
    let (tx, rx) = mpsc::channel();
    let started =
        conn.open_stream_blocking("proc.spawn", params, tx, super::connection::DEFAULT_TIMEOUT);
    let (stream, pid) = match started {
        Ok(v) => (
            v.get("stream").and_then(Value::as_u64).unwrap_or(0),
            v.get("pid").cloned().unwrap_or(Value::Null),
        ),
        Err(e) => {
            let _ = frame::write_json(&mut socket, &json!({ "error": e.to_string() }));
            return;
        }
    };
    if frame::write_json(&mut socket, &json!({ "started": { "pid": pid } })).is_err() {
        let _ = conn.notify("stream.kill", json!({ "stream": stream, "signal": "KILL" }));
        conn.forget_stream(stream);
        return;
    }
    // The relay's input → the program's.
    let Ok(mut from_relay) = socket.try_clone() else {
        let _ = conn.notify("stream.kill", json!({ "stream": stream, "signal": "KILL" }));
        return;
    };
    let input_conn = conn.clone();
    let exited = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let input_exited = exited.clone();
    let _ = std::thread::Builder::new()
        .name("remote-relay-in".into())
        .spawn(move || {
            loop {
                match frame::read_json(&mut from_relay) {
                    Ok(Some(m)) => {
                        if let Some(data) = m.get("stdin").and_then(Value::as_str) {
                            let bytes = base64::engine::general_purpose::STANDARD
                                .decode(data)
                                .unwrap_or_default();
                            let _ = input_conn.write_stream(stream, &bytes);
                        } else if m.get("closeStdin").is_some() {
                            let _ =
                                input_conn.notify("stream.closeStdin", json!({ "stream": stream }));
                        } else if let Some(signal) = m.get("signal").and_then(Value::as_str) {
                            let _ = input_conn.notify(
                                "stream.kill",
                                json!({ "stream": stream, "signal": signal }),
                            );
                        }
                    }
                    // The relay is gone (killed, or done): the program goes too, unless it
                    // already ended.
                    _ => {
                        if !input_exited.load(std::sync::atomic::Ordering::Acquire) {
                            let _ = input_conn.notify(
                                "stream.kill",
                                json!({ "stream": stream, "signal": "KILL" }),
                            );
                        }
                        break;
                    }
                }
            }
        });
    // The program's output → the relay.
    for event in rx {
        let message = match event {
            StreamEvent::Data { fd, bytes } => json!({
                "fd": fd,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
            StreamEvent::Exit { code, signal } => {
                exited.store(true, std::sync::atomic::Ordering::Release);
                let _ = frame::write_json(
                    &mut socket,
                    &json!({ "exit": { "code": code, "signal": signal } }),
                );
                break;
            }
            StreamEvent::Lost(reason) => {
                let _ = frame::write_json(
                    &mut socket,
                    &json!({ "error": super::connection::lost_error(&reason).to_string() }),
                );
                break;
            }
        };
        if frame::write_json(&mut socket, &message).is_err() {
            // The relay went away mid-output: the input thread kills the program.
            conn.forget_stream(stream);
            break;
        }
    }
    let _ = socket.shutdown(std::net::Shutdown::Both);
}

/// Token comparison that doesn't stop at the first difference.
fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// The relay's command line after the program: `--cwd <dir> -- <program> <args…>`.
pub fn relay_args(cwd: &str, program: &str, args: &[String]) -> Vec<String> {
    let mut out = vec![
        RELAY_FLAG.to_string(),
        "--cwd".to_string(),
        cwd.to_string(),
        "--".to_string(),
        program.to_string(),
    ];
    out.extend(args.iter().cloned());
    out
}

/// What a relay was asked to run.
#[derive(Debug, PartialEq, Eq)]
pub struct RelayCall {
    pub cwd: String,
    pub program: String,
    pub args: Vec<String>,
}

/// The relay's own arguments (after the program name), when this is a relay run.
pub fn parse_relay_args(args: &[String]) -> Option<RelayCall> {
    let mut it = args.iter();
    if it.next().map(String::as_str) != Some(RELAY_FLAG) {
        return None;
    }
    let mut cwd = String::new();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--cwd" => cwd = it.next()?.clone(),
            "--" => break,
            _ => return None,
        }
    }
    let program = it.next()?.clone();
    Some(RelayCall {
        cwd,
        program,
        args: it.cloned().collect(),
    })
}

/// The variables named in `IDE_REMOTE_ENV`, with their values here.
fn shared_env(names: &str, get: &dyn Fn(&str) -> Option<String>) -> HashMap<String, String> {
    names
        .split(',')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .filter_map(|n| get(n).map(|v| (n.to_string(), v)))
        .collect()
}

/// The socket the console's Ctrl+C handler sends SIGINT on (Windows).
#[cfg(windows)]
static INTERRUPT: std::sync::Mutex<Option<TcpStream>> = std::sync::Mutex::new(None);

#[cfg(windows)]
unsafe extern "system" fn on_ctrl(kind: u32) -> windows::core::BOOL {
    // CTRL_C_EVENT (0) and CTRL_BREAK_EVENT (1): the program gets SIGINT; the relay lives on to
    // pass on what the program does about it.
    if kind <= 1 {
        if let Ok(mut socket) = INTERRUPT.lock() {
            if let Some(s) = socket.as_mut() {
                let _ = frame::write_json(s, &json!({ "signal": "INT" }));
            }
        }
        return windows::core::BOOL(1);
    }
    windows::core::BOOL(0)
}

/// Started as a relay (`--remote-relay`): runs the program on the window's remote and returns
/// its exit code. None for any other start.
pub fn client() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let call = parse_relay_args(&args)?;
    Some(match run_client(call) {
        Ok(code) => code,
        Err(message) => {
            let _ = writeln!(std::io::stderr(), "{message}");
            255
        }
    })
}

fn run_client(call: RelayCall) -> std::result::Result<i32, String> {
    let spec =
        std::env::var(ENV_RELAY).map_err(|_| "Not started by a remote window.".to_string())?;
    let (addr, token) = spec
        .split_once(' ')
        .ok_or_else(|| "Bad relay address.".to_string())?;
    let mut socket = TcpStream::connect(addr)
        .map_err(|e| format!("The remote window isn't reachable ({e})."))?;
    let _ = socket.set_nodelay(true);
    let env = shared_env(&std::env::var(ENV_SHARED).unwrap_or_default(), &|n| {
        std::env::var(n).ok()
    });
    frame::write_json(
        &mut socket,
        &json!({
            "token": token,
            "cwd": call.cwd,
            "program": call.program,
            "args": call.args,
            "env": env,
        }),
    )
    .map_err(|e| e.to_string())?;
    match frame::read_json(&mut socket) {
        Ok(Some(m)) if m.get("started").is_some() => {}
        Ok(Some(m)) => {
            let error = m.get("error").and_then(Value::as_str).unwrap_or("refused");
            // As a shell says when a program can't start.
            let _ = writeln!(std::io::stderr(), "{error}");
            return Ok(127);
        }
        _ => return Err("The remote window didn't answer.".into()),
    }
    #[cfg(windows)]
    {
        if let (Ok(clone), Ok(mut slot)) = (socket.try_clone(), INTERRUPT.lock()) {
            *slot = Some(clone);
        }
        // SAFETY: registers a plain function as this process's console control handler. Ctrl+C
        // processing is switched back on first: a parent that ignored it passes that on.
        unsafe {
            use windows::Win32::System::Console::SetConsoleCtrlHandler;
            let _ = SetConsoleCtrlHandler(None, false);
            let _ = SetConsoleCtrlHandler(Some(on_ctrl), true);
        }
    }
    // Standard input → the program, until it ends.
    if let Ok(mut to_window) = socket.try_clone() {
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin().lock();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => {
                        let _ = frame::write_json(&mut to_window, &json!({ "closeStdin": true }));
                        break;
                    }
                    Ok(n) => {
                        let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        if frame::write_json(&mut to_window, &json!({ "stdin": data })).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    loop {
        match frame::read_json(&mut socket) {
            Ok(Some(m)) => {
                if let Some(data) = m.get("data").and_then(Value::as_str) {
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(data)
                        .unwrap_or_default();
                    // A reader that went away (the caller stopped reading) isn't the program's
                    // failure: its output is dropped and the exit code still comes.
                    if m.get("fd").and_then(Value::as_u64) == Some(2) {
                        let _ = stderr.write_all(&bytes).and_then(|()| stderr.flush());
                    } else {
                        let _ = stdout.write_all(&bytes).and_then(|()| stdout.flush());
                    }
                } else if let Some(exit) = m.get("exit") {
                    let code = exit
                        .get("code")
                        .and_then(Value::as_i64)
                        .and_then(|c| i32::try_from(c).ok());
                    let signal = exit
                        .get("signal")
                        .and_then(Value::as_i64)
                        .and_then(|c| i32::try_from(c).ok());
                    return Ok(StreamEvent::exit_code(code, signal));
                } else if let Some(error) = m.get("error").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
            }
            _ => return Err("The connection to the remote window ended.".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_arguments_round_trip() {
        let args = relay_args(
            "/home/me/app",
            "git",
            &["-c".into(), "x=--cwd".into(), "--".into()],
        );
        assert_eq!(
            args,
            [
                RELAY_FLAG,
                "--cwd",
                "/home/me/app",
                "--",
                "git",
                "-c",
                "x=--cwd",
                "--"
            ]
        );
        assert_eq!(
            parse_relay_args(&args),
            Some(RelayCall {
                cwd: "/home/me/app".into(),
                program: "git".into(),
                args: vec!["-c".into(), "x=--cwd".into(), "--".into()],
            })
        );
        // The login shell: an empty program.
        let shell = relay_args("", "", &["-c".into(), "ls".into()]);
        assert_eq!(
            parse_relay_args(&shell).map(|c| c.program),
            Some(String::new())
        );
        assert_eq!(parse_relay_args(&["/some/folder".into()]), None);
        assert_eq!(
            parse_relay_args(&[RELAY_FLAG.into(), "--what".into()]),
            None
        );
    }

    #[test]
    fn only_listed_variables_are_passed_on() {
        let get = |n: &str| match n {
            "TERM" => Some("dumb".to_string()),
            "CI" => Some("1".to_string()),
            _ => None,
        };
        let env = shared_env("TERM, CI,,MISSING", &get);
        assert_eq!(env.len(), 2);
        assert_eq!(env.get("TERM").map(String::as_str), Some("dumb"));
        assert!(same_token("abc", "abc") && !same_token("abc", "abd") && !same_token("ab", "abc"));
    }
}
