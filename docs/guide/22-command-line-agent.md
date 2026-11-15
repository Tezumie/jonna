# The agent at the command line

The agent also runs without the IDE's window: in a terminal, in a script, in CI, or inside
another editor. It is the same agent, with the same models, settings, rules, skills, memory,
hooks, MCP servers and chats: a chat you start in a terminal shows up in the IDE's Chats list,
and you can continue one from the IDE in a terminal. This page covers the session in a terminal,
one-shot runs for scripts, permissions, output formats and exit codes, saved chats, the settings
and keys it uses, and running it for another program (`serve`) or another editor (`acp`).

Below, `<cli>` is the agent's command (run it with `--help` to see its name). It needs Node.js 20
or newer on your PATH.

## A session in the terminal

Run `<cli>` in a project's folder. You get a prompt; type what you want done and press Enter.

- The answer prints as the agent writes it. Each tool call is one line, with its outcome on the
  line under it; a file the agent changed is named with the line it changed.
- After each turn a status line shows the model, the mode, what the agent may do without asking,
  the cost so far (when the model's price is known) and how full the context is.
- `<cli> "fix the failing test"` starts the session with that message.
- To write a message over several lines, end a line with `\`; the next line continues it.
  Several lines pasted at once are one message: it is sent when the paste ends with a line
  end, or when you press Enter on its last line.
- The Up and Down arrows go through what you typed before, and the usual keys edit the line.

### When the agent asks

- **A permission** (a command it wants to run, a tool of an MCP server): the request is shown
  with the command, and you answer `y` (yes, once), `a` (always: remembered, as the IDE's
  "Always allow") or `n` (no; Enter means no too). The agent is told when you refuse.
- **A question of its own:** its choices are numbered. Type a number (several, like `1,3`, when
  it takes several), type your own answer, or press Enter to skip.
- **A question from an MCP server** (a value it needs, signing in again): asked the same way. A
  key or a password is not shown as you type it.

### Stop and quit

- **Ctrl+C** while the agent works stops it; the session goes on. A second Ctrl+C quits.
- Ctrl+C at an empty prompt, twice, quits; so do `/exit` and Ctrl+D.
- Ctrl+C on a line you are typing clears it.

### Slash commands

`/help` lists them all. The session's own:

| Command | What it does |
|---|---|
| `/model [name or number]` | Lists the models, or switches to one |
| `/mode [agent, plan, ask or one of your agents]` | Shows or sets how the agent works |
| `/permissions [ask, accept-edits, auto, full-access]` | Shows or sets what it may do without asking, for this session |
| `/sessions`, `/resume <number or id>` | This folder's saved chats; switch to one |
| `/new` (also `/clear`) | Starts a new chat; the old one stays saved |
| `/compact [focus]` | Summarizes the conversation to free context |
| `/cost`, `/status` | Tokens and cost; the model, mode, folder and chat |
| `/diff`, `/accept [path]`, `/reject [path]` | The changes waiting for review; keep them; put the old text back |
| `/conflict mine`, `/conflict saved` | When the chat was saved somewhere else meanwhile (the app, another run): save this session's chat over it, or load the saved one |
| `/key [provider]` | Stores a provider's API key (typed unseen) |
| `/exit` | Ends the session |

Everything else that starts with a slash is the agent's own, as in the IDE: `/undo`, `/rewind`,
`/review`, `/init`, `/effort`, `/context`, your prompt files and skills, and MCP servers'
prompts. Commands that open one of the IDE's pages (`/config`, `/mcp`…) need the window and say
so.

## One shot: run a prompt and exit

For scripts and CI. The answer goes to standard output; what the agent does on the way goes to
standard error (when that is a terminal, or with `--verbose`), so the output stays clean.

| Command | What it does |
|---|---|
| `<cli> -p "explain this repository"` | Runs the prompt, prints the answer, exits |
| `<cli> exec "explain this repository"` | The same |
| `<cli> --prompt-file task.md` | The prompt from a file |
| `git diff \| <cli>` | The prompt from standard input |
| `git diff \| <cli> -p "review this change"` | Piped input as context for the prompt |

In a one-shot run nobody is there to answer, so anything that would ask is refused unless you
allowed it (see below). Edits are accepted as the agent makes them; `--review` keeps them under
review instead, for you to accept or reject later in a session or in the IDE.

At a terminal, `-p` still asks you about permissions as a session does; `--non-interactive`
turns that off.

## What the agent may do

`--permission-mode` picks one of the IDE's four modes for the run:

| Mode | Edits | Commands |
|---|---|---|
| `ask` | Kept for your review | Ask first |
| `accept-edits` | Accepted (checkpointed, `/undo` puts them back) | Ask first |
| `auto` | Accepted | Run; deleting, pushing and the like still ask |
| `full-access` | Accepted | Nothing asks |

Without the flag, your settings decide, as in the IDE.

- `--allow <pattern>` lets something go ahead without asking, and `--deny <pattern>` refuses it
  whatever the mode. Both can be repeated. A pattern is a tool's name (`write_file`,
  `mcp__github__*`) or the start of a command line (`"npm test"` allows `npm test -- --watch`).
  Every part of a chained command has to be allowed; one denied part refuses the line.
- `--mode plan` and `--mode ask` are read-only: the agent researches and plans, or answers.
- `--max-steps`, `--max-cost` and `--timeout` (seconds) stop a run that goes on too long.

### Trust

A folder nobody decided about is treated as the IDE treats it before you answer its trust
question: its own hooks, MCP servers, tasks and restricted settings stay off, and a run says so.
`--trust` trusts the folder and remembers it, as **Trust** does in the IDE. A session at a
terminal asks once.

## Output for programs

`--output-format` chooses what a one-shot run prints:

- `text` (the default): the answer.
- `json`: one object when the run ends, with `ok`, `exitCode`, `session` (the chat's id),
  `text`, `reason`, `usage`, `steps`, `cost`, `denied` (what was refused) and `pending` (files
  waiting for review).
- `stream-json`: one JSON object per line as things happen (the chat's events: text as it is
  written, tool calls and their results, permission requests and decisions, usage), and the
  result object as the last line.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | The task finished |
| 1 | It failed: the model or a tool failed, or a step, cost or time limit stopped it. Also when the chat was saved somewhere else while the run worked (the app, another run): the saved chat is kept, this run's turn is not in it, and the JSON result has `"unsaved": true` |
| 2 | Bad usage or setup: an unknown option, no model, no key, the host program not found |
| 3 | A permission was refused |
| 130 | Interrupted with Ctrl+C |

## Saved chats

Chats are saved where the IDE saves them.

- `<cli> --continue` (`-c`) goes on with this folder's last chat; `--resume <id>` (`-r`) with a
  chat by its id; `--session-id <id>` uses an id of your choice (a new chat when none has it).
- `<cli> sessions list` lists this folder's chats, newest first (`--all`: every folder's;
  `--json` for programs). `<cli> sessions show <id>` prints a chat's conversation.

The same chat open in the IDE and in a terminal at once is noticed when the second one saves:
the IDE asks which version to keep.

## Models, settings and keys

- The model is the one your settings name (`agent.model`), or `--model`: a provider's model
  (`ollama/qwen3:8b`; `/model` in a session lists them) or an external agent, with its own model
  after a colon (`"Claude Code:opus"`). `--agent <name>` picks one of your own agents or an
  external agent, and `--effort <level>` the reasoning effort.
- Settings are the IDE's: your user settings, then the folder's. A flag wins over both for the
  run, and `--settings <JSON or file>` sets any setting for the run without writing it.
- API keys come from the IDE's key store (the operating system's keychain where there is one),
  else from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
  `GEMINI_API_KEY` and the like, each used only for its own provider's address). `/key` in a
  session stores one. A key is never printed.
- `--cwd <folder>` works in another folder, `--add-dir <folder>` adds more folders to the run,
  and `--user-data-dir <folder>` uses a separate profile (settings, keys and chats of its own).

## For other programs

### An ACP agent for other editors

`<cli> acp` speaks the Agent Client Protocol on standard input and output, so an editor that
runs ACP agents can run this one: give it `<cli>` as the command and `acp` as its argument.
Sessions are your chats, permission requests appear in the editor, and the modes above (and
`plan`) are offered as the session's modes.

### A running agent to attach to

`<cli> serve` keeps the agent running and listens on this computer only. It prints one line of
JSON with the port and a token; a front end connects with the token and can run the IDE's
commands, read its state, follow a chat's events and answer its questions. One client at a time.

## On Windows

- Both Command Prompt and PowerShell run `<cli>`. Quote a prompt with double quotes.
- In Command Prompt a `%NAME%` inside the prompt is replaced before the agent sees it; write
  `%%` for a percent sign in a batch file.
- After Ctrl+C in a one-shot run, Command Prompt may ask "Terminate batch job (Y/N)?"; either
  answer is fine, the run has already stopped.
- Output is UTF-8. Windows PowerShell 5 reads a program's piped output in the console's code
  page: run `[Console]::OutputEncoding = [Text.Encoding]::UTF8` first when you pipe text with
  letters beyond ASCII, or use PowerShell 7.

## Troubleshooting

- **"Node.js 20 or newer is needed":** install a current Node.js and open a new terminal.
- **"The host program wasn't found":** the agent needs the IDE's host program beside it; pass
  `--host <path>` or set `IDE_HOST_PATH`.
- **"No model is available":** start Ollama and pull a model, or add a provider and its key
  (in the IDE, or with the environment variables above), then pick one with `--model`.
- **Something was refused (exit 3):** allow it with `--allow`, a `--permission-mode`, or run a
  session and answer the question.
- `--verbose` prints the host's log and failed calls on standard error.
