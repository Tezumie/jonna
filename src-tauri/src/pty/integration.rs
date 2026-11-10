//! Shell integration setup: the scripts in `scripts/` are written to the app's data folder and the
//! shell is started so it loads them after the user's own startup files (bash `--init-file`, zsh
//! via `ZDOTDIR`, fish `--init-command`, PowerShell `-NoExit -Command`). Other shells (cmd, sh,
//! nu…) start unchanged.

use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

use crate::error::Result;
use crate::store::atomic_write;

const BASH: &str = include_str!("scripts/bash.sh");
const ZSHRC: &str = include_str!("scripts/zshrc.zsh");
const FISH: &str = include_str!("scripts/fish.fish");
const PWSH: &str = include_str!("scripts/pwsh.ps1");

/// zsh startup files besides .zshrc: each sources the user's own file from their ZDOTDIR.
const ZSH_PASSTHROUGH: &[&str] = &[".zshenv", ".zprofile", ".zlogin"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Bash,
    Zsh,
    Fish,
    Pwsh,
    Other,
}

/// Recognizes the shell from its program path ("/bin/zsh", "C:\\…\\pwsh.exe", "powershell.exe").
pub fn shell_kind(program: &str) -> ShellKind {
    // Split on both separators: the same code reads Windows paths in tests on any OS.
    let file = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_lowercase();
    let name = file.strip_suffix(".exe").unwrap_or(&file);
    match name.trim_start_matches('-') {
        "bash" => ShellKind::Bash,
        "zsh" => ShellKind::Zsh,
        "fish" => ShellKind::Fish,
        "pwsh" | "powershell" => ShellKind::Pwsh,
        _ => ShellKind::Other,
    }
}

fn write_if_changed(path: &Path, content: &str) -> Result<()> {
    if std::fs::read_to_string(path).ok().as_deref() != Some(content) {
        atomic_write(path, content.as_bytes())?;
    }
    Ok(())
}

/// What a profile's own arguments ask for, when the IDE can still load its integration with them
/// (VS Code does the same: only arguments it knows are safe to combine).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ShellFlags {
    /// `-l` / `--login`: a login shell (Git Bash's `--login -i`).
    pub login: bool,
    /// PowerShell's `-NoProfile`.
    pub no_profile: bool,
}

/// The flags in a profile's `args` when every one of them is one the integration can keep;
/// None when there's another (the profile then starts exactly as given, without integration).
pub fn integration_flags(kind: ShellKind, args: &[String]) -> Option<ShellFlags> {
    let mut flags = ShellFlags::default();
    for arg in args {
        let a = arg.trim();
        match kind {
            ShellKind::Bash | ShellKind::Zsh | ShellKind::Fish => match a {
                "-l" | "--login" => flags.login = true,
                "-i" | "--interactive" => {}
                _ => return None,
            },
            ShellKind::Pwsh => match a.to_ascii_lowercase().as_str() {
                "-nologo" | "-nol" => {}
                "-noprofile" | "-nop" => flags.no_profile = true,
                "-login" | "-l" => flags.login = true,
                _ => return None,
            },
            ShellKind::Other => return None,
        }
    }
    Some(flags)
}

/// WSL's launcher (`C:\Windows\System32\bash.exe`) is called bash too, but runs Linux: the
/// scripts (Windows paths) can't load there.
fn is_wsl_launcher(program: &str) -> bool {
    let lower = program.replace('/', "\\").to_lowercase();
    lower.ends_with("\\system32\\bash.exe") || lower.ends_with("\\sysnative\\bash.exe")
}

/// A Windows bash (Git Bash, MSYS2, Cygwin): its `$PWD` is a POSIX path like `/c/Users/me`.
pub fn is_windows_bash(program: &str) -> bool {
    shell_kind(program) == ShellKind::Bash
        && (program.contains('\\') || program.get(1..3) == Some(":/") || program.ends_with(".exe"))
        && !is_wsl_launcher(program)
}

/// Builds the command for `program` with integration loaded from `dir` (created if needed).
/// Returns None for shells without integration (the caller keeps its own command). `flags`:
/// what a profile's arguments asked for (None: the platform's usual way to start the shell).
pub fn command_with_integration(
    program: &str,
    dir: &Path,
    flags: Option<ShellFlags>,
) -> Result<Option<CommandBuilder>> {
    let kind = shell_kind(program);
    if kind == ShellKind::Other || is_wsl_launcher(program) {
        return Ok(None);
    }
    let login = flags.map_or(cfg!(target_os = "macos"), |f| f.login);
    std::fs::create_dir_all(dir)?;
    let mut cmd = CommandBuilder::new(program);
    match kind {
        ShellKind::Bash => {
            let script = dir.join("bash.sh");
            write_if_changed(&script, BASH)?;
            cmd.arg("--init-file");
            if is_windows_bash(program) {
                // Git Bash reads `C:/…/bash.sh` reliably; backslashes are escapes to it.
                cmd.arg(script.to_string_lossy().replace('\\', "/"));
                // MSYS2's /etc/profile goes to $HOME unless told the folder was chosen.
                cmd.env("CHERE_INVOKING", "1");
            } else {
                cmd.arg(&script);
            }
            cmd.arg("-i");
            if login {
                cmd.env("IDE_SHELL_LOGIN", "1");
            }
        }
        ShellKind::Zsh => {
            let zdot = dir.join("zsh");
            std::fs::create_dir_all(&zdot)?;
            write_if_changed(&zdot.join(".zshrc"), ZSHRC)?;
            for name in ZSH_PASSTHROUGH {
                let body = format!(
                    "# Runs the user's {name}, then restores the IDE's ZDOTDIR for the next file.\n\
                     __ide_zdot=\"$ZDOTDIR\"; ZDOTDIR=\"${{IDE_USER_ZDOTDIR:-$HOME}}\"\n\
                     [ -r \"$ZDOTDIR/{name}\" ] && . \"$ZDOTDIR/{name}\"\n\
                     ZDOTDIR=\"$__ide_zdot\"; unset __ide_zdot\n"
                );
                write_if_changed(&zdot.join(name), &body)?;
            }
            let user = std::env::var_os("ZDOTDIR")
                .or_else(|| std::env::var_os("HOME"))
                .unwrap_or_default();
            cmd.env("IDE_USER_ZDOTDIR", user);
            cmd.env("ZDOTDIR", &zdot);
            if login {
                cmd.arg("-l");
            }
            cmd.arg("-i");
        }
        ShellKind::Fish => {
            let script = dir.join("integration.fish");
            write_if_changed(&script, FISH)?;
            if flags.is_some_and(|f| f.login) {
                cmd.arg("-l");
            }
            cmd.arg("--init-command");
            cmd.arg(format!(
                "source '{}'",
                script.to_string_lossy().replace('\'', "\\'")
            ));
        }
        ShellKind::Pwsh => {
            let script = dir.join("integration.ps1");
            write_if_changed(&script, PWSH)?;
            if flags.is_some_and(|f| f.login) {
                // -Login must come first (PowerShell 7 on macOS and Linux).
                cmd.arg("-Login");
            }
            cmd.arg("-NoLogo");
            if flags.is_some_and(|f| f.no_profile) {
                cmd.arg("-NoProfile");
            }
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            // In try/catch: under a Restricted execution policy the script can't load, and the
            // shell should just start without integration rather than print an error each time.
            cmd.arg(format!(
                "try {{ . '{}' }} catch {{}}",
                script.to_string_lossy().replace('\'', "''")
            ));
        }
        ShellKind::Other => {}
    }
    Ok(Some(cmd))
}

/// Where the scripts go: `<app data>/shell-integration`.
pub fn integration_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("shell-integration")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_shells() {
        assert_eq!(shell_kind("/bin/bash"), ShellKind::Bash);
        assert_eq!(shell_kind("-zsh"), ShellKind::Zsh);
        assert_eq!(
            shell_kind(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            ShellKind::Pwsh
        );
        assert_eq!(shell_kind("powershell.exe"), ShellKind::Pwsh);
        assert_eq!(shell_kind("/usr/bin/fish"), ShellKind::Fish);
        assert_eq!(shell_kind("cmd.exe"), ShellKind::Other);
    }

    #[test]
    fn writes_scripts_once() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("ide-shell-int-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(command_with_integration("/bin/bash", &dir, None)?.is_some());
        assert!(dir.join("bash.sh").is_file());
        assert!(command_with_integration("/bin/zsh", &dir, None)?.is_some());
        assert!(dir.join("zsh/.zshrc").is_file() && dir.join("zsh/.zprofile").is_file());
        assert!(command_with_integration("/bin/sh", &dir, None)?.is_none());
        let login = command_with_integration(
            "/bin/zsh",
            &dir,
            Some(ShellFlags {
                login: true,
                no_profile: false,
            }),
        )?
        .ok_or_else(|| crate::error::Error::Pty("no command".into()))?;
        assert!(login.get_argv().iter().any(|a| a == "-l"));
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn profile_args_the_integration_can_keep() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            integration_flags(ShellKind::Bash, &args(&["--login", "-i"])),
            Some(ShellFlags {
                login: true,
                no_profile: false
            })
        );
        assert_eq!(
            integration_flags(ShellKind::Bash, &[]),
            Some(ShellFlags::default())
        );
        assert_eq!(
            integration_flags(ShellKind::Bash, &args(&["-c", "x"])),
            None
        );
        assert_eq!(
            integration_flags(ShellKind::Pwsh, &args(&["-NoLogo", "-NoProfile"])),
            Some(ShellFlags {
                login: false,
                no_profile: true
            })
        );
        assert_eq!(
            integration_flags(ShellKind::Pwsh, &args(&["-File", "x.ps1"])),
            None
        );
        assert!(is_windows_bash(r"C:\Program Files\Git\bin\bash.exe"));
        assert!(!is_windows_bash(r"C:\Windows\System32\bash.exe"));
        assert!(!is_windows_bash("/bin/bash"));
    }
}
