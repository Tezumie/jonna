# src-tauri/src

The native side: Tauri commands are registered in `lib.rs` and implemented by the modules below
(`ipc/` holds the thin `#[tauri::command]` layer; each other folder is one service). One section
per folder.

## accounts/

The IDE account (D140, D414): OAuth code + PKCE through the system browser with a loopback
redirect (`mod.rs`); the saved session, tokens in the OS keychain and the profile check that
refreshes rotating tokens (`session.rs`). Server: product.json's `accountsUrl`; endpoints in
docs/accounts.md. Commands in `ipc/accounts.rs`.

## node_runtime.rs

The pinned Node.js for extensions' code (D267): the version and each platform's archive
SHA-256, `ext_node_status` (the downloaded program, if any) and `ext_node_install` (downloaded
from nodejs.org through `acp_agents::install_into` into `<data>/runtimes/node/<version>/`).

## speech/

Dictation without a key (D384): Whisper on the CPU with candle (pure Rust). `mod.rs`: the
models (whisper.cpp's multilingual `base` 60 MB and `small` 190 MB, q5_1, pinned by commit and
SHA-256), downloaded on first use through `acp_agents::download` into `<data>/speech/` with a
`.sha256` mark once verified; status, cancel, remove; `transcribe` on a worker thread, the loaded
model kept 3 minutes. `ggml.rs` reads whisper.cpp's file format into candle's tensors (names
mapped to Hugging Face's; compressed weights widened to f16, much faster in candle; data copied
to aligned memory). `model.rs` is the network, adapted from candle's with a decoder that keeps
its keys and values. `decode.rs`: log-mel segments of 30 s, the language asked or heard, greedy
decoding with Whisper's suppressed tokens, the no-speech check, a silence gate and a loop guard.
Commands in `ipc/speech.rs`: `speech_status`, `speech_install` (a progress Channel; a local
`url` + `sha256` in test builds), `speech_cancel`, `speech_remove`, `speech_transcribe` (a raw
body of 16 kHz f32 samples, headers `x-model`, `x-language`). Dev builds compile candle and its
matrix crates optimized (Cargo.toml) so the UI tests transcribe in seconds.

## acp_agents/

External ACP agents from the ACP agent registry (D215). `mod.rs`: the registry file fetched from
its CDN (`acp_registry_fetch`; another address only in debug builds, for the UI tests) and cached
in `<data>/acp-agents/registry.json` (`acp_registry_cached`), agents' icons (`acp_registry_icon`,
`icons/<id>.svg`, a week), and binary agents: `acp_agent_install` streams the download (progress
over a Channel, `acp_agent_cancel`) into a scratch folder, checks its SHA-256 when the registry
lists one, unpacks it and moves it to `<data>/acp-agents/<id>/<version>/` (older versions
removed), returning the command's absolute path; `acp_agent_remove`, `acp_agents_on_disk`.
https to public hosts only (each redirect checked). `archive.rs`: .zip (the `extensions::vsix`
reader), .tar.gz, .tar.bz2 (`tar`, `flate2`, `bzip2`) or a raw binary; zip slip, absolute
names, Windows device names and links out of the folder are refused, nothing is written through a
link, only the executable bit of modes is kept, sizes are capped.

## agent/

Agent session transcripts (`<appData>/agent/sessions/<id>.json`) and checkpoints — the contents of
files before an agent turn's changes were applied (`agent/checkpoints/<session>/<turn>.json`; the
first snapshot of a file in a turn wins). Never stored in the repository. `usage.rs` (D201): the
usage log, one JSON line per model request in `agent/usage/<n>.jsonl` (a file per 10 days, 90
days and 20 MB kept; `usage_append`, `usage_load`, `usage_clear`). Local only. D204: `docs.rs`
keeps @docs indexes (`agent/docs/<name>.json`; `docs_index_save` / `_load` / `_delete`);
`worktree.rs` sets up and compares worktree agents (`agent_worktree_copy`, `agent_worktree_run`,
`agent_worktree_diff`, `agent_worktree_apply`), only on a linked worktree of the open repository.
D208: `scratch.rs` — a chat's private folder with no folder open (`agent/scratch/<session>`,
`agent_scratch_dir`; removed with the chat): an external agent's process (`lsp_start`) and
commands (`exec_run`) may run there, and its file requests go through `agent_scratch_read` /
`_write`, confined to that one folder (`fs::resolve_under`, the workspace's own rule).
D233: `reports.rs` keeps helper reports waiting for a chat (`agent/pending-reports/<helper>.json`,
`agent_report_put` / `_list` / `_claim`: a claim renames the file first, so exactly one window of
all takes it); `render.rs` loads a documentation page that needs JavaScript in a hidden incognito
window (`docs-render-<n>`, same-origin navigations only, no new windows) and returns
`document.body.innerText` once the page settles (`docs_render`; the page may only call
`docs_render_post`, capability `docs-render.json`); `tree.rs` lists an external agent's folder with
sizes and times for its changes without git (`agent_tree_stats`: the open folder or a chat's
private folder, .gitignore honored, dependency and build folders skipped). `agent_sessions_watch` /
`_unwatch` watch the saved chats' folder for the worktree overview.
`session_index.rs`: `agent_session_list` reads a chat only when its file's stamp (size and modified
time) moved; the metas are kept in memory and in `agent/sessions/.meta-index` (atomic, checked
against each file's stamp before use, rebuilt when missing or corrupt). A save or delete forgets
that chat's entry.
D328: `socket.rs` — the agent's WebSocket monitors (`agent_monitor_socket_open` / `_close`,
state `monitor_sockets`): `ws://` / `wss://` to the address the user approved; the handshake
through reqwest's HTTP/1.1 upgrade (its TLS for wss, no new crate), frames read with
`mcp::ide_ws::read_frame` and written masked with `debug::encode_frame`. Text frames (fragments
joined) and binary frames' sizes stream on a Channel, pings are answered, errors come before
the `closed` event (code, reason); a lifetime closes a socket whose page went away.

## ai/
`limits.rs` (D201): the rate-limit headers of each provider's last chat response
(`anthropic-ratelimit-*`, `x-ratelimit-*`), kept in memory per provider id (`ai_rate_limits`),
and OpenRouter's key credits (`GET /key`, the label left out; `ai_provider_limits`). OpenRouter's
`usage.cost` rides on the done event as `cost`.

D355: `ToolStreamProgress` reports a tool call being written; for `STREAMED_TOOLS` (show_widget)
it also sends the arguments so far (`arguments`, partial JSON) at most every 150 ms, and every
report carries the call's `id`, so the chat draws the widget as it streams.

`transcribe.rs`: speech to text for the agent's voice input over an OpenAI-compatible
`/audio/transcriptions` (`ai_transcribe`, D180).

D223: model reply streams (`anthropic.rs`, `openai.rs`, `ollama.rs`) go through `next_chunk`: five
minutes without a byte ends the reply with a "timed out" error (which the agent retries).
`secrets.rs` changes the file under an exclusive lock on `secrets.json.lock` (`File::lock`) as well
as the in-process mutex, reading it again inside, so two windows saving keys at once keep both.

`fim.rs` (D204): fill-in-the-middle for suggestions as you type (`ai_fim`, cancellable with
`ai_cancel`): Ollama `/api/generate` with `suffix`, OpenAI-style `/v1/completions` with `suffix`,
Mistral's `/v1/fim/completions`, DeepSeek's `/beta/completions`; not streamed. A provider or
model without FIM (Ollama's "does not support insert", 404/405/501, a refused `suffix`) answers
`supported: false`, so the webview uses its chat prompt (tested).


Model providers for the built-in agent (D69): Ollama (`ollama.rs`: `/api/tags`, `/api/show`,
NDJSON `/api/chat`) and OpenAI-compatible endpoints (`openai.rs`: `/v1/models`, SSE
`/v1/chat/completions`, tool-call fragments assembled; cache hints for Claude/Gemini on OpenRouter)
and Anthropic's Messages API (`anthropic.rs`, D112: cache breakpoints, adaptive thinking whose
signed blocks are returned as `reasoning` events and sent back, cache usage). One provider-neutral
message shape in, normalized `ChatEvent`s (text, thinking, reasoning, toolCall, done with cache
tokens) out over a Channel; requests are cancellable. `web.rs` fetches one web page for agent
context (`web_fetch`, D130: http/https only, 3 MB cap). `search.rs` (D200) is `web_search`: Brave
Search, Tavily or Exa with the key from the secrets file (`websearch.<provider>`), or a SearXNG
address; results trimmed to title, URL and snippet (tested parsers). `ipc/agent.rs` also lists and reads files
the user picked (`attach_pick`) or dropped from the OS for agent attachments (D131).
API keys live in `<appData>/secrets.json` (`secrets.rs`) and never reach the webview; so do MCP
password inputs (`mcp.input.<server>::<input>`), filled into that server's process or requests
only (D193). D207: the values go to the OS keychain (`keychain.rs`, the `keyring` crate: Windows
Credential Manager, macOS Keychain, the Secret Service; long values split into parts) and the
file keeps a marker per id; without a keychain (headless Linux, `IDE_NO_KEYCHAIN=1`) or for a
value it refuses, the file keeps the value as before. Plain values move on first use. Parsers are
pure and tested in `tests.rs`.

## audit/

Append-only `logs/audit.jsonl`: one compact JSON object per dispatched command. Rotates at 10 MB,
keeps 5 (`audit.jsonl.1` … `.5`).

## debug/
A minimal WebSocket client for debuggers' inspector sockets (D143: Node's `--inspect`): local
addresses only (127.0.0.1, localhost, ::1), text frames, pings answered, messages up to 64 MB.
Commands `debug_socket_connect` / `debug_socket_send` / `debug_socket_close`, and
`debug_inspector_targets` (an inspector's `/json/list`, to attach to a running Node, D145). DAP
adapters use the stdio host (`lsp/`) instead. `debug_local_get` (`ipc/process.rs`, D196) reads an
http:// URL on a local address, for the source maps a dev server serves while debugging a page in
Chrome or Edge.
D204: `debug_dap_connect` — a debug adapter listening on a local port (Delve), DAP's
Content-Length framing over the same channel (`dap_frame`, tested). `autoattach.rs` (tested) —
auto-attach registration folders under `<data>/debug-attach/<hex id>` and `bootloader.js`
(NODE_OPTIONS=--require: Node child processes and a JavaScript debug terminal's programs open
their inspector, register and wait): `debug_autoattach_prepare` / `_take` / `_dispose`.
`processes.rs` — `debug_list_processes` (`ps`, or PowerShell's Win32_Process as JSON).
`browsers.rs` (tested) — `debug_find_browser { kind }`: where Chrome or Edge is (both Program
Files folders, LOCALAPPDATA, Windows' App Paths, PATH); the page's fs access can't look there.
`pane_port.rs` (tested) — `debug_set_pane_port`: the browser pane's WebView2 debugging port for
the next start (WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, kept out of terminals and commands).
`pty_spawn` takes `env` for interactive shells too (the JavaScript debug terminal).

## desktop/

Desktop control for the agent's `computer` tool (D353; commands in `ipc/desktop.rs`). Windows
only (`supported()` is false elsewhere and every call fails): `win.rs` lists monitors, captures an
area of the virtual desktop scaled to the model's size with GDI `StretchBlt` (HALFTONE) into BGRA
bytes, names the app at a point or in front (`WindowFromPoint` / `GetForegroundWindow`, the root
window's process and title, `is_self` for the IDE's own windows) and sends input with `SendInput`
(absolute moves over the virtual desktop, clicks with held keys, drag in steps, wheel ticks,
Unicode typing, virtual-key chords). `banner.rs`: the always-on-top "Controlling your computer"
window with Stop on its own thread (no-activate, excluded from captures) and an Esc watch that
ignores the IDE's own injected keys. Policy (which apps, grants) is the webview's.

## browser/

Browser previews (D89). `proxy.rs`: a hyper server on 127.0.0.1:<random> per target — a local dev
server (requests forwarded over hyper's client, WebSocket upgrades piped both ways, HTML bodies
get the bridge tag, frame-blocking headers dropped, redirects rewritten) or a workspace folder
(static files, no `..` or symlinks out). Requests must name the proxy as Host (no DNS
rebinding). `bridge.js` is the page-side script, also the initialization script of external
windows (`BrowserService::open_window`, labels `browser-*`, which may call only
`browser_bridge_post`). `netlog.rs`: every proxied request (headers, bodies ≤ 2 MB, 64 MB total,
timing) streamed to the IDE over the `browser_subscribe` Channel with external windows' reports;
`devtools.js` is the bridge's DevTools half (DOM, styles, storage, resources). Static previews
serve unsaved editor text (`browser_overlay`), and `/__ide/live?since=N` (D284) answers when
the change counter `browser_overlay` bumps moves (25 s at most): a preview open in an outside browser
reloads on it. `net_port_open` confirms detected servers. `browser_bridge_source` (D341) hands the
bridge to the IDE, which installs it over the DevTools protocol in a page of the user's own Chrome
or Edge (there it posts through a protocol binding and leaves links, keys and scrollbars alone).
`trusted_input.rs` (`browser_trusted_input`, D346): one `Input.*` DevTools protocol call into an
IDE webview through WebView2's in-process `CallDevToolsProtocolMethod` (no debugging port; any
other method refused), so a browser tab's page gets trusted events; Windows only.
`stream.rs`: request bodies forwarded as they arrive and HTML passed on as it comes, the bridge
tag inserted once `<head>` is seen (`/__ide/post` is the passing page a form posted into a new tab
is sent from). `embed.rs` (`browser_embed_open` / `_place` / `_focus`): another site in a child
webview of the IDE window over a browser tab (Tauri's multi-webview, the `unstable` feature;
Windows and macOS), labelled like site windows; site webviews never load the IDE's own origins.
`downloads.rs` (`browser_downloads`, `browser_download_cancel` / `_open` / `_reveal`,
`browser_downloads_clear`): downloads of the main webview, site windows and embedded sites, as
`BrowserEvent::Download` (Windows: WebView2's download operation with progress and cancel, its
own UI suppressed; elsewhere Tauri's start and end). Because a window can now hold several
webviews, code looks "main" up with `get_window` / `get_webview`, drops are also read from
webview events, and `capabilities/default.json` grants by webview (`main`), not by window.
Commands in `ipc/browser.rs`.

## extensions/

Third-party extensions on disk (D102): installed ones in `<appData>/extensions/<id>/`, unpacked
folders from `registry.json`; manifests listed for the frontend to validate, files read only from a
known extension root by a relative path, install (copy via a staging folder) and uninstall,
per-extension storage files. Webview panels are served by the browser proxy in static mode with a
restrictive CSP (`browser::webview_target`); a panel an extension's code opens at run time has its
HTML served there too, at `/__webview-<name>.html` (`ext_webview_page`, `Shared::webview_pages`, keyed
by the folder). Files of the folders its pages may read besides its own (VS Code's
localResourceRoots: the workspace's folders and declared roots inside them, `ext_webview_roots`,
`Shared::webview_roots`) are served at `/__fs/<absolute path>` (`proxy::resolve_rooted`: a file
inside one of them once links are followed). Commands in `ipc/extensions.rs` (`ext_fetch` makes the
HTTP requests the frontend allowed). `download.rs`: git repositories cloned into a scratch folder
(D185); `vsix.rs` (D200): a `.vsix` / `.zip` unpacked there (`ext_unpack_vsix`; stored and
deflated entries through `flate2`, already in the build for png and the updater; names that would
leave the folder, encryption and Zip64 refused; sizes capped and CRCs checked), installed and
discarded the same way. `store.rs` (D254): the extension store, Open VSX: search and an
extension's details as its JSON (`ext_store_search`, `ext_store_details`), and a version's
`.vsix` downloaded over https from Open VSX's hosts only and checked against the SHA-256 it
publishes (`ext_store_download`), then installed like any `.vsix`. `ext_node_host_script` (D255)
writes the Node extension host's script (the frontend's bundled copy) to `<data>/extension-host`,
named by its hash, for `node` to run.

## exec/

Non-interactive commands for agents (`exec_run`): the user's login shell (`$SHELL -lc`, or
PowerShell `-NoProfile -Command` on Windows), cwd inside the workspace, output streamed as it
arrives, exit code, timeout and cancel (kills the process group / tree).

The command sandbox (`exec/sandbox.rs`, D336): `exec_run { sandbox: true }` runs the shell under
the OS's isolation with writes limited to the command's workspace folder, its repository's git
folder and a temp folder. Windows: cmd started suspended, its token lowered to low integrity
(`job::spawn_then`), then PowerShell from it (the script in `AGENT_SANDBOX_SCRIPT`); the folders get
an inheritable low mandatory label once (`windows_low::mark_writable`), TEMP/TMP go to
`<LocalLow>\<data folder>\sandbox-temp`. Reads and the network aren't limited there. macOS:
`sandbox-exec` with a profile (`macos_profile`: no writes outside, no network but localhost).
Linux: `bwrap` when installed (`bwrap_args`), else none. Remote and WSL folders: never.
`exec_sandbox_info` says what this system has; `ExecResult.sandboxed` whether a run was.
D348–D350: `exec_run`'s `sandboxPolicy { denyRead, allowWrite, allowHosts }` (`SandboxPolicy`,
`Sandbox::with_policy`). `exec/sandbox_net.rs`: a filtering HTTP proxy per sandboxed command
(`NetProxy`, CONNECT and plain HTTP, allowed hosts only, loopback always; the refused hosts come
back as `ExecResult.blocked_hosts`), set through the proxy variables: on macOS the only way out, on
Windows for proxy-aware tools only (a normal user can't add a WFP filter: `sandbox_win_tests.rs`),
on Linux only with allowed hosts (bubblewrap then shares the network). `exec/sandbox_read.rs`:
the denyRead entries expanded (`~/`, `${secrets}`, `${keychains}`, `${browserProfiles}`,
`${envFiles}`), hidden by sandbox-exec deny rules, bubblewrap tmpfs / /dev/null mounts, or on
Windows a medium no-read-up label set once and recorded in `<data>/sandbox-hidden.json`;
`exec_sandbox_unhide` puts the labels back. `exec/sandbox_protect.rs` (D392): what a command
may not write inside its folders, as Claude Code's sandbox: git's `config`, `config.worktree`,
`commondir`, `hooks` (also under `modules/` and `worktrees/`), the repository's `.git` itself,
`.claude`, `.codex`, `.cursor`, `.mcp.json` and the IDE's folders (`protectFolders` in the
policy): macOS deny rules after the allow, bubblewrap read-only binds of what exists. Windows
can't hold them (the folder's low label lets them be deleted and remade): `git/guard.rs` there.

Project formatters (`exec/format.rs`, D140): Biome / Prettier from node_modules, Ruff / Black,
rustfmt, gofmt, clang-format detected from the file up to the root, text through stdin/stdout
(`format_project`); `find_program` finds tools also when the app's PATH is short.

## fs/

Workspace-scoped file access. `Workspace::resolve` canonicalizes every path (via the nearest existing
ancestor for new paths) and rejects anything outside the open folder. A file the user opened from
outside it (`allow_file`) is in scope alone, also when it and its folders don't exist yet (saving
creates them, m7.12). A headless helper's git worktree is an extra root while it works
(`allow_root` / `forget_root`, commands `workspace_allow_root` / `workspace_forget_root`): only a
linked worktree of the open folder's repository is taken, everything inside it is in scope like
the open folder's (`resolve`, `resolve_entry`, `root_of`; `scope_root` for `search_start` and
`index_query` with `root`, which walks it with `index::query_walk`), and opening or closing a
folder forgets it. Multi-root workspaces (several folders in one window, VS Code's
`.code-workspace`): the first folder stays `root` (the primary); `set_folders`
(`workspace_folders_set`, one `FolderStatus` per path, a missing folder reported and left out)
adds the others, in scope exactly like the root (`resolve`, `resolve_entry` — no workspace folder
itself is ever renamed, moved or deleted, nested ones included — `root_of`, `scope_root`;
`folder_of` / `all_folders` leave helper worktrees out). `set_file` (`workspace_set_file`) keeps
the open `.code-workspace` file: `location()` (it, else the root) keys the per-workspace state,
the window registry and the window's place. `workspace_file_read` / `_write` touch only absolute,
local `*.code-workspace` files (`checked_workspace_file`), `workspace_untitled_path` hands out
`<data>/workspaces/untitled/<ms>.code-workspace`, `workspace_folders` lists them root first.
`open` and `close` forget the folders and the file. `list_dir` lists one level,
dirs first, natural order, `.gitignore` matches flagged `ignored`. Create/rename/delete with name
validation; writes go through `store::atomic_write`.

`fs/encoding.rs` (D204): legacy text encodings. `encode` writes any WHATWG encoding with
`encoding_rs` without replacement (characters it can't hold are returned, so a save never writes
`&#NNNN;`); `guess` asks `chardetng` (Firefox's detector) about bytes that aren't UTF-8
(`files.autoGuessEncoding`). Commands `encoding_encode` (body: the text; header `x-encoding`) and
`encoding_guess` (body: the bytes). Decoding stays in the webview's `TextDecoder`, the same tables.

## git/

Git through the user's `git` CLI (D5, D65): `mod.rs` builds machine-friendly commands (no prompts,
no optional locks, no colors; on Windows the local git also gets `-c core.longpaths=true`, so paths
over 260 characters work); `status.rs` parses `status --porcelain=v2 -z`; `ops.rs` has the
operations (remote ones stream progress lines). Hunks are staged by writing a file's new index text
(`write_index`, via `hash-object --path` so clean filters and line endings apply), computed in TS
from a line diff (D66); `show` returns text in working-tree form (`cat-file --filters`) so the two
sides compare directly. `service.rs` holds the open repo and turns paths into repo-relative ones
(`find_workspace_repos`: each other workspace folder's own repository, kind "folder", then the
nested ones and submodules of every folder; `git_init { folder }` in any workspace folder);
`watch.rs` watches the git dir (HEAD, index, refs). Tests in `tests.rs` use throwaway repositories.
D139: `ops::log_graph` (date-ordered, HEAD + upstream or `--all`) for the commit graph;
`worktree.rs` (list / add / remove / prune); `rebase.rs` (interactive rebase from a prepared todo
list: `GIT_SEQUENCE_EDITOR=cp "$IDE_REBASE_TODO"`, rewords by `exec git commit --amend`);
`github.rs` (pull requests / issues through the `gh` CLI, fixed operations); `askpass.rs` (the
binary as git's and ssh's askpass: `main.rs` calls `askpass_client()` first, which relays the
prompt to the running IDE over a token-checked 127.0.0.1 socket). `journal.rs`: every `run`'s
arguments, time and error (the last 1000), read redacted by `log_git_commands` (in
`ipc/diagnostics.rs`) for the Git output channel's command lines. `guard.rs` (D392): every `run`
first checks that a repository where sandboxed commands ran (`arm`, from `exec_run`) still has
the git settings recorded then; changed, it fails with `GitSettingsChanged` until
`git_trust_settings`. The IDE's own commands that may change settings record what they left
(`settle`); the record lives in `<data>/git-guard.json`, an earlier session's dropped once it
matches.

## history/

Local history and the app trash (D86): `LocalHistory::record` snapshots a workspace file's bytes
(`<appData>/history/<hash>/`, `entries.json` index, deduplicated, 50 per file, ≤ 1 MB);
`before_write` keeps what was on disk before the app's first write or after an outside change.
`fs_write` and `search::replace` record through it. `trash` / `untrash` move items into
`<appData>/trash/<id>/` and back (swept at startup after 30 days; "Restore deleted files…" lists them). Commands in `ipc/history.rs`.

## index/

Workspace file list for quick open (`index_query`). Built by an `ignore` walk when a folder opens
(`FileIndex::open`, called from `workspace_open`), rebuilt in a background thread when its watcher
reports structural changes. `fuzzy.rs` ranks paths (tested; a first look without allocating
skips the paths a query can't match, D254). See docs/decisions.md D57.
Its watcher has no file-id cache (`NoCache`, D250): the recommended one walks and opens every
file under the folder before `workspace_open` returns. Every workspace folder has its own list,
walk and watcher (`set_folders` adds and drops the others, keeping unchanged ones); a query merges
them, and an item from another folder than the primary carries `root` (its folder), `path`
relative to it. `index_query { root }` with a workspace folder lists that folder alone.

## instances/

Windows across processes and the command line (D209). `mod.rs` (tested): each window's
registration in `<data>/windows/<pid>.json` (port, token, folder, last focus; written 0600), the
line protocol (`ping`, `focus`, `open { files, diff, wait, add }`; `add` left out when empty),
which window gets files (the one with their folder, else the last focused; `--add` folders always
the last focused) and which folders a new session reopens. A window with a `.code-workspace` file
open registers that file as its folder, so `<cli> team.code-workspace` focuses it. `server.rs`:
this window's listener on 127.0.0.1 (token checked), requests to the frontend through a Channel
(queued until it listens), `--wait`'s second line once the frontend says the tabs closed; on
quit the last window keeps its entry for `window.restoreWindows`. `client.rs`: `main.rs` calls
`cli_forward()` first — a folder already open is focused, files go to a running window
(`AllowSetForegroundWindow` on Windows), `--wait` starts a window when none runs and blocks; from a
shell (the PATH shim's `IDE_CLI`, a terminal on stdout) a new window starts detached.
`shell_command.rs` (tested): "Install shell command in PATH" — Windows: a `.cmd` shim (next to a
per-user install's exe as `bin\<name>.cmd`, else in the data folder) and the user PATH
(HKCU\Environment through PowerShell, REG_EXPAND_SZ kept, the value passed in a variable; never
the system PATH); macOS: a symlink in `/usr/local/bin` through the administrator prompt
(`osascript … with administrator privileges`, paths quoted for sh and AppleScript, tested),
`~/.local/bin` when refused; Linux: a symlink in `~/.local/bin` (or `~/bin` when only that is on
PATH). The shim makes cmd.exe / PowerShell wait for `--help`, `--version` and `--wait`; a plain
`<cli>` / `<cli> -n` from a shell detaches (`client::should_detach`).
Empty windows (m7.12): each window has a backup id (random, or `--restore-empty <id>`); while it
has no folder the frontend keeps its unsaved text in `<data>/windows/empty/<id>.json` (0600,
`instances_empty_backups_save` / `_load`). The first window of a session gets the leftover ids
with the folders (`instances_restorable` → `{ folders, empty }`, newest first) and may adopt one
(`instances_adopt_empty`); `app_new_window { empty }` starts the others (only ids handed out).
`instances_others_running` tells the frontend whether closing this window ends the session.
`jump_list.rs` (Windows) and `dock_menu.rs` (macOS, unverified: `applicationDockMenu:` added to
the app delegate's class with plain Objective-C runtime calls) both take `jump_list_set`.

## ipc/

Public Tauri commands, one file per domain (`accounts`, `agent`, `app`, `browser`, `extensions`,
`fs`, `git`, `history`, `mcp`, `process`, `settings` — mirroring `src/core/ipc/`); thin wrappers that scope-check paths and call the service
modules. All are `async` (off the main thread). Each command has a generated
`allow-<command>` permission (build.rs), granted in `capabilities/default.json`.
`settings.rs` also lets the fs commands reach the user settings, keybindings and snippet files
(and the agent's user files: `<config>/memory`, `agents`, `commands`, `AGENTS.md`, plus
`~/.claude/CLAUDE.md` and `~/.claude/commands/*.md`, D200), and saves / opens settings profiles through the system dialog (`profile_save` / `profile_open`,
D130). `skills.rs` (D206): the agent's user skills folders — `~/.claude/skills`,
`~/.cursor/skills`, `~/.agents/skills` read only, the IDE's own `~/<dataFolderName>/skills` read
and written (no links below a skill's folder) — and `skills_delete_user`; D221: `skills_watch_start` /
`skills_watch_set_dirs` watch the user skills folders themselves, recursively (`skills_watcher`).
`agent_session_save` takes `expect` (a version from `agent_session_version`: mtime and size) and
refuses a save over another window's newer one.

## mcp/

MCP server with `rmcp` (Streamable HTTP) on 127.0.0.1:<random>, bearer token per start, rmcp's
Host/Origin checks. `handler.rs` lists tools/resources from the catalog the frontend pushes and
forwards calls/reads through `bridge.rs` (a Channel to the webview + `mcp_respond`). `http.rs` is the
hyper server and token check. The URL and token are written to `<app data>/mcp.json` while running.
Test: `tests.rs` (401 without the token, initialize + tools/list with it). See docs/mcp.md, D64.
`remote.rs` (D193) is the client side for the agent's remote MCP servers: Streamable HTTP POSTs
(`mcp_remote_post`; https or localhost, no redirects), JSON or server-sent events back. D200:
the server's own requests and notifications in an event stream (an elicitation it waits on) go
to the page at once over the command's Channel, not with the reply.
D204: `oauth.rs` signs in to remote servers (RFC 9728 / 8414 discovery, dynamic client
registration, PKCE S256, a loopback redirect; `mcp_oauth_begin` / `_finish` / `_status` /
`_sign_out`), keeps tokens in the secrets file (`mcp.oauth.<server>`) and `remote::post` sends and
refreshes them (tested against a mock authorization server, `oauth_tests.rs`). `ide_ws.rs` is
Claude Code's IDE integration: the `~/.claude/ide/<port>.lock` file and an in-house WebSocket
(RFC 6455) MCP server with the auth-token header check (`ide_integration_*`; `ide_ws_tests.rs`).
D207: a 403 with `insufficient_scope` notes the challenge and fails with an error the page turns
into a step-up sign-in (`oauth::begin` asks for the granted scopes plus the new ones);
`stream.rs` keeps a remote server's GET stream open (`mcp_remote_listen` / `_unlisten`: events
on a Channel, reconnect with backoff and Last-Event-ID, 405 = none; tested against a local
server); `executeCode` is listed for Claude Code.
D222: `app_windows_alive(tags, folders)` answers a tag this process doesn't know from the window
registry (`instances::open_with_folder`: a live window with that folder); `agent_session_stamps`
gives each saved chat's size and modification time, so the worktree overview reads only changed
chats.
D223: `stdio_proxy.rs` makes the binary a stdio MCP server for agents that take no HTTP ones:
`<binary> --mcp-stdio-proxy <url>` with the token in `IDE_MCP_PROXY_TOKEN` (checked in `main.rs`
before anything of the app starts, like askpass); loopback `http://…:<port>` only; each stdin line
is POSTed with the session id and protocol version from initialize, answers (JSON or SSE) come
back one per line, requests run side by side, initialize and notifications in order, a refused
request gets a JSON-RPC error, stdin closing sends DELETE (`mcp_stdio_proxy` gives the frontend the
binary's path; tested against a local server, `stdio_proxy_tests.rs`). D233: after
`notifications/initialized` it also opens the standalone GET stream (Accept `text/event-stream`,
session, protocol version, `Last-Event-ID` on reconnect, stream.rs's `backoff`); the server's own
messages there go to stdout; 405 or a non-stream answer stops it, 404/401/403 too (tested against
`tests/fixtures/mock-remote-mcp.mjs` when Node is installed). `ide_ws.rs` tracks each
connection's calls and, when it closes, fails them and sends the webview `BridgeRequest::Cancel`
(a diff tab Claude Code left).

## url_scheme.rs

Links to the IDE (D255): `<urlScheme>://<extension id>/…` (product.json) reach an extension's URI
handler. `cli.rs` takes such an argument as `open_url`; a running window gets it over the instance
protocol (`Request::Open`'s `url`), a new one from its own command line. On Windows an installed
build registers the scheme for the user at start (`HKCU\Software\Classes\<scheme>`), only when it
points elsewhere; macOS and Linux declare it in their bundles.

## accelerators.rs

WebView2 (Windows) browser accelerator keys off for every window (D138), so keys like
Ctrl+Shift+P reach the page.

## frame_guard.rs

WebView2 (Windows) doesn't apply the page's CSP `frame-src` to a frame's own later navigations
(D253): each frame created directly in the IDE's page (main and pop-out windows) gets a
navigation check with the same rule (`http://127.0.0.1:*`, `about:`; `frame_allowed`, tested).
Frames inside those aren't touched. The opener plugin runs without its link-click script (lib.rs):
on WebView2 it ran in the browser pane's page frames and took their `target=_blank` links.

## job.rs
Children the IDE spawns for itself (PTYs, `exec`, formatters, language servers) go into one Windows
job object with `KILL_ON_JOB_CLOSE`. The children end with the IDE however it ends, so no orphaned
shells or console hosts are left (D180). It's a no-op elsewhere. m7.12: they're started suspended,
put in the job, then resumed, so nothing they start escapes it: `spawn(cmd)` for a
`std::process::Command` (adds `CREATE_NO_WINDOW | CREATE_SUSPENDED`, resumes the thread found with
a Toolhelp snapshot), `adopt_handle` for the terminals' own spawner (`pty/conpty.rs`); `adopt(pid)`
is the old racy way, kept for callers that can't. D264: `spawn_owned` also puts the program in a job
of its own, nested in the IDE's (`OwnJob`; dropping it ends everything in it): stdio servers
(`lsp/`, the Node extension host among them) close theirs when stopped or reaped, so what a
crashed server started doesn't run on until the IDE closes.

## lsp/

The stdio JSON-RPC host: spawns a process (language server, MCP server, ACP agent, debug adapter,
notebook kernel host), frames messages both ways (`framing.rs`: LSP's `Content-Length` headers or
newline-delimited JSON; for a program's output, its lines or, `chunks`, what the pipe has as it
comes, UTF-8 characters kept whole) and forwards them over a Channel. The protocols are TS (`src/core/lsp`,
`src/core/mcp`, `src/core/acp`); Rust only moves bytes. `LspHost` is a cheap clone (shared maps):
the IPC commands run its blocking calls (a write to a full pipe, killing and reaping a process
tree) on `spawn_blocking` threads through `LspHost::blocking` (D218). Closing the folder stops
its servers but not an extension's own processes (`ext-node:…`, `ext:…`: `stop_folder_servers`,
D271).

## pty/

`portable-pty` sessions: default shell (login shell on Unix, PowerShell on Windows), raw output over a
Channel, exit as `{ "exit": code }`, write/resize/kill. Flow control: reading pauses above 512 KB of
unacknowledged output and resumes below 128 KB (`pty_ack`). One thread reads, another sends what
arrived within 5 ms (at most 256 KiB) as one message (D254: ConPTY hands a flood over in many
small reads, and each message and ack is an IPC round trip on WebView2). All shells are killed on
app exit.
`pty_spawn` with a `run` spec (D134) starts a task instead of an interactive shell: a command line
through the task's or the default shell (`-l -c`, `-Command`, `/d /c`) or a program with its
arguments, with extra environment variables; `${env:NAME}` is expanded there. Which shell starts
(the default one, a profile's command, a task's variables) is `shell.rs` (split from `mod.rs`, D245).

`commands.rs` parses shell-integration marks (OSC 633/133) into command records; `integration.rs`
writes the scripts in `scripts/` to the app data folder and starts bash/zsh/fish/PowerShell with
them (D62). `pty_commands` returns the records. zsh's script prefixes `PROMPT_EOL_MARK` with the
D mark while a command runs (PROMPT_SP prints the mark before precmd), so records don't end with
a stray `%` / `#` (D207).

D204: `profiles.rs` finds the installed shells (VS Code's detected profiles: PowerShell 7, Windows
PowerShell, Git Bash via the registry / install folders / `git.exe` on PATH, Command Prompt,
Cygwin, WSL distributions; `/etc/shells` on macOS / Linux) for `pty_profiles` (which also says
whether a sideloaded `conpty.dll` sits next to the app); `pty_spawn`'s `profile` starts one (first
existing `path`, `args`, `env` with null to unset), with integration when its arguments allow
(`integration_flags`). `suggest.rs`: program names on PATH (cached, `pty_path_commands`) and a
folder's entry names relative to a live terminal's folder (`pty_list_dir`) for suggestions.

D229: `globals.rs` asks a live terminal's shell for the user's aliases and functions
(`pty_shell_globals`: bash / zsh / fish `-i -c` with `alias` and their function lists, PowerShell
`Get-Command -CommandType Alias,Function`; 5 s at most, text after a marker line; the frontend
parses it). A `.bat` / `.cmd` process task runs through `cmd.exe /e:ON /v:OFF /d /c %VAR%` with a
line quoted as Rust's std does since BatBadBut (`batch_quote`, `batch_command_line`): the variable
keeps portable-pty from quoting it the C way, and an expanded variable isn't expanded again. A task
in a WSL folder runs in its `options.shell` / the linux automation profile, else bash
(`wsl_task_shell`).

m7.12: task command lines live in `tasks.rs` (`task_command` returns a `TaskLaunch`). A shell
task run by cmd.exe gets its line verbatim: `/d /s /c "<line>"` (`cmd_verbatim_tail`), the
command-line tail passed as written by the spawner, so `echo "a b"` and quoted programs reach cmd
as typed (C quoting gave `\"`).

**Windows spawner** (`conpty.rs`): the IDE starts ConPTY children itself instead of portable-pty's
spawner (portable-pty still runs Unix ptys). Same pseudo-console flags, stdio and environment
block; differences: a `conpty.dll` + `OpenConsole.exe` next to the exe are loaded by full path
(else kernel32's ConPTY; `pty_profiles` → `conpty` says which actually loaded), the child is
created suspended, adopted into the job and resumed, and a verbatim command-line tail is allowed,
and the child's PATH is the IDE's own first, then the registry's additions (portable-pty's builder
starts from the registry's environment, which dropped what the IDE was started with).

**Process revival** (`revive.rs`, VS Code's): each session keeps its last 1 MiB of output in a
ring with absolute byte offsets. `page_loaded { page }` (main window) detaches the terminals of
every other page instead of killing them (`detach_except`); output keeps being read into the ring.
`pty_attach { id, key, since, cols?, rows?, onOutput, page }` takes one back: `key` is the secret
`pty_spawn` returned in `PtyInfo.key` (a tab saves it), `since` the output offset its saved screen
reflects; the bytes after it go first on the new channel (else the whole lines kept), then live
output. Errors: "Gone" (ended, or another run of the IDE), "AlreadyAttached" (a page has it; the
frontend retries ~2 s). `pty_detach { id }` lets one go without ending it (a view dropped mid
restore). A detached terminal not taken back within 60 s (`ORPHAN_GRACE`) is killed (tree and
all on Windows); app exit still kills everything (`kill_all`).
## remote/

Remote development (D252; the protocol is docs/remote.md, the server `src-tauri/remote-server/`).
A window works on one remote (`ssh:<host>`, `container:[user@]<id>` for a dev container (D266), or
`wsl:<distro>` for development and the UI tests),
process-wide (`active()`: every window is a process). `mod.rs`: the remote, `connect` /
`disconnect`, `is_remote_path` (the one rule: on Windows a POSIX path starting with `/`, not `//`,
in a remote window; elsewhere a remote window's path outside the app's own folders), `of_dir`,
`posix`, `command` + `share_env` (a program through the relay, like `wsl::command`), blocking
helpers (`is_dir`, `is_file`, `kind_blocking`, `subdirs_blocking`, `run_sh`), the remote trash
(`trash` / `untrash`, `~/<serverDir>/trash`), the git directory poll (`poll_git_dir`), and the
dispatch of `watch.batch` (by watcher name: `explorer`, `settings`, `docs`), `index.changes` and
`search.event`. `connection.rs`: `RemoteConn` (frames, ids, `call` / `call_blocking`,
`open_stream_blocking`, `StreamEvent`, lost-connection handling, remote errors as the app's).
`transport.rs`: `Authority` (validation: no leading `-`, `[A-Za-z0-9._@:\[\]%-]`; a container: one
`user@`, never an option-like container), the ssh, wsl.exe and `docker exec -i` commands (`-T`, keepalives, `BatchMode=no`, `-p` from `host:port`, askpass forced),
`~/.ssh/config` hosts. `install.rs`: the one-connection setup script (`uname`, the installed
server at `~/<serverDataFolderName>/<version>-<sha256[..12]>/ide-server`, else an upload of the
bundled build through `head -c`), `handshake`. `relay.rs`: the loopback relay listener and the
`--remote-relay` client (frames over TCP, token, stdin/stdout/stderr, exit codes, Ctrl+C → SIGINT
on Windows). `pty.rs`: a terminal as a remote pty (`Console::Remote` in `crate::pty`; no local
ConPTY, no pid). `ports.rs`: forwarded ports (`tcp.connect` per connection). `fs.rs`: the file
commands' remote side. Commands in `ipc/remote.rs`: `remote_connect { authority, onEvent }`,
`remote_askpass_answer`, `remote_disconnect`, `remote_status`, `remote_browse`, `remote_log`,
`remote_hosts`, `remote_forward_port`, `remote_unforward`, `remote_forwarded`, `remote_listening`.

## search/

Text search (`search_start` → Channel of `SearchEvent`, `search_cancel`) with grep-searcher /
grep-regex and the same ignore rules as the index plus include/exclude globs (ignore files and
symlinks per options; a workspace-relative file path means that one file); `search_replace`
rewrites files atomically with the `regex` crate, optionally only on given lines and keeping each
match's case (D139). A query that can match a line break (a regex with `\n`, or text holding a
newline) searches in multi-line mode (D200): each match is reported on the line it starts on,
the range running to the match's end or that line's end; `\n` outside a character class also
matches `\r\n`. Replace uses the same pattern. Tests in `tests.rs`. See docs/decisions.md D58.
One search runs several roots in order (`search_start { root, roots }`, each `scope_root`-checked;
neither: every workspace folder): `rel` is relative to the file's own folder, a file of a nested
folder is reported once, the result cap and the one `Done` count across them.

## store/

`atomic_write` (temp file → fsync → rename; keeps permissions; follows symlinks) and `AppDirs`
(app data/config/logs from the identifier in `product.json`; per-workspace state at
`workspaces/<sha256(canonical root)>/state.json`).

## diagnostics/

Alpha support (D204). `log.rs`: the session log, one file per run in
`<data>/logs/sessions/session-<UTC time>-<pid>.log`, the last 10 kept, each capped at 4 MB, every
line redacted (`redact.rs`: keys, tokens, `key=value` secrets, URL passwords, the home folder);
the panic hook writes Rust panics with a backtrace (never waiting for the log's lock).
`zip.rs`: a small deflate zip writer for the problem report. `mod.rs`: the one-shot
`next-start-extensions` flag ("off" / "on", read and removed at start; "on" overrides
`--disable-extensions`) and `last-version` (for What's new). Commands in `ipc/diagnostics.rs`:
`session_info`, `log_write`, `log_recent`, `report_save_zip`, `app_relaunch`.

## update/

Updates (D192): tauri-plugin-updater, registered only when the build has an update endpoint and
public key (product.json `updates`, or `IDE_UPDATE_*` at build time), so source builds never
connect. Checks `latest.json`, and with the user's go-ahead downloads, verifies, installs and
restarts. Release setup: docs/releasing.md. `update.channel` "beta" (D204) checks the beta
endpoint (`IDE_UPDATE_BETA_ENDPOINT` at build time, else product.json `updates.betaEndpoint`)
with the same public key; without one the check is stable's.

## watch/

`notify` + `notify-debouncer-full` (150 ms). Watches only the directories the explorer asks for
(non-recursive) and sends `{ dirs, paths }` batches over a Channel. See decision D21.

## Single files

- `aux_window.rs` — a tab in a window of its own (D101): the main webview opens `about:blank` and
  fills it; any other `window.open` from the IDE is denied.
- `cli.rs` — command-line arguments (tested): `[folder]` (or an existing `*.code-workspace`
  file), files as `path[:line[:column]]` (`--goto`), `--add <folder>` (repeatable; with no window
  running the first is the new window's folder, `into_window`), `--diff a b`, `--wait`,
  `--new-window`, `--verbose`,
  `--run-test-script`, `--user-data-dir`, `--test-timeout`, `--disable-extensions` (D209).
- `error.rs` — the one error type, sent to the frontend as `{ code, message }`.
- `screenshot.rs` — webview screenshots for agents (D96): WebKitGTK on Linux, WebView2 on
  Windows; not macOS yet.
- `window_bounds.rs` — the main window opens where it was last closed (`<appData>/window.json`:
  normal bounds in logical px and whether it was maximized), unless that screen is gone; not for
  "New window" or test runs.
- `user_folders.rs` — the user's Downloads, Desktop and temp folders for the risky-folder checks
  (D213), in `app_info`'s `userFolders`: Windows' Known Folders (`SHGetKnownFolderPath` through
  Tauri's path resolver) plus `%USERPROFILE%\Downloads`, macOS `~/Downloads`, Linux
  `XDG_DOWNLOAD_DIR` from `user-dirs.dirs` (parsed, tested) plus `~/Downloads`; each as found and
  canonical. `IDE_TEST_DOWNLOADS_DIR` replaces the Downloads list.
- `wsl.rs` — WSL folders (D192): files through `\\wsl.localhost\<distro>\…`, programs inside the
  distribution with `wsl.exe -d <distro> --cd <linux path> --exec …`, polling instead of watching.
