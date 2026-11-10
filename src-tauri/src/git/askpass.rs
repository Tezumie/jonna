//! Sign-in prompts for git (D139): HTTPS usernames/passwords/tokens and ssh passphrases when no
//! credential helper answers (Linux and macOS without one; Windows has Git Credential Manager).
//!
//! git asks `$GIT_ASKPASS "<prompt>"` and reads the answer from its stdout; ssh does the same with
//! `$SSH_ASKPASS`. Both point at the IDE's own binary: started that way (the env below is set),
//! `client()` connects back to a listener on 127.0.0.1, sends the prompt with a per-run token, and
//! prints what the user typed. The listener hands the prompt to the frontend through a Channel and
//! waits (up to five minutes) for `reply`. Nothing is stored; the answer only passes through.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::error::{Error, Result};

const ENV_PORT: &str = "IDE_ASKPASS_PORT";
const ENV_TOKEN: &str = "IDE_ASKPASS_TOKEN";
/// How long a prompt waits for the user before git gets "cancelled".
const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskpassRequest {
    pub id: u64,
    /// "ask", or "cancel" when git stopped waiting (the prompt should close).
    pub kind: &'static str,
    pub prompt: String,
    /// Mask the input (passwords, tokens, passphrases; not usernames or yes/no questions).
    pub secret: bool,
}

#[derive(Serialize, Deserialize)]
struct Ask {
    token: String,
    prompt: String,
}

#[derive(Serialize, Deserialize)]
struct Answer {
    value: Option<String>,
}

struct Server {
    port: u16,
    token: String,
    exe: PathBuf,
}

static SERVER: OnceLock<Server> = OnceLock::new();
static FRONTEND: Mutex<Option<Channel<AskpassRequest>>> = Mutex::new(None);
static PENDING: OnceLock<Mutex<HashMap<u64, mpsc::Sender<Option<String>>>>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn pending() -> &'static Mutex<HashMap<u64, mpsc::Sender<Option<String>>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether a prompt asks for something to hide.
pub fn is_secret(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    !(p.starts_with("username") || p.contains("(yes/no") || p.contains("[fingerprint]"))
}

/// Prompts that come with another token than git's go to the handler registered for it (D252:
/// ssh's sign-in for a remote window goes to that connection's progress channel).
type RouteHandler = std::sync::Arc<dyn Fn(AskpassRequest) -> bool + Send + Sync>;
static ROUTES: Mutex<Option<HashMap<String, RouteHandler>>> = Mutex::new(None);

/// The frontend is ready for prompts: starts the listener (once) and routes prompts to `channel`.
pub fn listen(channel: Channel<AskpassRequest>) -> Result<()> {
    *FRONTEND
        .lock()
        .map_err(|_| Error::Invalid("askpass lock".into()))? = Some(channel);
    start_server()
}

/// A route of its own for prompts (D252): the variables that make a program's askpass calls come
/// to `handler` (it returns false when it can't show them), and the token that names the route
/// (to `unroute` once the program no longer asks).
pub fn route(handler: RouteHandler) -> Result<(String, Vec<(String, String)>)> {
    start_server()?;
    let server = SERVER
        .get()
        .ok_or_else(|| Error::Invalid("askpass not started".into()))?;
    let token = random_token()?;
    ROUTES
        .lock()
        .map_err(|_| Error::Invalid("askpass lock".into()))?
        .get_or_insert_with(HashMap::new)
        .insert(token.clone(), handler);
    let env = vec![
        (
            "SSH_ASKPASS".to_string(),
            server.exe.to_string_lossy().into_owned(),
        ),
        (ENV_PORT.to_string(), server.port.to_string()),
        (ENV_TOKEN.to_string(), token.clone()),
    ];
    Ok((token, env))
}

/// Forgets a route: its program's later prompts are answered "cancelled".
pub fn unroute(token: &str) {
    if let Ok(mut routes) = ROUTES.lock() {
        if let Some(map) = routes.as_mut() {
            map.remove(token);
        }
    }
}

fn random_token() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| Error::Invalid(format!("no randomness: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The loopback listener the askpass program talks to (started once).
fn start_server() -> Result<()> {
    if SERVER.get().is_some() {
        return Ok(());
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let token = random_token()?;
    let exe = std::env::current_exe()?;
    if SERVER.set(Server { port, token, exe }).is_err() {
        return Ok(()); // another call won the race; its listener serves
    }
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let _ = serve(stream);
            });
        }
    });
    Ok(())
}

/// The user's answer to prompt `id` (None: cancelled).
pub fn reply(id: u64, value: Option<String>) {
    if let Ok(mut map) = pending().lock() {
        if let Some(tx) = map.remove(&id) {
            let _ = tx.send(value);
        }
    }
}

fn serve(stream: TcpStream) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut line = String::new();
    // A prompt is a line of text; anything bigger isn't one.
    BufReader::new(std::io::Read::take(&stream, 64 * 1024)).read_line(&mut line)?;
    let ask: Ask =
        serde_json::from_str(line.trim()).map_err(|e| Error::Invalid(format!("askpass: {e}")))?;
    let server = SERVER
        .get()
        .ok_or_else(|| Error::Invalid("askpass not started".into()))?;
    let value = if ask.token == server.token {
        ask_frontend(ask.prompt)
    } else {
        let handler = ROUTES
            .lock()
            .ok()
            .and_then(|r| r.as_ref().and_then(|m| m.get(&ask.token).cloned()));
        match handler {
            Some(handler) => ask_route(&handler, ask.prompt),
            None => None,
        }
    };
    let mut out = &stream;
    let text = serde_json::to_string(&Answer { value })
        .map_err(|e| Error::Invalid(format!("askpass: {e}")))?;
    out.write_all(text.as_bytes())?;
    out.write_all(b"\n")?;
    Ok(())
}

/// Asks a route's handler and waits for `reply` with its id (the same timeout as git's).
fn ask_route(handler: &RouteHandler, prompt: String) -> Option<String> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending().lock().ok()?.insert(id, tx);
    let secret = is_secret(&prompt);
    let shown = handler(AskpassRequest {
        id,
        kind: "ask",
        prompt,
        secret,
    });
    let answer = if shown {
        match rx.recv_timeout(ANSWER_TIMEOUT) {
            Ok(value) => value,
            Err(_) => {
                handler(AskpassRequest {
                    id,
                    kind: "cancel",
                    prompt: String::new(),
                    secret: false,
                });
                None
            }
        }
    } else {
        None
    };
    if let Ok(mut map) = pending().lock() {
        map.remove(&id);
    }
    answer
}

fn ask_frontend(prompt: String) -> Option<String> {
    let channel = FRONTEND.lock().ok()?.clone()?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending().lock().ok()?.insert(id, tx);
    let secret = is_secret(&prompt);
    let sent = channel
        .send(AskpassRequest {
            id,
            kind: "ask",
            prompt,
            secret,
        })
        .is_ok();
    let answer = if sent {
        match rx.recv_timeout(ANSWER_TIMEOUT) {
            Ok(value) => value,
            Err(_) => {
                // Nobody answered in time: git gives up, so the prompt should close too.
                let _ = channel.send(AskpassRequest {
                    id,
                    kind: "cancel",
                    prompt: String::new(),
                    secret: false,
                });
                None
            }
        }
    } else {
        None
    };
    if let Ok(mut map) = pending().lock() {
        map.remove(&id);
    }
    answer
}

/// Points git's and ssh's prompts at the IDE (once the frontend listens), unless the user set
/// their own askpass program.
pub fn apply_env(cmd: &mut Command) {
    let Some(server) = SERVER.get() else { return };
    // The listener may run for a remote window's sign-in alone (D252): git's prompts need the
    // frontend's own listener.
    if FRONTEND.lock().map(|f| f.is_none()).unwrap_or(true) {
        return;
    }
    let unset = |name: &str| std::env::var_os(name).is_none_or(|v| v.is_empty());
    if unset("GIT_ASKPASS") {
        cmd.env("GIT_ASKPASS", &server.exe);
    }
    if unset("SSH_ASKPASS") {
        cmd.env("SSH_ASKPASS", &server.exe)
            .env("SSH_ASKPASS_REQUIRE", "prefer");
    }
    cmd.env(ENV_PORT, server.port.to_string())
        .env(ENV_TOKEN, &server.token);
}

/// The IDE binary started as git's or ssh's askpass: asks the running IDE and prints the answer.
/// Returns the exit code, or None when this isn't an askpass run (start the app as usual).
pub fn client() -> Option<i32> {
    let port: u16 = std::env::var(ENV_PORT).ok()?.parse().ok()?;
    let token = std::env::var(ENV_TOKEN).ok()?;
    let mut args = std::env::args().skip(1);
    let prompt = args.next()?;
    // `ide <folder>` started from a git hook inherits the variables: that's a normal start.
    if args.next().is_some() || std::path::Path::new(&prompt).is_dir() {
        return None;
    }
    // ssh's notice-only call (a security key waiting for a touch): nothing to answer.
    if std::env::var("SSH_ASKPASS_PROMPT").is_ok_and(|v| v == "none") {
        return Some(0);
    }
    let answer = (|| -> std::io::Result<Option<String>> {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port))?;
        let ask = serde_json::to_string(&Ask { token, prompt }).map_err(std::io::Error::other)?;
        stream.write_all(ask.as_bytes())?;
        stream.write_all(b"\n")?;
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line)?;
        let answer: Answer = serde_json::from_str(line.trim()).map_err(std::io::Error::other)?;
        Ok(answer.value)
    })();
    match answer {
        Ok(Some(value)) => {
            println!("{value}");
            Some(0)
        }
        _ => Some(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_masked_but_usernames_and_questions_not() {
        assert!(!is_secret("Username for 'https://github.com': "));
        assert!(is_secret("Password for 'https://me@github.com': "));
        assert!(is_secret(
            "Enter passphrase for key '/home/me/.ssh/id_ed25519': "
        ));
        assert!(!is_secret(
            "Are you sure you want to continue connecting (yes/no/[fingerprint])? "
        ));
    }
}
