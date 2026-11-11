# Project Plan — AI-first Desktop IDE (v1.4)

> Master plan. Give this file, `AGENTS.md`, `DESIGN.md` and the current task prompt to any new work session.
> **The product's name lives only in `product.json` (§4.3).** Never hard-code it anywhere, so a rename stays a one-line change. Use the neutral word "IDE" in prose and `ide` in identifiers.
> **License:** source-available under the PolyForm Shield License 1.0.0 (`LICENSE`, §17).
> **Not in this repository:** a few working documents from before it started (the feature-gaps list, the long-term goals, audits and the owner's checklists; D418). Where this plan or the code names one of them, use the issue tracker instead.
> **Where we are (November 2026, D394):** M1–M6 are done and M7 (polish and ship) is near its end:
> the closed alpha waits on the owner's Windows pass and release keys. §16 has the history;
> `docs/feature-gaps.md` tracks what VS Code, Cursor, Zed and IntelliJ have that we don't yet.
> Where this plan and the code disagree, `docs/decisions.md` records the change and wins.

---

## 1. Vision
A local desktop code editor in the spirit of VS Code and Cursor, minus the bloat: simple, sleek, modern, fast. **AI-first**: every part of the IDE (editor, files, terminal, git, browser, layout, settings) is built so an agent can *see* and *control* it through the same API the UI uses. Local models first; hosted models and external agents (Claude Code, Gemini CLI, Codex…) plug in through standard protocols (ACP, MCP).

## 2. Guiding principles
1. **One dispatcher for everything.** Every action is a typed command. UI, keybindings, palette, built-in agent, external agents, MCP clients, extensions and tests all go through the *same* dispatcher, with the same validation, permissions and logging.
2. **Every call knows its caller.** `user`, `agent:<session>`, `acp:<agent>`, `ext:<id>`, `mcp:<client>`, `test`.
3. **Everything observable, within budget.** IDE state is an addressable tree (`ide://…`) with size limits, so agents with small context windows can still see what matters.
4. **Minimal dependencies.** Prefer the platform and small in-house code over libraries. Every runtime dependency states its size and why.
5. **Everything is an extension.** Explorer, terminal, git, search, browser and the built-in agent are built on the public extension API.
6. **No UI framework.** Vanilla TypeScript + DOM, a tiny signal store, an `h()` helper, strict `Disposable` cleanup.
7. **VS Code familiarity.** Default keybindings, `settings.json` / `keybindings.json` formats, `when` clauses, VS Code theme JSON.
8. **AI-readable codebase.** Files under ~1200 lines, split by responsibility (D77 replaced the first ~300-line rule: what's read together stays together), one feature per folder with a `README.md`, strict TS, explicit types, `AGENTS.md` at root, `docs/decisions.md`.
9. **Offline by default.** No CDN at runtime. No telemetry.
10. **Name-agnostic.** Product name, IDs, folders and URL schemes come from `product.json`.

## 3. Tech stack

| Layer | Choice | Notes |
|---|---|---|
| Desktop shell | **Tauri 2** | System webview, Rust backend. |
| Backend | **Rust** | Services: fs, watch, search, pty, exec, git, net/AI proxy, LSP host, MCP, ACP, secrets, checkpoints, audit. |
| Frontend | **Vanilla TypeScript (strict) + DOM** | Patterns in §5. |
| Build | **esbuild** via `build.mjs` | App bundle + worker entries; `serve` + live reload in dev. |
| Type check | `tsc --noEmit` | esbuild doesn't type-check. |
| Lint/format | **Biome** (dev-only, single binary) · `rustfmt` + `clippy` | |
| Editor | **`monaco-editor` + `@shikijs/monaco`**, behind an `EditorService` adapter | modern-monaco was dropped in M1 (it needs a CDN and IndexedDB). Lazy-loaded after the shell paints. Monaco's TS/JS, JSON, CSS and HTML workers bundled (M2). Theme colors derived from design tokens at runtime. |
| Syntax highlighting | **Shiki** with VS Code's TextMate grammars, Oniguruma (D132) | Grammars lazy-loaded per language; VS Code themes color the editor fully. |
| UI theme | **Design system in `DESIGN.md`** (dark + light), themes stored as VS Code theme JSON | `colors` → semantic tokens; `tokenColors` → Shiki. |
| Terminal renderer | **`@xterm/xterm`** (+ fit, search) behind a `TerminalRenderer` adapter | ghostty-web was the first choice; D48 switched to xterm.js (reflow on resize, live theme updates). |
| PTY | `portable-pty` | Shell integration (OSC 633, VS Code's; OSC 133 also read) added in Milestone 2. |
| ANSI stripping | In-house, no crate | Plain-text buffers for agents. |
| File walk | `ignore` | Respects .gitignore. |
| Watching | `notify` + debouncer | Batched events over a Channel. |
| Search | `grep-searcher` + `grep-regex` | Streamed over a Channel. |
| Git | **Git CLI** (`--porcelain=v2 -z`) | Zero added size; uses the user's config/credentials. |
| Dialogs | `tauri-plugin-dialog` (official) | Open folder/file. |
| Model HTTP | `reqwest` (streaming) | OpenAI-compatible client in Rust; avoids CORS; keys stay out of JS. |
| Secrets | `keyring` | OS keychain. |
| MCP | `rmcp` (official Rust SDK) for the server; an in-house client (`core/mcp`) | Server (expose IDE) + client (agent uses user's servers). |
| ACP | In-house client (`core/acp`) over the Rust stdio host | Host external agents over JSON-RPC/stdio. |
| Speech | `candle` (Whisper on the CPU, pure Rust, D384) | On-device dictation; whisper.cpp's models downloaded on first use. |
| Layout | Custom split/tab tree | Serializable JSON. |
| Styling | Plain CSS, `@layer`, CSS variables | |
| Icons | In-repo SVG sprite (icons copied from Lucide, ISC) | Zero runtime deps. |
| Fonts | System UI stack; the OS's default code font, as VS Code (D382) | |

**Frontend runtime dependencies (all of them):** `monaco-editor`, `@shikijs/monaco` + `shiki`, `@xterm/xterm` (+ `addon-fit`, `addon-search`, `addon-serialize`, `addon-unicode11`, `addon-webgl`), `emmet-monaco-es`, `monaco-vim`, `katex`, `pele` (diagrams), `@tauri-apps/api` and the official `plugin-dialog`, `plugin-opener`, `plugin-clipboard-manager`. Each has a decisions-log entry; anything else needs one too.

**License rule:** runtime dependencies must be MIT, Apache-2.0, BSD, ISC, Zlib, MPL-2.0 or similar permissive licenses. **No GPL/AGPL/LGPL** (the app ships under its own source-available license). Enforced by a Node license-check script in CI (`npm run licenses`), and `cargo deny check licenses` (`src-tauri/deny.toml`) by hand when crates change. Never copy code from GPL/AGPL projects; the design is our own.

## 4. Architecture

```
                    ┌───────────────── Clients ──────────────────┐
                    │ UI · keybindings · palette · built-in agent │
                    │ ACP agents · MCP clients · extensions · tests│
                    └──────────────────────┬─────────────────────┘
                                           ▼
┌──────────────────────────── Frontend host (main thread) ───────────────────────────┐
│  DISPATCHER: resolve → when → validate → authorize(caller, effects) → run → log → emit │
│  Registries: commands · state providers · views · keybindings · settings · themes  │
│  Context keys · Layout tree · Event bus · Extension host manager                    │
│  Built-in extensions: editor · explorer · terminal · git · search · browser · agent│
│  Sandboxed extensions: Web Workers (logic) + sandboxed iframes (webview panels)    │
└──────────────────────────────────────┬─────────────────────────────────────────────┘
                                       │ Tauri IPC: invoke (calls) · Channels (streams)
┌──────────────────────────────────── Rust services ─────────────────────────────────┐
│ fs · watch · search · pty · exec · git(CLI) · net/AI · lsp host · mcp · acp        │
│ browser proxy · secrets · settings/io · checkpoints · audit log                    │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Placement
- The dispatcher and registries live in the frontend host (most commands are editor/layout/UI).
- Rust services are low-level Tauri commands, wrapped as dispatcher commands in TS.
- External clients (MCP, ACP) enter through Rust and are forwarded to the dispatcher over IPC, so they get the same checks and logging.

### 4.2 IPC rules
- Request/response: `invoke`.
- Streams (PTY output, search hits, model tokens, watcher batches, exec output): **Tauri Channels**.
- File contents: raw bytes, not JSON.
- Tauri capabilities expose only needed commands; fs scope limited to the open workspace and app dirs.
- One typed wrapper per Rust service in `src/core/ipc/` — no raw `invoke` calls elsewhere.

### 4.3 Product config (name-agnostic)
`product.json` at repo root is the **only** place names live. Build reads it into Tauri config and a generated `src/core/product.ts`.
```json
{
  "nameShort": "IDE",
  "nameLong": "IDE",
  "identifier": "dev.placeholder.ide",
  "dataFolderName": ".ide",
  "workspaceFolderName": ".ide",
  "serverDataFolderName": ".ide-server",
  "workspaceFolderAliases": [".vscode"],
  "urlScheme": "ide",
  "extensionApiGlobal": "ide",
  "accountsUrl": "",
  "extensionsRepo": "",
  "issuesUrl": "",
  "updates": { "endpoint": "", "betaEndpoint": "", "pubkey": "" }
}
```
(The values above are placeholders; the real file holds the current name.) Renaming the product later = edit this file and rebuild.

## 5. Frontend core (vanilla patterns)
- `core/reactive`: `signal()`, `computed()`, `effect()`, `batch()`. ~100 lines.
- `core/lifecycle`: `Disposable`, `DisposableStore`, `toDisposable()`, `MutableDisposable` (VS Code pattern). Every listener, effect, timer, IPC subscription and child component is registered to an owner's store and disposed with it. **Dev builds track live disposables** and warn when the count keeps growing.
- `core/dom`: `h(tag, props, ...children)`, `on(el, evt, handler) → Disposable`, event delegation.
- `ui/VirtualList`: one virtualization primitive for tree, quick-open, search results, problems, git changes, agent timeline.
- Component shape: `class X implements Disposable { constructor(host, deps); update?(); dispose(); }`.
- Core logic (dispatcher, schema, state, keybindings, when-parser, jsonc, layout model) is **DOM-free** so it is unit-testable in Node.
- CSS: `@layer reset, tokens, base, components, extensions;` themes only override tokens.

## 6. Dispatcher and commands

```ts
type Effect = "read" | "write" | "exec" | "network" | "destructive";
type Caller =
  | { kind: "user" } | { kind: "test" }
  | { kind: "agent"; session: string } | { kind: "acp"; agent: string; session: string }
  | { kind: "ext"; id: string } | { kind: "mcp"; client: string };

interface CommandSpec<I, O> {
  id: string;              // "editor.openFile"  (namespace.verb)
  title: string;           // palette label
  description: string;     // for humans AND models: what it does, when to use it
  input: Schema<I>;        // in-house `s` builder → JSON Schema + TS type
  output?: Schema<O>;
  effects: Effect[];       // drives permission policy
  when?: string;           // context-key precondition
  agent?: "core" | "discoverable" | "hidden"; // default "discoverable"
  examples?: { input: I; note?: string }[];
  run(input: I, ctx: CommandContext): Promise<O>;
}
```

**Pipeline:** look up → check `when` → validate input → `authorize(caller, effects)` (may prompt) → run → validate output (dev builds) → audit log → emit `command.executed`.

**Schema builder (`core/schema`, ~150 lines):** `s.string()`, `s.number()`, `s.boolean()`, `s.enum([...])`, `s.array(x)`, `s.object({...})`, `.optional()`, `.describe()`. Emits JSON Schema and infers TS types.

**Permission policy (defaults, user-configurable):**

| Effect | user | agent / acp | ext (sandboxed) | mcp |
|---|---|---|---|---|
| read | allow | allow within workspace | if `fs.read` granted | allow within workspace |
| write | allow | into **changeset** (default) | if `fs.write` granted | ask |
| exec | allow | ask unless allowlisted | if `shell` granted, ask | ask |
| network | allow | ask per domain | if `network:<domain>` granted | ask |
| destructive | confirm | always ask | always ask | always ask |

Agents can never call commands that change permission settings. Approvals: once / this session / always for this pattern.

## 7. State tree (what agents "see")
```
ide://workspace                 root, trust state, git branch
ide://layout                    split/tab tree, focused part, visible panels
ide://editors                   open tabs (path, dirty, language)
ide://editors/active            path, cursor, selections, visible range, selected text
ide://diagnostics               problems (budgeted, errors first)
ide://terminals                 list (id, cwd, shell, running command)
ide://terminals/<id>/commands   last N: command, cwd, exitCode, output (truncated)
ide://git/status                branch, ahead/behind, changed files
ide://search/last               last query + top hits
ide://browser/<id>              url, title, console errors, DOM snapshot (on request)
ide://agent/<session>           plan, pending changeset, checkpoints
ide://settings                  effective settings (secrets excluded)
```
- `state.get(path, { budget })`: providers respect a size budget and report what was truncated.
- `state.watch(path)`; `events.since(cursor)` for "what changed since the agent's last turn" digests.
- The `ide://` scheme is internal and generic; it does not change with the product name.

## 8. AI integration

### 8.1 Three ways in, one experience
1. **Built-in agent** (local models first; hosted ones too) — a privileged built-in extension.
2. **External agents via ACP** (Claude Code, Gemini CLI, Codex CLI, Copilot CLI, OpenCode, Goose…). Rust spawns the agent; JSON-RPC over stdio; the IDE provides files, terminals and permission prompts. Same chat panel, diff review and permission UI.
3. **External tools via MCP server** (localhost, per-session token). Commands with `agent: core|discoverable` → tools; state paths → resources.

Plus an **MCP client**: the built-in agent uses the user's MCP servers; they are passed through to ACP agents.

### 8.2 Built-in agent core toolset
| Tool | Purpose |
|---|---|
| `read_file(path, range?)` | Read with line numbers; budgeted. |
| `list_dir(path, depth?)` | Ignore-aware listing. |
| `find_files(glob\|fuzzy)` | Locate files. |
| `search(query, regex?, glob?)` | Project text search. |
| `edit_file(path, edits[{old, new}])` | Search/replace edits → changeset. |
| `write_file(path, content)` | New files → changeset. |
| `run_command(cmd, cwd?, timeout?)` | Non-interactive exec → `{exitCode, stdout, stderr}`; mirrored live to an "Agent" terminal tab. |
| `get_state(path)` | Read the state tree. |
| `find_commands(query)` | Search the command registry. |
| `call_command(id, input)` | Call any discoverable command. |

Optional groups per model: **git**, **lsp**, **browser**, **mcp:<server>**. Plus the plan tool,
memory (`remember` / `recall`), display tools (`ask_user`, `show_links`), `explore` and `delegate`
(subagents, D195), dropped for small models. Rarely used tools (and many MCP tools) are named only
and loaded with `tool_search` when needed (`agent.deferTools`, D319, D390).

### 8.3 Agent behavior
- **Default edit mode (decided): changeset review.** Agent edits are held as a pending changeset, shown as inline diffs and in a Changes view, with accept/reject per hunk, file or all. A per-session toggle enables **auto-apply** (still checkpointed). Exec always asks unless the command matches the user's allowlist.
- **Checkpoints** before each agent turn: touched files snapshotted in app data (never the repo); one-click restore.
- **Providers:** OpenAI-compatible client in Rust; models listed from `/v1/models` (and Ollama `/api/tags`); per-model profile (context window, native tool support).
- **Tool calling:** native when supported; strict text-protocol fallback with a forgiving parser.
- **Context:** system prompt + `AGENTS.md`/`CLAUDE.md` + active editor + diagnostics + change digest + conversation; budgeted; old turns compacted.
- **Safety:** tool output from files/web/terminal is marked untrusted; exec/network/destructive need approval unless allowlisted (or, by the user's choice, run outside a denylist: `agent.runCommands`); every action logged to the session timeline. An opt-in operating-system sandbox runs the agent's commands (`agent.sandbox`, D336, D348–D350); it can't change git's settings or the agents' configuration, and on Windows the IDE's git pauses when they change (D392).
- **Sessions:** each agent session is a chat in the chat panel, listed in the side bar's Chats
  list (D291); several can run at once, also in git worktrees with a window each (D193).
- **Agents and subagents (D286–D288):** agents are the personas you talk to (the main agent, the
  default planner and chat partner, the user's own), one model each, and they hand work to each
  other in the open (`hand_off`). Subagents are workers (Explore, Plan, Review, General purpose and
  Claude Code's `.claude/agents` files) with their own prompt, tools and model, in the foreground or
  the background. The plan / build models and the presets of D195–D196 were removed.

### 8.4 Terminal for agents
- Shell integration scripts (bash, zsh, fish, pwsh) emit **OSC 633** (VS Code's protocol; OSC 133 is read too) prompt/command/exit markers + cwd.
- Rust parses the PTY stream, keeps an ANSI-stripped ring buffer per terminal, and produces structured command records.
- Agents read `ide://terminals/<id>/commands`, send input via `terminal.sendText`, and wait for the command-finished marker.

### 8.5 Browser panel
- **Localhost previews (default):** Rust reverse proxy (incl. WebSocket upgrade for HMR) injects a bridge script into HTML responses; rendered in an iframe in our layout; bridge ↔ host over `postMessage`.
- **External URLs:** separate `WebviewWindow` with an `initialization_script` bridge. Move to embedded child webviews once Tauri multiwebview leaves `unstable`.
- **Bridge:** DOM snapshot (compact accessibility-style tree with element refs), click, type, scroll, select, navigate, console/network errors, eval (ask).
- **Debugging pages (D196):** the user's own Chrome or Edge over CDP for launch.json `chrome` /
  `msedge` configurations (breakpoints, source maps). Not bundled.

## 9. Extension system

### 9.1 Tiers
1. **Declarative** (no code): themes, grammars, snippets, keybindings, settings schemas, icon themes, language configs. Auto-trusted.
2. **Sandboxed code:** logic in a **Web Worker**; UI via declarative views or sandboxed iframes; permissions granted at install.
3. **Built-in:** in-process; our own extensions only.
4. **VS Code extensions** (D255–D267, D295–D297): installed from Open VSX, run in a Node extension host with a `vscode` shim over the same API.

### 9.2 Manifest (`extension.json`)
```jsonc
{
  "id": "acme.todo-highlighter",
  "version": "1.0.0",
  "engines": { "ide": "^0.1.0" },
  "main": "main.js",                       // omit for declarative-only
  "activation": ["onLanguage:typescript", "onCommand:todo.list"],
  "permissions": ["fs.read"],              // fs.read, fs.write, shell, network:<domains>, git, browser, terminal, agent
  "contributes": {
    "commands":   [{ "id": "todo.list", "title": "List TODOs", "agent": "discoverable" }],
    "keybindings":[{ "command": "todo.list", "key": "ctrl+alt+t" }],
    "views":      [{ "id": "todo.view", "title": "TODOs", "location": "sidebar", "type": "tree" }],
    "settings":   { "todo.tags": { "type": "array", "default": ["TODO", "FIXME"] } },
    "themes":     [{ "label": "Acme Dark", "path": "themes/acme.json" }],
    "languages":  [{ "id": "toml", "extensions": [".toml"], "grammar": "syntaxes/toml.tmLanguage.json" }],
    "languageServers": [{ "languages": ["python"], "command": "pyright-langserver", "args": ["--stdio"] }],
    "mcpServers": [],
    "agentTools": ["todo.list"]
  }
}
```

### 9.3 API
Exposed to extensions as a global named by `product.json → extensionApiGlobal` (default `ide`), typed by the in-repo `src/api/` package. It is a typed RPC proxy over the dispatcher:
```ts
ide.commands.register(spec) / .execute(id, input)
ide.state.get(path) / .watch(path, cb)
ide.events.on(type, cb)
ide.workspace.fs.read/write/stat/list          // permission-scoped
ide.ui.registerTreeView(id, provider)
ide.ui.createWebviewPanel(opts)                 // sandboxed iframe + postMessage
ide.ui.showQuickPick / showInput / notify
ide.settings.get / onChange
ide.storage.get / set                           // per-extension, Rust-backed
ide.languages.registerProvider(...)
ide.net.fetch(url, init)                        // checked against network permission
```

### 9.4 Isolation
- Workers: no DOM, no Tauri IPC — only the postMessage RPC.
- App **CSP** restricts `connect-src` to IPC; all network goes through `ide.net.fetch` → Rust.
- No app state in IndexedDB/localStorage (workers share the origin); it lives in Rust-managed files.
- Webview panels: `<iframe sandbox="allow-scripts">` + `srcdoc` + strict CSP.
- Extension-declared language/MCP servers are spawned by Rust only after approval.
- **Workspace trust:** untrusted folders disable workspace tasks, extension recommendations, MCP configs and agent auto-exec.

### 9.5 Authoring
"Developer: Load Unpacked Extension" with hot reload; API types; template; docs generated from the command registry. VS Code themes, TextMate grammars and snippets import directly (and install from Open VSX, D254). VS Code extensions' code runs too: our own API at parity with a Node extension host, and a `vscode` shim on top (`docs/vscode-extensions-plan.md`, D254–D267, D295–D297).

## 10. Editor and languages
- `EditorService` owns models, tabs, view state, dirty tracking; Monaco is an implementation detail.
- **Built-in language services (decided for M2):** Monaco's own TS/JS, JSON, CSS and HTML language workers, bundled offline and lazy-loaded per language. They restore autocomplete/diagnostics for web languages before the M3 language-server host. Each worker's size is recorded in `npm run size`.
- Other languages: extensions contribute `languageServers`; Rust spawns them over stdio and relays JSON-RPC over a Channel; a **minimal in-house LSP client** maps LSP to Monaco providers (completion, hover, signature help, definition, references, diagnostics, formatting, rename, code actions, symbols). No `monaco-languageclient`.
- `settings.json` gets autocomplete/validation from contributed settings schemas via Monaco's JSON service.

## 11. Design and layout
- **Visual design is specified in `DESIGN.md`** (tokens, type, motion, components, agent UI, editor/terminal colors, extension-author rules). It is the source of truth for anything visual; `src/styles/tokens.css` implements it.
- Default UI theme: the design system's dark theme (light theme defined too). Syntax: Shiki **`dark-plus`** / `light-plus`. VS Code themes importable.
- Minimal chrome: responsive custom title bar with a centered command field, slim activity bar, palette-first navigation, quiet status bar. Flush panels (one shell color) by default.
- **Settings** are a dock view (tab), with User / Workspace scopes and an "Open settings.json" escape hatch — not a modal.
- **App icon:** `assets/logo.svg` is the single source for the desktop icon (generated with `tauri icon`), the welcome screen and the welcome tab icon.
- **Layout = fixed left sidebar + dynamic dock.** Only the activity bar and sidebar (explorer/search/git/extensions) are fixed. Everything else — editors, terminals, agent sessions, problems, output, browser, extension views — is a tab in one dock: an n-ary split tree of tab groups. Any tab can be dragged to reorder, moved to another group, or dropped on an edge to split. Default arrangement: editors main, terminal below, agent right. Full spec: `docs/dock.md` (dock model, views, drag/drop, keeping views alive, `layout.*` commands).
- Layout persisted per workspace and exposed at `ide://layout`.
- **Keybindings (VS Code defaults):** `Ctrl/Cmd+Shift+P` palette · `Ctrl/Cmd+P` quick open · `` Ctrl+` `` terminal · `Ctrl/Cmd+B` sidebar · `Ctrl/Cmd+J` panel · `Ctrl/Cmd+\` split · `Ctrl/Cmd+Shift+E/F/G/X` explorer/search/git/extensions · `Ctrl/Cmd+S` save · `Ctrl/Cmd+W` close tab · `Ctrl/Cmd+,` settings · `Ctrl/Cmd+L` agent chat · `Ctrl/Cmd+I` inline edit. All rebindable via `keybindings.json` with `when` clauses.
- Accessibility: full keyboard navigation, ARIA roles on tree/list/tabs, visible focus rings, contrast-checked tokens.

## 12. Persistence (decided)
- **Format:** JSON for config/state, JSONL for append-only logs and transcripts. User-edited files are **JSONC** (comments + trailing commas) parsed by an in-house parser (`core/settings/jsonc.ts`).
- **Location:** OS app-config dir from Tauri path APIs, subfolder from `product.json`. Workspace-level config in `<workspace>/<workspaceFolderName>/`.
```
<appConfig>/
  settings.json            user settings (JSONC)
  keybindings.json         user keybindings (JSONC)
<appData>/
  workspaces/<sha256(canonical path)>/state.json   layout, tabs, view state
  agent/sessions/<id>.jsonl                         transcripts
  agent/checkpoints/<session>/<turn>/               file snapshots
  extensions/<id>/                                  installed extensions + storage
  logs/audit.jsonl                                  dispatched commands (rotated)
  logs/app.log                                      diagnostics (rotated)
<workspace>/.ide/settings.json                      workspace settings (name from product.json)
```
- **Precedence:** defaults < user < workspace.
- **Safety:** all writes are atomic in Rust (write temp file → fsync → rename). Every state file has a `"version"` field with forward migrations. Logs rotate at 10 MB, keep 5.
- **Secrets:** OS keychain only, never in files.
- **Future cloud sync:** all user data is plain files under two folders, so a sync feature can be added later without changing formats. No sync work in v1.

## 13. Performance budgets (decided)
Reference machine: mid-range laptop from the last 4 years.
| Metric | Budget |
|---|---|
| Cold start → shell visible | **< 500 ms** (warm < 300 ms) |
| Cold start → editor interactive | **< 1.5 s** (Monaco lazy-loaded after shell) |
| Keystroke → paint | **< 16 ms p95**; no main-thread task > 50 ms while typing |
| Open 100k-file repo | tree visible < 1 s; no jank (lazy dirs, virtualized rows) |
| Terminal flood (`cat` large file) | UI stays responsive (Channel batching, rAF rendering) |
| Installer size | **Windows/Linux < 20 MB; macOS universal < 35 MB** |
| Idle memory (incl. webview) | **< 300 MB** with one project open |

**Enforcement:** `npm run size` reports the bundle and binary sizes in CI; the budget is checked by hand at each milestone. Startup timings are recorded via a `dev.perfReport` command (dev builds) and checked at each milestone.

## 14. Testing and quality (decided)
- **Type check:** `tsc --noEmit` in `npm run check` and CI. Strict mode, no `any`, `noUncheckedIndexedAccess`.
- **Lint/format:** Biome (TS/JSON/CSS); `rustfmt` + `clippy -D warnings`.
- **TS unit tests:** DOM-free core modules; esbuild bundles `*.test.ts` → `node --test`. No test framework dependency.
- **Rust unit tests:** `cargo test`.
- **Integration (command scripts):** JSON scripts listing dispatcher commands + state assertions, run inside the real app with `caller: test`. Launched by `--run-test-script <path>` (dev builds), exits with a status code. Runs in CI on Linux under Xvfb when the workflow is started by hand (`gh workflow run ci`). This is the same surface agents use, so the agent API is tested continuously.
- **E2E smoke via `tauri-driver`:** later (Milestone 4+).
- **License check:** the Node license script in CI, `cargo deny` by hand (§3).
- **CI:** GitHub Actions on Linux and Windows: check, lint, unit and Rust tests, licenses, a size report; the command-script suite only when started. macOS joins after the macOS pass.
- Test early on all three webviews: WebView2 (Windows), WKWebView (macOS), WebKitGTK (Linux, slowest).

## 15. Repo structure
```
/
├─ product.json               # ALL naming lives here
├─ AGENTS.md
├─ README.md
├─ docs/decisions.md          # decisions log
├─ build.mjs                  # esbuild: app, workers, dev server
├─ package.json  tsconfig.json  biome.json
├─ scripts/                   # size check, license check, test runner
├─ tests/scripts/             # command-script integration tests (JSON)
├─ src-tauri/
│  ├─ capabilities/
│  └─ src/
│     ├─ main.rs  lib.rs
│     ├─ ipc/  fs/  watch/  index/  search/  pty/  exec/  git/  ai/  lsp/  debug/
│     ├─ mcp/  acp_agents/  agent/  browser/  history/  audit/  store/  remote/
│     ├─ extensions/  accounts/  update/  speech/  desktop/  diagnostics/  instances/
└─ src/
   ├─ index.html  main.ts
   ├─ core/
   │  ├─ product.ts (generated)   dispatcher/  schema/  permissions/  state/  events/
   │  ├─ reactive/  lifecycle/  dom/  keybindings/ (+ when parser)  context/
   │  ├─ layout/  settings/ (+ jsonc)  themes/  extensions/  ipc/
   ├─ api/            # public extension API types (separately publishable)
   ├─ extensions/     # built-ins: editor, explorer, terminal, git, search, browser, agent, palette, debug, testing, remote…
   ├─ ui/             # VirtualList, Tree, Tabs, Menu, QuickPick, Button, Icon sprite
   └─ styles/         # tokens.css, base.css, themes/default-dark.json, themes/default-light.json
```

## 16. Milestones
- **M1 — Walking skeleton.** ✅ Scaffold, dispatcher, palette, layout, explorer, editor, terminal, state tree, audit log.
- **M1.5 — Design system + dynamic dock.** ✅ DESIGN.md v1, dock, Windows hardening.
- **M1.6 — Polish from the first Windows run.** ✅ DESIGN.md v2 (neutral, flush), layout overflow, terminal sizing, tree states, context menus, responsive title bar, settings tab, logo.
- **M2 — Core editing.** ✅ Language workers, split groups, quick open, search/replace, problems, settings/keybindings files, reload from disk, shell integration, command-script tests, **MCP server**.
- **M3 — Git + LSP host.** ✅ Source control, hunks, diffs, branches, remotes; LSP host and client.
- **M4 — Agents.** ✅ Built-in agent (providers in Rust, core toolset, changesets, checkpoints, permissions), MCP client, **ACP host**.
- **M5 — Browser.** ✅ Injecting proxy + frame preview, static previews with live reload, bridge tools for agents, external-URL window, DevTools.
- **M6 — Third-party extensions.** ✅ Worker sandbox, permission UI, workspace trust, webview panels, load-unpacked, VS Code theme/grammar/snippet import.
- **M6.x — Parity and depth (D111–D149).** ✅ Done in many small releases, each one "ide-m6.N", tested, logged and delivered:
  - Editor: snippets, outline, symbols, hot exit, untitled files, project formatters, Error Lens diagnostics, VS Code metrics.
  - Workbench: quick access, tasks with problem matchers, preview in place, activity badges, profiles, sidebar placement, auxiliary windows.
  - Agent: memory, compaction, sub-agents, prompt caching, a native Anthropic provider, verify step, Edit with AI and completions.
  - Git: graph, rebase, worktrees, GitHub, Publish to GitHub.
  - Debugger (Node inspector + DAP), Testing view, bookmarks.
  - Browser DevTools with editable styles and a Chrome-like Performance recording.
  - Audits: a whole-codebase audit before each larger step (D120, D138, D149).
- **M6.9x — Agents and adoption (D188–D196).** ✅ Notebooks you run and edit, moving from VS Code
  in one step, MCP from every config with secret inputs and remote servers, agents in worktrees,
  reviews, next-edit suggestions, auto-update and signed releases (keys pending), WSL folders,
  model roles, subagents and presets, browser debugging, search editors, the Timeline, Vim mode.
- **M7 — Polish & ship (near its end).** Done: hosted providers, AI in the editor, light theme,
  accounts groundwork, auto-update; language servers on demand and TypeScript across the project,
  Report a problem, terminal profiles, agent edits on disk, Emmet (D199–D209); the agent team,
  channels and schedules (D237–D253); multi-root workspaces, SSH and dev containers (D251, D252,
  D266); VS Code extensions from Open VSX (D255–D267, D295–D297); back / forward, tab options and
  the debugger's extras (D279); a plain chat panel with agents and subagents as in Claude Code
  (D286–D291); the agent's tools beside Claude Code's (D292–D375: plan mode, widgets, monitors,
  workflows, hooks, plugins…); an opt-in sandbox for its commands (D336, D348–D350); desktop
  control (D353); images in the chat (D381); dictation on this computer with Whisper (D384); F11
  full screen (D387); Claude Code's slash commands with inline "/" and "@" lists (D389); rarely
  used tools loaded on demand (D390); a full audit (D391); the sandbox keeps git's settings and
  the agents' configuration (D392); read-only files, hidden secrets and paste from history (D393);
  a code-health pass (D394). Left before outside testers: the owner's Windows pass and release
  keys, and a hand check of an installed build (`docs/feature-gaps.md`, "Next up").

## 17. Source-available
- **License:** the PolyForm Shield License 1.0.0 (`LICENSE`): free for any use except providing a product that competes with the IDE. `COMMERCIAL-LICENSING.md`, `TRADEMARKS.md`, `CONTRIBUTING.md` and `SECURITY.md` explain it and say how to reach us.
- Clean boundaries: `src/api/` and each built-in extension are self-contained and could be published separately.
- No secrets, keys or private URLs in the repo; config via env or keychain.
- Only permissively licensed dependencies (§3). `npm run licenses` checks them and `npm run notices` writes `THIRD_PARTY_NOTICES.md`; run it after adding or updating a dependency.
- No product name in code (§4.3), so a rename is mechanical.
- This repository is where the work happens and what is published (D418): there is no private copy to export from.

## 18. Non-goals (v1, decided)
Telemetry · bundled Chromium. (VS Code extension API compatibility moved from here to a phased plan: `docs/vscode-extensions-plan.md`, D254.) Deferred (possible later, tracked in `docs/feature-gaps.md`): cloud sync · real-time collaboration. Bigger directions after the alpha (a hosted web version as a paid option, among others) are in `docs/long-term-goals.md`. (Multi-root workspaces, SSH and dev containers were deferred here and are done: D251, D252, D266.) External accounts are opt-in and go through the user's own tools (`gh` for GitHub, D139/D148).

## 19. Decisions log (seed `docs/decisions.md`)
- D1 Tauri 2 over Electron/Electrobun — smallest mature option.
- D2 Vanilla TS, no framework — size, tweakability, AI legibility; leaks handled by `DisposableStore`.
- D3 esbuild over Vite — speed, one dependency.
- D4 Monaco over CodeMirror 6 — diff editor, familiarity, LSP-shaped providers; lazy-loaded.
- D5 Git CLI over gix — zero size; gix lacks push/full clone/rebase/reset.
- D6 Dispatcher in frontend host; Rust services underneath; external clients forwarded.
- D7 Small core agent toolset + discovery meta-tools — local models can't handle hundreds of tools.
- D8 ACP + MCP for external agents and tools.
- D9 All network via Rust — CORS, key safety, enforceable extension permissions.
- D10 Browser via injecting proxy + iframe until Tauri multiwebview is stable.
- D11 Agent default edit mode = changeset review; auto-apply is a per-session toggle.
- D12 No product name in code; `product.json` is the single source.
- D13 Closed source at first, source-available (PolyForm Shield) from the first public release (D417); permissive-license dependencies only.
- D14 Persistence = JSON/JSONC/JSONL files with atomic writes and versioned schemas.
- D15 Biome for lint/format; `node --test` for TS tests (no test framework dependency).
- D16 onward live in `docs/decisions.md` (numbered as they are made). Notable: editor library swap to `monaco-editor-core` + `@shikijs/monaco` (later `monaco-editor`, for its language workers); ghostty-web, later replaced by xterm.js (D48); watch only expanded folders; dynamic dock; `DESIGN.md` design system.
