//! Diagnostics and release support (D204): the session log and the panic hook (`log`), redaction
//! (`redact`), the problem report's zip (`zip`), and what a start needs to know about the last
//! one: whether to start with extensions off (a one-shot flag file, or `--disable-extensions`) and
//! the version that ran before (for "What's new").

pub mod log;
pub mod redact;
pub mod zip;

use std::fs;
use std::path::Path;

/// `<data>/next-start-extensions`: "off" or "on" for the next start only.
const NEXT_START_FILE: &str = "next-start-extensions";
/// `<data>/last-version`: the version that ran last.
const LAST_VERSION_FILE: &str = "last-version";

/// Why this session runs with extensions off, if it does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtensionsOff {
    /// `--disable-extensions` on the command line.
    CommandLine,
    /// "Restart with extensions off".
    Restart,
}

impl ExtensionsOff {
    pub fn as_str(self) -> &'static str {
        match self {
            ExtensionsOff::CommandLine => "commandLine",
            ExtensionsOff::Restart => "restart",
        }
    }
}

/// Reads (and removes) the one-shot flag: "on" overrides `--disable-extensions` ("Restart
/// normally" from a session started with the flag, whose arguments a restart repeats).
pub fn take_extensions_off(data: &Path, command_line: bool) -> Option<ExtensionsOff> {
    let file = data.join(NEXT_START_FILE);
    let flag = fs::read_to_string(&file).ok();
    if flag.is_some() {
        let _ = fs::remove_file(&file);
    }
    match flag.as_deref().map(str::trim) {
        Some("off") => Some(ExtensionsOff::Restart),
        Some("on") => None,
        _ if command_line => Some(ExtensionsOff::CommandLine),
        _ => None,
    }
}

/// What the next start does: `Some(true)` extensions off, `Some(false)` on (even with the
/// command-line flag), `None` as usual.
pub fn set_next_start(data: &Path, extensions_off: Option<bool>) -> std::io::Result<()> {
    let file = data.join(NEXT_START_FILE);
    match extensions_off {
        Some(off) => crate::store::atomic_write(&file, if off { b"off" } else { b"on" })
            .map_err(|e| std::io::Error::other(e.to_string())),
        None => match fs::remove_file(&file) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        },
    }
}

/// The next start's flag, if one is set ("off" / "on").
pub fn next_start(data: &Path) -> Option<String> {
    fs::read_to_string(data.join(NEXT_START_FILE))
        .ok()
        .map(|s| s.trim().to_string())
}

/// Records `current` as the last version and returns the one before (None on a first start).
pub fn record_version(data: &Path, current: &str) -> Option<String> {
    let file = data.join(LAST_VERSION_FILE);
    let previous = fs::read_to_string(&file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    if previous.as_deref() != Some(current) {
        let _ = crate::store::atomic_write(&file, current.as_bytes());
    }
    previous
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ide-diag-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn the_flag_is_one_shot_and_overrides_the_command_line() {
        let dir = temp("flag");
        assert_eq!(take_extensions_off(&dir, false), None);
        assert_eq!(
            take_extensions_off(&dir, true),
            Some(ExtensionsOff::CommandLine)
        );
        set_next_start(&dir, Some(true)).expect("set");
        assert_eq!(next_start(&dir).as_deref(), Some("off"));
        assert_eq!(
            take_extensions_off(&dir, false),
            Some(ExtensionsOff::Restart)
        );
        assert_eq!(take_extensions_off(&dir, false), None); // consumed
        set_next_start(&dir, Some(false)).expect("set");
        assert_eq!(take_extensions_off(&dir, true), None);
        set_next_start(&dir, Some(true)).expect("set");
        set_next_start(&dir, None).expect("clear");
        assert_eq!(next_start(&dir), None);
        set_next_start(&dir, None).expect("clear twice");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn versions_are_remembered() {
        let dir = temp("version");
        assert_eq!(record_version(&dir, "0.1.0"), None);
        assert_eq!(record_version(&dir, "0.1.0").as_deref(), Some("0.1.0"));
        assert_eq!(record_version(&dir, "0.2.0").as_deref(), Some("0.1.0"));
        assert_eq!(record_version(&dir, "0.2.0").as_deref(), Some("0.2.0"));
        let _ = fs::remove_dir_all(&dir);
    }
}
