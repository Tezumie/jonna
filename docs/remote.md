# Remote development: the server and its protocol

A window can work on a folder on another machine over SSH (D252). The IDE copies a small server
(`ide-server`, the crate in `src-tauri/remote-server/`) to the remote and talks to it over one
connection: the standard input and output of `ssh <host> <server> --stdio`. Everything the
window does with the folder goes through it: files, the file list, search, watching, and every
program the IDE runs there (git, terminals, tasks, the agent's commands, language servers).

The UI tests and local development use the same server without SSH: started as a local process
(`--stdio` over a pipe), or inside WSL (`wsl.exe -e <server> --stdio`), it is the same protocol.
`node scripts/test-server.mjs` runs it in WSL and checks every method below.

## Where the server lives on the remote

`~/<serverDir>/<version>-<hash>/ide-server`, where `serverDir` is product.json's
`serverDataFolderName` (the app passes it; the server never names the product) and `hash` the
first 12 hex digits of the bundled binary's SHA-256 (a rebuilt server is never taken for an
installed one). The app checks that file's `--version` first and uploads the binary for the
remote's `uname -sm` when it's missing or different (`head -c <size> > tmp && chmod && mv`, in
the same connection). Builds: `x86_64-unknown-linux-musl` and
`aarch64-unknown-linux-musl` (static, no glibc version to match), from any host with
`node scripts/build-server.mjs` (rust-lld, no C toolchain needed), into
`src-tauri/resources/server/<target>/ide-server`. `version` is the crate's version
(`src-tauri/remote-server/Cargo.toml`).

Command line: `ide-server --stdio` serves; `ide-server --version` prints the version alone;
anything else prints usage to standard error and exits 2. (`--print-env` is internal: the
login shell runs it to hand its environment back, see Processes.)

## Framing

Each message is a 4-byte big-endian length followed by that many bytes of UTF-8 JSON. Nothing
else is written to standard output (the server's own diagnostics go to standard error, which the
app keeps for the connection log). A message over 64 MiB is a protocol error and ends the
connection; a frame that isn't JSON is logged and ignored. Binary data (file contents, a
stream's bytes) is base64 in a `data` field.

Three kinds of message:

- **Request** (app → server): `{ "id": 7, "method": "fs.read", "params": { … } }`. Exactly one
  response comes back for each id (any JSON value; echoed as is), in any order: requests run
  concurrently. Missing `params` is `{}`.
- **Response** (server → app): `{ "id": 7, "result": … }` or
  `{ "id": 7, "error": { "code": "OutsideScope", "message": "…" } }`. The codes are the app's own
  (`Error::code` in `src-tauri/src/error.rs`), so a remote error can go to the frontend as it is:
  `Io`, and for the io kinds the frontend tells apart `NotFound`, `AlreadyExists`,
  `PermissionDenied`, `IsADirectory`, `NotADirectory`; then `OutsideScope`, `NoWorkspace`,
  `Invalid` (bad parameters too), `Exec`, `Pty`, `Watch`, and `Protocol` (an unknown method).
  A cancelled search isn't an error: it ends with `done` (`cancelled: true`).
- **Notification** (either way, no id, no response): `{ "notify": "stream.data", "params": … }`.

## Methods

### Session
- `hello { version? }` → `{ version, os, arch, home, shell, user, pid }` (`os` `"linux"`,
  `arch` `"x86_64"` or `"aarch64"`). `shell`: the login shell (`$SHELL`, else `/etc/passwd`'s,
  else `/bin/sh`). A `version` other than the server's is an error (`Invalid`): the app uploads
  the right one.
- `shutdown {}` → `null`, then the server exits (it also exits when its standard input closes).
  Either way everything it started ends: programs get SIGTERM (terminals SIGHUP), and SIGKILL
  after 500 ms; connections close. Programs also get SIGKILL (terminals SIGHUP) from the kernel
  if the server itself is killed.

### Workspace scope
The same rules as the app's `fs::Workspace`: every `fs.*` path must be absolute and inside a
workspace folder (canonical, symlinks resolved, `..` can't escape, also through folders that
don't exist yet); deleting, renaming or moving a folder itself is refused (`OutsideScope`).
A symlink is deleted, renamed or moved as the link, never what it points at.
- `ws.open { path }` → canonical path (the first folder; replaces the others). `~` expands.
- `ws.setFolders { paths }` → `[{ path, canonical, error }]` (the app's `FolderStatus`:
  `canonical` or `error`, a string, the other `null`), one per path: the other folders, replacing
  the earlier ones. The app decides which folders are let in; the server only checks each is an
  existing absolute folder. With no folder open: `NoWorkspace`.
- `ws.close {}` → `null`.

The file index follows the folders: every folder is indexed and watched from `ws.open` /
`ws.setFolders` on.

### Files (in scope)
- `fs.listDir { path }` → `[{ name, path, kind: "file"|"dir", isSymlink, ignored }]` (sorted as
  the app sorts: folders first, natural order; `.git`, `.hg`, `.svn`, `.DS_Store`, `Thumbs.db`
  left out; `ignored` from .gitignore / .ignore; a link's `kind` is its target's).
- `fs.stat { path }` → `{ kind, size, mtimeMs, readonly }`.
- `fs.exists { path }` → `bool` (never errors for a missing file; out of scope is still an error).
- `fs.read { path, maxBytes? }` → `{ data, truncated }` (base64). Refuses a folder. At most 48 MiB
  (a frame's worth): without `maxBytes` a larger file is refused (`Invalid`) rather than cut;
  with it, the first `maxBytes` and `truncated: true` when there was more.
- `fs.write { path, data }` → `null`. Atomic (temp file, fsync, rename), keeping the file's mode,
  writing a symlink's target; missing folders on the way are created.
- `fs.createFile { parent, name }` / `fs.createDir { parent, name }` → the new path (`name` one
  plain segment; an existing one is `AlreadyExists`).
- `fs.rename { path, newName }` → new path. `fs.move { path, dest }` / `fs.copy { path, dest }` →
  new path (into folder `dest`, also accepted as `destDir`; a move onto a taken name is
  `AlreadyExists`, a copy gets " copy", " copy 2" before the extension as the app does; a copy
  keeps links as links).
- `fs.delete { path }` → `null` (recursive for a folder; never a workspace folder itself).
- `fs.canonical { path }` → canonical path (in scope).

### Browsing (outside the workspace, read-only)
For the folder picker before a folder is open, and "Open file…" on the remote.
- `browse.listDir { path }` → as `fs.listDir`, any readable folder (`~` expands to home).
- `browse.stat { path }` → as `fs.stat` or `null`.

### File index and search
- `index.query { query, limit?, root? }` → `{ items: [{ path, score, positions, root? }], total,
  indexing, truncated }`, the app's `QueryResult`: `path` relative to its folder, `/` separators;
  `root` (the folder, absolute) only on items from a folder other than the first; `positions`
  char indices for highlighting; ranked as the app's fuzzy matcher ranks (an empty query lists
  the folders' own files before dependency and build folders). `limit` defaults to 100, at most
  1000 (50,000 for an empty query). `root` limits it to one workspace folder. `indexing`: a
  (re)build is running, so the list may be incomplete.
  Each folder is indexed with an `ignore` walk honoring .gitignore (`.git` skipped, at most
  300,000 files each) and kept current by its watcher (on Linux one non-recursive inotify watch
  per indexed folder, so ignored trees such as node_modules cost nothing).
- `index.listen {}` → `bool` (whether the first folder is being watched; false: poll instead);
  then `index.changes { paths, overflow }` notifications (absolute paths of files that changed on
  disk, debounced 300 ms, at most 1000; `overflow`: more changed than listed).
- `search.start { search, roots?, options }` → `null`. `search` is the app's id for this search
  (any JSON value); a new `search.start` with the same id replaces it, and the replaced one sends
  nothing more. `roots` default to every workspace folder (each must be one). `options` is the
  app's `SearchOptions` (`query`, `isRegex`, `matchCase`, `wholeWord`, `include`, `exclude`,
  `maxResults`, `useIgnoreFiles`, `followSymlinks`; replace's fields are ignored). An empty query
  or a bad pattern or glob is an error now (`Invalid`). Results arrive as
  `search.event { search, event }` notifications, `event` the app's `SearchEvent`:
  `{ kind: "file", path, rel, matches: [{ line, text, ranges }] }` per matching file (`rel` to
  its own folder; a file in nested folders once), then
  `{ kind: "done", files, matches, truncated, cancelled, durationMs }`.
  `search.cancel { search }` → `null`; the search then ends with `done`, `cancelled: true`.

### Watching
- `watch.setDirs { dirs, recursive?, watcher? }` → `null`. Replaces the folders watched by the set
  named `watcher` (default `""`; the explorer and the open documents can each have one), each
  non-recursively unless `recursive`. Absolute folders anywhere (as browsing, it only tells what
  changed); missing ones are skipped; no `dirs` stops the set. Changes come as
  `watch.batch { watcher, dirs, paths }` (the app's `WatchBatch` plus the set's name: the folders
  whose listing may have changed, and the changed paths, outside `.git`, debounced 150 ms).
  Inotify where it works; polling (2 s) on network file systems (NFS, SMB, 9p as in WSL's
  `/mnt/c`, FUSE such as sshfs) and where inotify refuses a watch (out of watches).

### Processes
- `proc.spawn { cwd, program, args?, env?, pty?: { rows, cols } }` → `{ stream, pid }`. The
  response always comes before the stream's first `stream.data`. `cwd` (`~` expands; `""` is
  home) isn't scope-checked: terminals and tasks may start anywhere. `program` `""` is the login
  shell with `-l` before `args` (with `pty`: an interactive login shell). `env`: variables to set
  (`null` value: unset) over the login environment: the server reads its login shell's
  environment once (`$SHELL -l -c` running `ide-server --print-env`, 10 s at most, else its own),
  so programs see the PATH the user's profile sets (nvm, cargo, pyenv) although `ssh host cmd`
  starts no login shell. Without `pty`, standard input, output and errors are three pipes, and the
  program runs in its own process group. With it, one terminal (`openpty`) in a session of its
  own, its controlling terminal; `TERM` is `xterm-256color` and `LANG` `C.UTF-8` unless `env` (or
  the environment, for `LANG`/`LC_ALL`) says otherwise. A program that can't start, or a missing
  `cwd`, is `Exec`; a terminal that can't open is `Pty`.
- Notifications from the server: `stream.data { stream, fd, data }` (`fd` 1 or 2; 1 for a
  terminal), `stream.exit { stream, code, signal }` after the last data: `code` the exit code or
  `null` when a signal ended it, `signal` its number (Linux numbering) or `null`. Output still
  coming 2 s after the program exited (a backgrounded child holding the pipe) is dropped.
- Notifications to the server: `stream.write { stream, data }`, `stream.closeStdin { stream }`
  (a terminal ignores it: Ctrl+D is the program's), `stream.resize { stream, rows, cols }`
  (terminals), `stream.kill { stream, signal? }` (a name such as `TERM`, `SIGINT`, `KILL`, or a
  number; `TERM` by default): the whole process group, for a terminal its whole session and
  foreground job. Notifications for a stream that has ended are ignored.
- Flow: the server reads a stream's output in chunks of up to 64 KiB and sends each as it comes;
  frames queue for standard output (at most 1024), so a program printing faster than the
  connection carries it waits instead of filling memory.
- Stream ids are integers the server assigns, one sequence for programs and connections.

### Ports
- `tcp.connect { host, port }` → `{ stream }`: a TCP connection made by the server (the browser
  preview's forwarded ports; `host` `""` is `localhost`, 10 s to connect, else `Exec`). Bytes
  flow as `stream.data` (fd 1) / `stream.write`; `stream.closeStdin` half-closes;
  `stream.kill` closes; `stream.exit { code: 0 }` when the remote side closes.
- `tcp.listening {}` → `[{ port, host, pid?, process? }]`: ports listening on the remote (from
  `/proc/net/tcp` and `tcp6`, LISTEN state), for "Forwarded ports"; one per port and host (a
  v4-mapped address shown as v4), sorted by port. `pid` and `process` (its `comm`) when the
  server may read the owner's `/proc/<pid>/fd` (the user's own programs; root sees all).

## The app's side

- `src-tauri/src/remote/`: the connection (the SSH process, frames, ids, streams), the upload,
  reconnects. A window is either local or connected to one remote, named by its authority
  (`transport.rs`): `ssh:<host>` runs the user's own `ssh`, `wsl:<distribution>` runs
  `wsl.exe`, `container:[user@]<id>` runs `docker exec` (below). In a remote window the
  workspace's paths are the remote's POSIX paths (`/home/me/app`), and the fs, index, search and
  watch commands send them to the server.
- Programs: git, the agent's commands, language servers and debug adapters build a `Command` as
  they do locally; in a remote window `remote::command` makes it run the IDE's own binary in relay
  mode (`--remote-relay`), which connects to the window over loopback (a token in its
  environment) and runs the program on the remote through `proc.spawn`, passing its standard
  input, output, errors and exit code through. So every caller works unchanged, as with WSL
  (D192), at the cost of a local process per program. Terminals and tasks are remote ptys the
  terminal manager drives directly (`remote/pty.rs`): no local console, real resizes.
- The setup is one transport connection (one sign-in): a script prints `uname -sm`, then starts
  `~/<serverDir>/<version>-<hash>/ide-server` (`hash`: the first 12 hex digits of the bundled
  binary's SHA-256) or reads the upload (`head -c <size>`) and starts that.
- Ports: the browser preview's `localhost:<port>` in a remote window is forwarded to the remote
  (`tcp.connect`), the same port number locally when it's free.

## Dev containers (D266)

A dev container is a remote reached with `docker exec` instead of ssh: the window's authority is
`container:[user@]<id>` (`transport.rs`, `Kind::Container`), the transport runs
`docker exec -i [-u user] <id> sh -c <setup script>`, and everything after that (the upload, the
server, the protocol, programs through the relay, ptys, ports) is the SSH window's. The docker
program is `docker` on PATH or `remote.containers.dockerPath` (`remote/docker.rs`).

Bringing the container up is the frontend's (`src/core/workspace/devContainer.ts` plans,
`src/extensions/remote/devContainers.ts` runs, `remote_docker` runs docker or the devcontainers
CLI by argv, never through a shell):

- the configuration: `.devcontainer/devcontainer.json`, `.devcontainer.json`, or
  `.devcontainer/<name>/devcontainer.json`; JSONC with `${localWorkspaceFolder}`,
  `${localWorkspaceFolderBasename}`, `${containerWorkspaceFolder}`, `${localEnv:NAME[:default]}`;
- with the devcontainers CLI installed (and required for Compose and features):
  `devcontainer up --workspace-folder <folder> --config <file>`, its JSON answer naming the
  container, user and folder;
- else docker alone: the folder's container is found by its labels
  (`devcontainer.local_folder`, `devcontainer.config_file`, VS Code's names, so either finds the
  other's); a stopped one is started (then `postStartCommand`); none is built (`docker build`,
  image `vsc-<folder>-<hash>`) or pulled and run detached with the folder bind-mounted, the
  configuration's mounts, environment, user and `runArgs`, kept up by a sleep loop unless
  `overrideCommand` is false; then `onCreateCommand`, `updateContentCommand`,
  `postCreateCommand`, `postStartCommand` (`docker exec -u <remoteUser> -w <workspaceFolder>`);
- `initializeCommand` runs on this machine first; `postAttachCommand` after the window is in;
  `forwardPorts` (numbers) are forwarded as the remote's ports are.

The UI test (devcontainer-m7-24) uses `tests/fixtures/fake-docker`, whose containers are WSL's
Ubuntu.
