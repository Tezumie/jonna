//! The stand-in framework's `#[command]` attribute: its argument and return mapping, and the
//! command table (`host-shim`, tested here because it is only built with the host).

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::host::{ChannelSink, CommandEntry, Invocation, Reply, SyncQueue};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request, Response};
use tauri::{AppHandle, Manager, State, Webview};

struct Counter {
    start: u32,
}

#[derive(Default)]
struct Notes(Mutex<Vec<u32>>);

/// The app's error shape: `{ code, message }`.
#[derive(Debug, Serialize)]
struct Failure {
    code: &'static str,
    message: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Point {
    x_pos: i32,
    y_pos: i32,
}

mod commands {
    use super::*;

    #[tauri::command]
    pub async fn add(state: State<'_, Counter>, first_number: u32, other: Option<u32>) -> u32 {
        state.start + first_number + other.unwrap_or(0)
    }

    #[tauri::command]
    pub fn sync_point(point: Point, mut scale: i32) -> Result<Point, Failure> {
        scale += 0;
        if scale == 0 {
            return Err(Failure {
                code: "Invalid",
                message: "scale is zero".into(),
            });
        }
        Ok(Point {
            x_pos: point.x_pos * scale,
            y_pos: point.y_pos * scale,
        })
    }

    #[tauri::command(rename_all = "snake_case")]
    pub async fn snake(file_name: String) -> String {
        file_name
    }

    #[tauri::command]
    pub async fn nothing() {}

    #[tauri::command]
    pub async fn unit_result(fail: bool) -> Result<(), Failure> {
        if fail {
            Err(Failure {
                code: "NotFound",
                message: "gone".into(),
            })
        } else {
            Ok(())
        }
    }

    #[tauri::command]
    pub async fn raw_echo(request: Request<'_>) -> Result<Response, Failure> {
        let name = request
            .headers()
            .get("x-name")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let InvokeBody::Raw(bytes) = request.body() else {
            return Err(Failure {
                code: "Invalid",
                message: "expected a raw byte body".into(),
            });
        };
        let mut out = name.into_bytes();
        out.extend_from_slice(bytes);
        Ok(Response::new(out))
    }

    #[tauri::command]
    pub async fn stream(
        app: AppHandle,
        webview: Webview,
        count: u32,
        on_item: Channel<Point>,
        on_bytes: Channel<InvokeResponseBody>,
    ) -> Result<String, Failure> {
        for i in 0..count {
            let _ = on_item.send(Point {
                x_pos: i as i32,
                y_pos: 0,
            });
        }
        let _ = on_bytes.send(InvokeResponseBody::Raw(vec![1, 2, 3]));
        Ok(format!(
            "{}:{}",
            webview.label(),
            app.state::<Counter>().start
        ))
    }

    #[tauri::command]
    pub fn panics() -> u32 {
        panic!("on purpose")
    }

    /// Notes `n` after `wait_ms`: what ran, in the order it ran.
    #[tauri::command]
    pub fn note(notes: State<'_, Notes>, n: u32, wait_ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(wait_ms));
        notes.0.lock().unwrap().push(n);
    }

    /// The same, off the caller's thread.
    #[tauri::command(async)]
    pub fn note_unordered(notes: State<'_, Notes>, n: u32, wait_ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(wait_ms));
        notes.0.lock().unwrap().push(n);
    }
}

const TABLE: &[CommandEntry] = tauri::generate_handler![
    commands::add,
    commands::sync_point,
    commands::snake,
    commands::nothing,
    commands::unit_result,
    commands::raw_echo,
    commands::stream,
    commands::panics,
    commands::note,
    commands::note_unordered,
];

/// What the commands sent, and which channels ended (id, no body).
type Sent = Arc<Mutex<Vec<(u32, Option<InvokeResponseBody>)>>>;

struct Recorder(Sent);

impl ChannelSink for Recorder {
    fn send(&self, id: u32, body: InvokeResponseBody) -> tauri::Result<()> {
        self.0.lock().unwrap().push((id, Some(body)));
        Ok(())
    }

    fn end(&self, id: u32) {
        self.0.lock().unwrap().push((id, None));
    }
}

fn app() -> AppHandle {
    let app = AppHandle::new("dev.example.app", "Example", "1.2.3");
    app.manage(Counter { start: 100 });
    app
}

fn invocation(params: Value, sent: &Sent) -> Invocation {
    Invocation {
        app: app(),
        client: Arc::from("main"),
        body: InvokeBody::Json(params.clone()),
        params,
        headers: tauri::http::HeaderMap::new(),
        channels: Arc::new(Recorder(sent.clone())),
        ordered: SyncQueue::new().unwrap(),
    }
}

fn call(name: &str, params: Value) -> Reply {
    call_with(name, invocation(params, &Sent::default()))
}

fn call_with(name: &str, invocation: Invocation) -> Reply {
    let entry = TABLE
        .iter()
        .find(|e| e.name == name)
        .unwrap_or_else(|| panic!("no command {name}"));
    tauri::async_runtime::block_on((entry.run)(invocation))
}

fn json_of(reply: Reply) -> Value {
    match reply {
        Reply::Json(text) => serde_json::from_str(&text).unwrap(),
        other => panic!("not a JSON result: {other:?}"),
    }
}

fn error_of(reply: Reply) -> Value {
    match reply {
        Reply::Error(text) => serde_json::from_str(&text).unwrap(),
        other => panic!("not an error: {other:?}"),
    }
}

#[test]
fn the_table_names_commands_by_function_name() {
    let names: Vec<&str> = TABLE.iter().map(|e| e.name).collect();
    assert_eq!(
        names,
        [
            "add",
            "sync_point",
            "snake",
            "nothing",
            "unit_result",
            "raw_echo",
            "stream",
            "panics",
            "note",
            "note_unordered"
        ]
    );
}

#[test]
fn arguments_are_camel_case_and_state_is_injected() {
    assert_eq!(
        json_of(call("add", json!({ "firstNumber": 5, "other": 2 }))),
        json!(107)
    );
}

#[test]
fn a_missing_optional_argument_is_none_and_unknown_ones_are_ignored() {
    assert_eq!(
        json_of(call("add", json!({ "firstNumber": 5, "extra": true }))),
        json!(105)
    );
    assert_eq!(
        json_of(call("add", json!({ "firstNumber": 5, "other": null }))),
        json!(105)
    );
}

#[test]
fn a_missing_or_wrong_argument_is_invalid_and_names_it() {
    let missing = error_of(call("add", json!({})));
    assert_eq!(missing["code"], "Invalid");
    assert!(missing["message"]
        .as_str()
        .unwrap()
        .contains("`firstNumber`"));
    // The snake_case spelling isn't the argument.
    let snake = error_of(call("add", json!({ "first_number": 5 })));
    assert_eq!(snake["code"], "Invalid");
    let wrong = error_of(call("add", json!({ "firstNumber": "five" })));
    assert!(wrong["message"].as_str().unwrap().contains("`firstNumber`"));
}

#[test]
fn rename_all_snake_case_keeps_the_names() {
    assert_eq!(
        json_of(call("snake", json!({ "file_name": "a.txt" }))),
        json!("a.txt")
    );
    assert_eq!(
        error_of(call("snake", json!({ "fileName": "a.txt" })))["code"],
        "Invalid"
    );
}

#[test]
fn sync_commands_and_struct_arguments() {
    assert_eq!(
        json_of(call(
            "sync_point",
            json!({ "point": { "xPos": 2, "yPos": 3 }, "scale": 10 })
        )),
        json!({ "xPos": 20, "yPos": 30 })
    );
}

#[test]
fn an_error_is_serialized_as_the_error_type_does() {
    assert_eq!(
        error_of(call(
            "sync_point",
            json!({ "point": { "xPos": 2, "yPos": 3 }, "scale": 0 })
        )),
        json!({ "code": "Invalid", "message": "scale is zero" })
    );
    assert_eq!(
        error_of(call("unit_result", json!({ "fail": true }))),
        json!({ "code": "NotFound", "message": "gone" })
    );
}

#[test]
fn unit_results_are_null() {
    assert_eq!(json_of(call("nothing", json!({}))), Value::Null);
    assert_eq!(
        json_of(call("unit_result", json!({ "fail": false }))),
        Value::Null
    );
}

#[test]
fn a_raw_body_and_headers_reach_the_command_and_bytes_come_back() {
    let mut inv = invocation(Value::Null, &Sent::default());
    inv.body = InvokeBody::Raw(b"abc".to_vec());
    inv.headers
        .insert("x-name", tauri::http::HeaderValue::from_static("n:"));
    assert_eq!(call_with("raw_echo", inv), Reply::Raw(b"n:abc".to_vec()));
    // Called without a raw body: the command's own error.
    assert_eq!(
        error_of(call("raw_echo", json!({})))["message"],
        "expected a raw byte body"
    );
}

#[test]
fn channels_are_bound_to_the_clients_ids() {
    let sent = Sent::default();
    let reply = call_with(
        "stream",
        invocation(
            json!({ "count": 2, "onItem": { "__channel": 7 }, "onBytes": { "__channel": 8 } }),
            &sent,
        ),
    );
    assert_eq!(json_of(reply), json!("main:100"));
    let sent = sent.lock().unwrap();
    for (i, (id, body)) in sent.iter().take(2).enumerate() {
        assert_eq!(*id, 7);
        let Some(InvokeResponseBody::Json(text)) = body else {
            panic!("expected JSON");
        };
        assert_eq!(
            serde_json::from_str::<Value>(text).unwrap(),
            json!({ "xPos": i, "yPos": 0 })
        );
    }
    assert_eq!(sent[2].0, 8);
    assert!(matches!(&sent[2].1, Some(InvokeResponseBody::Raw(b)) if b == &[1, 2, 3]));
    // The command returned and kept neither channel: each ended, once, after its messages.
    assert_eq!(sent.len(), 5);
    let mut ended: Vec<u32> = sent[3..]
        .iter()
        .map(|(id, body)| {
            assert!(body.is_none());
            *id
        })
        .collect();
    ended.sort_unstable();
    assert_eq!(ended, [7, 8]);
}

#[test]
fn a_missing_channel_is_invalid() {
    let error = error_of(call("stream", json!({ "count": 1 })));
    assert_eq!(error["code"], "Invalid");
    assert!(error["message"].as_str().unwrap().contains("`onItem`"));
}

#[test]
fn a_panicking_sync_command_answers_an_error() {
    assert_eq!(error_of(call("panics", json!({})))["code"], "Unknown");
}

/// Calls `name` with n = 0, 1, 2… one after another without waiting for answers (the first
/// two calls are the slow ones), then waits for all; answers what ran, in the order it ran.
fn notes_of(name: &str, count: u32) -> Vec<u32> {
    let entry = TABLE.iter().find(|e| e.name == name).unwrap();
    let app = app();
    app.manage(Notes::default());
    let ordered = SyncQueue::new().unwrap();
    tauri::async_runtime::block_on(async {
        let mut running = Vec::new();
        for n in 0..count {
            let mut inv = invocation(
                json!({ "n": n, "waitMs": if n < 2 { 150 } else { 0 } }),
                &Sent::default(),
            );
            inv.app = app.clone();
            inv.ordered = ordered.clone();
            running.push(tokio::spawn((entry.run)(inv)));
        }
        for task in running {
            assert_eq!(json_of(task.await.unwrap()), Value::Null);
        }
    });
    let notes = app.state::<Notes>().0.lock().unwrap().clone();
    notes
}

#[test]
fn sync_commands_run_one_at_a_time_in_the_order_called() {
    assert_eq!(notes_of("note", 50), (0..50).collect::<Vec<u32>>());
}

#[test]
fn a_sync_command_marked_async_does_not_wait_for_the_others() {
    let notes = notes_of("note_unordered", 10);
    // The two slow ones ran beside the rest and finished last.
    let mut last_two = notes[8..].to_vec();
    last_two.sort_unstable();
    assert_eq!(last_two, [0, 1]);
}

#[test]
fn a_panic_in_a_sync_command_does_not_stop_the_ones_behind_it() {
    let ordered = SyncQueue::new().unwrap();
    let call_on = |name: &str, params: Value| {
        let mut inv = invocation(params, &Sent::default());
        inv.ordered = ordered.clone();
        call_with(name, inv)
    };
    let error = error_of(call_on("panics", json!({})));
    assert_eq!(error["code"], "Unknown");
    assert!(error["message"].as_str().unwrap().contains("on purpose"));
    assert_eq!(
        json_of(call_on(
            "sync_point",
            json!({ "point": { "xPos": 1, "yPos": 2 }, "scale": 2 })
        )),
        json!({ "xPos": 2, "yPos": 4 })
    );
}
