//! A terminal in a remote window: the server opens a pty there (`proc.spawn` with `pty`) and its
//! bytes come and go over the connection. The terminal manager (`crate::pty`) treats it like a
//! local console: a reader, a writer, a child to wait for and kill, a size to set. Not a relay
//! process in a local ConPTY: the release build is a GUI program, which a ConPTY can't host as a
//! console client, and the remote pty already does what ConPTY would (one renderer, real
//! resizes, the remote's own line discipline).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::Duration;

use portable_pty::{CommandBuilder, ExitStatus};
use serde_json::{json, Value};

use super::connection::{RemoteConn, StreamEvent, DEFAULT_TIMEOUT};
use crate::error::{Error, Result};

#[derive(Default)]
struct Input {
    stream: Option<u64>,
    /// What was typed before the program started (sent once it has).
    early: Vec<u8>,
}

#[derive(Default)]
struct ExitSlot {
    code: Mutex<Option<u32>>,
    done: Condvar,
}

impl ExitSlot {
    fn set(&self, code: u32) {
        if let Ok(mut c) = self.code.lock() {
            c.get_or_insert(code);
            self.done.notify_all();
        }
    }

    fn get(&self) -> Option<u32> {
        self.code.lock().ok().and_then(|c| *c)
    }

    fn wait(&self) -> u32 {
        let Ok(mut code) = self.code.lock() else {
            return 1;
        };
        loop {
            if let Some(c) = *code {
                return c;
            }
            code = match self.done.wait(code) {
                Ok(c) => c,
                Err(_) => return 1,
            };
        }
    }
}

pub struct RemotePty {
    conn: Arc<RemoteConn>,
    input: Arc<Mutex<Input>>,
    exit: Arc<ExitSlot>,
    events: Mutex<Option<mpsc::Sender<StreamEvent>>>,
    output: Mutex<Option<mpsc::Receiver<StreamEvent>>>,
    rows: u16,
    cols: u16,
}

impl RemotePty {
    /// A terminal of `rows` × `cols` on the window's remote (its program starts with `spawn`).
    pub fn open(rows: u16, cols: u16) -> Result<RemotePty> {
        let conn = super::conn()?;
        let (tx, rx) = mpsc::channel();
        Ok(RemotePty {
            conn,
            input: Arc::default(),
            exit: Arc::default(),
            events: Mutex::new(Some(tx)),
            output: Mutex::new(Some(rx)),
            rows,
            cols,
        })
    }

    /// The terminal's output (ends when the program does) and input.
    pub fn io(&self) -> Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
        let rx = self
            .output
            .lock()
            .ok()
            .and_then(|mut o| o.take())
            .ok_or_else(|| Error::Pty("the terminal's output is taken".into()))?;
        let reader = StreamReader {
            rx,
            buf: Vec::new(),
            pos: 0,
            exit: self.exit.clone(),
        };
        let writer = StreamWriter {
            conn: self.conn.clone(),
            input: self.input.clone(),
        };
        Ok((Box::new(reader), Box::new(writer)))
    }

    /// Starts `cmd` there: its program (none: the user's interactive login shell), arguments,
    /// folder and the variables set on it.
    pub fn spawn(
        &self,
        cmd: &CommandBuilder,
    ) -> Result<Box<dyn portable_pty::Child + Send + Sync>> {
        let (program, args) = program_of(cmd);
        let cwd = cmd
            .get_cwd()
            .map(|c| c.to_string_lossy().into_owned())
            .unwrap_or_default();
        let env: HashMap<String, Option<String>> = cmd
            .iter_extra_env_as_str()
            .filter(|(k, _)| !super::shared_names([*k]).is_empty())
            .map(|(k, v)| (k.to_string(), Some(v.to_string())))
            .collect();
        let events = self
            .events
            .lock()
            .ok()
            .and_then(|mut e| e.take())
            .ok_or_else(|| Error::Pty("the terminal started already".into()))?;
        let started = self.conn.open_stream_blocking(
            "proc.spawn",
            json!({
                "cwd": cwd,
                "program": program,
                "args": args,
                "env": env,
                "pty": { "rows": self.rows, "cols": self.cols },
            }),
            events,
            DEFAULT_TIMEOUT,
        )?;
        let stream = started
            .get("stream")
            .and_then(Value::as_u64)
            .ok_or_else(|| Error::Pty("the remote started no terminal".into()))?;
        if let Ok(mut input) = self.input.lock() {
            input.stream = Some(stream);
            let early = std::mem::take(&mut input.early);
            if !early.is_empty() {
                let _ = self.conn.write_stream(stream, &early);
            }
        }
        Ok(Box::new(RemoteChild {
            exit: self.exit.clone(),
            killer: RemoteKiller {
                conn: self.conn.clone(),
                stream,
                exit: self.exit.clone(),
            },
        }))
    }

    pub fn resize(&self, rows: u16, cols: u16) {
        let stream = self.input.lock().ok().and_then(|i| i.stream);
        if let Some(stream) = stream {
            let _ = self.conn.notify(
                "stream.resize",
                json!({ "stream": stream, "rows": rows.max(1), "cols": cols.max(1) }),
            );
        }
    }
}

/// The program and arguments a command builder names (none: the login shell, `""`).
fn program_of(cmd: &CommandBuilder) -> (String, Vec<String>) {
    if cmd.is_default_prog() {
        return (String::new(), Vec::new());
    }
    let mut argv = cmd
        .get_argv()
        .iter()
        .map(|a| a.to_string_lossy().into_owned());
    let program = argv.next().unwrap_or_default();
    (program, argv.collect())
}

struct StreamReader {
    rx: mpsc::Receiver<StreamEvent>,
    buf: Vec<u8>,
    pos: usize,
    exit: Arc<ExitSlot>,
}

impl Read for StreamReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        while self.pos >= self.buf.len() {
            match self.rx.recv() {
                Ok(StreamEvent::Data { bytes, .. }) => {
                    self.buf = bytes;
                    self.pos = 0;
                }
                Ok(StreamEvent::Exit { code, signal }) => {
                    let code = StreamEvent::exit_code(code, signal);
                    self.exit.set(u32::try_from(code).unwrap_or(1));
                    return Ok(0);
                }
                Ok(StreamEvent::Lost(_)) | Err(_) => {
                    self.exit.set(255);
                    return Ok(0);
                }
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

struct StreamWriter {
    conn: Arc<RemoteConn>,
    input: Arc<Mutex<Input>>,
}

impl Write for StreamWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut input = self
            .input
            .lock()
            .map_err(|_| std::io::Error::other("terminal lock poisoned"))?;
        match input.stream {
            Some(stream) => self
                .conn
                .write_stream(stream, buf)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::BrokenPipe, e.to_string()))?,
            None => input.early.extend_from_slice(buf),
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Debug)]
struct RemoteChild {
    exit: Arc<ExitSlot>,
    killer: RemoteKiller,
}

impl std::fmt::Debug for ExitSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ExitSlot({:?})", self.get())
    }
}

#[derive(Clone)]
struct RemoteKiller {
    conn: Arc<RemoteConn>,
    stream: u64,
    exit: Arc<ExitSlot>,
}

impl std::fmt::Debug for RemoteKiller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RemoteKiller({})", self.stream)
    }
}

impl portable_pty::ChildKiller for RemoteKiller {
    /// A closed terminal: SIGHUP to its session (as a terminal emulator closing), SIGKILL a
    /// moment later for a program that ignores it.
    fn kill(&mut self) -> std::io::Result<()> {
        let _ = self.conn.notify(
            "stream.kill",
            json!({ "stream": self.stream, "signal": "HUP" }),
        );
        let killer = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            if killer.exit.get().is_none() {
                let _ = killer.conn.notify(
                    "stream.kill",
                    json!({ "stream": killer.stream, "signal": "KILL" }),
                );
            }
        });
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

impl portable_pty::ChildKiller for RemoteChild {
    fn kill(&mut self) -> std::io::Result<()> {
        self.killer.kill()
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(self.killer.clone())
    }
}

impl portable_pty::Child for RemoteChild {
    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        Ok(self.exit.get().map(ExitStatus::with_exit_code))
    }

    fn wait(&mut self) -> std::io::Result<ExitStatus> {
        Ok(ExitStatus::with_exit_code(self.exit.wait()))
    }

    /// No local process: the IDE must never `taskkill` a remote pid here.
    fn process_id(&self) -> Option<u32> {
        None
    }

    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_login_shell_is_the_default_program() {
        assert_eq!(
            program_of(&CommandBuilder::new_default_prog()),
            (String::new(), vec![])
        );
        let mut cmd = CommandBuilder::new("bash");
        cmd.arg("-c");
        cmd.arg("ls");
        assert_eq!(
            program_of(&cmd),
            ("bash".into(), vec!["-c".into(), "ls".into()])
        );
    }

    #[test]
    fn output_then_the_exit_code() {
        let (tx, rx) = mpsc::channel();
        let exit = Arc::new(ExitSlot::default());
        let mut reader = StreamReader {
            rx,
            buf: Vec::new(),
            pos: 0,
            exit: exit.clone(),
        };
        tx.send(StreamEvent::Data {
            fd: 1,
            bytes: b"hello".to_vec(),
        })
        .unwrap();
        tx.send(StreamEvent::Exit {
            code: None,
            signal: Some(1),
        })
        .unwrap();
        let mut out = String::new();
        reader.read_to_string(&mut out).unwrap();
        assert_eq!(out, "hello");
        assert_eq!(exit.get(), Some(129));
        assert_eq!(exit.wait(), 129);
    }
}
