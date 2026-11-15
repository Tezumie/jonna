//! The stand-in's error type (the framework's `Error`, as far as the IDE meets it).

use std::fmt;

#[derive(Debug)]
pub enum Error {
    /// A task panicked or was cancelled.
    Join(String),
    /// A folder the OS didn't give (no home directory, for example).
    UnknownPath,
    /// The client stopped reading a channel, or is gone.
    ChannelClosed,
    Json(serde_json::Error),
    Io(std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Join(message) => write!(f, "task failed: {message}"),
            Error::UnknownPath => f.write_str("unknown path"),
            Error::ChannelClosed => f.write_str("the channel is closed"),
            Error::Json(e) => write!(f, "{e}"),
            Error::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Json(e) => Some(e),
            Error::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Json(e)
    }
}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}
