//! A stand-in for the desktop framework, for the windowless host build.
//!
//! The IDE's services and commands are written against the desktop framework's paths
//! (`State`, `ipc::Channel`, `async_runtime::spawn`, `AppHandle`…). The host build compiles the
//! same source against this crate under the framework's name, so nothing is written twice. Only
//! what has a meaning without a window is here; code that needs a window is left out of the host
//! build instead of being faked.
//!
//! [`host`] is the other half: what the host's server uses to call a command (the invocation,
//! the argument and reply mapping, the table type).

mod app;
pub mod async_runtime;
mod error;
pub mod host;
pub mod ipc;
pub mod path;

pub use app::{
    AppHandle, Config, Manager, PackageInfo, Runtime, State, Webview, WebviewWindow, Window, Wry,
};
pub use error::{Error, Result};
pub use host_shim_macros::{command, generate_handler};
pub use http;
pub use url::Url;
