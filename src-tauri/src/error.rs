//! One error type for every service, serialized to the frontend as `{ code, message }`.

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

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
    /// git failed; the message is git's own (stderr), trimmed.
    #[error("{0}")]
    Git(String),
    #[error("git is not installed or not on PATH")]
    GitMissing,
    /// The IDE's git is paused for a repository whose settings changed after a sandboxed
    /// command ran there (D392, `git::guard`).
    #[error("{0}")]
    GitSettingsChanged(String),
    #[error("language server error: {0}")]
    Lsp(String),
    /// A model provider failed (message from the provider or the connection).
    #[error("{0}")]
    Ai(String),
    /// The model can't call tools natively (the agent falls back to the text protocol).
    #[error("{0}")]
    AiNoTools(String),
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Exec(String),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Tauri(#[from] tauri::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    /// Stable machine-readable code; the TS side maps it to `IpcError.code`.
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
            Error::Git(_) => "Git",
            Error::GitMissing => "GitMissing",
            Error::GitSettingsChanged(_) => "GitSettingsChanged",
            Error::Lsp(_) => "Lsp",
            Error::Ai(_) => "Ai",
            Error::AiNoTools(_) => "AiNoTools",
            Error::Cancelled => "Cancelled",
            Error::Exec(_) => "Exec",
            Error::Json(_) => "Json",
            Error::Tauri(_) => "Tauri",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("IpcError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}
