// What an agent that isn't the IDE's own needs to know to work in the IDE (D419): the IDE's own
// agent gets this in its prompt (extensions/agent/context.ts); an external agent (Claude Code,
// Codex… over ACP) or any MCP client brings its own prompt and knew none of it, so it treated
// the IDE as VS Code. `help.agentGuide` returns these texts; the MCP server's instructions point
// at it. DOM-free and tested. No product name: "the IDE".

export const AGENT_GUIDE_TOPICS = ["extensions"] as const;
export type AgentGuideTopic = (typeof AGENT_GUIDE_TOPICS)[number];

export interface AgentGuideFacts {
  /** The IDE's own folder inside a project (product.json: workspaceFolderName). */
  workspaceFolder: string;
}

function overview({ workspaceFolder }: AgentGuideFacts): string {
  return `# Working in this IDE (for agents)

This IDE is its own program, not VS Code: its menus, keys, settings and extension format differ.
Check before you describe them to the user.

## How you reach it
- Everything the IDE does is a command. A few are listed as tools; find the rest with
  ide_find_commands { query } and run one with ide_run_command { command, input }. (The IDE's
  documentation writes "call_command <id> {…}": that is ide_run_command.)
- State is under ide:// resources: ide://workspace, ide://editors, ide://diagnostics, ide://terminals, ide://git, ide://debug,
  ide://tests, ide://layout, ide://extensions.
- Reading never asks. A command that changes something asks the user in your chat; changing the
  IDE itself (layout, views, theme, settings, extensions) asks once per chat even with full
  access. Do those when the user asked for them, not on your own initiative.

## What to use
- The user guide: help.readDocs (no input: the pages; { page }: one page). Use it for "how do
  I…" questions about the IDE instead of answering from what VS Code does.
- Show the user something: editor.openFile { path, line }, editor.compareFiles, help.showDocs.
- Debugger: debug.setBreakpoint, debug.start, debug.continue / debug.stepOver, debug.evaluate;
  ide://debug says where it stopped and the variables.
- Tests: tests.run (ide://tests). Problems: problems.list (ide://diagnostics).
- Terminals: terminal.start for servers and long commands, terminal.readOutput for what the
  user's terminals show.
- Browser preview and DevTools: browser.open, browser.devtools, browser.console.
- Git: git.* commands (ide://git).
- Settings: ide://settings to read, settings.set { key, value } to change one.
- When the user asks you to use or demo one of the IDE's tools, drive it with its commands
  rather than describing steps for them to follow.

## Where things are
- The IDE keeps a project's settings, tasks, launch configurations and extensions in
  ${workspaceFolder}/ inside the project ("<workspace folder>" in command descriptions).
- Project instructions for agents: AGENTS.md at the project's root.

## Extending the IDE
To add a feature to the IDE itself (a command, view, panel, theme, file viewer; users may say
mod or plugin), build an extension. Read help.agentGuide { "topic": "extensions" } first.`;
}

function extensions({ workspaceFolder }: AgentGuideFacts): string {
  return `# Building an extension for this IDE (for agents)

The full reference is the extensions.guide command (no input: its sections; { section }: one).
Read its "choosing-a-format" section before you start, then the sections for what you build.

## Pick the format
1. **The IDE's own format** (default): a folder with extension.json and main.js. Its code runs
   in a sandbox and reaches the IDE only through the \`ide\` object, with the permissions the
   user grants. Its commands have descriptions and input schemas, so agents can call them, and
   it can publish ide:// state. Choose it for anything the \`ide\` API covers.
2. **The same format in Node** ("host": "node" with the "node" permission): for an npm package,
   a native module, a server or direct file access the sandbox doesn't allow. Still \`ide\`.
3. **A VS Code extension** (package.json, require("vscode")): when it must also run in VS Code,
   or when you are changing one that already exists. It runs in Node behind the IDE's vscode
   module; most of VS Code's API is there, and calls that aren't are logged.
Say which one you chose and why. Don't write a VS Code extension only because the IDE looks
like VS Code.

## The IDE's own format
1. extensions.create { name, displayName, description }: never write the folder by hand. It goes
   in ${workspaceFolder}/extensions/<name> and loads at once as a development extension that
   reloads when its files change.
2. extensions.examples lists small working extensions to copy.
3. Edit its files, then extensions.validate { folder }; fix what it lists.
4. Added permissions: extensions.grantPermissions { id } so the user can allow them.

## A VS Code extension
1. Write it in ${workspaceFolder}/extensions/<name> (package.json with "publisher", "name" and
   "main"), then extensions.loadFromWorkspace { folder }. A folder elsewhere:
   extensions.loadUnpacked { folder } (absolute path). Both run it in place and reload it when
   its files change; the user is asked to allow its code.
2. Its npm dependencies stay in its own node_modules.

## Check it before you say it works (both formats)
- ide://extensions?id=<id>: \`status\` must be "active"; \`log\` has its console output, errors
  and refused requests; \`live\` what it registered. A folder that didn't load is under
  \`notLoaded\` with the reason.
- extensions.try { id, command, input } runs one of its commands and returns the result and
  the log lines it wrote. Try every command it adds.
- A VS Code extension: ide://ext/<id>/vscode lists the VS Code calls the IDE doesn't support
  and its webviews' errors.
- extensions.reload { id } restarts it; extensions.showLog { id } opens the log for the user.

## Installing and updating
- A development extension shows under Development in the Extensions view, for this project.
  extensions.installPermanently { id } copies it into the installed ones (every project).
- extensions.installFromFolder { folder } installs a folder directly. Run again on the same
  folder after you change it, it replaces the installed copy: that is how a folder-installed
  extension is updated (raise "version" first). Nothing watches the folder for you.
- Changing an installed extension (yours or anyone's, VS Code ones too): its files are
  read-only. extensions.copyForDevelopment { id } makes a development copy that replaces it
  while loaded; change the copy, check it, then extensions.installPermanently { id, mode:
  "replace" }. Extensions from the store are updated by the store; a customized copy isn't.
- Installing and loading always ask the user. Tell them what you installed and where.`;
}

/** The guide's text: the overview, or one topic. */
export function agentGuide(topic: AgentGuideTopic | undefined, facts: AgentGuideFacts): string {
  return topic === "extensions" ? extensions(facts) : overview(facts);
}
