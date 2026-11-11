# extensions/mcp

Turns the Rust MCP server (`src-tauri/src/mcp`) on and off with `mcp.enabled`, keeps its catalog
current (commands → tools, `ide://` paths → resources), and runs forwarded calls as caller
`{ kind: "mcp", client }` (the permission policy asks the user for writes). Status bar: **MCP**.

**A chat's external agent (D419):** a chat that borrows the server (`mcpAgentAccess.acquire(owner,
{ agent, session })`) gets a token of its own, the server's plus `.<key>`; calls that carry a key
this window gave out run as `{ kind: "acp", agent, session }`, so their questions show in that
chat under its access mode. The keys live here (`chats`), until the chat releases the server.

**Commands:** `mcp.start`, `mcp.stop`, `mcp.showConnectionInfo`. **State:** `ide://mcp`.
How to connect Claude Code: `docs/mcp.md`.

**Claude Code's `/ide` (D204, `ideIntegration.ts`):** with `mcp.claudeCode.enabled` the Rust side
(`mcp/ide_ws.rs`) writes `~/.claude/ide/<port>.lock` and serves Claude Code's IDE tools over a
local WebSocket; this file answers them (selection, open editors, diagnostics, openDiff with
Accept / Reject) and sends `selection_changed`. Commands `mcp.claudeCodeIntegration`,
`mcp.acceptIdeDiff`, `mcp.rejectIdeDiff`, `mcp.reviewIdeDiff`; state `ide://mcp/claudeCode`.
D207: getDiagnostics gives whole ranges; `executeCode` runs code in an open Jupyter notebook's
kernel after the user says yes (a new cell at its end, through `notebook.insertCell` /
`notebook.runCell`; output as text); `mcp.sendSelectionToClaudeCode` sends `at_mentioned`
(0-based lines). The DOM-free parts are `core/mcp/ideTools.ts` (tested).
D222: executeCode answers the cell's images as MCP image content (`notebook.runCell` with
`images`, `executeCodeResult`); a new cell per run stays (the VS Code extension does the same).
Send selection is in the editor's context menu and on Ctrl+K Alt+K (Cmd+K Alt+K) while the
integration runs (context key `claudeCodeIdeRunning`); given the editor's own file without lines
it sends that editor's selection. Test: `tests/scripts/agent-worktrees-m7-7.jsonc`.

**Lent to external agents (D211):** `core/mcp/agentAccess.ts`: an ACP chat borrows the server (it starts without turning `mcp.enabled` on and stops when the last borrower leaves) and passes it to agents that take HTTP MCP servers; agents that take only stdio ones get the IDE's executable as a proxy to it (D223, `mcpIpc.stdioProxy`).

**Claude Code disconnecting (D223):** Rust sends `{ kind: "cancel", id }` for each call of a WebSocket that closed; `ideIntegration.ts` closes that call's diff tab without writing (a notification says so).

**Multi-root workspaces (D251):** the lock file and `getWorkspaceFolders` list every folder of the workspace (updated as folders are added or removed); relative paths resolve the workspace's way (`api/src/x.ts`).
