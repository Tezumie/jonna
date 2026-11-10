//! The Unix side of streams: process groups, terminals (`openpty`), signals, and the one thread
//! programs are started from.

use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};

use super::{signal_number, PtySize};
use crate::error::{Error, Result};

/// A program in its own process group (so a kill reaches what it started), killed if the
/// server dies without ending it.
pub fn own_group(cmd: &mut Command) {
    cmd.process_group(0);
    // SAFETY: getpid has no preconditions.
    let parent = unsafe { libc::getpid() };
    // SAFETY: the closure only makes async-signal-safe calls (prctl, getppid, _exit).
    unsafe {
        cmd.pre_exec(move || {
            die_with_parent(parent, libc::SIGKILL);
            Ok(())
        });
    }
}

/// In a forked child: `signal` when the server goes away (Linux), and gone at once if it
/// already has.
fn die_with_parent(parent: libc::pid_t, signal: libc::c_int) {
    #[cfg(target_os = "linux")]
    // SAFETY: prctl and getppid are async-signal-safe; _exit never returns.
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, signal as libc::c_ulong);
        if libc::getppid() != parent {
            libc::_exit(1);
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (parent, signal);
}

type Job = Box<dyn FnOnce() + Send>;

/// Starts `cmd` on the spawner thread. Linux delivers a child's "parent died" signal when the
/// *thread* that forked it ends, so programs must not be started from short-lived request
/// threads.
pub fn spawn_on_spawner(mut cmd: Command) -> io::Result<Child> {
    static SPAWNER: OnceLock<Option<mpsc::Sender<Job>>> = OnceLock::new();
    let spawner = SPAWNER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        std::thread::Builder::new()
            .name("spawner".into())
            .spawn(move || {
                for job in rx {
                    job();
                }
            })
            .ok()
            .map(|_| tx)
    });
    let (tx, rx) = mpsc::channel();
    let job: Job = Box::new(move || {
        let _ = tx.send(cmd.spawn());
    });
    match spawner {
        Some(s) => {
            if let Err(mpsc::SendError(job)) = s.send(job) {
                job();
            }
        }
        None => job(),
    }
    rx.recv()
        .map_err(|_| io::Error::other("the program couldn't be started"))?
}

/// A terminal: the server keeps the master side; the program gets the other as its standard
/// input, output and errors, in a session of its own with the terminal as its controlling one.
pub struct Pty {
    master: OwnedFd,
    slave: Mutex<Option<OwnedFd>>,
}

impl Pty {
    pub fn open(size: PtySize) -> Result<Self> {
        let (mut master, mut slave): (libc::c_int, libc::c_int) = (-1, -1);
        let ws = winsize(size.rows, size.cols);
        // SAFETY: valid pointers to two ints and a winsize; no name or termios asked for.
        let rc = unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null(),
                &ws,
            )
        };
        if rc != 0 {
            return Err(Error::Pty(io::Error::last_os_error().to_string()));
        }
        // SAFETY: openpty succeeded, so both are open descriptors nothing else owns.
        let (master, slave) =
            unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        for fd in [&master, &slave] {
            // Not inherited by other programs the server starts.
            // SAFETY: fcntl on an open descriptor.
            unsafe {
                libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
            }
        }
        // UTF-8 input mode, so the line editor erases a whole multi-byte character.
        // SAFETY: termios is plain data; tcgetattr fills it on an open terminal.
        unsafe {
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(slave.as_raw_fd(), &mut t) == 0 {
                t.c_iflag |= libc::IUTF8;
                libc::tcsetattr(slave.as_raw_fd(), libc::TCSANOW, &t);
            }
        }
        Ok(Self {
            master,
            slave: Mutex::new(Some(slave)),
        })
    }

    /// Makes `cmd` run in this terminal.
    pub fn attach(&self, cmd: &mut Command) -> Result<()> {
        let guard = self
            .slave
            .lock()
            .map_err(|_| Error::Pty("lock poisoned".into()))?;
        let slave = guard
            .as_ref()
            .ok_or_else(|| Error::Pty("terminal already in use".into()))?;
        let io = || slave.try_clone().map(Stdio::from);
        cmd.stdin(io()?).stdout(io()?).stderr(io()?);
        // SAFETY: getpid has no preconditions.
        let parent = unsafe { libc::getpid() };
        // SAFETY: only async-signal-safe calls (setsid, ioctl, prctl, getppid, _exit).
        unsafe {
            cmd.pre_exec(move || {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                // Standard input is the terminal by now: make it the session's terminal.
                if libc::ioctl(0, libc::TIOCSCTTY, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                die_with_parent(parent, libc::SIGHUP);
                Ok(())
            });
        }
        Ok(())
    }

    /// Closes the server's copy of the program's side (once the program has it).
    pub fn close_slave(&self) {
        if let Ok(mut slave) = self.slave.lock() {
            slave.take();
        }
    }

    pub fn reader(&self) -> Result<File> {
        Ok(File::from(self.master.try_clone()?))
    }

    pub fn writer(&self) -> Result<File> {
        Ok(File::from(self.master.try_clone()?))
    }

    pub fn resize(&self, rows: u16, cols: u16) -> Result<()> {
        let ws = winsize(rows, cols);
        // SAFETY: TIOCSWINSZ reads one winsize from a valid pointer.
        let rc = unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &ws) };
        if rc == -1 {
            return Err(Error::Pty(io::Error::last_os_error().to_string()));
        }
        Ok(())
    }

    /// The terminal's foreground process group (the program running in the shell), if any.
    fn foreground_group(&self) -> Option<libc::pid_t> {
        // SAFETY: tcgetpgrp on an open descriptor.
        let group = unsafe { libc::tcgetpgrp(self.master.as_raw_fd()) };
        (group > 0).then_some(group)
    }
}

fn winsize(rows: u16, cols: u16) -> libc::winsize {
    libc::winsize {
        ws_row: rows.max(1),
        ws_col: cols.max(1),
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

/// Signals process group `pid`; for a terminal also its foreground job and every process in
/// its session (an interactive shell puts each job in a group of its own).
pub fn kill_tree(pid: u32, terminal: bool, pty: Option<&Pty>, signal: &str) {
    let (Some(sig), Ok(pid)) = (signal_number(signal), libc::pid_t::try_from(pid)) else {
        return;
    };
    if pid <= 1 {
        return;
    }
    // SAFETY: kill(2) only sends a signal.
    unsafe {
        libc::kill(-pid, sig);
    }
    if !terminal {
        return;
    }
    if let Some(group) = pty.and_then(Pty::foreground_group) {
        // SAFETY: as above.
        unsafe {
            libc::kill(-group, sig);
        }
    }
    #[cfg(target_os = "linux")]
    for (member, _, session) in super::proc_stats() {
        if session == pid && member > 1 {
            // SAFETY: as above.
            unsafe {
                libc::kill(member, sig);
            }
        }
    }
}

/// Whether a process still runs in group `pid` (or, for a terminal, session `pid`).
#[cfg(target_os = "linux")]
pub fn group_alive(pid: u32, terminal: bool) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    super::proc_stats().into_iter().any(|(_, group, session)| {
        if terminal {
            session == pid
        } else {
            group == pid
        }
    })
}
