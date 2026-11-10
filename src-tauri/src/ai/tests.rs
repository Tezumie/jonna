use serde_json::json;

use super::ollama::{parse_line, parse_show, parse_tags, request_body};
use super::openai::SseParser;
use super::*;

fn request(kind: ProviderKind) -> ChatRequest {
    ChatRequest {
        provider: Provider {
            id: "p".into(),
            kind,
            base_url: "http://x".into(),
        },
        model: "qwen3:8b".into(),
        messages: vec![
            Message {
                role: "user".into(),
                content: "hi".into(),
                tool_calls: vec![],
                tool_call_id: None,
                tool_name: None,
                images: vec![],
                thinking_blocks: vec![],
            },
            Message {
                role: "assistant".into(),
                content: String::new(),
                tool_calls: vec![ToolCall {
                    id: "c1".into(),
                    name: "read_file".into(),
                    arguments: json!({"path": "a"}),
                }],
                tool_call_id: None,
                tool_name: None,
                images: vec![],
                thinking_blocks: vec![],
            },
            Message {
                role: "tool".into(),
                content: "text".into(),
                tool_calls: vec![],
                tool_call_id: Some("c1".into()),
                tool_name: Some("read_file".into()),
                images: vec![],
                thinking_blocks: vec![],
            },
        ],
        tools: vec![ToolSpec {
            name: "read_file".into(),
            description: "Read".into(),
            parameters: json!({"type": "object"}),
        }],
        think: Some(true),
        temperature: None,
        context_length: Some(16384),
        max_tokens: None,
        cache_ttl: None,
        effort: None,
        keep_alive: None,
        no_cache: false,
        modalities: None,
    }
}

#[test]
fn openai_api_adds_v1_only_without_a_version() {
    assert_eq!(
        openai_api("http://127.0.0.1:1234", "models"),
        "http://127.0.0.1:1234/v1/models"
    );
    assert_eq!(
        openai_api("http://127.0.0.1:1234/v1/", "models"),
        "http://127.0.0.1:1234/v1/models"
    );
    assert_eq!(
        openai_api("https://api.groq.com/openai/v1", "models"),
        "https://api.groq.com/openai/v1/models"
    );
    assert_eq!(
        openai_api(
            "https://generativelanguage.googleapis.com/v1beta/openai",
            "models"
        ),
        "https://generativelanguage.googleapis.com/v1beta/openai/models"
    );
    assert_eq!(
        openai_api("https://api.z.ai/api/paas/v4", "chat/completions"),
        "https://api.z.ai/api/paas/v4/chat/completions"
    );
    assert_eq!(
        openai_api("https://example.com/openai", "models"),
        "https://example.com/openai/v1/models"
    );
    // A host that starts like a version isn't a path segment.
    assert_eq!(
        openai_api("http://v1host:8080", "models"),
        "http://v1host:8080/v1/models"
    );
}

#[test]
fn line_buffer_splits_across_chunks() {
    let mut b = LineBuffer::default();
    assert!(b.push(b"{\"a\":").is_empty());
    assert_eq!(
        b.push(b"1}\n{\"b\"\r\n:2"),
        vec!["{\"a\":1}".to_string(), "{\"b\"".to_string()]
    );
    assert_eq!(b.finish().as_deref(), Some(":2"));
    assert_eq!(b.finish(), None);
}

#[test]
fn ollama_tags_show_and_request() {
    let tags = parse_tags(&json!({"models": [
        {"name": "qwen3:8b", "size": 5_200_000_000u64, "details": {"family": "qwen3", "parameter_size": "8.2B", "quantization_level": "Q4_K_M"}},
        {"name": "kimi-k3:cloud", "remote_host": "https://ollama.com"}
    ]}));
    assert_eq!(tags.len(), 2);
    assert_eq!(tags[0].parameter_size.as_deref(), Some("8.2B"));
    assert!(!tags[0].remote && tags[1].remote);
    let show = parse_show(
        &json!({"capabilities": ["completion", "tools", "thinking"], "model_info": {"qwen3.context_length": 40960}}),
    );
    assert_eq!(
        (show.tools, show.thinking, show.vision, show.context_length),
        (Some(true), Some(true), Some(false), Some(40960))
    );
    assert_eq!(parse_show(&json!({})).tools, None);
    let body = request_body(&request(ProviderKind::Ollama));
    assert_eq!(
        body["messages"][1]["tool_calls"][0]["function"]["arguments"]["path"],
        "a"
    );
    assert_eq!(body["messages"][2]["tool_name"], "read_file");
    assert_eq!(body["tools"][0]["function"]["name"], "read_file");
    assert_eq!(body["think"], true);
    assert_eq!(body["options"]["num_ctx"], 16384);
}

#[test]
fn ollama_stream_lines() {
    let mut n = 0;
    assert_eq!(
        parse_line(
            r#"{"message":{"role":"assistant","content":"","thinking":"hmm"},"done":false}"#,
            &mut n
        )
        .unwrap(),
        vec![ChatEvent::Thinking { text: "hmm".into() }]
    );
    let call = parse_line(
        r#"{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"read_file","arguments":{"path":"src/a.ts"}}}]},"done":false}"#,
        &mut n,
    )
    .unwrap();
    assert_eq!(
        call,
        vec![ChatEvent::ToolCall {
            id: "call_1".into(),
            name: "read_file".into(),
            arguments: json!({"path": "src/a.ts"})
        }]
    );
    assert_eq!(
        parse_line(
            r#"{"done":true,"done_reason":"stop","prompt_eval_count":12,"eval_count":34}"#,
            &mut n
        )
        .unwrap(),
        vec![ChatEvent::Done {
            stop_reason: "stop".into(),
            input_tokens: Some(12),
            output_tokens: Some(34),
            cache_read_tokens: None,
            cache_write_tokens: None,
            cost: None,
        }]
    );
    assert!(parse_line(r#"{"error":"model not found"}"#, &mut n).is_err());
}

#[test]
fn openai_stream_assembles_tool_calls() {
    let mut p = SseParser::default();
    let mut events = Vec::new();
    for line in [
        r#"data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}"#,
        ": keep-alive",
        r#"data: {"choices":[{"delta":{"content":"lo","reasoning_content":"r"}}]}"#,
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read_","arguments":"{\"pa"}}]}}]}"#,
        r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\":\"x\"}"}}]}}]}"#,
        r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#,
        r#"data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}"#,
        "data: [DONE]",
    ] {
        events.extend(p.line(line).unwrap());
    }
    events.extend(p.finish());
    // Progress reports are checked in tool_progress_* tests.
    events.retain(|e| !matches!(e, ChatEvent::ToolProgress { .. }));
    assert_eq!(
        events,
        vec![
            ChatEvent::Text { text: "Hel".into() },
            ChatEvent::Thinking { text: "r".into() },
            ChatEvent::Text { text: "lo".into() },
            ChatEvent::ToolCall {
                id: "call_a".into(),
                name: "read_file".into(),
                arguments: json!({"path": "x"})
            },
            ChatEvent::Done {
                stop_reason: "tool_calls".into(),
                input_tokens: Some(5),
                output_tokens: Some(7),
                cache_read_tokens: None,
                cache_write_tokens: None,
                cost: None,
            },
        ]
    );
    let body = super::openai::request_body(&request(ProviderKind::Openai));
    assert_eq!(
        body["messages"][1]["tool_calls"][0]["function"]["arguments"],
        "{\"path\":\"a\"}"
    );
    assert_eq!(body["messages"][2]["tool_call_id"], "c1");
}

#[test]
fn secrets_round_trip() {
    let dir = std::env::temp_dir().join(format!("ide-secrets-{}", std::process::id()));
    let path = dir.join("secrets.json");
    secrets::set(&path, "openai", Some("sk-1")).unwrap();
    assert!(secrets::has(&path, "openai"));
    assert_eq!(secrets::get(&path, "openai").as_deref(), Some("sk-1"));
    secrets::set(&path, "openai", None).unwrap();
    assert!(!secrets::has(&path, "openai"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn max_tokens_maps_per_provider() {
    let mut req = request(ProviderKind::Ollama);
    req.max_tokens = Some(64);
    let body = ollama::request_body(&req);
    assert_eq!(body["options"]["num_predict"], 64);
    let mut req = request(ProviderKind::Openai);
    req.max_tokens = Some(64);
    let body = openai::request_body(&req);
    assert_eq!(body["max_tokens"], 64);
}

#[test]
fn anthropic_request_has_cache_breakpoints_and_alternating_turns() {
    let mut req = request(ProviderKind::Anthropic);
    req.messages.insert(
        0,
        Message {
            role: "system".into(),
            content: "You are a coding agent.".into(),
            tool_calls: vec![],
            tool_call_id: None,
            tool_name: None,
            images: vec![],
            thinking_blocks: vec![],
        },
    );
    req.messages[2].thinking_blocks =
        vec![json!({"type": "thinking", "thinking": "plan", "signature": "sig"})];
    // A screenshot after the tool result joins the same user turn.
    req.messages.push(Message {
        role: "user".into(),
        content: "(Screenshot)".into(),
        tool_calls: vec![],
        tool_call_id: None,
        tool_name: None,
        images: vec!["iVBORw0".into()],
        thinking_blocks: vec![],
    });
    req.temperature = Some(0.2);
    req.cache_ttl = Some("1h".into());
    let body = super::anthropic::request_body(&req);
    assert_eq!(body["system"][0]["text"], "You are a coding agent.");
    assert_eq!(body["system"][0]["cache_control"]["ttl"], "1h");
    assert_eq!(body["cache_control"]["type"], "ephemeral");
    assert!(body.get("temperature").is_none());
    assert_eq!(body["thinking"]["type"], "adaptive");
    assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
    let msgs = body["messages"].as_array().unwrap();
    let roles: Vec<&str> = msgs.iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["user", "assistant", "user"]);
    assert_eq!(msgs[1]["content"][0]["type"], "thinking");
    assert_eq!(msgs[1]["content"][0]["signature"], "sig");
    assert_eq!(msgs[1]["content"][1]["type"], "tool_use");
    assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
    assert_eq!(msgs[2]["content"][0]["tool_use_id"], "c1");
    assert_eq!(msgs[2]["content"][1]["type"], "image");
    // Older settings: Anthropic configured as OpenAI-compatible goes native.
    let p = Provider {
        id: "a".into(),
        kind: ProviderKind::Openai,
        base_url: "https://api.anthropic.com/v1".into(),
    };
    assert_eq!(p.effective_kind(), ProviderKind::Anthropic);
}

#[test]
fn anthropic_stream_events() {
    let mut p = super::anthropic::SseParser::default();
    let mut events = Vec::new();
    for line in [
        "event: message_start",
        r#"data: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_read_input_tokens":9000,"cache_creation_input_tokens":300,"output_tokens":1}}}"#,
        r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#,
        r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me"}}"#,
        r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}"#,
        r#"data: {"type":"content_block_stop","index":0}"#,
        r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}"#,
        r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Reading."}}"#,
        r#"data: {"type":"content_block_stop","index":1}"#,
        r#"data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}"#,
        r#"data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\": \"a"}}"#,
        r#"data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":".ts\"}"}}"#,
        r#"data: {"type":"content_block_stop","index":2}"#,
        r#"data: {"type":"ping"}"#,
        r#"data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}"#,
        r#"data: {"type":"message_stop"}"#,
    ] {
        events.extend(p.line(line).unwrap());
    }
    events.extend(p.finish());
    // Progress reports are checked in tool_progress_* tests.
    events.retain(|e| !matches!(e, ChatEvent::ToolProgress { .. }));
    assert_eq!(
        events,
        vec![
            ChatEvent::Thinking {
                text: "Let me".into()
            },
            ChatEvent::Reasoning {
                block: json!({"type": "thinking", "thinking": "Let me", "signature": "abc"})
            },
            ChatEvent::Text {
                text: "Reading.".into()
            },
            ChatEvent::ToolCall {
                id: "toolu_1".into(),
                name: "read_file".into(),
                arguments: json!({"path": "a.ts"})
            },
            ChatEvent::Done {
                stop_reason: "tool_calls".into(),
                input_tokens: Some(9320),
                output_tokens: Some(42),
                cache_read_tokens: Some(9000),
                cache_write_tokens: Some(300),
                cost: None,
            },
        ]
    );
    let mut p = super::anthropic::SseParser::default();
    let err = p
        .line(
            r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        )
        .unwrap_err();
    assert!(err.to_string().contains("529"));
    let d = super::anthropic::parse_model(&json!({
        "id": "claude-opus-5-5", "max_input_tokens": 1000000, "max_tokens": 128000,
        "capabilities": {"thinking": {"supported": true}, "image_input": {"supported": true}}
    }));
    assert_eq!(
        (d.thinking, d.vision, d.context_length, d.max_output_tokens),
        (Some(true), Some(true), Some(1000000), Some(128000))
    );
}

#[test]
fn openrouter_claude_gets_cache_breakpoints() {
    let mut req = request(ProviderKind::Openai);
    req.provider.base_url = "https://openrouter.ai/api/v1".into();
    req.model = "anthropic/claude-sonnet-5.5".into();
    let body = super::openai::request_body(&req);
    assert_eq!(
        body["messages"][0]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
    req.model = "openai/gpt-5".into();
    let body = super::openai::request_body(&req);
    assert!(body["messages"][0]["content"].is_string());
}

#[test]
fn tool_progress_reports_start_path_and_size() {
    let mut p = ToolStreamProgress::default();
    let start = p.update("", "write_file", "");
    assert!(matches!(start, Some(ChatEvent::ToolProgress { ref path, .. }) if path.is_none()));
    assert!(p.update("", "write_file", "{\"pa").is_none());
    let with_path = p.update(
        "",
        "write_file",
        "{\"path\": \"src/a\\\"b.ts\", \"content\": \"",
    );
    assert!(
        matches!(with_path, Some(ChatEvent::ToolProgress { ref path, .. }) if path.as_deref() == Some("src/a\"b.ts"))
    );
    let long = format!("{{\"path\": \"x\", \"content\": \"{}", "a".repeat(2100));
    assert!(p.update("", "write_file", &long).is_some());
    assert!(p.update("", "write_file", &format!("{long}aa")).is_none());
    assert!(p.update("", "", "{}").is_none());
}

#[test]
fn show_widget_arguments_stream_at_most_every_150_ms() {
    use std::time::{Duration, Instant};
    let mut p = ToolStreamProgress::default();
    let t0 = Instant::now();
    let args = |e: Option<ChatEvent>| match e {
        Some(ChatEvent::ToolProgress { arguments, id, .. }) => Some((arguments, id)),
        _ => None,
    };
    // Its start: which tool, nothing to draw yet.
    let start = p.update_at("t1", "show_widget", "", t0);
    assert!(matches!(
        start,
        Some(ChatEvent::ToolProgress {
            arguments: None,
            ..
        })
    ));
    let first = args(p.update_at("t1", "show_widget", "{\"widget_code\":\"<svg", t0));
    assert_eq!(
        first,
        Some((
            Some("{\"widget_code\":\"<svg".to_string()),
            Some("t1".to_string())
        ))
    );
    // Within 150 ms: held back; after it, the whole text so far.
    let more = "{\"widget_code\":\"<svg viewBox";
    assert!(p
        .update_at("t1", "show_widget", more, t0 + Duration::from_millis(100))
        .is_none());
    let later = args(p.update_at("t1", "show_widget", more, t0 + Duration::from_millis(160)));
    assert_eq!(later.and_then(|(a, _)| a).as_deref(), Some(more));
    // Other tools don't send their arguments.
    let mut w = ToolStreamProgress::default();
    let e = w.update_at("t2", "write_file", "{\"path\":\"a\"", t0);
    assert!(matches!(
        e,
        Some(ChatEvent::ToolProgress {
            arguments: None,
            ..
        })
    ));
}

#[test]
fn openai_stream_reports_tool_progress() {
    let mut sse = SseParser::default();
    let events = sse
        .line(r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":"{\"path\":\"index.html\","}}]}}]}"#)
        .unwrap();
    assert!(events.iter().any(|e| matches!(e, ChatEvent::ToolProgress { name, path, .. } if name == "write_file" && path.as_deref() == Some("index.html"))));
}

#[test]
fn anthropic_drops_an_assistant_message_that_is_only_thinking() {
    let msg = |role: &str, content: &str| Message {
        role: role.into(),
        content: content.into(),
        tool_calls: vec![],
        tool_call_id: None,
        tool_name: None,
        images: vec![],
        thinking_blocks: vec![],
    };
    let mut thinking = msg("assistant", "");
    thinking.thinking_blocks =
        vec![json!({ "type": "thinking", "thinking": "hmm", "signature": "s" })];
    let messages = vec![msg("user", "go"), thinking, msg("user", "Continue.")];
    let (_, out) = super::anthropic::convert(&messages);
    // No assistant turn ending in thinking: the two user messages are one turn.
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["role"], "user");
}

#[test]
fn openrouter_pricing_per_million() {
    let p = parse_pricing(Some(&json!({
        "prompt": "0.000003",
        "completion": "0.000015",
        "input_cache_read": "0.0000003"
    })))
    .expect("pricing");
    assert_eq!(p.input, 3.0);
    assert_eq!(p.output, 15.0);
    assert_eq!(p.cache_read, Some(0.3));
    assert_eq!(p.cache_write, None);
    assert!(parse_pricing(Some(&json!({ "prompt": "-1", "completion": "0" }))).is_none());
    assert!(parse_pricing(None).is_none());
}

#[test]
fn openrouter_reports_cost() {
    let mut p = SseParser::default();
    let mut events = Vec::new();
    for line in [
        r#"data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}"#,
        r#"data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"cost":0.00042,"prompt_tokens_details":{"cached_tokens":64}}}"#,
        "data: [DONE]",
    ] {
        events.extend(p.line(line).unwrap());
    }
    assert_eq!(
        events.last(),
        Some(&ChatEvent::Done {
            stop_reason: "stop".into(),
            input_tokens: Some(100),
            output_tokens: Some(20),
            cache_read_tokens: Some(64),
            cache_write_tokens: None,
            cost: Some(0.00042),
        })
    );
}

/// Serves `body` to every connection (HTTP/1.1, closed after), whatever was asked.
async fn serve_once(content_type: &'static str, body: &'static str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = listener.accept().await {
            let mut buf = vec![0u8; 65536];
            let _ = s.read(&mut buf).await;
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\nconnection: close\r\n\r\n"
            );
            let _ = s.write_all(format!("{head}{body}").as_bytes()).await;
            let _ = s.shutdown().await;
        }
    });
    format!("http://127.0.0.1:{port}")
}

#[tokio::test]
async fn a_reply_cut_off_mid_stream_is_an_error_not_a_finished_reply() {
    let client = reqwest::Client::new();
    let cases: [(ProviderKind, &str, &str, &str); 3] = [
        (
            ProviderKind::Ollama,
            "application/x-ndjson",
            "{\"message\":{\"content\":\"Hal\"},\"done\":false}\n",
            "{\"message\":{\"content\":\"Hal\"},\"done\":false}\n{\"done\":true,\"done_reason\":\"stop\"}\n",
        ),
        (
            ProviderKind::Openai,
            "text/event-stream",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"function\":{\"name\":\"write_file\",\"arguments\":\"{\\\"pa\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        ),
        (
            ProviderKind::Anthropic,
            "text/event-stream",
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hal\"}}\n\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n",
        ),
    ];
    for (kind, content_type, cut, whole) in cases {
        let mut seen: SeenLimits = None;
        for (body, complete) in [(cut, false), (whole, true)] {
            let mut req = request(kind);
            req.provider.base_url = serve_once(content_type, body).await;
            let mut events = Vec::new();
            let emit = |e: ChatEvent| events.push(e);
            let result = match kind {
                ProviderKind::Ollama => ollama::chat(&client, &req, emit).await,
                ProviderKind::Openai => openai::chat(&client, &req, None, emit, &mut seen).await,
                ProviderKind::Anthropic => {
                    anthropic::chat(&client, &req, None, emit, &mut seen).await
                }
            };
            let done = events.iter().any(|e| matches!(e, ChatEvent::Done { .. }));
            if complete {
                assert!(result.is_ok() && done, "{kind:?}: {result:?} {events:?}");
            } else {
                let err = result.expect_err("a cut-off reply");
                assert!(err.to_string().contains("cut off"), "{kind:?}: {err}");
                assert!(!events
                    .iter()
                    .any(|e| matches!(e, ChatEvent::ToolCall { .. })));
            }
        }
    }
}

#[tokio::test]
async fn a_stream_that_goes_silent_is_given_up() {
    use futures_util::stream::{self, StreamExt};
    let chunks: Vec<reqwest::Result<bytes::Bytes>> = vec![Ok(bytes::Bytes::from_static(b"a"))];
    let mut s = stream::iter(chunks).chain(stream::pending());
    let idle = std::time::Duration::from_millis(50);
    let first = next_chunk_within(&mut s, idle).await;
    assert!(matches!(first, Some(Ok(ref b)) if b.as_ref() == b"a"));
    match next_chunk_within(&mut s, idle).await {
        Some(Err(Error::Ai(m))) => assert!(m.contains("timed out"), "{m}"),
        other => panic!("expected a timeout, got {other:?}"),
    }
    // A stream that ends just ends.
    let mut done = stream::iter(Vec::<reqwest::Result<bytes::Bytes>>::new());
    assert!(next_chunk_within(&mut done, idle).await.is_none());
}

#[test]
fn openai_stream_images_from_image_models() {
    // OpenRouter's image models: `images` beside the text; a content array's image parts too.
    let mut p = SseParser::default();
    let mut events = Vec::new();
    for line in [
        r#"data: {"choices":[{"delta":{"content":"Here it is.","images":[{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgo="}}]}}]}"#,
        r#"data: {"choices":[{"delta":{"content":[{"type":"text","text":" And"},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,/9j/4AAQ"}}]}}]}"#,
        r#"data: {"choices":[{"delta":{"images":[{"type":"image_url","image_url":{"url":"https://example.com/a.png"}},{"type":"image_url","image_url":{"url":"data:text/plain;base64,aGk="}}]},"finish_reason":"stop"}]}"#,
        "data: [DONE]",
    ] {
        events.extend(p.line(line).unwrap());
    }
    let images: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            ChatEvent::Image { mime, data, url } => Some((mime.clone(), data.clone(), url.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        images,
        vec![
            ("image/png".into(), "iVBORw0KGgo=".into(), None),
            ("image/jpeg".into(), "/9j/4AAQ".into(), None),
            (
                "image/png".into(),
                String::new(),
                Some("https://example.com/a.png".into())
            ),
        ]
    );
    assert!(events.contains(&ChatEvent::Text {
        text: " And".into()
    }));
}

#[test]
fn image_models_ask_for_images() {
    let mut req = request(ProviderKind::Openai);
    req.modalities = Some(vec!["image".into(), "text".into()]);
    let body = super::openai::request_body(&req);
    assert_eq!(body["modalities"], json!(["image", "text"]));
    let plain = super::openai::request_body(&request(ProviderKind::Openai));
    assert!(plain.get("modalities").is_none());
}
