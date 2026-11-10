//! The command sandbox's network filter (D348, D350): a small HTTP proxy on 127.0.0.1, one per
//! sandboxed command, that lets connections through to the allowed hosts only and records the
//! hosts it refused (the agent's result names them, so the user can allow one for the project).
//! The command finds it through the usual proxy variables (HTTP(S)_PROXY, ALL_PROXY, Node's
//! NODE_USE_ENV_PROXY), which npm, pip, git, curl, cargo, Go, .NET and Python honor.
//!
//! What that's worth depends on the system: on macOS the sandbox already refuses every outgoing
//! connection but to localhost, so the proxy is the only way out and the allowlist is enforced.
//! On Windows nothing stops a program from opening its own connections (D348: the Windows
//! Filtering Platform needs an administrator), so the proxy limits the tools that use the proxy
//! variables only. On Linux it's used when hosts are allowed (bubblewrap then shares the network).
//!
//! The proxy speaks CONNECT (HTTPS, any TLS) and plain HTTP in absolute form; each plain request
//! gets its own upstream connection (`Connection: close`), so one allowed request can't carry
//! another host's after it. No new dependency: std threads and sockets.

use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A request head larger than this is refused.
const MAX_HEAD: usize = 64 * 1024;

/// Whether `host` matches one of `patterns`: `example.com` (that host), `*.example.com` (its
/// subdomains), `*` (any). Case-insensitive; localhost and loopback addresses always match.
pub fn host_allowed(host: &str, patterns: &[String]) -> bool {
    let host = clean_host(host);
    is_loopback(&host) || matches_pattern(&host, patterns)
}

fn clean_host(host: &str) -> String {
    host.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

/// `host_allowed` without the loopback rule (`host` cleaned).
fn matches_pattern(host: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|p| {
        let p = p.trim().trim_end_matches('.').to_ascii_lowercase();
        if p == "*" {
            return true;
        }
        match p.strip_prefix("*.") {
            Some(base) => host.len() > base.len() + 1 && host.ends_with(&format!(".{base}")),
            None => !p.is_empty() && host == p,
        }
    })
}

/// Whether allowed `host` may be reached at `ip`. One let through as loopback by its name only
/// (`x.localhost`) must resolve to loopback too: a resolver that answered for it with another
/// address would open a way out the allowlist doesn't name.
fn address_allowed(host: &str, patterns: &[String], ip: std::net::IpAddr) -> bool {
    ip.is_loopback() || matches_pattern(&clean_host(host), patterns)
}

fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host.ends_with(".localhost")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// `host:port` (or `[v6]:port`) split; `default` when there's no port.
fn split_host_port(s: &str, default: u16) -> Option<(String, u16)> {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix('[') {
        let end = rest.find(']')?;
        let host = &rest[..end];
        let port = match rest[end + 1..].strip_prefix(':') {
            Some(p) => p.parse().ok()?,
            None => default,
        };
        return Some((host.to_string(), port));
    }
    match s.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => Some((h.to_string(), p.parse().ok()?)),
        _ if !s.is_empty() => Some((s.to_string(), default)),
        _ => None,
    }
}

/// What a request head asks for: the host and port to reach, and for plain HTTP the head to
/// send there (origin form, `Connection: close`, no proxy headers).
#[derive(Debug, PartialEq)]
pub(crate) struct Target {
    pub host: String,
    pub port: u16,
    /// None: CONNECT (a tunnel).
    pub forward: Option<Vec<u8>>,
}

pub(crate) fn parse_head(head: &str) -> Option<Target> {
    let mut lines = head.split("\r\n");
    let request = lines.next()?;
    let mut parts = request.split(' ');
    let method = parts.next()?;
    let target = parts.next()?;
    let version = parts.next().unwrap_or("HTTP/1.1");
    if method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = split_host_port(target, 443)?;
        return Some(Target {
            host,
            port,
            forward: None,
        });
    }
    let rest = target.strip_prefix("http://").or_else(|| {
        target
            .get(..7)
            .filter(|p| p.eq_ignore_ascii_case("http://"))
            .map(|_| &target[7..])
    })?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = split_host_port(authority, 80)?;
    let mut out = format!("{method} {path} {version}\r\n");
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let name = line
            .split(':')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if name == "proxy-connection" || name == "proxy-authorization" || name == "connection" {
            continue;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str("Connection: close\r\n\r\n");
    Some(Target {
        host,
        port,
        forward: Some(out.into_bytes()),
    })
}

/// A running proxy; it stops when dropped (connections already made run to their end).
pub struct NetProxy {
    port: u16,
    stop: Arc<AtomicBool>,
    blocked: Arc<Mutex<BTreeSet<String>>>,
}

impl NetProxy {
    /// Listens on 127.0.0.1 (a free port) and lets connections through to `allow` only.
    pub fn start(allow: Vec<String>) -> std::io::Result<NetProxy> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let stop = Arc::new(AtomicBool::new(false));
        let blocked = Arc::new(Mutex::new(BTreeSet::new()));
        let allow = Arc::new(allow);
        let (s, b) = (stop.clone(), blocked.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if s.load(Ordering::Acquire) {
                    break;
                }
                let Ok(conn) = conn else { continue };
                let (allow, b) = (allow.clone(), b.clone());
                std::thread::spawn(move || serve(conn, &allow, &b));
            }
        });
        Ok(NetProxy {
            port,
            stop,
            blocked,
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The set of hosts it refuses, shared: a running command's refusals read while it runs
    /// (a background command's, D372).
    pub fn blocked_set(&self) -> Arc<Mutex<BTreeSet<String>>> {
        self.blocked.clone()
    }

    /// The hosts it refused so far.
    pub fn blocked(&self) -> Vec<String> {
        self.blocked
            .lock()
            .map(|b| b.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// The variables that point a command's tools at it.
    pub fn env(&self) -> Vec<(String, String)> {
        let url = format!("http://127.0.0.1:{}", self.port);
        let mut vars: Vec<(String, String)> = [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ]
        .iter()
        .map(|k| (k.to_string(), url.clone()))
        .collect();
        for k in ["NO_PROXY", "no_proxy"] {
            vars.push((k.to_string(), "localhost,127.0.0.1,::1".to_string()));
        }
        // Node 24+ uses the variables for fetch and http only when asked.
        vars.push(("NODE_USE_ENV_PROXY".to_string(), "1".to_string()));
        vars
    }
}

impl Drop for NetProxy {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Wakes the accept loop so it sees the flag.
        let _ = TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], self.port)),
            Duration::from_millis(200),
        );
    }
}

fn refuse(mut conn: TcpStream, status: &str, message: &str) {
    let body = format!("{message}\n");
    let _ = conn.write_all(
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
    );
    let _ = conn.shutdown(Shutdown::Both);
}

fn serve(mut conn: TcpStream, allow: &[String], blocked: &Mutex<BTreeSet<String>>) {
    let _ = conn.set_read_timeout(Some(Duration::from_secs(30)));
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 8192];
    let end = loop {
        match conn.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > MAX_HEAD {
            return refuse(
                conn,
                "431 Request Header Fields Too Large",
                "Request head too large.",
            );
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let rest = buf[end..].to_vec();
    let Some(target) = parse_head(&head) else {
        return refuse(
            conn,
            "400 Bad Request",
            "The command sandbox's proxy takes CONNECT and http:// requests only.",
        );
    };
    if !host_allowed(&target.host, allow) {
        if let Ok(mut b) = blocked.lock() {
            b.insert(target.host.to_ascii_lowercase());
        }
        return refuse(
            conn,
            "403 Forbidden",
            &format!(
                "Blocked by the command sandbox: {} isn't an allowed host (agent.sandbox.allowHosts).",
                target.host
            ),
        );
    }
    let upstream = (target.host.as_str(), target.port)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addrs| {
            addrs.find_map(|a| {
                address_allowed(&target.host, allow, a.ip())
                    .then(|| TcpStream::connect_timeout(&a, Duration::from_secs(15)).ok())
                    .flatten()
            })
        });
    let Some(mut upstream) = upstream else {
        return refuse(
            conn,
            "502 Bad Gateway",
            &format!("Couldn't connect to {}:{}.", target.host, target.port),
        );
    };
    let _ = conn.set_read_timeout(None);
    let sent = match &target.forward {
        None => conn.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n"),
        Some(head) => upstream.write_all(head),
    };
    if sent.is_err() || (!rest.is_empty() && upstream.write_all(&rest).is_err()) {
        return;
    }
    pipe(conn, upstream);
}

/// Copies both ways until either side closes.
fn pipe(a: TcpStream, b: TcpStream) {
    let (Ok(mut a2), Ok(mut b2)) = (a.try_clone(), b.try_clone()) else {
        return;
    };
    let (mut a, mut b) = (a, b);
    let up = std::thread::spawn(move || {
        let _ = std::io::copy(&mut a2, &mut b2);
        let _ = b2.shutdown(Shutdown::Write);
    });
    let _ = std::io::copy(&mut b, &mut a);
    let _ = a.shutdown(Shutdown::Write);
    let _ = up.join();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn hosts_match_exactly_by_subdomain_or_all_and_loopback_always() {
        let p = list(&["registry.npmjs.org", "*.github.com"]);
        assert!(host_allowed("registry.npmjs.org", &p));
        assert!(host_allowed("Registry.NPMJS.org.", &p));
        assert!(!host_allowed("evil-registry.npmjs.org", &p));
        assert!(host_allowed("api.github.com", &p));
        assert!(!host_allowed("github.com", &p));
        assert!(!host_allowed("notgithub.com", &p));
        assert!(host_allowed("localhost", &[]));
        assert!(host_allowed("127.0.0.1", &[]));
        assert!(host_allowed("[::1]", &[]));
        assert!(!host_allowed("example.com", &[]));
        assert!(host_allowed("example.com", &list(&["*"])));
        // Loopback by name must be loopback where it resolves.
        let far: std::net::IpAddr = [93, 184, 216, 34].into();
        let near: std::net::IpAddr = [127, 0, 0, 1].into();
        assert!(!address_allowed("evil.localhost", &[], far));
        assert!(address_allowed("evil.localhost", &[], near));
        assert!(address_allowed("api.github.com", &p, far));
    }

    #[test]
    fn heads_give_the_target_and_plain_http_goes_out_in_origin_form() {
        let t = parse_head("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n");
        assert_eq!(
            t,
            Some(Target {
                host: "example.com".into(),
                port: 443,
                forward: None
            })
        );
        let t = parse_head("CONNECT [::1]:8080 HTTP/1.1\r\n\r\n").map(|t| (t.host, t.port));
        assert_eq!(t, Some(("::1".into(), 8080)));
        let t = parse_head(
            "GET http://example.com:8080/a?b HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\n\r\n",
        );
        let t = t.map(|t| {
            (
                t.host,
                t.port,
                String::from_utf8(t.forward.unwrap_or_default()),
            )
        });
        assert_eq!(
            t,
            Some((
                "example.com".into(),
                8080,
                Ok("GET /a?b HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n".into())
            ))
        );
        assert_eq!(parse_head("GET /relative HTTP/1.1\r\n\r\n"), None);
    }

    /// The real thing: an allowed host goes through, another is refused and recorded.
    #[test]
    fn the_proxy_tunnels_to_allowed_hosts_and_refuses_the_rest() {
        // A local "upstream" that answers one line.
        let upstream = match TcpListener::bind(("127.0.0.1", 0)) {
            Ok(l) => l,
            Err(e) => panic!("bind: {e}"),
        };
        let up_port = upstream.local_addr().map(|a| a.port()).unwrap_or(0);
        std::thread::spawn(move || {
            if let Ok((mut c, _)) = upstream.accept() {
                let _ = c.write_all(b"hello from upstream");
            }
        });
        let proxy = match NetProxy::start(list(&["allowed.test"])) {
            Ok(p) => p,
            Err(e) => panic!("start: {e}"),
        };
        let ask = |head: &str| -> String {
            let mut c = match TcpStream::connect(("127.0.0.1", proxy.port())) {
                Ok(c) => c,
                Err(e) => panic!("connect: {e}"),
            };
            let _ = c.set_read_timeout(Some(Duration::from_secs(10)));
            let _ = c.write_all(head.as_bytes());
            let mut out = String::new();
            let _ = c.read_to_string(&mut out);
            out
        };
        // Loopback is always allowed: the tunnel reaches the local upstream.
        let ok = ask(&format!("CONNECT 127.0.0.1:{up_port} HTTP/1.1\r\n\r\n"));
        assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
        assert!(ok.ends_with("hello from upstream"), "{ok}");
        let no = ask("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
        assert!(no.starts_with("HTTP/1.1 403"), "{no}");
        assert!(no.contains("Blocked by the command sandbox"), "{no}");
        let no = ask("GET http://Other.Example/ HTTP/1.1\r\nHost: other.example\r\n\r\n");
        assert!(no.starts_with("HTTP/1.1 403"), "{no}");
        assert_eq!(proxy.blocked(), vec!["example.com", "other.example"]);
        assert!(proxy.env().contains(&(
            "HTTPS_PROXY".to_string(),
            format!("http://127.0.0.1:{}", proxy.port())
        )));
    }
}
