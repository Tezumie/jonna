//! WSL folders (D192): a folder inside a WSL distribution, opened through Windows' own path to it
//! (`\\wsl.localhost\Ubuntu\home\me\project`, or the older `\\wsl$\…`). Files are read and written
//! through that path like any other folder; programs (terminals, tasks, the agent's commands, git)
//! run *inside* the distribution with `wsl.exe -d <distro> --cd <linux path>`, so they see Linux
//! paths and the Linux tools. Dev servers there are reachable from Windows at localhost (WSL 2
//! forwards ports), so the browser preview works unchanged. Watching uses polling there: change
//! notifications don't cross the 9P file share.

use std::path::{Path, PathBuf};
use std::process::Command;

/// A Windows path into a WSL distribution, split.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslPath {
    pub distro: String,
    /// The path inside Linux, `/`-separated, starting with `/`.
    pub linux: String,
}

/// `\\wsl.localhost\<distro>\rest`, `\\wsl$\<distro>\rest`, `//wsl.localhost/...` and the
/// verbatim `\\?\UNC\wsl.localhost\...`: the distribution and the Linux path. Any other path: None.
pub fn parse(path: &str) -> Option<WslPath> {
    let p = path.replace('/', "\\");
    let rest = p
        .strip_prefix("\\\\?\\UNC\\")
        .or_else(|| p.strip_prefix("\\\\"))?;
    let mut parts = rest.split('\\').filter(|s| !s.is_empty());
    let host = parts.next()?.to_ascii_lowercase();
    if host != "wsl.localhost" && host != "wsl$" {
        return None;
    }
    let distro = parts.next()?.to_string();
    if distro.is_empty() || distro.contains(['"', '\'', '`', '$']) {
        return None;
    }
    let linux = format!("/{}", parts.collect::<Vec<_>>().join("/"));
    Some(WslPath { distro, linux })
}

/// The Windows path of a Linux path in a distribution (`\\wsl.localhost\<distro>\…`).
pub fn to_windows(distro: &str, linux: &str) -> PathBuf {
    let rest = linux.trim_start_matches('/').replace('/', "\\");
    PathBuf::from(format!("\\\\wsl.localhost\\{distro}\\{rest}"))
}

/// `dir` is in WSL: the distribution and the Linux folder to run programs in.
pub fn of_dir(dir: &Path) -> Option<WslPath> {
    parse(&dir.to_string_lossy())
}

/// The `wsl.exe` arguments that run `program args…` in `at` (its distribution, its folder).
/// `--exec` runs the program with these arguments as they are; `--` would hand the line to the
/// user's shell first, which reads `$(…)`, `(` and backquotes in them.
pub fn wrap_args(at: &WslPath, program: &str, args: &[String]) -> Vec<String> {
    let mut out = vec![
        "-d".to_string(),
        at.distro.clone(),
        "--cd".to_string(),
        at.linux.clone(),
        "--exec".to_string(),
        program.to_string(),
    ];
    out.extend(args.iter().cloned());
    out
}

/// Variables a Windows process sets that must not cross into Linux: paths to Windows programs
/// and the Windows search path.
const NOT_SHARED: [&str; 6] = [
    "PATH",
    "WSLENV",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "SSH_ASKPASS_REQUIRE",
    "USERPROFILE",
];

/// `WSLENV` for a `wsl.exe` that sets `names`: only listed variables reach Linux (`NAME/u`),
/// added to any list already there.
pub fn wslenv<'a>(existing: Option<&str>, names: impl IntoIterator<Item = &'a str>) -> String {
    let mut list: Vec<String> = existing
        .unwrap_or("")
        .split(':')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    for name in names {
        let shared = list.iter().any(|e| e.split('/').next() == Some(name));
        if !shared && !NOT_SHARED.iter().any(|n| n.eq_ignore_ascii_case(name)) {
            list.push(format!("{name}/u"));
        }
    }
    list.join(":")
}

/// Lets the variables set on `cmd` (a `wsl.exe` command) reach the program inside Linux; call
/// it after the last `.env(...)`.
pub fn share_env(cmd: &mut Command) {
    let names: Vec<String> = cmd
        .get_envs()
        .filter(|(_, v)| v.is_some())
        .filter_map(|(k, _)| k.to_str().map(str::to_string))
        .collect();
    let existing = std::env::var("WSLENV").ok();
    let value = wslenv(existing.as_deref(), names.iter().map(String::as_str));
    if !value.is_empty() {
        cmd.env("WSLENV", value);
    }
}

/// A command run in `at` through `wsl.exe` (the caller adds its own options and then calls
/// `share_env`). On Windows the process has no console window of its own.
pub fn command(at: &WslPath, program: &str, args: &[String]) -> Command {
    let mut cmd = Command::new("wsl.exe");
    // The browser pane's debugging port is for the IDE's own webviews (D229).
    cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
    cmd.args(wrap_args(at, program, args));
    // A Windows folder to start in: the UNC path isn't a working directory processes accept.
    if let Some(home) = std::env::var_os("USERPROFILE") {
        cmd.current_dir(home);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// The installed distributions (`wsl.exe -l -q`, which answers in UTF-16).
pub fn distros() -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let mut cmd = Command::new("wsl.exe");
    // The browser pane's debugging port is for the IDE's own webviews (D229).
    cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
    cmd.args(["-l", "-q"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    crate::exec::output_within(&mut cmd, std::time::Duration::from_secs(8))
        .map(|(_, out)| parse_distro_list(&out))
        .unwrap_or_default()
}

/// `wsl -l -q` output: UTF-16LE (or UTF-8 with WSL_UTF8=1), one name per line.
pub fn parse_distro_list(bytes: &[u8]) -> Vec<String> {
    let bytes = bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes);
    let text = if bytes.len() >= 2 && bytes.iter().skip(1).step_by(2).take(8).all(|b| *b == 0) {
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    text.lines()
        .map(|l| {
            l.trim()
                .trim_matches('\u{feff}')
                .trim_matches('\0')
                .to_string()
        })
        .filter(|l| !l.is_empty())
        .collect()
}

/// The user's home folder in a distribution (`/home/me`).
pub fn home(distro: &str) -> Option<String> {
    let at = WslPath {
        distro: distro.to_string(),
        linux: "/".into(),
    };
    let mut cmd = command(&at, "sh", &["-c".into(), "printf %s \"$HOME\"".into()]);
    cmd.env_remove("WSLENV");
    let (status, out) = crate::exec::output_within(&mut cmd, std::time::Duration::from_secs(15))?;
    let home = String::from_utf8_lossy(&out).trim().to_string();
    (status.success() && home.starts_with('/')).then_some(home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_into_wsl_are_recognized() {
        let want = WslPath {
            distro: "Ubuntu".into(),
            linux: "/home/me/app".into(),
        };
        assert_eq!(
            parse(r"\\wsl.localhost\Ubuntu\home\me\app"),
            Some(want.clone())
        );
        assert_eq!(parse(r"\\wsl$\Ubuntu\home\me\app"), Some(want.clone()));
        assert_eq!(
            parse(r"\\?\UNC\wsl.localhost\Ubuntu\home\me\app"),
            Some(want.clone())
        );
        assert_eq!(parse("//wsl.localhost/Ubuntu/home/me/app/"), Some(want));
        assert_eq!(
            parse(r"\\wsl.localhost\Debian").map(|p| p.linux),
            Some("/".to_string())
        );
        assert_eq!(parse(r"C:\Users\me"), None);
        assert_eq!(parse(r"\\server\share\x"), None);
        assert_eq!(parse(r"\\wsl.localhost\bad$name\x"), None);
        assert_eq!(
            to_windows("Ubuntu", "/home/me"),
            PathBuf::from(r"\\wsl.localhost\Ubuntu\home\me")
        );
    }

    #[test]
    fn programs_run_inside_the_distribution() {
        let at = WslPath {
            distro: "Ubuntu".into(),
            linux: "/home/me/app".into(),
        };
        assert_eq!(
            wrap_args(&at, "git", &["status".into()]),
            [
                "-d",
                "Ubuntu",
                "--cd",
                "/home/me/app",
                "--exec",
                "git",
                "status"
            ]
        );
    }

    #[test]
    fn the_distribution_list_is_read_in_utf16() {
        let utf16: Vec<u8> = "Ubuntu\r\nDebian\r\n"
            .encode_utf16()
            .flat_map(|u| u.to_le_bytes())
            .collect();
        assert_eq!(parse_distro_list(&utf16), ["Ubuntu", "Debian"]);
        assert_eq!(parse_distro_list(b"Ubuntu\nArch\n"), ["Ubuntu", "Arch"]);
        let bom: Vec<u8> = [0xff, 0xfe]
            .into_iter()
            .chain("Ubuntu\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()))
            .collect();
        assert_eq!(parse_distro_list(&bom), ["Ubuntu"]);
    }

    #[test]
    fn variables_set_for_wsl_are_shared_with_linux() {
        assert_eq!(
            wslenv(Some("FOO/p"), ["GIT_EDITOR", "PATH", "FOO", "TERM"]),
            "FOO/p:GIT_EDITOR/u:TERM/u"
        );
        assert_eq!(wslenv(None, ["GIT_ASKPASS"]), "");
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistro {
    pub name: String,
}

/// The WSL distributions installed (empty off Windows or without WSL).
#[tauri::command]
pub async fn wsl_distros() -> crate::error::Result<Vec<WslDistro>> {
    tauri::async_runtime::spawn_blocking(|| {
        distros()
            .into_iter()
            .map(|name| WslDistro { name })
            .collect()
    })
    .await
    .map_err(|e| crate::error::Error::Invalid(e.to_string()))
}

/// A distribution's home folder as a Windows path (`\\wsl.localhost\Ubuntu\home\me`).
#[tauri::command]
pub async fn wsl_home(distro: String) -> crate::error::Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !distros().contains(&distro) {
            return Err(crate::error::Error::Invalid(format!(
                "No WSL distribution named {distro}."
            )));
        }
        let home = home(&distro).ok_or_else(|| {
            crate::error::Error::Invalid("WSL didn't answer (is it set up?).".into())
        })?;
        Ok(to_windows(&distro, &home).to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| crate::error::Error::Invalid(e.to_string()))?
}
