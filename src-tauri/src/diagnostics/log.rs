//! The session log (D204): one file per run in `<logs>/sessions/session-<UTC time>-<pid>.log`,
//! the last `KEEP_SESSIONS` kept, each capped at `MAX_BYTES` (later lines dropped, with one line
//! saying so). Every line is redacted before it's written. The frontend sends its errors here
//! (`log_write`), and the panic hook writes Rust panics.
//!
//! Output channels (D209, VS Code's Output panel: Extension host, Git, each language server,
//! Tasks, Agent) are written beside it, in a folder named like the session's file
//! (`session-<time>-<pid>/<channel>.log`), each capped the same way; the folder goes with its
//! session when it rotates out.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use super::redact::redact;

pub const KEEP_SESSIONS: usize = 10;
pub const MAX_BYTES: u64 = 4 * 1024 * 1024;
/// One message at most this long (a huge stack or a stray file's text).
const MAX_MESSAGE: usize = 8_000;
/// Channel files one session writes at most (each language server has its own).
const MAX_CHANNELS: usize = 64;

pub struct SessionLog {
    path: PathBuf,
    home: Option<String>,
    max_bytes: u64,
    inner: Mutex<Inner>,
    /// The output channels' files (D209), opened on their first record.
    channels: Mutex<HashMap<String, Inner>>,
}

/// A channel id as a file name: letters, digits, `.`, `-`, `_` (others become `-`), at most 60.
pub fn channel_file_name(channel: &str) -> Option<String> {
    let name: String = channel
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '-'
            }
        })
        .take(60)
        .collect();
    let name = name.trim_matches('.').to_string();
    (!name.is_empty()).then(|| format!("{name}.log"))
}

struct Inner {
    file: Option<File>,
    written: u64,
    capped: bool,
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` for ms since the epoch (UTC, no dependency).
pub fn iso_time(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem / 60) % 60,
        rem % 60,
        ms % 1000
    )
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The session files in `dir`, oldest first (their names sort by time).
pub fn session_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = fs::read_dir(dir)
        .map(|it| {
            it.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with("session-") && n.ends_with(".log"))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

/// Deletes the oldest session files so that `keep - 1` remain (room for the new one), with
/// their channel folders (D209).
pub fn rotate(dir: &Path, keep: usize) {
    let files = session_files(dir);
    let extra = files.len().saturating_sub(keep.saturating_sub(1));
    for old in files.into_iter().take(extra) {
        let _ = fs::remove_dir_all(old.with_extension(""));
        let _ = fs::remove_file(old);
    }
    // A channel folder whose session is gone (it couldn't be deleted last time: a file in use).
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.filter_map(|e| e.ok()) {
            let path = e.path();
            let is_session_dir = path.is_dir()
                && path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("session-"));
            if is_session_dir && !path.with_extension("log").exists() {
                let _ = fs::remove_dir_all(path);
            }
        }
    }
}

impl SessionLog {
    /// Opens a new session file in `<logs>/sessions` (rotating old ones). A folder that can't be
    /// written gives a log that drops everything, never an error: logging must not stop a start.
    pub fn open(logs_dir: &Path, home: Option<&Path>) -> Self {
        Self::open_with(logs_dir, home, now_ms(), std::process::id(), MAX_BYTES)
    }

    pub fn open_with(
        logs_dir: &Path,
        home: Option<&Path>,
        now: u64,
        pid: u32,
        max_bytes: u64,
    ) -> Self {
        let dir = logs_dir.join("sessions");
        let _ = fs::create_dir_all(&dir);
        rotate(&dir, KEEP_SESSIONS);
        let stamp: String = iso_time(now)
            .chars()
            .filter(|c| c.is_ascii_digit() || *c == 'T')
            .take(15)
            .collect();
        let path = dir.join(format!("session-{stamp}-{pid}.log"));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
        Self {
            path,
            home: home.map(|h| h.to_string_lossy().into_owned()),
            max_bytes,
            inner: Mutex::new(Inner {
                file,
                written: 0,
                capped: false,
            }),
            channels: Mutex::new(HashMap::new()),
        }
    }

    /// The folder of this session's output channel files (D209).
    pub fn channels_dir(&self) -> PathBuf {
        self.path.with_extension("")
    }

    /// Appends one record (redacted) to an output channel's file (D209). Silent on failure.
    pub fn write_channel(&self, channel: &str, level: &str, source: &str, message: &str) {
        let Some(name) = channel_file_name(channel) else {
            return;
        };
        let line = self.format(level, source, message);
        let Ok(mut channels) = self.channels.lock() else {
            return;
        };
        if !channels.contains_key(&name) {
            if channels.len() >= MAX_CHANNELS {
                return;
            }
            let dir = self.channels_dir();
            let _ = fs::create_dir_all(&dir);
            let file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(&name))
                .ok();
            channels.insert(
                name.clone(),
                Inner {
                    file,
                    written: 0,
                    capped: false,
                },
            );
        }
        if let Some(inner) = channels.get_mut(&name) {
            self.append(inner, &line);
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn dir(&self) -> &Path {
        self.path.parent().unwrap_or(&self.path)
    }

    fn format(&self, level: &str, source: &str, message: &str) -> String {
        let mut message = redact(message.trim_end(), self.home.as_deref());
        if message.len() > MAX_MESSAGE {
            let mut cut = MAX_MESSAGE;
            while !message.is_char_boundary(cut) {
                cut -= 1;
            }
            message.truncate(cut);
            message.push_str(" …(cut)");
        }
        // Continuation lines are indented, so every record starts with its time.
        let message = message.replace("\r\n", "\n").replace('\n', "\n    ");
        let level: String = level
            .chars()
            .filter(char::is_ascii_alphabetic)
            .take(8)
            .collect();
        let source: String = source
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'))
            .take(40)
            .collect();
        format!("{} [{level}] [{source}] {message}\n", iso_time(now_ms()))
    }

    /// Appends one record (redacted). Silent on failure.
    pub fn write(&self, level: &str, source: &str, message: &str) {
        let line = self.format(level, source, message);
        if let Ok(mut inner) = self.inner.lock() {
            self.append(&mut inner, &line);
        }
    }

    /// `write` that never waits for the lock (the panic hook: a panic while writing must not
    /// deadlock).
    pub fn write_now(&self, level: &str, source: &str, message: &str) {
        let line = self.format(level, source, message);
        if let Ok(mut inner) = self.inner.try_lock() {
            self.append(&mut inner, &line);
        }
    }

    fn append(&self, inner: &mut Inner, line: &str) {
        if inner.capped {
            return;
        }
        let Some(file) = inner.file.as_mut() else {
            return;
        };
        let bytes = line.len() as u64;
        if inner.written + bytes > self.max_bytes {
            inner.capped = true;
            let _ = file.write_all(
                format!(
                    "{} [warn] [log] The log reached its size limit; later lines are dropped.\n",
                    iso_time(now_ms())
                )
                .as_bytes(),
            );
            return;
        }
        if file.write_all(line.as_bytes()).is_ok() {
            inner.written += bytes;
        }
    }

    /// The last `max` records of this session's file (each with its continuation lines).
    pub fn recent(&self, max: usize) -> Vec<String> {
        let text = fs::read(&self.path)
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .unwrap_or_default();
        let mut records: Vec<String> = Vec::new();
        for line in text.lines() {
            match records.last_mut() {
                Some(last) if line.starts_with("    ") => {
                    last.push('\n');
                    last.push_str(line);
                }
                _ if !line.is_empty() => records.push(line.to_string()),
                _ => {}
            }
        }
        let start = records.len().saturating_sub(max);
        records.split_off(start)
    }
}

static LOG: OnceLock<Arc<SessionLog>> = OnceLock::new();

/// Makes `log` the process's log and writes Rust panics to it (the default hook still prints).
pub fn install_panic_hook(log: Arc<SessionLog>) {
    if LOG.set(log).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(log) = LOG.get() {
            let what = info
                .payload()
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic".into());
            let at = info
                .location()
                .map(|l| format!(" at {}:{}", l.file(), l.line()))
                .unwrap_or_default();
            let thread = std::thread::current()
                .name()
                .unwrap_or("unnamed")
                .to_string();
            let trace = std::backtrace::Backtrace::force_capture();
            log.write_now(
                "error",
                "panic",
                &format!("thread '{thread}' panicked{at}: {what}\n{trace}"),
            );
        }
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ide-log-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn times_are_iso() {
        assert_eq!(iso_time(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_time(1_793_000_000_123), "2026-10-26T07:33:20.123Z");
        assert_eq!(iso_time(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn sessions_rotate_keeping_the_last_ten() {
        let dir = temp("rotate");
        for i in 0..14u64 {
            let log = SessionLog::open_with(&dir, None, 1_700_000_000_000 + i * 1000, 7, MAX_BYTES);
            log.write("info", "test", &format!("run {i}"));
        }
        let files = session_files(&dir.join("sessions"));
        assert_eq!(files.len(), KEEP_SESSIONS);
        // The oldest went: the newest is the last run's.
        let newest = files.last().expect("a file");
        assert!(fs::read_to_string(newest)
            .unwrap_or_default()
            .contains("run 13"));
        let oldest = files.first().expect("a file");
        assert!(fs::read_to_string(oldest)
            .unwrap_or_default()
            .contains("run 4"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn channels_go_beside_the_session_and_rotate_with_it() {
        let dir = temp("channels");
        let first = SessionLog::open_with(&dir, Some(Path::new("/home/ada")), 1_000, 1, MAX_BYTES);
        first.write_channel("lsp.rust-analyzer", "info", "lsp", "started /home/ada/p");
        first.write_channel("ext host!", "warn", "ext", "careful");
        first.write_channel("..", "info", "x", "no name: dropped");
        let channels = first.channels_dir();
        let text = fs::read_to_string(channels.join("lsp.rust-analyzer.log")).unwrap_or_default();
        assert!(
            text.contains("[info] [lsp] started ~/p"),
            "redacted, formatted: {text}"
        );
        assert!(channels.join("ext-host-.log").exists());
        assert_eq!(fs::read_dir(&channels).map(|d| d.count()).unwrap_or(0), 2);
        for i in 1..=KEEP_SESSIONS as u64 {
            let _ = SessionLog::open_with(&dir, None, 1_000 + i * 1000, 1, MAX_BYTES);
        }
        assert!(!channels.exists(), "the folder went with its session");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn size_is_capped_and_lines_are_redacted() {
        let dir = temp("cap");
        let log = SessionLog::open_with(&dir, Some(Path::new("/home/ada")), 1, 1, 400);
        log.write(
            "error",
            "frontend",
            "failed /home/ada/p/x.ts key=sk-abcdefghijklmnopqrstu",
        );
        log.write("error", "frontend", "two\nlines");
        for _ in 0..20 {
            log.write("info", "x", "filler filler filler filler");
        }
        let text = fs::read_to_string(log.path()).unwrap_or_default();
        assert!(text.len() < 520, "{}", text.len());
        assert!(
            text.contains("~/p/x.ts") && !text.contains("abcdefghij"),
            "{text}"
        );
        assert!(text.contains("size limit"));
        let recent = log.recent(50);
        assert!(
            recent.iter().any(|r| r.ends_with("two\n    lines")),
            "{recent:?}"
        );
        assert!(recent[0].contains("[error] [frontend]"));
        let _ = fs::remove_dir_all(&dir);
    }
}
