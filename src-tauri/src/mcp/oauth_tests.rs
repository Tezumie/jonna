use super::*;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[test]
fn pkce_challenge_is_rfc_7636s() {
    // RFC 7636 appendix B.
    assert_eq!(
        code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    let (verifier, challenge) = pkce_pair().unwrap();
    assert_eq!(verifier.len(), 43);
    assert_eq!(code_challenge(&verifier), challenge);
    assert!(verifier
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    assert_eq!(base64url(b"f"), "Zg");
    assert_eq!(base64url(b"fo"), "Zm8");
    assert_eq!(base64url(b"foo"), "Zm9v");
    assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
}

#[test]
fn www_authenticate_parameters() {
    let h = r#"Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="read write""#;
    assert_eq!(
        header_param(h, "resource_metadata").as_deref(),
        Some("https://mcp.example.com/.well-known/oauth-protected-resource")
    );
    assert_eq!(header_param(h, "scope").as_deref(), Some("read write"));
    assert_eq!(header_param("Bearer realm=x", "resource_metadata"), None);
    assert_eq!(
        header_param(
            "Bearer resource_metadata=https://a/b, x=1",
            "resource_metadata"
        )
        .as_deref(),
        Some("https://a/b")
    );
    assert_eq!(header_param("Bearer xscope=\"a\"", "scope"), None);
}

#[test]
fn metadata_addresses() {
    assert_eq!(
        resource_metadata_urls("https://mcp.example.com/v1/mcp", None).unwrap(),
        vec![
            "https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp",
            "https://mcp.example.com/.well-known/oauth-protected-resource",
        ]
    );
    assert_eq!(
        resource_metadata_urls("https://a.com/", Some("https://a.com/meta")).unwrap(),
        vec![
            "https://a.com/meta",
            "https://a.com/.well-known/oauth-protected-resource"
        ]
    );
    assert_eq!(
        auth_server_metadata_urls("https://auth.example.com/tenant1").unwrap(),
        vec![
            "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
            "https://auth.example.com/.well-known/openid-configuration/tenant1",
            "https://auth.example.com/tenant1/.well-known/openid-configuration",
        ]
    );
    assert_eq!(
        auth_server_metadata_urls("https://auth.example.com").unwrap()[0],
        "https://auth.example.com/.well-known/oauth-authorization-server"
    );
    assert_eq!(
        canonical_resource("HTTPS://MCP.Example.com/mcp/#x").unwrap(),
        "https://mcp.example.com/mcp"
    );
    assert_eq!(
        canonical_resource("https://mcp.example.com/").unwrap(),
        "https://mcp.example.com"
    );
    let parsed: ProtectedResource = serde_json::from_str(
        r#"{"resource":"https://r","authorization_servers":["https://as"],"bearer_methods_supported":["header"]}"#,
    )
    .unwrap();
    assert_eq!(parsed.authorization_servers, vec!["https://as"]);
}

#[test]
fn metadata_must_name_this_server_as_its_resource() {
    let s = "https://mcp.example.com/v1/mcp";
    assert!(resource_covers("https://mcp.example.com/v1/mcp", s));
    assert!(resource_covers("https://mcp.example.com/v1/mcp/", s));
    assert!(resource_covers("https://mcp.example.com/v1", s));
    assert!(resource_covers("https://MCP.example.com", s));
    assert!(!resource_covers("https://other.example.com/v1/mcp", s));
    assert!(!resource_covers("https://mcp.example.com/v1/mc", s));
    assert!(!resource_covers("https://mcp.example.com/v2", s));
    assert!(!resource_covers("http://mcp.example.com/v1/mcp", s));
    assert!(!resource_covers("not a url", s));
}

#[tokio::test]
async fn a_refresh_that_cant_reach_the_server_keeps_the_tokens() {
    // A port nothing listens on: the refresh fails without an answer.
    let port = {
        let l = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        l.local_addr().unwrap().port()
    };
    let dir = std::env::temp_dir().join(format!("ide-oauth-offline-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let secrets = dir.join("secrets.json");
    let server_url = "http://127.0.0.1:1/mcp";
    let tokens = Tokens {
        access_token: "a".into(),
        refresh_token: Some("r".into()),
        expires_at: Some(1),
        token_endpoint: format!("http://127.0.0.1:{port}/token"),
        client_id: "c".into(),
        client_secret: None,
        resource: server_url.into(),
        server_url: server_url.into(),
        scope: None,
    };
    save(&secrets, "s", &tokens).unwrap();
    let client = reqwest::Client::new();
    assert_eq!(
        access_token(&client, &secrets, "s", server_url, false).await,
        None
    );
    assert!(status(&secrets, "s", server_url).signed_in);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn callback_parameters_and_secret_ids() {
    let p = callback_params("/callback?code=abc&state=xyz").unwrap();
    assert_eq!(p.get("code").map(String::as_str), Some("abc"));
    assert!(callback_params("/favicon.ico").is_none());
    assert_eq!(secret_id("my server"), "mcp.oauth.my_server");
}

/// A mock MCP server with its own authorization server (RFC 9728 + 8414 + 7591 + PKCE).
struct Mock {
    challenges: std::sync::Mutex<Vec<String>>,
    refreshed: std::sync::atomic::AtomicUsize,
}

async fn serve_mock() -> (u16, Arc<Mock>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let mock = Arc::new(Mock {
        challenges: std::sync::Mutex::new(Vec::new()),
        refreshed: std::sync::atomic::AtomicUsize::new(0),
    });
    let state = mock.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                continue;
            };
            let state = state.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (head, body) = loop {
                    let n = stream.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..end]).to_string();
                        let length = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        while buf.len() < end + 4 + length {
                            let n = stream.read(&mut chunk).await.unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            buf.extend_from_slice(&chunk[..n]);
                        }
                        break (head, String::from_utf8_lossy(&buf[end + 4..]).to_string());
                    }
                };
                let line = head.lines().next().unwrap_or("").to_string();
                let mut parts = line.split(' ');
                let method = parts.next().unwrap_or("");
                let target = parts.next().unwrap_or("");
                let url = reqwest::Url::parse(&format!("http://127.0.0.1:{port}{target}")).unwrap();
                let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
                let form: HashMap<String, String> =
                    reqwest::Url::parse(&format!("http://x/?{body}"))
                        .unwrap()
                        .query_pairs()
                        .into_owned()
                        .collect();
                let base = format!("http://127.0.0.1:{port}");
                let json = |v: Value| (200, String::new(), v.to_string());
                let (status, location, text) = match (method, url.path()) {
                    ("POST", "/mcp") => (401, String::new(), String::new()),
                    ("GET", "/.well-known/oauth-protected-resource/mcp") => {
                        json(serde_json::json!({
                            "resource": format!("{base}/mcp"),
                            "authorization_servers": [format!("{base}/auth")],
                            "scopes_supported": ["mcp:read"],
                        }))
                    }
                    ("GET", "/.well-known/oauth-authorization-server/auth") => {
                        json(serde_json::json!({
                            "issuer": format!("{base}/auth"),
                            "authorization_endpoint": format!("{base}/auth/authorize"),
                            "token_endpoint": format!("{base}/auth/token"),
                            "registration_endpoint": format!("{base}/auth/register"),
                            "code_challenge_methods_supported": ["S256"],
                        }))
                    }
                    ("POST", "/auth/register") => {
                        let v: Value = serde_json::from_str(&body).unwrap_or_default();
                        assert_eq!(v["token_endpoint_auth_method"], "none");
                        assert!(v["redirect_uris"][0]
                            .as_str()
                            .unwrap()
                            .starts_with("http://127.0.0.1:"));
                        json(serde_json::json!({ "client_id": "client-1" }))
                    }
                    ("GET", "/auth/authorize") => {
                        assert_eq!(
                            q.get("code_challenge_method").map(String::as_str),
                            Some("S256")
                        );
                        assert_eq!(q.get("client_id").map(String::as_str), Some("client-1"));
                        assert_eq!(q.get("resource"), Some(&format!("{base}/mcp")));
                        assert_eq!(q.get("scope").map(String::as_str), Some("mcp:read"));
                        state
                            .challenges
                            .lock()
                            .unwrap()
                            .push(q.get("code_challenge").cloned().unwrap_or_default());
                        let to = format!(
                            "{}?code=code-1&state={}",
                            q.get("redirect_uri").cloned().unwrap_or_default(),
                            q.get("state").cloned().unwrap_or_default()
                        );
                        (302, to, String::new())
                    }
                    ("POST", "/auth/token") => match form.get("grant_type").map(String::as_str) {
                        Some("authorization_code") => {
                            let verifier = form.get("code_verifier").cloned().unwrap_or_default();
                            let ok = state
                                .challenges
                                .lock()
                                .unwrap()
                                .iter()
                                .any(|c| *c == code_challenge(&verifier));
                            if ok && form.get("code").map(String::as_str) == Some("code-1") {
                                json(serde_json::json!({
                                    "access_token": "access-1",
                                    "refresh_token": "refresh-1",
                                    "expires_in": 3600,
                                    "token_type": "Bearer",
                                }))
                            } else {
                                (400, String::new(), r#"{"error":"invalid_grant"}"#.into())
                            }
                        }
                        Some("refresh_token") => {
                            state
                                .refreshed
                                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            if form.get("refresh_token").map(String::as_str) == Some("refresh-1") {
                                json(
                                    serde_json::json!({ "access_token": "access-2", "expires_in": 3600 }),
                                )
                            } else {
                                (400, String::new(), r#"{"error":"invalid_grant"}"#.into())
                            }
                        }
                        _ => (400, String::new(), String::new()),
                    },
                    _ => (404, String::new(), String::new()),
                };
                let mut reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
                    text.len()
                );
                if status == 401 {
                    reply.push_str(&format!(
                        "WWW-Authenticate: Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\"\r\n"
                    ));
                }
                if !location.is_empty() {
                    reply.push_str(&format!("Location: {location}\r\n"));
                }
                reply.push_str("\r\n");
                reply.push_str(&text);
                let _ = stream.write_all(reply.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    (port, mock)
}

#[tokio::test]
async fn sign_in_end_to_end_against_a_mock_server() {
    let (port, mock) = serve_mock().await;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let server_url = format!("http://127.0.0.1:{port}/mcp");
    // The 401 and its header, as remote::post sees them.
    let probe = client.post(&server_url).body("{}").send().await.unwrap();
    assert_eq!(probe.status().as_u16(), 401);
    let header = probe
        .headers()
        .get("www-authenticate")
        .and_then(|v| v.to_str().ok())
        .unwrap()
        .to_string();
    let found = discover(&client, &server_url, Some(&header)).await.unwrap();
    assert_eq!(found.resource, server_url);
    assert_eq!(found.scope.as_deref(), Some("mcp:read"));
    assert!(found.server.token_endpoint.ends_with("/auth/token"));

    let flow = begin(
        &client,
        "remote",
        &server_url,
        Some(&header),
        "IDE",
        None,
        None,
    )
    .await
    .unwrap();
    assert_eq!(flow.client_id, "client-1");
    assert!(flow.authorize_url.contains("code_challenge_method=S256"));
    // The browser: follows the authorization page's redirect to the loopback address.
    let browser = reqwest::Client::new();
    let url = flow.authorize_url.clone();
    let visit = tokio::spawn(async move { browser.get(url).send().await.map(|r| r.status()) });
    let code = wait_for_code(&flow, Duration::from_secs(10)).await.unwrap();
    assert_eq!(code, "code-1");
    assert_eq!(visit.await.unwrap().unwrap().as_u16(), 200);
    let tokens = exchange(&client, &flow, &code).await.unwrap();
    assert_eq!(tokens.access_token, "access-1");
    assert_eq!(tokens.refresh_token.as_deref(), Some("refresh-1"));
    assert!(tokens.expires_at.unwrap() > now());

    // Stored, then refreshed when forced (after a 401), keeping the refresh token.
    let dir = std::env::temp_dir().join(format!("ide-oauth-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let secrets = dir.join("secrets.json");
    save(&secrets, "remote", &tokens).unwrap();
    assert!(status(&secrets, "remote", &server_url).signed_in);
    assert!(!status(&secrets, "remote", "https://other/mcp").signed_in);
    assert_eq!(
        access_token(&client, &secrets, "remote", &server_url, false)
            .await
            .as_deref(),
        Some("access-1")
    );
    assert_eq!(
        access_token(&client, &secrets, "remote", &server_url, true)
            .await
            .as_deref(),
        Some("access-2")
    );
    assert_eq!(mock.refreshed.load(std::sync::atomic::Ordering::SeqCst), 1);
    let kept = load(&secrets, "remote", &server_url).unwrap();
    assert_eq!(kept.refresh_token.as_deref(), Some("refresh-1"));
    // A refresh token the server refuses: signed out.
    let mut bad = kept.clone();
    bad.refresh_token = Some("revoked".into());
    save(&secrets, "remote", &bad).unwrap();
    assert_eq!(
        access_token(&client, &secrets, "remote", &server_url, true).await,
        None
    );
    assert!(!status(&secrets, "remote", &server_url).signed_in);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn step_up_asks_for_the_granted_scopes_and_the_new_ones() {
    let h = r#"Bearer error="insufficient_scope", scope="files:write", resource_metadata="https://x/.well-known/oauth-protected-resource""#;
    assert_eq!(insufficient_scope(h), Some(Some("files:write".into())));
    assert_eq!(
        insufficient_scope(r#"Bearer error="insufficient_scope""#),
        Some(None)
    );
    assert_eq!(insufficient_scope(r#"Bearer error="invalid_token""#), None);
    assert_eq!(insufficient_scope(r#"Bearer realm="x""#), None);
    assert_eq!(
        merge_scopes(Some("read files:read"), Some("files:write read")).as_deref(),
        Some("read files:read files:write")
    );
    assert_eq!(merge_scopes(None, None), None);
    assert_eq!(merge_scopes(Some(""), Some("a")).as_deref(), Some("a"));
}

#[tokio::test]
async fn a_step_up_sign_in_keeps_what_was_granted() {
    let (port, _mock) = serve_mock().await;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let server_url = format!("http://127.0.0.1:{port}/mcp");
    let header = format!(
        r#"Bearer error="insufficient_scope", scope="mcp:write", resource_metadata="http://127.0.0.1:{port}/.well-known/oauth-protected-resource/mcp""#
    );
    let flow = begin(
        &client,
        "remote",
        &server_url,
        Some(&header),
        "IDE",
        None,
        Some("mcp:read"),
    )
    .await
    .unwrap();
    assert_eq!(flow.scope.as_deref(), Some("mcp:read mcp:write"));
    assert!(flow.authorize_url.contains("scope=mcp%3Aread+mcp%3Awrite"));
}

#[tokio::test]
async fn a_wrong_state_is_ignored_and_an_error_ends_the_sign_in() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let flow = PendingFlow {
        server: "s".into(),
        server_url: "http://x/mcp".into(),
        listener,
        redirect_uri: format!("http://127.0.0.1:{port}/callback"),
        state: "good".into(),
        verifier: "v".into(),
        client_id: "c".into(),
        client_secret: None,
        token_endpoint: "http://x/token".into(),
        resource: "http://x/mcp".into(),
        scope: None,
        authorize_url: String::new(),
    };
    let browser = reqwest::Client::new();
    let base = format!("http://127.0.0.1:{port}");
    let visits = tokio::spawn(async move {
        let a = browser
            .get(format!("{base}/callback?code=x&state=bad"))
            .send()
            .await
            .map(|r| r.status().as_u16());
        let b = browser
            .get(format!("{base}/callback?error=access_denied&state=good"))
            .send()
            .await
            .map(|r| r.status().as_u16());
        (a, b)
    });
    let err = wait_for_code(&flow, Duration::from_secs(10))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("access_denied"));
    let (a, b) = visits.await.unwrap();
    assert_eq!(a.unwrap(), 400);
    assert_eq!(b.unwrap(), 400);
}
