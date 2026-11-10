//! Which shell a terminal starts (split from `mod.rs` in D245): the user's default shell
//! (PowerShell 7, Windows PowerShell or cmd.exe on Windows; the login shell elsewhere), a terminal
//! profile's command with shell integration when its arguments allow it, and a task's variables.

use std::collections::HashMap;
use std::path::PathBuf;

use portable_pty::CommandBuilder;

use super::profiles::{self, ProfileSpec};
use super::{integration, tasks::expand_env};
use crate::error::{Error, Result};

/// The user's default shell: login shell on Unix. On Windows: PowerShell 7 (`pwsh.exe`) if it is
/// on PATH or in its usual install folders, else Windows PowerShell, else `cmd.exe` (`%ComSpec%`).
pub(super) fn default_shell_command() -> (CommandBuilder, String) {
    #[cfg(windows)]
    {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let system_root = std::env::var_os("SystemRoot").map(PathBuf::from);
        let comspec = std::env::var_os("ComSpec").map(PathBuf::from);
        let exists = |p: &std::path::Path| p.is_file();
        let shell = windows_shell(&path, system_root.as_deref(), comspec.as_deref(), &exists);
        let shell = match find_pwsh() {
            Some(pwsh) if !shell.program.ends_with("pwsh.exe") => ShellChoice {
                program: pwsh,
                args: vec!["-NoLogo".to_string()],
            },
            _ => shell,
        };
        let mut cmd = CommandBuilder::new(&shell.program);
        for arg in &shell.args {
            cmd.arg(arg);
        }
        (cmd, shell.program.to_string_lossy().into_owned())
    }
    #[cfg(not(windows))]
    {
        let cmd = CommandBuilder::new_default_prog();
        let shell = cmd.get_shell();
        (cmd, shell)
    }
}

/// A terminal profile's command (VS Code's `terminal.integrated.profiles.*`): its program, with
/// shell integration when its arguments allow it (none, or login / interactive flags), else
/// exactly as configured. Returns the command, the program and whether integration loads.
pub(super) fn profile_command(
    spec: &ProfileSpec,
    integration_dir: Option<&std::path::Path>,
) -> Result<(CommandBuilder, String, bool)> {
    let exists = |p: &std::path::Path| p.is_file();
    let program =
        profiles::resolve_program(&spec.path, &profiles::path_dirs(), cfg!(windows), &exists)
            .ok_or_else(|| {
                Error::Pty(format!(
                    "The terminal profile's shell wasn't found: {}",
                    spec.path.join(", ")
                ))
            })?;
    let shell = program.to_string_lossy().into_owned();
    let args: Vec<String> = spec
        .args
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|a| expand_env(a))
        .collect();
    let kind = integration::shell_kind(&shell);
    // No arguments given: the shell's usual start (None); given: only flags the scripts keep.
    let flags = spec
        .args
        .is_some()
        .then(|| integration::integration_flags(kind, &args))
        .flatten();
    // Integration when the arguments are ones it can keep (or there are none).
    let integrated = match (integration_dir, spec.args.is_none() || flags.is_some()) {
        (Some(dir), true) => integration::command_with_integration(&shell, dir, flags)
            .ok()
            .flatten(),
        _ => None,
    };
    let integration = integrated.is_some();
    let mut cmd = integrated.unwrap_or_else(|| {
        let mut cmd = CommandBuilder::new(&program);
        for arg in &args {
            cmd.arg(arg);
        }
        cmd
    });
    for (key, value) in &spec.env {
        match value {
            Some(v) => cmd.env(key, expand_env(v)),
            None => cmd.env_remove(key),
        }
    }
    Ok((cmd, shell, integration))
}

/// A task's variables: set, or removed where the value is null.
pub(super) fn apply_run_env(cmd: &mut CommandBuilder, env: &HashMap<String, Option<String>>) {
    for (key, value) in env {
        match value {
            Some(v) => cmd.env(key, expand_env(v)),
            None => cmd.env_remove(key),
        }
    }
}

/// PowerShell 7 when it isn't on PATH: its install folders (MSI, preview) and the Store's alias
/// (%LOCALAPPDATA%\Microsoft\WindowsApps). It has `&&` / `||`; Windows PowerShell 5.1 doesn't.
#[cfg(windows)]
pub fn find_pwsh() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join("pwsh.exe"))
                .collect()
        })
        .unwrap_or_default();
    for var in ["ProgramFiles", "ProgramW6432"] {
        if let Some(root) = std::env::var_os(var).map(PathBuf::from) {
            candidates.push(root.join(r"PowerShell\7\pwsh.exe"));
            candidates.push(root.join(r"PowerShell\7-preview\pwsh.exe"));
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        candidates.push(local.join(r"Microsoft\WindowsApps\pwsh.exe"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// A shell to start: program path and arguments.
#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct ShellChoice {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Windows shell selection, pure for testing: pwsh.exe on PATH → Windows PowerShell →
/// `%ComSpec%` → `cmd.exe`. `path` uses `;` separators.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn windows_shell(
    path: &std::ffi::OsStr,
    system_root: Option<&std::path::Path>,
    comspec: Option<&std::path::Path>,
    exists: &dyn Fn(&std::path::Path) -> bool,
) -> ShellChoice {
    let no_logo = || vec!["-NoLogo".to_string()];
    let dirs: Vec<PathBuf> = path
        .to_string_lossy()
        .split(';')
        .filter(|d| !d.trim().is_empty())
        .map(|d| PathBuf::from(d.trim().trim_matches('"')))
        .collect();
    if let Some(pwsh) = dirs.iter().map(|d| d.join("pwsh.exe")).find(|p| exists(p)) {
        return ShellChoice {
            program: pwsh,
            args: no_logo(),
        };
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(root) = system_root {
        candidates.push(root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"));
    }
    candidates.extend(dirs.iter().map(|d| d.join("powershell.exe")));
    if let Some(ps) = candidates.into_iter().find(|p| exists(p)) {
        return ShellChoice {
            program: ps,
            args: no_logo(),
        };
    }
    let cmd = comspec
        .map(std::path::Path::to_path_buf)
        .filter(|p| exists(p))
        .unwrap_or_else(|| PathBuf::from("cmd.exe"));
    ShellChoice {
        program: cmd,
        args: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::path::Path;

    #[test]
    fn windows_shell_prefers_pwsh_then_powershell_then_cmd() {
        let root = Path::new("C:/Windows");
        let ps = root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
        let pwsh = Path::new("C:/Program Files/PowerShell/7").join("pwsh.exe");
        let comspec = root.join("cmd.exe");
        let path = OsStr::new(r#""C:/Program Files/PowerShell/7";C:/Windows;;"#);

        let all = |p: &Path| p == pwsh || p == ps || p == comspec;
        let choice = windows_shell(path, Some(root), Some(&comspec), &all);
        assert_eq!(choice.program, pwsh);
        assert_eq!(choice.args, vec!["-NoLogo".to_string()]);

        let no_pwsh = |p: &Path| p == ps || p == comspec;
        assert_eq!(
            windows_shell(path, Some(root), Some(&comspec), &no_pwsh).program,
            ps
        );

        let only_cmd = |p: &Path| p == comspec;
        let choice = windows_shell(path, Some(root), Some(&comspec), &only_cmd);
        assert_eq!(choice.program, comspec);
        assert!(choice.args.is_empty());

        let nothing = |_: &Path| false;
        assert_eq!(
            windows_shell(path, None, None, &nothing).program,
            PathBuf::from("cmd.exe")
        );
    }
}
