//! Sync (D435): the account's devices and keys, encrypted records and chunks, and what is built on
//! them. The server stores only what was sealed here (`crypto`).

pub mod api;
pub mod chats;
pub mod chunks;
pub mod crypto;
pub mod incoming;
pub mod project;
pub mod records;
pub mod seen;
pub mod share;
pub mod snapshot;
pub mod user_files;
pub mod vault;
