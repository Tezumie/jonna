//! Stdio JSON-RPC host: spawns a process (language server, MCP server, ACP agent), frames messages
//! both ways and forwards every message to the webview over a Channel. Framing: LSP's
//! `Content-Length` headers, or newline-delimited JSON (MCP stdio, ACP). The protocols themselves
//! are TS (`src/core/lsp`, `src/core/mcp`, `src/core/acp`); Rust only moves bytes.

pub mod ctrl_c;
mod framing;

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSpec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Working directory (the workspace root).
    pub cwd: PathBuf,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub framing: Framing,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Framing {
    /// `Content-Length: N\r\n\r\n<json>` (LSP).
    #[default]
    Lsp,
    /// One JSON message per line (MCP stdio, ACP).
    Ndjson,
    /// A program's output, every line (the debugger's captured programs, VS Code's
    /// `internalConsole`); `${env:NAME}` in `env` is filled in, as for terminals.
    Lines,
    /// As `Lines`, but stdout and stderr are passed on as they come (line breaks kept), so a
    /// line printed without its end (a prompt, "Loading…") shows at once (the debugger's
    /// captured programs).
    Chunks,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LspEvent {
    /// One JSON-RPC message from the server (raw JSON text).
    Message {
        body: String,
    },
    /// A line the server wrote to stderr (its log).
    Stderr {
        line: String,
    },
    Exit {
        code: Option<i32>,
    },
}

struct Server {
    /// Tells this instance apart from a replacement started later under the same id.
    generation: u64,
    child: Child,
    /// Its own job (Windows): closed when it's stopped or reaped, ending what it started (D264).
    job: Option<crate::job::OwnJob>,
    /// None once closed (`close_stdin`: the program sees the end of its input).
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    framing: Framing,
}

/// On Windows, servers installed by npm/pip are often `.cmd` shims: look the name up on PATH with
/// PATHEXT. A shim is started by its path: Rust's std runs `.cmd` / `.bat` files through cmd.exe
/// itself and escapes their arguments for it (refusing ones it can't make safe), where our own
/// `cmd /C` broke on quoted paths and let `&`, `|`, `%` in arguments through (D203 audit).
#[cfg(windows)]
fn command_for(program: &str) -> Command {
    let path = std::path::Path::new(program);
    let has_ext = path.extension().is_some();
    if path.is_absolute() {
        // `C:\proj\node_modules\.bin\server`: its `.cmd` shim beside it.
        if !has_ext {
            let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
            for ext in exts.split(';').filter(|e| !e.is_empty()) {
                let candidate = PathBuf::from(format!("{program}{ext}"));
                if candidate.is_file() {
                    return Command::new(candidate);
                }
            }
        }
        return Command::new(program);
    }
    if !has_ext {
        let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let paths = std::env::var_os("PATH").unwrap_or_default();
        for dir in std::env::split_paths(&paths) {
            for ext in exts.split(';').filter(|e| !e.is_empty()) {
                let candidate = dir.join(format!("{program}{ext}"));
                if candidate.is_file() {
                    return Command::new(candidate);
                }
            }
        }
    }
    Command::new(program)
}

#[cfg(not(windows))]
fn command_for(program: &str) -> Command {
    Command::new(program)
}

/// A program named by a relative path (`./node_modules/.bin/server`, `bin\server.exe`) is the
/// one under the working directory: the OS would look for it under the IDE's own (Windows) or
/// leave it unspecified. A bare name is looked up on PATH as usual.
fn program_path(program: &str, cwd: &std::path::Path) -> String {
    let path = std::path::Path::new(program);
    if path.is_absolute() || !(program.contains('/') || program.contains('\\')) {
        return program.to_string();
    }
    cwd.join(path).to_string_lossy().into_owned()
}

type Servers = Arc<Mutex<HashMap<String, Server>>>;

/// Cheap to clone (shared state): the IPC commands hand a clone to a blocking thread, since
/// writing to a server's input, killing it and reaping it block (a full pipe, `taskkill`).
#[derive(Default, Clone)]
pub struct LspHost {
    /// Shared with each server's stdout thread, which reaps a server that exits on its own.
    servers: Servers,
    next_generation: Arc<AtomicU64>,
}

/// A process an extension owns (its Node host, or one it started): the ids the frontend gives them
/// (`extensions/workerHost.ts`, `extensions/runtimeProcess.ts`).
fn is_extension_process(id: &str) -> bool {
    id.starts_with("ext-node:") || id.starts_with("ext:")
}

/// Kills a server and everything it started, and reaps it.
fn kill_server(server: &mut Server) {
    // `.cmd` shims run under `cmd /C`: killing cmd alone would leave node.exe running.
    #[cfg(windows)]
    crate::exec::taskkill_tree(server.child.id());
    // Its own process group (see `start`): what it started goes too (D261: a Node extension's
    // language server or program was left running).
    #[cfg(unix)]
    if let Ok(pid) = i32::try_from(server.child.id()) {
        // SAFETY: kill(2) with a negative pid signals that process group; no memory involved.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = server.child.kill();
    let _ = server.child.wait();
    // Whatever it started that taskkill / the group missed (children of a `.cmd` shim's cmd.exe
    // already gone): its job ends them.
    server.job = None;
}

/// After a server closed its stdout: if `id` still names this instance (`generation`), take it
/// out of the map and reap it, returning its exit code. A server that keeps running without
/// stdout is useless, so it is killed after a short grace period.
fn reap_finished(servers: &Servers, id: &str, generation: u64) -> Option<i32> {
    let mut server = {
        let mut map = servers.lock().ok()?;
        if map.get(id).is_none_or(|s| s.generation != generation) {
            // `stop` already killed and reaped it, or a replacement now owns the id.
            return None;
        }
        map.remove(id)?
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match server.child.try_wait() {
            // Exited by itself (a crash): what it started goes too, with its job (D264).
            Ok(Some(status)) => {
                server.job = None;
                return status.code();
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                kill_server(&mut server);
                return None;
            }
        }
    }
}

impl LspHost {
    /// Starts server `id` (stopping an earlier one with that id).
    pub fn start(&self, id: &str, spec: ServerSpec, events: Channel<LspEvent>) -> Result<u32> {
        self.stop(id)?;
        // A remote window's folder (D252): the program runs there, through the relay, found on
        // the remote's PATH (a relative one under the folder, as the server starts it there).
        let remote = crate::remote::of_dir(&spec.cwd);
        let mut cmd = match &remote {
            Some(dir) => crate::remote::command(dir, &spec.command, &spec.args),
            None => {
                let mut c = command_for(&program_path(&spec.command, &spec.cwd));
                c.args(&spec.args).current_dir(&spec.cwd);
                c
            }
        };
        let env = spec.env.iter().map(|(k, v)| {
            let value = if matches!(spec.framing, Framing::Lines | Framing::Chunks) {
                crate::pty::expand_env(v)
            } else {
                v.clone()
            };
            (k.clone(), value)
        });
        cmd.envs(env)
            // The browser pane's debugging port is for the IDE's own webviews (D229).
            .env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if remote.is_some() {
            crate::remote::share_env(&mut cmd);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        // A group of its own, so stopping it stops what it started (kill_server).
        #[cfg(unix)]
        if remote.is_none() {
            std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        }
        // In the IDE's job before it runs (D180): language, MCP and agent servers end with it.
        let (mut child, job) = crate::job::spawn_owned(&mut cmd).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Error::Lsp(format!("{} was not found on PATH", spec.command))
            } else {
                Error::Lsp(format!("couldn't start {}: {e}", spec.command))
            }
        })?;
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| Error::Lsp("no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Lsp("no stdout".into()))?;
        if let Some(stderr) = child.stderr.take() {
            let events = events.clone();
            let chunked = spec.framing == Framing::Chunks;
            std::thread::spawn(move || {
                // Read to the end whatever it writes (bytes that aren't UTF-8 replaced, lines
                // cut at 8 KB): a stopped reader would fill the pipe and block the program.
                use std::io::Read;
                let mut reader = BufReader::new(stderr);
                if chunked {
                    let mut carry = Vec::new();
                    while let Ok(Some(line)) = framing::read_output_chunk(&mut reader, &mut carry) {
                        let _ = events.send(LspEvent::Stderr { line });
                    }
                    return;
                }
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match reader.by_ref().take(8192).read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    if buf.last() != Some(&b'\n') && buf.len() == 8192 {
                        // The rest of a long line is skipped.
                        let mut rest = Vec::new();
                        loop {
                            rest.clear();
                            match reader.by_ref().take(65536).read_until(b'\n', &mut rest) {
                                Ok(0) | Err(_) => break,
                                Ok(_) if rest.last() == Some(&b'\n') => break,
                                Ok(_) => {}
                            }
                        }
                    }
                    let text = String::from_utf8_lossy(&buf);
                    let line = text.trim_end_matches(['\r', '\n']).to_string();
                    let _ = events.send(LspEvent::Stderr { line });
                }
            });
        }
        let mode = spec.framing;
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let servers = self.servers.clone();
        let server_id = id.to_string();
        // Insert before the stdout thread can reach EOF, so a server that dies at once is reaped.
        // Two starts of one id at once: the one replaced here is killed, not left running.
        let replaced = self.lock()?.insert(
            id.to_string(),
            Server {
                generation,
                child,
                job: Some(job),
                stdin: Arc::new(Mutex::new(Some(stdin))),
                framing: spec.framing,
            },
        );
        if let Some(mut old) = replaced {
            kill_server(&mut old);
        }
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            // Chunks: the start of a UTF-8 character cut at a chunk's end, until the rest comes.
            let mut carry = Vec::new();
            loop {
                let next = match mode {
                    Framing::Lsp => framing::read_message(&mut reader),
                    Framing::Ndjson => framing::read_line_message(&mut reader),
                    Framing::Lines => framing::read_output_line(&mut reader),
                    Framing::Chunks => framing::read_output_chunk(&mut reader, &mut carry),
                };
                match next {
                    Ok(Some(body)) => {
                        if events.send(LspEvent::Message { body }).is_err() {
                            break;
                        }
                    }
                    _ => break,
                }
            }
            let code = reap_finished(&servers, &server_id, generation);
            let _ = events.send(LspEvent::Exit { code });
        });
        Ok(pid)
    }

    /// Sends one JSON-RPC message (framing added here).
    pub fn send(&self, id: &str, body: &str) -> Result<()> {
        let (stdin, mode) = self
            .lock()?
            .get(id)
            .map(|s| (s.stdin.clone(), s.framing))
            .ok_or_else(|| Error::Lsp(format!("{id} is not running")))?;
        let mut guard = stdin
            .lock()
            .map_err(|_| Error::Lsp("stdin lock poisoned".into()))?;
        let pipe = guard
            .as_mut()
            .ok_or_else(|| Error::Lsp(format!("{id}'s input is closed")))?;
        match mode {
            Framing::Lsp => framing::write_message(pipe, body),
            Framing::Ndjson | Framing::Lines | Framing::Chunks => {
                framing::write_line_message(pipe, body)
            }
        }
        .map_err(|e| Error::Lsp(format!("{id} stopped: {e}")))
    }

    /// Closes the program's input (it reads end-of-file), D203.
    pub fn close_stdin(&self, id: &str) -> Result<()> {
        let stdin = self
            .lock()?
            .get(id)
            .map(|s| s.stdin.clone())
            .ok_or_else(|| Error::Lsp(format!("{id} is not running")))?;
        let mut guard = stdin
            .lock()
            .map_err(|_| Error::Lsp("stdin lock poisoned".into()))?;
        *guard = None;
        Ok(())
    }

    /// Ctrl+C for the program (SIGINT), D203. On Windows, a Ctrl+C event on the program's own
    /// hidden console, sent by a helper process (`ctrl_c.rs`, D229).
    pub fn interrupt(&self, id: &str) -> Result<()> {
        let pid = self
            .lock()?
            .get(id)
            .map(|s| s.child.id())
            .ok_or_else(|| Error::Lsp(format!("{id} is not running")))?;
        #[cfg(unix)]
        {
            let pid = libc::pid_t::try_from(pid).map_err(|_| Error::Lsp("bad pid".into()))?;
            // SAFETY: kill(2) with a pid of a child this process started and still owns.
            if unsafe { libc::kill(pid, libc::SIGINT) } != 0 {
                return Err(Error::Lsp(format!("{id} couldn't be interrupted")));
            }
            Ok(())
        }
        #[cfg(windows)]
        {
            ctrl_c::send_ctrl_c(pid).map_err(Error::Lsp)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = pid;
            Err(Error::Lsp(
                "Interrupting a program isn't available here: send it a message instead.".into(),
            ))
        }
    }

    /// Kills server `id` (after the client's shutdown/exit, or right away).
    pub fn stop(&self, id: &str) -> Result<()> {
        // Take it out first so the lock isn't held while the process dies.
        let removed = self.lock()?.remove(id);
        if let Some(mut server) = removed {
            kill_server(&mut server);
        }
        Ok(())
    }

    /// Stops the open folder's servers when it closes (D270): an extension's own processes (its
    /// Node host `ext-node:…`, what it started `ext:…`) belong to the extension, which outlives
    /// the folder; killing them failed it ("Node ended").
    pub fn stop_folder_servers(&self) {
        let drained: Vec<Server> = match self.servers.lock() {
            Ok(mut servers) => {
                let ids: Vec<String> = servers
                    .keys()
                    .filter(|id| !is_extension_process(id))
                    .cloned()
                    .collect();
                ids.iter().filter_map(|id| servers.remove(id)).collect()
            }
            Err(_) => return,
        };
        for mut server in drained {
            kill_server(&mut server);
        }
    }

    pub fn stop_all(&self) {
        // Taken out first: the lock isn't held while the processes die (a send waiting on it
        // would wait for every kill).
        let drained: Vec<Server> = match self.servers.lock() {
            Ok(mut servers) => servers.drain().map(|(_, s)| s).collect(),
            Err(_) => return,
        };
        for mut server in drained {
            kill_server(&mut server);
        }
    }

    /// Runs `f` with a clone of the host on a blocking thread: a write to a server's input waits
    /// while its pipe is full, and stopping one kills and reaps a process tree; neither may hold
    /// up the async runtime's worker threads (every other IPC command runs on them).
    pub async fn blocking<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&LspHost) -> Result<T> + Send + 'static,
    {
        let host = self.clone();
        tauri::async_runtime::spawn_blocking(move || f(&host))
            .await
            .map_err(|e| Error::Lsp(format!("the stdio host's task failed: {e}")))?
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Server>>> {
        self.servers
            .lock()
            .map_err(|_| Error::Lsp("lock poisoned".into()))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn spawn_server(script: &str, generation: u64) -> Server {
        let mut child = Command::new("sh")
            .args(["-c", script])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        Server {
            generation,
            child,
            job: None,
            stdin: Arc::new(Mutex::new(Some(stdin))),
            framing: Framing::Lsp,
        }
    }

    #[test]
    fn relative_programs_are_under_the_working_directory() {
        let cwd = std::path::Path::new("/proj");
        assert_eq!(
            program_path("pyright-langserver", cwd),
            "pyright-langserver"
        );
        assert_eq!(program_path("/usr/bin/clangd", cwd), "/usr/bin/clangd");
        assert_eq!(
            program_path("./node_modules/.bin/server", cwd),
            "/proj/./node_modules/.bin/server"
        );
        assert_eq!(program_path("bin/server", cwd), "/proj/bin/server");
    }

    #[test]
    fn reaps_a_server_that_exited_but_not_its_replacement() {
        let servers: Servers = Arc::default();
        servers
            .lock()
            .unwrap()
            .insert("a".into(), spawn_server("exit 7", 1));
        assert_eq!(reap_finished(&servers, "a", 1), Some(7));
        assert!(servers.lock().unwrap().is_empty());
        // A replacement under the same id (newer generation) is left alone.
        servers
            .lock()
            .unwrap()
            .insert("a".into(), spawn_server("sleep 5", 2));
        assert_eq!(reap_finished(&servers, "a", 1), None);
        let mut map = servers.lock().unwrap();
        let mut replacement = map.remove("a").unwrap();
        assert_eq!(replacement.generation, 2);
        kill_server(&mut replacement);
    }

    #[test]
    fn closes_input_and_interrupts() {
        let host = LspHost::default();
        // `cat` ends when its input does.
        host.lock()
            .unwrap()
            .insert("cat".into(), spawn_server("cat >/dev/null", 1));
        host.close_stdin("cat").unwrap();
        assert!(host.send("cat", "{}").is_err());
        let mut done = false;
        for _ in 0..100 {
            let mut map = host.lock().unwrap();
            if let Some(s) = map.get_mut("cat") {
                if s.child.try_wait().unwrap().is_some() {
                    done = true;
                    break;
                }
            }
            drop(map);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(done, "cat didn't end after its input closed");
        // SIGINT ends a sleeping shell.
        host.lock()
            .unwrap()
            .insert("sleep".into(), spawn_server("sleep 30", 2));
        host.interrupt("sleep").unwrap();
        let mut ended = false;
        for _ in 0..100 {
            let mut map = host.lock().unwrap();
            if let Some(s) = map.get_mut("sleep") {
                if s.child.try_wait().unwrap().is_some() {
                    ended = true;
                    break;
                }
            }
            drop(map);
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(ended, "the program didn't stop on SIGINT");
        assert!(host.interrupt("missing").is_err());
        host.stop_all();
    }

    /// The IPC commands run on a clone in a blocking thread: it shares the servers.
    #[test]
    fn blocking_runs_on_a_clone_that_shares_the_servers() {
        let host = LspHost::default();
        host.lock()
            .unwrap()
            .insert("cat".into(), spawn_server("cat >/dev/null", 1));
        tauri::async_runtime::block_on(async {
            host.blocking(|h| h.send("cat", "{}")).await.unwrap();
            host.blocking(|h| h.stop("cat")).await.unwrap();
            assert!(host.blocking(|h| h.send("cat", "{}")).await.is_err());
        });
        assert!(host.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
mod folder_close_tests {
    use super::is_extension_process;

    /// Closing the folder keeps what extensions own (D270).
    #[test]
    fn extension_processes_outlive_the_folder() {
        assert!(is_extension_process("ext-node:anthropic.claude-code"));
        assert!(is_extension_process("ext:publisher.name:3"));
        assert!(!is_extension_process("typescript-language-server"));
        assert!(!is_extension_process("mcp:files"));
    }
}
