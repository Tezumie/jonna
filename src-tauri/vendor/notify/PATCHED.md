# notify 8.2.0, patched

A copy of [notify](https://github.com/notify-rs/notify) 8.2.0 (CC0-1.0, `LICENSE-CC0`), used
through `[patch.crates-io]` in `src-tauri/Cargo.toml`. One change, in `src/windows.rs`
`handle_event` (search for "Patched"): when ReadDirectoryChangesW reports lost changes
(`ERROR_NOTIFY_ENUM_DIR`, or an overflow: success with an empty buffer), the watch goes on and a
`Flag::Rescan` event is sent. Upstream unwatched the folder on that error and logged it, so a burst
of changes (a git checkout, an install, a build) left the IDE's file watcher dead until the folder
was opened again (D280). Drop this copy once upstream handles the error.
