# What's new

Short notes for each release, newest first. The IDE shows this page after an update (turn it off
with the setting `update.showReleaseNotes`), and Help → Release notes opens it any time.

## 0.1.14

Fewer notifications.

- **One notice when a chat needs you, and none when you can see it.** A chat that finished
  or asks for an approval while it is on screen says nothing more; otherwise there is one
  notice, with Show. The setting `agent.notifyWhenDone` is gone: there is nothing left to
  turn off.
- **No notice for what the window already shows:** a push or pull that worked, an extension
  installed from the store, files kept unsaved over a restart, signing out.
- **One notice for one problem.** A formatter that fails, a wrong line in keybindings.json,
  an MCP server that doesn't start or a language server that stops are said once, not every
  time they happen again.
- **Setting up an agent shows that it is downloading,** wherever it was started from.

## 0.1.13

Fixes for the agent on Anthropic models, after a review of 0.1.12.

- **A subagent keeps its tools on Anthropic models.** One that named an MCP tool, or one of
  the tools that load on demand, could find it out of reach.
- **A tool the chat loaded stays loaded after a summary.** It went back to being found by
  search first.
- **A long chat through a server that only speaks Anthropic's protocol** (a proxy) is
  shortened here again before it reaches the model's limit.
- **One refused request no longer turns the cache savings off** for that model until the app
  restarts: it is tried again after half an hour.

## 0.1.12

Sharing a project with chosen people, and its chats.

- **Share a project with the people you choose,** not only the whole team: "Share with" on
  the project's card. Taking someone off makes new keys at once.
- **Share a project's chats too** (off until you turn it on). Teammates read them, and
  **Continue as my own chat** makes a copy to go on from. Files you attached, tool calls that
  name a key file and text that looks like a key or token are left out; anything else said
  in a chat is shared, so look before you turn it on.
- **A notice when a teammate shares** a project or its chats (setting `team.shareNotices`),
  and **Ask to share…** on a teammate, which leaves them a note on their Team page.
- **Long chats on Anthropic models keep more of the provider's cache:** a tool loaded in the
  middle of a chat no longer changes what was already sent, and over the limit with
  summaries off the provider clears old tool results itself.

## 0.1.11

A fix for chats on the newest Claude models, which also makes long chats cheaper.

- **"The block is bound to a different conversation" no longer stops a chat.** The newest
  Claude models check that the conversation sent back to them is the one they wrote in. The
  IDE now sends replies back exactly as they came and keeps earlier messages unchanged, and
  where the conversation does change (an update, a summary, a tool that joins) the model
  carries on without its earlier reasoning instead of failing. A chat that showed this error
  works again: press Retry.
- **Long chats read more from the provider's cache**, for the same reason: fewer things change
  what was already sent (screenshots now leave in groups, a summary starts clean).

## 0.1.10

Web search without a key, and three fixes in the agent's chats.

- **Web search without a key of its own.** "Agent: Set up web search" has a new choice, **the
  model provider's own search**: in a chat on an Anthropic model, the provider runs the
  searches and bills each one with the model. Each search shows as a line over the reply
  (hover it for the results). Searches run without asking first, so it's off until you choose
  it.
- **Chats started with no folder open** are listed under **No folder** once you open a folder
  (they were in no list), and offer **Continue here** to become one of that folder's chats.
- **The plan card shows finished work as finished.** An agent that did everything but didn't
  tick its last steps left them open; wrapping up now ticks them off, except the ones it says
  it didn't finish.
- "Still starting…: npx is downloading it" no longer stays under an external agent's work
  once it has started.

## 0.1.9

Sharing with your team, a look inside snapshots, and a security review.

- **Look inside a snapshot before restoring it.** Open a snapshot (Sync → Projects) to see its
  files and how each differs from your folder, open any of them as a diff, and restore one
  file or all of them from there.
- **Share a project with your team.** Turn on "Share with team" for a synced project:
  teammates see its snapshots, what changed, and can open a copy. Read-only for them; your
  own synced copy is untouched. Key files (`.env`, keys and tokens) are left out. Sync →
  Team has **People**, where you can compare fingerprints with a teammate, and **Shared
  projects**.
- **The team library has required items.** The team's owner can make an item required
  (always on) as well as a default, and is the only one who decides what is on for everyone.
  The Team page says who published each item and when, and has a filter.
- **Pin a snapshot from your account page,** as well as in the app.
- **Git is off until you trust a folder.** A repository's own settings can run programs, so
  git now waits for your answer to "Do you trust this folder?", as in other editors. Source
  control says so and takes you there.
- **A review for what arrives from your other computers.** Skills, commands and keybindings
  that could run something are held until you accept them once on each computer.
- **Security fixes from a full review of accounts and Sync:**
  - a model provider's key is only ever sent to the address it was saved for (after
    changing a provider's address, enter its key again);
  - the sync service can't hand back an older copy of something, or one item in place of
    another;
  - removing a computer always makes new keys;
  - if sync goes off by itself, your keys are kept for 30 days, not deleted;
  - settings that choose a model or loosen a protection no longer sync between computers.
- Signing in from the app now needs a confirmed email address (email and password accounts).

## 0.1.8

Sync: your settings, chats and unfinished work on every computer.

- **Sync** (a paid add-on; the editor stays free). Sign in, turn it on, and your settings,
  keyboard shortcuts, rules, skills and chats follow you to your other computers. Turn it on
  for a project and its chats travel too, with **snapshots** of unfinished work: commits you
  haven't pushed, staged and unstaged changes, stashes, or the whole folder when there is no
  git. Continue on another computer from the latest one, or go back to any of the last 30
  days you worked on it.
- **Encrypted before it leaves.** What you sync is encrypted on your computer with keys we
  never have. A second computer joins by showing the same six digits as one that already
  syncs, or with the recovery key you are shown once. Keep that key: without it or one of
  your computers, nobody can open the synced copy.
- **The Sync tab** (Accounts menu → Sync): what is in your account, your projects as folders,
  your computers, storage and recent activity. The website's account page shows the same.
- **Teams.** Add people to your Sync subscription from your account page: one bill, one pool
  of storage, and what each person syncs stays their own. A team also has a **library**
  (Sync → Team): publish your rules, skills, commands, agents, MCP server lists and default
  settings, and every member's editor can use them. Defaults are on from the start; anyone
  can switch an item off. A team's items never run anything without asking, and can't change
  what the agent is allowed to do on your computer.
- **The Documentation tab has search,** and looks like Settings: pages with icons on the
  left, the open page's sections under its name, Previous and Next at the end of a page. It
  has a new page, **Sync and teams**.
- **You can rename a computer and a synced project,** and stop syncing a project from the
  Projects page, where projects now look like folders.

## 0.1.7

The agent can run without the window, and a round of fixes.

- **The agent at the command line** (build it yourself for now). The same agent, with your
  settings, keys and chats, runs in a terminal: a session you type into, one-shot runs for
  scripts and CI, and a mode other editors can drive. It isn't in the installers yet; the
  repository's README says how to build it. Nothing about the app's own agent changes.
- **A menu's button closes it on a second click,** also for a tab's ⋯, a sidebar view's ⋯ and
  the terminal's profiles. They used to close and open again.
- **The details panel reads like the Chats list:** the same text size, icons and row height.
- **An external agent can't reach outside the folder with `..`** in a file request.
- **A click the agent makes in the browser pane lands** on a page that has only just loaded.
- **A tab moved into its own window** is ready for clicks as soon as it shows.
- **A notebook doesn't open again by itself** after its folder is closed.
- **Linux:** widgets in a chat draw (their scripts were refused there).

## 0.1.6

More room for the conversation, and two fixes.

- **A chat has no header row.** The line under a chat's tab that repeated its name is gone, so
  the conversation gets that space. Its buttons are beside the tabs now, where a terminal's and
  a preview's are: **Chapters** (when the chat has some), **Chat actions** (the ⋯ menu: new
  session, sessions, checkpoints, export, delete and the rest) and **Chat details**. New chat
  and Sessions are in the Chats list and the ⋯ menu. A thread and a channel keep their title.
- **Dragging a divider follows the mouse** even while something else on screen updates. A tab
  refreshing during the drag could put the old sizes back until the next move.
- **The logo is dark on light themes,** in the title bar, the Welcome page and menus. It was
  faint there.

## 0.1.5

A layout to start from, and fixes from daily use.

- **Choose your default layout.** Settings → Default layout has three cards: **Default** (Chats,
  the Welcome page, the agent on the right), **Agent** (Chats and the chat, filling the window)
  and **Code** (the Welcome page alone, as VS Code starts). It is what a window starts with when
  it opens without a folder, when you close a folder, and the first time you open one.
- **No terminal opens by itself.** A folder opened for the first time used to start one.
  Ctrl+` opens it when you want it.
- **Changing an external agent's model shows that it's working.** The model pill shows the model
  you picked with a spinner until Claude Code, Codex or another agent has taken it; the first
  change starts the agent and can take a while. The same for its reasoning level.
- **The chat details panel and folders.** With nothing open, Environment shows "No folder":
  click it to open one. Right-click a folder there to reveal it, copy its path, open a terminal
  in it, change folder, or add another folder beside it; added folders are listed under the
  first, and the agent works in all of them.
- **A folder's tooltip in the Chats list no longer covers its + button.**
- **Forks:** a fork of a thread or of a channel's conversation is a chat of its own (it wasn't
  listed, or went with the channel); it starts with its own spend, takes its images along whole,
  and a chat forked while it works no longer opens as interrupted.
- **Extensions:** an update whose details couldn't be read isn't offered unchecked, and
  pre-releases aren't offered as updates.

## 0.1.4

Two follow-ups to 0.1.3.

- **Double-clicking a preview tab (italic title) keeps it open.** 0.1.3's fix didn't work with a
  real mouse; this one does.
- **Extensions install their newest version.** The IDE now reports VS Code 1.146 to extensions,
  so the store no longer holds one back at an older release (Error Lens stayed on 3.26.0). An
  extension that relies on something very new in VS Code may still not work.

## 0.1.3

Fork a chat from any reply, and several fixes from daily use.

- **Fork a chat from any reply.** Every reply has a Fork button: it starts a new chat from that
  point and leaves this one as it is. Its menu opens at the button, with the chat's own agent
  first and your other agents below, so a fork can go on with another agent. It takes the place
  of "Hand to another agent…" on replies.
- **Forks sit under their chat** in the Chats list, and a fork of a fork under that. Right-click
  a chat and choose Fork, or type `/fork`, to fork all of it.
- **Very large files open at once.** A text file of a few hundred thousand lines (a model's
  tokenizer, a big data file) froze the window for minutes.
- **VS Code extensions that read all their settings in one go start.** Error Lens failed with
  "Cannot read properties of undefined".
- **No update offered that can't be installed.** An extension whose newest version needs a newer
  VS Code than the IDE follows was offered that version right after installing an older one.
- **Double-clicking a preview tab (italic title) keeps it open.**

## 0.1.2

Agents you bring (Claude Code, Codex…) work with the IDE the way its own agent does, and
extensions with their own editors behave better.

- **An agent you brought asks in its chat.** Its questions about IDE commands are cards in the
  chat, under the chat's access mode, not a dialog over the window. One question per action, not
  two.
- **It knows this isn't VS Code.** A guide for agents is among its tools: how to reach the IDE,
  where the documentation is, and how to build an extension in the IDE's own format or as a VS
  Code extension.
- **It can load and install an extension folder for you**, after asking. Installing the same
  folder again updates the installed copy.
- **Extensions with their own editors** (VS Code's custom editors):
  - their buttons show in the tab's toolbar and their keys work;
  - "open as text" opens the text editor;
  - undo and redo work;
  - a file open in one comes back when you reopen the folder;
  - their pages can use the IDE's colors, sizes and corners;
  - their JSON schemas check and complete your files.
- **Resize handles next to an extension's page** show their highlight fully and are easier to
  grab.
- **The Send button's icon is back** in the agent's message box.
- **The language server settings page scrolls.**

## 0.1.1

Small fixes, and the first update delivered through the app itself.

- **The agent's icon is right from the start.** An agent that shows its model's logo could show a
  stand-in character until something else redrew it.
- **The icon beside the agent's name follows the chat's model.** It showed the default model's
  logo even after the chat was switched to another provider.
- **A macOS installer** (Apple silicon and Intel). It isn't signed yet: see Install in the README
  for how to open it.

## 0.1.0 — The first public alpha

Welcome. This is the first build anyone can download, so there is nothing to compare it with yet.
What's in it:

- **A complete editor:** Monaco with VS Code's grammars and themes, language servers, multi-cursor
  and Vim mode; VS Code's keybindings, `settings.json`, themes and `tasks.json` work as they are.
- **An agent harness:** a built-in agent with file, search, terminal, browser and IDE tools, on
  local models or hosted ones with your own key. Claude Code, Codex and other CLI agents run
  inside it over ACP, or drive it from outside over MCP.
- **Review before anything changes:** the agent's edits are a changeset you accept or reject per
  file or per hunk, with a checkpoint for every turn.
- **Git, a debugger, tests, terminals and a browser preview**, all of them reachable by the agent.
- **Extensions:** VS Code extensions from Open VSX, and small sandboxed ones the agent can write
  for you.
- **No telemetry**, and no account needed. Signing in is optional.

It's an alpha: expect rough edges, and tell us what breaks with Help → Report a problem.
