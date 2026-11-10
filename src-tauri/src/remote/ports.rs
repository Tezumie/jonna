//! Ports forwarded from the remote (a dev server running there, for the browser preview): a
//! listener on 127.0.0.1 here (the same port number when it's free), and each connection to it
//! a `tcp.connect` the server makes to that port there, bytes pumped both ways.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};

use super::connection::{RemoteConn, StreamEvent, DEFAULT_TIMEOUT};
use crate::error::{Error, Result};

/// Gives the current connection (an error while there is none).
pub type ConnFn = Arc<dyn Fn() -> Result<Arc<RemoteConn>> + Send + Sync>;

struct Forward {
    local: u16,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct Forwards {
    by_remote: Mutex<HashMap<u16, Forward>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Forwarded {
    pub remote: u16,
    pub local: u16,
}

impl Forwards {
    /// Forwards remote port `port`; the local port (an earlier forward of it is reused).
    pub fn forward(&self, port: u16, conn: ConnFn) -> Result<u16> {
        if port == 0 {
            return Err(Error::Invalid("port 0 can't be forwarded".into()));
        }
        let mut map = self
            .by_remote
            .lock()
            .map_err(|_| Error::Invalid("ports lock poisoned".into()))?;
        if let Some(f) = map.get(&port) {
            return Ok(f.local);
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .or_else(|_| TcpListener::bind((Ipv4Addr::LOCALHOST, 0)))?;
        let local = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        std::thread::Builder::new()
            .name(format!("remote-port-{port}"))
            .spawn(move || {
                for socket in listener.incoming() {
                    if stopping.load(Ordering::Acquire) {
                        break;
                    }
                    let Ok(socket) = socket else { continue };
                    let conn = conn.clone();
                    let _ = std::thread::Builder::new()
                        .name(format!("remote-port-{port}-conn"))
                        .spawn(move || {
                            let _ = pump(socket, port, &conn);
                        });
                }
            })?;
        map.insert(port, Forward { local, stop });
        Ok(local)
    }

    /// Stops forwarding `port` (connections already open run on until they close).
    pub fn unforward(&self, port: u16) {
        let removed = self.by_remote.lock().ok().and_then(|mut m| m.remove(&port));
        if let Some(f) = removed {
            stop(&f);
        }
    }

    pub fn list(&self) -> Vec<Forwarded> {
        let mut out: Vec<Forwarded> = self
            .by_remote
            .lock()
            .map(|m| {
                m.iter()
                    .map(|(remote, f)| Forwarded {
                        remote: *remote,
                        local: f.local,
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.sort_by_key(|f| f.remote);
        out
    }

    pub fn clear(&self) {
        let all: Vec<Forward> = self
            .by_remote
            .lock()
            .map(|mut m| m.drain().map(|(_, f)| f).collect())
            .unwrap_or_default();
        for f in &all {
            stop(f);
        }
    }
}

/// Wakes the accept loop so it sees the flag and ends (closing the listener).
fn stop(f: &Forward) {
    f.stop.store(true, Ordering::Release);
    let _ = TcpStream::connect((Ipv4Addr::LOCALHOST, f.local));
}

/// One connection: opened on the remote, then bytes both ways until either side closes.
fn pump(mut socket: TcpStream, port: u16, conn: &ConnFn) -> Result<()> {
    let conn = conn()?;
    let _ = socket.set_nodelay(true);
    let (tx, rx) = mpsc::channel();
    let opened = conn.open_stream_blocking(
        "tcp.connect",
        json!({ "host": "", "port": port }),
        tx,
        DEFAULT_TIMEOUT,
    );
    let stream = match opened {
        Ok(v) => v.get("stream").and_then(Value::as_u64).unwrap_or(0),
        Err(e) => {
            let _ = socket.shutdown(Shutdown::Both);
            return Err(e);
        }
    };
    let mut reading = socket.try_clone()?;
    let writer_conn = conn.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reading.read(&mut buf) {
                Ok(0) => {
                    let _ = writer_conn.notify("stream.closeStdin", json!({ "stream": stream }));
                    break;
                }
                Ok(n) => {
                    if writer_conn.write_stream(stream, &buf[..n]).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = writer_conn.notify("stream.kill", json!({ "stream": stream }));
                    break;
                }
            }
        }
    });
    for event in rx {
        match event {
            StreamEvent::Data { bytes, .. } => {
                if socket.write_all(&bytes).is_err() {
                    let _ = conn.notify("stream.kill", json!({ "stream": stream }));
                    conn.forget_stream(stream);
                    break;
                }
            }
            StreamEvent::Exit { .. } => {
                let _ = socket.shutdown(Shutdown::Write);
                break;
            }
            StreamEvent::Lost(_) => {
                let _ = socket.shutdown(Shutdown::Both);
                break;
            }
        }
    }
    Ok(())
}
