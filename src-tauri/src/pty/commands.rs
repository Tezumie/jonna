//! Command records from shell-integration marks in terminal output (OSC 633, VS Code's protocol;
//! OSC 133 A/B/C/D from other tools also counts): A prompt start, B prompt end, C output start,
//! D[;exit] done, E;command line, P;Cwd=dir. Records keep the command, cwd, timing, exit code and
//! its output with escape sequences removed (capped), for `ide://terminals/<id>/commands` and for
//! agents running commands.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// Output kept per command (the tail is dropped beyond this).
const MAX_OUTPUT: usize = 64 * 1024;
/// Records kept per terminal.
const MAX_RECORDS: usize = 200;
/// An OSC longer than this is not ours (and must not grow the buffer forever).
const MAX_OSC: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandRecord {
    pub id: u32,
    pub command: String,
    pub cwd: Option<String>,
    pub started_ms: f64,
    pub ended_ms: Option<f64>,
    pub exit_code: Option<i32>,
    pub output: String,
    pub output_truncated: bool,
}

#[derive(Debug, Default)]
enum Scan {
    #[default]
    Text,
    Esc,
    /// Inside an OSC; collecting its payload.
    Osc(Vec<u8>),
    /// ESC seen inside an OSC (maybe ST = ESC \).
    OscEsc(Vec<u8>),
    /// CSI or other escape: skip until its final byte.
    Csi,
}

#[derive(Debug, Default)]
pub struct CommandTracker {
    scan: Scan,
    pub cwd: Option<String>,
    pub records: Vec<CommandRecord>,
    running: Option<CommandRecord>,
    /// Command line seen before its C mark.
    pending_command: Option<String>,
    next_id: u32,
    /// The shell integration's secret: command lines (E) without it are ignored (D192).
    pub nonce: Option<String>,
    /// True once any integration mark arrived (the shell supports it).
    pub active: bool,
    /// The start of a UTF-8 character split across two output chunks, kept for the next one
    /// (decoded alone it became U+FFFD in the record).
    carry: Vec<u8>,
    /// A Windows bash (Git Bash): its folders (`/c/Users/me`) are kept as Windows paths.
    pub msys: bool,
}

/// Git Bash / MSYS2 / Cygwin folders as Windows paths: `/c/Users/me` → `C:\Users\me`,
/// `/cygdrive/d/x` → `D:\x`. Paths inside the shell's own tree (`/usr/bin`) stay.
pub fn msys_to_windows(path: &str) -> String {
    let rest = path.strip_prefix("/cygdrive").unwrap_or(path);
    let mut chars = rest.chars();
    if chars.next() == Some('/') {
        if let Some(drive) = chars.next().filter(char::is_ascii_alphabetic) {
            let tail = chars.as_str();
            if tail.is_empty() || tail.starts_with('/') {
                let tail = tail.trim_start_matches('/').replace('/', "\\");
                return format!("{}:\\{tail}", drive.to_ascii_uppercase());
            }
        }
    }
    path.to_string()
}

/// How many bytes at the end of `b` are an unfinished UTF-8 character (0 to 3).
fn incomplete_tail(b: &[u8]) -> usize {
    for back in 1..=b.len().min(3) {
        let c = b[b.len() - back];
        if c & 0xC0 == 0x80 {
            continue; // a continuation byte: look further back for the lead byte
        }
        let need = match c {
            0xF0..=0xFF => 4,
            0xE0..=0xEF => 3,
            0xC0..=0xDF => 2,
            _ => 1,
        };
        return if need > back { back } else { 0 };
    }
    0
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Undoes the scripts' escaping: `\\` and `\xHH`.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            Some('\\') => {
                chars.next();
                out.push('\\');
            }
            Some('x') => {
                chars.next();
                let hex: String = chars.by_ref().take(2).collect();
                match u8::from_str_radix(&hex, 16) {
                    Ok(b) => out.push(char::from(b)),
                    Err(_) => {
                        out.push_str("\\x");
                        out.push_str(&hex);
                    }
                }
            }
            _ => out.push('\\'),
        }
    }
    out
}

impl CommandTracker {
    /// The command currently running, if any.
    pub fn running(&self) -> Option<&CommandRecord> {
        self.running.as_ref()
    }

    /// Feeds terminal output bytes.
    pub fn feed(&mut self, bytes: &[u8]) {
        let mut text: Vec<u8> = Vec::new();
        for &b in bytes {
            let scan = std::mem::take(&mut self.scan);
            self.scan = match scan {
                Scan::Text => match b {
                    0x1b => Scan::Esc,
                    0x07 => Scan::Text,
                    _ => {
                        text.push(b);
                        Scan::Text
                    }
                },
                Scan::Esc => match b {
                    b']' => Scan::Osc(Vec::new()),
                    b'[' => Scan::Csi,
                    _ => Scan::Text, // two-byte escape: dropped
                },
                Scan::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        Scan::Text
                    } else {
                        Scan::Csi
                    }
                }
                Scan::Osc(mut payload) => match b {
                    0x07 => {
                        self.flush_text(&mut text);
                        self.osc(&payload);
                        Scan::Text
                    }
                    0x1b => Scan::OscEsc(payload),
                    _ if payload.len() > MAX_OSC => Scan::Text,
                    _ => {
                        payload.push(b);
                        Scan::Osc(payload)
                    }
                },
                Scan::OscEsc(payload) => {
                    self.flush_text(&mut text);
                    if b == b'\\' {
                        self.osc(&payload);
                    }
                    Scan::Text
                }
            };
        }
        self.flush_text(&mut text);
    }

    fn flush_text(&mut self, text: &mut Vec<u8>) {
        if text.is_empty() {
            return;
        }
        if self.running.is_none() {
            self.carry.clear();
        }
        if !self.carry.is_empty() {
            let mut joined = std::mem::take(&mut self.carry);
            joined.append(text);
            *text = joined;
        }
        let hold = incomplete_tail(text);
        if hold > 0 {
            self.carry = text.split_off(text.len() - hold);
        }
        if let Some(rec) = self.running.as_mut() {
            if rec.output.len() < MAX_OUTPUT {
                let s = String::from_utf8_lossy(text).replace('\r', "");
                let room = MAX_OUTPUT - rec.output.len();
                if s.len() > room {
                    let mut cut = room;
                    while !s.is_char_boundary(cut) {
                        cut -= 1;
                    }
                    rec.output.push_str(&s[..cut]);
                    rec.output_truncated = true;
                } else {
                    rec.output.push_str(&s);
                }
            } else {
                rec.output_truncated = true;
            }
        }
        text.clear();
    }

    fn osc(&mut self, payload: &[u8]) {
        let payload = String::from_utf8_lossy(payload);
        let rest = payload
            .strip_prefix("633;")
            .or_else(|| payload.strip_prefix("133;"));
        let Some(rest) = rest else { return };
        self.active = true;
        let (kind, arg) = rest.split_once(';').unwrap_or((rest, ""));
        match kind {
            "C" => {
                self.finish(None); // a C without D: close the previous one
                self.next_id += 1;
                self.running = Some(CommandRecord {
                    id: self.next_id,
                    command: self.pending_command.take().unwrap_or_default(),
                    cwd: self.cwd.clone(),
                    started_ms: now_ms(),
                    ended_ms: None,
                    exit_code: None,
                    output: String::new(),
                    output_truncated: false,
                });
            }
            "D" => self.finish(arg.split(';').next().and_then(|c| c.trim().parse().ok())),
            "E" => {
                let mut fields = arg.split(';');
                let command = unescape(fields.next().unwrap_or(""));
                if let Some(nonce) = &self.nonce {
                    if fields.next() != Some(nonce.as_str()) {
                        return;
                    }
                }
                match self.running.as_mut() {
                    Some(rec) if rec.command.is_empty() => rec.command = command,
                    // PowerShell reports the command line after it ran: attach to the last one.
                    _ => match self.records.last_mut() {
                        Some(last) if last.command.is_empty() => last.command = command,
                        _ => self.pending_command = Some(command),
                    },
                }
            }
            "P" => {
                if let Some(cwd) = arg.strip_prefix("Cwd=") {
                    let cwd = unescape(cwd);
                    self.cwd = Some(if self.msys {
                        msys_to_windows(&cwd)
                    } else {
                        cwd
                    });
                }
            }
            _ => {}
        }
    }

    fn finish(&mut self, exit_code: Option<i32>) {
        let Some(mut rec) = self.running.take() else {
            return;
        };
        rec.ended_ms = Some(now_ms());
        rec.exit_code = exit_code;
        let trimmed = rec.output.trim_end().len();
        rec.output.truncate(trimmed);
        self.records.push(rec);
        if self.records.len() > MAX_RECORDS {
            self.records.remove(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bash_style_sequence_makes_a_record() {
        let mut t = CommandTracker::default();
        t.feed(b"\x1b]633;P;Cwd=/home/a\x07\x1b]633;A\x07$ \x1b]633;B\x07");
        t.feed(b"ls\r\n\x1b]633;C\x07\x1b[1;34mfile.txt\x1b[0m\r\nother\r\n");
        t.feed(b"\x1b]633;E;ls -la \\x3b echo\x07\x1b]633;D;0\x07\x1b]633;P;Cwd=/tmp\x07");
        assert_eq!(t.records.len(), 1);
        let r = &t.records[0];
        assert_eq!(r.command, "ls -la ; echo");
        assert_eq!(r.cwd.as_deref(), Some("/home/a"));
        assert_eq!(r.exit_code, Some(0));
        assert_eq!(r.output, "file.txt\nother");
        assert_eq!(t.cwd.as_deref(), Some("/tmp"));
    }

    #[test]
    fn marks_split_across_reads_and_st_terminator() {
        let mut t = CommandTracker::default();
        t.feed(b"\x1b]633;E;make\x1b\\\x1b]63");
        t.feed(b"3;C\x07build ok\n\x1b]133;D;2\x07");
        assert_eq!(t.records[0].command, "make");
        assert_eq!(t.records[0].exit_code, Some(2));
        assert_eq!(t.records[0].output, "build ok");
    }

    #[test]
    fn powershell_order_attaches_the_command_afterwards() {
        let mut t = CommandTracker::default();
        // E arrives after C but before D: attached to the running record.
        t.feed(b"\x1b]633;C\x07hi\r\n\x1b]633;E;Write-Output hi\x07\x1b]633;D;0\x07");
        assert_eq!(t.records[0].command, "Write-Output hi");
        // E after D: attached to the last record.
        let mut u = CommandTracker::default();
        u.feed(b"\x1b]633;C\x07out\x1b]633;D;1\x07\x1b]633;E;bad\x07");
        assert_eq!(u.records[0].command, "bad");
        assert_eq!(u.records[0].exit_code, Some(1));
    }

    #[test]
    fn utf8_split_across_chunks_is_kept_whole() {
        let mut t = CommandTracker::default();
        t.feed(b"\x1b]633;E;echo\x07\x1b]633;C\x07a\xe2\x82");
        t.feed(b"\xac b\r\n\x1b]633;D;0\x07");
        let rec = t.records.last().expect("a record");
        assert_eq!(rec.output.trim(), "a\u{20ac} b");
        assert_eq!(incomplete_tail(b"ab\xf0\x9f"), 2);
        assert_eq!(incomplete_tail("\u{e9}".as_bytes()), 0);
    }

    #[test]
    fn git_bash_folders_become_windows_paths() {
        assert_eq!(msys_to_windows("/c/Users/me"), r"C:\Users\me");
        assert_eq!(msys_to_windows("/d"), r"D:\");
        assert_eq!(msys_to_windows("/cygdrive/e/x/y"), r"E:\x\y");
        assert_eq!(msys_to_windows("/usr/bin"), "/usr/bin");
        let mut t = CommandTracker {
            msys: true,
            ..CommandTracker::default()
        };
        t.feed(b"\x1b]633;P;Cwd=/c/src/app\x07");
        assert_eq!(t.cwd.as_deref(), Some(r"C:\src\app"));
    }

    #[test]
    fn command_lines_need_the_nonce_when_there_is_one() {
        let mut t = CommandTracker {
            nonce: Some("abc".into()),
            ..CommandTracker::default()
        };
        // Printed by a program (no nonce): ignored. From the scripts: kept.
        t.feed(b"\x1b]633;E;rm -rf x\x07\x1b]633;C\x07\x1b]633;D;0\x07");
        assert_eq!(t.records[0].command, "");
        t.feed(b"\x1b]633;E;ls;abc\x07\x1b]633;C\x07\x1b]633;D;0\x07");
        assert!(t.records.iter().any(|r| r.command == "ls"));
        assert!(!t.records.iter().any(|r| r.command.contains("rm")));
    }

    #[test]
    fn zsh_ends_the_command_before_its_prompt_eol_mark() {
        // The script prefixes PROMPT_EOL_MARK with D (D207): PROMPT_SP's inverse `#` and its
        // padding come after the record ended (bytes from a real zsh 5.9).
        let script = include_str!("scripts/zshrc.zsh");
        assert!(script.contains(r"PROMPT_EOL_MARK=$'%{\e]633;D;%?\a%}'"));
        let mut t = CommandTracker::default();
        t.feed(b"\x1b]633;E;printf abc\\x3b false\x07\x1b]633;C\x07abc\x1b]633;D;1\x07\x1b[1m\x1b[7m#\x1b[27m\x1b[1m\x1b[0m      \r \r\x1b]633;P;Cwd=/tmp\x07");
        assert_eq!(t.records[0].command, "printf abc; false");
        assert_eq!(t.records[0].output, "abc");
        assert_eq!(t.records[0].exit_code, Some(1));
    }
}
