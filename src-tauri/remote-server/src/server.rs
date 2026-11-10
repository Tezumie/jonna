//! The connection: frames come in on standard input, each request runs on a thread of its own
//! (so a slow search never holds up a file read) and gets exactly one response; notifications
//! (a stream's input) are handled in order, as they come.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{Error, Result};
use crate::files;
use crate::index::FileIndex;
use crate::outbox::{self, Outbox};
use crate::search::{SearchOptions, Searches};
use crate::streams::{ports, SpawnParams, Starter, Streams};
use crate::system;
use crate::watch::Watches;
use crate::workspace::{canonicalize, Workspace};

/// Quick open's limits, as the app's: a page by default, more for an empty query (a repo map
/// lists every file), never unbounded.
const DEFAULT_QUERY_LIMIT: usize = 100;
const MAX_QUERY_LIMIT: usize = 1000;
const MAX_LIST_LIMIT: usize = 50_000;

pub struct Server {
    out: Outbox,
    ws: Workspace,
    index: FileIndex,
    searches: Searches,
    watches: Watches,
    streams: Streams,
}

/// Serves the protocol on standard input and output until the input ends (or `shutdown`), then
/// ends everything it started. Never returns.
pub fn serve() -> ! {
    let (out, rx) = Outbox::new();
    let server = Arc::new(Server {
        ws: Workspace::default(),
        index: FileIndex::new(out.clone()),
        searches: Searches::default(),
        watches: Watches::new(out.clone()),
        streams: Streams::new(out.clone()),
        out,
    });
    // The login environment takes a login shell's start-up: begun now, ready by the first
    // program the app runs.
    std::thread::spawn(|| {
        system::base_env();
    });
    let writer = server.clone();
    std::thread::spawn(move || {
        let stdout = std::io::stdout();
        let mut output = std::io::BufWriter::with_capacity(256 * 1024, stdout.lock());
        outbox::write_all(&rx, &mut output);
        let _ = output.flush();
        // `shutdown`, or the app stopped reading.
        writer.end(0);
    });
    let mut input = std::io::stdin().lock();
    loop {
        match crate::frame::read_frame(&mut input) {
            Ok(Some(frame)) => server.handle_frame(&frame),
            Ok(None) => server.end(0),
            Err(e) => {
                eprintln!("{e}; closing the connection");
                server.end(1);
            }
        }
    }
}

#[derive(Deserialize)]
struct PathArg {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadArgs {
    path: String,
    max_bytes: Option<u64>,
}

#[derive(Deserialize)]
struct WriteArgs {
    path: String,
    data: String,
}

#[derive(Deserialize)]
struct CreateArgs {
    parent: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameArgs {
    path: String,
    new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntoArgs {
    path: String,
    #[serde(alias = "destDir")]
    dest: String,
}

#[derive(Deserialize)]
struct FoldersArgs {
    paths: Vec<String>,
}

#[derive(Deserialize)]
struct QueryArgs {
    #[serde(default)]
    query: String,
    limit: Option<usize>,
    root: Option<String>,
}

#[derive(Deserialize)]
struct SearchArgs {
    search: Value,
    roots: Option<Vec<String>>,
    options: SearchOptions,
}

#[derive(Deserialize)]
struct CancelArgs {
    search: Value,
}

#[derive(Deserialize)]
struct WatchArgs {
    dirs: Vec<String>,
    #[serde(default)]
    recursive: bool,
    #[serde(default)]
    watcher: String,
}

#[derive(Deserialize)]
struct HelloArgs {
    version: Option<String>,
}

#[derive(Deserialize)]
struct ConnectArgs {
    #[serde(default)]
    host: String,
    port: u16,
}

/// A request's parameters as `T` (absent ones as `{}`).
fn args<T: DeserializeOwned>(params: Value) -> Result<T> {
    let params = if params.is_null() { json!({}) } else { params };
    Ok(serde_json::from_value(params)?)
}

fn text(path: &Path) -> Value {
    Value::String(path.to_string_lossy().into_owned())
}

impl Server {
    /// Kills everything started and exits.
    fn end(&self, code: i32) -> ! {
        self.streams.shutdown();
        std::process::exit(code)
    }

    fn handle_frame(self: &Arc<Self>, frame: &[u8]) {
        let message: Value = match serde_json::from_slice(frame) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("ignored a message that isn't JSON: {e}");
                return;
            }
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        if let Some(method) = message.get("notify").and_then(Value::as_str) {
            if let Err(e) = self.streams.notification(method, &params) {
                eprintln!("{method}: {e}");
            }
            return;
        }
        let Some(id) = message.get("id").cloned() else {
            eprintln!("ignored a message with neither an id nor `notify`");
            return;
        };
        let Some(method) = message
            .get("method")
            .and_then(Value::as_str)
            .map(String::from)
        else {
            self.out
                .respond(id, Err(Error::Protocol("a request needs a method".into())));
            return;
        };
        let server = self.clone();
        let reply_id = id.clone();
        let spawned = std::thread::Builder::new().spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                server.request(&method, params)
            }))
            .unwrap_or_else(|_| Err(Error::Exec(format!("{method} failed unexpectedly"))));
            match result {
                Ok((value, starter)) => {
                    server.out.respond(reply_id, Ok(value));
                    if let Some(start) = starter {
                        start();
                    }
                }
                Err(e) => server.out.respond(reply_id, Err(e)),
            }
            if method == "shutdown" {
                // The writer sends what's queued (this response), then the server ends.
                server.out.exit();
            }
        });
        if let Err(e) = spawned {
            self.out.respond(id, Err(Error::Io(e)));
        }
    }

    /// One request's result, and for a new stream what starts it once the result is sent.
    fn request(&self, method: &str, params: Value) -> Result<(Value, Option<Starter>)> {
        let value = match method {
            "proc.spawn" => {
                let (value, start) = self.streams.spawn(args::<SpawnParams>(params)?)?;
                return Ok((value, Some(start)));
            }
            "tcp.connect" => {
                let a: ConnectArgs = args(params)?;
                let (value, start) = self.streams.connect(&a.host, a.port)?;
                return Ok((value, Some(start)));
            }
            _ => self.call(method, params)?,
        };
        Ok((value, None))
    }

    fn call(&self, method: &str, params: Value) -> Result<Value> {
        let ws = &self.ws;
        Ok(match method {
            "hello" => {
                let a: HelloArgs = args(params)?;
                let version = env!("CARGO_PKG_VERSION");
                if let Some(wanted) = a.version.filter(|v| v != version) {
                    return Err(Error::Invalid(format!(
                        "this server is version {version}, not {wanted}"
                    )));
                }
                json!({
                    "version": version,
                    "os": std::env::consts::OS,
                    "arch": std::env::consts::ARCH,
                    "home": system::home(),
                    "shell": system::login_shell(),
                    "user": system::user(),
                    "pid": std::process::id(),
                })
            }
            "shutdown" => Value::Null,

            "ws.open" => {
                let a: PathArg = args(params)?;
                let root = ws.open(&system::expand_home(&a.path, &system::home()))?;
                self.index.set_folders(&ws.folders());
                text(&root)
            }
            "ws.setFolders" => {
                let a: FoldersArgs = args(params)?;
                let results = ws.set_folders(&a.paths)?;
                self.index.set_folders(&ws.folders());
                serde_json::to_value(results)?
            }
            "ws.close" => {
                ws.close()?;
                self.index.set_folders(&[]);
                Value::Null
            }

            "fs.listDir" => {
                let a: PathArg = args(params)?;
                serde_json::to_value(files::list_dir(&ws.resolve(&a.path)?)?)?
            }
            "fs.stat" => {
                let a: PathArg = args(params)?;
                serde_json::to_value(files::stat(&ws.resolve(&a.path)?)?)?
            }
            "fs.exists" => {
                let a: PathArg = args(params)?;
                Value::Bool(ws.resolve(&a.path)?.exists())
            }
            "fs.read" => {
                let a: ReadArgs = args(params)?;
                let (bytes, truncated) = files::read(&ws.resolve(&a.path)?, a.max_bytes)?;
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                json!({ "data": data, "truncated": truncated })
            }
            "fs.write" => {
                let a: WriteArgs = args(params)?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(a.data.as_bytes())
                    .map_err(|e| Error::Invalid(format!("bad base64: {e}")))?;
                files::write(&ws.resolve(&a.path)?, &bytes)?;
                Value::Null
            }
            "fs.createFile" => {
                let a: CreateArgs = args(params)?;
                text(&files::create_file(&ws.resolve(&a.parent)?, &a.name)?)
            }
            "fs.createDir" => {
                let a: CreateArgs = args(params)?;
                text(&files::create_dir(&ws.resolve(&a.parent)?, &a.name)?)
            }
            "fs.rename" => {
                let a: RenameArgs = args(params)?;
                text(&files::rename(&ws.resolve_entry(&a.path)?, &a.new_name)?)
            }
            "fs.move" => {
                let a: IntoArgs = args(params)?;
                let from = ws.resolve_entry(&a.path)?;
                let dest = ws.resolve(&a.dest)?;
                text(&files::move_into(&from, &dest, &ws.folders())?)
            }
            "fs.copy" => {
                let a: IntoArgs = args(params)?;
                text(&files::copy_into(
                    &ws.resolve(&a.path)?,
                    &ws.resolve(&a.dest)?,
                )?)
            }
            "fs.delete" => {
                let a: PathArg = args(params)?;
                files::delete(&ws.resolve_entry(&a.path)?, &ws.folders())?;
                Value::Null
            }
            "fs.canonical" => {
                let a: PathArg = args(params)?;
                text(&ws.resolve(&a.path)?)
            }

            "browse.listDir" => {
                let a: PathArg = args(params)?;
                serde_json::to_value(files::list_dir(&canonicalize(browse_path(&a.path)?)?)?)?
            }
            "browse.stat" => {
                let a: PathArg = args(params)?;
                match files::stat(&browse_path(&a.path)?) {
                    Ok(stat) => serde_json::to_value(stat)?,
                    Err(_) => Value::Null,
                }
            }

            "index.query" => {
                let a: QueryArgs = args(params)?;
                let cap = if a.query.trim().is_empty() {
                    MAX_LIST_LIMIT
                } else {
                    MAX_QUERY_LIMIT
                };
                let limit = a.limit.unwrap_or(DEFAULT_QUERY_LIMIT).min(cap);
                let root = a.root.map(|r| ws.scope_root(&r)).transpose()?;
                serde_json::to_value(self.index.query(&a.query, limit, root.as_deref())?)?
            }
            "index.listen" => Value::Bool(self.index.listen()),
            "search.start" => {
                let a: SearchArgs = args(params)?;
                let roots = match a.roots {
                    Some(roots) => roots
                        .iter()
                        .map(|r| ws.scope_root(r))
                        .collect::<Result<Vec<_>>>()?,
                    None => ws.folders(),
                };
                self.searches
                    .start(a.search, roots, a.options, self.out.clone())?;
                Value::Null
            }
            "search.cancel" => {
                let a: CancelArgs = args(params)?;
                self.searches.cancel(&a.search);
                Value::Null
            }

            "watch.setDirs" => {
                let a: WatchArgs = args(params)?;
                let dirs: Vec<PathBuf> = a
                    .dirs
                    .iter()
                    .map(PathBuf::from)
                    .filter(|d| d.is_absolute())
                    .collect();
                self.watches.set_dirs(&a.watcher, dirs, a.recursive)?;
                Value::Null
            }

            "tcp.listening" => serde_json::to_value(ports::listening())?,

            other => return Err(Error::Protocol(format!("unknown method {other}"))),
        })
    }
}

/// A path to browse (outside the workspace, read-only): absolute after `~` is expanded.
fn browse_path(path: &str) -> Result<PathBuf> {
    let expanded = PathBuf::from(system::expand_home(path.trim(), &system::home()));
    if !expanded.is_absolute() {
        return Err(Error::Invalid(format!("path must be absolute: {path}")));
    }
    Ok(expanded)
}
