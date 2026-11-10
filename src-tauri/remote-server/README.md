# remote-server (`ide-server`)

The IDE's remote development server. A window working on a folder on another machine runs it
there (over SSH, or in WSL, or as a local process) and does all its file, index, search, watch,
process and port work through it, over one connection on standard input and output. The
protocol is [`docs/remote.md`](../../docs/remote.md); this crate implements it. The server never
names the product (the app passes anything product-specific, such as where it lives).

A standalone crate (its own `[workspace]`, its own `target/`), not part of the app's build. Std
threads only: a reader thread for frames, one writer thread owning standard output (every frame
goes through one bounded channel), a thread per request, threads per stream. Behavior is ported
from the app's own modules so a remote folder acts as a local one.

## Modules

- `main.rs`: the command line (`--stdio`, `--version`, the internal `--print-env`).
- `server.rs`: the connection: frames in, a thread per request, the method table, one response
  each; notifications go to `streams`.
- `frame.rs`: 4-byte big-endian length + JSON, the 64 MiB limit.
- `outbox.rs`: responses and notifications to the writer thread, in order.
- `error.rs`: the error type; `code()` is the app's `Error::code`.
- `workspace.rs`: the scope (the app's `fs::Workspace`): `resolve`, `resolve_under`,
  `resolve_entry`, `root_of`, `scope_root`, several folders.
- `files.rs`: `list_dir` (sorting, always-hidden names, gitignore-dimmed), `stat`, `read`,
  atomic `write`, create / rename / move / copy (" copy" names) / delete (the app's `fs`).
- `index/`: the file index per folder (`ignore` walk, watcher with no file-id cache, D250) and
  the fuzzy ranking (`fuzzy.rs`, the app's), `index.changes`.
- `search/`: the app's search (grep-regex / grep-searcher, globs, case / word / regex,
  multi-line, limits), named searches that replace or cancel each other.
- `watch.rs`: `watch.setDirs` sets, `watch.batch`; polling on network file systems.
- `streams/`: `proc.spawn` (pipes or a terminal, process groups, kill tree, exit after the last
  data), `tcp.connect` (`tcp.rs`), `tcp.listening` (`ports.rs`, `/proc/net/tcp*`), and
  `unix.rs` (openpty, sessions, signals, the spawner thread for "die with the server").
- `system.rs`: user, home, login shell (`hello`), `~`, and the login shell's environment
  programs start with.

Platform-neutral logic is unit-tested on any OS with `cargo test`; the Unix-only parts
(terminals, process groups, `/proc`) are behind `#[cfg(unix)]` / `#[cfg(target_os = "linux")]`
and covered by the end-to-end test. On Windows `proc.spawn` runs pipes only (for the unit tests);
the server is built for Linux.

## Build and test

```sh
# In this folder
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --target x86_64-unknown-linux-musl -- -D warnings
cargo test

# From the repository root: static Linux binaries into src-tauri/resources/server/<target>/
node scripts/build-server.mjs            # x86_64 and aarch64 (musl, rust-lld)
node scripts/build-server.mjs x86_64     # one target

# End to end, in WSL (Ubuntu by default; needs git and python3)
node scripts/test-server.mjs [distro]
```

The unit tests also run on Linux from Windows (the Unix-only ones included): build them with
`RUSTFLAGS="-C linker=rust-lld -C link-self-contained=yes" cargo test --target
x86_64-unknown-linux-musl --no-run` and run the printed executable with `wsl.exe -e`.

`rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl` once. The release
profile optimizes for size (`opt-level = "z"`, LTO, stripped); panics unwind so a bug fails one
request instead of ending the server.

## Dependencies

All crates the app already depends on, all permissive: `base64`, `regex`, `serde`,
`serde_json`, `thiserror`, `libc`, `notify-debouncer-full` (MIT/Apache-2.0); `ignore`,
`grep-matcher`, `grep-regex`, `grep-searcher` (MIT/Unlicense); `notify` (CC0-1.0, pulling
`inotify`, ISC, and `mio`, MIT). Terminals use libc's `openpty` directly.
