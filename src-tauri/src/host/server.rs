//! One client connection: frames in, commands run, frames out.
//!
//! The reader and the writer are threads of their own (the carriers are blocking streams); every
//! frame to the client goes through the one writer, in the order it was queued. Requests run as
//! tasks on the shared runtime, many at once, and answer in any order; the sync commands among
//! them run one at a time on the connection's own thread, in the order they arrived (as the
//! desktop runs them). A command that panics answers an error; the host keeps running.

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, BufWriter, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tauri::host::{ChannelSink, CommandEntry, CommandFuture, Invocation, Reply, SyncQueue};
use tauri::ipc::{InvokeBody, InvokeResponseBody};
use tauri::AppHandle;

use super::frame::{read_frame, read_frame_within, write_frame, Frame, MAX_FIRST_HEADER};

/// The wire contract's version.
pub const PROTOCOL: u64 = 1;

/// The name commands see where the desktop gives them a window's label. The host's one client
/// is the app's page, which the desktop calls "main" (what a reloaded page may stop, who owns
/// a request).
pub const CLIENT_LABEL: &str = "main";

/// Frames read ahead of the dispatcher. With the cap on running requests below, this bounds
/// what the host holds of what the client sent: when the host is behind, it stops reading and
/// the stream itself pushes back on the client.
const FRAMES_AHEAD: usize = 16;

/// Requests running at once; more wait unread on the stream.
const MAX_RUNNING: usize = 1024;

/// How long a TCP client has to say `$/hello`, whole: a connection that says nothing would
/// hold the host's one place for a client.
const HELLO_WITHIN: Duration = Duration::from_secs(5);

/// How long the host's last frames (the answer to `$/shutdown`, an error) wait for the client
/// to read them once the connection is over.
const FLUSH_WITHIN: Duration = Duration::from_secs(5);

/// What the host keeps of frames the client hasn't read yet, in bytes. Past it whoever sends
/// waits (a channel message where the command sends it, an answer in its task, the next
/// request unread on the stream): a client that reads slowly slows its commands down instead of
/// growing the host, and nothing it asked for is dropped. A frame larger than this goes alone.
const OUT_BUDGET: u32 = 64 * 1024 * 1024;

/// The room a frame takes of the budget.
fn room_for(header: &str, body: &[u8]) -> u32 {
    u32::try_from(header.len().saturating_add(body.len()))
        .unwrap_or(u32::MAX)
        .min(OUT_BUDGET)
}

/// The two ends of a client's byte stream.
pub struct Carrier {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    /// Ends the stream for good, so a reader blocked on it returns (a socket's shutdown).
    pub hang_up: Box<dyn FnOnce() + Send>,
}

/// How a connection ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// The client asked the host to shut down (`$/shutdown`).
    Shutdown,
    /// The stream ended, or broke the protocol.
    Closed,
}

/// A served connection: how it ended, and whether its client ever said a `$/hello` the host
/// accepted (one that didn't was never the host's client).
#[derive(Debug, PartialEq, Eq)]
pub struct Served {
    pub ended: Ended,
    pub greeted: bool,
}

enum Outgoing {
    Frame {
        header: String,
        body: Vec<u8>,
        /// The room it holds, given back once it is written.
        held: u32,
    },
    /// Flush and stop writing: the connection is over.
    Close,
}

/// What commands and channels share of the connection.
struct Connection {
    out: mpsc::Sender<Outgoing>,
    alive: AtomicBool,
    /// Channels the client no longer reads (`$/channelClose`).
    closed_channels: Mutex<HashSet<u32>>,
    /// The room left for frames the client hasn't read yet, in bytes; closed with the
    /// connection, so whoever waits for room stops waiting.
    room: tokio::sync::Semaphore,
    /// The runtime, for a sender that waits for room on a thread that isn't the runtime's.
    runtime: tokio::runtime::Handle,
}

impl Connection {
    fn queue(&self, header: String, body: Vec<u8>, held: u32) -> bool {
        self.alive.load(Ordering::SeqCst)
            && self
                .out
                .send(Outgoing::Frame { header, body, held })
                .is_ok()
    }

    /// Queues a frame once there is room for it. False when the client is gone.
    async fn send(&self, header: String, body: Vec<u8>) -> bool {
        let held = room_for(&header, &body);
        match self.room.acquire_many(held).await {
            Ok(room) => room.forget(),
            Err(_) => return false,
        }
        self.queue(header, body, held)
    }

    /// The same from a command's own code, which isn't async (a channel's send): the calling
    /// thread waits for room.
    fn send_waiting(&self, header: String, body: Vec<u8>) -> bool {
        let held = room_for(&header, &body);
        self.wait_for_room(held) && self.queue(header, body, held)
    }

    fn wait_for_room(&self, held: u32) -> bool {
        use tokio::runtime::{Handle, RuntimeFlavor};
        use tokio::sync::TryAcquireError;
        match self.room.try_acquire_many(held) {
            Ok(room) => {
                room.forget();
                return true;
            }
            Err(TryAcquireError::Closed) => return false,
            Err(TryAcquireError::NoPermits) => {}
        }
        let wait = || match self.runtime.block_on(self.room.acquire_many(held)) {
            Ok(room) => {
                room.forget();
                true
            }
            Err(_) => false,
        };
        match Handle::try_current() {
            // A thread of the command's own (a terminal's reader, a watcher).
            Err(_) => wait(),
            // One of the runtime's: it hands its other tasks over while this one waits.
            Ok(current) if current.runtime_flavor() == RuntimeFlavor::MultiThread => {
                tokio::task::block_in_place(wait)
            }
            // A single-threaded runtime of a service's own can't be waited in: on a thread
            // beside it.
            Ok(_) => std::thread::scope(|scope| scope.spawn(wait).join().unwrap_or(false)),
        }
    }

    /// The connection is over: sends fail, and whoever waits for room stops waiting.
    fn close(&self) {
        self.alive.store(false, Ordering::SeqCst);
        self.room.close();
    }

    async fn reply(&self, id: u64, reply: Reply) {
        let (header, body) = match reply {
            Reply::Json(text) => (format!("{{\"id\":{id},\"result\":{text}}}"), Vec::new()),
            Reply::Raw(bytes) => (format!("{{\"id\":{id},\"raw\":true}}"), bytes),
            Reply::Error(text) => (format!("{{\"id\":{id},\"error\":{text}}}"), Vec::new()),
        };
        self.send(header, body).await;
    }

    /// Whether the client said it no longer reads `channel`.
    fn closed_by_client(&self, channel: u32) -> bool {
        self.closed_channels
            .lock()
            .map(|closed| closed.contains(&channel))
            .unwrap_or(true)
    }
}

impl ChannelSink for Connection {
    /// A channel message. Fails once the client closed the channel or is gone, as a send fails
    /// on the desktop when the page is gone.
    fn send(&self, channel: u32, body: InvokeResponseBody) -> tauri::Result<()> {
        if self.closed_by_client(channel) {
            return Err(tauri::Error::ChannelClosed);
        }
        let (header, body) = match body {
            InvokeResponseBody::Json(text) => (
                format!("{{\"channel\":{channel},\"data\":{text}}}"),
                Vec::new(),
            ),
            InvokeResponseBody::Raw(bytes) => {
                (format!("{{\"channel\":{channel},\"raw\":true}}"), bytes)
            }
        };
        if self.send_waiting(header, body) {
            Ok(())
        } else {
            Err(tauri::Error::ChannelClosed)
        }
    }

    /// The host holds the channel no more: the client may forget its id. Not said for a channel
    /// the client closed itself (it already forgot it).
    fn end(&self, channel: u32) {
        if self.closed_by_client(channel) {
            // Nothing refers to the id any more: forget that it was closed.
            if let Ok(mut closed) = self.closed_channels.lock() {
                closed.remove(&channel);
            }
            return;
        }
        // A few bytes, once per channel, from wherever the last handle was dropped: not waited
        // for.
        self.queue(
            format!("{{\"channel\":{channel},\"end\":true}}"),
            Vec::new(),
            0,
        );
    }
}

/// A frame's header from the client.
#[derive(Deserialize)]
struct Incoming {
    id: Option<Value>,
    method: Option<String>,
    params: Option<Value>,
    #[serde(default)]
    raw: bool,
    headers: Option<HashMap<String, String>>,
}

/// A request's id: a positive integer.
fn request_id(id: &Value) -> Option<u64> {
    id.as_u64().filter(|id| *id > 0)
}

/// The same length and the same bytes, without stopping at the first difference.
fn same_token(given: &str, expected: &str) -> bool {
    let (given, expected) = (given.as_bytes(), expected.as_bytes());
    given.len() == expected.len()
        && given
            .iter()
            .zip(expected)
            .fold(0u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn header_map(headers: Option<HashMap<String, String>>) -> Result<tauri::http::HeaderMap, String> {
    let mut map = tauri::http::HeaderMap::new();
    for (name, value) in headers.unwrap_or_default() {
        let name = tauri::http::HeaderName::from_bytes(name.to_ascii_lowercase().as_bytes())
            .map_err(|_| format!("invalid header name: {name}"))?;
        let value = tauri::http::HeaderValue::from_str(&value)
            .map_err(|_| format!("invalid value for header {name}"))?;
        map.insert(name, value);
    }
    Ok(map)
}

/// Answers clients, one connection at a time.
pub struct Server {
    app: AppHandle,
    commands: HashMap<&'static str, fn(Invocation) -> CommandFuture>,
    /// The commands' names, as `$/hello` lists them.
    names: Vec<&'static str>,
    version: String,
    hello_within: Duration,
    flush_within: Duration,
}

impl Server {
    pub fn new(app: AppHandle, table: &'static [CommandEntry], version: &str) -> Self {
        Self {
            app,
            commands: table.iter().map(|entry| (entry.name, entry.run)).collect(),
            names: table.iter().map(|entry| entry.name).collect(),
            version: version.to_string(),
            hello_within: HELLO_WITHIN,
            flush_within: FLUSH_WITHIN,
        }
    }

    /// Shorter waits, for tests of what happens when they pass.
    #[cfg(test)]
    pub fn with_waits(mut self, hello_within: Duration, flush_within: Duration) -> Self {
        self.hello_within = hello_within;
        self.flush_within = flush_within;
        self
    }

    /// Serves one client until its stream ends or it asks for shutdown. `token`: what
    /// `$/hello` must carry (a TCP client, which must also say it in time), `None` for the
    /// process's own pipes.
    pub async fn serve(&self, carrier: Carrier, token: Option<&str>) -> Served {
        let Carrier {
            reader,
            writer,
            hang_up,
        } = carrier;
        let (out, queued) = mpsc::channel::<Outgoing>();
        let connection = Arc::new(Connection {
            out,
            alive: AtomicBool::new(true),
            closed_channels: Mutex::new(HashSet::new()),
            room: tokio::sync::Semaphore::new(OUT_BUDGET as usize),
            runtime: tokio::runtime::Handle::current(),
        });
        // Dropped when the writer's thread ends, which is how its end is heard.
        let (writer_ends, mut writer_ended) = tokio::sync::oneshot::channel::<()>();
        let writing = {
            let connection = connection.clone();
            std::thread::Builder::new()
                .name("host-writer".into())
                .spawn(move || {
                    let _writer_ends = writer_ends;
                    write_loop(writer, queued, &connection)
                })
        };
        let (frames, mut incoming) = tokio::sync::mpsc::channel(FRAMES_AHEAD);
        let running = Arc::new(tokio::sync::Semaphore::new(MAX_RUNNING));
        // Told once `$/hello` was accepted: nothing behind it is read before that.
        let (greet, accepted) = tokio::sync::oneshot::channel::<()>();
        let mut greet = Some(greet);
        let reading = std::thread::Builder::new()
            .name("host-reader".into())
            .spawn(move || read_loop(reader, frames, accepted));
        let mut greeted = false;
        let ended = match (&writing, &reading, SyncQueue::new()) {
            (Ok(_), Ok(_), Ok(ordered)) => {
                loop {
                    // A place for the next request first: none is read while all are taken.
                    let Ok(place) = running.clone().acquire_owned().await else {
                        break Ended::Closed;
                    };
                    let next = if greeted || token.is_none() {
                        incoming.recv().await
                    } else {
                        // The whole frame in time: one that trickles in is no better than none.
                        match tokio::time::timeout(self.hello_within, incoming.recv()).await {
                            Ok(next) => next,
                            Err(_) => {
                                eprintln!("host: a client said no $/hello in time");
                                break Ended::Closed;
                            }
                        }
                    };
                    let frame = match next {
                        Some(Ok(Some(frame))) => frame,
                        // The stream ended between frames.
                        Some(Ok(None)) | None => break Ended::Closed,
                        Some(Err(e)) => {
                            eprintln!("host: the connection broke: {e}");
                            break Ended::Closed;
                        }
                    };
                    match self
                        .handle(&connection, &ordered, frame, &mut greeted, token, place)
                        .await
                    {
                        Next::Continue => {}
                        Next::End(ended) => break ended,
                    }
                    if greeted {
                        if let Some(greet) = greet.take() {
                            let _ = greet.send(());
                        }
                    }
                }
            }
            _ => {
                eprintln!("host: couldn't start the connection's threads");
                Ended::Closed
            }
        };
        // What is queued (the answer to `$/shutdown`, an error) still goes out, to a client
        // that reads it in time; then nothing. The writer isn't waited for beyond that: stuck
        // in a write to a client that stopped reading, it only returns once the stream is hung
        // up (and on the process's own pipes, not before the other end goes).
        let _ = connection.out.send(Outgoing::Close);
        let _ = tokio::time::timeout(self.flush_within, &mut writer_ended).await;
        connection.close();
        hang_up();
        Served { ended, greeted }
    }

    /// One frame from the client.
    async fn handle(
        &self,
        connection: &Arc<Connection>,
        ordered: &SyncQueue,
        frame: Frame,
        greeted: &mut bool,
        token: Option<&str>,
        place: tokio::sync::OwnedSemaphorePermit,
    ) -> Next {
        let message: Incoming = match serde_json::from_slice(&frame.header) {
            Ok(message) => message,
            Err(e) => {
                eprintln!("host: a frame's header isn't a JSON object: {e}");
                return Next::End(Ended::Closed);
            }
        };
        let Some(method) = message.method else {
            eprintln!("host: a frame without a method");
            return Next::End(Ended::Closed);
        };
        let id = match &message.id {
            None => None,
            Some(id) => match request_id(id) {
                Some(id) => Some(id),
                None => {
                    eprintln!("host: a request's id must be a positive integer");
                    return Next::End(Ended::Closed);
                }
            },
        };
        if !*greeted {
            // `$/hello` first, before anything else.
            let Some(id) = id.filter(|_| method == "$/hello") else {
                if let Some(id) = id {
                    connection
                        .reply(id, Reply::invalid("expected $/hello first"))
                        .await;
                }
                return Next::End(Ended::Closed);
            };
            let params = message.params.unwrap_or(Value::Null);
            if params.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL) {
                connection
                    .reply(
                        id,
                        Reply::invalid(&format!(
                            "unsupported protocol (this host speaks {PROTOCOL})"
                        )),
                    )
                    .await;
                return Next::End(Ended::Closed);
            }
            if let Some(expected) = token {
                let given = params.get("token").and_then(Value::as_str).unwrap_or("");
                if !same_token(given, expected) {
                    connection.reply(id, Reply::invalid("wrong token")).await;
                    return Next::End(Ended::Closed);
                }
            }
            *greeted = true;
            connection
                .reply(
                    id,
                    Reply::Json(
                        serde_json::json!({
                            "protocol": PROTOCOL,
                            "version": self.version,
                            "os": std::env::consts::OS,
                            "pid": std::process::id(),
                            "commands": self.names,
                        })
                        .to_string(),
                    ),
                )
                .await;
            return Next::Continue;
        }
        let Some(id) = id else {
            // A notification.
            if method == "$/channelClose" {
                let channel = message
                    .params
                    .as_ref()
                    .and_then(|p| p.get("channel"))
                    .and_then(Value::as_u64)
                    .and_then(|c| u32::try_from(c).ok());
                if let (Some(channel), Ok(mut closed)) =
                    (channel, connection.closed_channels.lock())
                {
                    closed.insert(channel);
                }
            }
            return Next::Continue;
        };
        match method.as_str() {
            "$/shutdown" => {
                connection.reply(id, Reply::Json("null".into())).await;
                return Next::End(Ended::Shutdown);
            }
            "$/hello" => {
                connection
                    .reply(id, Reply::invalid("$/hello was already answered"))
                    .await;
                return Next::Continue;
            }
            _ => {}
        }
        let Some(run) = self.commands.get(method.as_str()).copied() else {
            connection
                .reply(id, Reply::invalid(&format!("unknown command: {method}")))
                .await;
            return Next::Continue;
        };
        let (params, body, headers) = if message.raw {
            match header_map(message.headers) {
                Ok(headers) => (Value::Null, InvokeBody::Raw(frame.body), headers),
                Err(e) => {
                    connection.reply(id, Reply::invalid(&e)).await;
                    return Next::Continue;
                }
            }
        } else {
            let params = match message.params {
                None | Some(Value::Null) => Value::Object(serde_json::Map::new()),
                Some(params @ Value::Object(_)) => params,
                Some(_) => {
                    connection
                        .reply(id, Reply::invalid("params must be an object"))
                        .await;
                    return Next::Continue;
                }
            };
            (
                params.clone(),
                InvokeBody::Json(params),
                tauri::http::HeaderMap::new(),
            )
        };
        let invocation = Invocation {
            app: self.app.clone(),
            client: Arc::from(CLIENT_LABEL),
            params,
            body,
            headers,
            channels: connection.clone(),
            ordered: ordered.clone(),
        };
        let connection = connection.clone();
        // Called here, in the order the frames arrived: a sync command takes its turn now.
        let running = run(invocation);
        tokio::spawn(async move {
            // A task of its own, so a panic inside the command ends only the command.
            let reply = match tokio::spawn(running).await {
                Ok(reply) => reply,
                Err(e) => tauri::host::reply_panic(&e.to_string()),
            };
            connection.reply(id, reply).await;
            drop(place);
        });
        Next::Continue
    }
}

enum Next {
    Continue,
    End(Ended),
}

type ReadResult = std::io::Result<Option<Frame>>;

fn read_loop(
    reader: Box<dyn Read + Send>,
    frames: tokio::sync::mpsc::Sender<ReadResult>,
    accepted: tokio::sync::oneshot::Receiver<()>,
) {
    let mut reader = BufReader::with_capacity(64 * 1024, reader);
    // The first frame is `$/hello`, from a client that hasn't shown its token yet: small, and
    // nothing more is read (or kept) for a client until the host accepted it.
    let first = read_frame_within(&mut reader, MAX_FIRST_HEADER, 0);
    let last = !matches!(first, Ok(Some(_)));
    if frames.blocking_send(first).is_err() || last || accepted.blocking_recv().is_err() {
        return;
    }
    loop {
        let frame = read_frame(&mut reader);
        let last = !matches!(frame, Ok(Some(_)));
        if frames.blocking_send(frame).is_err() || last {
            return;
        }
    }
}

fn write_loop(
    writer: Box<dyn Write + Send>,
    queued: mpsc::Receiver<Outgoing>,
    connection: &Connection,
) {
    let mut writer = BufWriter::with_capacity(64 * 1024, writer);
    let mut next = queued.recv().ok();
    while let Some(Outgoing::Frame { header, body, held }) = next {
        if write_frame(&mut writer, header.as_bytes(), &body).is_err() {
            break;
        }
        drop((header, body));
        connection.room.add_permits(held as usize);
        // Flushed whenever nothing more is waiting, so a burst goes out in few writes.
        next = match queued.try_recv() {
            Ok(message) => Some(message),
            Err(mpsc::TryRecvError::Empty) => {
                if writer.flush().is_err() {
                    break;
                }
                queued.recv().ok()
            }
            Err(mpsc::TryRecvError::Disconnected) => None,
        };
    }
    let _ = writer.flush();
    // The client is gone, or the connection is over: later sends fail.
    connection.close();
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
