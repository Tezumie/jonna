//! Everything the server sends goes through one channel to the thread that owns standard output,
//! so frames from concurrent requests and streams never interleave. The channel is bounded: a
//! program printing faster than the connection carries it waits instead of filling memory.

use std::io::Write;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};

use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::frame::{write_frame, MAX_FRAME};

/// Frames queued for the writer (each up to 64 KiB of stream data, so about 64 MiB at most).
const CAPACITY: usize = 1024;

pub enum Out {
    Frame(Vec<u8>),
    /// Flush what came before, then end the server (`shutdown`).
    Exit,
}

#[derive(Clone)]
pub struct Outbox {
    tx: SyncSender<Out>,
}

impl Outbox {
    pub fn new() -> (Self, Receiver<Out>) {
        let (tx, rx) = sync_channel(CAPACITY);
        (Self { tx }, rx)
    }

    /// A notification (no id, no answer).
    pub fn notify(&self, method: &str, params: Value) {
        let message = json!({ "notify": method, "params": params });
        match serde_json::to_vec(&message) {
            Ok(bytes) if bytes.len() <= MAX_FRAME => self.send(bytes),
            Ok(bytes) => eprintln!("dropped a {method} notification of {} bytes", bytes.len()),
            Err(e) => eprintln!("couldn't encode a {method} notification: {e}"),
        }
    }

    /// The one response to request `id`.
    pub fn respond(&self, id: Value, result: Result<Value>) {
        let message = match result {
            Ok(value) => json!({ "id": id, "result": value }),
            Err(e) => json!({ "id": id, "error": e.to_json() }),
        };
        let bytes = match serde_json::to_vec(&message) {
            Ok(bytes) if bytes.len() <= MAX_FRAME => bytes,
            // The app would end the connection on a frame this big: answer with an error instead.
            Ok(_) => error_bytes(
                &id,
                &Error::Invalid("the result is too large to send".into()),
            ),
            Err(e) => error_bytes(&id, &Error::Invalid(e.to_string())),
        };
        self.send(bytes);
    }

    pub fn exit(&self) {
        let _ = self.tx.send(Out::Exit);
    }

    fn send(&self, bytes: Vec<u8>) {
        // The writer only goes away when the server is ending.
        let _ = self.tx.send(Out::Frame(bytes));
    }
}

fn error_bytes(id: &Value, e: &Error) -> Vec<u8> {
    serde_json::to_vec(&json!({ "id": id, "error": e.to_json() })).unwrap_or_default()
}

/// Writes frames to `output` until `Exit` or a write fails (the app is gone); flushes whenever
/// the queue runs empty, so a burst goes out in few writes. Returns when the server should end.
pub fn write_all(rx: &Receiver<Out>, output: &mut impl Write) {
    while let Ok(first) = rx.recv() {
        let mut next = Some(first);
        while let Some(out) = next.take() {
            match out {
                Out::Frame(bytes) => {
                    if write_frame(output, &bytes).is_err() {
                        return;
                    }
                }
                Out::Exit => {
                    let _ = output.flush();
                    return;
                }
            }
            next = rx.try_recv().ok();
        }
        if output.flush().is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::read_frame;

    #[test]
    fn responses_and_notifications_are_framed_in_order() -> Result<()> {
        let (out, rx) = Outbox::new();
        out.respond(json!(1), Ok(json!({ "a": 1 })));
        out.respond(json!(2), Err(Error::NoWorkspace));
        out.notify("stream.data", json!({ "stream": 3 }));
        out.exit();
        let mut buf = Vec::new();
        write_all(&rx, &mut buf);
        let mut input = &buf[..];
        let mut messages = Vec::new();
        while let Some(frame) = read_frame(&mut input)? {
            messages.push(serde_json::from_slice::<Value>(&frame)?);
        }
        assert_eq!(messages[0], json!({ "id": 1, "result": { "a": 1 } }));
        assert_eq!(messages[1]["error"]["code"], "NoWorkspace");
        assert_eq!(messages[2]["notify"], "stream.data");
        Ok(())
    }
}
