//! Terminal profiles (VS Code's `terminal.integrated.profiles.*`): the shells installed on this
//! machine, found the way VS Code finds them. Windows: PowerShell 7, Windows PowerShell, Command
//! Prompt, Git Bash (registry, install folders, `git.exe` on PATH), Cygwin and the WSL
//! distributions (`wsl.exe -l -q`). macOS and Linux: the shells listed in `/etc/shells`. The
//! frontend merges them with the user's own profiles (settings) and picks the one to start; the
//! launch itself is a [`ProfileSpec`]. The parsing and choosing are pure and tested.
// The Windows half is only called on Windows (and in the tests everywhere).
#![cfg_attr(not(windows), allow(dead_code))]

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A shell found on this machine.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedProfile {
    pub name: String,
    pub path: String,
    pub args: Vec<String>,
    /// The VS Code `source` this profile answers to ("PowerShell", "Git Bash"), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// A hint for the tab icon: "powershell", "cmd", "bash", "linux" or "terminal".
    pub icon: String,
}

/// A profile to start (from the frontend, which merged settings and detected shells).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSpec {
    /// Candidate programs, the first one that exists wins (VS Code takes a list too). Each may
    /// use `${env:NAME}`; a bare name is looked up on PATH.
    pub path: Vec<String>,
    /// Arguments; None leaves the IDE's own (shell integration, login flags).
    pub args: Option<Vec<String>>,
    /// Extra environment; a null value removes the variable (VS Code's semantics).
    #[serde(default)]
    pub env: HashMap<String, Option<String>>,
}

// The macOS / Linux half (below, to `WindowsEnv`) is only called there (and in tests).
#[cfg_attr(windows, allow(dead_code))]
fn file_name(path: &str) -> String {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    file.strip_suffix(".exe")
        .or_else(|| file.strip_suffix(".EXE"))
        .unwrap_or(file)
        .to_string()
}

/// Shells in `/etc/shells` that aren't for logging in interactively.
#[cfg_attr(windows, allow(dead_code))]
const NOT_SHELLS: &[&str] = &["nologin", "false", "git-shell", "rbash", "screen", "true"];

/// The shell paths listed in `/etc/shells` (comments and blank lines skipped).
#[cfg_attr(windows, allow(dead_code))]
pub fn parse_etc_shells(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| l.split('#').next().unwrap_or("").trim())
        .filter(|l| l.starts_with('/'))
        .filter(|l| !NOT_SHELLS.contains(&file_name(l).as_str()))
        .map(str::to_string)
        .collect()
}

/// macOS / Linux profiles: one per shell name (`/bin/bash` and `/usr/bin/bash` are one), the
/// login shell's own path when it's listed under several, in `/etc/shells` order.
#[cfg_attr(windows, allow(dead_code))]
pub fn unix_profiles(
    shells: &[String],
    login_shell: Option<&str>,
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<DetectedProfile> {
    let mut out: Vec<DetectedProfile> = Vec::new();
    let mut all: Vec<&str> = shells.iter().map(String::as_str).collect();
    if let Some(login) = login_shell.filter(|s| s.starts_with('/')) {
        if !all.contains(&login) {
            all.insert(0, login);
        }
    }
    for path in all {
        if !exists(Path::new(path)) {
            continue;
        }
        let name = file_name(path);
        if let Some(seen) = out.iter_mut().find(|p| p.name == name) {
            if login_shell == Some(path) {
                seen.path = path.to_string();
            }
            continue;
        }
        let icon = match name.as_str() {
            "pwsh" => "powershell",
            "bash" | "zsh" | "fish" | "sh" | "dash" | "ksh" | "tcsh" | "csh" => "bash",
            _ => "terminal",
        };
        out.push(DetectedProfile {
            name,
            path: path.to_string(),
            args: Vec::new(),
            source: None,
            icon: icon.into(),
        });
    }
    out
}

/// Where Windows keeps things, read from the environment (and the registry for Git).
#[derive(Debug, Default, Clone)]
pub struct WindowsEnv {
    pub system_root: Option<PathBuf>,
    /// `ProgramW6432`, `ProgramFiles`, `ProgramFiles(x86)` (duplicates are fine).
    pub program_files: Vec<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub user_profile: Option<PathBuf>,
    pub path_dirs: Vec<PathBuf>,
    /// Git for Windows' `InstallPath` (HKLM / HKCU `SOFTWARE\GitForWindows`).
    pub git_install: Option<PathBuf>,
}

/// Joins a Windows path with `\`-separated parts (tests run this on any OS).
fn wjoin(base: &Path, rel: &str) -> PathBuf {
    let mut p = base.to_path_buf();
    for part in rel.split('\\') {
        p.push(part);
    }
    p
}

fn first(candidates: Vec<PathBuf>, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.into_iter().find(|p| exists(p))
}

/// PowerShell 7 (`pwsh.exe`): PATH, its install folders (MSI, preview), the Store's alias and a
/// .NET global tool.
pub fn find_pwsh_in(env: &WindowsEnv, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    let mut c: Vec<PathBuf> = env.path_dirs.iter().map(|d| d.join("pwsh.exe")).collect();
    for root in &env.program_files {
        c.push(wjoin(root, r"PowerShell\7\pwsh.exe"));
        c.push(wjoin(root, r"PowerShell\7-preview\pwsh.exe"));
    }
    if let Some(local) = &env.local_app_data {
        c.push(wjoin(local, r"Microsoft\WindowsApps\pwsh.exe"));
    }
    if let Some(home) = &env.user_profile {
        c.push(wjoin(home, r".dotnet\tools\pwsh.exe"));
    }
    first(c, exists)
}

/// Git for Windows' bash: the registry's install folder, the usual install folders, Scoop, and
/// next to a `git.exe` on PATH (`Git\cmd\git.exe` → `Git\bin\bash.exe`).
pub fn find_git_bash(env: &WindowsEnv, exists: &dyn Fn(&Path) -> bool) -> Option<PathBuf> {
    let mut c: Vec<PathBuf> = Vec::new();
    if let Some(dir) = &env.git_install {
        c.push(wjoin(dir, r"bin\bash.exe"));
    }
    for root in &env.program_files {
        c.push(wjoin(root, r"Git\bin\bash.exe"));
    }
    if let Some(local) = &env.local_app_data {
        c.push(wjoin(local, r"Programs\Git\bin\bash.exe"));
    }
    if let Some(home) = &env.user_profile {
        c.push(wjoin(home, r"scoop\apps\git\current\bin\bash.exe"));
        c.push(wjoin(
            home,
            r"scoop\apps\git-with-openssh\current\bin\bash.exe",
        ));
    }
    for dir in &env.path_dirs {
        if exists(&dir.join("git.exe")) {
            if let Some(parent) = dir.parent() {
                c.push(wjoin(parent, r"bin\bash.exe"));
                if let Some(grand) = parent.parent() {
                    c.push(wjoin(grand, r"bin\bash.exe"));
                }
            }
        }
    }
    first(c, exists)
}

/// The Windows profiles VS Code detects, in its order.
pub fn windows_profiles(
    env: &WindowsEnv,
    exists: &dyn Fn(&Path) -> bool,
    wsl_distros: &[String],
) -> Vec<DetectedProfile> {
    let profile = |name: &str, path: &Path, args: &[&str], source: Option<&str>, icon: &str| {
        DetectedProfile {
            name: name.into(),
            path: path.to_string_lossy().into_owned(),
            args: args.iter().map(|a| a.to_string()).collect(),
            source: source.map(str::to_string),
            icon: icon.into(),
        }
    };
    let mut out = Vec::new();
    if let Some(pwsh) = find_pwsh_in(env, exists) {
        out.push(profile(
            "PowerShell",
            &pwsh,
            &["-NoLogo"],
            Some("PowerShell"),
            "powershell",
        ));
    }
    let root = env.system_root.as_deref();
    if let Some(ps) = root
        .map(|r| wjoin(r, r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .filter(|p| exists(p))
    {
        // Without PowerShell 7 this one is what source "PowerShell" means.
        let source = (!out.iter().any(|p| p.name == "PowerShell")).then_some("PowerShell");
        out.push(profile(
            "Windows PowerShell",
            &ps,
            &["-NoLogo"],
            source,
            "powershell",
        ));
    }
    if let Some(bash) = find_git_bash(env, exists) {
        out.push(profile(
            "Git Bash",
            &bash,
            &["--login", "-i"],
            Some("Git Bash"),
            "bash",
        ));
    }
    if let Some(cmd) = root
        .map(|r| wjoin(r, r"System32\cmd.exe"))
        .filter(|p| exists(p))
    {
        out.push(profile("Command Prompt", &cmd, &[], None, "cmd"));
    }
    for drive in ["C:\\cygwin64", "C:\\cygwin"] {
        let bash = wjoin(Path::new(drive), r"bin\bash.exe");
        if exists(&bash) {
            out.push(profile("Cygwin", &bash, &["--login"], None, "bash"));
            break;
        }
    }
    if let Some(wsl) = root
        .map(|r| wjoin(r, r"System32\wsl.exe"))
        .filter(|p| exists(p))
    {
        for distro in wsl_distros {
            // Docker Desktop's own distributions aren't for logging in (VS Code hides them too).
            if distro.starts_with("docker-desktop") {
                continue;
            }
            out.push(profile(
                &format!("{distro} (WSL)"),
                &wsl,
                &["-d", distro],
                None,
                "linux",
            ));
        }
    }
    out
}

/// A value from `reg query <key> /v <name>` output ("    InstallPath    REG_SZ    C:\Git").
pub fn parse_reg_value(text: &str, name: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let line = line.trim();
        let rest = line.strip_prefix(name)?;
        let rest = rest.trim_start();
        let (_kind, value) = rest.split_once("REG_")?;
        let value = value.split_once(char::is_whitespace)?.1.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

/// The program a profile starts: the first candidate that exists, `${env:…}` expanded; a bare
/// name (`bash`, `pwsh`) is looked up in `path_dirs` (with `.exe` on Windows).
pub fn resolve_program(
    candidates: &[String],
    path_dirs: &[PathBuf],
    windows: bool,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    for raw in candidates {
        let expanded = super::expand_env(raw.trim());
        if expanded.is_empty() {
            continue;
        }
        let bare = !expanded.contains(['/', '\\']);
        if !bare {
            let p = PathBuf::from(&expanded);
            if exists(&p) {
                return Some(p);
            }
            continue;
        }
        let names: Vec<String> = if windows && !expanded.to_lowercase().ends_with(".exe") {
            vec![format!("{expanded}.exe"), expanded.clone()]
        } else {
            vec![expanded.clone()]
        };
        for dir in path_dirs {
            for name in &names {
                let p = dir.join(name);
                if exists(&p) {
                    return Some(p);
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn registry_git_install() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    for hive in ["HKLM", "HKCU"] {
        let mut cmd = std::process::Command::new("reg");
        // The browser pane's debugging port is for the IDE's own webviews (D229).
        cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        cmd.args([
            "query",
            &format!(r"{hive}\SOFTWARE\GitForWindows"),
            "/v",
            "InstallPath",
        ]);
        cmd.creation_flags(0x0800_0000);
        let Some((_, out)) =
            crate::exec::output_within(&mut cmd, std::time::Duration::from_secs(3))
        else {
            continue;
        };
        if let Some(v) = parse_reg_value(&String::from_utf8_lossy(&out), "InstallPath") {
            return Some(PathBuf::from(v));
        }
    }
    None
}

/// The directories of PATH.
pub fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default()
}

/// The shells installed on this machine (runs `wsl.exe` and `reg` on Windows: call off the main
/// thread).
pub fn detect() -> Vec<DetectedProfile> {
    let exists = |p: &Path| p.is_file();
    #[cfg(windows)]
    {
        let var = |name: &str| std::env::var_os(name).map(PathBuf::from);
        let env = WindowsEnv {
            system_root: var("SystemRoot").or_else(|| var("windir")),
            program_files: ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"]
                .iter()
                .copied()
                .filter_map(var)
                .collect(),
            local_app_data: var("LOCALAPPDATA"),
            user_profile: var("USERPROFILE"),
            path_dirs: path_dirs(),
            git_install: registry_git_install(),
        };
        windows_profiles(&env, &exists, &crate::wsl::distros())
    }
    #[cfg(not(windows))]
    {
        let shells = std::fs::read_to_string("/etc/shells")
            .map(|t| parse_etc_shells(&t))
            .unwrap_or_default();
        let login = std::env::var("SHELL").ok();
        unix_profiles(&shells, login.as_deref(), &exists)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etc_shells_one_profile_per_name() {
        let text = "# /etc/shells: valid login shells\n/bin/sh\n/bin/bash\n/usr/bin/bash\n\
                    /usr/sbin/nologin\n/bin/rbash\n/usr/bin/zsh # zsh\n\n/usr/bin/fish\n/usr/bin/tmux\n";
        let shells = parse_etc_shells(text);
        assert_eq!(
            shells,
            [
                "/bin/sh",
                "/bin/bash",
                "/usr/bin/bash",
                "/usr/bin/zsh",
                "/usr/bin/fish",
                "/usr/bin/tmux"
            ]
        );
        let present = |p: &Path| p != Path::new("/usr/bin/fish");
        let profiles = unix_profiles(&shells, Some("/usr/bin/bash"), &present);
        let names: Vec<&str> = profiles.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["sh", "bash", "zsh", "tmux"]);
        // The login shell's own path wins when the name is listed twice.
        assert_eq!(profiles[1].path, "/usr/bin/bash");
        assert_eq!(profiles[1].icon, "bash");
        assert_eq!(profiles[3].icon, "terminal");
    }

    fn win_env() -> WindowsEnv {
        WindowsEnv {
            system_root: Some(PathBuf::from("C:/Windows")),
            program_files: vec![PathBuf::from("C:/Program Files")],
            local_app_data: Some(PathBuf::from("C:/Users/me/AppData/Local")),
            user_profile: Some(PathBuf::from("C:/Users/me")),
            path_dirs: vec![PathBuf::from("D:/tools/Git/cmd")],
            git_install: None,
        }
    }

    #[test]
    fn windows_profiles_in_vs_code_order() {
        let env = win_env();
        let have = [
            wjoin(Path::new("C:/Program Files"), r"PowerShell\7\pwsh.exe"),
            wjoin(
                Path::new("C:/Windows"),
                r"System32\WindowsPowerShell\v1.0\powershell.exe",
            ),
            wjoin(Path::new("C:/Windows"), r"System32\cmd.exe"),
            wjoin(Path::new("C:/Windows"), r"System32\wsl.exe"),
            PathBuf::from("D:/tools/Git/cmd").join("git.exe"),
            wjoin(Path::new("D:/tools/Git"), r"bin\bash.exe"),
        ];
        let exists = |p: &Path| have.iter().any(|h| h == p);
        let distros = vec!["Ubuntu".to_string(), "docker-desktop".to_string()];
        let profiles = windows_profiles(&env, &exists, &distros);
        let names: Vec<&str> = profiles.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "PowerShell",
                "Windows PowerShell",
                "Git Bash",
                "Command Prompt",
                "Ubuntu (WSL)"
            ]
        );
        assert_eq!(profiles[0].source.as_deref(), Some("PowerShell"));
        // PowerShell 7 is there: Windows PowerShell isn't what source "PowerShell" means.
        assert_eq!(profiles[1].source, None);
        assert_eq!(profiles[2].args, ["--login", "-i"]);
        assert_eq!(profiles[2].source.as_deref(), Some("Git Bash"));
        assert_eq!(profiles[4].args, ["-d", "Ubuntu"]);

        // Only Windows PowerShell and the registry's Git.
        let env = WindowsEnv {
            git_install: Some(PathBuf::from("E:/Git")),
            path_dirs: Vec::new(),
            ..win_env()
        };
        let have = [
            wjoin(
                Path::new("C:/Windows"),
                r"System32\WindowsPowerShell\v1.0\powershell.exe",
            ),
            wjoin(Path::new("E:/Git"), r"bin\bash.exe"),
        ];
        let exists = |p: &Path| have.iter().any(|h| h == p);
        let profiles = windows_profiles(&env, &exists, &[]);
        assert_eq!(profiles[0].name, "Windows PowerShell");
        assert_eq!(profiles[0].source.as_deref(), Some("PowerShell"));
        assert_eq!(profiles[1].name, "Git Bash");
        assert!(profiles[1].path.contains("E:"));
    }

    #[test]
    fn reg_query_output() {
        let out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\GitForWindows\r\n    InstallPath    REG_SZ    C:\\Program Files\\Git\r\n\r\n";
        assert_eq!(
            parse_reg_value(out, "InstallPath").as_deref(),
            Some("C:\\Program Files\\Git")
        );
        assert_eq!(parse_reg_value("ERROR: not found", "InstallPath"), None);
    }

    #[test]
    fn programs_resolve_first_existing_or_on_path() {
        let dirs = vec![PathBuf::from("/opt/x"), PathBuf::from("/usr/bin")];
        let exists = |p: &Path| p == Path::new("/usr/bin/fish") || p == Path::new("/usr/bin/a.exe");
        assert_eq!(
            resolve_program(&["/nope/fish".into(), "fish".into()], &dirs, false, &exists),
            Some(PathBuf::from("/usr/bin/fish"))
        );
        assert_eq!(
            resolve_program(&["a".into()], &dirs, true, &exists),
            Some(PathBuf::from("/usr/bin/a.exe"))
        );
        assert_eq!(
            resolve_program(&["zsh".into()], &dirs, false, &exists),
            None
        );
        std::env::set_var("IDE_PROFILE_TEST", "/usr/bin");
        assert_eq!(
            resolve_program(
                &["${env:IDE_PROFILE_TEST}/fish".into()],
                &[],
                false,
                &exists
            ),
            Some(PathBuf::from("/usr/bin/fish"))
        );
    }
}
