//! Windows pseudo-consoles started by the IDE itself (m7.12) instead of portable-pty's spawner,
//! which can't do three things the terminal needs:
//! - **A newer ConPTY next to the program**: `conpty.dll` + `OpenConsole.exe` beside the exe (the
//!   bundle puts them there when the build has them) are loaded by full path, else kernel32's.
//!   portable-pty loaded `conpty.dll` by bare name, which also searches the current folder.
//! - **Starting suspended**: the child is created suspended, put in the IDE's job object, then
//!   resumed, so nothing it starts in its first instants escapes the job (D180's race).
//! - **A raw command-line tail**: cmd.exe reads its command line with its own rules, and the C
//!   quoting portable-pty applies to every argument breaks a shell task's `"` (D229); the tail is
//!   passed exactly as written (`/s /c "<line>"`).
//!
//! The pseudo-console flags, stdio handles and environment block are the ones portable-pty used,
//! so the terminal behaves as before.

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use super::tasks::command_line;

use portable_pty::{Child, ChildKiller, CommandBuilder, ExitStatus, PtySize};
use windows::core::{HRESULT, PCSTR, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE};
use windows::Win32::System::Console::{COORD, HPCON};
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32, LOAD_WITH_ALTERED_SEARCH_PATH,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, GetProcessId,
    InitializeProcThreadAttributeList, ResumeThread, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

/// portable-pty's flags: inherit the cursor, the resize quirk, win32-input-mode.
const PSEUDOCONSOLE_FLAGS: u32 = 0x1 | 0x2 | 0x4;

type CreateFn = unsafe extern "system" fn(COORD, HANDLE, HANDLE, u32, *mut HPCON) -> HRESULT;
type ResizeFn = unsafe extern "system" fn(HPCON, COORD) -> HRESULT;
type CloseFn = unsafe extern "system" fn(HPCON);

struct Api {
    create: CreateFn,
    resize: ResizeFn,
    close: CloseFn,
    bundled: bool,
}

/// The pseudo-console functions: the bundled conpty.dll when both files sit next to the program
/// (conpty.dll starts the OpenConsole.exe beside it), else the system's.
fn api() -> Option<&'static Api> {
    static API: OnceLock<Option<Api>> = OnceLock::new();
    API.get_or_init(|| {
        let bundled = bundled_dir()
            .and_then(|dir| unsafe { load(&dir.join("conpty.dll"), LOAD_WITH_ALTERED_SEARCH_PATH) })
            .map(|api| Api {
                bundled: true,
                ..api
            });
        bundled.or_else(|| unsafe { load(Path::new("kernel32.dll"), LOAD_LIBRARY_SEARCH_SYSTEM32) })
    })
    .as_ref()
}

/// The program's folder when it has both conpty.dll and OpenConsole.exe.
fn bundled_dir() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    (dir.join("conpty.dll").is_file() && dir.join("OpenConsole.exe").is_file()).then_some(dir)
}

/// "bundled" or "system": the ConPTY the terminals use (`ide://terminals` `conpty`).
pub fn kind() -> &'static str {
    match api() {
        Some(api) if api.bundled => "bundled",
        _ => "system",
    }
}

unsafe fn load(
    path: &Path,
    flags: windows::Win32::System::LibraryLoader::LOAD_LIBRARY_FLAGS,
) -> Option<Api> {
    let wide = wide_z(path.as_os_str());
    let module = unsafe { LoadLibraryExW(PCWSTR(wide.as_ptr()), None, flags) }.ok()?;
    let find = |name: &[u8]| unsafe { GetProcAddress(module, PCSTR(name.as_ptr())) };
    let create = find(b"CreatePseudoConsole\0")?;
    let resize = find(b"ResizePseudoConsole\0")?;
    let close = find(b"ClosePseudoConsole\0")?;
    // The module stays loaded for the life of the process (never freed), so these stay valid.
    Some(unsafe {
        Api {
            create: std::mem::transmute::<unsafe extern "system" fn() -> isize, CreateFn>(create),
            resize: std::mem::transmute::<unsafe extern "system" fn() -> isize, ResizeFn>(resize),
            close: std::mem::transmute::<unsafe extern "system" fn() -> isize, CloseFn>(close),
            bundled: false,
        }
    })
}

fn wide_z(s: &std::ffi::OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

fn coord(size: PtySize) -> COORD {
    COORD {
        X: i16::try_from(size.cols.max(1)).unwrap_or(i16::MAX),
        Y: i16::try_from(size.rows.max(1)).unwrap_or(i16::MAX),
    }
}

fn os_err(context: &str) -> io::Error {
    let e = io::Error::last_os_error();
    io::Error::new(e.kind(), format!("{context}: {e}"))
}

struct Console {
    hpc: HPCON,
    size: PtySize,
    close: CloseFn,
}

// The handle is used only through the Mutex around it.
unsafe impl Send for Console {}

impl Drop for Console {
    fn drop(&mut self) {
        // Can block until the console's output is read (the session's reader drains it).
        unsafe { (self.close)(self.hpc) };
    }
}

/// A pseudo-console and the IDE's ends of its pipes.
pub struct ConPty {
    console: Arc<Mutex<Console>>,
    resize: ResizeFn,
    reader: File,
    writer: Mutex<Option<File>>,
}

/// Opens a pseudo-console of `size`.
pub fn open(size: PtySize) -> io::Result<ConPty> {
    let api = api().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::Unsupported,
            "this Windows has no ConPTY (Windows 10 October 2018 or newer is needed)",
        )
    })?;
    let mut in_read = HANDLE::default();
    let mut in_write = HANDLE::default();
    let mut out_read = HANDLE::default();
    let mut out_write = HANDLE::default();
    unsafe {
        CreatePipe(&mut in_read, &mut in_write, None, 0).map_err(|_| os_err("CreatePipe"))?;
    }
    // Owned from here, so every early return closes them.
    let in_read = unsafe { OwnedHandle::from_raw_handle(in_read.0) };
    let in_write = unsafe { OwnedHandle::from_raw_handle(in_write.0) };
    unsafe {
        CreatePipe(&mut out_read, &mut out_write, None, 0).map_err(|_| os_err("CreatePipe"))?;
    }
    let out_read = unsafe { OwnedHandle::from_raw_handle(out_read.0) };
    let out_write = unsafe { OwnedHandle::from_raw_handle(out_write.0) };
    let mut hpc = HPCON::default();
    let hr = unsafe {
        (api.create)(
            coord(size),
            HANDLE(in_read.as_raw_handle()),
            HANDLE(out_write.as_raw_handle()),
            PSEUDOCONSOLE_FLAGS,
            &mut hpc,
        )
    };
    if hr.is_err() {
        return Err(io::Error::other(format!(
            "CreatePseudoConsole failed: HRESULT {:#x}",
            hr.0
        )));
    }
    // The console has its own copies of its ends of the pipes.
    drop(in_read);
    drop(out_write);
    Ok(ConPty {
        console: Arc::new(Mutex::new(Console {
            hpc,
            size,
            close: api.close,
        })),
        resize: api.resize,
        reader: File::from(out_read),
        writer: Mutex::new(Some(File::from(in_write))),
    })
}

impl ConPty {
    /// Starts `cmd` attached to the console: created suspended, put in the IDE's job, resumed.
    /// `verbatim` is appended to the command line exactly as written.
    pub fn spawn(&self, cmd: &CommandBuilder, verbatim: Option<&str>) -> io::Result<WinChild> {
        let cmd = &with_inherited_path(cmd);
        let console = self
            .console
            .lock()
            .map_err(|_| io::Error::other("console lock poisoned"))?;
        let env = environment_block(cmd);
        let path_env = cmd.get_env("PATH").map(|p| p.to_os_string());
        let pathext = cmd
            .get_env("PATHEXT")
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let argv = cmd.get_argv();
        let program = argv
            .first()
            .ok_or_else(|| io::Error::other("no program to start"))?;
        let exe = resolve_exe(program, path_env.as_deref(), &pathext, &|p| p.is_file());
        let args: Vec<String> = argv
            .iter()
            .skip(1)
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let shown = exe
            .as_ref()
            .map(|p| p.as_os_str().to_os_string())
            .unwrap_or_else(|| program.clone());
        let line = command_line(&shown.to_string_lossy(), &args, verbatim);
        let mut line_w: Vec<u16> = std::ffi::OsStr::new(&line)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let exe_w = exe.as_ref().map(|p| wide_z(p.as_os_str()));
        let cwd_w = working_dir(cmd).map(|d| wide_z(d.as_os_str()));

        let mut attrs = AttributeList::new(1)?;
        unsafe {
            UpdateProcThreadAttribute(
                attrs.ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                Some(console.hpc.0 as *const core::ffi::c_void),
                std::mem::size_of::<HPCON>(),
                None,
                None,
            )
            .map_err(|_| os_err("UpdateProcThreadAttribute"))?;
        }
        let mut si = STARTUPINFOEXW::default();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        // No inherited stdio: everything goes through the console (as portable-pty does).
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
        si.lpAttributeList = attrs.ptr();
        let mut pi = PROCESS_INFORMATION::default();
        let created = unsafe {
            CreateProcessW(
                exe_w
                    .as_ref()
                    .map_or(PCWSTR::null(), |w| PCWSTR(w.as_ptr())),
                Some(PWSTR(line_w.as_mut_ptr())),
                None,
                None,
                false,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                Some(env.as_ptr() as *const core::ffi::c_void),
                cwd_w
                    .as_ref()
                    .map_or(PCWSTR::null(), |w| PCWSTR(w.as_ptr())),
                &si.StartupInfo,
                &mut pi,
            )
        };
        drop(attrs);
        if created.is_err() {
            let e = io::Error::last_os_error();
            return Err(io::Error::new(
                e.kind(),
                format!("couldn't start {line}: {e}"),
            ));
        }
        let process = unsafe { OwnedHandle::from_raw_handle(pi.hProcess.0) };
        let thread = unsafe { OwnedHandle::from_raw_handle(pi.hThread.0) };
        // In the job before it runs a single instruction (D180).
        crate::job::adopt_handle(process.as_raw_handle());
        let resumed = unsafe { ResumeThread(HANDLE(thread.as_raw_handle())) };
        if resumed == u32::MAX {
            let err = os_err("ResumeThread");
            unsafe {
                let _ = TerminateProcess(HANDLE(process.as_raw_handle()), 1);
            }
            return Err(err);
        }
        drop(thread);
        Ok(WinChild {
            process: Arc::new(process),
        })
    }
}

impl ConPty {
    /// A new size for the console (ConPTY repaints its screen at it).
    pub fn resize(&self, size: PtySize) -> io::Result<()> {
        let mut console = self
            .console
            .lock()
            .map_err(|_| io::Error::other("console lock poisoned"))?;
        let hr = unsafe { (self.resize)(console.hpc, coord(size)) };
        if hr.is_err() {
            return Err(io::Error::other(format!(
                "ResizePseudoConsole failed: HRESULT {:#x}",
                hr.0
            )));
        }
        console.size = size;
        Ok(())
    }

    /// The console's output (a second handle to the same pipe).
    pub fn reader(&self) -> io::Result<File> {
        self.reader.try_clone()
    }

    /// The console's input; once.
    pub fn take_writer(&self) -> io::Result<File> {
        self.writer
            .lock()
            .map_err(|_| io::Error::other("writer lock poisoned"))?
            .take()
            .ok_or_else(|| io::Error::other("writer already taken"))
    }
}

/// `PROC_THREAD_ATTRIBUTE_LIST` storage.
struct AttributeList {
    data: Vec<usize>,
}

impl AttributeList {
    fn new(count: u32) -> io::Result<Self> {
        let mut bytes = 0usize;
        // The first call only reports the size (and "fails" with ERROR_INSUFFICIENT_BUFFER).
        unsafe {
            let _ = InitializeProcThreadAttributeList(None, count, None, &mut bytes);
        }
        let words = bytes.div_ceil(std::mem::size_of::<usize>()).max(1);
        let mut list = Self {
            data: vec![0usize; words],
        };
        unsafe {
            InitializeProcThreadAttributeList(Some(list.ptr()), count, None, &mut bytes)
                .map_err(|_| os_err("InitializeProcThreadAttributeList"))?;
        }
        Ok(list)
    }

    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        LPPROC_THREAD_ATTRIBUTE_LIST(self.data.as_mut_ptr() as *mut core::ffi::c_void)
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.ptr()) };
    }
}

/// The started program (portable-pty's `Child` for the session's waiter and killer).
#[derive(Debug, Clone)]
pub struct WinChild {
    process: Arc<OwnedHandle>,
}

impl WinChild {
    fn handle(&self) -> HANDLE {
        HANDLE(self.process.as_raw_handle())
    }

    fn exit_code(&self) -> io::Result<Option<u32>> {
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(self.handle(), &mut code) }
            .map_err(|_| os_err("GetExitCodeProcess"))?;
        Ok((code != STILL_ACTIVE.0 as u32).then_some(code))
    }
}

impl ChildKiller for WinChild {
    fn kill(&mut self) -> io::Result<()> {
        // Already gone is fine.
        unsafe {
            let _ = TerminateProcess(self.handle(), 1);
        }
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(self.clone())
    }
}

impl Child for WinChild {
    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        Ok(self.exit_code()?.map(ExitStatus::with_exit_code))
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        unsafe { WaitForSingleObject(self.handle(), INFINITE) };
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(self.handle(), &mut code) }
            .map_err(|_| os_err("GetExitCodeProcess"))?;
        Ok(ExitStatus::with_exit_code(code))
    }

    fn process_id(&self) -> Option<u32> {
        let pid = unsafe { GetProcessId(self.handle()) };
        (pid != 0).then_some(pid)
    }

    fn as_raw_handle(&self) -> Option<RawHandle> {
        Some(self.process.as_raw_handle())
    }
}

/// The environment block CreateProcessW takes: `KEY=value\0…\0`, in the builder's order (sorted
/// case-insensitively, as Windows wants).
/// portable-pty starts every builder's environment from the registry's (wezterm's rule), which
/// dropped the PATH the IDE itself was started with: a launcher's venv or nvm, a folder a test
/// put first. VS Code's terminals inherit the IDE's own. So: the IDE's PATH first, then the
/// registry's entries it lacks (something installed since); a PATH the command sets or removes
/// itself (a task's `env`) stays as it is.
fn with_inherited_path(cmd: &CommandBuilder) -> CommandBuilder {
    let mut cmd = cmd.clone();
    let own = cmd
        .iter_extra_env_as_str()
        .any(|(key, _)| key.eq_ignore_ascii_case("PATH"));
    if let (false, Some(base), Ok(current)) = (own, cmd.get_env("PATH"), std::env::var("PATH")) {
        let merged = crate::exec::merge_path(&current, &base.to_string_lossy(), ';');
        cmd.env("PATH", merged);
    }
    cmd
}

fn environment_block(cmd: &CommandBuilder) -> Vec<u16> {
    let mut block: Vec<u16> = Vec::new();
    for (key, value) in cmd.iter_full_env_as_str() {
        block.extend(std::ffi::OsStr::new(key).encode_wide());
        block.push(u16::from(b'='));
        block.extend(std::ffi::OsStr::new(value).encode_wide());
        block.push(0);
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

/// The folder the program starts in: the builder's, else the user's home (portable-pty's rule).
fn working_dir(cmd: &CommandBuilder) -> Option<PathBuf> {
    let dir = cmd
        .get_cwd()
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| {
            cmd.get_env("USERPROFILE")
                .map(PathBuf::from)
                .filter(|p| p.is_dir())
        })?;
    if dir.is_relative() {
        std::env::current_dir().ok().map(|c| c.join(dir))
    } else {
        Some(dir)
    }
}

/// The program to start: as given when it names a folder, else the first PATH folder with that
/// name, or that name plus one of PATHEXT's extensions. None: not found (CreateProcess then
/// searches by the command line, its own rules).
pub fn resolve_exe(
    name: &OsString,
    path: Option<&std::ffi::OsStr>,
    pathext: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let text = name.to_string_lossy();
    if text.contains(['\\', '/', ':']) {
        return Some(PathBuf::from(name));
    }
    let exts: Vec<String> = if pathext.trim().is_empty() {
        vec![".exe".into()]
    } else {
        pathext
            .split(';')
            .map(str::trim)
            .filter(|e| e.starts_with('.') && e.len() > 1)
            .map(str::to_ascii_lowercase)
            .collect()
    };
    let dirs: Vec<PathBuf> = path
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    dirs.iter().find_map(|dir| {
        let exact = dir.join(name);
        if exists(&exact) {
            return Some(exact);
        }
        exts.iter()
            .map(|ext| dir.join(format!("{text}{ext}")))
            .find(|p| exists(p))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn programs_resolve_on_path_with_their_extension() {
        let dirs = std::env::join_paths([PathBuf::from("C:\\a"), PathBuf::from("C:\\b")])
            .unwrap_or_default();
        let files = [
            PathBuf::from("C:\\b\\wsl.exe"),
            PathBuf::from("C:\\a\\npm.cmd"),
        ];
        let exists = |p: &Path| files.iter().any(|f| f == p);
        let ext = ".COM;.EXE;.BAT;.CMD";
        assert_eq!(
            resolve_exe(&"wsl.exe".into(), Some(&dirs), ext, &exists),
            Some(PathBuf::from("C:\\b\\wsl.exe"))
        );
        assert_eq!(
            resolve_exe(&"npm".into(), Some(&dirs), ext, &exists),
            Some(PathBuf::from("C:\\a\\npm.cmd"))
        );
        assert_eq!(resolve_exe(&"nope".into(), Some(&dirs), ext, &exists), None);
        assert_eq!(
            resolve_exe(&"C:\\x\\y.exe".into(), Some(&dirs), ext, &exists),
            Some(PathBuf::from("C:\\x\\y.exe"))
        );
    }

    /// Starts cmd.exe in a real pseudo-console with a verbatim `/s /c` line whose quotes portable-pty
    /// would have mangled, and reads what it prints.
    #[test]
    fn a_verbatim_cmd_line_keeps_its_quotes() {
        let Ok(pty) = open(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        }) else {
            return; // no ConPTY on this machine (CI without a console subsystem)
        };
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        let mut cmd = CommandBuilder::new(&comspec);
        cmd.cwd(std::env::temp_dir());
        let Ok(mut reader) = pty.reader() else {
            return;
        };
        let out = std::sync::Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = out.clone();
        let read = std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                if let Ok(mut o) = sink.lock() {
                    o.extend_from_slice(&buf[..n]);
                }
            }
        });
        let mut child = match pty.spawn(&cmd, Some("/d /s /c \"echo \"quoted words\" & exit 7\"")) {
            Ok(child) => child,
            Err(e) => panic!("spawn failed: {e}"),
        };
        assert!(child.process_id().is_some());
        // The console asks where the cursor is (it inherits the cursor) and waits for the answer
        // the terminal (xterm.js) gives in the app.
        if let Ok(mut w) = pty.take_writer() {
            use std::io::Write;
            let _ = w.write_all(b"\x1b[1;1R");
            let _ = w.flush();
            std::mem::forget(w); // closing the input would end cmd early
        }
        let status = child.wait().map(|s| s.exit_code()).unwrap_or(0);
        assert_eq!(status, 7);
        std::thread::sleep(std::time::Duration::from_millis(300));
        drop(pty); // closes the console: the reader ends
        let _ = read.join();
        let text = String::from_utf8_lossy(&out.lock().map(|o| o.clone()).unwrap_or_default())
            .into_owned();
        assert!(text.contains("\"quoted words\""), "{text:?}");
    }
}
