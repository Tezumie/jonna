//! `tcp.connect`: a connection the server makes for the app (the browser preview's forwarded
//! ports), its bytes carried as a stream.

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use crate::error::{Error, Result};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Connects to `host:port`, trying each address the name resolves to.
pub fn connect(host: &str, port: u16) -> Result<TcpStream> {
    let host = if host.trim().is_empty() {
        "localhost"
    } else {
        host.trim()
    };
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| Error::Exec(format!("can't resolve {host}: {e}")))?;
    let mut last = None;
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT) {
            Ok(socket) => {
                // Small writes (keystrokes in a dev server's websocket) go out at once.
                let _ = socket.set_nodelay(true);
                return Ok(socket);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(Error::Exec(match last {
        Some(e) => format!("can't connect to {host}:{port}: {e}"),
        None => format!("{host} has no address"),
    }))
}
