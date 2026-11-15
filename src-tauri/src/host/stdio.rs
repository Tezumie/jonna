//! The process's own stdin and stdout as the client's stream.
//!
//! Nothing but frames may reach the client, and nothing but the host may read what the client
//! sends. So the two pipes are taken out of the process's standard handles before anything else
//! runs: stdin becomes the null device and stdout becomes stderr. A stray `println!`, or a
//! program the services start with inherited handles, then writes to stderr and reads nothing,
//! instead of corrupting the stream or eating a request. The pipes themselves are not
//! inheritable, so no program the host starts keeps the client's stream open after the host.

use std::fs::File;
use std::io;

/// The client's stream: (what it sends, where it reads). Call once, first thing.
pub fn take() -> io::Result<(File, File)> {
    imp::take()
}

#[cfg(unix)]
mod imp {
    use std::fs::File;
    use std::io;
    use std::os::fd::{FromRawFd, IntoRawFd, RawFd};

    /// A copy of `fd` that programs the host starts don't inherit.
    fn private_copy(fd: RawFd) -> io::Result<RawFd> {
        // SAFETY: a plain call on a descriptor number; the result is checked.
        let copy = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        if copy < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(copy)
    }

    fn replace(target: RawFd, with: RawFd) -> io::Result<()> {
        // SAFETY: both are open descriptors; the result is checked.
        if unsafe { libc::dup2(with, target) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn take() -> io::Result<(File, File)> {
        let input = private_copy(libc::STDIN_FILENO)?;
        let output = private_copy(libc::STDOUT_FILENO)?;
        let null_in = File::open("/dev/null")?.into_raw_fd();
        replace(libc::STDIN_FILENO, null_in)?;
        // SAFETY: `null_in` is ours and no longer needed once copied onto stdin.
        unsafe { libc::close(null_in) };
        // Stdout becomes stderr; the null device when stderr is closed.
        if replace(libc::STDOUT_FILENO, libc::STDERR_FILENO).is_err() {
            let null_out = std::fs::OpenOptions::new()
                .write(true)
                .open("/dev/null")?
                .into_raw_fd();
            replace(libc::STDOUT_FILENO, null_out)?;
            // SAFETY: as above.
            unsafe { libc::close(null_out) };
        }
        // SAFETY: the two copies are open, ours alone, and owned by the files from here on.
        Ok(unsafe { (File::from_raw_fd(input), File::from_raw_fd(output)) })
    }
}

#[cfg(windows)]
mod imp {
    use std::fs::File;
    use std::io;
    use std::os::windows::io::{FromRawHandle, IntoRawHandle};

    use windows::Win32::Foundation::{
        SetHandleInformation, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT,
    };
    use windows::Win32::System::Console::{
        GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };

    fn os_error(e: windows::core::Error) -> io::Error {
        io::Error::other(e.to_string())
    }

    fn usable(handle: HANDLE) -> bool {
        !handle.is_invalid() && !handle.0.is_null()
    }

    pub fn take() -> io::Result<(File, File)> {
        // SAFETY: plain calls on the process's own standard handles; results are checked.
        unsafe {
            let input = GetStdHandle(STD_INPUT_HANDLE).map_err(os_error)?;
            let output = GetStdHandle(STD_OUTPUT_HANDLE).map_err(os_error)?;
            if !usable(input) || !usable(output) {
                return Err(io::Error::other(
                    "no standard input or output to talk over (use --listen)",
                ));
            }
            // Programs the host starts must not hold the client's stream.
            let _ = SetHandleInformation(input, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0));
            let _ = SetHandleInformation(output, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0));
            let null_in = File::open("NUL")?.into_raw_handle();
            SetStdHandle(STD_INPUT_HANDLE, HANDLE(null_in)).map_err(os_error)?;
            // Stdout becomes stderr; the null device when there is no stderr.
            let error = GetStdHandle(STD_ERROR_HANDLE).ok().filter(|h| usable(*h));
            let stray = match error {
                Some(error) => error,
                None => HANDLE(
                    std::fs::OpenOptions::new()
                        .write(true)
                        .open("NUL")?
                        .into_raw_handle(),
                ),
            };
            SetStdHandle(STD_OUTPUT_HANDLE, stray).map_err(os_error)?;
            Ok((
                File::from_raw_handle(input.0),
                File::from_raw_handle(output.0),
            ))
        }
    }
}
