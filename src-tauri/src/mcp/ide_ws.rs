//! Claude Code's IDE integration (D204): what `/ide` looks for. A WebSocket server on 127.0.0.1
//! speaking MCP (JSON-RPC over text frames), announced by a lock file
//! `~/.claude/ide/<port>.lock` (`$CLAUDE_CONFIG_DIR/ide` when set) holding the IDE's pid, its
//! workspace folders, its name, `"transport": "ws"` and a per-start auth token that every
//! connection must send as `x-claude-code-ide-authorization`. The tools (getCurrentSelection,
//! getOpenEditors, openDiff, getDiagnostics…) run in the webview, forwarded like the IDE's own
//! MCP server's calls (`bridge.rs`); `selection_changed` notifications go the other way. The
//! integrated terminals get `CLAUDE_CODE_SSE_PORT` and `ENABLE_IDE_INTEGRATION` so a Claude Code
//! started there connects by itself. The WebSocket framing (RFC 6455, text frames, ping/pong,
//! close, fragments) is in-house: small, and nothing else here needs a WebSocket library.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::bridge::{Bridge, BridgeRequest};
use crate::error::{Error, Result};

/// The lock file's contents (the field names Claude Code reads).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LockFile {
    pub pid: u32,
    pub workspace_folders: Vec<String>,
    pub ide_name: String,
    pub transport: String,
    pub auth_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeInfo {
    pub port: u16,
    pub lock_file: String,
    pub connected: usize,
}

const MAX_MESSAGE: usize = 16 * 1024 * 1024;
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// The tools Claude Code calls, with their input schemas (as its VS Code extension offers them).
pub fn tool_list() -> Value {
    let obj = |props: Value, required: &[&str]| json!({ "type": "object", "properties": props, "required": required });
    let path = json!({ "type": "string", "description": "Absolute path of the file" });
    json!([
        { "name": "openFile", "description": "Open a file in the editor, optionally selecting a range of text between startText and endText.",
          "inputSchema": obj(json!({ "filePath": path, "preview": { "type": "boolean" }, "startText": { "type": "string" }, "endText": { "type": "string" }, "selectToEndOfLine": { "type": "boolean" }, "makeFrontmost": { "type": "boolean" } }), &["filePath"]) },
        { "name": "openDiff", "description": "Show the proposed new contents of a file as a diff against the file and wait until the user accepts (FILE_SAVED) or rejects (DIFF_REJECTED) it.",
          "inputSchema": obj(json!({ "old_file_path": path, "new_file_path": path, "new_file_contents": { "type": "string" }, "tab_name": { "type": "string" } }), &["old_file_path", "new_file_path", "new_file_contents", "tab_name"]) },
        { "name": "getCurrentSelection", "description": "The active editor's selection: its text, file and range.", "inputSchema": obj(json!({}), &[]) },
        { "name": "getLatestSelection", "description": "The most recent selection in any file editor (the active one may be another kind of tab).", "inputSchema": obj(json!({}), &[]) },
        { "name": "getOpenEditors", "description": "The open editor tabs: file, label, language, whether active and unsaved.", "inputSchema": obj(json!({}), &[]) },
        { "name": "getWorkspaceFolders", "description": "The open workspace folders.", "inputSchema": obj(json!({}), &[]) },
        { "name": "getDiagnostics", "description": "Language diagnostics (errors, warnings) for a file, or for all files.",
          "inputSchema": obj(json!({ "uri": { "type": "string", "description": "A file URI; all files when omitted" } }), &[]) },
        { "name": "checkDocumentDirty", "description": "Whether a file has unsaved changes in the editor.", "inputSchema": obj(json!({ "filePath": path }), &["filePath"]) },
        { "name": "saveDocument", "description": "Save a file that's open in the editor.", "inputSchema": obj(json!({ "filePath": path }), &["filePath"]) },
        { "name": "close_tab", "description": "Close a tab by its name (a diff tab openDiff opened).", "inputSchema": obj(json!({ "tab_name": { "type": "string" } }), &["tab_name"]) },
        { "name": "closeAllDiffTabs", "description": "Close every diff tab openDiff opened.", "inputSchema": obj(json!({}), &[]) },
        // D207: like the VS Code extension, only for a Jupyter notebook open in the IDE, and the
        // user is asked before each run (the code goes into a new cell, so it stays visible).
        { "name": "executeCode", "description": "Execute python code in the Jupyter kernel of the notebook open in the IDE (the active one, else the only one). The user is asked first; the code runs in a new cell at the end of the notebook. Code persists across calls unless the kernel restarts: avoid declaring variables or changing the kernel's state unless the user asks. Returns the output text and images.",
          "inputSchema": obj(json!({ "code": { "type": "string", "description": "The code to be executed on the kernel" } }), &["code"]) },
    ])
}

/// Where lock files go: `$CLAUDE_CONFIG_DIR/ide`, else `~/.claude/ide`.
pub fn lock_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join("ide"));
    }
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(|h| PathBuf::from(h).join(".claude").join("ide"))
}

fn write_lock(path: &Path, lock: &LockFile) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    crate::store::atomic_write_private(path, &serde_json::to_vec(lock)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

// ---- SHA-1 and base64 for the handshake ------------------------------------------------

/// SHA-1 (only for the WebSocket handshake's accept key, which RFC 6455 defines with it).
pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in block.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }
    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

/// Standard base64 with padding.
pub fn base64(bytes: &[u8]) -> String {
    let mut s = super::oauth::base64url(bytes)
        .replace('-', "+")
        .replace('_', "/");
    while !s.len().is_multiple_of(4) {
        s.push('=');
    }
    s
}

pub fn accept_key(key: &str) -> String {
    base64(&sha1(format!("{}{WS_GUID}", key.trim()).as_bytes()))
}

// ---- Frames ------------------------------------------------------------------------------

/// A frame to send (server frames aren't masked).
pub fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 10);
    out.push(0x80 | opcode);
    match payload.len() {
        n if n < 126 => out.push(n as u8),
        n if n <= 0xFFFF => {
            out.push(126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        n => {
            out.push(127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
    }
    out.extend_from_slice(payload);
    out
}

/// Reads one frame: (fin, opcode, payload unmasked).
pub(crate) async fn read_frame<R: AsyncReadExt + Unpin>(r: &mut R) -> Result<(bool, u8, Vec<u8>)> {
    let mut head = [0u8; 2];
    r.read_exact(&mut head).await?;
    let fin = head[0] & 0x80 != 0;
    let opcode = head[0] & 0x0F;
    let masked = head[1] & 0x80 != 0;
    let mut len = u64::from(head[1] & 0x7F);
    if len == 126 {
        let mut b = [0u8; 2];
        r.read_exact(&mut b).await?;
        len = u64::from(u16::from_be_bytes(b));
    } else if len == 127 {
        let mut b = [0u8; 8];
        r.read_exact(&mut b).await?;
        len = u64::from_be_bytes(b);
    }
    if len as usize > MAX_MESSAGE {
        return Err(Error::Invalid("WebSocket message too large".into()));
    }
    let mut mask = [0u8; 4];
    if masked {
        r.read_exact(&mut mask).await?;
    }
    let mut payload = vec![0u8; len as usize];
    r.read_exact(&mut payload).await?;
    if masked {
        for (i, b) in payload.iter_mut().enumerate() {
            *b ^= mask[i % 4];
        }
    }
    Ok((fin, opcode, payload))
}

// ---- The server --------------------------------------------------------------------------

struct Running {
    port: u16,
    token: String,
    lock: PathBuf,
    ide_name: String,
    cancel: CancellationToken,
}

#[derive(Default)]
pub struct IdeIntegration {
    running: Mutex<Option<Running>>,
    bridge: Arc<Bridge>,
    clients: Arc<Mutex<Vec<mpsc::UnboundedSender<Vec<u8>>>>>,
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn new_token() -> Result<String> {
    // 128 bits as 32 lower-case hex characters, as the lock files of other IDEs have it.
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| Error::Invalid(format!("no randomness: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

impl IdeIntegration {
    pub fn bridge(&self) -> &Bridge {
        &self.bridge
    }

    /// Starts the server and writes the lock file (or returns the running one's info).
    pub async fn start(
        &self,
        requests: Channel<BridgeRequest>,
        folders: Vec<String>,
        ide_name: String,
        dir: Option<PathBuf>,
    ) -> Result<IdeInfo> {
        self.bridge.set_channel(requests);
        if let Some(info) = self.info() {
            self.update(folders)?;
            return Ok(info);
        }
        let dir = dir
            .or_else(lock_dir)
            .ok_or_else(|| Error::Invalid("no home folder for ~/.claude/ide".into()))?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        // Two starts at once both get past the check above while binding: the later one keeps
        // the server that won (no await from here on, so this lock covers the rest). Otherwise
        // the loser's server kept running, uncancellable, with a lock file of its own left behind.
        let mut running = self.lock()?;
        if running.is_some() {
            drop(running);
            drop(listener);
            self.update(folders)?;
            return self
                .info()
                .ok_or_else(|| Error::Invalid("the IDE integration stopped".into()));
        }
        let port = listener.local_addr()?.port();
        let token = new_token()?;
        let lock = dir.join(format!("{port}.lock"));
        write_lock(
            &lock,
            &LockFile {
                pid: std::process::id(),
                workspace_folders: folders,
                ide_name: ide_name.clone(),
                transport: "ws".into(),
                auth_token: token.clone(),
            },
        )?;
        // Claude Code started in an integrated terminal connects without /ide.
        std::env::set_var("CLAUDE_CODE_SSE_PORT", port.to_string());
        std::env::set_var("ENABLE_IDE_INTEGRATION", "true");
        let cancel = CancellationToken::new();
        let bridge = self.bridge.clone();
        let clients = self.clients.clone();
        let expected = token.clone();
        let stop = cancel.clone();
        let name = ide_name.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = stop.cancelled() => break,
                    a = listener.accept() => a,
                };
                let Ok((stream, _)) = accepted else {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    continue;
                };
                let bridge = bridge.clone();
                let clients = clients.clone();
                let expected = expected.clone();
                let stop = stop.clone();
                let name = name.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::select! {
                        _ = stop.cancelled() => {}
                        _ = connection(stream, expected, bridge, clients, name) => {}
                    }
                });
            }
        });
        *running = Some(Running {
            port,
            token,
            lock: lock.clone(),
            ide_name,
            cancel,
        });
        Ok(IdeInfo {
            port,
            lock_file: lock.to_string_lossy().into_owned(),
            connected: 0,
        })
    }

    /// The folders changed (another folder opened): the lock file says so.
    pub fn update(&self, folders: Vec<String>) -> Result<()> {
        let guard = self.lock()?;
        let Some(r) = guard.as_ref() else {
            return Ok(());
        };
        write_lock(
            &r.lock,
            &LockFile {
                pid: std::process::id(),
                workspace_folders: folders,
                ide_name: r.ide_name.clone(),
                transport: "ws".into(),
                auth_token: r.token.clone(),
            },
        )
    }

    pub fn info(&self) -> Option<IdeInfo> {
        let connected = self.clients.lock().map(|c| c.len()).unwrap_or(0);
        self.running.lock().ok()?.as_ref().map(|r| IdeInfo {
            port: r.port,
            lock_file: r.lock.to_string_lossy().into_owned(),
            connected,
        })
    }

    pub fn stop(&self) -> Result<()> {
        if let Some(r) = self.lock()?.take() {
            r.cancel.cancel();
            let _ = std::fs::remove_file(&r.lock);
            std::env::remove_var("CLAUDE_CODE_SSE_PORT");
            std::env::remove_var("ENABLE_IDE_INTEGRATION");
        }
        if let Ok(mut c) = self.clients.lock() {
            c.clear();
        }
        self.bridge.fail_all("The IDE integration stopped.");
        Ok(())
    }

    /// Sends a notification (selection_changed, at_mentioned) to every connected client.
    pub fn notify(&self, method: &str, params: Value) -> usize {
        let text = json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string();
        let bytes = frame(0x1, text.as_bytes());
        let Ok(mut clients) = self.clients.lock() else {
            return 0;
        };
        clients.retain(|c| c.send(bytes.clone()).is_ok());
        clients.len()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Running>>> {
        self.running
            .lock()
            .map_err(|_| Error::Invalid("ide integration lock poisoned".into()))
    }
}

/// The HTTP upgrade: the request's headers (lower-case names), if it's a WebSocket request.
async fn read_upgrade(stream: &mut TcpStream) -> Option<Vec<(String, String)>> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    loop {
        let n = tokio::time::timeout(std::time::Duration::from_secs(10), stream.read(&mut chunk))
            .await
            .ok()?
            .ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
        if buf.len() > 16 * 1024 {
            return None;
        }
    }
    let text = String::from_utf8_lossy(&buf).to_string();
    let mut lines = text.split("\r\n");
    if !lines.next()?.starts_with("GET ") {
        return None;
    }
    Some(
        lines
            .take_while(|l| !l.is_empty())
            .filter_map(|l| {
                let (k, v) = l.split_once(':')?;
                Some((k.trim().to_ascii_lowercase(), v.trim().to_string()))
            })
            .collect(),
    )
}

async fn connection(
    mut stream: TcpStream,
    token: String,
    bridge: Arc<Bridge>,
    clients: Arc<Mutex<Vec<mpsc::UnboundedSender<Vec<u8>>>>>,
    ide_name: String,
) {
    stream.set_nodelay(true).ok();
    let Some(headers) = read_upgrade(&mut stream).await else {
        return;
    };
    let get = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    let authorized = get("x-claude-code-ide-authorization")
        .is_some_and(|v| same(v.as_bytes(), token.as_bytes()));
    // A browser page can open WebSockets to localhost too: it would send an Origin.
    let from_page = get("origin").is_some_and(|o| !o.is_empty() && o != "null");
    let key = get("sec-websocket-key");
    let (Some(key), true, false) = (key, authorized, from_page) else {
        let _ = stream
            .write_all(
                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .await;
        return;
    };
    let accept = accept_key(key);
    let protocol = get("sec-websocket-protocol")
        .and_then(|p| p.split(',').map(str::trim).find(|p| *p == "mcp"))
        .map(|p| format!("Sec-WebSocket-Protocol: {p}\r\n"))
        .unwrap_or_default();
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n{protocol}\r\n"
    );
    if stream.write_all(response.as_bytes()).await.is_err() {
        return;
    }
    let (mut reader, mut writer) = stream.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    if let Ok(mut c) = clients.lock() {
        c.push(tx.clone());
    }
    let write_task = tauri::async_runtime::spawn(async move {
        while let Some(bytes) = rx.recv().await {
            if writer.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });
    let mut message: Vec<u8> = Vec::new();
    // This connection's calls waiting in the webview: dropped when it closes (D223).
    let inflight: Arc<Mutex<HashSet<u64>>> = Arc::default();
    loop {
        let Ok((fin, opcode, payload)) = read_frame(&mut reader).await else {
            break;
        };
        match opcode {
            0x8 => {
                let _ = tx.send(frame(0x8, &payload[..payload.len().min(2)]));
                break;
            }
            0x9 => {
                let _ = tx.send(frame(0xA, &payload));
                continue;
            }
            0xA => continue,
            0x0..=0x2 => {
                message.extend_from_slice(&payload);
                if message.len() > MAX_MESSAGE {
                    break;
                }
                if !fin {
                    continue;
                }
            }
            _ => break,
        }
        let text = String::from_utf8_lossy(&std::mem::take(&mut message)).to_string();
        let tx = tx.clone();
        let bridge = bridge.clone();
        let name = ide_name.clone();
        let inflight = inflight.clone();
        // Each request on its own: openDiff waits for the user while others go on.
        tauri::async_runtime::spawn(async move {
            if let Some(reply) = handle_tracked(&text, &bridge, &name, Some(&inflight)).await {
                let _ = tx.send(frame(0x1, reply.to_string().as_bytes()));
            }
        });
    }
    // This connection's sender by identity: its writer still holds the receiver here, so it
    // isn't closed yet, and `connected` would go on counting it.
    if let Ok(mut c) = clients.lock() {
        c.retain(|c| !c.same_channel(&tx) && !c.is_closed());
    }
    drop(tx);
    write_task.abort();
    // Claude Code went away: a diff it proposed would wait for an answer nobody reads.
    let waiting: Vec<u64> = inflight
        .lock()
        .map(|mut s| s.drain().collect())
        .unwrap_or_default();
    for id in waiting {
        bridge.cancel(id, "Claude Code disconnected.");
    }
}

/// One JSON-RPC message from Claude Code → the reply (None for notifications), untracked (tests).
#[cfg(test)]
pub async fn handle(text: &str, bridge: &Bridge, ide_name: &str) -> Option<Value> {
    handle_tracked(text, bridge, ide_name, None).await
}

/// `handle`, noting each call's bridge id in `inflight` while the webview works on it.
pub async fn handle_tracked(
    text: &str,
    bridge: &Bridge,
    ide_name: &str,
    inflight: Option<&Mutex<HashSet<u64>>>,
) -> Option<Value> {
    let msg: Value = serde_json::from_str(text).ok()?;
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(Value::as_str)?;
    let params = msg.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-03-26"),
            "capabilities": { "tools": { "listChanged": false }, "logging": {} },
            "serverInfo": { "name": ide_name, "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tool_list() })),
        "prompts/list" => Ok(json!({ "prompts": [] })),
        "resources/list" => Ok(json!({ "resources": [] })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let known = tool_list()
                .as_array()
                .is_some_and(|t| t.iter().any(|t| t["name"] == name));
            if !known {
                Err((-32602, format!("unknown tool {name}")))
            } else {
                let id = bridge.next_id();
                let request = BridgeRequest::Call {
                    id,
                    client: "claude-code".into(),
                    command: name.to_string(),
                    input: params.get("arguments").cloned().unwrap_or(json!({})),
                };
                if let Some(set) = inflight {
                    if let Ok(mut set) = set.lock() {
                        set.insert(id);
                    }
                }
                let answer = bridge.ask(id, request).await;
                if let Some(set) = inflight {
                    if let Ok(mut set) = set.lock() {
                        set.remove(&id);
                    }
                }
                Ok(match answer {
                    Ok(v) if v.get("content").is_some() => v,
                    Ok(v) => json!({ "content": [{ "type": "text", "text": v.to_string() }] }),
                    Err(e) => {
                        json!({ "content": [{ "type": "text", "text": e }], "isError": true })
                    }
                })
            }
        }
        _ => Err((-32601, format!("method not found: {method}"))),
    };
    Some(match result {
        Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    })
}

#[cfg(test)]
#[path = "ide_ws_tests.rs"]
mod tests;
