//! Sync (D435): the account's devices and keys, encrypted records and chunks, and what is built on
//! them. The server stores only what was sealed here (`crypto`).

pub mod api;
pub mod chats;
pub mod chunks;
pub mod crypto;
pub mod project;
pub mod records;
pub mod vault;
