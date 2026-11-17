//! Snapshots (D435): a project's files as they are, captured on one computer and restored on
//! another or later. Git is asked, never bypassed, and nothing is written inside `.git` to
//! make one.
//!
//! - **A git project:** the commit checked out and its branch; commits no remote has (as git
//!   bundles, each carrying only what the bundles before it lack); what is staged (a patch);
//!   and every file that differs from that commit, new files included. Ignored files stay out.
//! - **A folder without git:** every file, minus well-known heavy folders and oversized files.
//!
//! A snapshot is a manifest (stored as chunks) that names each file's chunks, and a record
//! that names every chunk the snapshot needs, so the server keeps them while it exists.

mod capture;
mod compare;
mod git;
mod manifest;
mod paths;
mod restore;
#[cfg(test)]
mod tests;

pub use capture::{create, estimate, fingerprint, CreateOptions, Created, Estimate};
pub use compare::{compare, read_text, Compared, FileText, Standing, COMPARE_MAX};
pub(super) use git::safe_remote;
pub use manifest::{
    list, manifest, pinned, rewrite, summary, within_bytes, ListedFile, Manifest, Summary,
    MAX_COPY_BYTES,
};
pub(super) use paths::unsafe_name;
pub use restore::{local_changes, restore, restore_file, RestoreOptions, Restored};

// Public as before, though nothing outside names them yet: they are what the types and
// functions above are made of.
#[allow(unused_imports)]
pub use capture::LeaveOut;
#[allow(unused_imports)]
pub use compare::{ComparedFile, TEXT_MAX_BYTES};
#[allow(unused_imports)]
pub use manifest::{carried_bytes, Bundle, FileEntry, GitState};
