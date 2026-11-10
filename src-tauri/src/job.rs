//! Children that end with the IDE (D180). On Windows a process outlives its parent: when the IDE
//! is closed abruptly (crash, Task Manager, `tauri dev` rebuilding it), its terminals' shells,
//! commands, language / MCP / agent servers and formatters kept running, each with a "Console
//! Window Host", some busy on a closed pipe. Each such child is put in one job object that is
//! killed when the IDE's handle to it closes, which Windows does when the process ends, however it
//! ends. Things the IDE launches for the user (their browser, another IDE window) aren't added.
//! Elsewhere this is a no-op: Unix children get a hangup when their terminal or pipe closes.
//!
//! Children are started suspended, put in the job, then resumed (m7.12): adopting a running
//! process by its id raced with what it started in its first instants, which could escape the job.
//! Terminals do this in `pty::conpty`; `spawn` does it for `std::process::Command`.

/// Adds process `pid` (just spawned by the IDE) to the IDE's job. Best effort: a failure leaves
/// the process as it was. Prefer `spawn` (no race with the child's own children).
#[allow(dead_code)]
pub fn adopt(pid: u32) {
    #[cfg(windows)]
    windows_job::adopt(pid);
    #[cfg(not(windows))]
    let _ = pid;
}

/// Adds a process, by a handle with PROCESS_SET_QUOTA and PROCESS_TERMINATE access (a handle from
/// CreateProcess has them), to the IDE's job. Best effort, as `adopt`.
#[cfg(windows)]
pub fn adopt_handle(process: std::os::windows::io::RawHandle) {
    windows_job::adopt_handle(process);
}

/// Starts `cmd` with no console window, in the IDE's job from its first instruction: created
/// suspended, adopted, then resumed. Elsewhere a plain spawn.
pub fn spawn(cmd: &mut std::process::Command) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    {
        spawn_then(cmd, |_| Ok(()))
    }
    #[cfg(not(windows))]
    {
        cmd.spawn()
    }
}

/// `spawn`, with `before_resume` run on the child while it is still suspended (the command
/// sandbox lowers its token there, D336). An error from it kills the child.
#[cfg(windows)]
pub fn spawn_then(
    cmd: &mut std::process::Command,
    before_resume: impl FnOnce(&std::process::Child) -> std::io::Result<()>,
) -> std::io::Result<std::process::Child> {
    {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let mut child = cmd.spawn()?;
        windows_job::adopt_handle(child.as_raw_handle());
        let ready = before_resume(&child);
        if let Err(err) = ready.and_then(|()| windows_job::resume(child.id())) {
            // Never leave a process suspended forever.
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
        Ok(child)
    }
}

/// A job of its own for one program and everything it starts (D264), nested in the IDE's job:
/// dropping it ends them all. A server that crashed left what it started running until the IDE
/// closed (a Node extension host's language server or CLI), and a restart started a second copy.
/// Elsewhere it holds nothing (process groups do this there, `lsp::kill_server`).
pub struct OwnJob {
    #[cfg(windows)]
    handle: isize,
}

impl Drop for OwnJob {
    fn drop(&mut self) {
        #[cfg(windows)]
        windows_job::close(self.handle);
    }
}

/// `spawn`, with the program also in a job of its own (see `OwnJob`).
pub fn spawn_owned(
    cmd: &mut std::process::Command,
) -> std::io::Result<(std::process::Child, OwnJob)> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let mut child = cmd.spawn()?;
        // The IDE's job first: its own is then nested in it (Windows 8+), so closing the IDE still
        // ends everything.
        windows_job::adopt_handle(child.as_raw_handle());
        let handle = windows_job::own_job(child.as_raw_handle());
        if let Err(err) = windows_job::resume(child.id()) {
            let _ = child.kill();
            let _ = child.wait();
            windows_job::close(handle);
            return Err(err);
        }
        Ok((child, OwnJob { handle }))
    }
    #[cfg(not(windows))]
    {
        Ok((cmd.spawn()?, OwnJob {}))
    }
}

#[cfg(windows)]
mod windows_job {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, OpenThread, ResumeThread, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        THREAD_SUSPEND_RESUME,
    };

    /// The job's handle as an integer (HANDLE isn't Send); 0 when it couldn't be made. Never
    /// closed: it closes with the process, which is what kills the children.
    static JOB: OnceLock<isize> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        let raw = *JOB.get_or_init(|| unsafe {
            let Ok(job) = CreateJobObjectW(None, windows::core::PCWSTR::null()) else {
                return 0;
            };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set.is_err() {
                let _ = CloseHandle(job);
                return 0;
            }
            job.0 as isize
        });
        (raw != 0).then_some(HANDLE(raw as *mut core::ffi::c_void))
    }

    pub fn adopt(pid: u32) {
        unsafe {
            let Ok(process) = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) else {
                return;
            };
            adopt_handle(process.0);
            let _ = CloseHandle(process);
        }
    }

    pub fn adopt_handle(process: std::os::windows::io::RawHandle) {
        let Some(job) = job() else { return };
        // Fails if it already exited, or sits in a job that forbids nesting: then it stays as it
        // was.
        unsafe {
            let _ = AssignProcessToJobObject(job, HANDLE(process));
        }
    }

    /// A new job that kills its processes when closed, with `process` in it; 0 if it couldn't
    /// be made (then the process is only in the IDE's job, as before).
    pub fn own_job(process: std::os::windows::io::RawHandle) -> isize {
        unsafe {
            let Ok(job) = CreateJobObjectW(None, windows::core::PCWSTR::null()) else {
                return 0;
            };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if set.is_err() || AssignProcessToJobObject(job, HANDLE(process)).is_err() {
                let _ = CloseHandle(job);
                return 0;
            }
            job.0 as isize
        }
    }

    /// Closes a job of `own_job` (0: nothing), which ends what's still in it.
    pub fn close(handle: isize) {
        if handle != 0 {
            unsafe {
                let _ = CloseHandle(HANDLE(handle as *mut core::ffi::c_void));
            }
        }
    }

    /// Resumes the threads of process `pid` (a process created suspended has one).
    pub fn resume(pid: u32) -> std::io::Result<()> {
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
                .map_err(|e| std::io::Error::other(format!("thread snapshot: {e}")))?;
            let mut entry = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut resumed = 0;
            let mut more = Thread32First(snapshot, &mut entry).is_ok();
            while more {
                if entry.th32OwnerProcessID == pid {
                    if let Ok(thread) = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                    {
                        if ResumeThread(thread) != u32::MAX {
                            resumed += 1;
                        }
                        let _ = CloseHandle(thread);
                    }
                }
                more = Thread32Next(snapshot, &mut entry).is_ok();
            }
            let _ = CloseHandle(snapshot);
            if resumed == 0 {
                return Err(std::io::Error::other("couldn't resume the started process"));
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn an_own_job_runs_its_program_and_ends_with_it() {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = std::process::Command::new(
                std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()),
            );
            c.args(["/d", "/c", "exit 4"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = std::process::Command::new("sh");
            c.args(["-c", "exit 4"]);
            c
        };
        let (mut child, job) = match super::spawn_owned(&mut cmd) {
            Ok(started) => started,
            Err(e) => panic!("spawn failed: {e}"),
        };
        let status = child.wait().map(|s| s.code());
        drop(job);
        assert_eq!(status.ok().flatten(), Some(4));
    }

    /// Closing a program's own job ends it (the job holds it, nested in the IDE's).
    #[cfg(windows)]
    #[test]
    fn closing_an_own_job_ends_its_program() {
        let mut cmd = std::process::Command::new("ping");
        cmd.args(["-n", "30", "127.0.0.1"])
            .stdout(std::process::Stdio::null());
        let (mut child, job) = match super::spawn_owned(&mut cmd) {
            Ok(started) => started,
            Err(e) => panic!("spawn failed: {e}"),
        };
        let started = std::time::Instant::now();
        drop(job);
        let _ = child.wait();
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[test]
    fn a_suspended_start_runs_to_its_end() {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = std::process::Command::new(
                std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()),
            );
            c.args(["/d", "/c", "exit 3"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = std::process::Command::new("sh");
            c.args(["-c", "exit 3"]);
            c
        };
        let mut child = match super::spawn(&mut cmd) {
            Ok(child) => child,
            Err(e) => panic!("spawn failed: {e}"),
        };
        let status = child.wait().map(|s| s.code());
        assert_eq!(status.ok().flatten(), Some(3));
    }
}
