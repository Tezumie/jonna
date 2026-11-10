//! The server's error type. `code()` gives the same codes as the app's own `Error::code`
//! (`src-tauri/src/error.rs`), so the app can hand a remote failure to the frontend unchanged.

use serde_json::{json, Value};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("path is outside the open workspace: {0}")]
    OutsideScope(String),
    #[error("no workspace folder is open")]
    NoWorkspace,
    #[error("invalid argument: {0}")]
    Invalid(String),
    #[error("terminal error: {0}")]
    Pty(String),
    #[error("watch error: {0}")]
    Watch(String),
    #[error("{0}")]
    Exec(String),
    /// A message the server can't take: unknown method, not a request.
    #[error("protocol error: {0}")]
    Protocol(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<serde_json::Error> for Error {
    // Only parameters are parsed from JSON: a bad one is the caller's mistake.
    fn from(e: serde_json::Error) -> Self {
        Error::Invalid(e.to_string())
    }
}

impl Error {
    /// The app's codes (io kinds the frontend tells apart get their own).
    pub fn code(&self) -> &'static str {
        match self {
            Error::Io(e) => match e.kind() {
                std::io::ErrorKind::NotFound => "NotFound",
                std::io::ErrorKind::AlreadyExists => "AlreadyExists",
                std::io::ErrorKind::PermissionDenied => "PermissionDenied",
                std::io::ErrorKind::IsADirectory => "IsADirectory",
                std::io::ErrorKind::NotADirectory => "NotADirectory",
                _ => "Io",
            },
            Error::OutsideScope(_) => "OutsideScope",
            Error::NoWorkspace => "NoWorkspace",
            Error::Invalid(_) => "Invalid",
            Error::Pty(_) => "Pty",
            Error::Watch(_) => "Watch",
            Error::Exec(_) => "Exec",
            Error::Protocol(_) => "Protocol",
        }
    }

    pub fn to_json(&self) -> Value {
        json!({ "code": self.code(), "message": self.to_string() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_match_the_app() {
        let missing = Error::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "gone"));
        assert_eq!(missing.code(), "NotFound");
        assert_eq!(missing.to_json()["message"], "gone");
        assert_eq!(Error::OutsideScope("/x".into()).code(), "OutsideScope");
        let bad: Error = serde_json::from_str::<u32>("\"x\"")
            .err()
            .map(Error::from)
            .unwrap_or(Error::NoWorkspace);
        assert_eq!(bad.code(), "Invalid");
    }
}
