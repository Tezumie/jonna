# Customizing the agent

You can shape how the agent works in your projects: the rules it follows, what it remembers, the
skills and slash commands it has, hooks that run on its events, your own chat modes, the MCP
servers whose tools it uses, what it may do without asking, and which files it never sees. This
page covers each of those and the agent's settings.

Most of these files use the same formats as Claude Code, Cursor, GitHub Copilot and VS Code, so a
project set up for one of those tools works here as it is.

In this page, "the IDE's own folder" is the folder the IDE keeps in your project for its settings
(as VS Code keeps `.vscode`), and "your settings folder" is the folder that holds your user
`settings.json`.

## The Customize page

**Customize** is one tab for setting up the agent. The chips at the top pick a section, and the
search box finds the section you need ("openai", "subagents", "mcp"). Every way in, like
**Manage providers** or **Configure agents…**, opens it at its section; "Agent settings ›
Customize" at the top goes back to the agent's settings. [Open Customize](command:agent.customize)

| Section | What it holds |
|---|---|
| **Providers** | The AI models page: providers, keys, local models and external agents. Keys are checked before they are saved and stay on this computer, outside your settings; OpenRouter and Gemini have free options. External agents (Claude Code, Codex…) bring their own models and sign-in, and **View more** lists the ACP registry's. See [Set up a model](05-agent.md#set-up-a-model). |
| **Agents** | The main agent and your agents, the model each runs on (click one to edit it, the **New agent** card adds one), and the [AI features](05-agent.md#commit-messages-and-other-ai-features) outside the chat. The subagents are on the main agent's page. See [Agents and channels](06-agents-channels.md#create-and-edit-agents) and [Subagents](06-agents-channels.md#subagents). |
| **Rules** | Every rules file the agent reads. |
| **Skills** | Your skills and the project's. |
| **Commands** | Your slash commands and the project's: Markdown files you run with `/name`; `$ARGUMENTS` takes what you type after it. |
| **Plugins** | Claude Code plugins: commands, skills, subagents, hooks and MCP servers in one package. See [Plugins](05-agent.md#plugins). |
| **Auto** (Auto-approve) | What the agent may do without asking, by kind of action. A pattern set to **Allow** goes ahead; **Ask** always asks, even with full access; the most specific pattern wins. |
| **MCP** (MCP servers) | The built-in tools and your MCP servers. Servers start with a chat's first message. |
| **Docs** | Documentation sites for `@docs:<name>`: pages are read once and kept on this computer. |

## Rules

Rules are instructions the agent follows in every chat: your project's conventions, commands to
use, things to avoid. The agent reads every rules file in your project, not only the first one it
finds:

| File | Notes |
|---|---|
| `AGENTS.md` | At the root, and in subfolders. |
| `CLAUDE.md`, `CLAUDE.local.md` | Claude Code's. `CLAUDE.md` can pull in other files with `@path` (up to 5 levels). |
| `.github/copilot-instructions.md` | Copilot's. |
| `.github/instructions/*.instructions.md` | Copilot's, for the files `applyTo` matches. |
| `.cursorrules`, `.cursor/rules/*.mdc` | Cursor's (`alwaysApply`, `globs`, `description`). |
| `.claude/rules/*.md` | Claude Code's rules (`paths`). |
| `AGENTS.md` in your settings folder, `~/.claude/CLAUDE.md` | Your own rules for every project. |

When each reaches the agent:

- **Rules for the whole project** are in every chat.
- **A subfolder's `AGENTS.md`**, or **a rule meant for certain files** (Cursor's `globs`,
  Copilot's `applyTo`, Claude Code's `paths`), reaches the agent when it first opens or edits a
  file it covers.
- **A subfolder's own `.cursor/rules`** holds for the files under that subfolder only (its `globs`
  count from the subfolder). Rules can also be organized in subfolders of `.cursor/rules` and
  `.github/instructions`.

Other tools' files (everything but `AGENTS.md`) are read while `agent.thirdPartyConfigs` is on
(the default). To see which rules are active and why, choose **Rules…** in the chat's **⋯** menu.

### The Rules page

**Rules…** (the chat's **⋯** menu, Customize → Rules, or Settings → Agent) lists every rules file:
where it comes from, when it applies and which subagents get it.

- Click a rule to open its file in the editor, as a skill's `SKILL.md` opens.
- Its **⋯** has **Open**, **When it applies…** (the scope and which subagents get it, written in
  the file's own front matter), **Turn off** / **Turn on** (`agent.rules.disabled`) and **Delete**.
- Add one with **New** beside "In this project", from a template: a Cursor rule, a section of
  `AGENTS.md`, Copilot instructions or a Claude Code rule. With no folder open, **New** opens one
  first.

**Rules and subagents.** Subagents (other than plan and explore) get the always-on rules in their
instructions; a folder's `AGENTS.md` and rules for matching files come with the first file they
read or edit there, as they do for the agent. To give a rule to subagents only, put
`subagents: reviewer` in its front matter (`*` for all, `none` for none); an agent's own file can
list `rules: [testing]` to load more.

> **Tip:** `/init` has the agent write an `AGENTS.md` for the project, as a change you review.

## Memory

The agent can remember facts about your project and things that apply to every project.

- **Project memory** is a set of topic files in the `memory` folder inside the IDE's own folder:
  commands that work, conventions, pitfalls and their fixes. The agent reads an index of it in
  every chat.
- **User memory** holds what applies everywhere: your style, preferences and tools. It's kept in a
  `memory` folder next to your `settings.json`, and the agent saves a note there only after you say
  yes to it.
- The agent saves your corrections and stated preferences as you make them ("don't…", "always…",
  "I prefer…"), with a short reason, and replaces a note that's wrong or outdated instead of adding
  another.
- Each note says what kind it is: `[user]` (about you), `[feedback]` (how to work: a correction
  or an approach you confirmed), `[project]` (ongoing work, goals and deadlines the code doesn't
  show) or `[reference]` (where something lives, such as a dashboard or a ticket board). Feedback
  and project notes carry **Why:** and **How to apply:**, and `[[topic]]` links one topic to
  another. The agent doesn't save what the repository already records. Older notes without a
  kind still work.
- **Show agent memory** opens the notes. [Show agent memory](command:agent.openMemory)

**Tidy up agent memory** curates the notes: it merges duplicates, drops what's outdated and picks
up your corrections. The result is proposed as changes in a new chat, for you to review; nothing
changes until you accept. [Tidy up agent memory](command:agent.dream)

| Setting | Default | Description |
|---|---|---|
| `agent.memory.enabled` | `true` | Let the agent keep and read project notes. |
| `agent.memory.autoTidyUp` | `true` | Tidy up by itself in the background, at most once a day, after five sessions; you review the result. |
| `agent.memory.suggestTidyUp` | `true` | Suggest tidying up after several sessions. |
| `agent.memory.model` | `""` | The model that tidies up (empty: the chat's default model). It can also be an external agent. |

A channel has its own memory too; see [Channels](06-agents-channels.md#channels).

## Skills

A skill is a folder with a `SKILL.md`: a description of when it's useful, then instructions, plus
any files they refer to (references, scripts). The agent sees only each skill's name and
description, and loads the rest when your request matches, so a skill costs nothing until it's
needed.

```md
---
name: release-notes
description: Writes release notes from the commits since the last tag. Use when asked for release notes.
---
1. Find the last tag with `git describe --tags --abbrev=0`.
2. …
```

**Where skills are found:**

- Yours, for every project: the `skills` folder in the IDE's folder in your home folder, and
  Claude Code's and Cursor's (`~/.claude/skills`, `~/.cursor/skills`, `~/.agents/skills`).
- The project's: the `skills` folder in the IDE's own folder, `.claude/skills`, `.cursor/skills`
  and `.agents/skills`. A project's skill replaces one of yours with the same name.
- A skill in a subfolder's own `.claude/skills` is named with the folder in front
  (`apps/web:deploy`).

**Use skills:**

- The agent picks a skill when your request matches its description.
- Run one yourself with `/name` and what you want, like a slash command.
- **Customize → Skills** lists them under **User** and **Workspace**. **+ New** makes
  one from a template and opens it; a row opens its `SKILL.md`; its **⋯** turns it off
  (`agent.skills.disabled`), reveals it in the file manager or deletes it.
  [New agent skill…](command:agent.newSkill)
- The IDE comes with a skill for building extensions of the IDE itself. **Customize** on its row
  copies it to your skills folder to change it.

**Front matter:**

| Field | What it does |
|---|---|
| `name`, `description` | The skill's name and when it's useful. |
| `disable-model-invocation: true` | Only you can start it (a deploy, say). |
| `paths` | The skill isn't listed up front: the first time the agent reads or edits a file it covers, the IDE tells it the skill exists. Skills in a subfolder's `.claude/skills` work the same way. |
| `context: fork` | Runs in a subagent of its own; only its report comes back. |
| `model`, `effort` | The model and effort of the turn you start with `/name`. |
| `allowed-tools` | In your own skills only: commands and tools that run without asking while the skill is in use (`Bash(npm test)`, `Edit(src/**)`, `WebFetch(domain:docs.rs)`). A project's skills can't approve anything. |
| `disallowed-tools` | Tools or patterns the turn can't use (`Read(.env)` keeps it from reading `.env` files). |

Skills you add, change or remove in your home folder show at once.

## Slash commands

Type **/** in the message box: the commands that match what you type show above the box. **↑**
and **↓** choose one, **Tab** fills it in, **Enter** fills it in and runs one that needs nothing
after it, **Esc** closes the list. A command's other names find it too (`/new` is `/clear`).

| Command | What it does |
|---|---|
| `/clear` (`/new`, `/reset`) | Starts a new chat in place of this one (the old one stays in Sessions…). |
| `/compact` | Summarizes the chat so far (optionally: what to keep). |
| `/btw` *question* | A quick side question about the chat, answered from what it says so far, with no tools. The answer shows in a card you can close; it isn't part of the conversation, and a running turn goes on. |
| `/undo` | Puts back the files the agent's last turn changed. |
| `/rewind` | Goes back to before one of your messages (its files too). |
| `/fork` | A copy of this chat to try something else in. |
| `/resume` | Opens an earlier chat. |
| `/rename` *name* | Renames the chat. |
| `/export` | Saves the chat as Markdown. |
| `/copy` | Copies the agent's last answer. |
| `/context` | How full the chat's context is, as a note. |
| `/usage` (`/cost`) | Tokens and cost so far. |
| `/model` | Chooses this chat's model. |
| `/effort` *level* | How hard the model thinks (low to max, for models that take it). |
| `/plan` *task* | Plan mode, and the task if you give one. |
| `/output-style` | How the agent writes its answers. |
| `/todos` | The agent's plan for this chat. |
| `/tasks` | Background commands. |
| `/loop` *interval prompt* | Sends a prompt again and again. |
| `/review` | A second opinion on your uncommitted changes, in a new chat. |
| `/security-review` | The same, looking for security problems. |
| `/init` | The agent writes an `AGENTS.md` for the project, which you review. |
| `/memory`, `/agents`, `/skills`, `/rules`, `/mcp`, `/hooks`, `/permissions`, `/plugin` | Open that page. |
| `/add-dir` | Adds a folder to the workspace. |
| `/config` (`/settings`) | The agent's settings. |
| `/help`, `/release-notes`, `/bug` | Every command, what's new, report a problem. |
| `/`*skill* | Runs a skill. |
| `/mcp__`*server*`__`*prompt* | Runs an MCP server's prompt. |

External agents' own commands appear in the list while the chat uses one.

### Your own commands

A command is a Markdown file whose text is sent as your message. Put it in the `commands` folder in
the IDE's own folder, `.claude/commands` or `.cursor/commands` for the project, or in the
`commands` folder in your settings folder or `~/.claude/commands` for every project. **Customize →
Commands** lists them under **User** and **Workspace**, each with **+ New**; a row opens its
file. [New slash command…](command:agent.newSlashCommand)

```md
---
description: Run the tests for one package
argument-hint: <package>
allowed-tools: Bash(npm test:*), Read
---
Run the tests for $1 and fix what fails. The current status:
!`git status --short`
```

- `$ARGUMENTS` is everything typed after the name; `$1`, `$2`… are single words.
- `@path` includes a file's text.
- `` !`command` `` runs a command line and puts its output in place. The IDE asks you before
  running it, unless it's one of your own command files that allows it in `allowed-tools`. A
  project's command files always ask, so a cloned repository can't run commands when you type its
  command's name.
- Front matter can give a `description`, an `argument-hint` and the `model` to use for that
  message.
- **Subfolders** give a prefix: `.claude/commands/frontend/test.md` is `/frontend:test`.
- **`allowed-tools`** lists the tools the command needs (`Bash(git diff:*)`, `Read`, `Edit`…): for
  that command's answer the agent gets only those, plus the tools that only read; your next
  message has them all again. In your own command files it also lets those tools run without
  asking during that command (`allowed-tools: Bash(git status:*), Bash(git diff:*)` runs those git
  lines straight away). Questions that always ask (an Ask pattern in Auto-approve, deletion
  protection, the command denylist) still ask. A project's command files can't approve anything:
  they only narrow the tools.
- **`disallowed-tools`** (`WebSearch, Bash(git push:*)`) takes tools away for the command's turn,
  or refuses just those command lines.

## Hooks

Hooks are your own commands that run on the agent's events. They use Claude Code's format, so the
same configuration works in both. Set them in `agent.hooks` (user settings), or in a trusted
folder's `.claude/settings.json`. The IDE asks before running a folder's hooks, and again when they
change.

```json
"agent.hooks": {
  "PreToolUse": [
    { "matcher": "Bash", "hooks": [{ "type": "command", "command": "node tools/check-command.mjs", "timeout": 30 }] }
  ]
}
```

| Event | When it runs | What it can do |
|---|---|---|
| `PreToolUse` | Before a tool call. | Block it. |
| `PostToolUse` | After a tool call. | Tell the agent something. |
| `UserPromptSubmit` | When you send a message. | Stop it or add context. |
| `Stop` | When the agent finishes. | Send it back to work once. |
| `SessionStart` | A chat's first message; after `/clear`, reopening it from Chats, or a summary. Matcher: `startup`, `resume`, `clear`, `compact`. | Add context (what it prints). |
| `SessionEnd` | A chat is cleared, deleted or the window closes. | Clean up (nothing waits on it). |
| `PreCompact` | Before earlier messages are summarized. Matcher: `manual`, `auto`. | Save what it needs. |
| `Notification` | The agent waits for your approval or answer. | Tell you somewhere else. |
| `SubagentStart` | A subagent starts. Matcher: its name. | Add context to its task. |
| `SubagentStop` | A subagent finishes. Matcher: its name. | Send it back to work once. |

- The matcher takes the IDE's tool names (`run_command`, `edit_file`…) or Claude Code's (`Bash`,
  `Edit|Write`, `Read`, `Grep`, `Glob`); empty or `*` matches every tool.
- The hook gets the event as JSON on stdin and runs in the open folder with `CLAUDE_PROJECT_DIR`
  set. On Windows the command runs in PowerShell.
- Exit code 2 blocks, with what it printed as the reason. Exit code 0 may print Claude Code's JSON
  (`{"decision": "block", "reason": "…"}`, `hookSpecificOutput`).
- Hooks run for subagents' tool calls too. Stop cancels a running hook.

## Custom modes

Your own chat modes are listed with the agents in the composer's menu (VS Code now calls them
custom agents). **Create chat mode…** writes one as `.github/chatmodes/<name>.chatmode.md`
(Copilot's format, so the file works there too). [Create chat mode…](command:agent.createChatMode)

```md
---
description: Reviews code for security problems. Changes nothing.
tools: [read]
model: anthropic/claude-opus-5-5
---
Look for injection, unsafe deserialization and secrets in code. Report by severity.
```

- `tools` lists tool names or groups (`read`, `edit`, `run`, `mcp`; Copilot's and Claude Code's
  names work too). Leave it out to allow every tool.
- The text after the front matter is what the agent gets with each message in that mode.
- `.github/agents/*.agent.md` files are modes too, and modes can also go in `agent.customModes`.
  A folder's mode files are read in a trusted folder.

## Auto-approve

**Auto-approve** (the chat's **⋯** menu, or Customize → Auto) says what the agent may do
without asking, by kind: protect files from being read or changed (`**/.env*` → Ask), let commands
like `npm test` run, trust a site in the browser or on the web, or let one MCP server's tools run.
**Ask** always asks, even with full access. Each kind has **Add** for a new pattern, and a
pattern's **⋯** switches it between Allow and Ask or removes it.
[Auto-approve…](command:agent.showAutoApprove)

```json
"agent.autoApprove": {
  "reads": { "**/.env*": false },
  "edits": { "**/.vscode/*.json": false },
  "commands": { "npm test": true, "git push": false },
  "browser": { "localhost": true },
  "web": { "docs.rs": true },
  "mcp": { "github": true, "github/create_issue": false }
}
```

- `true` goes ahead; `false` always asks. The most specific pattern wins.
- A command's Ask pattern matches however the command is written: extra spaces or tabs, other
  letter case, the program's path or `.exe` (`C:\Git\cmd\git.exe push`), or `git -C folder push`.
- When a protected file asks, tick **Always allow** to allow that one file from now on (saved as
  `/path/to/file`; the other files the pattern covers still ask). On a browser or web page
  question, Always allow saves the site's domain. The chat notes each one.
- Files you protect from reading are also left out of the agent's file and text searches.

### Read-only paths

`agent.readOnlyPaths` lists paths the agent may read but never write, as gitignore-style patterns
relative to the folder (`~/` for your home). By default: git's folder, `.vscode/settings.json` and
`.idea`. A write there is refused without asking, and the agent is told not to try another way.
The IDE's own folder settings are always read-only to the agent. Commands it runs aren't checked
against these paths.

## Keep files from the agent

Add an `.aiignore` (or `.cursorignore`) file, in gitignore syntax, at the root of your folder:

```text
secrets/
*.sqlite
customer-data/**
```

- The agent's read, search, list and find tools skip those files, and you can't @-mention them.
  The agent can't change the ignore files themselves.
- `.env` files, keys (`*.pem`, `*.key`, `id_rsa*`) and credentials files are excluded by default
  (**Exclude secrets from the agent**, `agent.ignoreDefaults`). Add more patterns in **Files
  excluded from the agent** (`agent.ignoreFiles`).
- Matching ignores upper and lower case.
- Excluded files are also left out of the codebase index.

> **Note:** This doesn't stop a terminal command the agent runs from reading a file, so don't rely
> on it as a security boundary.

## Web pages and web search

The agent can read a web page whose address it knows (`agent.webFetch.enabled`). It asks first,
unless you turn on **Fetch without asking** (`agent.webFetch.autoApprove`) or gave it full access.

To let it find pages, run [Set up web search](command:agent.setupWebSearch) and choose a provider:

- **Brave Search API**, **Tavily** or **Exa**: each needs an API key from its site, typed into a
  hidden box and kept on this computer, never shown to the agent.
- **SearXNG**: your own server's address (turn on the `json` format in its `settings.yml`).

The agent then has a `web_search` tool, which asks like web pages do. It can keep results to some
sites or leave sites out, and search harder (`mode: extended`: more results, and the top pages read)
when a plain search falls short; an answer from search results ends with a **Sources:** list. With a
question, `web_fetch` hands the page to a model and gets back only the answer, so a long page
doesn't fill the chat (**Model for questions about pages**, `agent.webFetch.model`; empty: the
Explore agent's model if you chose one, else the chat's). You can also search
yourself: type `@web search` and your words in the message box, and the results go with your
message.

| Setting | Default | Description |
|---|---|---|
| `agent.webFetch.enabled` | `true` | Let the agent read web pages. |
| `agent.webFetch.autoApprove` | `false` | Read pages and search without asking. |
| `agent.webSearch.provider` | `off` | `off`, `brave`, `tavily`, `exa` or `searxng`. |
| `agent.webSearch.searxngUrl` | `""` | Your SearXNG address. |
| `agent.webSearch.maxResults` | `8` | Most results a search returns. |
| `agent.imageGeneration.enabled` | `true` | The agent's generate_image tool (the provider bills each image). |
| `agent.imageGeneration.model` | `""` | The model it uses, as `provider/model`. Empty: the chat's model when it draws, else one of your providers' image models, else OpenAI's gpt-image-1. |

## Documentation for @docs

Add a documentation site on the **Docs** page (the chat's **⋯** menu → **Docs for @docs…**, or
Customize → Docs); it's read once and kept on your computer. Type `@docs:<name>` in a message and
the passages that match your question go along. [Docs for @docs…](command:agent.showDocs)

- The site's sitemap is read too, so pages no link reaches are found.
- Pages that show nothing without JavaScript are counted on the Docs page. Turn on **Docs: render
  JavaScript pages** (`agent.docs.renderJavaScript`) to read them in a hidden window.
- **Add** beside "Sources" takes the site's start page; the pages under that folder are read.
  A site's **⋯** has **Read again** (or **Stop reading**) and **Remove**.
- Sites are read again after a week (`agent.docs.refreshDays`; 0 = only when you choose
  **Read again**).
- To match passages by meaning as well as by their words, turn on **Docs: search by meaning**
  (`agent.docs.embeddings.enabled`) and pick an embedding model (`agent.docs.embeddings.model`, for
  example `ollama/nomic-embed-text`), then read the site again. It's off by default because the
  passages go to that model's provider.

| Setting | Default | Description |
|---|---|---|
| `agent.docs.sources` | `[]` | The sites: `[{ "name": "next", "url": "https://nextjs.org/docs", "maxPages": 80 }]`. |
| `agent.docs.maxPages` | `60` | Most pages read from a site. |
| `agent.docs.delayMs` | `500` | Pause between pages (a site's `Crawl-delay` wins when longer). |

## The codebase index

Turn on **Codebase index** (`agent.codebaseIndex.enabled`) and pick an embedding model
(`agent.codebaseIndex.model`): for example `ollama/nomic-embed-text` after
`ollama pull nomic-embed-text`, or `openai/text-embedding-3-small`. The IDE embeds the folder's
source files, keeps the index in its data folder and updates it after you save. The agent then has
a `codebase_search` tool that finds code by meaning ("where are failed uploads retried?").

- With a hosted model, your code goes to that provider; with Ollama it stays on your computer.
- Files the agent ignores (`.aiignore`, `.cursorignore`) are left out.
- **Update codebase index** builds it again; **Search the codebase by meaning…** searches it
  yourself. Changing the model builds the index again.

## MCP servers

The agent can use the tools, prompts and resources of
[Model Context Protocol](https://modelcontextprotocol.io) servers. Servers start with the chat's
first message. [MCP servers](command:agent.showMcpPage)

### Where servers come from

The first source with a given name wins:

1. The setting `agent.mcpServers`, and your user `mcp.json` next to `settings.json`.
2. The folder's `mcp.json` in the IDE's own folder, `.vscode/mcp.json` and `.mcp.json`. They're
   read only in a trusted folder, and you approve each server once: a card in the chat shows its
   command before it starts.
3. With `agent.mcp.discovery` on: the servers Claude Desktop, Claude Code (`~/.claude.json`),
   Cursor (`~/.cursor/mcp.json`) and VS Code's user `mcp.json` have set up.
4. Extensions.

The format is VS Code's. Local servers (a `command`) and remote ones (a `url`, Streamable HTTP,
https only or http on localhost) both work:

```json
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
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${workspaceFolder}"],
      "envFile": ".env"
    }
  }
}
```

- `${input:id}` is asked once, in a hidden box when it's a password, and stored on your computer
  for that server (by its address or the program it runs). Neither the chat nor the agent sees it.
  Inputs with a fixed set of choices are picked from a list.
- `${env:NAME}`, `${workspaceFolder}`, `${userHome}` and `envFile` work as in VS Code.
- Ask the agent to install a server and it adds it to the folder's `mcp.json` after you approve.
  Any key is asked in the hidden box rather than pasted into the chat.

### The MCP servers page

Customize → **MCP servers** (the chat's **⋯** → **MCP servers…**) shows the built-in tools first
(the IDE's own: files, search, terminal, git, browser, editor; click to list them), then your
servers with their state and tool count.

- **Click a server** to configure it: turn it off (`agent.mcp.disabledServers`), or turn single
  tools off so the agent doesn't see them (`agent.mcp.disabledTools`).
- A server's **⋯** has **Sign in** / **Sign out** (remote servers), **Configure…**, **Restart**,
  **Sampling…**, **Edit mcp.json** and **Remove**.
- **New** beside "Connected" adds a **Custom server…** (written in `mcp.json`), one of the popular ones
  (filesystem, git, fetch, memory, Playwright, Chrome DevTools, Context7, DeepWiki, GitHub, Sentry,
  Linear, Notion, Hugging Face, Brave Search…), or one from **Search the MCP registry…**, which
  searches the official MCP registry as you type (offline, the built-in list). Install writes the
  server into this folder's `mcp.json` or yours.
- Servers from the registry aren't checked by the IDE, so the install question shows what one
  runs. Servers that would run Docker with full access to your computer (`--privileged`, the whole
  disk mounted, host networking) or `npx` with a command of its own aren't offered; others that
  mount folders, open ports or install from another package index say so.
- **MCP servers** (Command Palette) shows each server's status, restarts one or forgets its stored
  inputs. [Show MCP servers](command:agent.mcpServers)

### Sign-in, sampling and questions

- **Sign in:** a remote server that needs it opens your browser to sign in (OAuth); the IDE keeps
  the tokens in your OS keychain (Windows Credential Manager, the macOS Keychain, GNOME Keyring /
  KWallet) when there is one, and refreshes them. A server that asks for more access during a call
  has you sign in again, then the call goes through.
- **Sampling:** a server can ask to run a prompt on your model. You see the server, the model and
  the prompt, and choose **Allow once**, **Always allow** *server* (in this window), **Deny** or
  **Show the whole prompt…**. **Sampling…** on the MCP servers page answers ahead for good
  (`agent.mcp.sampling`: allow, deny or ask, per server). When you allow it, you see the answer
  before the server does: send it, change it or reject it. A server's preferred model is used only
  when it costs no more than yours; requests may hold up to 200,000 characters. Audio in a request
  is turned into text by your voice input's speech service first, and when the server stops, its
  request stops too.
- **Questions:** some servers ask for a detail while they work (a name, a choice, a confirmation).
  A box opens at the top of the window with the server's name and question: **Answer…** fills in
  its fields one by one, **Decline** says no, and Escape cancels. Servers aren't allowed to ask for
  passwords or keys; don't type them there.

### Prompts and resources

- **Prompts** appear in the "/" list as `/mcp__<server>__<prompt>`. Type the arguments after the
  name (or `name=value`); the IDE asks for a required one you left out.
- **Resources** appear when you type `@`: pick one and its content goes with your message. A
  resource you attached is followed: when it changes, your next message carries its new text.
- Both are listed once the servers have started, and update by themselves when a server changes
  its tools, prompts or resources (remote servers keep a connection open for that).
- **Deferred tools** (`agent.deferTools`): with many MCP tools (more than 30, or their definitions
  past about 6,000 tokens, in `auto`; `always`; `never`), the model sees only their names and loads
  the ones it needs with `tool_search`. A loaded tool stays for the rest of the chat. The agent's
  own rarely used tools (scheduling, workflows, messages to other chats, worktrees, images,
  suggestions) are only named the same way, which keeps a few thousand tokens free in every
  request; `never` sends everything.

### The IDE as an MCP server

The other direction: the IDE can run an MCP server itself, so another agent (Claude Code, say) can
use the IDE's commands and read its state.

1. Turn on **MCP: Enabled** (`mcp.enabled`), or run **Start MCP server**. While it runs, the status
   bar shows **MCP**; click it for the connection info. [Start MCP server](command:mcp.start)
2. The dialog shows the address (`http://127.0.0.1:<port>/mcp`), a token and a ready-made command.
   **Copy Claude Code command** puts it on the clipboard. In a terminal, in the project folder:

   ```bash
   claude mcp add --transport http ide http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
   ```

3. The port and token change whenever the server restarts, so add it again after a restart. The
   current address and token are also written to `mcp.json` in the app's data folder while the
   server runs.

It listens on `127.0.0.1` only, and requests need the token. Commands that only read run directly;
anything that writes files, runs programs or touches the network asks you (Allow once, Allow for
this session, Deny), and destructive commands ask every time. For Claude Code's `/ide` link, see
[Claude Code's /ide](06-agents-channels.md#claude-codes-ide).

## The agent's settings

Settings → **Agent** groups the agent's settings in sections. [Open settings](command:settings.open)

| Section | What's in it |
|---|---|
| Models and context | The default, plan, build and backup models, effort, thinking, context lengths, prompt cache, Ollama, providers, custom modes, the codebase index. |
| Conversation | Text size, Ctrl+Enter to send, what a message sent while it works does, wrapping code blocks, streaming, chat names, cards, notifications, the details panel, the projects folder. |
| Context and tools | The repository map, prices and budget, usage history, excluded files, subagents, group chats and channels, web fetch and search, other tools' configs, rules and skills turned off, @docs, the main agent's name and face. |
| Memory | Project memory and its tidy-up. |
| Execution and approvals | Commands, auto-approve, read-only paths, hooks, IDE control and the protections. |
| Applying changes | Checks after edits, the test command, formatting, reloading previews, opening dev servers. |
| Integrations | MCP servers, external agents, worktrees. |
| Voice | Voice input. |

Settings not covered on the other pages:

| Setting | Default | Description |
|---|---|---|
| `agent.textSize` | `default` | The chat's text size (`small`, `default`, `large`). |
| `agent.codeBlockWordWrap` | `false` | Wrap long lines in the chat's code blocks. |
| `agent.streamText` | `true` | Show answers as they arrive. |
| `agent.cacheTtl` | `5m` | How long Anthropic keeps the cached prompt (`5m`, `1h`). |
| `agent.thirdPartyConfigs` | `true` | Read other AI tools' rules and commands (`CLAUDE.md`, `.cursor/rules`…). |
| `agent.ideControl` | `true` | Ask before the agent changes the IDE itself, even with full access. |
| `agent.mcp.discovery` | `false` | Also use other tools' MCP servers on this computer. |
| `agent.mcp.registryUrl` | `https://registry.modelcontextprotocol.io` | The MCP registry New MCP server searches (empty: the built-in list only). |
| `agent.codebaseIndex.enabled` | `false` | Index the folder for search by meaning. |
| `agent.codebaseIndex.model` | `""` | The embedding model for the index. |
| `agent.customModes` | `[]` | Your own chat modes. |
| `agent.hooks` | `{}` | Commands that run on the agent's events. |
| `agent.readOnlyPaths` | git's folder, `.vscode/settings.json`, `.idea` | Paths the agent may read but never write. |
| `agent.ignoreDefaults` | `true` | Keep secrets away from the agent. |
| `agent.ignoreFiles` | `[]` | More patterns the agent's tools skip. |
| `mcp.enabled` | `false` | Run the IDE's own MCP server. |

> **Note:** **Reset all** on the Settings page keeps the agent's settings (its models, agents and
> their choices) unless you check "Also reset the agent's settings".

## Common questions

### My project has a CLAUDE.md and .cursor/rules. Which one does the agent use?

All of them. The agent reads every rules file; turn one off on the Rules page if you don't want it.

### Why doesn't the agent load my project's rules or MCP servers?

The folder isn't trusted, or it's a risky folder (Downloads, your home folder, the Desktop, the
temp folder, a drive root). The folder's own rules, skills, subagents and MCP servers aren't loaded
there.

### Where do I put a rule that holds in every project?

In `AGENTS.md` in your settings folder, next to your user `settings.json` (or
`~/.claude/CLAUDE.md`).

### Can a cloned repository run commands through its slash commands or hooks?

Not without asking: a project's command files always ask before running a command line, and a
folder's hooks run only after you approve them (and again when they change).

## Next steps

- [The agent](05-agent.md): models, modes, access and reviewing edits.
- [Agents and channels](06-agents-channels.md): the team, channels and external agents.
- [Settings, themes and profiles](16-settings-themes.md): the Settings page and settings files.
- [Workspaces and trust](20-workspaces.md): trusted and restricted folders.
