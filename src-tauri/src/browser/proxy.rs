//! The preview proxy: one hyper server on 127.0.0.1:<random> per target. A target is a local dev
//! server (`http://localhost:5173`: every request is forwarded, WebSocket upgrades included so hot
//! reload keeps working) or a workspace folder served as static files. HTML responses get the
//! bridge script injected; headers that would stop the page from showing in the IDE's frame
//! (X-Frame-Options, CSP) are dropped. Requests must name the proxy itself as Host, so a web page
//! can't reach it through DNS rebinding.

use std::collections::HashMap;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use super::netlog::{header_list, NetLog, Pending, Tap};
use crate::error::Result;

pub const BRIDGE_PATH: &str = "/__ide/bridge.js";
/// Where a page load redirected to another site lands (D209): a page whose bridge asks the IDE to
/// open the address in `?url=` (another local server through its own proxy, or another site),
/// since the frame only shows pages a proxy serves.
pub const GOTO_PATH: &str = "/__ide/goto";
/// Where a tab starts when a page posted a form into a new tab: a page whose bridge the IDE asks
/// to post the form (to this proxy's server, or to another site), so the body isn't lost.
pub const POST_PATH: &str = "/__ide/post";
/// A static preview's change counter (D284): `?since=N` answers once it isn't N (or after 25 s),
/// so the page opened in an outside browser reloads when a file changes, as Live Server's does.
pub const LIVE_PATH: &str = "/__ide/live";
pub const BRIDGE_JS: &str = concat!(
    include_str!("bridge.js"),
    "\n",
    include_str!("devtools.js"),
    "\n",
    include_str!("input.js"),
    "\n",
    include_str!("links.js")
);
const BRIDGE_TAG: &str = "<script src=\"/__ide/bridge.js\"></script>";
/// Extension webviews (served with a CSP, no bridge) get the IDE's scrollbars (D189): otherwise
/// Chromium draws its native overlay ones there, thin until hovered, unlike the rest of the IDE.
/// In a cascade layer, so a page's own scrollbar rules still win.
const WEBVIEW_STYLE_TAG: &str = "<style data-ide>@layer ide-defaults{::-webkit-scrollbar{width:var(--size-scrollbar,9px);height:var(--size-scrollbar,9px)}::-webkit-scrollbar,::-webkit-scrollbar-thumb,::-webkit-scrollbar-track,::-webkit-scrollbar-corner{cursor:default}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--fg-subtle,#8b8b8b) 22%,transparent);border-radius:999px;border:1px solid transparent;background-clip:padding-box}:hover::-webkit-scrollbar-thumb{background-color:color-mix(in srgb,var(--fg-subtle,#8b8b8b) 40%,transparent)}::-webkit-scrollbar-thumb:hover{background-color:color-mix(in srgb,var(--fg-subtle,#8b8b8b) 50%,transparent)}::-webkit-scrollbar-thumb:active{background-color:color-mix(in srgb,var(--fg-subtle,#8b8b8b) 60%,transparent)}}</style>";

type Body = BoxBody<Bytes, hyper::Error>;

#[derive(Debug, Clone)]
pub enum Target {
    /// A dev server on this machine: scheme-less authority ("localhost:5173") and its origin.
    Upstream {
        host: String,
        port: u16,
        origin: String,
    },
    /// A folder served as files (index.html for folders). With `csp` (an extension's webview
    /// panels, D102), every response carries that Content-Security-Policy and HTML gets no bridge.
    Static {
        root: PathBuf,
        csp: Option<&'static str>,
    },
}

/// State every proxy shares: the network log and, for static previews, unsaved editor text
/// served in place of the file on disk (live preview while typing).
#[derive(Default)]
pub struct Shared {
    pub log: NetLog,
    pub overlays: Mutex<HashMap<PathBuf, Vec<u8>>>,
    /// Extensions' webview panels made at run time (`ide.ui.createWebviewPanel`): HTML their
    /// code set, by the extension folder and the panel's page name, served on that folder's
    /// origin at `/__webview-<name>.html` with the folder's CSP.
    pub webview_pages: Mutex<HashMap<(PathBuf, String), Vec<u8>>>,
    /// Folders an extension's webview pages may read files from besides its own (VS Code's
    /// localResourceRoots: the workspace's folders, declared roots inside them), by the extension
    /// folder; canonical. Served at `/__fs/<absolute path>` on that folder's origin.
    pub webview_roots: Mutex<HashMap<PathBuf, Vec<PathBuf>>>,
    /// Downloads from previews and site windows (`downloads.rs`).
    pub downloads: super::downloads::Downloads,
    /// Counts the folder's changes (saved files, live edits) for `LIVE_PATH`; waiters are woken.
    pub live_generation: std::sync::atomic::AtomicU64,
    pub live_changed: tokio::sync::Notify,
}

impl Shared {
    /// A file a static preview may show changed: pages waiting on `LIVE_PATH` reload.
    pub fn bump_live(&self) {
        self.live_generation.fetch_add(1, Ordering::SeqCst);
        self.live_changed.notify_waiters();
    }
}

struct Ctx {
    shared: Arc<Shared>,
    target: Target,
    /// "127.0.0.1:<port>" and "localhost:<port>": the only Host values accepted.
    hosts: [String; 2],
    origin: String,
    upstream: Arc<Upstream>,
}

/// Connections to the dev server, kept open and reused (D123). A page load of a Vite app is
/// hundreds of module requests: one TCP connect + handshake each made reloads visibly slower
/// than VS Code's / Cursor's, and on Windows a `localhost` server listening only on ::1 cost a
/// refused 127.0.0.1 connect (about a second there) on every request — the address that worked
/// is remembered.
#[derive(Default)]
struct Upstream {
    idle: Mutex<Vec<hyper::client::conn::http1::SendRequest<Body>>>,
    addr: Mutex<Option<std::net::SocketAddr>>,
}

const MAX_IDLE: usize = 16;

impl Upstream {
    fn take_idle(&self) -> Option<hyper::client::conn::http1::SendRequest<Body>> {
        let mut idle = self.idle.lock().ok()?;
        while let Some(sender) = idle.pop() {
            if sender.is_ready() && !sender.is_closed() {
                return Some(sender);
            }
        }
        None
    }

    /// Gives a connection back once its response has been read to the end.
    fn release(self: &Arc<Self>, mut sender: hyper::client::conn::http1::SendRequest<Body>) {
        let this = self.clone();
        tauri::async_runtime::spawn(async move {
            if sender.ready().await.is_ok() {
                if let Ok(mut idle) = this.idle.lock() {
                    if idle.len() < MAX_IDLE {
                        idle.push(sender);
                    }
                }
            }
        });
    }

    async fn connect(&self, host: &str, port: u16) -> std::io::Result<TcpStream> {
        let known = self.addr.lock().ok().and_then(|a| *a);
        if let Some(addr) = known {
            if let Ok(s) = TcpStream::connect(addr).await {
                s.set_nodelay(true).ok();
                return Ok(s);
            }
        }
        let candidates: Vec<std::net::SocketAddr> = if host == "localhost" {
            vec![
                ([127, 0, 0, 1], port).into(),
                (std::net::Ipv6Addr::LOCALHOST, port).into(),
            ]
        } else {
            tokio::net::lookup_host((host, port)).await?.collect()
        };
        let mut last = std::io::Error::other("no address");
        for addr in candidates {
            match TcpStream::connect(addr).await {
                Ok(s) => {
                    s.set_nodelay(true).ok();
                    if let Ok(mut a) = self.addr.lock() {
                        *a = Some(addr);
                    }
                    return Ok(s);
                }
                Err(e) => last = e,
            }
        }
        Err(last)
    }
}

/// `LIVE_PATH`: the change counter now if it isn't `since`, else once it moves (25 s at most).
async fn live(req: &Request<Incoming>, shared: &Shared) -> Response<Body> {
    let since = req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("since=")))
        .and_then(|v| v.parse::<u64>().ok());
    // Listening before reading the counter: a change in between isn't missed.
    let changed = shared.live_changed.notified();
    tokio::pin!(changed);
    changed.as_mut().enable();
    if since == Some(shared.live_generation.load(Ordering::SeqCst)) {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(25), changed).await;
    }
    let mut r = full(
        StatusCode::OK,
        "text/plain",
        shared.live_generation.load(Ordering::SeqCst).to_string(),
    );
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

fn full(status: StatusCode, content_type: &str, body: impl Into<Bytes>) -> Response<Body> {
    let mut r = Response::new(
        Full::new(body.into())
            .map_err(|never: Infallible| match never {})
            .boxed(),
    );
    *r.status_mut() = status;
    if let Ok(v) = HeaderValue::from_str(content_type) {
        r.headers_mut().insert(header::CONTENT_TYPE, v);
    }
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

fn page(status: StatusCode, title: &str, detail: &str) -> Response<Body> {
    let esc = |s: &str| {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>{t}</title>\
         <body style=\"font:14px system-ui,sans-serif;padding:32px;color:#888\">\
         <h2 style=\"font-weight:600;color:#aaa\">{t}</h2><p>{d}</p>{BRIDGE_TAG}",
        t = esc(title),
        d = esc(detail)
    );
    full(status, "text/html; charset=utf-8", html)
}

/// Inserts the bridge tag right after `<head…>` (else after `<html…>`, else at the start).
#[cfg(test)]
pub fn inject(html: &str) -> String {
    inject_tag(html, BRIDGE_TAG)
}

/// Inserts `tag` right after `<head…>` (else after `<html…>`, else at the start).
fn inject_tag(html: &str, tag: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let after_tag = |tag: &str| {
        let mut from = 0;
        while let Some(i) = lower[from..].find(tag) {
            let at = from + i;
            let next = lower.as_bytes().get(at + tag.len()).copied();
            if matches!(
                next,
                Some(b'>') | Some(b' ') | Some(b'\n') | Some(b'\t') | Some(b'\r')
            ) {
                return lower[at..].find('>').map(|end| at + end + 1);
            }
            from = at + tag.len();
        }
        None
    };
    let at = after_tag("<head")
        .or_else(|| after_tag("<html"))
        .unwrap_or(0);
    let mut out = String::with_capacity(html.len() + tag.len());
    out.push_str(&html[..at]);
    out.push_str(tag);
    out.push_str(&html[at..]);
    out
}

fn is_html(headers: &hyper::HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().starts_with("text/html"))
}

/// Whether a request carries a body (a length above zero, or chunked).
fn request_has_body(headers: &hyper::HeaderMap) -> bool {
    headers.contains_key(header::TRANSFER_ENCODING)
        || headers
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .is_some_and(|n| n > 0)
}

/// Headers that keep a page out of a frame or block the injected script.
fn strip_frame_blockers(headers: &mut hyper::HeaderMap) {
    for name in [
        "x-frame-options",
        "content-security-policy",
        "content-security-policy-report-only",
        "cross-origin-opener-policy",
        "cross-origin-embedder-policy",
    ] {
        headers.remove(name);
    }
}

/// A request for a document (a page load), not a fetch or a subresource: the only kind whose
/// redirects to another site go through the goto page.
fn is_navigation(headers: &hyper::HeaderMap) -> bool {
    let get = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    match get("sec-fetch-mode") {
        Some(mode) => mode.eq_ignore_ascii_case("navigate"),
        // Engines without fetch metadata: page loads ask for HTML first, fetches for anything.
        None => get("accept").is_some_and(|a| a.trim_start().starts_with("text/html")),
    }
}

/// The Location the frame should follow (None: keep it). The dev server's own origin becomes the
/// proxy's — only as a whole origin (`http://localhost:5173` must not match
/// `http://localhost:51730`, and an address in the query stays). A page load redirected to any
/// other http(s) origin goes to the goto page, so the IDE opens it: another local server through
/// its own proxy in the same tab, another site as the tab's other sites (D209).
pub fn rewrite_location(
    location: &str,
    upstream_origin: &str,
    proxy_origin: &str,
    navigation: bool,
) -> Option<String> {
    if let Some(rest) = location.strip_prefix(upstream_origin) {
        if rest.is_empty() || rest.starts_with(['/', '?', '#']) {
            return Some(format!("{proxy_origin}{rest}"));
        }
    }
    if !navigation || location.starts_with(&format!("{proxy_origin}/")) || location == proxy_origin
    {
        return None;
    }
    let absolute = if location.starts_with("//") {
        format!("http:{location}")
    } else {
        location.to_string()
    };
    let parsed = reqwest::Url::parse(&absolute).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return None;
    }
    Some(format!(
        "{GOTO_PATH}?url={}",
        percent_encode(parsed.as_str())
    ))
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3 / 2);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Chromium's cookie rules (WebView2) apply, rather than WebKit's.
const CHROMIUM: bool = cfg!(windows);

/// A dev server's cookie as the frame needs it (D209). The frame is a cross-site frame of the
/// IDE's own page, where SameSite=Lax/Strict cookies are neither stored nor sent, so a sign-in
/// never stuck. Chromium (WebView2) also treats a cookie without SameSite as Lax: there they
/// become SameSite=None, which needs Secure (Chromium counts loopback addresses as secure).
/// WebKit refuses Secure cookies on http and treats no SameSite as None: there the attribute is
/// dropped. A Domain of localhost is dropped everywhere: the page's host is 127.0.0.1, which such
/// a cookie doesn't match, so it was refused.
pub fn frame_cookie(cookie: &str, chromium: bool) -> String {
    let mut parts = cookie.split(';').map(str::trim);
    let mut out = parts.next().unwrap_or_default().to_string();
    let mut secure = false;
    for attr in parts {
        let name = attr.split('=').next().unwrap_or_default().trim();
        if attr.is_empty() || name.eq_ignore_ascii_case("samesite") {
            continue;
        }
        if name.eq_ignore_ascii_case("domain") {
            let domain = attr
                .split_once('=')
                .map_or("", |(_, v)| v.trim().trim_start_matches('.'))
                .to_ascii_lowercase();
            if domain == "localhost" || domain.ends_with(".localhost") {
                continue;
            }
        }
        if name.eq_ignore_ascii_case("secure") {
            secure = true;
        }
        out.push_str("; ");
        out.push_str(attr);
    }
    if chromium {
        out.push_str("; SameSite=None");
        if !secure {
            out.push_str("; Secure");
        }
    }
    out
}

fn rewrite_set_cookies(headers: &mut hyper::HeaderMap) {
    let cookies: Vec<String> = headers
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok().map(|c| frame_cookie(c, CHROMIUM)))
        .collect();
    if cookies.is_empty() {
        return;
    }
    headers.remove(header::SET_COOKIE);
    for c in cookies {
        if let Ok(v) = HeaderValue::from_str(&c) {
            headers.append(header::SET_COOKIE, v);
        }
    }
}

/// The host name a proxy's pages are on. Extension webviews (a folder with a CSP) are on
/// `localhost`, previews on 127.0.0.1: cookies are kept by host name, not port, so a preview's
/// cookies and an extension page's stay apart (D265). The same listener answers both names.
pub fn origin_host(target: &Target) -> &'static str {
    match target {
        Target::Static { csp: Some(_), .. } => "localhost",
        _ => "127.0.0.1",
    }
}

/// Binds and serves in the background; returns the port.
pub async fn serve(target: Target, cancel: CancellationToken, shared: Arc<Shared>) -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let host = origin_host(&target);
    let ctx = Arc::new(Ctx {
        shared,
        target,
        hosts: [format!("127.0.0.1:{port}"), format!("localhost:{port}")],
        origin: format!("http://{host}:{port}"),
        upstream: Arc::new(Upstream::default()),
    });
    tauri::async_runtime::spawn(async move {
        loop {
            let accepted = tokio::select! {
                _ = cancel.cancelled() => break,
                accepted = listener.accept() => accepted,
            };
            let Ok((stream, _)) = accepted else {
                // Out of file handles (EMFILE) and the like: a short pause, not a busy loop.
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            };
            // Headers and body go out as separate small writes: without this, Nagle's algorithm
            // and delayed ACKs add ~40 ms to every request (D123).
            stream.set_nodelay(true).ok();
            let ctx = ctx.clone();
            let cancel = cancel.clone();
            tauri::async_runtime::spawn(async move {
                let service = service_fn(move |req| {
                    let ctx = ctx.clone();
                    async move { Ok::<_, Infallible>(handle(req, &ctx).await) }
                });
                let conn = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .with_upgrades();
                tokio::select! {
                    _ = cancel.cancelled() => {}
                    _ = conn => {}
                }
            });
        }
    });
    Ok(port)
}

async fn handle(req: Request<Incoming>, ctx: &Ctx) -> Response<Body> {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !ctx.hosts.iter().any(|h| h == host) {
        return full(StatusCode::FORBIDDEN, "text/plain", "wrong host");
    }
    if req.uri().path() == BRIDGE_PATH {
        return full(StatusCode::OK, "text/javascript; charset=utf-8", BRIDGE_JS);
    }
    let bridged = !matches!(ctx.target, Target::Static { csp: Some(_), .. });
    if req.uri().path() == LIVE_PATH && matches!(ctx.target, Target::Static { csp: None, .. }) {
        return live(&req, &ctx.shared).await;
    }
    if bridged && (req.uri().path() == GOTO_PATH || req.uri().path() == POST_PATH) {
        // The bridge reads the address from the query; the page shows none of it.
        return page(StatusCode::OK, "Opening…", "Opening the next page.");
    }
    let url = req
        .uri()
        .path_and_query()
        .map_or("/", |p| p.as_str())
        .to_string();
    let pending = ctx.shared.log.begin(
        &ctx.origin,
        req.method().as_str(),
        &url,
        header_list(req.headers()),
    );
    match &ctx.target {
        Target::Static { root, csp } => serve_file(req, root, *csp, &ctx.shared, pending).await,
        Target::Upstream { host, port, origin } => {
            let mut slot = Some(pending);
            match forward(req, host, *port, origin, ctx, &mut slot).await {
                Ok(r) => r,
                Err(err) => {
                    let response = page(
                        StatusCode::BAD_GATEWAY,
                        &format!("Can't reach {origin}"),
                        &format!("Is the dev server running? ({err})"),
                    );
                    if let Some(mut p) = slot.take() {
                        ctx.shared.log.respond(&mut p, 502, response.headers());
                        ctx.shared.log.finish(p, None, 0, Some(err.to_string()));
                    }
                    response
                }
            }
        }
    }
}

/// Forwards one request to the dev server. `slot` holds the log entry until something takes it
/// over (a body tap, or `finish`); on error the caller finishes it.
async fn forward(
    mut req: Request<Incoming>,
    host: &str,
    port: u16,
    origin: &str,
    ctx: &Ctx,
    slot: &mut Option<Pending>,
) -> std::result::Result<Response<Body>, Box<dyn std::error::Error + Send + Sync>> {
    let (proxy_origin, shared, upstream) = (ctx.origin.as_str(), &ctx.shared, &ctx.upstream);
    let upgrading = req.headers().contains_key(header::UPGRADE);
    let has_body = !upgrading && request_has_body(req.headers());
    // A WebSocket takes its connection over, and a request with a body gets a fresh one (its body
    // streams, so it couldn't be sent again on another); everything else reuses an idle one.
    let reused = if upgrading || has_body {
        None
    } else {
        upstream.take_idle()
    };
    let was_reused = reused.is_some();
    let mut sender = match reused {
        Some(s) => s,
        None => {
            let stream = upstream.connect(host, port).await?;
            let (sender, conn) =
                hyper::client::conn::http1::handshake::<_, Body>(TokioIo::new(stream)).await?;
            tauri::async_runtime::spawn(async move {
                let _ = conn.with_upgrades().await;
            });
            sender
        }
    };
    let client_upgrade = upgrading.then(|| hyper::upgrade::on(&mut req));
    let authority = format!("{host}:{port}");
    let headers = req.headers_mut();
    headers.insert(header::HOST, HeaderValue::from_str(&authority)?);
    // The dev server sees its own origin (Vite and others check it on WebSocket upgrades).
    for name in [header::ORIGIN, header::REFERER] {
        if let Some(v) = headers.get(&name).and_then(|v| v.to_str().ok()) {
            let rewritten = v.replacen(proxy_origin, origin, 1);
            headers.insert(name, HeaderValue::from_str(&rewritten)?);
        }
    }
    if !upgrading {
        // Plain bodies, so HTML can be edited.
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
    }
    let no_cache = shared.log.no_cache.load(Ordering::Relaxed);
    if no_cache {
        headers.remove(header::IF_NONE_MATCH);
        headers.remove(header::IF_MODIFIED_SINCE);
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    let head_request = req.method() == hyper::Method::HEAD;
    let navigation = is_navigation(req.headers());
    // A request body (an upload, a form post) streams to the server as it arrives; the log keeps
    // its first 2 MB.
    let (parts, body) = req.into_parts();
    let empty = || {
        Empty::new()
            .map_err(|never: Infallible| match never {})
            .boxed()
    };
    let forwarded = if has_body {
        let kept = Arc::new(Mutex::new(super::stream::Kept::default()));
        if let Some(p) = slot.as_mut() {
            p.req_tap = Some(kept.clone());
        }
        super::stream::RequestTap::new(body, kept, super::netlog::BODY_CAP).boxed()
    } else {
        empty()
    };
    // A kept-alive connection the server has just closed fails before any response: send again
    // on a new one (only bodyless requests take a kept-alive connection, so nothing is lost).
    let again = was_reused.then(|| {
        let mut r = Request::new(empty());
        *r.method_mut() = parts.method.clone();
        *r.uri_mut() = parts.uri.clone();
        *r.version_mut() = parts.version;
        *r.headers_mut() = parts.headers.clone();
        r
    });
    let req = Request::from_parts(parts, forwarded);
    let mut response = match (sender.send_request(req).await, again) {
        (Ok(r), _) => r,
        (Err(e), Some(retry)) if e.is_canceled() || e.is_closed() || e.is_incomplete_message() => {
            let stream = upstream.connect(host, port).await?;
            let (fresh, conn) =
                hyper::client::conn::http1::handshake::<_, Body>(TokioIo::new(stream)).await?;
            tauri::async_runtime::spawn(async move {
                let _ = conn.with_upgrades().await;
            });
            sender = fresh;
            sender.send_request(retry).await?
        }
        (Err(e), _) => return Err(e.into()),
    };
    if !upgrading {
        upstream.release(sender);
    }
    if let Some(p) = slot.as_mut() {
        shared
            .log
            .respond(p, response.status().as_u16(), response.headers());
    }
    if response.status() == StatusCode::SWITCHING_PROTOCOLS {
        if let Some(mut p) = slot.take() {
            p.event.protocol = "websocket";
            shared.log.finish(p, None, 0, None);
        }
        if let Some(client) = client_upgrade {
            let server = hyper::upgrade::on(&mut response);
            tauri::async_runtime::spawn(async move {
                if let (Ok(c), Ok(s)) = (client.await, server.await) {
                    let _ =
                        tokio::io::copy_bidirectional(&mut TokioIo::new(c), &mut TokioIo::new(s))
                            .await;
                }
            });
        }
        let (parts, _) = response.into_parts();
        return Ok(Response::from_parts(
            parts,
            Empty::new()
                .map_err(|never: Infallible| match never {})
                .boxed(),
        ));
    }
    let (mut parts, body) = response.into_parts();
    strip_frame_blockers(&mut parts.headers);
    if no_cache {
        parts
            .headers
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    if let Some(location) = parts
        .headers
        .get(header::LOCATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(rewritten) = rewrite_location(location, origin, proxy_origin, navigation) {
            parts
                .headers
                .insert(header::LOCATION, HeaderValue::from_str(&rewritten)?);
        }
    }
    rewrite_set_cookies(&mut parts.headers);
    let encoded = parts.headers.contains_key(header::CONTENT_ENCODING);
    let inject_bridge =
        is_html(&parts.headers) && !head_request && !encoded && parts.status.is_success();
    if inject_bridge {
        // The page streams on with the bridge tag added (stream::HtmlInject): its length changes.
        parts.headers.remove(header::CONTENT_LENGTH);
        parts.headers.remove(header::ETAG);
    }
    let Some(p) = slot.take() else {
        return Ok(Response::from_parts(parts, body.boxed()));
    };
    let log = shared.clone();
    // The log sees the server's bytes; the page gets them with the tag.
    let tap = Tap::new(
        body,
        Box::new(move |buf, size, error| log.log.finish(p, buf, size, error)),
    );
    if inject_bridge {
        return Ok(Response::from_parts(
            parts,
            super::stream::HtmlInject::new(tap, BRIDGE_TAG).boxed(),
        ));
    }
    Ok(Response::from_parts(parts, tap.boxed()))
}

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js" | "mjs" | "cjs") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        Some("xml") => "application/xml",
        Some("pdf") => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A runtime webview panel's page name from its URL path (`/__webview-<name>.html`).
pub fn webview_page_name(url_path: &str) -> Option<&str> {
    let name = url_path
        .strip_prefix("/__webview-")?
        .strip_suffix(".html")?;
    is_webview_page_name(name).then_some(name)
}

/// Letters, digits, `-` and `_`, 1 to 64 of them.
pub fn is_webview_page_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Where an extension's page reads a file of a local resource root: `/__fs/<absolute path>`.
pub const ROOT_FILES_PREFIX: &str = "/__fs/";

/// The file of a local resource root a URL path names (`/__fs/C:/work/a.png`, `/__fs/home/a.png`):
/// a file (not a folder) inside one of `roots` (canonical) once links are followed; `.`, `..`
/// and backslashes are refused.
pub fn resolve_rooted(roots: &[PathBuf], url_path: &str) -> Option<PathBuf> {
    let rest = url_path.strip_prefix(ROOT_FILES_PREFIX)?;
    let decoded = percent_decode(rest)?;
    let parts: Vec<&str> = decoded.split('/').filter(|p| !p.is_empty()).collect();
    if parts
        .iter()
        .any(|p| *p == ".." || *p == "." || p.contains('\\'))
    {
        return None;
    }
    let mut path = PathBuf::new();
    let mut iter = parts.iter();
    if cfg!(windows) {
        let drive = iter.next()?;
        let bytes = drive.as_bytes();
        if bytes.len() != 2 || bytes[1] != b':' || !bytes[0].is_ascii_alphabetic() {
            return None;
        }
        path.push(format!("{drive}\\"));
    } else {
        path.push("/");
    }
    for part in iter {
        if part.contains(':') {
            return None;
        }
        path.push(part);
    }
    let canonical = std::fs::canonicalize(&path).ok()?;
    if !canonical.is_file() || !roots.iter().any(|r| canonical.starts_with(r)) {
        return None;
    }
    Some(canonical)
}

/// The file for a URL path under `root`, never outside it (`..` and symlinks out are refused).
pub fn resolve_static(root: &Path, url_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(url_path)?;
    let mut path = root.to_path_buf();
    for part in decoded.split('/').filter(|p| !p.is_empty()) {
        if part == ".." || part == "." || part.contains('\\') || part.contains(':') {
            return None;
        }
        path.push(part);
    }
    let canonical = std::fs::canonicalize(&path).ok()?;
    let root = std::fs::canonicalize(root).ok()?;
    if !canonical.starts_with(&root) {
        return None;
    }
    if canonical.is_dir() {
        // The folder's index.html may itself be a link out of the root: checked like any file.
        let index = std::fs::canonicalize(canonical.join("index.html")).ok()?;
        return (index.starts_with(&root) && index.is_file()).then_some(index);
    }
    canonical.is_file().then_some(canonical)
}

async fn serve_file(
    req: Request<Incoming>,
    root: &Path,
    csp: Option<&'static str>,
    shared: &Shared,
    mut pending: Pending,
) -> Response<Body> {
    let tag = if csp.is_none() {
        BRIDGE_TAG
    } else {
        WEBVIEW_STYLE_TAG
    };
    let (mut response, body) = static_response(&req, root, tag, shared, csp.is_some()).await;
    if let Some(csp) = csp {
        response.headers_mut().insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(csp),
        );
    }
    shared
        .log
        .respond(&mut pending, response.status().as_u16(), response.headers());
    let size = body.as_ref().map_or(0, |b| b.len() as u64);
    let error = (!response.status().is_success()).then(|| response.status().to_string());
    shared.log.finish(pending, body, size, error);
    response
}

/// The response for a static request, and the bytes to log as its body.
async fn static_response(
    req: &Request<Incoming>,
    root: &Path,
    tag: &str,
    shared: &Shared,
    // An extension's webview pages: they may also read files of their local resource roots.
    extension: bool,
) -> (Response<Body>, Option<Vec<u8>>) {
    if req.method() != hyper::Method::GET && req.method() != hyper::Method::HEAD {
        return (
            full(StatusCode::METHOD_NOT_ALLOWED, "text/plain", "read-only"),
            None,
        );
    }
    if let Some(html) = webview_page_name(req.uri().path()).and_then(|name| {
        shared
            .webview_pages
            .lock()
            .ok()
            .and_then(|pages| pages.get(&(root.to_path_buf(), name.to_string())).cloned())
    }) {
        let text = inject_tag(&String::from_utf8_lossy(&html), tag);
        return (
            full(StatusCode::OK, "text/html; charset=utf-8", text),
            Some(html),
        );
    }
    let rooted = if extension && req.uri().path().starts_with(ROOT_FILES_PREFIX) {
        let roots = shared
            .webview_roots
            .lock()
            .ok()
            .and_then(|r| r.get(root).cloned())
            .unwrap_or_default();
        Some(resolve_rooted(&roots, req.uri().path()))
    } else {
        None
    };
    let resolved = match rooted {
        Some(found) => found,
        None => resolve_static(root, req.uri().path()),
    };
    let Some(path) = resolved else {
        let missing = format!("{} isn't in this folder.", req.uri().path());
        return (page(StatusCode::NOT_FOUND, "Not found", &missing), None);
    };
    let overlay = shared
        .overlays
        .lock()
        .ok()
        .and_then(|o| o.get(&path).cloned());
    let bytes = match overlay {
        Some(b) => b,
        None => match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(_) => {
                let page = page(
                    StatusCode::NOT_FOUND,
                    "Not found",
                    "The file can't be read.",
                );
                return (page, None);
            }
        },
    };
    let kind = content_type(&path);
    if kind.starts_with("text/html") {
        let html = inject_tag(&String::from_utf8_lossy(&bytes), tag);
        return (full(StatusCode::OK, kind, html), Some(bytes));
    }
    (full(StatusCode::OK, kind, bytes.clone()), Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview_page_names() {
        assert_eq!(webview_page_name("/__webview-p1.html"), Some("p1"));
        assert_eq!(webview_page_name("/__webview-a_b-C9.html"), Some("a_b-C9"));
        assert_eq!(webview_page_name("/__webview-.html"), None);
        assert_eq!(webview_page_name("/__webview-../x.html"), None);
        assert_eq!(webview_page_name("/sub/__webview-p1.html"), None);
        assert_eq!(webview_page_name("/__webview-p1.htm"), None);
        assert!(!is_webview_page_name(&"x".repeat(65)));
    }

    #[test]
    fn injects_after_head() {
        assert_eq!(
            inject("<!doctype html><html><HEAD lang=x><title>t</title>"),
            format!("<!doctype html><html><HEAD lang=x>{BRIDGE_TAG}<title>t</title>")
        );
        assert_eq!(
            inject("<html><header>x</header>"),
            format!("<html>{BRIDGE_TAG}<header>x</header>")
        );
        assert_eq!(inject("<p>hi"), format!("{BRIDGE_TAG}<p>hi"));
    }

    #[test]
    fn redirects_map_to_the_proxy_or_the_goto_page() {
        let up = "http://localhost:5173";
        let px = "http://127.0.0.1:40000";
        let rw = |l: &str, nav: bool| rewrite_location(l, up, px, nav);
        assert_eq!(
            rw("http://localhost:5173/a?b", true).as_deref(),
            Some("http://127.0.0.1:40000/a?b")
        );
        assert_eq!(
            rw("http://localhost:5173", false).as_deref(),
            Some("http://127.0.0.1:40000")
        );
        // Another port isn't the same origin.
        assert_eq!(
            rw("http://localhost:51730/x", true).as_deref(),
            Some("/__ide/goto?url=http%3A%2F%2Flocalhost%3A51730%2Fx")
        );
        assert_eq!(
            rw("http://127.0.0.1:8787/account", true).as_deref(),
            Some("/__ide/goto?url=http%3A%2F%2F127.0.0.1%3A8787%2Faccount")
        );
        assert!(rw("https://accounts.example.com/o?x=1", true)
            .is_some_and(|l| l.starts_with("/__ide/goto?url=https%3A")));
        assert!(rw("//cdn.example.com/x", true).is_some());
        // Fetches follow redirects themselves; relative ones and other schemes stay.
        assert_eq!(rw("http://127.0.0.1:8787/account", false), None);
        assert_eq!(rw("/login?next=http://localhost:5173/", true), None);
        assert_eq!(rw("myapp://callback", true), None);
        assert_eq!(rw("http://127.0.0.1:40000/self", true), None);
    }

    #[test]
    fn cookies_work_in_the_frame() {
        let chromium = |c: &str| frame_cookie(c, true);
        assert_eq!(chromium("sid=1"), "sid=1; SameSite=None; Secure");
        assert_eq!(
            chromium("sid=1; Path=/; HttpOnly; SameSite=Lax"),
            "sid=1; Path=/; HttpOnly; SameSite=None; Secure"
        );
        assert_eq!(
            chromium("sid=1; Domain=.localhost; Secure; samesite=strict"),
            "sid=1; Secure; SameSite=None"
        );
        assert_eq!(
            chromium("a=b; Domain=example.com"),
            "a=b; Domain=example.com; SameSite=None; Secure"
        );
        assert_eq!(
            chromium("a=b; Expires=Wed, 21 Oct 2026 07:28:00 GMT"),
            "a=b; Expires=Wed, 21 Oct 2026 07:28:00 GMT; SameSite=None; Secure"
        );
        let webkit = |c: &str| frame_cookie(c, false);
        assert_eq!(webkit("sid=1"), "sid=1");
        assert_eq!(
            webkit("sid=1; Path=/; SameSite=Strict; Domain=localhost"),
            "sid=1; Path=/"
        );
    }

    #[test]
    fn bodies_are_announced() {
        let mut h = hyper::HeaderMap::new();
        assert!(!request_has_body(&h));
        h.insert("content-length", HeaderValue::from_static("0"));
        assert!(!request_has_body(&h));
        h.insert("content-length", HeaderValue::from_static("12"));
        assert!(request_has_body(&h));
        let mut chunked = hyper::HeaderMap::new();
        chunked.insert("transfer-encoding", HeaderValue::from_static("chunked"));
        assert!(request_has_body(&chunked));
    }

    #[test]
    fn page_loads_are_navigations() {
        let mut h = hyper::HeaderMap::new();
        h.insert(
            "accept",
            HeaderValue::from_static("text/html,application/xhtml+xml"),
        );
        assert!(is_navigation(&h));
        h.insert("sec-fetch-mode", HeaderValue::from_static("cors"));
        assert!(!is_navigation(&h));
        h.insert("sec-fetch-mode", HeaderValue::from_static("navigate"));
        assert!(is_navigation(&h));
        let mut fetch = hyper::HeaderMap::new();
        fetch.insert("accept", HeaderValue::from_static("*/*"));
        assert!(!is_navigation(&fetch));
    }

    #[test]
    fn static_paths_stay_inside() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("proxy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("site/sub"))?;
        std::fs::write(dir.join("site/index.html"), "<p>root")?;
        std::fs::write(dir.join("site/sub/a b.css"), "p{}")?;
        std::fs::write(dir.join("secret.txt"), "no")?;
        let root = dir.join("site");
        assert!(resolve_static(&root, "/").is_some_and(|p| p.ends_with("index.html")));
        assert!(resolve_static(&root, "/sub/a%20b.css").is_some());
        assert!(resolve_static(&root, "/../secret.txt").is_none());
        assert!(resolve_static(&root, "/%2e%2e/secret.txt").is_none());
        assert!(resolve_static(&root, "/sub/").is_none());
        // A folder's index.html that links out of the root isn't served either.
        #[cfg(unix)]
        {
            std::fs::create_dir_all(dir.join("site/out"))?;
            std::os::unix::fs::symlink(dir.join("secret.txt"), dir.join("site/out/index.html"))?;
            assert!(resolve_static(&root, "/out/").is_none());
        }
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }

    /// `/__fs/<path>` as an extension's page writes it (its asWebviewUri): the absolute path's
    /// parts, percent-encoded, the drive first on Windows.
    fn rooted_url(path: &std::path::Path) -> String {
        let text = path.to_string_lossy().replace('\\', "/");
        let text = text.strip_prefix("//?/").unwrap_or(&text).to_string();
        let parts: Vec<String> = text
            .split('/')
            .filter(|p| !p.is_empty())
            .map(|p| p.replace(' ', "%20").replace(':', "%3A"))
            .collect();
        format!("{ROOT_FILES_PREFIX}{}", parts.join("/"))
    }

    #[test]
    fn root_files_stay_inside_their_roots() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("proxy-roots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("work/img"))?;
        std::fs::write(dir.join("work/img/a b.png"), "png")?;
        std::fs::write(dir.join("secret.txt"), "no")?;
        let work = std::fs::canonicalize(dir.join("work"))?;
        let roots = vec![work.clone()];
        let file = work.join("img").join("a b.png");
        assert_eq!(
            resolve_rooted(&roots, &rooted_url(&file)),
            Some(std::fs::canonicalize(&file)?)
        );
        // Outside the roots, a folder, `..`, or no roots at all: not served.
        let secret = std::fs::canonicalize(dir.join("secret.txt"))?;
        assert!(resolve_rooted(&roots, &rooted_url(&secret)).is_none());
        assert!(resolve_rooted(&roots, &rooted_url(&work.join("img"))).is_none());
        let climb = format!("{}/../../secret.txt", rooted_url(&work.join("img")));
        assert!(resolve_rooted(&roots, &climb).is_none());
        assert!(resolve_rooted(&[], &rooted_url(&file)).is_none());
        assert!(resolve_rooted(&roots, "/elsewhere").is_none());
        std::fs::remove_dir_all(dir)?;
        Ok(())
    }
}
