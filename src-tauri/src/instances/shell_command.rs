//! "Install shell command in PATH" (D209, VS Code's): the command line as `<name>` in new
//! terminals. Windows: a `.cmd` shim in a folder of the app's that is added to the *user* PATH
//! (HKCU\Environment, kept as REG_EXPAND_SZ; the system PATH is never touched), through PowerShell
//! with the value passed in a variable, never on a command line. macOS (VS Code's way): a symlink
//! in `/usr/local/bin`, through the system's administrator prompt (osascript) when that folder
//! needs it, else in `~/.local/bin`. Linux: a symlink in a user bin folder (`~/.local/bin`, else
//! `~/bin` when that one is on PATH). `plan` says what install would do, so the user is asked
//! first. The shim makes `cmd.exe` (and PowerShell through it) wait for the program, so
//! `--help`, `--version` and `--wait` behave there as they do in a Unix shell; the GUI program
//! started on its own isn't waited for by PowerShell (VS Code's `Code.exe` is the same).

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellCommand {
    /// What to type: product.json's short name, lowercase.
    pub name: String,
    /// The shim (Windows) or the link (macOS, Linux).
    pub path: String,
    /// The program it starts.
    pub target: String,
    /// The folder that has to be on PATH.
    pub folder: String,
    pub on_path: bool,
    pub installed: bool,
    /// What install does, step by step (shown before asking).
    pub steps: Vec<String>,
    /// What's left for the user (a folder to add to PATH), if anything.
    pub note: Option<String>,
}

/// The `.cmd` shim: sets the variable that marks a command-line start (client.rs) and runs the
/// app with the arguments. `relative`: the app as a path from the shim's folder (`%~dp0`, which
/// cmd expands itself, so any user name works); else its absolute path, with the console's code
/// page switched to UTF-8 for that one line when the path isn't ASCII, then put back.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn cmd_shim(target: &str, relative: Option<&str>) -> String {
    // In a batch file % starts a variable: doubled, it's a percent sign.
    let escape = |s: &str| s.replace('%', "%%");
    let program = match relative {
        Some(rel) => format!("\"%~dp0{}\"", escape(rel)),
        None => format!("\"{}\"", escape(target)),
    };
    let ascii = relative.is_some() || target.is_ascii();
    let mut out = String::from("@echo off\r\nsetlocal\r\nset \"IDE_CLI=1\"\r\n");
    if ascii {
        out.push_str(&format!("{program} %*\r\n"));
        out.push_str("exit /b %ERRORLEVEL%\r\n");
    } else {
        out.push_str("for /f \"tokens=2 delims=:\" %%a in ('chcp') do set \"IDE_CP=%%a\"\r\n");
        out.push_str("chcp 65001 >nul\r\n");
        out.push_str(&format!("{program} %*\r\n"));
        out.push_str("set \"IDE_RC=%ERRORLEVEL%\"\r\n");
        out.push_str("chcp %IDE_CP% >nul\r\n");
        out.push_str("exit /b %IDE_RC%\r\n");
    }
    out
}

/// A PATH entry the same folder (case and a trailing slash don't matter on Windows).
fn same_entry(a: &str, b: &str, windows: bool) -> bool {
    let norm = |s: &str| {
        let t = s.trim().trim_end_matches(['\\', '/']).to_string();
        if windows {
            t.to_lowercase()
        } else {
            t
        }
    };
    norm(a) == norm(b)
}

/// `old` with `dir` at the end; None when it's there already.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn path_with_entry(old: &str, dir: &str, sep: char) -> Option<String> {
    let windows = sep == ';';
    if old.split(sep).any(|e| same_entry(e, dir, windows)) {
        return None;
    }
    let trimmed = old.trim_end_matches(sep);
    Some(if trimmed.trim().is_empty() {
        dir.to_string()
    } else {
        format!("{trimmed}{sep}{dir}")
    })
}

/// `old` without `dir`; None when it isn't there.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn path_without_entry(old: &str, dir: &str, sep: char) -> Option<String> {
    let windows = sep == ';';
    if !old.split(sep).any(|e| same_entry(e, dir, windows)) {
        return None;
    }
    let kept: Vec<&str> = old
        .split(sep)
        .filter(|e| !same_entry(e, dir, windows) && !e.trim().is_empty())
        .collect();
    Some(kept.join(&sep.to_string()))
}

fn on_process_path(dir: &Path) -> bool {
    let windows = cfg!(windows);
    std::env::var_os("PATH").is_some_and(|p| {
        std::env::split_paths(&p)
            .any(|e| same_entry(&e.to_string_lossy(), &dir.to_string_lossy(), windows))
    })
}

/// The program the command starts: the AppImage itself when the app runs from one (its own path
/// is inside a mount that goes away), else this executable.
fn target_program() -> Result<PathBuf> {
    if let Some(image) = std::env::var_os("APPIMAGE").filter(|v| !v.is_empty()) {
        return Ok(PathBuf::from(image));
    }
    Ok(crate::store::simplify(std::env::current_exe()?))
}

/// What install would do (and whether it's done).
pub fn plan(data_dir: &Path) -> Result<ShellCommand> {
    let name = crate::product_term_program().to_string();
    let target = target_program()?;
    platform::plan(&name, &target, data_dir)
}

pub fn install(data_dir: &Path) -> Result<ShellCommand> {
    let p = plan(data_dir)?;
    platform::install(&p)?;
    plan(data_dir)
}

pub fn uninstall(data_dir: &Path) -> Result<ShellCommand> {
    let p = plan(data_dir)?;
    platform::uninstall(&p)?;
    plan(data_dir)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// A per-user install (under %LOCALAPPDATA%) can have the shim next to the app, as VS Code's
    /// `bin\code.cmd`; elsewhere (Program Files) it goes in the app's data folder.
    fn shim_folder(target: &Path, data_dir: &Path) -> (PathBuf, Option<String>) {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        let exe_dir = target.parent().map(Path::to_path_buf);
        match (local, exe_dir, target.file_name()) {
            (Some(local), Some(dir), Some(file))
                if dir
                    .to_string_lossy()
                    .to_lowercase()
                    .starts_with(&local.to_string_lossy().to_lowercase()) =>
            {
                (
                    dir.join("bin"),
                    Some(format!("..\\{}", file.to_string_lossy())),
                )
            }
            _ => (data_dir.join("bin"), None),
        }
    }

    fn powershell(script: &str, env: &[(&str, &str)]) -> Result<String> {
        let mut cmd = Command::new("powershell.exe");
        // The browser pane's debugging port is for the IDE's own webviews (D229).
        cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let out = cmd.output()?;
        if !out.status.success() {
            return Err(Error::Exec(format!(
                "PowerShell couldn't change the user PATH: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// The user PATH as stored (`%VAR%` references kept).
    fn read_user_path() -> Result<String> {
        powershell(
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); if ($k) { [Console]::Write($k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) }",
            &[],
        )
        .map(|s| s.trim_end_matches(['\r', '\n']).to_string())
    }

    /// Writes the user PATH (REG_EXPAND_SZ) and tells running programs (Explorer, new terminals)
    /// that the environment changed: .NET broadcasts WM_SETTINGCHANGE when a user variable is set.
    fn write_user_path(value: &str) -> Result<()> {
        powershell(
            "$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); $k.SetValue('Path', $env:IDE_NEW_PATH, [Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close(); [Environment]::SetEnvironmentVariable('IDE_ENV_REFRESH', '1', 'User'); [Environment]::SetEnvironmentVariable('IDE_ENV_REFRESH', $null, 'User')",
            &[("IDE_NEW_PATH", value)],
        )
        .map(|_| ())
    }

    pub fn plan(name: &str, target: &Path, data_dir: &Path) -> Result<ShellCommand> {
        let (folder, relative) = shim_folder(target, data_dir);
        let path = folder.join(format!("{name}.cmd"));
        let target_s = target.to_string_lossy().into_owned();
        let on_path = read_user_path()
            .map(|p| {
                p.split(';')
                    .any(|e| same_entry(e, &folder.to_string_lossy(), true))
            })
            .unwrap_or(false)
            || on_process_path(&folder);
        let expected = cmd_shim(&target_s, relative.as_deref());
        let installed = std::fs::read_to_string(&path).is_ok_and(|t| t == expected) && on_path;
        Ok(ShellCommand {
            name: name.to_string(),
            path: path.to_string_lossy().into_owned(),
            target: target_s.clone(),
            folder: folder.to_string_lossy().into_owned(),
            on_path,
            installed,
            steps: vec![
                format!("Write {} (it runs {target_s})", path.to_string_lossy()),
                format!(
                    "Add {} to your user PATH (HKCU\\Environment; the system PATH isn't changed)",
                    folder.to_string_lossy()
                ),
            ],
            note: Some(format!(
                "Open a new terminal to use `{name}` (terminals already open keep their old PATH)."
            )),
        })
    }

    pub fn install(p: &ShellCommand) -> Result<()> {
        let folder = PathBuf::from(&p.folder);
        std::fs::create_dir_all(&folder)?;
        let target = PathBuf::from(&p.target);
        let relative = (folder.parent() == target.parent())
            .then(|| {
                target
                    .file_name()
                    .map(|f| format!("..\\{}", f.to_string_lossy()))
            })
            .flatten();
        crate::store::atomic_write(
            Path::new(&p.path),
            cmd_shim(&p.target, relative.as_deref()).as_bytes(),
        )?;
        let old = read_user_path()?;
        if let Some(new) = path_with_entry(&old, &p.folder, ';') {
            write_user_path(&new)?;
        }
        // This window's terminals get it too.
        if !on_process_path(&folder) {
            let current = std::env::var("PATH").unwrap_or_default();
            if let Some(next) = path_with_entry(&current, &p.folder, ';') {
                std::env::set_var("PATH", next);
            }
        }
        Ok(())
    }

    pub fn uninstall(p: &ShellCommand) -> Result<()> {
        let old = read_user_path()?;
        if let Some(new) = path_without_entry(&old, &p.folder, ';') {
            write_user_path(&new)?;
        }
        match std::fs::remove_file(&p.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

/// `s` as one word for `sh` (single quotes; a quote inside is closed, escaped and reopened).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `s` as an AppleScript string literal.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The AppleScript that runs `script` as root after the system's administrator prompt (VS Code's
/// "Install 'code' command in PATH" does the same through osascript).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn admin_script(script: &str) -> String {
    format!(
        "do shell script {} with administrator privileges",
        applescript_string(script)
    )
}

/// macOS: VS Code's place for the command, on every user's PATH by default.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const SYSTEM_BIN: &str = "/usr/local/bin";

#[cfg(not(windows))]
mod platform {
    use super::*;

    fn home() -> Option<PathBuf> {
        std::env::var_os("HOME").map(PathBuf::from)
    }

    /// Runs `script` as root through the administrator prompt; Err when it's refused or fails.
    #[cfg(target_os = "macos")]
    fn as_admin(script: &str) -> Result<()> {
        let out = std::process::Command::new("/usr/bin/osascript")
            .env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR)
            .arg("-e")
            .arg(admin_script(script))
            .stdin(std::process::Stdio::null())
            .output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(Error::Exec(format!(
                "the administrator prompt was refused or failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )))
        }
    }

    /// Whether `path` is a link to `target`.
    fn links_to(path: &Path, target: &Path) -> bool {
        std::fs::read_link(path).is_ok_and(|t| t == target)
    }

    /// `~/.local/bin`, or `~/bin` when only that one is on PATH.
    fn bin_folder() -> Result<PathBuf> {
        let home = home().ok_or_else(|| Error::Invalid("no home folder".into()))?;
        let local = home.join(".local").join("bin");
        let plain = home.join("bin");
        Ok(if !on_process_path(&local) && on_process_path(&plain) {
            plain
        } else {
            local
        })
    }

    /// The link in the user's own bin folder (Linux; macOS when the administrator prompt is
    /// refused).
    fn user_plan(name: &str, target: &Path) -> Result<ShellCommand> {
        let folder = bin_folder()?;
        let path = folder.join(name);
        let on_path = on_process_path(&folder);
        let installed = links_to(&path, target);
        let folder_s = folder.to_string_lossy().into_owned();
        Ok(ShellCommand {
            name: name.to_string(),
            path: path.to_string_lossy().into_owned(),
            target: target.to_string_lossy().into_owned(),
            folder: folder_s.clone(),
            on_path,
            installed,
            steps: vec![format!(
                "Create the link {} → {}",
                path.to_string_lossy(),
                target.to_string_lossy()
            )],
            note: (!on_path).then(|| {
                format!(
                    "{folder_s} isn't on your PATH: add `export PATH=\"{folder_s}:$PATH\"` to your shell's profile (~/.zshrc, ~/.bashrc)."
                )
            }),
        })
    }

    fn user_install(p: &ShellCommand) -> Result<()> {
        let path = PathBuf::from(&p.path);
        std::fs::create_dir_all(&p.folder)?;
        match std::fs::symlink_metadata(&path) {
            Ok(m) if m.file_type().is_symlink() => std::fs::remove_file(&path)?,
            Ok(_) => {
                return Err(Error::Invalid(format!(
                    "{} is already there and isn't a link this IDE made; remove it first.",
                    p.path
                )))
            }
            Err(_) => {}
        }
        std::os::unix::fs::symlink(&p.target, &path)?;
        Ok(())
    }

    fn user_uninstall(path: &str) -> Result<()> {
        match std::fs::symlink_metadata(path) {
            Ok(m) if m.file_type().is_symlink() => Ok(std::fs::remove_file(path)?),
            Ok(_) => Err(Error::Invalid(format!(
                "{path} isn't a link this IDE made; it was left alone."
            ))),
            Err(_) => Ok(()),
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn plan(name: &str, target: &Path, _data_dir: &Path) -> Result<ShellCommand> {
        user_plan(name, target)
    }

    #[cfg(not(target_os = "macos"))]
    pub fn install(p: &ShellCommand) -> Result<()> {
        user_install(p)
    }

    #[cfg(not(target_os = "macos"))]
    pub fn uninstall(p: &ShellCommand) -> Result<()> {
        user_uninstall(&p.path)
    }

    /// macOS, as VS Code: a link in /usr/local/bin (on PATH for every shell), made with the
    /// administrator prompt when that folder needs it; refused, the link goes in ~/.local/bin.
    /// A link already in ~/.local/bin (an earlier install) is reported as it is.
    #[cfg(target_os = "macos")]
    pub fn plan(name: &str, target: &Path, _data_dir: &Path) -> Result<ShellCommand> {
        let user = user_plan(name, target)?;
        let folder = PathBuf::from(SYSTEM_BIN);
        let path = folder.join(name);
        if user.installed && !links_to(&path, target) {
            return Ok(user);
        }
        let path_s = path.to_string_lossy().into_owned();
        Ok(ShellCommand {
            name: name.to_string(),
            path: path_s.clone(),
            target: target.to_string_lossy().into_owned(),
            folder: SYSTEM_BIN.to_string(),
            on_path: true,
            installed: links_to(&path, target),
            steps: vec![
                format!(
                    "Create the link {path_s} → {} (macOS asks for an administrator password when {SYSTEM_BIN} needs it)",
                    target.to_string_lossy()
                ),
                format!(
                    "If that's refused, create it in {} instead",
                    user.folder
                ),
            ],
            note: None,
        })
    }

    #[cfg(target_os = "macos")]
    pub fn install(p: &ShellCommand) -> Result<()> {
        if p.folder != SYSTEM_BIN {
            return user_install(p);
        }
        let path = PathBuf::from(&p.path);
        let target = PathBuf::from(&p.target);
        // Something else by that name (not a link): left alone, the user folder instead.
        let other_file =
            std::fs::symlink_metadata(&path).is_ok_and(|m| !m.file_type().is_symlink());
        if !other_file {
            let direct = std::fs::create_dir_all(SYSTEM_BIN).and_then(|()| {
                if std::fs::symlink_metadata(&path).is_ok() {
                    std::fs::remove_file(&path)?;
                }
                std::os::unix::fs::symlink(&target, &path)
            });
            if direct.is_ok() {
                return Ok(());
            }
            let script = format!(
                "mkdir -p {dir} && ln -sfn {target} {path}",
                dir = sh_quote(SYSTEM_BIN),
                target = sh_quote(&p.target),
                path = sh_quote(&p.path),
            );
            if as_admin(&script).is_ok() && links_to(&path, &target) {
                return Ok(());
            }
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.name.clone());
        user_install(&user_plan(&name, &target)?)
    }

    #[cfg(target_os = "macos")]
    pub fn uninstall(p: &ShellCommand) -> Result<()> {
        let target = PathBuf::from(&p.target);
        let system = PathBuf::from(SYSTEM_BIN).join(&p.name);
        if links_to(&system, &target) && std::fs::remove_file(&system).is_err() {
            as_admin(&format!("rm -f {}", sh_quote(&system.to_string_lossy())))?;
        }
        let user = user_plan(&p.name, &target)?;
        if links_to(Path::new(&user.path), &target) {
            user_uninstall(&user.path)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_path_entries_are_added_once_and_removed_cleanly() {
        let dir = r"C:\Users\me\AppData\Local\Programs\App\bin";
        assert_eq!(
            path_with_entry(r"%USERPROFILE%\.cargo\bin;C:\Tools;", dir, ';').as_deref(),
            Some(r"%USERPROFILE%\.cargo\bin;C:\Tools;C:\Users\me\AppData\Local\Programs\App\bin")
        );
        assert_eq!(path_with_entry("", dir, ';').as_deref(), Some(dir));
        assert_eq!(
            path_with_entry(&format!("C:\\Tools;{}\\", dir.to_uppercase()), dir, ';'),
            None
        );
        assert_eq!(
            path_without_entry(&format!("C:\\A;{dir};%X%\\b"), dir, ';').as_deref(),
            Some(r"C:\A;%X%\b")
        );
        assert_eq!(path_without_entry(r"C:\A", dir, ';'), None);
        assert_eq!(
            path_with_entry("/usr/bin:/bin", "/home/me/.local/bin", ':').as_deref(),
            Some("/usr/bin:/bin:/home/me/.local/bin")
        );
    }

    #[test]
    fn the_admin_prompt_gets_the_paths_quoted_twice() {
        assert_eq!(sh_quote("/Applications/A b.app"), "'/Applications/A b.app'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(applescript_string(r#"a "b" \c"#), r#""a \"b\" \\c""#);
        let script = format!(
            "ln -sfn {} {}",
            sh_quote("/Applications/O'Neil \"x\".app/Contents/MacOS/app"),
            sh_quote("/usr/local/bin/app")
        );
        let full = admin_script(&script);
        assert!(
            full.starts_with("do shell script \"ln -sfn '/Applications/O'\\\\''Neil \\\"x\\\".app")
        );
        assert!(full.ends_with("'/usr/local/bin/app'\" with administrator privileges"));
    }

    #[test]
    fn the_shim_runs_the_app_with_the_arguments() {
        let shim = cmd_shim(
            r"C:\Users\me\AppData\Local\Programs\App\App.exe",
            Some(r"..\App.exe"),
        );
        assert!(shim.contains("set \"IDE_CLI=1\""));
        assert!(shim.contains("\"%~dp0..\\App.exe\" %*"));
        assert!(!shim.contains("chcp"));
        let odd = cmd_shim(r"C:\Program Files\100% App\App.exe", None);
        assert!(odd.contains("\"C:\\Program Files\\100%% App\\App.exe\" %*"));
        // A name the console's code page can't spell: UTF-8 for that line, then back.
        let unicode = cmd_shim(r"C:\Users\José\AppData\Roaming\x\bin\App.exe", None);
        assert!(unicode.contains("chcp 65001"));
        assert!(unicode.contains("chcp %IDE_CP%"));
        assert!(unicode
            .lines()
            .all(|l| l.is_empty() || l.ends_with('\r') || !l.contains('\n')));
    }
}
