//! The IDE's windows across processes (D209). Each window is its own process; each registers in
//! `<data>/windows/<pid>.json` (its folder, a local port and a secret token, when it last had the
//! focus) and listens on that port (127.0.0.1 only, `server.rs`). That lets a second launch:
//! - focus the window that already has the folder open instead of opening it twice (VS Code),
//! - hand files to a running window (`<cli> file:line:col`, `--diff a b`, `--wait`: `client.rs`),
//! - and the first window of a new session reopen the folders the last one had open
//!   (`window.restoreWindows`: "all").
//!
//! An entry is live when its port answers a ping with its token; anything else is a leftover
//! (a crash, or the last window of the session, which keeps its entry on purpose so the next
//! start can restore it). `shell_command.rs` installs the command line in PATH.

pub mod client;
#[cfg(target_os = "macos")]
pub mod dock_menu;
pub mod jump_list;
pub mod server;
pub mod shell_command;

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// A ping answers within this or the window counts as gone.
const PING_TIMEOUT: Duration = Duration::from_millis(400);

/// One window's registration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub pid: u32,
    pub port: u16,
    pub token: String,
    /// The folder it has open (canonical), None for an empty window.
    #[serde(default)]
    pub folder: Option<String>,
    /// When it last had the focus (ms since the epoch): the most recent gets files.
    #[serde(default)]
    pub focused_ms: u64,
}

/// What a launch asks a running window to do.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Request {
    /// Are you there? (the answer says who)
    Ping,
    /// Bring the window to the front.
    Focus,
    /// Open files (at a line), or two files side by side; with `wait`, answer once they're closed.
    /// `add`: folders to add to the window's workspace (`--add`, absolute); left out when none,
    /// so a launch and a window of different versions still understand each other.
    #[serde(rename_all = "camelCase")]
    Open {
        files: Vec<FileArg>,
        diff: Option<(String, String)>,
        wait: bool,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        add: Vec<String>,
        /// A link to the IDE for an extension's URI handler (D255); left out when none.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        url: Option<String>,
    },
}

/// A file from the command line: `path[:line[:column]]`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileArg {
    pub path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
    /// It doesn't exist (yet): the window opens an untitled editor that saves there (VS Code).
    #[serde(default)]
    pub missing: bool,
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    token: String,
    request: Request,
}

/// One line the window answers with: `ok`, then (an Open with `wait`) `done` when it's closed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub ok: bool,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub error: Option<String>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `<data>/windows`: the same data folder Tauri gives the app (`app_data_dir`, from the bundle
/// identifier), worked out without Tauri since the command line runs before it starts.
/// `--user-data-dir <dir>` (and IDE_USER_DATA_DIR) puts it under `<dir>/data`, as AppDirs does.
pub fn registry_dir(user_data_dir: Option<&Path>) -> Option<PathBuf> {
    if let Some(dir) = user_data_dir {
        return Some(dir.join("data").join("windows"));
    }
    let identifier = product_identifier();
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base =
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(not(any(windows, target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    base.map(|b| b.join(identifier).join("windows"))
}

/// product.json's `identifier` (the bundle identifier Tauri's folders are named after).
fn product_identifier() -> String {
    serde_json::from_str::<serde_json::Value>(include_str!("../../../product.json"))
        .ok()
        .and_then(|v| {
            v.get("identifier")
                .and_then(|n| n.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| "ide".into())
}

/// Every registration in `dir` (unreadable ones are skipped).
pub fn read_entries(dir: &Path) -> Vec<(PathBuf, Entry)> {
    let Ok(list) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    list.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| {
            let text = std::fs::read_to_string(e.path()).ok()?;
            let entry = serde_json::from_str::<Entry>(&text).ok()?;
            Some((e.path(), entry))
        })
        .collect()
}

/// Sends one request and returns the first answer line (and the stream, for more).
pub fn send(
    entry: &Entry,
    request: &Request,
    timeout: Duration,
) -> std::io::Result<(Reply, TcpStream)> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, entry.port));
    let stream = TcpStream::connect_timeout(&addr, timeout)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let text = serde_json::to_string(&Envelope {
        token: entry.token.clone(),
        request: request.clone(),
    })
    .map_err(std::io::Error::other)?;
    let mut out = &stream;
    out.write_all(text.as_bytes())?;
    out.write_all(b"\n")?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line)?;
    let reply: Reply = serde_json::from_str(line.trim()).map_err(std::io::Error::other)?;
    Ok((reply, stream))
}

/// Whether the window of `entry` answers (and is the process it says).
pub fn alive(entry: &Entry) -> bool {
    send(entry, &Request::Ping, PING_TIMEOUT).is_ok_and(|(r, _)| r.ok && r.pid == entry.pid)
}

/// Same folder, the way the OS compares names (case-insensitive on Windows and macOS).
pub fn same_folder(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let t = p.trim_end_matches(['/', '\\']).replace('\\', "/");
        if cfg!(any(windows, target_os = "macos")) {
            t.to_lowercase()
        } else {
            t
        }
    };
    norm(a) == norm(b)
}

/// Whether a window other than `own` has `folder` open and answers (`alive`): a worktree agent's
/// window after the window that started it restarted (D222), when that one no longer holds the
/// process. Asks only the entries with that folder.
pub fn open_with_folder(
    entries: &[Entry],
    folder: &str,
    own: u32,
    alive: impl Fn(&Entry) -> bool,
) -> bool {
    entries.iter().any(|e| {
        e.pid != own && e.folder.as_deref().is_some_and(|f| same_folder(f, folder)) && alive(e)
    })
}

/// `path` is `folder` or inside it.
pub fn folder_contains(folder: &str, path: &str) -> bool {
    if same_folder(folder, path) {
        return true;
    }
    let f = folder.trim_end_matches(['/', '\\']);
    // `get`: a cut inside a multi-byte character is no match (and no panic).
    let Some(head) = path.get(..f.len()) else {
        return false;
    };
    path.len() > f.len()
        && same_folder(head, f)
        && matches!(path.as_bytes().get(f.len()), Some(b'/') | Some(b'\\'))
}

/// The window to give files to: the one whose folder holds the first file (the deepest folder),
/// else the one that had the focus last. `entries` are the live ones.
pub fn target_for_files<'a>(entries: &'a [Entry], files: &[String]) -> Option<&'a Entry> {
    let first = files.first();
    let holding = first.and_then(|f| {
        entries
            .iter()
            .filter(|e| e.folder.as_deref().is_some_and(|d| folder_contains(d, f)))
            .max_by_key(|e| e.folder.as_ref().map_or(0, String::len))
    });
    holding.or_else(|| entries.iter().max_by_key(|e| e.focused_ms))
}

/// The folders to reopen at the start of a session (window.restoreWindows "all"): the leftover
/// entries' folders, the most recently focused first, each once.
pub fn restorable_folders(stale: &[Entry]) -> Vec<String> {
    let mut sorted: Vec<&Entry> = stale.iter().collect();
    sorted.sort_by_key(|e| std::cmp::Reverse(e.focused_ms));
    let mut out: Vec<String> = Vec::new();
    for e in sorted {
        if let Some(f) = &e.folder {
            if !out.iter().any(|o| same_folder(o, f)) {
                out.push(f.clone());
            }
        }
    }
    out
}

/// An empty window's backup id: 1–64 lowercase hex digits (it names a file).
pub fn valid_backup_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The empty windows' backups in `dir` (`<id>.json`), the most recently written first.
pub fn empty_backup_ids(dir: &Path) -> Vec<String> {
    let Ok(list) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(SystemTime, String)> = list
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().is_none_or(|x| x != "json") {
                return None;
            }
            let id = path.file_stem()?.to_str()?.to_string();
            if !valid_backup_id(&id) {
                return None;
            }
            let modified = e
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            Some((modified, id))
        })
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    found.into_iter().map(|(_, id)| id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_window_backups_are_listed_newest_first() {
        assert!(valid_backup_id("0a9f"));
        assert!(!valid_backup_id(""));
        assert!(!valid_backup_id("../x"));
        assert!(!valid_backup_id("ABC"));
        assert!(!valid_backup_id(&"a".repeat(65)));
        let dir = std::env::temp_dir().join(format!("ide-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("aa.json"), "[]");
        std::thread::sleep(Duration::from_millis(30));
        let _ = std::fs::write(dir.join("bb.json"), "[]");
        let _ = std::fs::write(dir.join("not-an-id.json"), "[]");
        let _ = std::fs::write(dir.join("cc.txt"), "x");
        let ids = empty_backup_ids(&dir);
        assert_eq!(ids, vec!["bb".to_string(), "aa".to_string()]);
        assert!(empty_backup_ids(&dir.join("missing")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn entry(pid: u32, folder: Option<&str>, focused_ms: u64) -> Entry {
        Entry {
            pid,
            port: 1,
            token: "t".into(),
            folder: folder.map(String::from),
            focused_ms,
        }
    }

    #[test]
    fn folders_compare_as_the_os_does() {
        assert!(same_folder("/w/app/", "/w/app"));
        assert!(folder_contains("/w/app", "/w/app/src/a.ts"));
        assert!(!folder_contains("/w/app", "/w/application/a.ts"));
        assert!(folder_contains(r"C:\w\app", r"C:\w\app\src\a.ts"));
        assert!(!folder_contains("/w/app", "/w"));
        if cfg!(windows) {
            assert!(same_folder(r"C:\Work\App", r"c:\work\app\"));
        }
    }

    #[test]
    fn files_go_to_the_window_with_their_folder_else_the_last_focused() {
        let list = vec![
            entry(1, Some("/w"), 50),
            entry(2, Some("/w/app"), 10),
            entry(3, None, 90),
        ];
        let files = |p: &str| vec![p.to_string()];
        assert_eq!(
            target_for_files(&list, &files("/w/app/a.ts")).map(|e| e.pid),
            Some(2)
        );
        assert_eq!(
            target_for_files(&list, &files("/w/b.ts")).map(|e| e.pid),
            Some(1)
        );
        assert_eq!(
            target_for_files(&list, &files("/elsewhere/c.ts")).map(|e| e.pid),
            Some(3)
        );
        assert_eq!(target_for_files(&[], &files("/x")), None);
    }

    #[test]
    fn a_folder_is_open_when_another_live_window_has_it() {
        let list = vec![
            entry(1, Some("/w/wt-a"), 0),
            entry(2, Some("/w/wt-b"), 0),
            entry(3, Some("/w/wt-c"), 0),
        ];
        let live = |e: &Entry| e.pid != 2;
        assert!(open_with_folder(&list, "/w/wt-a/", 9, live));
        assert!(
            !open_with_folder(&list, "/w/wt-b", 9, live),
            "its window is gone"
        );
        assert!(
            !open_with_folder(&list, "/w/wt-c", 3, live),
            "this window doesn't count"
        );
        assert!(!open_with_folder(&list, "/w/other", 9, live));
    }

    #[test]
    fn restored_folders_are_the_most_recent_first_without_repeats() {
        let stale = vec![
            entry(1, Some("/a"), 10),
            entry(2, Some("/b"), 30),
            entry(3, None, 40),
            entry(4, Some("/a/"), 5),
        ];
        assert_eq!(
            restorable_folders(&stale),
            vec!["/b".to_string(), "/a".to_string()]
        );
    }

    #[test]
    fn requests_and_entries_round_trip() {
        let r = Request::Open {
            files: vec![FileArg {
                path: "/w/a.ts".into(),
                line: Some(3),
                column: None,
                missing: false,
            }],
            diff: None,
            wait: true,
            add: Vec::new(),
            url: None,
        };
        let text = serde_json::to_string(&r).unwrap_or_default();
        assert!(text.contains("\"kind\":\"open\""));
        // No folders to add: the line is what it always was.
        assert!(!text.contains("add"), "{text}");
        assert_eq!(serde_json::from_str::<Request>(&text).ok(), Some(r));
        let adding = Request::Open {
            files: Vec::new(),
            diff: None,
            wait: false,
            add: vec!["/w/lib".into()],
            url: None,
        };
        let text = serde_json::to_string(&adding).unwrap_or_default();
        assert!(text.contains("\"add\":[\"/w/lib\"]"), "{text}");
        assert_eq!(serde_json::from_str::<Request>(&text).ok(), Some(adding));
        let e = entry(7, Some("/w"), 1);
        let text = serde_json::to_string(&e).unwrap_or_default();
        assert_eq!(serde_json::from_str::<Entry>(&text).ok(), Some(e));
    }

    #[test]
    fn a_window_is_alive_when_it_answers_as_itself() {
        let Ok(listener) = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) else {
            return;
        };
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten().take(2) {
                let mut line = String::new();
                let _ = BufReader::new(&stream).read_line(&mut line);
                if let Ok(mut l) = log.lock() {
                    l.push(line);
                }
                let mut out = &stream;
                let _ = out.write_all(b"{\"ok\":true,\"pid\":42}\n");
            }
        });
        let mut e = entry(42, None, 0);
        e.port = port;
        e.token = "secret".into();
        assert!(alive(&e));
        e.pid = 43;
        assert!(!alive(&e), "another process on that port isn't the window");
        let lines = seen.lock().map(|l| l.clone()).unwrap_or_default();
        assert!(
            lines.first().is_some_and(
                |l| l.contains("\"token\":\"secret\"") && l.contains("\"kind\":\"ping\"")
            )
        );
        // Nothing listening: gone.
        e.port = 1;
        assert!(!alive(&e));
    }

    #[test]
    fn the_registry_is_under_the_profile_folder_when_one_is_given() {
        let dir = std::env::temp_dir().join("profile");
        assert_eq!(
            registry_dir(Some(&dir)),
            Some(dir.join("data").join("windows"))
        );
    }
}
