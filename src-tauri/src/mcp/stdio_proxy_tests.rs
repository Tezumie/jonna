use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{json, Value};

use super::*;

#[test]
fn only_the_ides_own_server_on_this_computer() {
    assert!(check_url("http://127.0.0.1:4000/mcp").is_ok());
    assert!(check_url("http://localhost:4000/mcp").is_ok());
    assert!(check_url("http://[::1]:4000/mcp").is_ok());
    assert!(check_url("https://127.0.0.1:4000/mcp").is_err());
    assert!(check_url("http://example.com:4000/mcp").is_err());
    assert!(check_url("http://127.0.0.1.example.com:80/mcp").is_err());
    assert!(check_url("http://user:pw@127.0.0.1:4000/mcp").is_err());
    assert!(check_url("file:///etc/passwd").is_err());
}

#[test]
fn messages_are_classified_and_put_on_one_line() {
    assert_eq!(
        classify(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#),
        Some((Some(json!(1)), true))
    );
    assert_eq!(
        classify(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#),
        Some((None, false))
    );
    // A response to the server (no method) waits for nothing.
    assert_eq!(
        classify(r#"{"jsonrpc":"2.0","id":4,"result":{}}"#),
        Some((None, false))
    );
    assert_eq!(classify("[1,2]"), None);
    assert_eq!(classify("not json"), None);
    assert_eq!(one_line("{\n \"a\": 1\n}").as_deref(), Some("{\"a\":1}"));
    assert_eq!(one_line("[]"), None);
    let e: Value = serde_json::from_str(&error_reply(&json!("x"), "gone")).unwrap();
    assert_eq!(e["id"], "x");
    assert_eq!(e["error"]["message"], "gone");
}

type Seen = Arc<Mutex<Vec<String>>>;

/// A stand-in for the IDE's server: JSON for initialize, an event stream for tools/list, 202 for
/// notifications, a slow answer for "slow", 401 without the token.
async fn fake_server(seen: Seen) -> u16 {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let seen = seen.clone();
            tokio::spawn(async move {
                let service = service_fn(move |req: Request<Incoming>| {
                    let seen = seen.clone();
                    async move {
                        let auth = req
                            .headers()
                            .get("authorization")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();
                        let session = req
                            .headers()
                            .get("mcp-session-id")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("-")
                            .to_string();
                        let protocol = req
                            .headers()
                            .get("mcp-protocol-version")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("-")
                            .to_string();
                        let method = req.method().to_string();
                        let body = req.into_body().collect().await.unwrap().to_bytes();
                        let msg: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                        let name = msg["method"].as_str().unwrap_or("").to_string();
                        seen.lock()
                            .unwrap()
                            .push(format!("{method} {name} {session} {protocol}"));
                        let mut response = Response::builder();
                        if auth != "Bearer t0k" {
                            return Ok::<_, Infallible>(
                                response
                                    .status(401)
                                    .body(Full::new(Bytes::from("no")))
                                    .unwrap(),
                            );
                        }
                        let id = msg["id"].clone();
                        let reply = match name.as_str() {
                            "initialize" => {
                                response = response
                                    .header("content-type", "application/json")
                                    .header("mcp-session-id", "s1");
                                json!({ "jsonrpc": "2.0", "id": id, "result": { "protocolVersion": "2025-03-26" } })
                                    .to_string()
                            }
                            "tools/list" => {
                                response = response.header("content-type", "text/event-stream");
                                let answer = json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": [] } });
                                // A message over two data lines (joined with a line break).
                                format!(
                                    "data: {{\ndata: \"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}}\n\nevent: message\ndata: {answer}\n\n"
                                )
                            }
                            "slow" => {
                                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                                response = response.header("content-type", "application/json");
                                json!({ "jsonrpc": "2.0", "id": id, "result": "slow" }).to_string()
                            }
                            "fast" => {
                                response = response.header("content-type", "application/json");
                                json!({ "jsonrpc": "2.0", "id": id, "result": "fast" }).to_string()
                            }
                            _ if method == "DELETE" => String::new(),
                            _ => {
                                return Ok(response
                                    .status(202)
                                    .body(Full::new(Bytes::new()))
                                    .unwrap())
                            }
                        };
                        Ok(response.body(Full::new(Bytes::from(reply))).unwrap())
                    }
                });
                let _ = http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    port
}

fn proxy(port: u16, token: &str, out: Seen) -> Arc<Proxy> {
    let url = check_url(&format!("http://127.0.0.1:{port}/mcp")).unwrap();
    Arc::new(Proxy::new(
        url,
        token,
        Arc::new(move |line| out.lock().unwrap().push(line)),
    ))
}

#[tokio::test]
async fn messages_go_through_with_the_session_and_answers_come_back_as_lines() {
    let seen = Seen::default();
    let port = fake_server(seen.clone()).await;
    let out = Seen::default();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    for line in [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"slow"}"#,
        r#"{"jsonrpc":"2.0","id":3,"method":"fast"}"#,
        r#"{"jsonrpc":"2.0","id":4,"method":"tools/list"}"#,
        "garbage",
    ] {
        tx.send(line.to_string()).unwrap();
    }
    let p = proxy(port, "t0k", out.clone());
    let done = tokio::spawn(p.pump(rx));
    // The slow answer comes after the ones sent later (requests run side by side).
    tokio::time::sleep(std::time::Duration::from_millis(700)).await;
    drop(tx);
    done.await.unwrap();
    let out = out.lock().unwrap().clone();
    let ids: Vec<Value> = out
        .iter()
        .map(|l| serde_json::from_str::<Value>(l).unwrap()["id"].clone())
        .collect();
    assert_eq!(out.len(), 5, "{out:?}");
    assert!(out.iter().all(|l| !l.contains('\n')));
    assert_eq!(ids[0], json!(1));
    assert_eq!(ids.last(), Some(&json!(2)), "{out:?}");
    assert!(out.iter().any(|l| l.contains("notifications/message")));
    let seen = seen.lock().unwrap().clone();
    // The session and the protocol version from initialize go with every later request, and
    // the session is ended when stdin closes.
    assert_eq!(seen[0], "POST initialize - -");
    assert!(
        seen[1..]
            .iter()
            .all(|s| s.ends_with(" s1 2025-03-26") || s.starts_with("DELETE")),
        "{seen:?}"
    );
    assert!(seen.last().unwrap().starts_with("DELETE"), "{seen:?}");
}

#[tokio::test]
async fn a_request_the_server_refuses_gets_an_error_answer() {
    let seen = Seen::default();
    let port = fake_server(seen.clone()).await;
    let out = Seen::default();
    let p = proxy(port, "wrong", out.clone());
    p.forward(r#"{"jsonrpc":"2.0","id":7,"method":"initialize"}"#.into())
        .await;
    // A notification has nobody to tell.
    p.forward(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into())
        .await;
    let out = out.lock().unwrap().clone();
    assert_eq!(out.len(), 1);
    let e: Value = serde_json::from_str(&out[0]).unwrap();
    assert_eq!(e["id"], 7);
    assert!(e["error"]["message"].as_str().unwrap().contains("401"));
    // Nothing listening: the agent hears that the IDE's server isn't running.
    let out2 = Seen::default();
    proxy(1, "t0k", out2.clone())
        .forward(r#"{"jsonrpc":"2.0","id":8,"method":"tools/list"}"#.into())
        .await;
    assert!(out2.lock().unwrap()[0].contains("isn't running"));
}

#[test]
fn the_get_streams_answers_are_taken_as_the_spec_says() {
    assert_eq!(stream_answer(200, "text/event-stream"), StreamAnswer::Open);
    assert_eq!(
        stream_answer(200, "text/event-stream; charset=utf-8"),
        StreamAnswer::Open
    );
    assert_eq!(stream_answer(405, ""), StreamAnswer::Unsupported);
    assert_eq!(
        stream_answer(200, "application/json"),
        StreamAnswer::Unsupported
    );
    assert_eq!(stream_answer(202, ""), StreamAnswer::Unsupported);
    assert_eq!(stream_answer(404, ""), StreamAnswer::Stop);
    assert_eq!(stream_answer(401, ""), StreamAnswer::Stop);
    assert_eq!(stream_answer(503, ""), StreamAnswer::Retry);
    assert!(is_initialized(
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
    ));
    assert!(!is_initialized(
        r#"{"jsonrpc":"2.0","id":1,"method":"notifications/initialized"}"#
    ));
    assert!(!is_initialized(
        r#"{"jsonrpc":"2.0","method":"tools/list"}"#
    ));
}

/// The repository's mock remote MCP server (tests/fixtures/mock-remote-mcp.mjs, served by
/// mock-ollama.mjs): its first GET stream sends tools/list_changed (a tool added meanwhile) and
/// ends; the proxy writes it to stdout and opens the stream again. Skipped without Node.
#[tokio::test]
async fn the_servers_own_messages_come_through_the_get_stream() {
    use std::io::BufRead as _;
    use std::process::Stdio;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let port = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        l.local_addr().unwrap().port()
    };
    let Ok(mut node) = std::process::Command::new("node")
        .arg(root.join("tests/fixtures/mock-ollama.mjs"))
        .arg(port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    else {
        eprintln!("node isn't installed: skipped");
        return;
    };
    struct Kill(std::process::Child);
    impl Drop for Kill {
        fn drop(&mut self) {
            let _ = self.0.kill();
        }
    }
    let stderr = node.stderr.take().unwrap();
    let _node = Kill(node);
    // Ready once it says so on stderr.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let marker = format!("on {port}");
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if line.contains(&marker) {
                let _ = ready_tx.send(true);
            }
        }
    });
    let ready = ready_rx.recv_timeout(std::time::Duration::from_secs(20));
    assert_eq!(ready, Ok(true), "the mock didn't start");
    let out = Seen::default();
    let url = check_url(&format!("http://127.0.0.1:{port}/remote-mcp/mcp")).unwrap();
    let sink = out.clone();
    let p = Arc::new(Proxy::new(
        url,
        "t0k",
        Arc::new(move |line| sink.lock().unwrap().push(line)),
    ));
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let done = tokio::spawn(p.pump(rx));
    tx.send(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#.into())
        .unwrap();
    tx.send(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.into())
        .unwrap();
    let mut heard = false;
    for _ in 0..80 {
        if out
            .lock()
            .unwrap()
            .iter()
            .any(|l| l.contains("notifications/tools/list_changed"))
        {
            heard = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(heard, "{:?}", out.lock().unwrap());
    // The tool the notification announced is there.
    tx.send(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#.into())
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    drop(tx);
    tokio::time::timeout(std::time::Duration::from_secs(10), done)
        .await
        .unwrap()
        .unwrap();
    let out = out.lock().unwrap().clone();
    assert!(
        out.iter()
            .any(|l| l.contains("\"id\":2") && l.contains("late")),
        "{out:?}"
    );
    // Each message once (the reopened stream doesn't repeat it).
    assert_eq!(
        out.iter()
            .filter(|l| l.contains("notifications/tools/list_changed"))
            .count(),
        1
    );
}
