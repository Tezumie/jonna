//! Tests of one connection, over a real socket pair and a small table of commands.

use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::ipc::{Channel, InvokeBody, Request, Response};

use super::*;

mod commands {
    use super::*;

    #[tauri::command]
    pub async fn echo(text: String, times: Option<u32>) -> String {
        text.repeat(times.unwrap_or(1) as usize)
    }

    #[tauri::command]
    pub async fn fails(name: String) -> crate::error::Result<()> {
        Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("no {name}")).into())
    }

    #[tauri::command]
    pub async fn upper(request: Request<'_>) -> crate::error::Result<Response> {
        let InvokeBody::Raw(bytes) = request.body() else {
            return Err(crate::error::Error::Invalid(
                "expected a raw byte body".into(),
            ));
        };
        let suffix = request
            .headers()
            .get("x-suffix")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let mut out = bytes.to_ascii_uppercase();
        out.extend_from_slice(suffix.as_bytes());
        Ok(Response::new(out))
    }

    /// Sends 0..count, then keeps sending until a send fails (the channel was closed) or
    /// `limit` more were sent; answers how many of those went out.
    #[tauri::command]
    pub async fn count(
        webview: tauri::Webview,
        count: u32,
        limit: u32,
        on_number: Channel<u32>,
    ) -> String {
        for n in 0..count {
            let _ = on_number.send(n);
        }
        let mut extra = 0;
        while extra < limit && on_number.send(1000 + extra).is_ok() {
            extra += 1;
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        format!("{}:{extra}", webview.label())
    }

    #[tauri::command]
    pub async fn slow(ms: u64) -> u64 {
        tokio::time::sleep(Duration::from_millis(ms)).await;
        ms
    }

    #[tauri::command]
    pub async fn panics() -> u32 {
        panic!("on purpose (a test)")
    }

    /// How many of `flood`'s messages the connection has taken.
    pub static FLOODED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

    /// Sends `count` messages of a mebibyte each from `from`: the command's "task", a "thread"
    /// of its own, or a single-threaded "runtime" of its own (as some services keep); answers
    /// how many were taken.
    #[tauri::command]
    pub async fn flood(
        count: u32,
        from: String,
        on_data: Channel<tauri::ipc::InvokeResponseBody>,
    ) -> u32 {
        let send = move || {
            let mut taken = 0;
            for n in 0..count {
                let chunk = vec![n as u8; 1024 * 1024];
                if on_data
                    .send(tauri::ipc::InvokeResponseBody::Raw(chunk))
                    .is_err()
                {
                    break;
                }
                taken += 1;
                FLOODED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
            taken
        };
        if from == "task" {
            return send();
        }
        let (done, taken) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let taken = if from == "runtime" {
                tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap()
                    .block_on(async move { send() })
            } else {
                send()
            };
            let _ = done.send(taken);
        });
        taken.await.unwrap_or(0)
    }

    /// What `note` was called with, in the order the calls ran.
    pub static NOTES: std::sync::Mutex<Vec<u64>> = std::sync::Mutex::new(Vec::new());

    /// A sync command, as a terminal's write is: the order of the calls is the result.
    #[tauri::command]
    pub fn note(n: u64, wait_ms: Option<u64>) {
        std::thread::sleep(Duration::from_millis(wait_ms.unwrap_or(0)));
        NOTES.lock().unwrap().push(n);
    }

    #[tauri::command]
    pub async fn noted() -> Vec<u64> {
        NOTES.lock().unwrap().clone()
    }
}

fn table() -> &'static [CommandEntry] {
    tauri::generate_handler![
        commands::echo,
        commands::fails,
        commands::upper,
        commands::count,
        commands::slow,
        commands::panics,
        commands::note,
        commands::noted,
        commands::flood,
    ]
}

/// The client's end of a served connection.
struct Client {
    stream: TcpStream,
    served: std::thread::JoinHandle<Ended>,
}

fn connect(token: Option<&'static str>) -> Client {
    connect_with(token, None)
}

/// `waits`: how long the host waits for `$/hello`, and for its last frames to be read.
fn connect_with(token: Option<&'static str>, waits: Option<(Duration, Duration)>) -> Client {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    let (accepted, _) = listener.accept().unwrap();
    let served = std::thread::spawn(move || {
        let app = AppHandle::new("dev.example.app", "Example", "9.9.9");
        let server = Server::new(app, table(), "9.9.9");
        let reader = accepted.try_clone().unwrap();
        let writer = accepted.try_clone().unwrap();
        let carrier = Carrier {
            reader: Box::new(reader),
            writer: Box::new(writer),
            hang_up: Box::new(move || {
                let _ = accepted.shutdown(std::net::Shutdown::Both);
            }),
        };
        let server = match waits {
            Some((hello, flush)) => server.with_waits(hello, flush),
            None => server,
        };
        tauri::async_runtime::block_on(server.serve(carrier, token)).ended
    });
    Client { stream, served }
}

impl Client {
    fn send(&mut self, header: Value, body: &[u8]) {
        write_frame(&mut self.stream, header.to_string().as_bytes(), body).unwrap();
    }

    /// The next frame: its header and body.
    fn next(&mut self) -> (Value, Vec<u8>) {
        let frame = read_frame(&mut self.stream)
            .unwrap()
            .expect("the host closed the connection");
        (serde_json::from_slice(&frame.header).unwrap(), frame.body)
    }

    fn hello(&mut self) -> Value {
        self.send(
            json!({ "id": 1, "method": "$/hello", "params": { "protocol": 1, "client": "test" } }),
            b"",
        );
        self.next().0
    }

    /// Reads until the answer to `id`; channel messages on the way are collected.
    fn answer(&mut self, id: u64, messages: &mut Vec<Value>) -> (Value, Vec<u8>) {
        loop {
            let (header, body) = self.next();
            if header.get("id").and_then(Value::as_u64) == Some(id) {
                return (header, body);
            }
            messages.push(header);
        }
    }

    fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(json!({ "id": id, "method": method, "params": params }), b"");
        self.answer(id, &mut Vec::new()).0
    }

    /// How the connection ended, when it did within `wait`.
    fn ended_within(self, wait: Duration) -> Option<Ended> {
        let Client { stream, served } = self;
        let (done, ended) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = done.send(served.join().unwrap());
        });
        let ended = ended.recv_timeout(wait).ok();
        // The client's end stays open until here: the host ended by itself.
        drop(stream);
        ended
    }

    /// True when the host has closed the connection.
    fn closed(&mut self) -> bool {
        matches!(read_frame(&mut self.stream), Ok(None) | Err(_))
    }
}

#[test]
fn hello_lists_the_commands() {
    let mut client = connect(None);
    let hello = client.hello();
    assert_eq!(hello["id"], 1);
    let result = &hello["result"];
    assert_eq!(result["protocol"], 1);
    assert_eq!(result["version"], "9.9.9");
    assert_eq!(result["os"], std::env::consts::OS);
    assert_eq!(result["pid"], std::process::id());
    assert_eq!(
        result["commands"],
        json!(["echo", "fails", "upper", "count", "slow", "panics", "note", "noted", "flood"])
    );
}

#[test]
fn anything_before_hello_is_refused() {
    let mut client = connect(None);
    client.send(
        json!({ "id": 5, "method": "echo", "params": { "text": "a" } }),
        b"",
    );
    let (answer, _) = client.next();
    assert_eq!(answer["error"]["code"], "Invalid");
    assert!(client.closed());
    assert_eq!(client.served.join().unwrap(), Ended::Closed);
}

#[test]
fn a_wrong_protocol_or_token_is_refused() {
    let mut client = connect(None);
    client.send(
        json!({ "id": 1, "method": "$/hello", "params": { "protocol": 2 } }),
        b"",
    );
    assert_eq!(client.next().0["error"]["code"], "Invalid");
    assert!(client.closed());

    let mut client = connect(Some("secret"));
    client.send(
        json!({ "id": 1, "method": "$/hello", "params": { "protocol": 1, "token": "guess" } }),
        b"",
    );
    assert_eq!(client.next().0["error"]["message"], "wrong token");
    assert!(client.closed());

    let mut client = connect(Some("secret"));
    client.send(
        json!({ "id": 1, "method": "$/hello", "params": { "protocol": 1, "token": "secret" } }),
        b"",
    );
    assert_eq!(client.next().0["result"]["protocol"], 1);
}

#[test]
fn results_errors_and_unknown_commands() {
    let mut client = connect(None);
    client.hello();
    assert_eq!(
        client.call(2, "echo", json!({ "text": "ab", "times": 2 })),
        json!({ "id": 2, "result": "abab" })
    );
    // Params left out: `{}`, so the required argument is missing.
    client.send(json!({ "id": 3, "method": "echo" }), b"");
    let (answer, _) = client.next();
    assert_eq!(answer["error"]["code"], "Invalid");
    assert!(answer["error"]["message"]
        .as_str()
        .unwrap()
        .contains("`text`"));
    assert_eq!(
        client.call(4, "fails", json!({ "name": "file" })),
        json!({ "id": 4, "error": { "code": "NotFound", "message": "no file" } })
    );
    assert_eq!(
        client.call(5, "window_open", json!({})),
        json!({ "id": 5, "error": { "code": "Invalid", "message": "unknown command: window_open" } })
    );
    assert_eq!(
        client.call(6, "echo", json!(["not", "an", "object"]))["error"]["code"],
        "Invalid"
    );
}

#[test]
fn raw_bodies_and_raw_results() {
    let mut client = connect(None);
    client.hello();
    client.send(
        json!({ "id": 2, "method": "upper", "raw": true, "headers": { "X-Suffix": "!" } }),
        b"shout",
    );
    let (header, body) = client.next();
    assert_eq!(header, json!({ "id": 2, "raw": true }));
    assert_eq!(body, b"SHOUT!");
}

#[test]
fn channel_messages_arrive_in_order_and_a_closed_channel_stops_sends() {
    let mut client = connect(None);
    client.hello();
    client.send(
        json!({ "id": 2, "method": "count", "params": { "count": 3, "limit": 2000, "onNumber": { "__channel": 7 } } }),
        b"",
    );
    for n in 0..3 {
        assert_eq!(client.next().0, json!({ "channel": 7, "data": n }));
    }
    // The command keeps sending until the channel is closed.
    assert_eq!(client.next().0["channel"], 7);
    client.send(
        json!({ "method": "$/channelClose", "params": { "channel": 7 } }),
        b"",
    );
    let mut messages = Vec::new();
    let (answer, _) = client.answer(2, &mut messages);
    let result = answer["result"].as_str().unwrap().to_string();
    let (label, sent) = result.split_once(':').unwrap();
    assert_eq!(label, CLIENT_LABEL);
    // It stopped long before its own limit.
    assert!(sent.parse::<u32>().unwrap() < 2000, "{result}");
}

#[test]
fn a_channel_the_host_dropped_ends_once() {
    let mut client = connect(None);
    client.hello();
    client.send(
        json!({ "id": 2, "method": "count", "params": { "count": 2, "limit": 0, "onNumber": { "__channel": 9 } } }),
        b"",
    );
    let mut messages = Vec::new();
    client.answer(2, &mut messages);
    // The end may come after the answer: a later request's answer is behind both.
    client.send(
        json!({ "id": 3, "method": "slow", "params": { "ms": 150 } }),
        b"",
    );
    client.answer(3, &mut messages);
    assert_eq!(
        messages,
        [
            json!({ "channel": 9, "data": 0 }),
            json!({ "channel": 9, "data": 1 }),
            json!({ "channel": 9, "end": true }),
        ]
    );
}

#[test]
fn a_channel_the_client_closed_is_not_ended() {
    let mut client = connect(None);
    client.hello();
    client.send(
        json!({ "method": "$/channelClose", "params": { "channel": 9 } }),
        b"",
    );
    client.send(
        json!({ "id": 2, "method": "count", "params": { "count": 2, "limit": 0, "onNumber": { "__channel": 9 } } }),
        b"",
    );
    let mut messages = Vec::new();
    client.answer(2, &mut messages);
    client.send(
        json!({ "id": 3, "method": "slow", "params": { "ms": 150 } }),
        b"",
    );
    client.answer(3, &mut messages);
    assert_eq!(messages, Vec::<Value>::new());
}

#[test]
fn requests_are_answered_as_they_finish() {
    let mut client = connect(None);
    client.hello();
    client.send(
        json!({ "id": 2, "method": "slow", "params": { "ms": 400 } }),
        b"",
    );
    for id in 3..40u64 {
        client.send(
            json!({ "id": id, "method": "echo", "params": { "text": id.to_string() } }),
            b"",
        );
    }
    let mut order = Vec::new();
    for _ in 2..40 {
        let (answer, _) = client.next();
        let id = answer["id"].as_u64().unwrap();
        if id != 2 {
            assert_eq!(answer["result"], id.to_string());
        }
        order.push(id);
    }
    // The slow one was sent first and answered last.
    assert_eq!(order.last(), Some(&2));
    order.sort_unstable();
    assert_eq!(order, (2..40).collect::<Vec<u64>>());
}

#[test]
fn sync_commands_run_one_at_a_time_in_the_order_sent() {
    let mut client = connect(None);
    client.hello();
    // The first one is slow: run each on a thread of its own and it would finish last.
    client.send(
        json!({ "id": 2, "method": "note", "params": { "n": 2, "waitMs": 300 } }),
        b"",
    );
    for id in 3..200u64 {
        client.send(
            json!({ "id": id, "method": "note", "params": { "n": id } }),
            b"",
        );
    }
    // An async command doesn't wait behind them.
    client.send(
        json!({ "id": 200, "method": "echo", "params": { "text": "now" } }),
        b"",
    );
    let mut order = Vec::new();
    for _ in 2..=200 {
        order.push(client.next().0["id"].as_u64().unwrap());
    }
    assert_eq!(order.first(), Some(&200));
    // Answers come in any order; what counts is the order the commands ran in.
    order.sort_unstable();
    assert_eq!(order, (2..=200).collect::<Vec<u64>>());
    assert_eq!(
        client.call(201, "noted", json!({}))["result"],
        json!((2..200).collect::<Vec<u64>>())
    );
}

#[test]
fn a_panicking_command_answers_and_the_host_goes_on() {
    let mut client = connect(None);
    client.hello();
    let answer = client.call(2, "panics", json!({}));
    assert_eq!(answer["error"]["code"], "Unknown");
    assert_eq!(
        client.call(3, "echo", json!({ "text": "still here" }))["result"],
        "still here"
    );
}

#[test]
fn shutdown_is_answered_then_the_connection_ends() {
    let mut client = connect(None);
    client.hello();
    assert_eq!(
        client.call(2, "$/shutdown", json!({})),
        json!({ "id": 2, "result": null })
    );
    assert!(client.closed());
    assert_eq!(client.served.join().unwrap(), Ended::Shutdown);
}

#[test]
fn the_end_of_the_stream_ends_the_connection() {
    let mut client = connect(None);
    client.hello();
    client.stream.shutdown(std::net::Shutdown::Write).unwrap();
    assert_eq!(client.served.join().unwrap(), Ended::Closed);
}

#[test]
fn a_broken_frame_closes_the_connection() {
    let mut client = connect(None);
    client.hello();
    write_frame(&mut client.stream, b"not json", b"").unwrap();
    assert!(client.closed());
    assert_eq!(client.served.join().unwrap(), Ended::Closed);
}

#[test]
fn a_client_that_says_nothing_is_dropped() {
    let waits = Some((Duration::from_millis(300), Duration::from_secs(5)));
    // Nothing at all.
    let client = connect_with(Some("secret"), waits);
    assert_eq!(
        client.ended_within(Duration::from_secs(8)),
        Some(Ended::Closed)
    );
    // A frame that never comes whole.
    let mut client = connect_with(Some("secret"), waits);
    client.stream.write_all(&[40, 0, 0, 0, 0, 0]).unwrap();
    assert_eq!(
        client.ended_within(Duration::from_secs(8)),
        Some(Ended::Closed)
    );
}

#[test]
fn the_first_frame_is_small_and_has_no_body() {
    // A header past the first frame's limit: refused on its length alone, none of it awaited.
    let mut client = connect(Some("secret"));
    let mut prefix = (64 * 1024 + 1u32).to_le_bytes().to_vec();
    prefix.extend_from_slice(&0u32.to_le_bytes());
    client.stream.write_all(&prefix).unwrap();
    assert_eq!(
        client.ended_within(Duration::from_secs(3)),
        Some(Ended::Closed)
    );
    // A body, of any size.
    let mut client = connect(Some("secret"));
    let mut prefix = 20u32.to_le_bytes().to_vec();
    prefix.extend_from_slice(&1u32.to_le_bytes());
    client.stream.write_all(&prefix).unwrap();
    assert_eq!(
        client.ended_within(Duration::from_secs(3)),
        Some(Ended::Closed)
    );
    // After `$/hello`, a frame may be larger than the first one.
    let mut client = connect(Some("secret"));
    client.send(
        json!({ "id": 1, "method": "$/hello", "params": { "protocol": 1, "token": "secret" } }),
        b"",
    );
    assert_eq!(client.next().0["result"]["protocol"], 1);
    let text = "x".repeat(100 * 1024);
    assert_eq!(
        client.call(2, "echo", json!({ "text": text }))["result"],
        text
    );
}

#[test]
fn frames_sent_behind_the_hello_are_read_once_it_is_accepted() {
    let mut client = connect(Some("secret"));
    client.send(
        json!({ "id": 1, "method": "$/hello", "params": { "protocol": 1, "token": "secret" } }),
        b"",
    );
    client.send(
        json!({ "id": 2, "method": "echo", "params": { "text": "x".repeat(100 * 1024) } }),
        b"",
    );
    assert_eq!(client.next().0["result"]["protocol"], 1);
    assert_eq!(client.next().0["id"], 2);
}

#[test]
fn the_processs_own_pipes_have_no_deadline() {
    // No token: the stream is the host's own stdin, whose other end started the host.
    let waits = Some((Duration::from_millis(100), Duration::from_secs(5)));
    let mut client = connect_with(None, waits);
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(client.hello()["result"]["protocol"], 1);
}

#[test]
fn a_client_that_stops_reading_does_not_keep_the_connection_open() {
    let waits = Some((Duration::from_secs(5), Duration::from_millis(300)));
    let mut client = connect_with(None, waits);
    client.hello();
    // Answers nobody reads: more than the socket holds, so the writer is stuck in a write.
    let text = "x".repeat(1024 * 1024);
    for id in 2..34u64 {
        client.send(
            json!({ "id": id, "method": "echo", "params": { "text": text } }),
            b"",
        );
    }
    std::thread::sleep(Duration::from_millis(500));
    client.stream.shutdown(std::net::Shutdown::Write).unwrap();
    assert_eq!(
        client.ended_within(Duration::from_secs(8)),
        Some(Ended::Closed)
    );
}

#[test]
fn messages_wait_for_a_client_that_reads_slowly() {
    use std::sync::atomic::Ordering;
    let mut client = connect(None);
    client.hello();
    let mut next_id = 2;
    for from in ["task", "thread", "runtime"] {
        commands::FLOODED.store(0, Ordering::SeqCst);
        let id = next_id;
        next_id += 1;
        client.send(
            json!({ "id": id, "method": "flood", "params": { "count": 200, "from": from, "onData": { "__channel": id } } }),
            b"",
        );
        // Nothing is read: the host takes what fits its budget (64 MiB, and what the socket
        // holds), and the command waits with the rest.
        std::thread::sleep(Duration::from_millis(1500));
        let taken = commands::FLOODED.load(Ordering::SeqCst);
        assert!(
            (1..140).contains(&taken),
            "{taken} of 200 MiB queued (sent from its {from})"
        );
        // Read: everything arrives, in order, and the command answers.
        let mut seen = 0u32;
        loop {
            let (header, body) = client.next();
            if header.get("id").and_then(Value::as_u64) == Some(id) {
                assert_eq!(header["result"], 200);
                break;
            }
            if header.get("end").is_some() {
                continue;
            }
            assert_eq!(header["channel"], id);
            assert_eq!(body.len(), 1024 * 1024);
            assert_eq!(body[0], seen as u8);
            seen += 1;
        }
        assert_eq!(seen, 200);
    }
    // The connection still answers.
    assert_eq!(
        client.call(next_id, "echo", json!({ "text": "after" }))["result"],
        "after"
    );
}
