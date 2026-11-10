//! The user's aliases and functions for the terminal's command suggestions (D229, as VS Code's
//! terminal suggest lists them): the shell is asked once, the way it starts in a terminal (its rc
//! files / profile read), and prints them after a marker line; the frontend parses the text
//! (`suggest.ts` `parseShellGlobals`, tested). A shell that takes too long is killed.

use std::process::Command;
use std::time::Duration;

/// Printed before the aliases (and before the functions): what an rc file prints is skipped.
pub const MARK: &str = "--shell-globals--";
const DEADLINE: Duration = Duration::from_secs(5);

/// The family of a shell program, as the suggestions know them.
fn family(shell: &str) -> Option<&'static str> {
    let file = shell
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(shell)
        .to_lowercase();
    match file.strip_suffix(".exe").unwrap_or(&file) {
        "pwsh" | "powershell" => Some("pwsh"),
        "bash" | "sh" => Some("bash"),
        "zsh" => Some("zsh"),
        "fish" => Some("fish"),
        _ => None,
    }
}

/// The arguments that make `shell` print its aliases and functions; None for a shell without
/// any we can read (cmd's doskey macros live in its own session only).
pub fn probe_args(shell: &str) -> Option<Vec<String>> {
    let script = match family(shell)? {
        "pwsh" => {
            return Some(vec![
                "-NoLogo".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                format!(
                    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; '{MARK}'; \
                     Get-Command -CommandType Alias,Function -ErrorAction SilentlyContinue | \
                     ForEach-Object {{ $d = ([string]$_.Definition -replace '\\s+', ' ').Trim(); \
                     if ($d.Length -gt 200) {{ $d = $d.Substring(0, 200) }}; \
                     \"$($_.CommandType)`t$($_.Name)`t$d\" }}"
                ),
            ]);
        }
        "bash" => format!("echo '{MARK}'; alias; echo '{MARK}'; compgen -A function"),
        "zsh" => format!("echo '{MARK}'; alias; echo '{MARK}'; print -rl -- ${{(k)functions}}"),
        "fish" => format!("echo '{MARK}'; alias; echo '{MARK}'; functions -n"),
        _ => return None,
    };
    // Interactive, so the rc file that defines them is read (as in a terminal).
    Some(vec!["-i".into(), "-c".into(), script])
}

/// What the shell printed from the first marker on (empty when it can't be asked or fails).
pub fn shell_globals(shell: &str) -> String {
    let Some(args) = probe_args(shell) else {
        return String::new();
    };
    let mut cmd = Command::new(shell);
    cmd.args(&args);
    // Not the IDE's debugging port, and no window for a console program (Windows).
    cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Some((_, out)) = crate::exec::output_within(&mut cmd, DEADLINE) else {
        return String::new();
    };
    let text = String::from_utf8_lossy(&out);
    match text.find(MARK) {
        Some(at) => text[at..].to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_by_shell() {
        assert!(probe_args("C:\\Windows\\System32\\cmd.exe").is_none());
        assert!(probe_args("wsl · Ubuntu").is_none());
        let bash = probe_args("/usr/bin/bash").unwrap_or_default();
        assert_eq!(bash[..2], ["-i", "-c"]);
        assert!(bash[2].contains("compgen -A function"));
        let pwsh = probe_args("C:\\Program Files\\PowerShell\\7\\pwsh.exe").unwrap_or_default();
        assert_eq!(pwsh[2], "-Command");
        assert!(pwsh[3].contains("Get-Command -CommandType Alias,Function"));
        assert!(pwsh[3].contains("-replace '\\s+'"));
        assert!(probe_args("zsh").unwrap_or_default()[2].contains("(k)functions"));
    }
}
