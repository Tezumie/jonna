# The agent

The agent is the IDE's built-in AI assistant. It reads your project, edits files (you review the
changes), runs commands (it asks first) and uses the IDE's own commands, the same ones you run
from the Command Palette. This page covers setting up a model, talking to the agent, its modes and
access levels, adding context, reviewing its edits, sessions, usage and the tools it has.

Two more pages go further: [Agents and channels](06-agents-channels.md) covers the team of agents,
channels, threads, helpers, worktrees and external agents such as Claude Code and Codex, and
[Customizing the agent](07-agent-customize.md) covers rules, memory, skills, slash commands,
hooks, MCP servers and the agent's settings.

## Open the agent

- Press **Ctrl+L** (**Focus agent**) to jump to the agent's message box.
- The **Channels** view in the activity bar lists every conversation: the Inbox, channels, tasks,
  direct messages and recent chats. See
  [The Channels view](06-agents-channels.md#the-channels-view).
- Each conversation opens as a tab in the dock, so you can move it, split it or put it beside your
  editor like any other tab. [New agent session](command:agent.newSession) starts a fresh chat.

An empty chat greets you and shows the message box. If no model can answer yet, the greeting comes
with what's missing and buttons to set one up.

## Set up a model

The agent needs a model: a local one, a hosted provider with your key, or an agent you already
have (Claude Code, Codex, Gemini CLI, GitHub Copilot, OpenCode V2). Everything is set up on the
**AI models** page, which is **Customize → Providers**.
[Open Customize](command:agent.customize)

### Start free with OpenCode

With no model set up, an empty chat offers **Start free with OpenCode**. It installs OpenCode V2
from the ACP registry (a download from opencode.ai, after you confirm; no Node.js needed) and uses
its free models, with no account or key. [Start free with OpenCode](command:agent.startFree)

- OpenCode V2 is also on the AI models page with the agents you may already have: **Install**
  there does the same.
- It's always the download, never an `opencode` already on your PATH, which can be OpenCode 1
  (`opencode-ai`): the two share a database that OpenCode 1 can't read once OpenCode 2 has used it.

### Sign in or out of an agent you have

An installed agent's row (Claude Code, Codex, Gemini CLI, GitHub Copilot) has **⋯** beside
**Use**: **Sign in** runs the agent's own sign-in in a terminal (`claude /login`), and **Sign out**
its sign-out (`claude /logout`). Gemini CLI has no sign-out: its sign-in changes the account.

Claude Code and Codex start through `npx`, which downloads their adapter again when a new version
comes out. That can take a few minutes: the chat says it's still starting after 15 seconds, and
it waits up to 10 minutes before giving up.

> **Note:** OpenCode offers its free models for a limited time, and some of the companies behind
> them keep what you send or use it to improve their model (see OpenCode's terms at
> opencode.ai/docs/zen). Don't send secrets or personal data through them. Your own key or a local
> model doesn't have that catch.

### Local models with Ollama

Install [Ollama](https://ollama.com) and pull a model (`ollama pull qwen3:8b`). The IDE finds it
at `http://127.0.0.1:11434` and lists every installed model, local ones first and Ollama's cloud
models in a submenu, with their size, context and whether they use tools. Local models cost
nothing and your code stays on your computer.

| Setting | Default | Description |
|---|---|---|
| `agent.ollama.enabled` | `true` | Look for Ollama on this machine and list its models. |
| `agent.ollama.url` | `http://127.0.0.1:11434` | Where Ollama listens. |
| `agent.ollama.keepAlive` | `30m` | How long Ollama keeps the model loaded after a request (`-1`: always). A loaded model starts the next message faster. |
| `agent.contextLength` | `16384` | Context window requested from local models (Ollama's `num_ctx`). Bigger uses more memory. |
| `agent.smallModelProfile` | `auto` | A shorter system prompt and fewer tools so a small local model isn't swamped. |

### Hosted providers

1. Open **Add a provider** in the model picker, or run
   [Add model provider…](command:agent.addProvider).
2. Pick a service. The first rows are Anthropic, OpenAI, Google Gemini, xAI, OpenRouter, Groq,
   LM Studio and llama.cpp server. **View more** lists the rest: Mistral AI, DeepSeek, Together AI,
   Fireworks AI, Cerebras, Hugging Face, NVIDIA NIM, Kimi (Moonshot AI), Qwen (Alibaba Cloud),
   Z.ai (GLM), Azure OpenAI, Amazon Bedrock, vLLM and more.
3. Paste your API key. **Connect** checks the key by listing the provider's models before anything
   is saved.

Some notes on providers:

- **OpenRouter's `openrouter/free`** is a router over OpenRouter's free models. It works with any
  OpenRouter key and needs no credits.
- **Any OpenAI-compatible server:** choose **Other server**. Start typing a name and pick a
  suggestion to fill in its address and logo. A server of your own can show an image you choose
  (PNG, SVG, JPEG or WebP, up to 256 KB), kept on this computer.
- **Keys are stored apart from your settings**, in your operating system's keychain (Windows
  Credential Manager, the macOS Keychain, the Secret Service on Linux) when there is one. The
  agent never sees them. **Set model provider API key…** changes one.
- OpenAI-compatible providers you add by hand go in `agent.providers`:

```json
"agent.providers": [
  { "id": "lmstudio", "name": "LM Studio", "kind": "openai", "baseUrl": "http://127.0.0.1:1234/v1" }
]
```

### An agent you already have

Claude Code, Codex, Gemini CLI, GitHub Copilot and OpenCode can answer in the IDE's chat. They
run with their own sign-in and their own tools, and the IDE shows their work, asks you before they
write and puts their changes under review. Pick one in the model picker. Many more agents can be
installed from the ACP agent registry. See [External agents](06-agents-channels.md#external-agents).

### Pick a model

Under the message box, the model button shows the provider's or agent's logo and the model, then
its reasoning effort (dimmer), then what the agent may do on its own: **Review**, **Accept edits**
or **Auto**.

The model button opens the model picker:

- The left rail has a tab for **Favorites and recent** (the star), one per provider you added and
  one per external agent you have. Hover a logo for its name.
- Type to search every provider at once. ↑/↓ and Enter pick; Ctrl+PageUp / Ctrl+PageDown switch
  tabs.
- Hover a model and press its star to keep it in Favorites. The models you picked lately show
  under Recent.
- The gear opens the providers page, and **Refresh** lists the models again.

The model you pick is the chat's. New chats start with `agent.model`; empty, the first local model.

### Reasoning effort and thinking

The effort button beside the model sets how hard a reasoning model thinks: **Think when the model
can**, **Always think** or **Don't think**, and **Effort** (default, low, medium, high, xhigh,
max), where lower is faster and uses fewer tokens. An external agent shows its own reasoning
levels there instead.

### When a model hits a usage limit

Set `agent.fallbackModel` (or `fallbackModel:` in one of your agents' files) and a turn that hits a
usage limit (a free tier's daily cap, a quota, credits that run out) goes on with that model after
one retry, and says so. Without it, the turn stops at the limit.

## Talk to the agent

Type in the message box and press **Enter** to send; **Shift+Enter** adds a new line. Turn on
`agent.submitWithCtrlEnter` to send with **Ctrl+Enter** instead.

- **While it works, keep typing.** Enter sends your message into its work, and it reads it at its
  next step ("stop", "use tabs instead"). **Send now** has it read at once: the reply it's writing
  or the command it's running is cut short (with Claude Code or another external agent, its turn is
  stopped and your message goes next). **Take back** returns a waiting message to the box. Set
  `agent.whileWorking` to `interrupt` to stop the turn instead.
- **Stop:** with an empty box, the send button becomes Stop, and **Esc** stops the agent too.
- **What it's doing:** under your message, one line says what the agent is doing, then what it did
  ("Read 3 files, ran a command"). Click it for the steps; click a step for its output and the
  thinking behind it.
- **A plan:** for longer work the agent keeps a to-do list, shown as a card under its latest
  message: a dashed circle waits, a turning one is the step it's on, a check is done. If you send
  a message before it finishes, the card says it's the plan from before your last message.
- **Next step:** when the agent finishes work that leaves you a decision (commit it, try the other
  approach), a small box under its answer sums up where things stand, asks the one question and
  offers a button or two: a reply (sent as your message) or an action (review or keep the changes,
  commit, create a pull request, a new chat). Only the latest turn's box has buttons. Its first
  sentence is the chat's status in the Inbox and the Chats list's tooltip; a box that waits on you
  marks the chat as needing you.
- **Chapters:** in a long chat the agent marks where the work changes phase with a divider. Once
  there's one, the **Chapters** button (a bookmark) in the chat's header lists them; pick one to
  scroll there (`agent.showChapter`).
- **Proposed tasks:** when the agent finds separate work worth doing (a bug elsewhere, missing
  tests), it may offer it as a **New task** card: **Start in a new chat** opens a chat with the
  task's brief as its first message; **Dismiss** removes it.
- **Plan first?** Before a large change the agent may ask to switch to Plan mode. **Switch to Plan**
  makes the rest of the turn read-only and it ends with a plan and **Build**; **Keep going** lets it
  carry on.
- **The plan as a document:** a Plan mode turn's plan is saved as a Markdown file (in a `plans`
  folder next to your settings) and shown as a card: click its title to read it, **Open to edit**
  opens the file in an editor tab, **Build** has the agent carry out the plan as the file is now
  (your edits included), and **Keep planning** keeps the chat in Plan mode: say what to change, and
  your edits to the file go with your message.
- **A task moved to its own chat:** when you ask about something else while the agent is in the
  middle of a task, it may move that task to a new chat, which carries on with this conversation
  and the steps left, while it answers you here. A **Moved to a new chat** card links to it.
- **Loops:** `/loop check the build` has the agent check again and again, choosing when to look
  next (between a minute and an hour); `/loop 5m check the build` checks every five minutes. A strip
  above the message box shows the loop, its next check and **Stop**; checks where nothing changed
  fold into one line ("3 quiet checks"). The agent ends the loop when it's done, and every loop
  ends after 7 days.
- **Diagrams, charts and math:** answers can hold Mermaid diagrams and charts (flowcharts, sequence
  diagrams, bar and line charts, pie charts) and math (`$x^2$`), drawn in the chat. The code button
  on a diagram shows its source; copying an answer gives plain Markdown.
- **Questions with choices:** when the agent needs you to decide, it asks with choices. Click one,
  or type your own answer in the box. It waits for you meanwhile. Files and pages it points you to
  show as cards (`agent.richBlocks` turns these cards off).
- **Code blocks:** a code block that names a file has **Apply** (a reviewable change to that file)
  and **Insert at the cursor**.
- **Message actions:** answers have Copy, Retry (the newest) and the name of the model that wrote
  them; your messages have Copy, Edit and Restore.
- **Output style:** `/output-style` (or **Agent: choose output style…**) changes how the agent talks
  while it works. **Default** keeps it brief; **Explanatory** adds short "★ Insight" notes about
  the choices in the code; **Learning** has you write small, meaningful parts yourself: it leaves a
  `TODO(human)` comment where they go, says what to write and waits for you. Your own styles are
  Markdown files in an `output-styles` folder next to your settings, or in a trusted project's
  `output-styles` folder in the IDE's workspace folder (Claude Code's `.claude/output-styles`
  work too), with `name`, `description` and `keep-coding-instructions` at the top: without
  `keep-coding-instructions: true` the style replaces the agent's coding guidance as well as its
  tone. The chat's details show a style other than Default. A change applies from the next
  message (the chat's prompt is rebuilt once, so that message isn't cached).
- **Your own status line:** set `agent.statusLine` to `{ "type": "command", "command": "node
  ~/statusline.mjs" }` and the first line your command prints shows in the status bar, beside the
  agent's model, colors included, as Claude Code's status line. The command gets the active chat
  as JSON on stdin (`session_id`, `model.display_name`, `workspace.current_dir`, `cost` with the
  chat's cost, time and lines changed, `output_style.name`…) and runs again when the conversation
  changes (at most every 300 ms), in the open folder, in trusted folders only.

If a model gets stuck repeating the same thing (small and free models sometimes do), the IDE stops
it after a few repetitions and says so: try again or pick another model. Provider errors that
happen before anything arrives are retried by themselves (three attempts); a final error shows a
short message with Retry or Continue.

If the same chat is open in two windows and one saves it, the other stops saving it and asks: keep
this window's version, or reload the other one.

### Ask the agent about the IDE

The agent can read this guide and run the IDE's commands, so you can ask it how to do something or
ask it to do it ("split the editor and open the terminal below"). How-to questions go to its
**guide** helper, which searches this guide and answers with the page it used. Ask for a feature of the IDE
itself ("a status bar item that counts words") and it builds an extension, following a built-in
skill: it creates the extension, checks it, runs each of its commands and reads its log before it
says it works. Customize that skill on the Skills page (it copies it to your skills folder). A
message that starts with an extension's chat participant (`@name`) goes to that participant
instead. See [Extensions](18-extensions.md).

## Who answers: the main agent, Plato or Gabby

The first pill under the message box picks **who answers**. Its menu lists the agents with their
faces: the main agent, your agents and your custom modes. Each starts in a mode, set in the agent
editor's **Mode**, as in Cursor and VS Code:

| Agent | Mode |
|---|---|
| **The main agent** | Agent: reads, edits files and runs commands, as far as the chat's access allows. |
| **Plato** | Plan: looks around without changing anything and writes a plan. When it's done, **Build** carries it out. |
| **Gabby** | Ask: only answers. It reads the project but changes nothing. |

- **Shift+Tab** steps through them: the main agent, Plato, Gabby (Claude Code's Agent → Plan →
  Ask, as agents). Without a planner or a chat partner of your own, the main agent plans or
  answers itself.
- **Mode ›** in the same menu switches whichever agent is answering to **Agent**, **Plan** or
  **Ask** for this chat (its current mode is shown beside it). The pill then says so, for example
  "Jonna · Ask".
- **Build** hands the plan to the main agent (or to a builder of yours if you made one) and it
  carries the plan out in the same chat; the "Plan ready" note says who.
- **Another model for planning:** give Plato that model on its card. Plan with one model and build
  with another (Claude Code's "opusplan") by giving Plato the planning model and the main agent the
  building one: Build hands the plan to the main agent.
- Your own modes (custom chat modes) are listed with the agents. See
  [Custom modes](07-agent-customize.md#custom-modes).

## Access and approvals

The last button under the message box says what the agent may do without asking. It has two
parts:

**Edits**

- **Review edits** (the default): edits are saved to your files at once, so the agent's commands
  and tests see them, and you review them afterwards (see
  [Review the agent's changes](#review-the-agents-changes)).
- **Accept edits (checkpointed)**: edits are kept without review. A checkpoint is still kept, so
  you can roll back.

**Commands** (`agent.runCommands`)

- **Ask before commands** (`ask`): each command shows a card with the command line and **Allow** /
  **Deny**. Tick **Always allow** to add it to `agent.allowedCommands`.
- **Run commands automatically** (`auto`): commands run without asking, except risky ones
  (deleting, killing processes, downloading, `sudo`, `git push`, `git reset --hard`,
  `npm publish`…) and your `agent.deniedCommands`. Only in a trusted folder: in one that isn't,
  commands ask as in `ask` (the card says why).
- **Auto: full access, never ask** (`full`): nothing asks (except the cases below) and edits apply
  in every chat, a new folder's too. The button says **Auto**; if you pick Review edits under
  Auto, it says "Auto, review edits".

Some things ask even with full access:

- **Changing the IDE:** when the agent wants to rearrange panels, change a setting or load an
  extension, you see "Let the agent change the IDE". **Always allow this chat** covers the rest of
  that chat (`agent.ideControl`).
- **Your Downloads folder:** before the agent reads, writes, lists or runs a command in Downloads,
  it asks, and search results leave Downloads out until you allow it for the chat. In a risky
  folder (Downloads, your home folder, the Desktop, the temp folder, a drive root) the folder's own
  rules, skills, subagents and MCP servers aren't loaded, and an external agent asks before it
  starts.
- **Other agents' settings and startup files:** changing `.codex/`, `.claude/settings.json`, MCP
  server lists, `.bashrc`, a PowerShell profile or git hooks always asks, with the reason.
- **Protections you turn on:** **Deletion protection** (`agent.deleteProtection`), **MCP tools
  protection** (`agent.mcpProtection`) and **Browser protection** (`agent.browserProtection`) make
  those actions ask every time.
- **Ask patterns** on the Auto-approve page. See
  [Auto-approve](07-agent-customize.md#auto-approve).
- **A command outside the sandbox:** see below.

### The command sandbox

With **Command sandbox** (`agent.sandbox`) on `auto` (it's off until you turn it on), the agent's
commands run in
your system's sandbox, after the usual question (if any):

- **Windows:** the command runs at low integrity, so it can write only in the folder (and its git
  folder) and a temp folder of its own; your other files, settings and registry are out of its
  reach, and so are the secrets in `agent.sandbox.denyRead` (below). The first command in a folder
  marks the folder writable for low-integrity programs (`icacls <folder>` shows it), which can take
  a few seconds in a big folder. **The network:** Windows lets only an administrator block a
  program's connections, so the sandbox can't. Tools that use the proxy settings (npm, pip, git,
  curl, cargo, Go, Python, .NET) are sent through a filter that lets them reach localhost and the
  allowed hosts only; a program that opens its own connections isn't stopped.
- **macOS:** `sandbox-exec`: writes only in the folder and temp folders, the secrets hidden, no
  network except localhost and the allowed hosts.
- **Linux:** bubblewrap, when it's installed (`bwrap`): the same as macOS (with allowed hosts the
  network is shared and only tools that use the proxy settings are held to them). Without it
  there's no sandbox, and the card says so.

**Git's settings and the agents' configuration.** Git runs programs its settings name (on
every `git status`, commit or fetch), and the IDE's own git runs outside the sandbox, so a
sandboxed command may not change them. On macOS and Linux, as with Claude Code's sandbox, it
can't write `.git/config`, `.git/hooks` (also a submodule's or a worktree's), rename `.git`, or
write `.claude`, `.codex`, `.cursor`, `.mcp.json` or the IDE's own project folder. Commits,
branches and fetches still work; `git config` or a hook installer runs outside the sandbox
when you allow it. Windows can't hold those files in a folder the command may write, so there
the IDE checks instead: if a repository's git settings change after a sandboxed command ran in
it, the IDE's git pauses for that repository, and Source control says which file changed. Look
at it, then choose **Trust git settings** (only you can, not the agent). If you changed them
yourself, trust them the same way.

**Secrets.** `agent.sandbox.denyRead` lists what sandboxed commands can't read: by default
`~/.ssh`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`, `~/.docker/config.json`,
`~/.kube`, `~/.gnupg`, `~/.netrc`, `~/.git-credentials`, the IDE's own keys file, the keychains'
and browsers' files (macOS, Linux) and `.env` files outside the folder (macOS: all of them;
Windows and Linux: those in your home folder and the folder's parents). Your own programs read
them as before. On Windows each gets a label once (it stays, like the folder's); **Let sandboxed
commands read my secrets again** in the palette takes the labels off (empty the list or turn the
sandbox off first, or the next command hides them again).

**Allowances.** When a sandboxed command failed because it needed a host or a folder outside the
project, the agent can show a card with **Allow**: it's kept for this project
(`agent.sandbox.projects`, in your settings, not the folder's, so a repository can't widen its own
sandbox). `agent.sandbox.allowHosts` and `agent.sandbox.allowWrite` hold what you allow in every
project. The permission card lists what's hidden and allowed.

The step's summary says "sandboxed". When a command fails because it needed to reach outside (an
`npm install -g`, a cache in your profile, the network on macOS or Linux), the agent may ask to run
it **outside the sandbox**: that card always shows, even with full access, and says so. Set
`agent.sandbox` to `off` to run every command with your full rights, as before. Folders on a
remote or in WSL aren't sandboxed.

Paths in `agent.readOnlyPaths` (by default git's folder, `.vscode/settings.json` and `.idea`) are
refused without a question. See [Read-only paths](07-agent-customize.md#read-only-paths).

### Close what the agent opened

**Close what the agent opened** (**Ctrl+Shift+Alt+W**, or the chat's **⋯** menu) closes every tab
and window the agent opened in that chat. "Move all tabs back into the main window" brings back
any separate windows. Turn on `agent.closeOpenedOnStop` to do that whenever you press Stop.

## Add context

Type **@** in the message box, or click **+**, to add context to your message. What matches what you
type after the **@** (files, the mentions below, symbols, your agents) shows above the box: **↑** and
**↓** choose, **Enter** or **Tab** adds it, **Esc** closes the list, and **Browse files and context…**
opens the full list.

| Mention | What goes with your message |
|---|---|
| A file or folder | Its content (pick it from the list as you type). |
| **Problems** | The current errors and warnings. |
| **Terminal output** | What the terminal printed. |
| **Editor selection** | The selected text. |
| **Web page…** | A page's text (type its address). |
| `@web search` *words* | Web search results, when web search is set up. |
| `@git` | Your uncommitted changes and new files. |
| `@commit` | One commit's changes. |
| `@branch` | What your branch changed compared with main (or master). |
| `@chat` | Another chat's transcript, to carry on from it. |
| `@rules` | The project's rules. |
| A symbol | A function, class or type's definition: type part of its name after @. |
| `@docs:`*name* | Passages from a documentation site you added. See [@docs](07-agent-customize.md#documentation-for-docs). |
| An MCP resource | A resource an MCP server offers. See [MCP servers](07-agent-customize.md#mcp-servers). |

Mentioning one of your agents (`@Plato`) brings it into the chat instead; see
[Group chats](06-agents-channels.md#direct-messages-and-group-chats).

### Attach files and images

- **+ → Upload from computer…** attaches files from anywhere; you can also drag files onto the chat
  (from the explorer or your system) and paste images. Up to 20 attachments per message.
- Long pastes become a card. A `.zip` becomes one card with its path, file list and text files.
- Click a card to look at it: the viewer opens beside the chat, so you can keep typing. The
  download button next to a card's × **adds it to the project** (you pick the file name);
  **Download…** saves it elsewhere.
- In the explorer, right-click a file or folder and choose **Add file to chat** (or **Add folder
  to chat**).
- From the Problems view, **Fix with agent** and **Fix all in this file with agent** send a
  problem to the agent. In the terminal, point at a failed command's line for its **Fix** button
  (**Terminal: Fix with agent**): the command, its exit code and the end of its output go to the
  agent.

The agent can also open images in the project (a screenshot, a mockup) and, with a model that sees
images, look at them. It reads a PDF as text, page by page.

### Images the agent makes

Ask for a picture ("make a hero image for the landing page", "draw an icon for the app") and the
agent makes one with an image model. While it works, a "Creating image" placeholder shows in the
chat; then the picture, large. Point at it for its id (**img1**, **img2**…), **Add to project**
and Download; click it to see it full size. Ask the agent
to put it in the project ("save img2 as assets/hero.webp") and it writes the file, converting it
when the extension asks for another format.

Which model draws:
- **The chat's own model**, when it makes images (on OpenRouter, models such as
  `google/gemini-2.5-flash-image`): its reply carries the picture.
- **Otherwise the agent's `generate_image` tool** uses `agent.imageGeneration.model`, or a model
  of your providers that makes images, or OpenAI's `gpt-image-1` when OpenAI is set up. With
  none, the agent tells you how to set one up (and can draw an SVG meanwhile).

Images from MCP tools and from external agents show the same way. The chat keeps each image whole
on this computer (deleting the chat deletes them). The provider bills each image it makes; turn
`agent.imageGeneration.enabled` off to remove the tool.

### The repository map

Each chat starts with a **map of the project**: the files that matter most and the functions,
classes and types they define, ranked by how much other code uses them. It helps the agent (and
small local models especially) find its way faster. `agent.repoMap.enabled` and
`agent.repoMap.maxChars` (4000 characters) control it.

## Review the agent's changes

The agent's edits are saved to your files right away, so its commands and tests see them, and you
review them afterwards. In a changed file, each edit is tinted with a bar in the margin.

| Command | Keys | What it does |
|---|---|---|
| Keep this agent change | Ctrl+Alt+Y | Keeps the change at the cursor. |
| Undo this agent change | Ctrl+Alt+N | Undoes the change at the cursor. |
| Go to the next agent change | Alt+F5 | Moves to the next change. |
| Go to the previous agent change | Shift+Alt+F5 | Moves to the previous change. |
| Keep the agent's changes in this file | | Also a button in the editor's title bar. |
| Undo the agent's changes in this file | | Also a button in the editor's title bar. |

- Each turn's changes show as one card in the chat ("Changed 10 files +412 −8"). Open it for a row
  per file; **Keep all** or **Undo all** handles everything.
- Undoing restores what the file held before the agent's turn, even if you've typed elsewhere in
  it since. If you changed the same lines, it stops and tells you.
- Changes waiting for review come back after you close and reopen the folder.
- With **Accept edits** or **Auto** there is no review.

### Checks after the agent edits

After the agent edits, it checks its work and fixes what fails:

- Each edit is checked by the language services (TypeScript and JavaScript, JSON, CSS), and the
  agent is told about errors it introduced (`agent.checkEdits`).
- Before it's done, it runs the project's check: your `agent.verifyCommand`, else the project's
  test script, else a typecheck, check or lint script, `cargo check` or `go build`
  (`agent.verify`, `agent.verifyTimeoutSeconds`).
- `agent.formatOnFinish` runs the project's formatter (Prettier, Biome, Ruff, Black, rustfmt,
  gofmt, clang-format) on the files it changed.
- Browser tabs showing a local server's page reload after the agent writes files
  (`agent.reloadBrowser`).
- **Follow the agent** (`agent.followEdits`, off): each file the agent edits opens in a preview
  tab at the change while you watch the chat. Focus stays in the chat, and nothing moves while
  you're typing in an editor.

### A second opinion

**Review changes** in the chat's **⋯** menu gives a diff to the model you pick, in a new chat in
Ask mode: **Uncommitted changes…**, **Staged changes…**, **This branch…** or **This chat's pending
edits…**. It reports problems, most severe first, and changes nothing: the findings come as a
card, where a row opens the file at the line and **Fix** (or **Fix all**) asks the agent to fix
them, switching the chat to Agent mode; its next report says what was fixed. `/review` does the
same for your uncommitted changes with the chat's model. To have the reviewer look at every turn that
changes files, see [Handing work to agents](06-agents-channels.md#handing-work-to-agents).

## Go back to an earlier point

Every message you send has a **Restore** button (the circular arrow next to Copy and Edit). It
takes the chat back to just before that message and undoes the changes the agent made to your
files since then; your message goes back into the box so you can change it and send it again.

- When you edit or retry a message after the agent changed files, the IDE asks: **Undo and send**,
  **Keep changes** or **Cancel**.
- **Restore checkpoint** in the chat's **⋯** menu lists the turns ("Before turn 3: …") and puts
  the files back as they were before the one you pick.

## The chat's details

A panel on the right of the chat shows small cards:

- **Environment:** this computer, the folder, the branch (click it to switch branch), the model,
  the agent or mode, and the output style when it isn't Default. With nothing open the folder
  row says "No folder": click it to open one. Right-click a folder for more: reveal it, copy its
  path, open it in a terminal, change folder, or **Add folder…** to put another folder beside it.
  Added folders are listed under the first; the agent reads and edits files in all of them
  (name the folder in front of a path, as in `api/src/x.ts`). Remove one from its menu.
- **Context:** how full the context window is, split into messages, attachments, system prompt,
  rules and memory, skills, built-in tools (click for each tool's share) and MCP tools (each
  server's). Deferred tools, which the agent loads by name when it needs them, are listed apart:
  they aren't in the window yet. Below: how much more the chat can take before the agent
  summarizes it by itself, and **Compact session** to do it now (an external agent such as Claude
  Code gets its own `/compact`).
- **Changes:** lines added and removed, the files, **Review**, **Keep all**, **Undo all**, and a
  **Create PR** button when the folder is on GitHub.
- **Background:** helpers, background subagents, commands with their running time and Stop
  (monitors show what they watch), scheduled messages, and the pull request the chat watches
  with **Check now** and **Stop watching**.
- **Plan:** the agent's to-do list.

Each card folds from its header. To move one, hover its header and drag the grip at its right
edge; the order holds for every chat.

The panel sits beside the chat when the tab is wide enough, and otherwise opens as a sheet from the
header's button. `agent.detailsPanel` (`auto`, `always`, `never`) and **Toggle chat details**
control it.

## Commands that keep running

When the agent starts a dev server or a watcher, it keeps running in the background and a chip
under the conversation counts it ("2 background commands · 1 completed, 1 running"). The agent can read what it printed since it last looked and stop
it; you can open its output or stop it from the list. When a dev server starts, its address opens
in a browser tab (`agent.openServers`).

- Background commands stop when you delete the chat, close the folder or quit the IDE. The Stop
  button stops the agent's turn, not a server it already started.
- For a long build or test run, the agent can ask to be told when it ends: it gets a message with
  how it ended and the last lines, and carries on. It can also wait until a command prints a given
  line ("listening on", "tests passed").
- **View output** under the step that started one opens what it prints, live, in a panel tab, with
  Stop while it runs.
- **Agent background commands** lists them for the whole window.
- **Monitors:** the agent can watch a log or a loop and get each new line as a message ("tell me
  every time an ERROR line appears"), while it works on something else. Lines that come together
  arrive as one message; a monitor that sends too much is stopped, and each one ends after its
  time (5 minutes unless the agent asks for up to 30). It's listed with the background commands,
  marked "monitor", with Stop.
- **Workflows:** ask the agent for a workflow ("run a workflow that reviews each folder, then
  verifies what it finds") and it writes a small script that runs several subagents, side by side
  or in stages. You're asked first, with the workflow's name, what it does and its phases. It runs
  in the background: a card under the conversation shows each phase and agent as it works, the
  tokens used so far, and **Stop**; the result comes back to the agent as a message. Its agents
  only read (they don't edit), at most 10 per run, 4 at a time, for up to 30 minutes
  (`agent.workflows.maxAgents`, `.concurrency`, `.timeoutMinutes`). Asked to change and run it
  again, the agent reuses the results of the steps that didn't change. `agent.workflows.enabled`
  turns the tool off. A workflow's agent can also edit, each in a git worktree of its own (a
  branch and folder, never your folder): the question before it runs names those agents, at most
  3 per run (`agent.workflows.maxEditingAgents`). The card lists each one's branch and what it
  changed, with **Review** and **Merge**; nothing is merged without you.
  marked "monitor", with Stop. A monitor can also listen to a WebSocket (`ws://` or `wss://`):
  each message the server sends comes back as one event, and the socket closing ends it. The
  agent asks before connecting, as it asks before running a command.

### Background tasks

Click the chip (or run **Show background tasks**) to open the Background tasks view beside the
chat. It lists everything the chat has working on its own, running and finished: subagents,
helpers in worktrees, background commands, monitors and a watched pull request.

- Each running task has its time and **Stop**.
- A subagent shows how many tool calls it made (and how many failed); open them to see each
  command and its output. Click its title to read its transcript: the brief it was given, its
  model and its work as the chat shows a turn, live while it runs. Finished subagents open too.
- A command opens to its command line and what it printed, live, with **Open output**.
- The trash button clears finished tasks; the expand button gives the view the whole window.

## Work the agent keeps an eye on

- **A pull request:** ask the agent to watch one (or run **Watch pull request from chat**). The IDE
  looks at it every minute through the GitHub CLI and tells the agent when a check fails, all
  checks pass, a merge conflict appears or someone comments (with what they wrote); the agent
  then fixes it in a turn of its own. Merged or closed, the watch ends. The chat's details show it
  with **Check now** and **Stop watching**.
- **Auto-merge:** ask the agent to merge the pull request once it's ready (or press the merge
  button on its row in the chat's details or Background tasks). The first time for a pull
  request you confirm it. Where the repository allows GitHub's auto-merge, GitHub does it;
  otherwise the IDE merges it when every check passed, it's approved (if reviews are required)
  and it merges cleanly, and says so in the chat. The same button turns it off.
- **A side task on this conversation:** the agent can fork itself: a copy that starts from the
  conversation so far works on a side question in the background (reading only) and reports back.
- **Your other chats:** the agent can list this folder's chats and send one a message, which
  shows in that chat as from this one and starts its agent working; you're asked the first time
  it messages a given chat. It can ask to hear back once that chat is done. Chats open in the
  IDE's other windows are listed too (with the window's folder) and can be messaged the same way:
  the other window passes the message on within a few seconds.
- **Earlier chats:** the agent can search this folder's chats (their messages and answers) for
  something decided or done before. **Search chats…** does it for you: type words, pick a hit, and
  that chat opens at the message.

## The chat in a worktree

Ask the agent to work "in a worktree" and it moves the chat into a git worktree: a new branch
(`agent/<name>`) and a folder next to the repository, set up like the worktree agents' (files from
`agent.worktree.copyFiles`, `agent.worktree.setupScript`). From then on its edits, searches and
commands happen there; your folder doesn't change. The chat's header shows the branch: click it to
**Review its changes**, **Merge into this folder**, or leave the worktree (keeping the branch, or
removing it). The agent can also leave by itself when you ask; removing a worktree with
uncommitted changes or unmerged commits asks you first. A chat in a worktree stays there after a
reload. It can also enter a worktree that already exists.

## Sessions and history

- **Sessions…** (the clock button in the Channels view's title bar, or the chat's **⋯** menu)
  lists every saved chat. [Sessions…](command:agent.showHistory)
- The model names each chat in its first reply (`agent.autoTitle`). **Rename chat…** and **Pin
  chat** are in the chat's menus.
- The chat's **⋯** menu also has **Export as Markdown**, **Copy conversation** and **Delete
  session**.
- **Long chats:** near the model's context limit, the older part of the chat is summarized so the
  agent keeps the thread (`agent.autoCompact`). `/compact` (or **Summarize the conversation**) does
  it now; `/clear` starts a new chat in place of this one.
- **A chat from another folder** opens with a "Started in …" banner: **Open** *folder* opens that
  folder, **Continue here** ties the chat to the folder you have open.
- **No folder open:** ask the agent to build something and it offers a folder card: it creates or
  opens the folder (in `agent.projectsFolder`, by default Projects in your home folder) and sends
  your message there. A folder the IDE makes this way is trusted.
- Transcripts and checkpoints are saved in the app's data folder.

## Pull requests from a chat

In the chat's **⋯** menu, **Open pull request** asks the agent to commit the conversation's work on
a branch and open the pull request, with a title and description written from the conversation.
The chat links it: a card shows it, and the menu item then opens it. See
[Source control](08-git.md).

## Usage and budgets

For models with a known price, the cost of each answer shows under it, and the chat's total is in
the context meter's tooltip (beside it only when the chat nears its budget). Prices come from your `agent.prices` (dollars per million tokens), else what
OpenRouter lists, else a
built-in list of common hosted models (approximate). Local Ollama models cost nothing.

- **Budget per chat** (`agent.budget.perChat`, in dollars): the agent warns at 80 % and asks
  before going past it.
- The **Usage** page shows what the agent and the AI features used on this computer: today, the
  last 7 and 30 days, a bar per day, models and features, the chats that cost the most (click one
  to open it) and the chat you're in with its budget. [Show usage](command:agent.showUsage)
- **Providers and limits** on the Usage page shows what each provider reports about its limits:
  requests and tokens left and when they reset (Anthropic, OpenAI and compatible services, after a
  request), or your OpenRouter credits, and "not reported" where a provider says nothing.
- The history is kept for 90 days in the app's data folder and never leaves your computer.
  **Clear usage history…** deletes it; `agent.usage.keepHistory` turns it off.
- Open the Usage page from the Channels view's **⋯**, the chat's **⋯** menu or Settings → Agent.

```json
"agent.prices": {
  "my-provider/my-model": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
},
"agent.budget.perChat": 2
```

External agents report their own usage; see
[External agents](06-agents-channels.md#external-agents).

## Voice input

A microphone sits at the end of the message box; the send button shows to its left once you've
typed something or attached a file, so you can type, speak, and type again. Click the microphone
and talk; a waveform shows while you speak. **Enter** or ✓ adds the words to your message, and
**Esc** or × throws the recording away. End with "submit" to send it right away.

- **On this computer, free:** the first click offers to download a speech model (60 MB, once).
  It runs offline, nothing leaves your computer, and it understands 99 languages. A sentence takes
  about two seconds. **Settings → Agent → Voice** has a more accurate model (190 MB, slower);
  **Remove the speech model** in the command palette frees the space.
- **A speech service:** with a Groq key (free tier) or an OpenAI key, and no model downloaded,
  the audio goes to that service. `agent.voice.provider` picks one, or `device` for this
  computer's model only.
- On Windows, **Win + H** (voice typing) also works in the box with no setup.
- The first time, your system asks to allow the microphone.
- **Transcribe an audio file** (command palette, or the agent) turns a WAV, MP3, M4A, OGG,
  WebM or FLAC file in the project into text the same way.

| Setting | Default | Description |
|---|---|---|
| `agent.voice.enabled` | `true` | Show the microphone at the end of the message box. |
| `agent.voice.provider` | `""` | What turns speech into text. Empty: this computer's model if downloaded, else Groq, else OpenAI. `device`: this computer's model only. |
| `agent.voice.localModel` | `base` | The model on this computer: `base` (60 MB) or `small` (190 MB, more accurate, slower). |
| `agent.voice.model` | `""` | The speech model. Empty: whisper-large-v3-turbo on Groq, gpt-4o-mini-transcribe on OpenAI. |
| `agent.voice.language` | `""` | The language you speak (`en`, `de`). Empty: detected each time. |
| `agent.voice.submitWords` | `["submit"]` | Words that send the message when you end with them. |

## Commit messages and other AI features

The agent's chat is on by default; AI features outside it are off until you turn them on. The
sparkle in the status bar lists them with an on / off switch each (**AI features…**), and **Choose
models…** sets each one's model. The **Agents** page (Customize) has them too, under **AI
features**: Edit with AI, suggestions as you type, next-edit suggestions, commit messages and the
memory tidy-up, each with its switch and its model (**Same as the chat** by default).

Every model chip (an agent's card, the agent editor, a subagent, an AI feature) opens the same
picker as the chat's: the providers down the side, search, favorites, and an external agent's own
models. Picking **Claude Code · Sonnet 5.5** for Plato is Plato's own: Plato answers on Sonnet
while the main agent stays on whatever Claude Code model you picked for it, even in one chat.
(Agents started with a model flag, such as GitHub Copilot, keep one model for everyone.) While you type, the
results are grouped under each provider or agent.

- **Generate commit message** (on by default, since it runs only when you press it): a button in
  Source control's commit box writes the message from the staged changes.
  `git.aiCommitMessage.model` picks its model; empty, the agent's. See [Source control](08-git.md).
- Commit messages and the memory tidy-up can also use an agent you have (Claude Code, Codex, Gemini
  CLI, GitHub Copilot): pick it under "Agents" in the feature's model menu. It answers one prompt
  with its own sign-in and does nothing else; it's slower than a model.
- Inline edit and suggestions as you type are covered in [Editing](04-editing.md).

## When you're in another window

When a chat asks you something, needs your approval, or finishes while the IDE isn't in front, the
taskbar button flashes (the Dock icon bounces on macOS) and a notification waits in the window with
**Show**. A round where several agents answer counts once. `agent.notifyWhenAway` turns it off.

**On your phone:** run **Send agent notifications to my phone** and give an
[ntfy](https://ntfy.sh) topic URL, a Discord or Slack incoming webhook, or any https address that
takes JSON. When the agent sends you a notification while the window isn't in front, it goes
there too: one line, no code. A URL anyone could post to is kept in the IDE's secret store, not in
your settings. **Send a test notification to my phone** checks it; **Stop sending agent
notifications to my phone** removes it.

## Plugins

Claude Code plugins work in the IDE: a plugin bundles slash commands, skills, subagents, hooks and
MCP servers. Open **Customize → Plugins** (or type `/plugin` in the chat), **Add marketplace**
(GitHub's `owner/repo`, a git URL, or a folder), then **Install** a plugin. You're shown what it
brings; its hooks and MCP servers run only if you tick them there. Its commands are
`/plugin-name:command`, its skills `plugin-name:skill`. In the chat: `/plugin marketplace add
<source>`, `/plugin install <name@marketplace>`, `/plugin disable`, `enable`, `uninstall`. Only
install plugins you trust: their commands run as yours.

Plugins can also bring output styles and language servers. A plugin's language servers start only
if you tick them, like its MCP servers.

Plugins you installed in Claude Code show under **From Claude Code** and work without installing
them again. Turning one off here leaves it on in Claude Code. Their hooks, MCP servers and language
servers start once you allow them from the plugin's ⋯ menu. Claude Code's marketplaces are listed
too, read from Claude Code's copy.

## The agent's tools at a glance

| Tool | What it does |
|---|---|
| `read_file`, `list_dir`, `find_files`, `search` | Read files (images for vision models, PDFs as text by pages, Jupyter notebooks as cells with outputs), list folders, find files by name or glob (`**/*.ts`, newest first), search text (matching lines with context, files or counts per file; by folder, glob or file type; long results page). |
| `edit_file`, `write_file` | Change and create files (under review); several changes to one file go in one `edit_file` call. The agent must read a file in the chat before changing it, and read it again if it changed since. |
| `run_command`, `process_output`, `kill_process` | Run a command (in the background for servers), read what it printed, stop it. When a command's output is too long for the chat, the agent sees its end, and the whole output stays readable for it (`out1`…) until the window reloads. |
| `find_commands`, `call_command`, `get_state` | Find and run the IDE's commands, read the IDE's state (`ide://…`). |
| `screenshot`, `browser_snapshot`, `browser_act`, `browser_inspect`, `browser_console`, `browser_eval`, `browser_batch` | Look at and use the browser preview or the whole IDE: find elements, read the page's text, click or drag at a point of a screenshot, press keys, zoom in, switch tabs, emulate dark mode, run a script to inspect the page (on a site that isn't yours it asks you first), several steps in one go, upload a project file or a screenshot into the page, record what it does as an animated GIF (shown in the chat with Save), and work in your own Chrome or Edge once you connect it (with its network, styles, storage and cookies). Clicks and keys reach the page as yours would (trusted events) in your own browser and, on Windows, in the built-in one; turn `browser.trustedInput` off to go back to script-made events. |
| `computer` | Off until you turn on **Computer use** (`agent.computerUse.enabled`, Windows): see your desktop and use other apps with the mouse and keyboard. The first action on each app asks you (Allow, or allow for this chat); browsers can only be looked at, terminals and IDEs only clicked, password managers and banking apps are refused. A banner with Stop stays on top while it works, and Esc stops it. |
| `web_search`, `web_fetch` | Search the web (when set up; only some sites, or a harder search) and read a page as text, or ask a question about it and get only the answer (you approve it, unless `agent.webFetch.autoApprove`). |
| `tool_search` | Load tools that are only named until needed: the agent's rarely used ones, and MCP tools when there are many (`agent.deferTools`). |
| `codebase_search` | Find code by meaning (with the codebase index on). |
| `explore`, `delegate`, `message_subagent` | Run subagents (they work privately and report back; a fork starts from this conversation); message a running one. |
| `monitor` | Watch a command's output: each new line comes back as a message. |
| `run_workflow` | Run a workflow script that fans work out to several subagents, in the background (only when you ask for a workflow; you're asked first). |
| `monitor` | Watch a command's output (each new line) or a WebSocket (each message) as messages. |
| `enter_worktree`, `exit_worktree` | When you ask for a worktree: move the chat into a new branch and folder of its own (or an existing worktree), so its edits and commands stay there; leave it, keeping the branch for review and merge or removing it (asked first if work would be lost). |
| `watch_pr` | Watch a pull request: failed or passing checks, conflicts and new comments come back as messages. Auto-merge it once it's ready, when you ask (you confirm it). |
| `list_chats`, `message_chat` | List your other chats in this folder and send one a message (asked first). |
| `hand_off` | Bring another of your agents into the chat to answer next. |
| `wrap_up`, `mark_chapter`, `propose_task`, `dismiss_task`, `enter_plan_mode`, `notify` | The next-step box at a turn's end, chapter dividers, a separate task offered as a card (and withdrawn), asking to plan first, a notification when you've stepped away (not sent while you're at the window). |
| `update_plan`, `ask_user`, `show_links` | Keep the to-do list, ask you up to four questions in one card (each with a short header, choices with a line on what each means and sometimes a preview beside them; type your own answer in **Other**; keys 1–9 pick, then **Submit** or Ctrl+Enter; **Skip** leaves the choice to the agent), show file and link cards. |
| `show_widget`, `widget_guide` | Draw a picture, chart, diagram or small interactive page (a calculator, a form, a table to sort) right in the chat, in the IDE's colors. It appears as the agent writes it, and its scripts run once it's complete. It runs sandboxed with no network; a button in it can send a message to the chat for you (marked as from the widget). Above it: open it full size in a tab, copy its code, or save it as an .svg or .html file. |
| `generate_image`, `save_image` | Make an image with an image model (shown in the chat with an id, saved to a path if asked), and save any image of the chat (or one you attached) into the project as .png, .jpg, .webp, .gif or .svg. |
| `report_findings` | Show a review's findings as a card: open each at its line, **Fix** one or **Fix all**. |
| `suggest_extension` | Suggest an extension from Open VSX when the task needs one you don't have: a card with **Install** (you install it; the agent doesn't). |
| `suggest_sandbox_allowance` | With the command sandbox on: after a sandboxed command needed a host the network filter refused or a folder outside the project, a card with **Allow** that keeps it for this project. The agent never widens the sandbox itself. |
| `suggest_skill` | Suggest a skill when a task could be made repeatable (a house style, a review checklist, a recurring workflow): skills that come with the IDE but aren't added yet, and ones you turned off, as a card with **Add** / **Turn on**. Added skills go in your own skills folder, where you can edit them. **Add an agent skill from the catalog…** in the palette lists the same ones. |
| `suggest_mcp_server` | Find MCP servers for a service or tool the task needs, in the popular servers and the MCP registry: a card per server with how it runs (npx, uvx, Docker or a remote address), what it needs, a field for each key and **Add**. Keys typed there are stored on your computer and never reach the chat; left empty, they're asked for when the server starts. Registry servers aren't reviewed: Add shows what one runs before it's written. |
| `mcp_status` | Show your MCP servers and how each is doing (running, failed with its error, waiting); **Reconnect** restarts one. |
| `remember`, `recall` | Keep and read memory notes (each of a kind: about you, feedback on how to work, the project, or where to find something). |
| `use_skill` | Load a skill's instructions. |
| `schedule` | Schedule a message for later, or on repeat ("every weekday at 9am"). |
| `schedule_wakeup` | In a loop (`/loop`): when to check next, a quiet check, or the end of the loop. |
| `hand_off_task` | Move the task it's in the middle of to a new chat that carries on, to answer you now. |
| `search_chats` | Search this folder's other chats for earlier work or decisions. |
| `read_guide` | Read this guide (its guide helper uses it to answer how-to questions). |
| `chat_attachments` | Find files attached earlier in the chat. |
| `mcp__`*server*`__`*tool* | Tools from your MCP servers. |

Calls that only read run together (up to 8 at once); edits and commands run one at a time, in
order, and two edits of the same file never overlap (`agent.parallelToolCalls`).

When a file the agent read changes afterwards (you edit it, a formatter or `git checkout` runs, a
command rewrites it), the agent is told with its next tool result or your next message, with a
short diff of what changed; a large change is only named, and the agent reads the file again
before it edits it. Its own edits are never reported back to it.

## Commands

| Command | Keys | What it does |
|---|---|---|
| Focus agent | Ctrl+L | Moves focus to the agent's message box. |
| New agent session | | Starts a new chat. |
| Stop agent | Esc (in the chat) | Stops the agent's turn. |
| Sessions… | | Lists every saved chat. |
| Select agent model… | | Picks the chat's model. |
| Add model provider… | | Adds a hosted or local provider. |
| Next agent | Shift+Tab (in the box) | The main agent, Plato, Gabby. |
| Set agent edit mode | | Review edits or accept them. |
| Set agent command approval | | Ask, run automatically or full access. |
| Accept all agent changes / Reject all agent changes | | Keeps or undoes every pending change. |
| Restore agent checkpoint… | | Puts files back as they were before a turn. |
| Summarize the conversation | | Compacts the chat (`/compact`). |
| Search chats… | | Finds earlier chats in this folder by their words; opens one at the message. |
| Review changes with the agent… | | A second opinion on a diff. |
| Close what the agent opened | Ctrl+Shift+Alt+W | Closes the tabs and windows the agent opened. |
| Show usage | | Opens the Usage page. |
| Toggle chat details | | Shows or hides the details panel. |
| Agent: choose output style… | | How the agent talks while it works (`/output-style`). |
| Agent background commands | | Lists commands the agent left running. |
| Show background tasks | | Opens the chat's subagents, commands and monitors beside it. |
| Customize… | | Opens the agent's set-up pages. |

## Settings

The agent's settings are under Settings → **Agent**. The ones that matter most day to day:

| Setting | Default | Description |
|---|---|---|
| `agent.model` | `""` | Model for new chats, as `provider/model`. Empty: the first local model. |
| `agent.effort` | `default` | Reasoning effort for models that take it. |
| `agent.thinking` | `auto` | Let reasoning models think before answering. |
| `agent.fallbackModel` | `""` | A model to go on with at a usage limit. |
| `agent.cloudContextLength` | `200000` | Most context to use with hosted models; older messages are summarized past 80 %. |
| `agent.runCommands` | `ask` | Whether the agent asks before running commands (`ask`, `auto`, `full`). |
| `agent.sandbox` | `off` | Run the agent's commands in the system's sandbox (`auto`, `off`). |
| `agent.sandbox.denyRead` | secrets | What sandboxed commands can't read (paths, `${secrets}`, `${keychains}`, `${browserProfiles}`, `${envFiles}`). |
| `agent.sandbox.allowWrite` | `[]` | Folders outside the project sandboxed commands may write, everywhere. |
| `agent.sandbox.allowHosts` | `[]` | Hosts sandboxed commands may reach, everywhere (`*.example.com`, `*`). |
| `agent.sandbox.projects` | `{}` | Per-project `allowWrite` / `allowHosts` (the sandbox card's Allow adds here). |
| `agent.allowedCommands` | `[]` | Command prefixes the agent may run without asking. |
| `agent.deniedCommands` | `[]` | Commands that still ask under `auto`. |
| `agent.whileWorking` | `queue` | What a message sent while the agent works does (`queue`, `interrupt`). |
| `agent.maxSteps` | `150` | Most model calls per message before the agent pauses (with Continue). |
| `agent.verify` | `auto` | Check the agent's work with the project's tests before it's done. |
| `agent.formatOnFinish` | `false` | Run the formatter on the files the agent changed. |
| `agent.followEdits` | `false` | Open each file the agent edits at the change, keeping focus in the chat. |
| `agent.budget.perChat` | `0` | A spending limit per chat, in dollars (0: none). |
| `agent.notifyWhenDone` | `true` | A notification when the agent finishes or needs you, while the window isn't focused. |
| `agent.outputStyle` | `default` | How the agent talks while it works (`default`, `explanatory`, `learning`, or your own style's name). |
| `agent.statusLine` | `{}` | A command whose first line of output shows in the status bar (Claude Code's `statusLine`). |

The full list, section by section, is in
[The agent's settings](07-agent-customize.md#the-agents-settings).

## Common questions

### The agent says no model is set up. What's the quickest start?

Click **Start free with OpenCode** in the empty chat, or install Ollama and pull a model. With a
key, add a provider; OpenRouter's `openrouter/free` works with any OpenRouter key.

### Why did the agent change my file before I accepted?

Edits are saved at once so the agent's own checks see them; review happens afterwards. Undo a
change with Ctrl+Alt+N, a file with the title bar's button, or everything with **Undo all**.

### How do I stop it asking about every command?

Choose **Run commands automatically** (risky commands still ask), allow single commands with
**Always allow**, or add patterns on the Auto-approve page. **Auto** asks about nothing except
the protections listed under [Access and approvals](#access-and-approvals).

### Can I keep some files away from the agent?

Yes: add an `.aiignore` file. See
[Keep files from the agent](07-agent-customize.md#keep-files-from-the-agent).

## Next steps

- [Agents and channels](06-agents-channels.md): the team, channels, helpers, worktrees and
  external agents.
- [Customizing the agent](07-agent-customize.md): rules, memory, skills, hooks and MCP servers.
- [Source control](08-git.md): commit messages and pull requests.
