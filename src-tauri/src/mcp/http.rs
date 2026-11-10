//! The HTTP side: a hyper server on 127.0.0.1:<random> serving rmcp's Streamable HTTP service at
//! `/mcp`, behind a bearer-token check. Host and Origin are validated by rmcp (loopback only; a
//! browser page on another origin is refused), so a web page can't drive the IDE.

use std::convert::Infallible;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tower_service::Service;

use super::handler::IdeServer;
use super::{Bridge, Catalog};
use crate::error::Result;

type Body = BoxBody<Bytes, Infallible>;

fn plain(status: StatusCode, text: &'static str) -> Response<Body> {
    let mut response = Response::new(Full::new(Bytes::from_static(text.as_bytes())).boxed());
    *response.status_mut() = status;
    response
}

/// Constant-time comparison so the token can't be guessed byte by byte from timing.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Binds, starts serving in the background, returns the port.
pub async fn serve(
    catalog: Arc<RwLock<Catalog>>,
    bridge: Arc<Bridge>,
    token: String,
    cancel: CancellationToken,
) -> Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let mut config = StreamableHttpServerConfig::default();
    config.cancellation_token = cancel.child_token();
    config.sse_keep_alive = Some(Duration::from_secs(15));
    config.allowed_origins = vec![
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ];
    let server = IdeServer { catalog, bridge };
    let mcp = StreamableHttpService::new(
        move || Ok(server.clone()),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let expected = format!("Bearer {token}");
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
            stream.set_nodelay(true).ok();
            let mcp = mcp.clone();
            let expected = expected.clone();
            let cancel = cancel.clone();
            tauri::async_runtime::spawn(async move {
                let service = service_fn(move |req: Request<Incoming>| {
                    let mut mcp = mcp.clone();
                    let authorized = req
                        .headers()
                        .get(hyper::header::AUTHORIZATION)
                        .is_some_and(|v| same(v.as_bytes(), expected.as_bytes()));
                    let path_ok = req.uri().path() == "/mcp";
                    async move {
                        if !path_ok {
                            return Ok::<_, Infallible>(plain(StatusCode::NOT_FOUND, "not found"));
                        }
                        if !authorized {
                            return Ok(plain(
                                StatusCode::UNAUTHORIZED,
                                "missing or wrong bearer token (see the IDE's MCP connection info)",
                            ));
                        }
                        mcp.call(req).await
                    }
                });
                let conn = http1::Builder::new().serve_connection(TokioIo::new(stream), service);
                tokio::select! {
                    _ = cancel.cancelled() => {}
                    _ = conn => {}
                }
            });
        }
    });
    Ok(port)
}
