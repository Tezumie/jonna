//! The agent's command sandbox (D336): `run_command` runs its shell under the operating system's
//! own isolation, with writes limited to the command's workspace folder (plus the repository's
//! git folder, so commits work from a worktree) and a temp folder. No new dependency; per OS:
//!
//! - Windows: the shell starts at low integrity (its token is lowered while it is still
//!   suspended, before its first instruction; everything it starts inherits that). Windows'
//!   mandatory integrity control then refuses it write access to anything labelled medium —
//!   every file, folder and registry key of the user's that isn't explicitly marked lower. The
//!   folder (and its git folder) are marked low once, inheritably, so the command can write
//!   there; its temp folder is a folder under LocalLow. The user's secrets get a no-read-up
//!   label once (D349, `sandbox_read.rs`). The network is NOT limited by the system (D348: that
//!   takes an administrator); only tools that honor the proxy variables go through the filter.
//! - macOS: `sandbox-exec` with a profile that denies file writes outside those folders, reads
//!   of the secrets, and network connections except to localhost (where the proxy listens).
//! - Linux: bubblewrap (`bwrap`) when it is installed: the system read-only, those folders and
//!   /tmp writable, the secrets covered, no network (or, with allowed hosts, the network shared
//!   and the proxy set). Without bwrap there is no sandbox (said so, not pretended).
//!
//! D350: a project's extra writable folders and allowed hosts come with the command
//! (`SandboxPolicy`); the hosts through the filtering proxy (`sandbox_net.rs`).
//!
//! Remote and WSL folders are never sandboxed (the command runs on the other side).

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::error::{Error, Result};

/// What this system's sandbox can do, for the agent's tool row, its permission card and its
/// settings (`exec_sandbox_info`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxInfo {
    /// "low-integrity", "sandbox-exec", "bubblewrap"; None when there is none here.
    pub mechanism: Option<String>,
    pub limits_writes: bool,
    /// The system refuses connections other than to localhost (D336).
    pub limits_network: bool,
    /// The secrets in agent.sandbox.denyRead are hidden (D349).
    pub limits_reads: bool,
    /// "blocked": the system allows localhost only (allowed hosts through the proxy); "proxy":
    /// only tools that honor the proxy variables are limited (Windows, D348); "open": none.
    pub network: String,
    /// One sentence for the user: what it protects, or why there's none.
    pub note: String,
}

/// The sandbox one command runs in.
#[derive(Debug, Clone, Default)]
pub struct Sandbox {
    /// Folders it may write (besides its temp folder).
    pub writable: Vec<PathBuf>,
    /// Names its temp folder (Windows: under LocalLow); the IDE's data folder's name.
    pub app_name: String,
    /// What it may not read (D349).
    pub deny_read: super::sandbox_read::ReadLimits,
    /// Hosts it may reach through the proxy (D350); loopback always.
    pub allow_hosts: Vec<String>,
    /// The IDE's data folder (Windows records the paths it hid there).
    pub data_dir: Option<PathBuf>,
    /// The configuration folders it may not write in its folders (D392, `sandbox_protect`).
    pub protect_folders: Vec<String>,
}

/// What the webview sends with a sandboxed command (D349, D350): agent.sandbox.denyRead, and the
/// user's and the project's allowances.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SandboxPolicy {
    pub deny_read: Vec<String>,
    pub allow_write: Vec<String>,
    pub allow_hosts: Vec<String>,
    /// The IDE's own configuration folder names (product.json), protected as the agents' are
    /// (D392).
    pub protect_folders: Vec<String>,
}

/// What a sandboxed command leaves behind for its result: the hosts the proxy refused and what
/// couldn't be set up (a secret it couldn't hide). Held while the command runs (the proxy).
#[derive(Default)]
pub struct SandboxGuard {
    pub proxy: Option<super::sandbox_net::NetProxy>,
    pub notes: Vec<String>,
}

impl Sandbox {
    /// For a command in workspace folder `root`: that folder and its repository's git folder
    /// (a worktree's lives outside it; a subfolder's repository is above it).
    pub fn for_root(root: &Path, app_name: &str) -> Self {
        let mut writable = vec![root.to_path_buf()];
        if let Some(git) = crate::fs::repository_common_dir(root) {
            if !git.starts_with(root) {
                writable.push(git);
            }
        }
        Sandbox {
            writable,
            app_name: app_name.to_string(),
            protect_folders: super::sandbox_protect::clean_folder_names(&[]),
            ..Default::default()
        }
    }

    /// With the policy: extra writable folders (absolute, existing; one that holds the home
    /// folder or is a drive's root is refused), the secrets to hide, the hosts to allow.
    pub fn with_policy(mut self, policy: &SandboxPolicy, data_dir: &Path) -> Self {
        let home = home_dir();
        for raw in &policy.allow_write {
            let p = match raw.trim() {
                "~" => home.clone(),
                t => match t.strip_prefix("~/").or_else(|| t.strip_prefix("~\\")) {
                    Some(rest) => home.as_ref().map(|h| h.join(rest)),
                    None => Some(PathBuf::from(t)).filter(|p| p.is_absolute()),
                },
            };
            // `..` resolved first: `~/..` or `C:\Windows\..` would pass the checks below as
            // written and then mark the folder they name.
            let Some(p) = p
                .map(|p| super::sandbox_read::lexical(&p))
                .filter(|p| p.is_dir())
            else {
                continue;
            };
            let too_wide = p.parent().is_none() || home.as_ref().is_some_and(|h| holds(&p, h));
            if !too_wide && !self.writable.contains(&p) {
                self.writable.push(p);
            }
        }
        self.deny_read = super::sandbox_read::expand(
            &policy.deny_read,
            home.as_deref(),
            Some(data_dir),
            &self.writable,
        );
        self.allow_hosts = policy
            .allow_hosts
            .iter()
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
            .collect();
        self.data_dir = Some(data_dir.to_path_buf());
        self.protect_folders = super::sandbox_protect::clean_folder_names(&policy.protect_folders);
        self
    }
}

/// Whether folder `dir` is `inner` or holds it. Windows paths compare without regard to case:
/// `C:\USERS\ME` is the home folder too (marking it would make the whole profile writable).
fn holds(dir: &Path, inner: &Path) -> bool {
    let parts = |p: &Path| -> Vec<String> {
        super::sandbox_read::lexical(p)
            .components()
            .map(|c| {
                let s = c.as_os_str().to_string_lossy();
                if cfg!(windows) {
                    s.to_lowercase()
                } else {
                    s.into_owned()
                }
            })
            .collect()
    };
    parts(inner).starts_with(&parts(dir))
}

/// The user's home folder.
fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// What this system offers (worked out once).
pub fn info() -> SandboxInfo {
    static INFO: std::sync::OnceLock<SandboxInfo> = std::sync::OnceLock::new();
    INFO.get_or_init(detect).clone()
}

fn detect() -> SandboxInfo {
    #[cfg(windows)]
    {
        SandboxInfo {
            mechanism: Some("low-integrity".into()),
            limits_writes: true,
            limits_network: false,
            limits_reads: true,
            network: "proxy".into(),
            note: "Windows: the command runs at low integrity, so it can't write outside the folder and a temp folder (the folder is marked writable for low-integrity programs the first time), nor read the secrets in agent.sandbox.denyRead (they get a label once). Windows lets only an administrator limit the network: tools that use the proxy settings (npm, pip, git, curl, cargo) reach localhost and the allowed hosts only; other programs aren't limited.".into(),
        }
    }
    #[cfg(target_os = "macos")]
    {
        if Path::new(SANDBOX_EXEC).is_file() {
            SandboxInfo {
                mechanism: Some("sandbox-exec".into()),
                limits_writes: true,
                limits_network: true,
                limits_reads: true,
                network: "blocked".into(),
                note: "macOS: sandbox-exec keeps the command's writes to the folder and temp folders, hides the secrets in agent.sandbox.denyRead, and allows connections to localhost and the allowed hosts only.".into(),
            }
        } else {
            none("macOS without /usr/bin/sandbox-exec: commands run with your full rights.")
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if crate::exec::format::find_program("bwrap").is_some() {
            SandboxInfo {
                mechanism: Some("bubblewrap".into()),
                limits_writes: true,
                limits_network: true,
                limits_reads: true,
                network: "blocked".into(),
                note: "Linux: bubblewrap mounts the system read-only except the folder and /tmp, hides the secrets in agent.sandbox.denyRead, with no network (with allowed hosts, the network is shared and only tools that use the proxy settings are limited).".into(),
            }
        } else {
            none("Linux without bubblewrap (bwrap): commands run with your full rights. Install bubblewrap for a sandbox.")
        }
    }
}

#[cfg(unix)]
fn none(note: &str) -> SandboxInfo {
    SandboxInfo {
        mechanism: None,
        limits_writes: false,
        limits_network: false,
        limits_reads: false,
        network: "open".into(),
        note: note.into(),
    }
}

#[cfg(target_os = "macos")]
const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// A string literal in a sandbox-exec profile.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn sbpl_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The macOS profile: everything allowed except file writes outside `writable` and `/dev` and
/// to what `protect_rules` names inside them (`sandbox_protect::macos_rules`, after the allow:
/// the later rule wins), the reads in `read_rules` (`sandbox_read::macos_rules`), and outgoing
/// connections other than to localhost. Paths must be canonical (/private/var, not /var).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn macos_profile(writable: &[PathBuf], protect_rules: &str, read_rules: &str) -> String {
    let mut out = String::from("(version 1)\n(allow default)\n(deny file-write*)\n(allow file-write*\n  (subpath \"/dev\")");
    for dir in writable {
        out.push_str(&format!(
            "\n  (subpath {})",
            sbpl_string(&dir.to_string_lossy())
        ));
    }
    out.push_str(")\n");
    out.push_str(protect_rules);
    out.push_str(read_rules);
    out.push_str("(deny network-outbound)\n(allow network-outbound (remote ip \"localhost:*\"))\n");
    out
}

/// bubblewrap's arguments: the system read-only, /dev and /tmp and `writable` as they are, git's
/// settings and the configuration folders in them read-only (`protect`, D392), the secrets
/// covered (`hide`, after the binds), no network unless `share_net` (allowed hosts go through
/// the proxy on the host's loopback), then the shell running `command`.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
pub fn bwrap_args(
    writable: &[PathBuf],
    protect: &[String],
    hide: &[String],
    share_net: bool,
    shell: &str,
    command: &str,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "--ro-bind",
        "/",
        "/",
        "--dev-bind",
        "/dev",
        "/dev",
        "--bind",
        "/tmp",
        "/tmp",
    ]
    .map(String::from)
    .to_vec();
    for dir in writable {
        let d = dir.to_string_lossy().to_string();
        args.extend(["--bind".to_string(), d.clone(), d]);
    }
    args.extend(protect.iter().cloned());
    args.extend(hide.iter().cloned());
    if !share_net {
        args.push("--unshare-net".to_string());
    }
    args.extend(["--die-with-parent", "--", shell, "-lc", command].map(String::from));
    args
}

/// The temp folders a sandboxed command may write on macOS (canonical).
#[cfg(target_os = "macos")]
fn macos_temp_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/private/tmp"),
        PathBuf::from("/private/var/folders"),
    ];
    if let Ok(t) = std::fs::canonicalize(std::env::temp_dir()) {
        if !dirs.iter().any(|d| t.starts_with(d)) {
            dirs.push(t);
        }
    }
    dirs
}

/// Holds a sandboxed PowerShell's script on its way through cmd (Windows).
#[cfg(windows)]
const SCRIPT_VAR: &str = "AGENT_SANDBOX_SCRIPT";

/// What PowerShell runs in the sandbox: the script from variable `var`, in the global scope as
/// `-Command` would, the variable cleared first. Nothing in it means anything to cmd (no & | < > ^
/// % or quotes), which passes it on. (Not `-EncodedCommand`: 5.1 then writes errors as CLIXML.)
#[cfg_attr(not(windows), allow(dead_code))]
fn script_stub(var: &str) -> String {
    format!(
        "$__sandboxScript = $env:{var}; Remove-Item Env:{var}; . ([scriptblock]::Create($__sandboxScript))"
    )
}

/// The filtering proxy for a command, and its variables set on `cmd` (D348, D350).
#[cfg_attr(all(unix, not(target_os = "macos")), allow(dead_code))]
fn start_proxy(cmd: &mut Command, sandbox: &Sandbox, guard: &mut SandboxGuard) {
    match super::sandbox_net::NetProxy::start(sandbox.allow_hosts.clone()) {
        Ok(proxy) => {
            for (k, v) in proxy.env() {
                cmd.env(k, v);
            }
            guard.proxy = Some(proxy);
        }
        Err(e) => guard
            .notes
            .push(format!("the sandbox's network filter didn't start: {e}")),
    }
}

/// The shell command for `command` inside `sandbox`. Windows: cmd (lowered to low integrity by
/// `spawn` while suspended) starts PowerShell, which is then low from its creation — PowerShell
/// lowered after its start fails fast (it opens its own process, whose object stays medium). TEMP
/// and TMP point to the sandbox's temp folder; the writable folders are marked first, the secrets
/// hidden.
pub(crate) fn shell_command(command: &str, sandbox: &Sandbox) -> Result<(Command, SandboxGuard)> {
    let mut guard = SandboxGuard::default();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for dir in &sandbox.writable {
            windows_low::mark_writable(dir).map_err(|e| {
                Error::Exec(format!(
                    "the sandbox couldn't mark {} writable for low-integrity programs: {e}",
                    dir.display()
                ))
            })?;
        }
        let temp = windows_low::temp_dir(&sandbox.app_name)
            .map_err(|e| Error::Exec(format!("the sandbox has no temp folder: {e}")))?;
        if let Some(data) = &sandbox.data_dir {
            guard
                .notes
                .extend(super::sandbox_read::windows_hide::hide_all(
                    &sandbox.deny_read.paths,
                    data,
                ));
        }
        let (shell, script) = super::powershell_script(command);
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        let mut cmd = Command::new(comspec);
        cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        cmd.env(SCRIPT_VAR, script);
        cmd.env("TEMP", &temp).env("TMP", &temp);
        // `/s /c "…"`: cmd drops the outer quotes and runs the rest as it is.
        cmd.raw_arg(format!(
            "/d /s /c \"\"{}\" -NoLogo -NoProfile -NonInteractive -Command \"{}\"\"",
            shell.display(),
            script_stub(SCRIPT_VAR)
        ));
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
        start_proxy(&mut cmd, sandbox, &mut guard);
        Ok((cmd, guard))
    }
    #[cfg(target_os = "macos")]
    {
        let _ = &sandbox.app_name;
        if !Path::new(SANDBOX_EXEC).is_file() {
            return Err(Error::Exec("sandbox-exec isn't available".into()));
        }
        let mut writable: Vec<PathBuf> = sandbox
            .writable
            .iter()
            .map(|d| std::fs::canonicalize(d).unwrap_or_else(|_| d.clone()))
            .collect();
        writable.extend(macos_temp_dirs());
        let mut limits = sandbox.deny_read.clone();
        limits.paths = limits
            .paths
            .iter()
            .map(|p| std::fs::canonicalize(p).unwrap_or_else(|_| p.clone()))
            .collect();
        let read_rules = super::sandbox_read::macos_rules(&limits, &writable);
        // The command's own folders (not the temp ones): git's settings and the configuration
        // folders in them stay read-only (D392).
        let own = &writable[..sandbox.writable.len()];
        let protect_rules = super::sandbox_protect::macos_rules(own, &sandbox.protect_folders);
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut cmd = Command::new(SANDBOX_EXEC);
        cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        cmd.arg("-p")
            .arg(macos_profile(&writable, &protect_rules, &read_rules))
            .args([shell.as_str(), "-lc", command]);
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        // Connections reach localhost only: the proxy is the way to the allowed hosts.
        start_proxy(&mut cmd, sandbox, &mut guard);
        Ok((cmd, guard))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = &sandbox.app_name;
        let bwrap = crate::exec::format::find_program("bwrap")
            .ok_or_else(|| Error::Exec("bubblewrap (bwrap) isn't installed".into()))?;
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut cmd = Command::new(bwrap);
        cmd.env_remove(crate::debug::pane_port::WEBVIEW2_ARGS_VAR);
        let hide = super::sandbox_read::bwrap_hide_args(&sandbox.deny_read);
        // A network of its own can't reach the host's loopback, where the proxy listens: with
        // allowed hosts the network is shared and the proxy set (proxy-aware tools only, D350).
        let share_net = !sandbox.allow_hosts.is_empty();
        let protect =
            super::sandbox_protect::bwrap_args(&sandbox.writable, &sandbox.protect_folders);
        cmd.args(bwrap_args(
            &sandbox.writable,
            &protect,
            &hide,
            share_net,
            &shell,
            command,
        ));
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        if share_net {
            start_proxy(&mut cmd, sandbox, &mut guard);
        }
        Ok((cmd, guard))
    }
}

/// Starts a command from `shell_command` (in the IDE's job, as `job::spawn`). Windows: its token
/// goes to low integrity while it is suspended, so not one instruction runs with more.
pub(crate) fn spawn(cmd: &mut Command) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    {
        crate::job::spawn_then(cmd, |child| {
            use std::os::windows::io::AsRawHandle;
            windows_low::lower(child.as_raw_handle())
        })
    }
    #[cfg(not(windows))]
    {
        crate::job::spawn(cmd)
    }
}

#[cfg(windows)]
pub(crate) mod windows_low {
    use std::path::{Path, PathBuf};

    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertSecurityDescriptorToStringSecurityDescriptorW,
        ConvertStringSecurityDescriptorToSecurityDescriptorW, GetNamedSecurityInfoW,
        SetNamedSecurityInfoW, SDDL_REVISION_1, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        CreateWellKnownSid, GetSecurityDescriptorSacl, InitializeAcl, SetTokenInformation,
        TokenIntegrityLevel, WinLowLabelSid, ACL, ACL_REVISION, LABEL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::OpenProcessToken;

    /// The label that lets low-integrity programs write: low, no-write-up, inherited by files and
    /// folders.
    const LOW_LABEL: &str = "S:(ML;OICI;NW;;;LW)";
    /// SE_GROUP_INTEGRITY (winnt.h).
    const GROUP_INTEGRITY: u32 = 0x20;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn wide_path(p: &Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        p.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Lowers the token of a process (still suspended) to low integrity.
    pub fn lower(process: std::os::windows::io::RawHandle) -> std::io::Result<()> {
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(
                HANDLE(process),
                TOKEN_ADJUST_DEFAULT | TOKEN_QUERY,
                &mut token,
            )
            .map_err(|e| std::io::Error::other(format!("open token: {e}")))?;
            // A SID is at most 68 bytes.
            let mut sid = [0u8; 68];
            let mut size = sid.len() as u32;
            let made = CreateWellKnownSid(
                WinLowLabelSid,
                None,
                Some(PSID(sid.as_mut_ptr().cast())),
                &mut size,
            );
            let set = made.and_then(|()| {
                let label = TOKEN_MANDATORY_LABEL {
                    Label: SID_AND_ATTRIBUTES {
                        Sid: PSID(sid.as_mut_ptr().cast()),
                        Attributes: GROUP_INTEGRITY,
                    },
                };
                SetTokenInformation(
                    token,
                    TokenIntegrityLevel,
                    (&label as *const TOKEN_MANDATORY_LABEL).cast(),
                    std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 + size,
                )
            });
            let _ = CloseHandle(token);
            set.map_err(|e| std::io::Error::other(format!("lower integrity: {e}")))
        }
    }

    /// `path`'s mandatory label as SDDL (`S:(ML;…)`, or `S:`/empty without one); None when it
    /// can't be read.
    pub fn label_text(path: &Path) -> Option<String> {
        let path = wide_path(path);
        unsafe {
            let mut sd = PSECURITY_DESCRIPTOR::default();
            let got = GetNamedSecurityInfoW(
                PCWSTR(path.as_ptr()),
                SE_FILE_OBJECT,
                LABEL_SECURITY_INFORMATION,
                None,
                None,
                None,
                None,
                &mut sd,
            );
            if got != ERROR_SUCCESS || sd.0.is_null() {
                return None;
            }
            let mut text = PWSTR::null();
            let ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(
                sd,
                SDDL_REVISION_1,
                LABEL_SECURITY_INFORMATION,
                &mut text,
                None,
            )
            .is_ok();
            let s = if ok && !text.is_null() {
                Some(text.to_string().unwrap_or_default())
            } else {
                None
            };
            if !text.is_null() {
                let _ = LocalFree(Some(HLOCAL(text.0.cast())));
            }
            let _ = LocalFree(Some(HLOCAL(sd.0)));
            s
        }
    }

    /// Whether `dir` carries the inheritable low label already.
    pub fn is_marked(dir: &Path) -> bool {
        label_text(dir)
            .map(|s| {
                // Low, no-write-up, inherited by both files and folders.
                s.contains("ML;OICI;NW;;;LW") || s.contains("ML;CIOI;NW;;;LW")
            })
            .unwrap_or(false)
    }

    /// Sets `path`'s explicit mandatory label to `sddl` (`S:(ML;…)`; `S:` for none; labels it
    /// inherits stay). An inheritable label is carried down to what's in a folder
    /// (SetNamedSecurityInfo does that); the DACL isn't touched. (Protecting the label from
    /// inheritance would need the security privilege: error 1314 for a normal user.)
    pub fn set_label(path: &Path, sddl: &str) -> std::io::Result<()> {
        let path = wide_path(path);
        let text = wide(sddl);
        unsafe {
            let mut sd = PSECURITY_DESCRIPTOR::default();
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(text.as_ptr()),
                SDDL_REVISION_1,
                &mut sd,
                None,
            )
            .map_err(|e| std::io::Error::other(format!("label: {e}")))?;
            let mut present = windows::core::BOOL(0);
            let mut defaulted = windows::core::BOOL(0);
            let mut sacl: *mut ACL = std::ptr::null_mut();
            let got = GetSecurityDescriptorSacl(sd, &mut present, &mut sacl, &mut defaulted);
            // No label at all: an empty ACL (a null one would mean "leave it").
            let mut empty = [0u32; 4];
            if got.is_ok() && sacl.is_null() {
                let acl = empty.as_mut_ptr().cast::<ACL>();
                if InitializeAcl(acl, std::mem::size_of_val(&empty) as u32, ACL_REVISION).is_ok() {
                    sacl = acl;
                }
            }
            let result = match got {
                Ok(()) if !sacl.is_null() => {
                    let set = SetNamedSecurityInfoW(
                        PCWSTR(path.as_ptr()),
                        SE_FILE_OBJECT,
                        LABEL_SECURITY_INFORMATION,
                        None,
                        None,
                        None,
                        Some(sacl as *const ACL),
                    );
                    if set == ERROR_SUCCESS {
                        Ok(())
                    } else {
                        Err(std::io::Error::from_raw_os_error(set.0 as i32))
                    }
                }
                Ok(()) => Err(std::io::Error::other("label: no ACL")),
                Err(e) => Err(std::io::Error::other(format!("label: {e}"))),
            };
            let _ = LocalFree(Some(HLOCAL(sd.0)));
            result
        }
    }

    /// Marks `dir` (and, through inheritance, what's in it) writable for low-integrity programs.
    /// Once per folder: a folder marked already is left as it is. The label only lowers the bar for
    /// writes by low-integrity programs; the folder's permissions (its DACL) don't change.
    pub fn mark_writable(dir: &Path) -> std::io::Result<()> {
        if is_marked(dir) {
            return Ok(());
        }
        set_label(dir, LOW_LABEL)
    }

    /// The sandbox's temp folder: `<LocalLow>\<app>\sandbox-temp` (LocalLow is low already).
    pub fn temp_dir(app: &str) -> std::io::Result<PathBuf> {
        use windows::Win32::System::Com::CoTaskMemFree;
        use windows::Win32::UI::Shell::{
            FOLDERID_LocalAppDataLow, SHGetKnownFolderPath, KF_FLAG_DEFAULT,
        };
        let base = unsafe {
            let p = SHGetKnownFolderPath(&FOLDERID_LocalAppDataLow, KF_FLAG_DEFAULT, None)
                .map_err(|e| std::io::Error::other(format!("LocalLow: {e}")))?;
            let s = p.to_string().unwrap_or_default();
            CoTaskMemFree(Some(p.0 as *const core::ffi::c_void));
            s
        };
        if base.is_empty() {
            return Err(std::io::Error::other("no LocalLow folder"));
        }
        let name = if app.trim().is_empty() { "ide" } else { app };
        let dir = PathBuf::from(base).join(name).join("sandbox-temp");
        std::fs::create_dir_all(&dir)?;
        // Made by the IDE (medium) inside LocalLow: it inherits LocalLow's low label, but mark
        // it in case LocalLow was set up differently.
        if !is_marked(&dir) {
            mark_writable(&dir)?;
        }
        Ok(dir)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_macos_profile_denies_writes_but_the_folders_and_connections_but_localhost() {
        let p = macos_profile(&[PathBuf::from("/Users/me/my \"app\"")], "", "");
        assert!(p.starts_with("(version 1)\n(allow default)\n(deny file-write*)"));
        assert!(p.contains("(subpath \"/Users/me/my \\\"app\\\"\")"));
        assert!(p.contains("(subpath \"/dev\")"));
        assert!(p.contains("(deny network-outbound)"));
        assert!(p.contains("(allow network-outbound (remote ip \"localhost:*\"))"));
    }

    #[test]
    fn bwrap_binds_the_system_read_only_and_the_folders_writable() {
        let a = bwrap_args(
            &[PathBuf::from("/home/me/app")],
            &[],
            &[],
            false,
            "/bin/bash",
            "npm test",
        );
        assert_eq!(&a[..3], ["--ro-bind", "/", "/"]);
        let at = a.iter().position(|x| x == "/home/me/app").unwrap_or(0);
        assert_eq!(a[at - 1], "--bind");
        assert!(a.contains(&"--unshare-net".to_string()));
        assert_eq!(&a[a.len() - 4..], ["--", "/bin/bash", "-lc", "npm test"]);
        // Hidden paths come after the binds; allowed hosts share the network.
        let hide = ["--tmpfs".to_string(), "/home/me/.ssh".to_string()];
        let a = bwrap_args(
            &[PathBuf::from("/home/me/app")],
            &[],
            &hide,
            true,
            "/bin/sh",
            "x",
        );
        let bind = a
            .iter()
            .position(|x| x == "/home/me/app")
            .unwrap_or(usize::MAX);
        let tmpfs = a.iter().position(|x| x == "--tmpfs").unwrap_or(0);
        assert!(bind < tmpfs);
        assert!(!a.contains(&"--unshare-net".to_string()));
    }

    #[test]
    fn an_allowed_folder_that_holds_home_or_is_a_root_is_refused_however_written() {
        let home = PathBuf::from(if cfg!(windows) {
            "C:\\Users\\me"
        } else {
            "/home/me"
        });
        assert!(holds(&home, &home));
        assert!(holds(&home.join("x").join(".."), &home));
        assert!(!holds(&home.join("work"), &home));
        if cfg!(windows) {
            assert!(holds(Path::new("c:\\USERS\\ME"), &home));
            assert!(holds(Path::new("C:/Users"), &home));
        } else {
            assert!(!holds(Path::new("/HOME/ME"), &home));
        }
        // `<root>/<first folder>/..` is the root: refused, not marked.
        let temp = std::env::temp_dir();
        let Some(first) = temp.ancestors().filter(|a| a.parent().is_some()).last() else {
            return;
        };
        let policy = SandboxPolicy {
            allow_write: vec![first.join("..").to_string_lossy().into_owned()],
            ..Default::default()
        };
        let sb = Sandbox::for_root(&temp.join("no-such-project"), "t");
        let before = sb.writable.len();
        let sb = sb.with_policy(&policy, &temp);
        assert_eq!(sb.writable.len(), before, "{:?}", sb.writable);
    }

    #[test]
    fn info_says_what_it_protects() {
        let i = info();
        assert!(!i.note.is_empty());
        if cfg!(windows) {
            assert_eq!(i.mechanism.as_deref(), Some("low-integrity"));
            assert!(i.limits_writes && !i.limits_network && i.limits_reads);
            assert_eq!(i.network, "proxy");
        }
    }

    /// The real thing on Windows: a sandboxed shell writes in its folder, not next to it.
    #[cfg(windows)]
    #[test]
    fn a_sandboxed_command_writes_in_its_folder_only() {
        let base = std::env::temp_dir().join(format!("ide-sandbox-test-{}", std::process::id()));
        let inside = base.join("inside");
        let outside = base.join("outside");
        let _ = std::fs::create_dir_all(inside.join("sub"));
        let _ = std::fs::create_dir_all(&outside);
        // A file and folder that were there before the folder was marked are writable too.
        let _ = std::fs::write(inside.join("sub").join("old.txt"), "old");
        let sandbox = Sandbox {
            writable: vec![inside.clone()],
            app_name: "ide-sandbox-test".into(),
            ..Default::default()
        };
        let service = crate::exec::ExecService::default();
        let script = format!(
            "Set-Content -Path '{}' -Value in; Set-Content -Path '{}' -Value old2; Set-Content -Path (Join-Path $env:TEMP 'x.txt') -Value t; cmd /c 'echo x > {}'; Set-Content -Path '{}' -Value out",
            inside.join("new.txt").display(),
            inside.join("sub").join("old.txt").display(),
            outside.join("child.txt").display(),
            outside.join("escaped.txt").display()
        );
        let out = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let sink = out.clone();
        let r = service.run_sandboxed(
            "t1",
            &script,
            &inside,
            std::time::Duration::from_secs(60),
            &sandbox,
            move |c| {
                if let Ok(mut o) = sink.lock() {
                    o.push_str(&c);
                }
            },
        );
        let text = out.lock().map(|o| o.clone()).unwrap_or_default();
        let r = match r {
            Ok(r) => r,
            Err(e) => panic!("run failed: {e}"),
        };
        assert!(r.sandboxed);
        assert!(
            inside.join("new.txt").is_file(),
            "inside write failed: {text} {r:?}"
        );
        assert_eq!(
            std::fs::read_to_string(inside.join("sub").join("old.txt"))
                .unwrap_or_default()
                .trim(),
            "old2",
            "{text}"
        );
        assert!(
            !outside.join("escaped.txt").exists(),
            "wrote outside: {text}"
        );
        // What it starts is held the same way.
        assert!(
            !outside.join("child.txt").exists(),
            "a child wrote outside: {text}"
        );
        assert_ne!(r.exit_code, Some(0));
        let _ = std::fs::remove_dir_all(&base);
    }
}
