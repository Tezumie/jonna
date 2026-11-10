//! Forwards MCP requests to the webview (where commands and state live) and waits for answers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tokio::sync::oneshot;

/// A long-running command (a terminal command, a search) may take a while, but not forever.
const TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BridgeRequest {
    /// Run a command as caller `{ kind: "mcp", client }`.
    #[serde(rename_all = "camelCase")]
    Call {
        id: u64,
        client: String,
        command: String,
        input: Value,
    },
    /// Read a state path.
    #[serde(rename_all = "camelCase")]
    Read {
        id: u64,
        client: String,
        uri: String,
    },
    /// The caller of request `id` went away (Claude Code disconnected, D223): whatever it waits
    /// for (a diff tab's Accept / Reject) is dropped; its answer would reach nobody.
    #[serde(rename_all = "camelCase")]
    Cancel { id: u64 },
}

type Reply = std::result::Result<Value, String>;

#[derive(Default)]
pub struct Bridge {
    channel: Mutex<Option<Channel<BridgeRequest>>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next: AtomicU64,
}

impl Bridge {
    pub fn set_channel(&self, channel: Channel<BridgeRequest>) {
        if let Ok(mut slot) = self.channel.lock() {
            *slot = Some(channel);
        }
    }

    pub fn next_id(&self) -> u64 {
        self.next.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Sends `request` (built with `next_id()`) and waits for the webview's reply.
    pub async fn ask(&self, id: u64, request: BridgeRequest) -> Reply {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(id, tx);
        }
        let sent = self
            .channel
            .lock()
            .ok()
            .and_then(|c| c.as_ref().map(|c| c.send(request).is_ok()))
            .unwrap_or(false);
        if !sent {
            self.take(id);
            return Err("The IDE window is not connected.".into());
        }
        match tokio::time::timeout(TIMEOUT, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("The IDE dropped the request.".into()),
            Err(_) => {
                self.take(id);
                Err("Timed out waiting for the IDE.".into())
            }
        }
    }

    pub fn respond(&self, id: u64, reply: Reply) {
        if let Some(tx) = self.take(id) {
            let _ = tx.send(reply);
        }
    }

    /// Request `id` is no longer wanted: it fails with `message` and the webview is told to drop
    /// it. False when it was already answered.
    pub fn cancel(&self, id: u64, message: &str) -> bool {
        let Some(tx) = self.take(id) else {
            return false;
        };
        let _ = tx.send(Err(message.to_string()));
        if let Ok(c) = self.channel.lock() {
            if let Some(c) = c.as_ref() {
                let _ = c.send(BridgeRequest::Cancel { id });
            }
        }
        true
    }

    pub fn fail_all(&self, message: &str) {
        let waiting: Vec<_> = self
            .pending
            .lock()
            .map(|mut p| p.drain().collect())
            .unwrap_or_default();
        for (_, tx) in waiting {
            let _ = tx.send(Err(message.to_string()));
        }
    }

    fn take(&self, id: u64) -> Option<oneshot::Sender<Reply>> {
        self.pending.lock().ok().and_then(|mut p| p.remove(&id))
    }
}
