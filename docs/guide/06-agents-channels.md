# Agents and channels

The IDE's agent works as a team. Besides the main agent there are agents of your own, each with
its own instructions, model, mode, effort and access, and you talk to them the way you talk to
people in a chat app: in channels, in direct messages and in threads. This page covers the team,
creating and editing agents, the Channels view, channels, threads, group chats, task channels,
schedules, helpers and subagents, worktree agents, and external agents such as Claude Code, Codex
and Gemini CLI.

For the basics of a chat (models, modes, access, context, reviewing edits) see
[The agent](05-agent.md).

## The Chats view

The **Chats** view in the activity bar is laid out like a chat app's side bar: a search field
on top (the list narrows to chats whose title or text matches; Escape clears it), then rows for
**New chat**, **Usage** (what the models have cost) and **Customize** (models and providers,
your agents and their models, rules, skills, slash commands, MCP servers).

Right-click **New chat** to open it **to the side** or **in a new tab**, to start it **with one of
your agents**, or for **New group chat…**. The title bar's **⋯** has **Sessions…** (every saved
chat), **Scheduled messages**, **Manage providers**, **MCP servers**, **Agent memory**, **Tidy up
memory**, **Archived channels…** and **Agent settings**.

Below them, the chats by folder: this folder's under its name, newest first (forty, then **Show
more**), then each other folder's latest chats under its name (a chat from another folder opens
here, offering to open its folder). Click a folder's name to fold it. Each row shows who's in
the chat (an agent's face, or the faces of a group), how long ago it changed, a dot while it
works and a badge when it needs you; it turns bold when its agents replied while you were
elsewhere.

Click a chat to open it in the chat panel (Ctrl+click or middle-click: a tab of its own).
Right-click it for **Open to the side**, **Open in new tab**, **Rename…** and **Delete**.

**Who answers** is picked in the chat's message box (the agent picker at its bottom left): the
main agent, Plato, Gabby or an agent of yours, each with its own model. To bring other agents
into a chat, **@mention** them: they answer there, and the chat becomes a group chat with their
faces on its tab and its row.

Channels and direct messages (below) still work for agents and commands, but the side bar
doesn't list them: their conversations show in the Chats list like any other chat, and open in
the chat panel.

## The team

Every folder starts with a team. Each agent is named for what it does and starts in its own mode:

| Agent | Starts in | What it does |
|---|---|---|
| The main agent (named {{product}} until you rename it) | Agent | Does the work: builds, edits, runs commands. |
| **Plato** | Plan | Works out how to make a change, read-only, and hands the plan on. |
| **Gabby** | Ask | Talks things through, read-only, and hands work on. |

- Plato and Gabby are ordinary agents (files in your agents folder): edit, rename or delete them
  on the Agents page. A deleted one doesn't come back.
- More starting points are templates in **New agent**: Builder, Code reviewer, Test writer, Docs
  writer, Refactorer, Debugger and Researcher.
- **Reset to defaults** (beside "Your agents" on the Agents page) puts the agents back as a new
  install has them: it asks first, moves every agent in your agents folder to the trash, writes the
  team again and clears their model and on / off choices. Project agents, Claude Code's agents and
  the main agent aren't touched.
- **One agent, one conversation at a time.** If you ask Plato something in its direct messages
  while it's answering in `#general`, the new turn waits for it ("Plato is answering in #general;
  this starts when it's done"); Stop cancels the wait. Chats with the main agent aren't limited.

### The main agent's name and face

The main agent is named after the IDE until you rename it. Its name and face are yours to choose:
on the Agents page, type a name in its card, or click its face for the face picker (or right-click
its direct message and choose **Rename or change face…**). Chats, group chats and @mentions use
them. By default it shows its model's logo.

## Create and edit agents

**New agent…** (the **+** beside Direct messages, or the Agents page) opens the agent editor, one
tab per agent. [New agent…](command:agent.newAgent)

1. Pick a template, or start blank. **Describe it…** has a model draft the name, role,
   description, instructions and access from one sentence (it uses the memory tidy-up's model);
   check the draft before you create it.
2. Choose a face: **Model icon** (the logo of the model the agent uses; the default) or
   **Character** (a face you pick, with Shuffle and a choice of colors).
3. Fill in the fields:
   - **Name:** how the agent is shown and @mentioned. Its id comes from the first name and never
     changes, so chats and mentions keep working after a rename.
   - **Role:** a short tag, shown beside its name.
   - **What does it do?:** when to use it. Other agents read this when they pick who to hand work
     to.
   - **Instructions:** what it's told with every message.
   - **Model:** its own model, or "Same as the chat". An external agent (Claude Code, Codex…)
     works too.
   - **Access:** **Read only** (reads and searches, changes nothing), **Can edit files** (no
     commands) or **Full** (every tool, commands included). **Advanced** lists its tools and its
     maximum steps.
   - **Mode:** **Agent** (does the work), **Plan** (plans first; its Build hands the plan to the
     main agent) or **Ask** (only answers): the mode its chats start in.
   - **Subagents** (once it's created): which subagents it may run. See [Subagents](#subagents).
   - **Where it lives:** **Every project** (the default) or **This project**.
4. Click **Create agent**. After that, each change is saved to the agent's file as you type.

The editor's footer has an on / off switch, **Delete**, **Duplicate** and **Chat with it**. On
the Agents page, an agent's card shows its face, model and source (Project, You or Claude Code);
its **⋯** has **Chat with it**, **Edit**, **Duplicate**, **Open file** and **Delete**.
[Configure agents…](command:agent.showAgentConfig)

### Agent files

An agent is a Markdown file: a header, then its instructions. The format is Claude Code's, so the
same file works there.

```md
---
name: test-runner
label: Tess
role: Tests
description: Runs the tests and fixes what fails. Use after changing code.
tools: read_file, search, run_command
model: ollama/qwen3:8b
mode: plan
icon: model
---
You run the project's tests…
```

| Field | What it does |
|---|---|
| `name`, `description` | Required: the agent's id and when to use it. |
| `label`, `role`, `icon` | Its shown name, its tag and its face (`model` for the model's logo). |
| `tools` | The tools it may use: the IDE's names or Claude Code's (`Read`, `Grep`, `Bash`…), and `mcp__server__tool` or `mcp__server` for an MCP server's. Left out: every tool. |
| `disallowedTools` | Tools taken away, whatever `tools` says. |
| `model` | `provider/model`, `inherit`, or `sonnet` / `opus` / `haiku`. |
| `fallbackModel` | A model to go on with at a usage limit. |
| `mode` | The mode it starts in: `plan` or `ask`. |
| `permissionMode` | `plan` makes it read-only; `acceptEdits` keeps its edits without review in its chat. |
| `maxTurns` | Most steps per task (up to 200). |
| `rules` | More rules to load for it. See [Rules](07-agent-customize.md#rules). |
| `isolation` | `worktree`: work handed to it runs in a git worktree of its own. |
| `handoffs` | Buttons under its replies that hand the chat to another agent. |

Agents for every project live in the `agents` folder next to your user `settings.json`; a
project's live in the `agents` folder inside the IDE's own folder in the project (the folder it
keeps for its settings, as VS Code keeps `.vscode`). `.github/agents/*.agent.md` files are
listed as agents too (see [Custom modes](07-agent-customize.md#custom-modes)). Claude Code's
`.claude/agents` files are subagents, as they are in Claude Code: see
[Subagents](#subagents).

## Each agent's model, effort and access

- **A direct message with one of your agents** runs on that agent's own model when it has one,
  otherwise on the chat's. The model pill under the box shows it, and picking a model there
  changes that agent's model everywhere.
- **An agent on an external agent:** pick Claude Code, Codex or another in the agent's model menu,
  and its replies come from that agent, in any chat.
- **In a group chat** the pills say **Models**, **Effort** and **Access** and list each agent with
  its own value, to change one at a time. Effort is "Same as the chat" or a level of its own;
  access is **Its default**, **Accept edits (checkpointed)** or **Read only**. The main agent's are
  the chat's. These choices are yours (kept in your settings), not the agent file's, so a
  project's agent can't give itself more access.
- A reply's footer names the model that wrote it.

## Channels

A channel is a conversation with a standing team and a purpose, which its agents are told. Open
`#general` and talk: its agents answer right there, and `@Name` picks who answers first.

- **Create a channel:** the **+** beside Channels. [Create channel…](command:agent.createChannel)
- **Right-click a channel** for **Edit agents…**, **Edit purpose…**, **Channel memory…**, **New
  conversation** (start its conversation over; the old one stays in Sessions… and the Inbox),
  **Open to the side**, **Open in new tab**, **Archive channel** and **Delete channel** (it and
  its conversations, after asking).
- **Archived channels…** (the view's **⋯**) brings an archived channel back.
- **The channel's header:** **+** starts its conversation over, and its **▾** jumps to another
  agent or channel.
- **Channel memory:** decisions and conventions kept for a channel, told to every conversation in
  it. Agents can add notes too; you see each one, and agents are told notes are information, not
  instructions.
- **Long channels:** a channel's or direct message's conversation is summarized past
  `agent.channels.contextTokens` (32,000 tokens), since each reply between agents sends it again.
  Threads keep the model's full context.

### Mention agents and everyone

- `@Name` in a message picks who answers. The first agent you mention answers first, the others
  after it, in order. With no mention, the agent that spoke last answers.
- `@channel` (in a channel), `@everyone` or `@all` asks every agent at once: the one whose turn it
  is answers with its tools, the others at the same time, read-only, without seeing each other's
  answers. Their answers join the chat when the turn is over.
- Turn on `agent.groupChat.answerTogether` to have several `@Name`s answer together the same way.
- Mentions are colored in the chat. Hover an agent's mention for its name, role and what it does.

## Threads

Messages have no **Reply in thread** in the plain chat panel. A message that already has threads
shows "3 replies · 2 min ago"; click it to open the thread, and **Thread ›** in its header goes
back to the chat. Agents can still start one (`agent.replyInThread`).

## Direct messages and group chats

**Direct messages** are ordinary chats with one agent. **@mention** another agent in any chat
(for example "@Plato what do you think?") and it joins: the chat becomes a group chat (two to six
agents) and that agent answers. You can also ask the agent to bring one in ("bring Plato into the
chat"), and the agent it invites answers after its reply. **New group chat…** starts one with the
agents you pick.

- **Agents answer each other.** A reply that starts a line with `@Name` hands the next turn to that
  agent. They may do that `agent.groupChat.maxAutoTurns` times (4) per message of yours, then the
  chat waits ("Paused after 4 replies…"). 0: only the agents you mention answer.
- **Messages while an agent works:** the agent working now reads yours at its next step, so "stop"
  changes what it's doing. A message that @mentions a different agent waits and starts that agent's
  turn when this one ends (the note under it says so). External agents read it after their turn.
- **Who's speaking:** each reply shows its agent's face and name when the speaker changes. In a
  group chat, **@** lists the members first, and the members pill mentions one or opens **Agents
  in this chat…**. The mode pill and Shift+Tab are off: each agent answers in its own mode.
- **Forking a chat:** every reply has **Fork** among its actions. It starts a new chat from that
  point and leaves this one as it is. Its menu opens at the button: the chat's own agent first,
  then the others, so a fork can go on with another agent. In the Chats list a fork sits under the
  chat it came from, and a fork of a fork under that. Right-click a chat and choose **Fork**, or
  type `/fork`, to fork all of it.
- **Handing the chat over:** an agent's file can define handoff buttons (`handoffs:`) that switch
  the chat to another agent with a prompt, and **Hand the chat to another agent…** in the command
  palette does it for any agent. To keep the chat as it is, fork it to that agent instead.
- **Delegating is different:** the other agent does a task on its own and reports back, without
  joining the conversation. See [Handing work to agents](#handing-work-to-agents).
- **A group chat on an external agent** (Codex, Claude Code…) plays every member with it, except a
  member with its own model: that one answers on its model, and the external agent is told what it
  said.

## Task channels

A task channel is a channel for one piece of work (as in Slack's task channels).

1. Click **+** beside **Tasks**. [New task channel…](command:agent.createTaskChannel)
2. Describe the task. It becomes the channel's first message, and the team works on it there.
3. When it's done, right-click the channel and choose **Close task**. It's archived with a note of
   what was done.

## Agents use channels too

Agents can post in a channel (a hand-off you can see), read another conversation, keep a channel
note and open a task channel. A post by an agent is marked "Posted by an agent, not the user",
can't run a slash command, and asks you first; an agent opens at most 8 task channels.

| Command | What it does |
|---|---|
| Post to a channel… (`agent.postToChannel`) | Posts a message in a channel or an agent's direct messages. |
| Read a conversation (`agent.readThread`) | Reads another of this folder's conversations. |
| `agent.rememberInChannel` | Keeps a note in a channel's memory. |
| New task channel… (`agent.createTaskChannel`) | Opens a task channel. |

`ide://agent/channels` lists every channel, direct message and thread.

## Schedules and wake-ups

Ask for something later and the agent schedules it: "remind me in an hour to check the deploy",
"every weekday at 9am, sum up what changed yesterday", "every 2 hours, look at the error log".
When it's due, the message arrives in the chat (as a quiet line with a clock) and the agent picks
it up, even if you're in another chat. It can also send it to a channel, to another agent's direct
messages, or to a new chat with one of your agents, so one agent can leave another work for later.

- **Times:** "in 20 minutes", "at 15:30", "tomorrow at 9am", "2026-11-03 09:00", "every 30
  minutes", "hourly", "daily at 9:00", "every weekday at 9am", "every monday and thursday at
  17:00".
- The agent asks you first before anything that repeats or goes to another chat. Repeats stop
  after 7 days unless you ask for longer ("every day at 9am for the next 3 months"; at most a
  year).
- Schedules run only while the IDE is open. One that came due while it was closed runs once when
  the folder opens again.
- The chat's details list its schedules (**Run now**, **Cancel**). The chat's **⋯** menu has
  **Schedule a message…**, and the Channels view's **⋯** has **Scheduled messages** for the
  whole folder. [Scheduled messages…](command:agent.schedules)

## Handing work to each other

Agents pass work on in two ways, as in Claude Code and the team bots:

| | Agents (Plato, Gabby, yours) | Subagents (Explore, Plan, Review, yours) |
|---|---|---|
| **What they are** | People you talk to: direct messages, @mentions, channels. | Workers an agent runs for one task. |
| **How work reaches them** | **Hand off:** the agent brings one into the chat; it answers next in the open and can hand back. | **Run:** the agent gives it a task; it works privately in a fresh context and returns a report. |
| **Where you set them up** | The Agents page and the agent editor. | The **Subagents** section of the main agent's page. |
| **Their files** | The `agents` folders. | `.claude/agents`, the project's and your home's. |

### Handing off to an agent

When another agent's job fits better (Plato for a plan, Gabby for a question, the main agent to
build the plan), an agent hands the chat to it: the chat becomes a group chat, the agent handed to
answers right after, sees the whole conversation, and can hand it back. The chat shows it as a step,
"Handed to Plato: …". Replies between agents stop after `agent.groupChat.maxAutoTurns` in a row.

- **Let agents hand work to each other** (`agent.handOff`, on the Agents page) turns it off. An
  agent you switch off isn't handed the chat.

### Subagents

A subagent does one task in its own context, with its own tools and model, and returns only a short
report, so your chat stays small. The chat shows it as a step, "Ran Review: …", that opens to the
report. Four come with the IDE:

| Subagent | What it does |
|---|---|
| **Explore** | Searches the code and answers a question (read-only); the agent runs it with its explore tool (`agent.explore`). |
| **Plan** | Researches the code and returns a step-by-step plan (read-only). |
| **Review** | Reviews code or a change (read-only); also the automatic review (below). |
| **General purpose** | A copy of the agent with its tools, for a self-contained task whose steps shouldn't fill the chat. |

Every agent's page in the agent editor ends with **Subagents**: the built-in ones and yours, each
with a model (**Same as the chat** by default; a fast one works well for Explore). As in Claude
Code, a subagent is shared: its model and instructions are the same whichever agent runs it.

- On the **main agent's page** (click its card, or **Subagents** under the agents), the switches
  turn a subagent on or off for every agent.
- On **one of your agents' pages**, they say which it may run: switch Plan off for Gabby and Gabby
  can't run it (others still can). It's saved in its file as `subagents: explore, reviewer`
  (`none` for none; no key: all of them), like Claude Code's `Agent(…)` list.

- **New subagent** writes a Claude Code file in the project's `.claude/agents` (in your home's
  `.claude/agents` without a trusted folder) and opens it. The format is Claude Code's:
  `name`, `description` (when to use it), `tools`, `model`, `permissionMode`, `maxTurns`, then
  its instructions. Files you already have for Claude Code work unchanged, and Claude Code's names
  for its own (`general-purpose`, `Explore`, `Plan`) map to the built-in ones.
- **Customize** (the copy button on a built-in one) writes it to `.claude/agents` with its
  instructions; your copy replaces it everywhere (a customized `explore` is what the explore tool
  runs, a customized `reviewer` does the automatic review). Delete the file to go back.
- **Let agents run subagents** (`agent.delegate`) turns them off: agents then do every task
  themselves.
- A subagent can't run subagents or hand the chat on: it works privately and reports.
- **Several at once:** when the agent needs several independent things (five files, three
  searches, two subagents looking into different parts), it asks for them in one step and they run
  at the same time (`agent.parallelToolCalls`).
- **In the background:** the agent can run a subagent in the background and go on working. Its
  report shows up in the chat when it's done. **Stop background subagents** is in the chat's **⋯**
  menu while any run.
- **Follow-ups:** while a background subagent works, send it a message with the speech-bubble
  button on its row in the chat's details, or **Message a background subagent…**. It reads it at
  its next step. The agent can do the same.
- **Review changes automatically** (`agent.autoReview`, off): after a turn that changes files, the
  Review subagent checks them in the background and the agent sees its report.

## Helpers in worktrees

The agent can hand a larger task to a helper that works in a git worktree of its own: it delegates
with `isolated`, or to one of your agents whose file says `isolation: worktree`. It asks you first.

- The helper gets its own branch and folder. By default it runs in this window, without a window of
  its own, and its tools (files, search, commands, its own `PORT`) work in its worktree, never in
  your folder.
- A line in the chat follows it. **Open its chat** (in the notification, or **Helpers in
  worktrees**) shows it at work, where you can answer its questions or send it a follow-up.
- When it's done, its report comes back to the chat that started it, and the notification offers
  **Review changes** and **Merge**.
- **Helpers in windows of their own** (`agent.isolatedHelpers.window`) gives each helper a window
  instead. **Helpers in worktrees at once** (`agent.isolatedHelpers.max`) caps how many work
  together (3).
- A helper can't start helpers, and a chat in Ask or Plan mode, a read-only agent or a folder that
  isn't a git repository can't start one.

## Worktree agents and best of N

Run several agents on the same repository without them touching your folder.

- **New agent in a worktree…** (the chat's **⋯** menu) asks what to do, makes a branch (`agent/…`)
  checked out in a folder next to your repository, and opens a window there whose agent starts on
  it. [New agent in a worktree…](command:agent.startInWorktree)
- **Setup:** each new worktree copies the files in `agent.worktree.copyFiles` (`.env` and the like,
  which git doesn't track) and runs `agent.worktree.setupScript` (`npm ci`, say). Its window gets
  its own `PORT` (`agent.worktree.basePort` + n × `agent.worktree.portStep`) and
  `WORKTREE_INDEX`, `WORKTREE_PORT_BASE` and `WORKTREE_PORT_STEP`, so dev servers don't collide.
  The setup script gets them too.
- **Best of N…** gives one task to several models at once and opens Compare: pick one to see its
  changes and **Apply this one**. [Best of N…](command:agent.bestOfN)
- **Worktree agents** shows every agent's state, files changed and time; it updates every couple
  of seconds. An agent whose window was closed mid-task shows Stopped, also after you restart the
  IDE. [Worktree agents](command:agent.worktreeAgents)
- **Agent worktrees** lists them: open one, have another model review its changes, merge it into
  your branch, or delete it.
- When **Apply this one** meets a conflict, the files are marked as usual and **Resolve
  conflicts** (in the notification or on the row) opens each in the 3-way merge editor.

## External agents

External agents are coding agents that run as their own programs and talk to the IDE over the
Agent Client Protocol (ACP). The presets are **Claude Code**, **Codex**, **Gemini CLI**, **GitHub
Copilot** and **OpenCode**. Install and sign in to them on the AI models page (Customize →
Providers, under **Use an agent you already have**), then pick one in the model picker. An
"Authentication required" error shows a **Sign in** card that runs the agent's login in a
terminal.

### Choose an external agent's model

In the model picker, pick the agent's tab:

- The first row (for example **Claude Code (its default model)**) switches the chat to it.
- Below are its own models; picking one switches with that model. Its reasoning level is the
  effort button beside the model. In a chat with the main agent the choice is the main agent's
  (`agent.externalAgentChoices`); in a chat with one of your agents it's that agent's own.
- The Agents page lists the external agents without a model: an external agent's model is always
  some agent's (its card, or the chat's model menu), so it's set in one place.
- The models are the ones the agent reported the last time it started, so the very first time they
  appear once it has started.
- Copilot doesn't offer a choice over ACP: its list comes from `copilot --help`, plus **Other
  model…**, and changing it restarts Copilot with `--model`.

Making an external agent the main agent (here or on the Agents page) switches the chat in use, and
new chats start with it.

### More agents from the ACP registry

Under **Use an agent you already have → View more agents**, the AI models page lists the agents of
the ACP agent registry: Cursor, Gemini CLI, Claude Agent, Copilot, goose, OpenCode, Kimi CLI, Qwen
Code, Mistral Vibe, Cline, Factory Droid, Auggie, Junie, Kilo, Amp, Devin, Antigravity and more.
[Browse agents](command:agent.registry.browse)

- Type in the search box to find one. **Details** shows its repository, website, license and how
  it's distributed.
- **Install** asks first and says where it comes from. Some download a program for your computer
  into the IDE's data folder (checked against the registry's checksum when it lists one; the card
  says "not checksum-verified" otherwise); some run through `npx` (needs Node.js) or `uvx` (needs
  uv). If the agent's program is already on your PATH, the card says so and Install uses it.
- Then pick it in the model picker, or press **Use**. **Remove** takes it away and deletes what was
  downloaded.
- The list comes with the IDE and is refreshed from the registry when you open it (**Refresh**
  fetches it again). Many of these agents are proprietary and need their own account; the card
  shows the license.

Other ACP agents go in `agent.externalAgents` (`{ "name": { "command": "…", "args": [] } }`), and
`{ "enabled": false }` hides a preset.

### How the IDE works with them

- **They ask before writing.** Each turn starts by putting the agent in the mode that matches the
  chat's access: with Review edits or Ask before commands, Claude Code and Codex ask before a
  write, through the IDE's approval card; with Accept edits and automatic commands they edit
  freely; with Auto they have full access.
- **What it changed.** Codex, Claude Code and Gemini CLI write files with their own tools. After
  each step and at the end of the turn, the IDE compares the folder with how it was and puts the
  changed files under review, like its own agent's edits: open the diff, keep, or undo a file or a
  single change. Without git, it compares the folder's files before and after the turn. Files your
  `.gitignore` leaves out and dependency folders are skipped unless a step names them. If you save
  a file during the turn, your own edits aren't shown as the agent's. A file that changes while
  none of the agent's steps is running (another program, another agent, a formatter) isn't
  counted as its work either: a note at the end of the turn names it.
- **The IDE's tools.** External agents get the IDE's tools with their session (read terminals, open
  editors, diagnostics, git and the IDE's commands) through the built-in MCP server; actions that
  change things still ask (`agent.externalAgents.ideTools`). Agents that only take MCP servers
  started as programs get them through a small proxy the IDE starts, with the key in its
  environment, never its command line. `ide://agent/ideTools` shows which way each chat's agent
  connects.
- **No folder?** You can still chat with one: it works in a private folder of its own that the IDE
  keeps for that chat, and it can't read or write anything outside it through the IDE. Open a
  folder and the next message moves it there.
- **After a restart** their chats pick up where they left off: when the agent supports it, its own
  session is loaded again; otherwise the IDE sends it a recap with your next message.
- **Their slash commands** appear in the "/" list while the chat uses the agent.
- **Guardian.** When Codex has its Guardian review a command, the command's row says so
  ("Guardian: approved · low risk"); open it for the reasoning. A command Guardian stopped shows
  as its own row.
- **Usage.** Claude Code, Codex and Gemini CLI report each turn's tokens; Claude Code also reports
  a cost, at API prices. Codex and Claude Code often run on your ChatGPT or Claude subscription,
  and the IDE can't tell which, so it applies no price of its own: a cost the agent doesn't report
  shows as "—" ("subscription or not reported"). Your plan's own limits are in the agent itself
  (`/status` in Codex, `/usage` in Claude Code and Copilot); Codex's `/status` limits are also kept
  in `ide://agent/session`. An agent that reports its turn by model gets a row per model on the
  Usage page.
- **Risky folders:** an external agent asks before it starts in Downloads, your home folder and
  the like.

## Claude Code's /ide

Claude Code in a terminal can connect to the IDE the way it connects to VS Code:

1. Turn on **Claude Code integration (/ide)** (`mcp.claudeCode.enabled`) in Settings → MCP.
2. In Claude Code, run `/ide`; the IDE is listed. Claude Code started in a terminal opened after
   that connects by itself.

Then:

- Claude Code sees your selection, open editors and diagnostics.
- Its edits arrive as diffs you accept or reject; the status bar shows how many wait.
- **Send selection to Claude Code** (**Ctrl+K Alt+K**, or the editor's context menu) @-mentions
  the selected lines in Claude Code's prompt.
- Claude Code can run code in a Jupyter notebook open here. You're asked each time; each run is a
  new cell at the end, and plots come back as images.

To let other agents use the IDE's commands over MCP, see
[The IDE as an MCP server](07-agent-customize.md#the-ide-as-an-mcp-server).

## Commands

| Command | What it does |
|---|---|
| Open channel… | Opens a channel or an agent's direct messages. |
| Show inbox | Opens the Inbox. |
| Create channel… | Makes a new channel. |
| New task channel… | Makes a channel for one task. |
| New conversation | Starts a channel's or direct message's conversation over. |
| Chat with an agent… | Opens a new chat with one of your agents. |
| New group chat… | Starts a chat with several agents. |
| Agents in this chat… | Changes a group chat's members. |
| Hand the chat to another agent… | Switches the chat to another agent. |
| New agent… / Edit agent… | Opens the agent editor. |
| Generate agent from a description… | Drafts an agent from a sentence. |
| Configure agents… | Opens the Agents page. |
| Reset agents to defaults | Puts the team back as a new install has it. |
| Message a background subagent… | Sends a follow-up to a running subagent. |
| Stop background subagents | Stops every background subagent. |
| Helpers in worktrees | Lists helpers working in worktrees. |
| New agent in a worktree… | Starts an agent on a new branch in its own window. |
| Best of N: one task, several agents… | Runs one task on several models and compares. |
| Worktree agents / Agent worktrees | The overview and the list of worktrees. |
| Schedule a message to the agent… / Scheduled messages… | Schedules and lists messages for later. |
| Browse agents from the ACP registry | Opens the registry's agents. |
| Select the external agent's model… | Picks an external agent's model. |
| Send selection to Claude Code (Ctrl+K Alt+K) | @-mentions the selection in Claude Code. |

## Settings

| Setting | Default | Description |
|---|---|---|
| `agent.mainAgent.name` | `""` | The main agent's name (empty: the IDE's own name). |
| `agent.mainAgent.icon` | `""` | The main agent's face (empty: its model's logo). |
| `agent.subagents` | `{}` | Per agent and subagent: its model, whether it's used, its effort and access. |
| `agent.delegate` | `true` | Let agents run subagents. |
| `agent.handOff` | `true` | Let agents hand the chat to each other. |
| `agent.explore` | `true` | Give the agent the explore tool. |
| `agent.autoReview` | `false` | The reviewer checks every turn that changes files. |
| `agent.parallelToolCalls` | `true` | Run calls that only read at the same time. |
| `agent.groupChat.maxAutoTurns` | `4` | How many times agents may answer each other per message of yours. |
| `agent.groupChat.answerTogether` | `false` | Several mentioned agents answer at the same time. |
| `agent.channels.contextTokens` | `32000` | How much of a channel's conversation is sent with each message (0: all). |
| `agent.isolatedHelpers.max` | `3` | How many helpers may work in worktrees at once. |
| `agent.isolatedHelpers.window` | `false` | Give each worktree helper a window of its own. |
| `agent.worktree.setupScript` | `""` | A command run in each new agent worktree. |
| `agent.worktree.copyFiles` | `[".env", ".env.local", ".env.development.local"]` | Untracked files copied into each worktree. |
| `agent.worktree.setupTimeoutSeconds` | `600` | How long the setup script may run. |
| `agent.worktree.basePort` | `3000` | The base of each worktree's `PORT`. |
| `agent.worktree.portStep` | `10` | Ports per worktree. |
| `agent.externalAgents` | `{}` | More ACP agents, or `{ "enabled": false }` to hide a preset. |
| `agent.externalAgents.ideTools` | `true` | Give external agents the IDE's tools through the built-in MCP server. |
| `mcp.claudeCode.enabled` | `false` | Let Claude Code find the IDE with `/ide`. |

## Common questions

### What's the difference between a channel and a direct message?

A direct message is a chat with one agent. A channel has a standing team, a purpose and its own
memory, and every agent in it can answer.

### Why is my agent's message waiting?

Each of your agents answers in one conversation at a time. The turn starts when the agent finishes
elsewhere; Stop cancels the wait.

### Can two agents edit files at the same time?

Agents answering together with `@all` are read-only. For parallel edits, use helpers in worktrees,
worktree agents or Best of N: each works on its own branch.

### Do Claude Code and Codex use my API key?

No: they run with their own sign-in, often on your subscription. The IDE shows their tokens and
any cost they report.

## Next steps

- [The agent](05-agent.md): models, modes, access and reviewing edits.
- [Customizing the agent](07-agent-customize.md): rules, skills, hooks and MCP servers.
- [Source control](08-git.md): worktrees, branches and merging.
