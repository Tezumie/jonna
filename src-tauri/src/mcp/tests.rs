use std::io::{Read, Write};
use std::net::TcpStream;

use serde_json::json;

use super::*;

/// One raw HTTP/1.1 POST; returns (status line + headers, body).
fn post(port: u16, token: Option<&str>, session: Option<&str>, body: &str) -> (String, String) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    let mut req = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(t) = token {
        req.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    if let Some(s) = session {
        req.push_str(&format!(
            "Mcp-Session-Id: {s}\r\nMcp-Protocol-Version: 2025-06-18\r\n"
        ));
    }
    req.push_str("\r\n");
    req.push_str(body);
    stream.write_all(req.as_bytes()).expect("write");
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(3)))
        .expect("timeout");
    let mut out = Vec::new();
    let _ = stream.read_to_end(&mut out);
    let text = String::from_utf8_lossy(&out).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    (head.to_string(), body.to_string())
}

#[test]
fn serves_tools_only_with_the_token() {
    tauri::async_runtime::block_on(async {
        let catalog = Arc::new(RwLock::new(Catalog {
            tools: vec![ToolSpec {
                command: "editor.openFile".into(),
                title: "Open file".into(),
                description: "Opens a file.".into(),
                input_schema: json!({ "type": "object" }),
                core: true,
                read_only: true,
            }],
            resources: vec![],
        }));
        let cancel = CancellationToken::new();
        let port = http::serve(
            catalog,
            Arc::new(Bridge::default()),
            "secret".into(),
            cancel.clone(),
        )
        .await
        .expect("serve");
        let result = tokio::task::spawn_blocking(move || {
            let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}"#;
            let (head, _) = post(port, None, None, init);
            assert!(head.starts_with("HTTP/1.1 401"), "{head}");
            let (head, body) = post(port, Some("wrong"), None, init);
            assert!(head.starts_with("HTTP/1.1 401"), "{head} {body}");
            let (head, body) = post(port, Some("secret"), None, init);
            assert!(head.starts_with("HTTP/1.1 200"), "{head} {body}");
            assert!(body.contains("\"tools\""), "{body}");
            let session = head
                .lines()
                .find_map(|l| l.to_lowercase().strip_prefix("mcp-session-id:").map(|v| v.trim().to_string()))
                .expect("session id");
            let note = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
            post(port, Some("secret"), Some(&session), note);
            let list = r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#;
            let (head, body) = post(port, Some("secret"), Some(&session), list);
            assert!(head.starts_with("HTTP/1.1 200"), "{head}");
            assert!(body.contains("editor_openFile"), "{body}");
            assert!(body.contains("ide_find_commands"), "{body}");
        })
        .await;
        cancel.cancel();
        result.expect("client");
    });
}
