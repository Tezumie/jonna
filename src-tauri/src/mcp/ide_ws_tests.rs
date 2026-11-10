use super::*;

#[test]
fn sha1_and_the_handshake_key() {
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    assert_eq!(
        hex(&sha1(b"abc")),
        "a9993e364706816aba3e25717850c26c9cd0d89d"
    );
    assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
    // 56+ bytes: the padding spills into a second block.
    assert_eq!(
        hex(&sha1(
            b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
        )),
        "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
    );
    // RFC 6455 §1.3's example.
    assert_eq!(
        accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    );
    assert_eq!(base64(b"ab"), "YWI=");
}

#[tokio::test]
async fn frames_round_trip_with_a_client_mask() {
    for len in [5usize, 300, 70_000] {
        let payload: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        let server = frame(0x1, &payload);
        let (fin, op, back) = read_frame(&mut server.as_slice()).await.unwrap();
        assert!(fin);
        assert_eq!(op, 1);
        assert_eq!(back, payload);
        // A client's frame is masked.
        let mask = [1u8, 2, 3, 4];
        let mut masked = server.clone();
        let at = if len < 126 {
            2
        } else if len <= 0xFFFF {
            4
        } else {
            10
        };
        masked[1] |= 0x80;
        let mut body: Vec<u8> = payload
            .iter()
            .enumerate()
            .map(|(i, b)| b ^ mask[i % 4])
            .collect();
        masked.truncate(at);
        masked.extend_from_slice(&mask);
        masked.append(&mut body);
        let (_, _, back) = read_frame(&mut masked.as_slice()).await.unwrap();
        assert_eq!(back, payload);
    }
}

#[tokio::test]
async fn initialize_tools_and_unknown_methods() {
    let bridge = Bridge::default();
    let init = handle(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
        &bridge,
        "Test IDE",
    )
    .await
    .unwrap();
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "Test IDE");
    let tools = handle(
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        &bridge,
        "x",
    )
    .await
    .unwrap();
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for want in [
        "openFile",
        "openDiff",
        "getCurrentSelection",
        "getLatestSelection",
        "getOpenEditors",
        "getWorkspaceFolders",
        "getDiagnostics",
        "checkDocumentDirty",
        "saveDocument",
        "close_tab",
        "closeAllDiffTabs",
        "executeCode",
    ] {
        assert!(names.contains(&want), "{want}");
    }
    let unknown = handle(r#"{"jsonrpc":"2.0","id":3,"method":"x/y"}"#, &bridge, "x")
        .await
        .unwrap();
    assert_eq!(unknown["error"]["code"], -32601);
    assert!(handle(
        r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        &bridge,
        "x"
    )
    .await
    .is_none());
    // A tool call with no window connected says so, as a tool error.
    let call = handle(
        r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"getOpenEditors","arguments":{}}}"#,
        &bridge,
        "x",
    )
    .await
    .unwrap();
    assert_eq!(call["result"]["isError"], true);
    let bad = handle(
        r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"rm"}}"#,
        &bridge,
        "x",
    )
    .await
    .unwrap();
    assert_eq!(bad["error"]["code"], -32602);
}

async fn handshake(port: u16, token: Option<&str>, origin: Option<&str>) -> (TcpStream, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut req = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n"
    );
    if let Some(t) = token {
        req.push_str(&format!("x-claude-code-ide-authorization: {t}\r\n"));
    }
    if let Some(o) = origin {
        req.push_str(&format!("Origin: {o}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = vec![0u8; 1024];
    let mut got = Vec::new();
    loop {
        let n = s.read(&mut buf).await.unwrap();
        if n == 0 {
            break;
        }
        got.extend_from_slice(&buf[..n]);
        if got.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    (s, String::from_utf8_lossy(&got).to_string())
}

fn client_frame(text: &str) -> Vec<u8> {
    let mut f = frame(0x1, text.as_bytes());
    let at = if text.len() < 126 { 2 } else { 4 };
    f[1] |= 0x80;
    let body: Vec<u8> = f.split_off(at);
    f.extend_from_slice(&[0, 0, 0, 0]);
    f.extend_from_slice(&body);
    f
}

#[tokio::test]
async fn the_server_writes_its_lock_file_checks_the_token_and_speaks_mcp() {
    let dir = std::env::temp_dir().join(format!("ide-lock-test-{}", std::process::id()));
    let ide = IdeIntegration::default();
    let channel: Channel<BridgeRequest> = Channel::new(|_| Ok(()));
    let info = ide
        .start(
            channel,
            vec!["/work/app".into()],
            "Test IDE".into(),
            Some(dir.clone()),
        )
        .await
        .unwrap();
    let lock_path = dir.join(format!("{}.lock", info.port));
    let lock: Value = serde_json::from_str(&std::fs::read_to_string(&lock_path).unwrap()).unwrap();
    assert_eq!(lock["pid"], std::process::id());
    assert_eq!(lock["workspaceFolders"][0], "/work/app");
    assert_eq!(lock["ideName"], "Test IDE");
    assert_eq!(lock["transport"], "ws");
    let token = lock["authToken"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 32);
    assert_eq!(
        std::env::var("CLAUDE_CODE_SSE_PORT").unwrap(),
        info.port.to_string()
    );

    // No token, a wrong one, or a browser page: refused.
    for (t, o) in [
        (None, None),
        (Some("nope"), None),
        (Some(token.as_str()), Some("https://evil.example")),
    ] {
        let (_, reply) = handshake(info.port, t, o).await;
        assert!(reply.starts_with("HTTP/1.1 401"), "{reply}");
    }
    let (mut s, reply) = handshake(info.port, Some(&token), None).await;
    assert!(reply.starts_with("HTTP/1.1 101"), "{reply}");
    assert!(reply.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="));
    s.write_all(&client_frame(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
    ))
    .await
    .unwrap();
    let (_, op, payload) = read_frame(&mut s).await.unwrap();
    assert_eq!(op, 1);
    let v: Value = serde_json::from_slice(&payload).unwrap();
    assert_eq!(v["result"]["serverInfo"]["name"], "Test IDE");
    // Notifications reach connected clients.
    assert_eq!(ide.notify("selection_changed", json!({ "text": "x" })), 1);
    let (_, _, payload) = read_frame(&mut s).await.unwrap();
    let v: Value = serde_json::from_slice(&payload).unwrap();
    assert_eq!(v["method"], "selection_changed");
    assert_eq!(ide.info().unwrap().connected, 1);
    // A client that goes away isn't counted any more.
    drop(s);
    let mut gone = false;
    for _ in 0..100 {
        if ide.info().unwrap().connected == 0 {
            gone = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(gone, "the closed connection is still counted");
    // The folders change: the lock file follows.
    ide.update(vec!["/work/other".into()]).unwrap();
    let lock: Value = serde_json::from_str(&std::fs::read_to_string(&lock_path).unwrap()).unwrap();
    assert_eq!(lock["workspaceFolders"][0], "/work/other");
    ide.stop().unwrap();
    assert!(!lock_path.exists());
    assert!(ide.info().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn a_call_waiting_when_claude_code_disconnects_is_dropped() {
    let sent = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = sent.clone();
    let channel: Channel<BridgeRequest> = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(text) = body {
            seen.lock().unwrap().push(text);
        }
        Ok(())
    });
    let bridge = Arc::new(Bridge::default());
    bridge.set_channel(channel);
    let inflight: Arc<Mutex<HashSet<u64>>> = Arc::default();
    let (b, f) = (bridge.clone(), inflight.clone());
    let call = tokio::spawn(async move {
        handle_tracked(
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"openDiff","arguments":{}}}"#,
            &b,
            "x",
            Some(&f),
        )
        .await
    });
    let mut waited = 0;
    while inflight.lock().unwrap().is_empty() && waited < 100 {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        waited += 1;
    }
    let id = *inflight
        .lock()
        .unwrap()
        .iter()
        .next()
        .expect("the call is in flight");
    assert!(bridge.cancel(id, "Claude Code disconnected."));
    let reply = call.await.unwrap().unwrap();
    assert_eq!(reply["result"]["isError"], true);
    assert!(inflight.lock().unwrap().is_empty());
    let sent = sent.lock().unwrap().clone();
    assert!(
        sent.iter().any(|m| m.contains("\"kind\":\"cancel\"")),
        "{sent:?}"
    );
    // Answered already: nothing to drop.
    assert!(!bridge.cancel(id, "again"));
}
