# extensions/help

The user guide (`docs/guide/*.md`, 21 pages, bundled with `?raw` imports; `pages.ts`, D283) in a
singleton `docs` dock tab (`docsView.ts`: page list, Markdown, links to pages / anchors / the web /
`command:` ids) — `help.showDocs {page?}` (Help → Documentation) — and for agents,
`help.readDocs {page?}` (D133).

Alpha support (D204):
- `errorCapture.ts` — `ErrorCapture`: `window` errors, unhandled rejections, `console.error`,
  failed IPC calls (`onFailedCall` in `core/ipc/invoke.ts`; NotFound / Cancelled / NoWorkspace
  are expected and skipped) and failed commands go through a `LogBuffer` (core/diagnostics) to
  the Rust session log every 2 s; the last errors are kept for the report.
- `reportModel.ts`, `reportView.ts`, `reportCommands.ts` — Help → Report a problem: a singleton
  `report` dock tab. The parts (system, recent errors and error notifications, the session log's
  last 80 lines, the state paths in `REPORT_STATE_PATHS`, a screenshot taken when it opens) are
  redacted when gathered (`core/diagnostics/redact.ts`); each has a checkbox and shows its exact
  text. Commands: `help.reportProblem {title?, description?}`, `help.reportInclude {section,
  included}`, `help.reportCopy`, `help.reportOpenIssue {dryRun?}` (product.json `issuesUrl`; a
  body too long for the link is cut and the whole goes to the clipboard), `help.reportSaveZip
  {path?}` (Rust `report_save_zip`). State: `ide://report`.
- Logs: `help.openLogsFolder` (reveals this session's file in the OS file manager),
  `help.showLog` (a read-only tab), `ide://logs` (`?lines=n`).
- Output channels (D209, VS Code's Output panel; `core/diagnostics/output.ts`, tested): Window
  (the session log's records), Extension host, Git (the git command lines the IDE ran, `> git
  status -z [12 ms]`, from Rust's `git/journal.rs` via `log_git_commands`, fetched shortly after
  a git call; `core/diagnostics/outputText.ts`: changes at info, queries at trace, failures at
  warn), Tasks, Agent (commands agents, ACP agents and MCP clients ran) and one per language
  server, each in memory for the Output tab (`outputView.ts`, the `output` dock tab: channel
  picker, filter box `text, !exclude`, the channel's log level, word wrap, clear, open the logs
  folder) and, but for Window, in a file per channel in this session's logs folder
  (`sessions/session-<time>-<pid>/<channel>.log`, Rust `write_channel`). `log.level` (trace,
  debug, info, warn, error; default info) is every channel's default and the session log's;
  `log.channelLevels` (`{ "git": "trace" }`) gives a channel its own (VS Code's Set log level per
  channel); debug adds every command that ran to Window, trace git's queries. `outputCommands.ts`:
  `output.show {channel?}`, `output.clear {channel?}`, `output.read {channel, lines?}`,
  `output.setFilter {text}`, `output.toggleWordWrap {on?}`, `log.setLevel {level?, channel?}`
  (`"default"` for a channel goes back to log.level), `ide://output` (channels with their levels,
  the tab's filter and wrap).
- `safeMode.ts` — `help.restartWithExtensionsOff`, `help.restartNormally`,
  `help.clearNextStart`; the status bar item `help.extensionsOff`; `ide://safeMode`. The
  extension manager (`extensions/extensions/manager.ts`) runs nothing while
  `sessionIpc.extensionsOff()`.
- `releaseNotes.ts` — What's new: `docs/release-notes.md` in a `releaseNotes` dock tab,
  `help.showReleaseNotes {release?}` (Help → Release notes), opened after an update once the
  folder is restored (`update.showReleaseNotes`).
