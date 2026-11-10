//! Who and where the server runs: the user, home folder and login shell (`hello`), `~` in
//! paths, and the login environment programs start with.
//!
//! `ssh host server --stdio` runs the server without a login shell, so its PATH lacks what the
//! user's profile adds (nvm, cargo, pyenv). The login shell's environment is read once (the
//! shell runs this binary again with `--print-env`) and every program starts with it, as a
//! local program started from the user's own terminal would.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::Duration;

/// The variables the login shell hands back through `--print-env`.
const EXE_VAR: &str = "REMOTE_SERVER_EXE";
const MARK_VAR: &str = "REMOTE_SERVER_MARK";
/// A shell profile that hangs (waiting for input, a slow network mount) mustn't hang the server.
const LOGIN_ENV_TIMEOUT: Duration = Duration::from_secs(10);

/// One `/etc/passwd` line's fields that matter here.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PasswdEntry {
    pub name: String,
    pub home: String,
    pub shell: String,
}

/// The entry for `uid` in a passwd file's `text`.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn passwd_entry(text: &str, uid: u32) -> Option<PasswdEntry> {
    text.lines().find_map(|line| {
        let fields: Vec<&str> = line.split(':').collect();
        let (name, id, home, shell) = (
            fields.first()?,
            fields.get(2)?,
            fields.get(5)?,
            fields.get(6)?,
        );
        (id.parse::<u32>().ok()? == uid).then(|| PasswdEntry {
            name: name.to_string(),
            home: home.to_string(),
            shell: shell.trim().to_string(),
        })
    })
}

fn own_passwd_entry() -> Option<PasswdEntry> {
    #[cfg(unix)]
    {
        // SAFETY: getuid has no preconditions and can't fail.
        let uid = unsafe { libc::getuid() };
        let text = std::fs::read_to_string("/etc/passwd").ok()?;
        passwd_entry(&text, uid)
    }
    #[cfg(not(unix))]
    None
}

fn non_empty_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

pub fn home() -> String {
    non_empty_var("HOME")
        .or_else(|| own_passwd_entry().map(|e| e.home).filter(|h| !h.is_empty()))
        .unwrap_or_else(|| "/".into())
}

pub fn user() -> String {
    non_empty_var("USER")
        .or_else(|| non_empty_var("LOGNAME"))
        .or_else(|| own_passwd_entry().map(|e| e.name))
        .unwrap_or_default()
}

/// The login shell: `$SHELL`, else the passwd entry's, else `/bin/sh`.
pub fn login_shell() -> String {
    non_empty_var("SHELL")
        .or_else(|| {
            own_passwd_entry()
                .map(|e| e.shell)
                .filter(|s| !s.is_empty() && std::path::Path::new(s).exists())
        })
        .unwrap_or_else(|| "/bin/sh".into())
}

/// `~` and `~/…` with the home folder in front.
pub fn expand_home(path: &str, home: &str) -> String {
    if path == "~" {
        return home.to_string();
    }
    match path.strip_prefix("~/") {
        Some(rest) => format!("{}/{rest}", home.trim_end_matches('/')),
        None => path.to_string(),
    }
}

/// `--print-env`: the environment, NUL-separated after the caller's mark (what a shell profile
/// prints before it is skipped).
pub fn print_env() -> i32 {
    use std::io::Write;
    let mark = std::env::var(MARK_VAR).unwrap_or_default();
    let mut out = Vec::new();
    out.extend_from_slice(mark.as_bytes());
    out.push(0);
    for (key, value) in std::env::vars_os() {
        if key == EXE_VAR || key == MARK_VAR {
            continue;
        }
        out.extend_from_slice(key.to_string_lossy().as_bytes());
        out.push(b'=');
        out.extend_from_slice(value.to_string_lossy().as_bytes());
        out.push(0);
    }
    let mut stdout = std::io::stdout().lock();
    match stdout.write_all(&out).and_then(|()| stdout.flush()) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

/// The variables in `--print-env` output after `mark`, without the shell's own bookkeeping.
pub fn parse_env(output: &[u8], mark: &str) -> Option<Vec<(String, String)>> {
    let mut start = mark.as_bytes().to_vec();
    start.push(0);
    let at = output.windows(start.len()).position(|w| w == start)?;
    let rest = &output[at + start.len()..];
    let vars = rest
        .split(|&b| b == 0)
        .filter_map(|entry| {
            let text = String::from_utf8_lossy(entry);
            let (key, value) = text.split_once('=')?;
            let skip = key.is_empty() || matches!(key, "PWD" | "OLDPWD" | "SHLVL" | "_");
            (!skip).then(|| (key.to_string(), value.to_string()))
        })
        .collect();
    Some(vars)
}

/// The environment programs start with: the server's own, with the login shell's on top.
pub fn base_env() -> &'static HashMap<OsString, OsString> {
    static ENV: OnceLock<HashMap<OsString, OsString>> = OnceLock::new();
    ENV.get_or_init(|| {
        let mut env: HashMap<OsString, OsString> = std::env::vars_os().collect();
        match login_env() {
            Some(vars) => {
                for (key, value) in vars {
                    env.insert(key.into(), value.into());
                }
            }
            None => eprintln!("couldn't read the login shell's environment; using the server's"),
        }
        env
    })
}

fn login_env() -> Option<Vec<(String, String)>> {
    if cfg!(not(unix)) {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let mark = format!(
        "env-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let mut cmd = Command::new(login_shell());
    cmd.args(["-l", "-c", &format!("exec \"${EXE_VAR}\" --print-env")])
        .env(EXE_VAR, exe)
        .env(MARK_VAR, &mark)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let output = rx.recv_timeout(LOGIN_ENV_TIMEOUT).ok();
    if output.is_none() {
        crate::streams::kill_group(child.id(), "KILL");
        let _ = child.kill();
    }
    let _ = child.wait();
    parse_env(&output?, &mark)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_passwd_entries() {
        let text = "root:x:0:0:root:/root:/bin/bash\nme:x:1000:1000:Me,,,:/home/me:/usr/bin/zsh\n";
        assert_eq!(
            passwd_entry(text, 1000),
            Some(PasswdEntry {
                name: "me".into(),
                home: "/home/me".into(),
                shell: "/usr/bin/zsh".into()
            })
        );
        assert_eq!(passwd_entry(text, 5), None);
        assert_eq!(passwd_entry("broken", 0), None);
    }

    #[test]
    fn expands_home() {
        assert_eq!(expand_home("~", "/home/me"), "/home/me");
        assert_eq!(expand_home("~/src", "/home/me/"), "/home/me/src");
        assert_eq!(expand_home("/etc", "/home/me"), "/etc");
        assert_eq!(expand_home("~other", "/home/me"), "~other");
    }

    #[test]
    fn parses_env_after_the_mark() {
        let output = b"Welcome!\nmk\0PATH=/a:/b\0SHLVL=2\0EQ=x=y\0junk\0";
        let vars = parse_env(output, "mk");
        assert_eq!(
            vars,
            Some(vec![
                ("PATH".into(), "/a:/b".into()),
                ("EQ".into(), "x=y".into())
            ])
        );
        assert_eq!(parse_env(b"PATH=/a\0", "mk"), None);
    }
}
