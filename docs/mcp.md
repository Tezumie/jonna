# The IDE's MCP server

The IDE can run a [Model Context Protocol](https://modelcontextprotocol.io) server so an external
agent, such as Claude Code, can use the same commands the UI uses (open files, search, run
terminal commands, read diagnostics…) and read the IDE's state.

- **Off by default.** Turn it on with the setting **MCP: Enabled** (`mcp.enabled`) or the command
  **MCP: Start MCP server**. While it runs, the status bar shows **MCP** on the right; click it for
  the connection info.
- **Local only.** It listens on `127.0.0.1` on a random port, at `http://127.0.0.1:<port>/mcp`
  (Streamable HTTP). Requests must carry `Authorization: Bearer <token>`; the token is new every
  time the server starts. Requests from browser pages on other origins and non-loopback `Host`
  headers are refused.
- **You stay in control.** Calls run as caller `mcp` (with the client's name) under the permission
  policy: commands that only read (and UI-only commands with no effects, like switching the
  theme) run directly; anything that writes files, runs programs or touches the network asks you
  (*Allow once* / *Allow for this session* / *Deny*); destructive commands (delete, replace in
  files) ask every time. Commands marked as UI-only (`agent: "hidden"`, e.g. the palette) are not
  offered at all. Every call is in the audit log with its caller.
- **Start with `help_agentGuide`.** It is among the listed tools: what the IDE offers an agent,
  where its documentation is, and (`{ "topic": "extensions" }`) how to extend the IDE (D419).
- **An agent in a chat is that chat's agent (D419).** An external agent the IDE runs in a chat
  calls with a token of its own, so its calls run as that chat's agent rather than as an MCP
  client: questions are cards in the chat, the chat's access mode applies, and it may run what
  the IDE's own agent may (installing an extension from a folder, say).
- **External agents borrow it.** An external agent the IDE runs over ACP (Claude Code, Codex…)
  gets the same server without `mcp.enabled` being on: over HTTP when it takes HTTP servers, else
  through the IDE's own program as a stdio proxy (D211, D223). `agent.externalAgents.ideTools`
  turns this off.

## What an agent sees

- **Tools**: the "core" commands — `editor_openFile`, `quickOpen_search`, `search_run`,
  `problems_list`, `terminal_runCommand`, `layout_*` … (command ids with `.` → `_`), plus
  `ide_find_commands { query }` to discover the other commands and `ide_run_command { command,
  input }` to run them. Each tool's input schema is the command's own schema.
- **Resources**: every state path, e.g. `ide://workspace`, `ide://editors/active`,
  `ide://diagnostics`, `ide://search/last`, `ide://terminals`, `ide://terminals/<id>/commands`,
  `ide://layout`, `ide://settings`, `ide://keybindings`.
- `terminal_runCommand` waits for the command to finish (shell integration: bash, zsh, fish,
  PowerShell) and returns its exit code and output, so an agent doesn't need to scrape the screen.

## Claude Code's `/ide` (D204)

With **MCP: Claude Code integration (/ide)** (`mcp.claudeCode.enabled`, off by default), the IDE
does what VS Code's and JetBrains' Claude Code extensions do, so `/ide` in Claude Code finds it by
itself:

- It writes a lock file `~/.claude/ide/<port>.lock` (`%USERPROFILE%\.claude\ide` on Windows,
  `$CLAUDE_CONFIG_DIR/ide` when that's set) holding `pid`, `workspaceFolders`, `ideName`,
  `"transport": "ws"` and an `authToken` (new every start), and removes it when it stops. The file
  is readable only by you on macOS and Linux.
- It listens on `127.0.0.1:<port>` for a WebSocket (MCP's JSON-RPC in text frames); every
  connection must send the token as `x-claude-code-ide-authorization`, and one from a browser page
  (an `Origin` header) is refused.
- Terminals opened afterwards have `CLAUDE_CODE_SSE_PORT` and `ENABLE_IDE_INTEGRATION=true`, so a
  Claude Code started in one connects without `/ide`.
- Tools Claude Code calls: `getCurrentSelection`, `getLatestSelection`, `getOpenEditors`,
  `getWorkspaceFolders`, `getDiagnostics`, `openFile`, `openDiff`, `checkDocumentDirty`,
  `saveDocument`, `close_tab`, `closeAllDiffTabs`. The selection is sent as `selection_changed` as
  it changes.
- **Diffs:** `openDiff` opens the file against Claude Code's proposal. **Accept** (the
  notification, the status bar's *Claude Code: 1 diff*, or **MCP: Accept Claude Code's diff**)
  writes the file and answers `FILE_SAVED`; **Reject** answers `DIFF_REJECTED`.
- `ide://mcp/claudeCode` shows whether it runs, the lock file and how many sessions are connected.

The protocol follows the community write-up of the extensions' behaviour (claudecode.nvim's
PROTOCOL.md). Claude Code's `executeCode` runs code in an open Jupyter notebook after asking you,
and answers with the cell's output and images (D207, D222).

## Connect Claude Code on Windows

1. In the IDE: **MCP: Start MCP server** (or enable `mcp.enabled` in Settings). A dialog shows the
   URL, the token and a ready-made command; **Copy Claude Code command** puts it on the clipboard.
2. In PowerShell (or Windows Terminal), in the project folder:

   ```powershell
   claude mcp add --transport http ide http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
   ```

   Add `--scope user` to make it available in every project. Check with `claude mcp list`; inside
   Claude Code, `/mcp` shows the server and its tools.
3. Because the port and token change whenever the IDE (or the server) restarts, re-register after a
   restart. The IDE also writes the current URL and token to `mcp.json` in its app data folder
   (`%APPDATA%\<identifier>\mcp.json`, where `<identifier>` is `identifier` from `product.json`;
   removed when the server stops), so a small script can do it:

   ```powershell
   $info = Get-Content "$env:APPDATA\<identifier>\mcp.json" | ConvertFrom-Json
   claude mcp remove ide 2>$null
   claude mcp add --transport http ide $info.url --header "Authorization: Bearer $($info.token)"
   ```

   (macOS: `~/Library/Application Support/<identifier>/mcp.json`; Linux:
   `~/.local/share/<identifier>/mcp.json`.)

**Claude Code inside WSL:** WSL 2's default NAT networking can't reach the Windows host's
`127.0.0.1`. Use WSL's mirrored networking mode (`networkingMode=mirrored` in `.wslconfig`), or run
Claude Code from Windows.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `401` / "missing or wrong bearer token" | The server restarted (new token): copy the command again. |
| Connection refused | The server is off (no **MCP** in the status bar), or the port changed. |
| A tool says "Not permitted" | You chose *Deny*, or the command is UI-only. |
| A call waits | The IDE is asking you for permission: look at its window. |

# MCP servers the agent uses (D193)

The other direction: servers whose tools the IDE's own agent can call. They start with the
agent's first message; the MCP servers page (Customize → MCP servers, also **MCP servers…** in the
chat's ⋯ menu) shows each one's state, and the agent can check them with `mcp_status` (a card
with Reconnect). A server's switch there (`agent.mcp.disabledServers`) keeps it from starting, and
its Configure dialog hides single tools (`agent.mcp.disabledTools`).

Where they come from, first match by name wins:
1. The setting `agent.mcpServers`, the user's `mcp.json` next to `settings.json`
   (Import from VS Code copies VS Code's here), and the servers of enabled Claude Code plugins
   that you let start when installing them (D358).
2. The folder's `<IDE folder>/mcp.json` (the IDE's own workspace folder), and `.vscode/mcp.json` and
   `.mcp.json`, which other tools use, in every folder of the workspace. They're only read in
   a trusted folder that isn't a risky one (Downloads, the home folder, a drive root…; D213), and
   each server is approved once: a card in the chat shows its command before it starts.
3. With `agent.mcp.discovery` on: Claude Desktop's config, Claude Code's `~/.claude.json`,
   Cursor's `~/.cursor/mcp.json` and VS Code's user `mcp.json`.
4. Extensions.

The format is VS Code's:

```jsonc
{
  "inputs": [
    { "type": "promptString", "id": "github-token", "description": "GitHub token", "password": true }
  ],
  "servers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${input:github-token}" }
    },
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"], "envFile": ".env" }
  }
}
```

- `${input:id}` is asked once, in a hidden box when it's a password.
  - Passwords are stored on this computer, in the OS keychain like API keys (D207), and filled in
    by the native side when the server starts.
  - Neither the agent nor the page ever sees them, and one server can't read another's.
  - **MCP servers… → Forget its stored inputs** asks again.
- `${env:NAME}`, `${workspaceFolder}`, `${userHome}` and `envFile` work as in VS Code.
- Remote servers (`url`) use Streamable HTTP, https only (or http on localhost). A server that
  answers 401 signs in with OAuth (below); a token header with an input works too.
- Asking the agent to "install X" makes it call `agent.addMcpServer`. You approve the server, and
  any key is asked in the hidden box rather than pasted into the chat. When a task needs a server
  you don't have, the agent can call `suggest_mcp_server`: a card with up to three servers from the
  gallery and the MCP registry, each with its inputs and Add (keys go to the keychain, not the chat; D343).

## Prompts, resources and questions from servers (D200)

The agent's MCP client follows the 2025-06-18 specification:

- **Tools, prompts and resources stay current.** When a server sends
  `notifications/tools/list_changed` (or `prompts/…` or `resources/…`), the list is fetched again;
  the next step of a turn has the new tools. **MCP servers…** and `ide://agent/mcp` show each
  server's tool, prompt and resource counts.
- **Prompts are slash commands.** A server's prompt `review` on server `docs` is
  `/mcp__docs__review` in the message box (type `/` to see them with their arguments). What you
  type after it fills the arguments: `name=value` pairs, then the remaining words in order, and
  a prompt with one argument takes the whole text. A required argument that's missing is asked
  for. The prompt's messages go with your message. `agent.mcpPrompts` lists them.
- **Resources are @-mentions.** Type `@` and part of a resource's name: the running servers'
  resources are listed; the one you pick is read when the message is sent
  (`@mcp <server> <uri>`). The agent can list and read them too (`agent.mcpResources`; with
  **MCP tools protection** on, reading asks).
- **Servers can ask you something** (elicitation). A box at the top of the window shows the
  server's name and question: **Answer…** asks for each field in turn (checked against what the
  server wants: numbers, a choice, yes / no, an email), **Decline** tells the server no, and
  Escape cancels. Never type passwords or keys there; the protocol forbids servers from asking.

Limits: prompts and resources are listed once the servers run (they start with the chat's first
message, or **MCP servers… → Restart**). A remote server's list_changed and questions also arrive
between requests: after initialize the IDE keeps a GET event stream open to it, reconnecting with
back-off (D207; a server that answers 405 has none). URL-mode questions (a later revision's
sign-in pages) are declined.

## Sign-in, sampling, templates, the gallery (D204)

The **MCP servers** page (Customize → MCP servers, the chat's ⋯ menu, Settings → Agent) lists
the servers with their state and counts, and has Sign in / Sign out, the sampling choice, Restart
and Remove, plus a
**gallery** of popular servers (filesystem, git, fetch, memory, Playwright, Chrome DevTools,
Context7, DeepWiki, GitHub, Sentry, Linear, Notion, Hugging Face, Brave Search…). The gallery is
built in (no network to show it); **Install** writes the server into this folder's mcp.json or
yours, with its inputs declared. The agent can list it (`agent.mcpGallery`) and install from it
(`agent.installMcpServer`, you approve).

- **OAuth** (the MCP authorization spec, 2025-06-18). When a remote server answers 401, **Sign
  in** finds its authorization server (the protected resource metadata named by the
  `WWW-Authenticate` header, or the well-known address; then the server's RFC 8414 / OpenID
  metadata; older servers' default endpoints), registers the IDE as a client (dynamic client
  registration; a server without it takes `"oauth": { "clientId": "…" }` in the server's config),
  and opens the sign-in page in your browser with PKCE (S256) and the `resource` parameter. The
  browser comes back to a loopback address the IDE listens on (`http://127.0.0.1:<port>/callback`)
  for five minutes. Tokens are kept with the API keys, in the OS keychain (Windows Credential
  Manager, macOS Keychain, the Secret Service; D207), never shown to the page or the agent, sent as the Bearer header, and refreshed
  when they expire or a request gets 401. A configured `Authorization` header wins.
- **Sampling** (`sampling/createMessage`): a server can ask to run a prompt on your model. A quick
  input shows the server, the model and the prompt (Allow once / Always allow it in this window /
  Deny / Show the whole prompt); `agent.mcp.sampling` (`{ "server": "allow" | "deny" | "ask", "*":
  … }`) answers ahead. The model is the server's hint when you have it, else the chat's; no
  tools, `maxTokens` capped at 8192; the Usage page counts it as *MCP sampling*. When you approved
  the request by hand, the model's answer is shown in an editable dialog (Send / Reject) before it
  goes back (D207). A refusal reaches the server as the spec's user-rejected error (-1).
- **Resource templates** (`resources/templates/list`) appear in the @ picker as "(fill in)"; their
  variables are asked when the message is sent. `agent.mcpResources` lists them and reads one
  with `values`.
- **Subscriptions**: a resource a chat attached is subscribed to when the server allows it; when
  it changes (`notifications/resources/updated`), the chat's next message carries its new text
  (`ide://agent/mcp/subscriptions`).
- **Deferred tools** (`agent.deferTools`, D319; it replaced D204's `agent.mcp.toolSchemas` and
  `mcp_tool_schema`): with more than 30 MCP tools or about 6,000 tokens of their definitions
  (`auto`), or `always`, the model sees only their names with one line each, plus `tool_search`
  (`select:a,b`, keywords, `+word`), which loads the tools it names; they carry their full schema
  from the next step on and stay loaded for the chat. `never` sends every schema. The IDE's own
  rarely used tools are deferred the same way on `auto` and `always` (D390); `never` sends them too.
