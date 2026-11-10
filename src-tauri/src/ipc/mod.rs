//! Public Tauri commands, one file per domain. Each command is a thin, scope-checked wrapper over
//! its service module; the TS side wraps these again in `src/core/ipc/` (no raw `invoke` elsewhere).
//! All commands are `async` so they run off the main thread and never block the UI.

pub mod accounts;
pub mod acp_agents;
pub mod agent;
pub mod agent_windows;
pub mod app;
pub mod browser;
pub mod desktop;
pub mod diagnostics;
pub mod extensions;
pub mod fs;
pub mod git;
pub mod history;
pub mod instances;
pub mod mcp;
pub mod notify;
pub mod plugins;
pub mod process;
pub mod remote;
pub mod remote_image;
pub mod settings;
pub mod skills;
pub mod speech;
