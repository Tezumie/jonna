//! Dev containers (D266): docker (or the devcontainers CLI) run with arguments, never through a
//! shell, for the frontend's plan (`src/core/workspace/devContainer.ts`): finding, building and
//! starting a folder's container, its lifecycle commands, the containers to attach to. The
//! container transport (`transport.rs`, `container:<user@id>`) runs `docker exec` with the same
//! program, which the `remote.containers.dockerPath` setting can name.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::RwLock;

use serde::Serialize;
use tauri::ipc::Channel;

use crate::error::{Error, Result};

/// The docker program the setting names (None: `docker` on PATH).
static DOCKER: RwLock<Option<PathBuf>> = RwLock::new(None);

/// What a run printed on stdout is kept up to this size (container lists, ids, JSON answers).
const MAX_STDOUT: usize = 4 * 1024 * 1024;

/// Sets the docker program (`remote.containers.dockerPath`); empty or None: `docker` on PATH.
pub fn set_program(path: Option<String>) {
    let path = path.filter(|p| !p.trim().is_empty()).map(PathBuf::from);
    if let Ok(mut d) = DOCKER.write() {
        *d = path;
    }
}

/// The docker program: the setting's, else `docker` found on PATH (or the login shell's).
pub fn program() -> PathBuf {
    if let Some(p) = DOCKER.read().ok().and_then(|d| d.clone()) {
        return p;
    }
    crate::exec::format::find_program("docker").unwrap_or_else(|| PathBuf::from("docker"))
}

/// One run's end: its exit code (None: ended by a signal) and its standard output.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerRun {
    pub code: Option<i32>,
    pub stdout: String,
}

/// Runs `docker <args>` (`tool` "docker") or `devcontainer <args>` (`tool` "devcontainer") in
/// `cwd`; every line of output (stdout and stderr) goes to `on_output` as it comes, stdout is
/// also returned. Blocking: called on a blocking thread.
pub fn run(
    tool: &str,
    args: &[String],
    cwd: Option<&str>,
    on_output: &Channel<String>,
) -> Result<DockerRun> {
    let program = match tool {
        "docker" => program(),
        "devcontainer" => crate::exec::format::find_program("devcontainer").ok_or_else(|| {
            Error::Exec(
                "The devcontainers CLI isn't installed: npm install -g @devcontainers/cli".into(),
            )
        })?,
        other => {
            return Err(Error::Invalid(format!(
                "{other} isn't docker or devcontainer"
            )))
        }
    };
    let mut cmd = Command::new(&program);
    cmd.args(args)
        .env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = cmd.spawn().map_err(|e| {
        Error::Exec(if e.kind() == std::io::ErrorKind::NotFound {
            match tool {
                "docker" => "Docker isn't installed (or isn't on PATH): install Docker Desktop or Docker Engine, or set remote.containers.dockerPath.".to_string(),
                _ => "The devcontainers CLI isn't installed: npm install -g @devcontainers/cli".to_string(),
            }
        } else {
            format!("Couldn't start {}: {e}", program.display())
        })
    })?;
    let stderr = child.stderr.take().map(|err| {
        let out = on_output.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).split(b'\n').map_while(|l| l.ok()) {
                let _ = out.send(String::from_utf8_lossy(&line).trim_end().to_string());
            }
        })
    });
    let mut stdout = String::new();
    if let Some(out) = child.stdout.take() {
        let mut reader = BufReader::new(out);
        let mut line = Vec::new();
        loop {
            line.clear();
            match reader.by_ref().take(64 * 1024).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&line);
                    let _ = on_output.send(text.trim_end().to_string());
                    if stdout.len() + text.len() <= MAX_STDOUT {
                        stdout.push_str(&text);
                    }
                }
            }
        }
    }
    let status = child.wait()?;
    if let Some(t) = stderr {
        let _ = t.join();
    }
    Ok(DockerRun {
        code: status.code(),
        stdout,
    })
}
