//! How a window reaches its remote: `ssh:<host>` runs the user's own `ssh` (their config, keys,
//! agent, known hosts, jump hosts all apply), `wsl:<distro>` runs `wsl.exe` (local development
//! and the UI tests), `container:<user@id>` runs `docker exec` in a dev container (D266). Either
//! way the server's protocol goes over the process's standard input and output. Also the hosts
//! in `~/.ssh/config`, for the picker.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Ssh,
    Wsl,
    /// A running container (a dev container, D266): `[user@]<container id or name>`.
    Container,
}

/// A window's remote, as `--remote` and `remote_connect` name it (`ssh:box`, `wsl:Ubuntu`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authority {
    pub kind: Kind,
    /// ssh: as the user wrote it (an ~/.ssh/config alias, user@host, user@host:port);
    /// wsl: the distribution.
    pub host: String,
}

impl Authority {
    pub fn parse(text: &str) -> Result<Authority> {
        let text = text.trim();
        let (kind, host) = match text.split_once(':') {
            Some(("ssh", host)) => (Kind::Ssh, host),
            Some(("wsl", host)) => (Kind::Wsl, host),
            Some(("container", host)) => (Kind::Container, host),
            _ => {
                return Err(Error::Invalid(format!(
                    "{text} isn't a remote (ssh:<host>, wsl:<distribution> or container:<id>)"
                )))
            }
        };
        if !valid_host(kind, host) {
            return Err(Error::Invalid(format!(
                "\"{host}\" isn't a host name (letters, digits, . _ - @ : only)"
            )));
        }
        Ok(Authority {
            kind,
            host: host.to_string(),
        })
    }

    /// `ssh:box`: how it's passed between processes.
    pub fn as_string(&self) -> String {
        format!("{}:{}", self.scheme(), self.host)
    }

    pub fn scheme(&self) -> &'static str {
        match self.kind {
            Kind::Ssh => "ssh",
            Kind::Wsl => "wsl",
            Kind::Container => "container",
        }
    }

    /// "SSH: box" / "WSL: Ubuntu" (the frontend's `remoteLabel`).
    pub fn label(&self) -> String {
        match self.kind {
            Kind::Ssh => format!("SSH: {}", self.host),
            Kind::Wsl => format!("WSL: {}", self.host),
            Kind::Container => format!("Dev container: {}", self.host),
        }
    }

    /// `ssh://box/home/me/app`: a folder there as the recent list and the window registry name
    /// it (the frontend's `formatRemoteLocation`).
    pub fn location(&self, path: &str) -> String {
        let path = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        };
        format!(
            "{}://{}{}",
            self.scheme(),
            self.host,
            path.replace('%', "%25").replace(' ', "%20")
        )
    }
}

/// A host as typed: never option-like (`-oProxyCommand=…`), no spaces, quotes or shell
/// characters (it's one argument to ssh, never a shell's).
pub fn valid_host(kind: Kind, host: &str) -> bool {
    if host.is_empty() || host.len() > 255 || host.starts_with('-') {
        return false;
    }
    if kind == Kind::Container {
        // One `user@`, and the container never option-like (`node@-it`).
        let container = host.rsplit('@').next().unwrap_or_default();
        if host.matches('@').count() > 1 || container.is_empty() || container.starts_with('-') {
            return false;
        }
    }
    host.chars().all(|c| {
        c.is_ascii_alphanumeric()
            || matches!(c, '.' | '_' | '-')
            || (kind == Kind::Ssh && matches!(c, '@' | ':' | '[' | ']' | '%'))
            || (kind == Kind::Container && c == '@')
    })
}

/// `user@container` → (the user, if one is named; the container).
pub fn container_target(host: &str) -> (Option<&str>, &str) {
    match host.split_once('@') {
        Some((user, id)) if !user.is_empty() => (Some(user), id),
        Some((_, id)) => (None, id),
        None => (None, host),
    }
}

/// `user@host:port` / `[v6]:port` → the destination for ssh and the port, if one is given
/// (ssh takes `-p`, not `host:port`). A bare IPv6 address (several `:`) is the host itself.
pub fn ssh_destination(host: &str) -> (String, Option<u16>) {
    let (user, rest) = match host.rsplit_once('@') {
        Some((u, r)) => (Some(u), r),
        None => (None, host),
    };
    let with_user = |h: &str| match user {
        Some(u) => format!("{u}@{h}"),
        None => h.to_string(),
    };
    if let Some(inner) = rest.strip_prefix('[') {
        // `[::1]` or `[::1]:2222`.
        if let Some((addr, tail)) = inner.split_once(']') {
            let port = tail.strip_prefix(':').and_then(|p| p.parse().ok());
            return (with_user(addr), port);
        }
    }
    match rest.split_once(':') {
        Some((h, p)) if !p.contains(':') && !h.is_empty() => match p.parse::<u16>() {
            Ok(port) => (with_user(h), Some(port)),
            Err(_) => (host.to_string(), None),
        },
        _ => (host.to_string(), None),
    }
}

/// The ssh arguments that run `remote_command` (one string, the remote's login shell runs it)
/// on `host`: no terminal, keepalives, and prompts allowed (they go to the askpass program).
pub fn ssh_args(host: &str, remote_command: &str) -> Vec<String> {
    let (dest, port) = ssh_destination(host);
    let mut args: Vec<String> = [
        "-T",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=4",
        "-o",
        "ConnectTimeout=20",
        "-o",
        "BatchMode=no",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    if let Some(p) = port {
        args.push("-p".into());
        args.push(p.to_string());
    }
    // `--`: whatever the host looks like, it's never read as an option.
    args.push("--".into());
    args.push(dest);
    args.push(remote_command.to_string());
    args
}

/// Windows' own OpenSSH client when it's there (Git for Windows' ssh doesn't take SSH_ASKPASS
/// from a program without a console the same way), else `ssh` on PATH.
pub fn ssh_program() -> PathBuf {
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let p = PathBuf::from(root)
                .join("System32")
                .join("OpenSSH")
                .join("ssh.exe");
            if p.is_file() {
                return p;
            }
        }
    }
    PathBuf::from("ssh")
}

/// The transport process that runs `script` (POSIX sh, without single quotes) on the remote,
/// its standard input, output and errors piped. `askpass`: the variables that send ssh's
/// prompts to the IDE.
pub fn command(at: &Authority, script: &str, askpass: &[(String, String)]) -> Command {
    let mut cmd = match at.kind {
        Kind::Ssh => {
            let mut c = Command::new(ssh_program());
            c.args(ssh_args(&at.host, &format!("sh -c '{script}'")));
            for (k, v) in askpass {
                c.env(k, v);
            }
            // Prompts come through the askpass program even with a console around (force), and
            // older clients want DISPLAY set before they use it at all.
            c.env("SSH_ASKPASS_REQUIRE", "force");
            if std::env::var_os("DISPLAY").is_none() {
                c.env("DISPLAY", "localhost:0");
            }
            c
        }
        Kind::Wsl => {
            let mut c = Command::new("wsl.exe");
            c.args(["-d", &at.host, "-e", "sh", "-c", script]);
            c
        }
        Kind::Container => {
            // `docker exec -i`: the pipe, no terminal; the container's own user unless one is named.
            let (user, container) = container_target(&at.host);
            let mut c = Command::new(super::docker::program());
            c.args(["exec", "-i"]);
            if let Some(u) = user {
                c.args(["-u", u]);
            }
            c.args([container, "sh", "-c", script]);
            c
        }
    };
    // The browser pane's debugging port is for the IDE's own webviews (D229).
    cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(home) = super::home_dir() {
        cmd.current_dir(home);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// A host from `~/.ssh/config` (no wildcards), for the picker.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfigHost {
    pub host: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// The `Host` entries of an ssh config text: each named host (patterns with `*`, `?` or `!`
/// left out) with the HostName, User and Port lines under it. `include` reads an `Include`d
/// file's text (best effort; nested at most four deep).
pub fn parse_config(
    text: &str,
    include: &dyn Fn(&str) -> Vec<String>,
    depth: u8,
) -> Vec<ConfigHost> {
    let mut out: Vec<ConfigHost> = Vec::new();
    // The hosts the current block names (a `Match` block names none).
    let mut current: Vec<usize> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (
                k.to_ascii_lowercase(),
                v.trim().trim_start_matches('=').trim(),
            ),
            None => continue,
        };
        let value = value.trim_matches('"');
        match key.as_str() {
            "host" => {
                current.clear();
                for name in value.split_whitespace() {
                    if name.contains(['*', '?', '!']) || !valid_host(Kind::Ssh, name) {
                        continue;
                    }
                    let index = match out.iter().position(|h| h.host == name) {
                        Some(i) => i,
                        None => {
                            out.push(ConfigHost {
                                host: name.to_string(),
                                hostname: None,
                                user: None,
                                port: None,
                            });
                            out.len() - 1
                        }
                    };
                    current.push(index);
                }
            }
            "match" => current.clear(),
            // ssh uses the first value it sees for each option.
            "hostname" => {
                for &i in &current {
                    out[i].hostname.get_or_insert_with(|| value.to_string());
                }
            }
            "user" => {
                for &i in &current {
                    out[i].user.get_or_insert_with(|| value.to_string());
                }
            }
            "port" => {
                if let Ok(port) = value.parse::<u16>() {
                    for &i in &current {
                        out[i].port.get_or_insert(port);
                    }
                }
            }
            "include" if depth < 4 => {
                for file in value.split_whitespace() {
                    for text in include(file) {
                        for host in parse_config(&text, include, depth + 1) {
                            if !out.iter().any(|h| h.host == host.host) {
                                out.push(host);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The hosts in the user's `~/.ssh/config` (and the files it includes).
pub fn config_hosts() -> Vec<ConfigHost> {
    let Some(home) = super::home_dir() else {
        return Vec::new();
    };
    let ssh = home.join(".ssh");
    let Ok(text) = std::fs::read_to_string(ssh.join("config")) else {
        return Vec::new();
    };
    let include = |pattern: &str| -> Vec<String> {
        include_files(&ssh, &home, pattern)
            .iter()
            .filter_map(|p| std::fs::read_to_string(p).ok())
            .collect()
    };
    parse_config(&text, &include, 0)
}

/// The files an `Include` names: relative to `~/.ssh`, `~` expanded, a `*` in the file name
/// matched against that folder's files.
fn include_files(ssh: &Path, home: &Path, pattern: &str) -> Vec<PathBuf> {
    let expanded = match pattern.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => {
            let p = PathBuf::from(pattern);
            if p.is_absolute() {
                p
            } else {
                ssh.join(p)
            }
        }
    };
    let name = expanded
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    if !name.contains('*') {
        return vec![expanded];
    }
    let Some(dir) = expanded.parent() else {
        return Vec::new();
    };
    let (head, tail) = name.split_once('*').unwrap_or((&name, ""));
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.is_file()
                        && p.file_name().is_some_and(|n| {
                            let n = n.to_string_lossy();
                            n.starts_with(head)
                                && n.ends_with(tail)
                                && n.len() >= head.len() + tail.len()
                        })
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorities_are_parsed_and_checked() {
        let a = Authority::parse("ssh:me@box:2222").unwrap();
        assert_eq!(a.kind, Kind::Ssh);
        assert_eq!(a.host, "me@box:2222");
        assert_eq!(a.as_string(), "ssh:me@box:2222");
        assert_eq!(a.label(), "SSH: me@box:2222");
        assert_eq!(
            Authority::parse("wsl:Ubuntu").unwrap().label(),
            "WSL: Ubuntu"
        );
        for bad in [
            "ssh:-oProxyCommand=calc",
            "ssh:a b",
            "ssh:",
            "ssh:a;b",
            "ssh:a'b",
            "wsl:a@b",
            "ftp:box",
            "box",
        ] {
            assert!(Authority::parse(bad).is_err(), "{bad}");
        }
        assert_eq!(
            a.location("/home/me/my app"),
            "ssh://me@box:2222/home/me/my%20app"
        );
    }

    #[test]
    fn containers_are_a_user_and_a_container() {
        let c = Authority::parse("container:node@0123456789ab").unwrap();
        assert_eq!(c.kind, Kind::Container);
        assert_eq!(c.label(), "Dev container: node@0123456789ab");
        assert_eq!(container_target(&c.host), (Some("node"), "0123456789ab"));
        assert_eq!(container_target("happy_app"), (None, "happy_app"));
        for bad in [
            "container:a@b@c",
            "container:-it",
            "container:a b",
            "container:a:b",
            "container:a;b",
            "container:node@-it",
            "container:node@",
        ] {
            assert!(Authority::parse(bad).is_err(), "{bad}");
        }
        assert_eq!(
            c.location("/workspaces/app"),
            "container://node@0123456789ab/workspaces/app"
        );
    }

    #[test]
    fn ports_and_ipv6_become_ssh_arguments() {
        assert_eq!(ssh_destination("box"), ("box".into(), None));
        assert_eq!(
            ssh_destination("me@box:2222"),
            ("me@box".into(), Some(2222))
        );
        assert_eq!(ssh_destination("[::1]:22"), ("::1".into(), Some(22)));
        assert_eq!(ssh_destination("me@[fe80::1]"), ("me@fe80::1".into(), None));
        assert_eq!(ssh_destination("::1"), ("::1".into(), None));
        assert_eq!(ssh_destination("box:x"), ("box:x".into(), None));
        let args = ssh_args("me@box:2222", "sh -c 'x'");
        assert_eq!(
            args,
            [
                "-T",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=4",
                "-o",
                "ConnectTimeout=20",
                "-o",
                "BatchMode=no",
                "-p",
                "2222",
                "--",
                "me@box",
                "sh -c 'x'"
            ]
        );
    }

    #[test]
    fn the_ssh_command_routes_prompts_to_the_ide() {
        let at = Authority::parse("ssh:box").unwrap();
        let cmd = command(&at, "echo hi", &[("SSH_ASKPASS".into(), "ide".into())]);
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args.last().map(String::as_str), Some("sh -c 'echo hi'"));
        let env: Vec<(String, Option<String>)> = cmd
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        assert!(env.contains(&("SSH_ASKPASS".into(), Some("ide".into()))));
        assert!(env.contains(&("SSH_ASKPASS_REQUIRE".into(), Some("force".into()))));
        let wsl = command(&Authority::parse("wsl:Ubuntu").unwrap(), "echo hi", &[]);
        let args: Vec<String> = wsl
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(args, ["-d", "Ubuntu", "-e", "sh", "-c", "echo hi"]);
    }

    #[test]
    fn config_hosts_without_wildcards_with_their_details() {
        let text = "\
# comment
Host *
  User everyone
Host box box2
  HostName 10.0.0.5
  User me
  Port 2222
Host *.internal !bad
  User nobody
Host dev
  HostName=dev.example.com
Match host x
  User matched
Include extra
";
        let include = |name: &str| -> Vec<String> {
            if name == "extra" {
                vec!["Host dev\n  User ignored\nHost extra-host\n  User you\n".into()]
            } else {
                vec![]
            }
        };
        let hosts = parse_config(text, &include, 0);
        assert_eq!(
            hosts,
            vec![
                ConfigHost {
                    host: "box".into(),
                    hostname: Some("10.0.0.5".into()),
                    user: Some("me".into()),
                    port: Some(2222)
                },
                ConfigHost {
                    host: "box2".into(),
                    hostname: Some("10.0.0.5".into()),
                    user: Some("me".into()),
                    port: Some(2222)
                },
                ConfigHost {
                    host: "dev".into(),
                    hostname: Some("dev.example.com".into()),
                    user: None,
                    port: None
                },
                ConfigHost {
                    host: "extra-host".into(),
                    hostname: None,
                    user: Some("you".into()),
                    port: None
                },
            ]
        );
    }
}
