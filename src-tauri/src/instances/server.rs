//! This window's side (D209): its registration file and a listener on 127.0.0.1 that answers
//! other launches — a ping, "come to the front", "open these files" (handed to the frontend
//! through a Channel; held until it listens), and for `--wait` a second line once the frontend
//! says the files' tabs are closed (`done`).

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use super::{alive, now_ms, read_entries, restorable_folders, Entry, FileArg, Reply, Request};
use crate::error::{Error, Result};

/// Files to open, as the frontend gets them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenEvent {
    pub id: u64,
    pub files: Vec<FileArg>,
    pub diff: Option<(String, String)>,
    /// A launch waits for their tabs to close (`--wait`): call `done(id)` then.
    pub wait: bool,
    /// Folders to add to this window's workspace (`--add`, absolute); empty when none.
    pub add: Vec<String>,
    /// A link to the IDE for an extension's URI handler (D255).
    pub url: Option<String>,
}

struct Server {
    dir: PathBuf,
    file: PathBuf,
    entry: Mutex<Entry>,
    app: AppHandle,
}

static SERVER: OnceLock<Server> = OnceLock::new();
static FRONTEND: Mutex<Option<Channel<OpenEvent>>> = Mutex::new(None);
static QUEUED: Mutex<VecDeque<OpenEvent>> = Mutex::new(VecDeque::new());
static WAITERS: OnceLock<Mutex<HashMap<u64, mpsc::Sender<()>>>> = OnceLock::new();
static RESTORABLE: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// The last session's empty windows that kept unsaved untitled text (their backup ids).
static RESTORABLE_EMPTY: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Empty-window ids this start handed out (`take_restorable`): only these may be adopted.
static OFFERED_EMPTY: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// This window's backup id: where its untitled text goes while it has no folder.
static EMPTY_ID: Mutex<String> = Mutex::new(String::new());
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// The folder of empty windows' backups, under the registry: `<data>/windows/empty`.
const EMPTY_DIR: &str = "empty";
/// An empty window's backups are refused above this (hot exit itself keeps 10 MB at most).
const EMPTY_BACKUP_MAX: usize = 16 * 1024 * 1024;

/// What the last session leaves for this start to reopen (window.restoreWindows "all").
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Restorable {
    /// Folders of the last session's windows, the most recently used first.
    pub folders: Vec<String>,
    /// Empty windows that had unsaved untitled text, the most recent first (backup ids).
    pub empty: Vec<String>,
}

fn waiters() -> &'static Mutex<HashMap<u64, mpsc::Sender<()>>> {
    WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Registers this window and starts listening. `restore`: this start may reopen the last
/// session's windows (no folder or files were asked for, not a "New window", not a test run);
/// their folders are kept for `take_restorable` when this is the only window running, with the
/// empty windows that kept unsaved text. `empty_id`: this window reopens that empty window
/// (`--restore-empty`, started by the restore), else it gets a new id.
pub fn start(app: &AppHandle, dir: PathBuf, restore: bool, empty_id: Option<String>) -> Result<()> {
    if SERVER.get().is_some() {
        return Ok(());
    }
    std::fs::create_dir_all(&dir)?;
    let id = match empty_id.filter(|i| super::valid_backup_id(i)) {
        Some(id) => id,
        None => random_hex()?,
    };
    if let Ok(mut own_id) = EMPTY_ID.lock() {
        *own_id = id;
    }
    let own = std::process::id();
    // The others: those answering are running windows; the rest are leftovers (a crash, or the
    // last window of the session, kept for this moment).
    let (live, stale): (Vec<_>, Vec<_>) = read_entries(&dir)
        .into_iter()
        .filter(|(_, e)| e.pid != own)
        .partition(|(_, e)| alive(e));
    if live.is_empty() {
        if restore {
            let folders =
                restorable_folders(&stale.iter().map(|(_, e)| e.clone()).collect::<Vec<_>>());
            if let Ok(mut r) = RESTORABLE.lock() {
                *r = folders;
            }
            // No window runs, so no backup belongs to a running one.
            let own_id = EMPTY_ID.lock().map(|i| i.clone()).unwrap_or_default();
            let empty: Vec<String> = super::empty_backup_ids(&dir.join(EMPTY_DIR))
                .into_iter()
                .filter(|i| *i != own_id)
                .collect();
            if let Ok(mut r) = RESTORABLE_EMPTY.lock() {
                *r = empty;
            }
        }
        // Read once: the next session starts from this one's windows.
        for (path, _) in &stale {
            let _ = std::fs::remove_file(path);
        }
    } else {
        // Windows are running: leftovers are crashes; the session that runs keeps its own list.
        for (path, _) in &stale {
            let _ = std::fs::remove_file(path);
        }
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    let port = listener.local_addr()?.port();
    let token = random_hex()?;
    let entry = Entry {
        pid: own,
        port,
        token,
        folder: None,
        focused_ms: now_ms(),
    };
    let file = dir.join(format!("{own}.json"));
    write_entry(&file, &entry)?;
    if SERVER
        .set(Server {
            dir,
            file,
            entry: Mutex::new(entry),
            app: app.clone(),
        })
        .is_err()
    {
        return Ok(());
    }
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                let _ = serve(stream);
            });
        }
    });
    Ok(())
}

fn write_entry(file: &std::path::Path, entry: &Entry) -> Result<()> {
    let text = serde_json::to_string(entry).map_err(|e| Error::Invalid(e.to_string()))?;
    // The token is a secret: only this user may read it.
    crate::store::atomic_write_private(file, text.as_bytes())
}

fn update(change: impl FnOnce(&mut Entry) -> bool) {
    let Some(server) = SERVER.get() else { return };
    let Ok(mut entry) = server.entry.lock() else {
        return;
    };
    if change(&mut entry) {
        let _ = write_entry(&server.file, &entry);
    }
}

/// The folder this window has open now (None: closed).
pub fn set_folder(folder: Option<String>) {
    update(|e| {
        if e.folder == folder {
            return false;
        }
        e.folder = folder;
        true
    });
}

/// The window got the focus: it's the one files go to (written at most every few seconds).
pub fn focused() {
    update(|e| {
        let now = now_ms();
        if now.saturating_sub(e.focused_ms) < 3000 {
            e.focused_ms = now;
            return false;
        }
        e.focused_ms = now;
        true
    });
}

/// 16 random bytes as hex: a window's token, or an empty window's backup id.
fn random_hex() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| Error::Invalid(format!("no randomness: {e}")))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The last session's windows (window.restoreWindows "all"): their folders and the empty windows
/// that kept unsaved text. Once per start.
pub fn take_restorable() -> Restorable {
    let folders = RESTORABLE
        .lock()
        .map(|mut r| std::mem::take(&mut *r))
        .unwrap_or_default();
    let empty = RESTORABLE_EMPTY
        .lock()
        .map(|mut r| std::mem::take(&mut *r))
        .unwrap_or_default();
    if let Ok(mut offered) = OFFERED_EMPTY.lock() {
        offered.extend(empty.iter().cloned());
    }
    Restorable { folders, empty }
}

/// Whether `id` is one of the empty windows this start handed out (a window may be started on it).
pub fn offered_empty(id: &str) -> bool {
    OFFERED_EMPTY
        .lock()
        .is_ok_and(|o| o.iter().any(|i| i == id))
}

/// This window becomes the last session's empty window `id` (one `take_restorable` handed out):
/// its untitled text is read from and saved to that window's backups from now on.
pub fn adopt_empty(id: &str) -> Result<()> {
    if !offered_empty(id) {
        return Err(Error::Invalid(format!("not a window to restore: {id}")));
    }
    let mut own = EMPTY_ID
        .lock()
        .map_err(|_| Error::Invalid("instances lock".into()))?;
    *own = id.to_string();
    Ok(())
}

/// This window's empty-window backup file (`<data>/windows/empty/<id>.json`).
fn empty_backup_file() -> Option<PathBuf> {
    let server = SERVER.get()?;
    let id = EMPTY_ID.lock().ok()?.clone();
    super::valid_backup_id(&id).then(|| server.dir.join(EMPTY_DIR).join(format!("{id}.json")))
}

/// The unsaved untitled text this window kept while it had no folder (JSON, as saved), if any.
pub fn load_empty_backups() -> Option<String> {
    std::fs::read_to_string(empty_backup_file()?).ok()
}

/// Keeps this empty window's unsaved text for the next start (`json`); None removes it (the
/// window got a folder, or nothing is unsaved).
pub fn save_empty_backups(json: Option<&str>) -> Result<()> {
    let file = empty_backup_file().ok_or_else(|| Error::Invalid("no window registry".into()))?;
    match json {
        Some(text) => {
            if text.len() > EMPTY_BACKUP_MAX {
                return Err(Error::Invalid(
                    "the unsaved text is too large to keep".into(),
                ));
            }
            serde_json::from_str::<serde_json::Value>(text)
                .map_err(|e| Error::Invalid(e.to_string()))?;
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            // The user's own text: only this user may read it.
            crate::store::atomic_write_private(&file, text.as_bytes())
        }
        None => match std::fs::remove_file(&file) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        },
    }
}

/// Whether another window of this IDE runs (closing this one then isn't the end of the session).
pub fn others_running() -> bool {
    let Some(server) = SERVER.get() else {
        return false;
    };
    let own = std::process::id();
    read_entries(&server.dir)
        .into_iter()
        .any(|(_, e)| e.pid != own && alive(&e))
}

/// The processes of the other windows that answer (D359: their chats are listed); None without a
/// registry here (a test run), where the caller goes by how recent a window's record is.
pub fn other_live_pids() -> Option<Vec<u32>> {
    let server = SERVER.get()?;
    let own = std::process::id();
    Some(
        read_entries(&server.dir)
            .into_iter()
            .filter(|(_, e)| e.pid != own && alive(e))
            .map(|(_, e)| e.pid)
            .collect(),
    )
}

/// The app is quitting. With other windows still running this one is simply gone; as the last
/// one, its entry stays so the next start can reopen its folder (VS Code restores the windows
/// open when the app quit).
pub fn exiting() {
    let Some(server) = SERVER.get() else { return };
    if others_running() {
        let _ = std::fs::remove_file(&server.file);
    }
}

/// Whether another running window has `folder` open (D222); None without a registry here.
pub fn window_open_with(folder: &str) -> Option<bool> {
    let server = SERVER.get()?;
    let entries: Vec<Entry> = read_entries(&server.dir)
        .into_iter()
        .map(|(_, e)| e)
        .collect();
    Some(super::open_with_folder(
        &entries,
        folder,
        std::process::id(),
        alive,
    ))
}

/// Another running window with `folder` open: brought to the front, true. False: none has it.
pub fn focus_window_with(folder: &str) -> bool {
    let Some(server) = SERVER.get() else {
        return false;
    };
    let own = std::process::id();
    let target = read_entries(&server.dir).into_iter().find(|(_, e)| {
        e.pid != own
            && e.folder
                .as_deref()
                .is_some_and(|f| super::same_folder(f, folder))
    });
    let Some((_, entry)) = target else {
        return false;
    };
    super::client::allow_foreground(entry.pid);
    super::send(&entry, &Request::Focus, Duration::from_secs(2)).is_ok_and(|(r, _)| r.ok)
}

/// The frontend opens files from now on; what came before it listened is handed over now.
pub fn listen(channel: Channel<OpenEvent>) -> Result<()> {
    let queued: Vec<OpenEvent> = QUEUED
        .lock()
        .map(|mut q| q.drain(..).collect())
        .unwrap_or_default();
    for event in queued {
        let _ = channel.send(event);
    }
    *FRONTEND
        .lock()
        .map_err(|_| Error::Invalid("instances lock".into()))? = Some(channel);
    Ok(())
}

/// The files of request `id` are closed: the waiting launch ends.
pub fn done(id: u64) {
    if let Ok(mut map) = waiters().lock() {
        if let Some(tx) = map.remove(&id) {
            let _ = tx.send(());
        }
    }
}

/// Files (and folders to add) from this process's own command line (it became the window):
/// opened like any request.
pub fn open_own(
    files: Vec<FileArg>,
    diff: Option<(String, String)>,
    add: Vec<String>,
    url: Option<String>,
) {
    deliver(OpenEvent {
        id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
        files,
        diff,
        wait: false,
        add,
        url,
    });
}

fn deliver(event: OpenEvent) {
    let channel = FRONTEND.lock().ok().and_then(|c| c.clone());
    let sent = channel.is_some_and(|c| c.send(event.clone()).is_ok());
    if !sent {
        if let Ok(mut q) = QUEUED.lock() {
            q.push_back(event);
        }
    }
}

fn bring_to_front(app: &AppHandle) {
    // The window, not the webview window: once a browser tab shows a site inside it (a second
    // webview), "main" is no longer a single-webview window.
    if let Some(window) = app.get_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn serve(stream: TcpStream) -> Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut line = String::new();
    // A request is one line; anything bigger isn't one.
    BufReader::new((&stream).take(1024 * 1024)).read_line(&mut line)?;
    let server = SERVER
        .get()
        .ok_or_else(|| Error::Invalid("not listening".into()))?;
    let reply = |stream: &TcpStream, r: &Reply| -> Result<()> {
        let text = serde_json::to_string(r).map_err(|e| Error::Invalid(e.to_string()))?;
        let mut out = stream;
        out.write_all(text.as_bytes())?;
        out.write_all(b"\n")?;
        out.flush()?;
        Ok(())
    };
    let own = std::process::id();
    let ok = Reply {
        ok: true,
        pid: own,
        done: false,
        error: None,
    };
    let parsed: std::result::Result<super::Envelope, _> = serde_json::from_str(line.trim());
    let token_ok = |t: &str| {
        server
            .entry
            .lock()
            .is_ok_and(|e| !t.is_empty() && e.token.as_bytes() == t.as_bytes())
    };
    let Ok(envelope) = parsed else {
        return reply(
            &stream,
            &Reply {
                ok: false,
                pid: own,
                done: false,
                error: Some("bad request".into()),
            },
        );
    };
    if !token_ok(&envelope.token) {
        return reply(
            &stream,
            &Reply {
                ok: false,
                pid: 0,
                done: false,
                error: Some("not allowed".into()),
            },
        );
    }
    match envelope.request {
        Request::Ping => reply(&stream, &ok),
        Request::Focus => {
            bring_to_front(&server.app);
            reply(&stream, &ok)
        }
        Request::Open {
            files,
            diff,
            wait,
            add,
            url,
        } => {
            let (tx, rx) = mpsc::channel();
            let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
            if wait {
                if let Ok(mut map) = waiters().lock() {
                    map.insert(id, tx);
                }
            }
            deliver(OpenEvent {
                id,
                files,
                diff,
                wait,
                add,
                url,
            });
            bring_to_front(&server.app);
            reply(&stream, &ok)?;
            if wait {
                // Until the frontend says the tabs are closed, or this window goes away (the
                // stream closes with the process and the launch ends then too).
                stream.set_read_timeout(None)?;
                let _ = rx.recv();
                reply(
                    &stream,
                    &Reply {
                        ok: true,
                        pid: own,
                        done: true,
                        error: None,
                    },
                )?;
            }
            Ok(())
        }
    }
}
