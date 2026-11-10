# extensions/agent

The built-in coding agent (PLAN §8, DESIGN.md §13). Each session is an `agent` dock tab (not a
singleton; `viewState: { session }`); "Focus agent" reuses the most recent one.

- **Models** (`providers.ts`, D69): "Add a provider…" offers presets (OpenRouter, OpenAI, Anthropic,
  Groq, LM Studio, llama.cpp) and asks for the API key; big catalogs open a searchable picker.
  Anthropic uses its native Messages API (`kind: "anthropic"`, D112).
- **Prompt caching** (D112): the system prompt is built once per session; the IDE state rides on
  each user message; tools are fixed per turn; earlier messages are sent unchanged while they fit;
  summaries reuse the cached prefix. Settings: `agent.cacheTtl`, `agent.effort`,
  `agent.cloudContextLength`, `agent.ollama.keepAlive`. The meter's tooltip shows cache use.
- **Model discovery**: Ollama is found automatically at `agent.ollama.url` and every
  installed model is listed (local first, cloud models in a submenu) with size/context/tools info
  from `/api/show`; OpenAI-compatible endpoints come from `agent.providers` (keys via
  `agent.setApiKey`, stored by Rust). External ACP agents (`acp.ts`, D73) appear in the same menu.
- **Session files** (D221, split by responsibility): `session.ts` (the session's state, permissions,
  queue, saving), `sessionRewind.ts` (retry, edit and resend, restore checkpoint, putting files
  back; D245), `sessionTurn.ts` (one turn: tools, model requests, verify),
  `sessionExternal.ts` (an ACP agent's turn), `sessionSubagents.ts` (subagents, background runs,
  automatic review), `sessionSummaries.ts` (summaries, one-off tasks), `sessionUsage.ts` (request
  options, usage, budget), `sessionStore.ts` (the saved form), `sessionTypes.ts` (shared types).
  Commands: `commands.ts` (sessions, modes, slash, mentions), `sendCommands.ts` (`agent.send`,
  `agent.startInFolder`), `reviewCommands.ts` (accept / reject, review diffs, checkpoints),
  `modelCommands.ts` (models, providers, keys), `mentionContext.ts` (@-mention context).
- **Turn** (`sessionTurn.ts` → `core/agent/loop`): system prompt from `context.ts` (AGENTS.md /
  CLAUDE.md + IDE digest), native tool calls or the text protocol, live streaming.
- **Tools** (`tools.ts`): read_file, list_dir, find_files, search,
  edit_file, write_file, run_command, get_state, find_commands, call_command, process_output,
  kill_process, plus MCP tools (`mcp.ts`, D72), and `delegate` for subagents (D195).
  D253: a step's calls that only read run together (`AgentTool.concurrent`, the loop's
  `callGroups` / `inParallel`, at most 8; `agent.parallelToolCalls`), subagents included (one
  started while another uses the turn's requests gets its own); two edits of one file wait for
  each other (`KeyedLock` in `sessionTurn.ts`, by the resolved path and across every chat of the
  window, D254). D254: one of the user's agents answers in one conversation at a time
  (`agentTurns` in `sessionTurn.ts`: a turn for an agent busy elsewhere waits, with a notice, and
  Stop works while it waits; the main agent isn't limited); at a usage limit a turn goes on with
  the agent's `fallbackModel:` or `agent.fallbackModel` (`isUsageLimit` and `SwitchModelError` in
  the loop: the step is taken again after the switch, at most twice a turn).
  `chatTools` (session.ts) is the tool list a chat
  gets; `SessionManager.builtinTools` is what the MCP page counts (MCP tools carry `mcp`).
  read_file's paging, images (attached for vision models) and PDFs (`core/agent/pdfText.ts`, as
  text) are in `readFileOutput.ts`.
- **Files and search, after Claude Code's tools** (package B, D306–D311): `searchTools.ts` builds
  `search` (Grep: `pattern` a regex, output_mode content / files_with_matches / count, context
  lines, ignore_case (smart case by default), only_matching, multiline, path / glob / type,
  head_limit 250 / offset paging that names the next offset; the old `query` / `regex` / `include`
  still work; `core/agent/grep.ts`, tested) over the `search.find` command (the user's
  search view is left alone), and `find_files` (Glob: a glob pattern, newest first, with `path`,
  `limit` / `offset`; plain words stay fuzzy; `core/agent/fileGlob.ts`). Read before edit
  (`readGuard.ts`, D309): edit_file and write_file over an existing file need the file read (or
  written) in the chat (`Changeset.hasSeen`), unchanged since; an attached file sent whole counts.
  Changed-on-disk notes (`changeNotices.ts` + `core/agent/readTracker.ts`, D308): the texts the
  agent last saw (`Changeset.reads`, in memory) are compared after every tool call and with the
  user's next message (in `<ide_state>`); a change comes back with a short diff (a change shown
  whole counts as read), a large one only named. read_file reads `.ipynb` as cells with outputs
  and PDFs by `pages` (`core/agent/notebookText.ts`, D310). A foreground run_command whose output
  was cut keeps it whole as `out1`… (`core/agent/savedOutput.ts`, the last 5 per chat, in memory)
  for process_output's `offset` / `limit` / `filter` (D311).
- **Screenshots** (D96): the `screenshot` tool (`browserTools.ts`) captures the browser tab's page
  or the whole IDE; the image goes to vision models as a user message after the tool results
  (newest two only) and shows as a thumbnail in the chat; `call_command` results with a `png`
  field are handled the same way. Images aren't saved with the session.
- **Browser tools** (`browserTools.ts`, `browserScriptTools.ts`; D316–D318): Claude Code's browser
  tools as modes and actions of the existing ones, to keep the tool list short. `browser_snapshot`
  `find` (outline lines with refs, `core/agent/browserInput.ts` `findInOutline`) and `text` (the
  page's main text); `browser_act` clicks (right, double, triple), hover, drag and wheel scroll at
  a `coordinate` of the screenshot's frame, keys with `repeat` and `modifiers`, typing at the
  focus, `wait` `duration`, `new_tab` / `select_tab` / `close_tab`, and `action_summary` for its
  row (`planAct` maps it to browser.* commands, tested); `browser_inspect` `tabs` and `resize`
  with `preset` and `colorScheme`; `browser_console` `pattern`; `screenshot` `region` (zoom) and
  `scale`. New: `browser_eval` (REPL: `core/agent/browserEval.ts`; asks first on sites that aren't
  local, D317) and `browser_batch` (`core/agent/browserBatch.ts`: in order, stops at the first
  error, not nestable, only the turn's tools).
- **Files into a page** (D339, `browserUploadTool.ts`, `core/agent/browserUpload.ts` tested):
  `browser_act upload` with `files` (workspace paths only; files excluded from the agent stay out)
  or `screenshot` (an id the `screenshot` tool gives with each page shot: the chat's last 8 are
  kept) onto a file input or a drop zone (ref, selector or coordinate), through `browser.upload`
  (asks like the other page actions). Claude in Chrome's file_upload and upload_image.
- **Recordings** (D340, `browserRecorder.ts`, `core/agent/browserRecording.ts` and
  `core/image/gif.ts` tested): `browser_act start_recording` / `stop_recording` (Claude in
  Chrome's gif_creator): a frame after each browser action (a marker where it pointed, its
  `action_summary` as a caption) and every second while the page is on screen, encoded as an
  animated GIF as it goes; stop draws a card in the chat (`view/recordingCard.ts`; a
  `browser_batch` that stops one shows its row and the card) with Save to project and Download
  (`agent.saveRecording`). Kept in memory until the IDE closes (the last 10), listed at
  `ide://agent/recordings`; a recording ends by itself after 5 minutes, 300 frames or 30 MB.
  D354: the whole IDE window too: the `screenshot` tool's `record: start | stop` (target `ide`,
  the default; `page` records the tab), and the user's `workbench.recordGif` (toggle, `stop`) for
  bug reports, with a status bar item while the IDE is recorded (click: stop). Frames are
  `captureWindow` pictures; the user's clicks add a frame with a marker and "Clicked <label>". The
  card says "IDE recording"; the user's own recording is offered in a notification (Save / Download).
- **Desktop control** (D353, `computerTool.ts`; `core/agent/computerUse.ts` tested; Rust
  `desktop/`): the `computer` tool (Claude Code's computer use) — screenshot (all monitors or
  `monitor`, `region` zoom, `scale`, the browser tools' coordinate frame), clicks, drag, move,
  type, key chords with repeat, scroll, wait. Offered only with `agent.computerUse.enabled` (off by
  default) on Windows, never to a small model. The first action on each app asks "Allow <app>?"
  (Allow, with "Allow for this chat"; asked even in full access); tiers: browsers look-only,
  terminals and IDEs left-click and scroll only, system settings and the IDE's own window asked
  every time, password managers and trading / banking apps refused; a card number is never typed.
  While a turn uses it the native banner "Controlling your computer" (Stop) stays on top (left out
  of screenshots) and Esc anywhere stops the turn; the status bar item does too
  (`agent.computerUse.stop`). `agent.computerUse.revoke` forgets grants; `ide://agent/computerUse`.
- **The user's own browser** (D341): when the browser extension is connected to the user's Chrome
  or Edge (`browser.launchExternal` / `browser.connectExternal`), the browser tools are offered
  and list it as tab `external`; `browser_act select_tab external` makes it the one they act on.
  `browser_inspect` works there too, over the DevTools protocol (D347).
- **Trusted input** (D346): `browser_act`'s clicks, keys and typing reach the page as a person's
  (`isTrusted`) in the user's own browser and the built-in tab on Windows; where they are
  synthesized instead, the row says "(synthesized)".
- **Review** (`changeset.ts`, D70, D199): edits are written to disk at once (checkpointed first,
  D71) and stay in the changeset for review (`onDisk`): accept only clears the review; reject puts
  back the pre-turn content on top of the file as it is now (`rebase`, D161: a same-line conflict
  refuses). Auto-apply mode skips the review. `{ staged: true }` proposals (the memory tidy-up)
  keep the old way: written only on accept. Review diffs compare the `agentBase:<session>` content
  (the original) with the live file (`agent.openReviewDiff`).
- **Inline review** (`inlineReview.ts`, D199): tinted changes, margin bars and a hint in the
  editor; `agent.acceptHunk` / `agent.rejectHunk` (`path` + `index` or `line`, default the cursor),
  `agent.nextHunk` / `agent.previousHunk`, `agent.acceptFile` / `agent.rejectFile`; context key
  `agentReviewActive`; `ide://agent/review`.
- **Ignore file** (`ignore.ts` + `core/agent/ignore.ts`, tested, D199): `.aiignore` /
  `.cursorignore` (gitignore syntax) at the folder root and in the IDE's folder, `agent.ignoreFiles`
  and the default secrets (`agent.ignoreDefaults`). read/edit/write refuse, list marks, find and
  search skip, @-mentions refuse, `call_command` refuses a command whose `path` input is excluded
  and filters search results, the rule files can't be written by the agent; matching ignores case
  and Windows' trailing dots and streams; `run_command` is not blocked. `ide://agent/ignore`.
- Files that editing would corrupt (not UTF-8 on disk or in an open tab, binary, > 4 MB) are refused
  (`editableText`). Stop skips a stopped tool's side effects (per-call flag, D161).
- **Permissions** (`permissions.ts`): run_command allowlist (`agent.allowedCommands`); IDE commands
  go through the permission policy (`core/permissions`) with `askAgent` — inline cards: once / always / deny.
  `agent.runCommands: "full"` (D163) never asks about anything (commands, IDE and browser
  commands, MCP tools, external agents): `session.ask` answers at once.
  `agent.runCommands: "auto"` (mode menu, `agent.setCommandMode`, D117) runs commands without
  asking except the built-in denylist (`DEFAULT_DENIED_COMMANDS`: deleting, killing, downloading,
  sudo, git push…) plus `agent.deniedCommands`, read with the program's folder and `.exe` dropped
  and git's options skipped; a program run through git's config (`-c alias.x=!…`, `core.pager`…)
  or the environment (`GIT_PAGER=…`, `NODE_OPTIONS=…`) asks too (D391) — only in a trusted folder (D103): in one that
  isn't, commands and IDE commands ask as in "ask" mode (the card says why), since the folder's
  scripts, Makefile and `agent.verifyCommand` are its own programs and its files can steer the
  agent (m7.6). Dev servers (`looksLikeServer`) always start in the
  background; a server already started is reused, and its address opens in a browser tab
  (`agent.openServers`).
- **Changing the IDE asks** (D176, `core/permissions/ideControl.ts`): IDE commands under layout,
  view, workbench, ui, settings, keybindings, extensions… ask in the chat even with full access
  (`evenWithFullAccess`); "Always allow this chat" covers all of them for that chat.
- **Extensions:** `read_file` / `list_dir` also read loaded extensions' folders (installed ones
  are outside the workspace), read-only; the prompt points to `extensions.guide`.
  `contributes.agents` / `mcpServers` from extensions join the model menu and the MCP clients;
  `agent.compose` opens the panel with a drafted message.
- **Memory** (D109): `update_plan` (the session's plan, a card under the conversation's latest
  message, D300; the whole list or `advance` / `done` / `start`, `core/agent/plan.ts`; re-sent in
  the system prompt), compaction (`core/agent/compact.ts`: summary items near the context limit,
  `/compact` / `agent.compact`), the context meter, @-mentions (`agent.mention`).
- **Turn tools** (`turnTools.ts`, `turnCommands.ts`, `view/turnCards.ts`, `core/agent/turnTools.ts`
  tested, `styles/agent-turn.css`, D301–D305, after Claude Code's app): `wrap_up` (recap, one
  `ask`, 1–2 buttons: a reply sent as the user's message or an app action run by
  `agent.runWrapUpAction`; only actions available now are accepted; finishes the plan; the box
  under the latest turn, after the plan card; its first sentence is the chat's `recap` in the
  lists, `blocked` marks the chat as needing the user), `mark_chapter` (a divider, moved above the
  message when it opens the turn; the header's Chapters menu, `agent.showChapter`),
  `propose_task` / `dismiss_task` (a "New task" card: `agent.startTask` opens a new chat with the
  brief, `agent.dismissTask`; its state is the call's `summary`), `enter_plan_mode` (a consent
  card through `session.question`; yes switches the chat and the rest of the turn to Plan,
  `ToolHost.followChatMode`) and `notify` (window attention plus a notification, only when the
  window isn't focused, one a turn). All are saved as their tool calls, so reload and rewind keep
  them; subagents don't get them. State: `ide://agent/session` `wrapUp`, `chapters`, `proposals`.
- **Project memory** (`memory.ts` + `core/agent/memory.ts`, D110): `<IDE folder>/memory/<topic>.md`,
  written by the `remember` tool, read with `recall`; the prompt gets an index. D271: a note
  can carry a short `why`, and `replaces` updates (or, with an empty note, removes) the note it
  corrects instead of adding another; the prompt asks for the user's corrections to be saved as
  they're made; the index shows two notes per topic (the user's own: all that fit). `agent.dream`
  ("Tidy up agent memory") proposes a curated version in a new session for review;
  `agent.openMemory` shows the folder; state `ide://agent/memory`. D315: notes have a `type`
  (user, feedback, project, reference) as a `[type]` tag, feedback and project notes carry
  `**Why:**` / `**How to apply:**` on the same line, `[[topic]]` links topics (recall lists them),
  `recall { type }` reads one kind; untyped notes read as before, and the tidy-up keeps the tags.
- **Web pages** (`webFetch.ts` + `core/agent/webText.ts`, D130): `@web <url>` mentions and the
  `web.fetch` command (network effect: agents ask first).
- **Approval cards** (D110): heading, the command as code, "always allow" checkbox, Deny / Allow;
  a leading `cd <folder> &&` becomes the working folder (`splitLeadingCd`).
- **No folder open** (D121): `agent.send` shows a folder card (name from
  `core/agent/projectFolder.ts`, parent from the message / `agent.projectsFolder` / `~/Projects`);
  `agent.startInFolder` creates or opens the folder and sends the message there.
- **Chats sidebar** (`chatsView.ts`, `chatGroups.ts`, D121): the `agent.chats` sidebar view —
  search on top, then a vertical nav without backgrounds (New chat, Usage, Configure agents,
  Agent settings; More: Manage providers, MCP servers, Agent memory, Tidy up memory; D204), chats:
  pinned, "This project" (the open folder's, newest first, D227), then the rest by day, delete; `agent.showChats`, `agent.openSession`,
  `agent.renameSession`, `agent.pinSession`, `agent.clearChats` (D124; `chatCommands.ts`). A chat
  from another folder: `agent.openChatFolder` opens that folder and the chat there,
  `agent.moveChatHere` ties it to the open folder.
  D230: under the search box, the agents row — the main agent's face, the user's agents, + (New
  agent); a click runs `agent.chatWith { agent }` (a new chat in the agent's chat mode,
  `custom:<name>`; agents are chat modes through `customModes.ts`'s `agentModes`). Faces
  (`ui/AgentFace.ts`) show working / waiting for you / failed; each chat row has its agent's face
  instead of a spinner (the chat's mode is saved in its meta), the chat header too, and chats
  waiting for the user come first under "Needs you".
- **Details panel** (`chatDetails.ts`, `view/details.ts`, `core/agent/chatDetails.ts` tested,
  `styles/agent-details.css`, D231, after Claude Code's desktop app): small cards on the right of
  the chat — Environment (this computer, folder → reveal, branch from `ide://git/status`, model →
  picker, the agent → edit, or the mode → menu), Context (used / window, a stacked bar, rows for
  messages, attachments, system prompt, rules and memory, skills, built-in tools, MCP tools per
  server, free; the split is estimated from sizes and scaled to the provider's count; the prompt's
  part sizes are recorded by `context.ts`; built-in tools fold to each tool, deferred tools are
  listed apart; "N until auto-compact" (`untilAutoCompact`) and Compact session, D409), Changes
  (+/−, files, Review / Keep all / Undo all, a Create PR button via `agent.createPullRequest`
  when GitHub is there),
  Background (worktree helpers with Stop / Review / Merge, subagents, commands with elapsed time
  and Stop, "N finished"), Plan. Beside the chat when the tab fits the column plus 280px
  (`agent.detailsPanel`: auto / always / never), else a sheet from the header's button (Esc or a
  click outside closes). `agent.toggleDetails { session?, show? }`; `agent.moveDetailsCard
  { card, before? }` (dragging a header's grip, D409); folded cards, their order and "hidden"
  are kept in the global state; `ide://agent/details`. The branch row runs `git.checkout`.
- **AI features menu** (`aiFeatures.ts`, D230): the status bar's sparkle lists the AI features
  outside the chat with on/off (`agent.aiFeatures { toggle }`, `ide://ai/features`), and "Choose
  models…" (Settings → AI in the editor). They left the Agents page.
- **Titles** (`core/agent/title.ts`, D124): the model names the chat in its first reply.
- **Harness** (D127): the verify step (`core/agent/verify.ts`, `projectCheck.ts`; a failed check
  goes back to the agent), observation masking before summaries (`core/agent/conversation.ts`),
  the explore subagent (`exploreTool.ts`, `session.subagent`; more subagents in D195 below).
- **Code blocks** (`codeBlocks.ts` + `core/agent/applyCode.ts`, D122): Apply (blocks whose fence
  names a file → `agent.applyCode`, a reviewable change) and Insert at the cursor.
- **Attachments** (D131): `uploads.ts` (+ menu's Upload from computer…, system drops, pasted
  files; `agent.attachFiles`, `agent.attachDropped`), `view/attachCards.ts` (cards), the model in
  `core/agent/attachments.ts` (up to 20 per message); sent messages keep `attachments`. A `.zip`
  becomes one text card: its path (to extract with a command), file list and text files
  (`core/agent/zip.ts`, platform `DecompressionStream`, D227). Sent
  cards and the image viewer offer Download… (`agent.saveAttachmentAs`, Rust save dialog) and Add to
  project…; the agent finds earlier attachments with the `chat_attachments` tool
  (`chatAttachmentsTool.ts`, D214).
- **UI**: `view/` (panel, items, composer; `turns.ts` + `work.ts`: each turn's work in one collapsed group, D104; `permissionCards.ts`: the permission and folder cards above the composer), `menus.ts` (mode, more, empty state), `view/modelPicker.ts` (the model picker: a rail of providers and agents with Favorites and Recent first, D227; `modelPicks.ts`, `agent.toggleFavoriteModel`, `agent.favoriteModels`, `agent.recentModels`), `view/brandMark.ts` (provider and agent logos).
- **Layout** (D159): notes between steps show in the conversation; the steps between two notes
  collapse into their own group (`layoutTurn`).
- **Chat feel** (D151): `work.ts` is the calm status line (shimmering words, no spinner, each
  phrase at least 1.1 s, rapid ones skipped, generic work shown as plain phrases, never
  "Thinking"); `steps.ts` renders the open group as a card of rows (`workRows` in `turns.ts`:
  notes, tool rows that open to output and the thinking behind them, the first step's headline,
  "Thought process" last). Code and output are never darker than the chat. The system prompt asks
  for a warm, brief, plain tone.
- **Changes card** (D154, `view/changes.ts`): a turn's files as one card ("Changed 10 files +412
  −8" / "3 files to review", Accept all / Reject all), rows per file when opened; applied counts
  from `changeset.appliedStat`. The plan reminder (`session.planNudge`) asks a busy model to
  update its plan after 6 calls without `update_plan`.
- **Messages while it works** (D151): `agent.send` during a turn queues the message
  (`session.queued`, shown with "Take back" = `agent.unqueue`); the loop takes queued messages
  before each model call (`LoopDeps.takeQueued`) and answers them before ending; leftovers are sent
  next, or go back to the box after Stop or an error. **Send now** (`agent.sendNow`, D363) cuts
  the step short (`LoopDeps.interrupt`: the request or the running commands are cancelled) so the
  next step reads them at once; an external agent's turn is cancelled and they go next.

**Commands:** mostly `commands.ts` and the files split from it (D221) — `agent.newSession`, `agent.send`
(`{message, session?, wait?}`), `agent.stop`, `agent.setMode`, `agent.acceptAll`, `agent.rejectAll`,
`agent.reviewChange`, `agent.review`, `agent.openAppliedDiff` (D119), `agent.restoreCheckpoint`, `agent.deleteSession`,
`agent.showHistory`, `agent.refreshModels`, `agent.selectModel`, `agent.addProvider`,
`agent.setApiKey`, `agent.respondPermission`, `agent.openLink`, `agent.retry`, `agent.editMessage`,
`agent.compact`, `agent.mention`, `agent.dream`, `agent.openMemory`, `agent.exportMarkdown`;
`agent.restoreToMessage` (`checkpointCommands.ts`) and `agent.listRules` (`rules.ts`), D200.

**Project prompts** (D111, D200): rules and slash commands, see "Rules, mentions, slash
commands and checkpoints" below.

**Message actions** (D79): answers get copy, retry (newest) and the model name; your messages get
copy and edit (resend replaces the conversation after it). The newest answer's actions stay
visible, older ones show on hover.

**Provider errors** (D84): transient failures retry by themselves (3 attempts, backoff) while
nothing has streamed yet; a final error shows a short message (details in its tooltip) with
`agent.retry` / `agent.continue`. **Attachments:** `agent.addContext` ("Add file/folder to chat")
puts files on the composer as chips; `agent.send` inlines them (20 000 characters each).
Accepted edits are workspace undo entries (D86).
**State:** `ide://agent` (providers, models, sessions), `ide://agent/session` (items, status,
pending changes, permissions), `ide://agent/usage` (this window's sessions),
`ide://agent/usage/history` and `ide://agent/usage/limits` (D201). **Persists:** transcripts and checkpoints in app data.
**Tests:** `permissions.test.ts`; `tests/scripts/agent.jsonc` drives a mock Ollama, a mock MCP
server and a mock ACP agent.

**AI setup (D164):** `catalog.ts` (provider presets, agent CLI install info; DOM-free, tested),
`setupCommands.ts` (`agent.showSetup`, `agent.connectProvider`, `agent.removeProvider`,
`agent.detectTools`, `agent.pullStarterModel`, `agent.installAgent`), `view/setup.ts` (the shared
panel: page and first-run card), `view/setupPage.ts` (the "AI models" tab, view type
`agent.setup`).

**More providers (D212):** `providerPresets.ts` (the ~20 presets: featured ones on the first rows,
the rest under "View more"; `aliases`, `hosts`, `editAddress` for Azure/Bedrock), `providerMatch.ts`
(DOM-free, tested: `matchPresets` for the "Other server" name box's suggestions, "groqai" → Groq;
`presetForUrl` gives a hand-added provider at a known host its logo), `providerImage.ts` (a custom
server's own image: PNG/SVG/JPEG/WebP ≤ 256 KB, checked by its bytes, kept as a data URL in the
global state's `providerImages`, never fetched from a URL). Commands: `agent.matchProviderPresets`,
`agent.chooseProviderImage`, `agent.setProviderImage`; state `ide://agent/providerPresets`.

**Repository map (D174):** `repoMap.ts` (`RepoMapService`, `registerRepoMap` / `repoMapFor`)
builds the map from the workspace index with symbols cached per file; `context.ts` puts it in a
new chat's system prompt, ranked toward the open editors (`core/agent/repoMap.ts`: per-language
symbol patterns, PageRank, rendering to a budget). Settings `agent.repoMap.enabled`,
`agent.repoMap.maxChars`; `agent.showRepoMap`, `ide://agent/repoMap`. Each AI feature's model:
`languageModel.ts` (`FEATURE_MODEL_SETTING`), `agent.selectFeatureModel`, the Agents page's "AI
features" branch, and dropdowns in the Settings editor (`modelChoices.ts`, D216).

**Display tools (D171, D172):** `displayTools.ts` gives the agent `show_links` and `ask_user`.
Their calls are drawn as cards in the conversation (`turns.ts` keeps them out of the work group;
`view/items.ts` → `view/displayCards.ts`, parsed by `core/agent/displayCards.ts`), and the
answer's text stays plain Markdown. `ask_user` waits on `session.question()`: a click runs
`agent.answer`, and a message typed meanwhile is the answer. Off with `agent.richBlocks: false`.
D312: `ask_user` takes `questions` (1–4: `question`, `header` chip, 2–4 `options` with
`label` / `description` / optional `preview`, `multiSelect`; the older single-question arguments
still read), parsed by `core/agent/askUser.ts` and drawn by `view/toolCards.ts` (header chips as
tabs, the focused option's preview beside or under the options, an "Other" field, keys 1–9 / ↑↓ /
←→, Submit); `agent.answer { answers }` answers by question, and the result is keyed by question.
D313: `report_findings` (`core/agent/findings.ts`) draws a review's findings: a row opens
file:line, **Fix** / **Fix all** run `agent.fixFindings` (Ask switches to Agent), a re-report
shows outcomes; the review prompt (`reviewPrompt`) asks for it. D314: `suggest_extension`
(`extensionSuggest.ts`, `core/agent/extensionSuggest.ts`) searches Open VSX and shows an install
card (icon, publisher, verified mark, Install via `agent.installSuggestedExtension`), its data in
the call's `detail`; once per conversation unless the user takes it up. Commands and the
`questions` / `findings` of `ide://agent/session`: `toolCardCommands.ts`.
D342 / D343 (`discoveryTools.ts`, cards in `view/discoveryCards.ts`, commands in
`discoveryCommands.ts`): `suggest_skill { keywords, reason }` ranks the skills the user could add
(`skillCatalog.ts`: the catalog in `catalogSkills/*.md`, not installed until added, and skills
turned off; `core/agent/skillSuggest.ts`) and shows up to three with **Add** / **Turn on**
(`agent.addSuggestedSkill` → `agent.addSkillFromCatalog`, also in the palette; `agent.skillCatalog`
lists them). `suggest_mcp_server { query, reason }` searches the gallery and the MCP registry
(`agent.mcp.registryUrl`, up to three name searches) and ranks them (`core/mcp/suggest.ts`): a
card per server with how it runs, what it needs, a field per input and **Add**
(`agent.addSuggestedMcpServer` → `agent.installMcpServer`, then `McpClients.presetInputs`; the
fields reach it through `stashCardValues`, not the command log). `mcp_status { name? }` lists the
servers from `ide://agent/mcp` as a card with **Reconnect** (`agent.reconnectMcpServer`). Both
suggestion tools keep D314's once-per-conversation rule (`oncePerConversation`).
D335: the ask card looks like Claude Code's AskUserQuestion: options as rows with a radio or a
checkbox, a last "Other" row to type in, and a footer with **Skip** and **Submit** (Ctrl+Enter
submits). Skip answers a one-question card at once, else skips the question on screen
(`SKIPPED`, `skipAll` in `core/agent/askUser.ts`; the model reads "The user skipped this
question"); `agent.answer { skip: true }` skips a whole card.
D334: inline widgets, like Claude Code's `show_widget` / `read_me`: `widgetTools.ts` gives
`show_widget` (`title`, `widget_code`, `loading_messages`; `<svg` first → SVG, else HTML) and
`widget_guide` (the design rules, a tool of its own so they aren't in every request), parsed by
`core/agent/widgets.ts`. `view/widgetCard.ts` draws the card: one element per chat view, so the
frame never reloads on a re-render; the frame is `src-tauri/notebook/output/widget.html` on the
notebook outputs' local origin, sandboxed (`allow-scripts` only) under a policy with no network,
themed with the IDE's tokens (refreshed on theme change), sized by its height messages (max
900px, then it scrolls). `sendPrompt(text)` posts to the chat, accepted only while the frame has
focus (a click in it) and rate-limited (1.5 s apart, 6 a minute, in the frame and in the
command). `widgets.ts`: the widget tab (`agent.widget`), `agent.openWidget`,
`agent.copyWidgetCode`, `agent.saveWidget` (.svg, or a whole .html page), `agent.sendFromWidget`
(the user's message, with a "From …" chip; joins a running turn), `ide://agent/widgets`, and in
dev builds `dev.clickInWidget` for UI tests.
D355: a widget is drawn while it's written. Rust sends show_widget's arguments so far with its
`toolProgress` events (`STREAMED_TOOLS`, at most every 150 ms, with the call's id); the loop keeps
them on the assistant's `toolDraft.args`. `core/agent/widgetStream.ts` (tested) reads the strings
out of the unfinished JSON and cuts the markup to what's whole (`drawableMarkup`: no scripts, no
half-written tag, attribute, comment or entity). `view.ts` puts the draft card
(`widgetDraftCard`) where the finished card will be; its frame gets `{ draft }` messages and
morphs the code in (widget.js: no scripts, no reload), the loading lines show until the first
paint. When the call is complete the tool's row adopts the same card and frame by call id
(`widgetCard` with `callId`): `{ render }` draws the finished code once, scripts included. The
chat column now removes nodes on their way out instead of moving the next one before them (a
moved frame reloads). State: `ide://agent/widgets` `drafts`, and per widget `streamed`, `paints`,
`loads`. Only providers that stream tool arguments (Anthropic, OpenAI-compatible) draw drafts;
Ollama sends whole calls.
Charts and diagrams are ```mermaid in the answer and math is `$…$`, drawn by the Markdown renderer
(`ui/markdown/visuals.ts`); one line of the system prompt says so.

## Output styles and the status line (D356, D357)
- `outputStyles.ts` + `core/agent/outputStyles.ts` (tested): Claude Code's output styles. Built-ins
  Default, Explanatory, Learning; the user's `<config>/output-styles/*.md` and
  `~/.claude/output-styles`, a trusted folder's `<workspace folder>/output-styles` and
  `.claude/output-styles` (front matter `name`, `description`, `keep-coding-instructions`).
  `agent.outputStyle` names it; `sessionTurn.ts` puts it into the frozen system prompt
  (`styledPrompt`: built-ins add to "How to talk"; a custom style replaces it, and without
  `keep-coding-instructions` "How to work" becomes the essentials), and the style's key is part of
  `frozenFor`, so a change rebuilds the prompt once. `agent.setOutputStyle` (picker), `/output-style
  [name]` (in `agent.send`), the details panel's Environment row, `ide://agent/outputStyles`.
- `statusLine.ts` + `core/agent/statusLine.ts` (tested): Claude Code's `statusLine`.
  `agent.statusLine` (user settings only) `{ command, padding }` runs through `execIpc` in the
  open folder (trusted only) with the active chat as JSON on stdin (`statusLineInput`: Claude
  Code's fields), at most every 300 ms (`Throttle`), when the chat's version, cost, model, usage,
  changes, the folder, trust or the style change. The first line (`statusLineText`: colors kept,
  other escapes dropped, 200 characters) shows in the status bar item `agent.statusLine` (left of
  the model's), drawn with the notebook's `ansiNodes` (the theme's terminal colors) through the
  status bar's new `nodes` hook. `ide://agent/statusLine`.

## Opened by the agent and settings (D179)
- `opened.ts`: tabs opened while an agent / ACP command ran, per chat; `agent.closeOpened`
  (Ctrl+Shift+Alt+W, ⋯ menu; also on Stop with `agent.closeOpenedOnStop`), `agent.listOpened`,
  `ide://agent` `opened`.
- `follow.ts` (D383): Follow the agent, `agent.followEdits` (off, a setting only). The changeset
  emits `agent.didEdit` (session, path, line, staged) for each edit, its own and an external
  agent's; the active chat's edits open in a preview tab at `firstChangedLine` (tested), focus
  kept, not while the user typed in an editor in the last 3 s, the last of a burst (150 ms).
- Settings are sectioned (`section` in extension.json). New settings, and where they act:

  | Setting | Where it acts |
  |---|---|
  | `textSize`, `codeBlockWordWrap` | view.ts |
  | `submitWithCtrlEnter` | composer.ts |
  | `whileWorking` | agent.send |
  | `webFetch.*` | webFetch.ts, permission handler |
  | `thirdPartyConfigs` | context.ts, slash commands |
  | `ideControl`, `browserProtection` | permission handler in index.ts |
  | `mcpProtection` | mcp.ts |
  | `deleteProtection` | run_command, `mayDeleteFiles` |
  | `formatOnFinish` | `session.formatChanged` |

  Others, by group: the turn (`thinking`, `contextLength`, `maxSteps`, `autoCompact`,
  `streamText`, `autoTitle`, `notifyWhenDone`), helpers (`explore`, `delegate`, `autoReview`),
  checks (`checkEdits`, `verify`, `verifyCommand`, `verifyTimeoutSeconds`, `reloadBrowser`),
  memory (`memory.enabled`, `memory.model`, `memory.suggestTidyUp`, `memory.autoTidyUp`), and
  `ollama.enabled`, `externalAgents`.

## Modes and voice (D180)
- `session.chatMode` is `agent`, `plan` or `ask`, set by `agent.setChatMode` and the composer's
  first pill (Shift+Tab). `tools()` filters to read-only tools for the turn's mode, plus
  `update_plan` in Plan. `MODE_RULES` go in the message's context. A plan turn ends with a
  notice whose Build action runs `agent.build`.
- Voice: `view/voice.ts` (`VoiceRecorder`: MediaRecorder plus the waveform canvas), the composer's
  own mic button (always last; Send to its left once there's something to send, D384),
  `dictation.ts` (D384: the route, `voiceRoute` in `core/agent/voice.ts`, tested: this
  computer's model first, then Groq / OpenAI / `agent.voice.provider`; the recording decoded to
  16 kHz in the page, `toSamples`; the setup dialog on the mic's first click; commands
  `agent.voice.setup`, `downloadModel`, `cancelDownload`, `removeModel`, `transcribeFile`; state
  `ide://agent/voice`), Rust `speech/` (Whisper on the CPU) and `ai_transcribe`
  (`ai/transcribe.rs`). Settings: `agent.voice.*`.

Agent ergonomics (D191):
- `core/agent/toolText.ts` shapes tool results: text as text, the beginning of documents with an `offset` to read on, "did you mean", ranked compact `find_commands`, and errors with a code and a hint.
- `usage.ts` provides `ide://agent/usage`. Cost (D199, `core/agent/prices.ts`, tested):
  `agent.prices`, else the provider's listing (OpenRouter `pricing`), else built-in list prices;
  the session adds it up per request (`session.cost`), shows it under each answer and beside the
  context meter, and `agent.budget.perChat` warns at 80 % and asks past 100 %.
- Usage history (D201): `usageLog.ts` writes one record per model request (`core/agent/usageLog.ts`,
  tested: `makeRecord`, `summarize`, `resetAt`) — the chat (`session.countUsage`), subagents
  (`subChat`, explore), summaries and the AI features (`languageModel.ts`, by purpose) — to the
  Rust log in app data (90 days / 20 MB); `agent.usage.keepHistory` (default on) stops it. The
  provider's own cost (OpenRouter `usage.cost`, the done event's `cost`) wins over prices.
  `usagePage.ts` is the Usage page (dock view `agent.usage`: today / 7 / 30 days, a bar per day,
  models, features, providers with their limits, top chats, this chat and its budget, clear);
  commands `agent.showUsage`, `agent.clearUsageHistory`, `agent.refreshUsageLimits`; state
  `ide://agent/usage/history` (`?days=`) and `ide://agent/usage/limits` (in `usage.ts`). Limits:
  the rate-limit headers Rust kept from each provider's last response and OpenRouter's key
  credits (`refreshLimits`). Entry points: the Chats view's nav under the search box (Agents,
  Settings, Usage), the chat's ⋯ menu, Settings → Agent (a row and a ↗ link). Styles:
  `src/styles/agent-usage.css`. Test: `tests/scripts/agent-m7-2-usage.jsonc`.
- `context.ts` has the small-model prompt (`agent.smallModelProfile`).
- `memory.ts` has the user-level memory (`remember { scope: "user" }`).

## Agent CLIs: detection and sign-in (D192)
- Presets: `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`,
  `gemini --acp`.
- Detection re-runs on the AI models page, on window focus (if something was missing) and after
  `agent.installAgent`; on Windows it reads the registry PATH too (`exec::fresh_windows_path`).
- An "Authentication required" error shows a Sign in card: `agent.signInAgent` runs the CLI's
  login in a terminal, then Retry. An installed agent's row has ⋯ with Sign in and Sign out
  (`agent.signOutAgent`, `catalog.ts` AGENT_SETUP `signOut`; Gemini CLI has none) (D401).
- An agent started through npx / uvx (`core/acp/display.ts` `packageRunner`) waits up to 10
  minutes for `initialize` (a new version downloads first) and says it's still starting after
  15 s (D401).

## External agents' models, MCP, worktrees, reviews (D193)
- `acp.ts`: an external agent's model and reasoning level come from ACP's session config
  options (or the older `models` list); `session.agentSettings` holds them, the model picker lists
  them (`view/modelPicker.ts`, the reasoning level is the composer's effort pill), `agent.setAgentModel` sets one, `agent.externalAgentChoices` remembers it.
  `acpAgents.ts` (split from `acp.ts`, D245): the agents it knows (`ACP_PRESETS`, extensions',
  registry-installed, `agent.externalAgents`: `externalAgents()`) and their command lines
  (`helpChoices`, `shellArg`, `helpCommandLine`).
- `mcp.ts`: servers from `agent.mcpServers`, the user's `mcp.json`, the folder's mcp.json files
  (trusted folders, approved once), other tools' configs (`agent.mcp.discovery`) and extensions
  (`core/mcp/config.ts` merges them). Password inputs live in Rust's secret store; remote
  servers go through `mcp_remote_post`. `agent.mcpServers`, `agent.addMcpServer`, `ide://agent/mcp`.
  `mcpConfigFiles.ts` (split from `mcp.ts`, D245): which mcp.json to add to (`folderMcpFile`),
  `writeServerEntry` / `removeServerEntry` (comments kept), `userMcpPath`, and the servers and
  tools turned off (`disabledServers`, `disabledTools`).
- `worktreeAgents.ts`: `agent.startInWorktree` (a branch, a folder, a window whose chat starts on
  the task via `agentHandoffs` in the global state), `agent.worktrees`, `agent.reviewChanges`.
- `memory.ts`: `agent.memory.autoTidyUp` runs the tidy-up in the background (`agent.dream` with
  `background`).
- D194: the model picker's agent tabs use the agent's settings from its last start
  (`cachedSettings`); agents with `modelFlag` (Copilot) get a launch-time Model setting from
  their `--help`.
- D227: each turn starts by putting the agent in the ACP session mode that matches the IDE's
  permission settings (`core/acp/modes.ts`): with Review edits or Ask before commands, Claude
  Code's `default` and Codex's `read-only` (they ask before writing); Auto-apply with commands
  automatic, `acceptEdits` / `auto`; full access, `bypassPermissions` / `full-access`.

## Customize (D205)

`customize.ts`: one dock tab (`agent.customize`, singleton, state `{ section }`) for the agent's
set-up pages, like Cursor's Customize: a search box and chips over the section's page. Sections
are added with `addCustomizeSection({ id, label, icon, detail, keywords, order, page })` (`page`
is the old DockViewDescriptor's `create`); they are no longer dock view types of their own.
Sections: models (`view/setupPage.ts`), agents (`agentConfig.ts`), rules (`rulesPage.ts`),
autoApprove (`autoApprove.ts`), mcp (`mcpPage.ts`), docs (`docsPage.ts`). Every way in
(`agent.showSetup`, `agent.showAgentConfig`, `agent.showRules`, `agent.showAutoApprove`,
`agent.showMcpPage`, `agent.showDocs`, `agent.customize { section }`) calls `openCustomize`.
Usage stays a tab of its own.

## Skills (D206)

- `builtinSkills/` (D255): skills that come with the IDE, read after every folder's (one of the
  same name in a skills folder replaces it; the Skills page's Customize copies it there):
  `build-extension.md`, how the agent builds an extension of the IDE (the workflow, VS Code's API
  mapped to `ide`, the checks before it says it works); the system prompt points at it
  (`context.ts`).
- `participants.ts` (D255): a message that starts with an extension's chat participant's `@name`
  goes to it instead of the model (`sendNow`); the user's agents and the chat's own mentions keep
  their names.
- `skills.ts` (+ `core/agent/skills.ts`, tested): `SkillsService` (`skillsFor(services)`) finds
  `<name>/SKILL.md` folders, one level deep, in the user's folders (`~/<dataFolderName>/skills`,
  then `~/.claude/skills`, `~/.cursor/skills`, `~/.agents/skills`) and the open folder's
  (`<workspace folder>/skills`, `.claude/skills`, `.cursor/skills`, `.agents/skills`; other
  tools' only with `agent.thirdPartyConfigs`); a workspace skill overrides a user one of the same
  name. Cached until a file event under a `skills` folder, a command below, the page opening,
  window focus, or 30 s. `context.ts` puts `promptSection()` (name, description, path of the
  skills the agent may pick) in a new chat's prompt.
- The **use_skill** tool `{ name, file? }` (added to `sessions.extraTools` by `registerSkills`):
  SKILL.md's body and the folder's files, or one of them (kept inside the folder; a workspace
  skill's files keep to `.aiignore` and auto-approve for reads). Refuses skills turned off
  (`agent.skills.disabled`, names, user scope) and `disable-model-invocation` ones.
- `/name args` runs a skill through a slash source (`composerExtras.ts`), so the / picker lists
  them; a command file of the same name comes first.
- `skillsPage.ts`: Customize → Skills (order 35): User / Workspace groups with + New, rows with the
  zap icon (the MCP page's `.mcp-row` styles, `src/styles/agent-skills.css`), Not loaded for
  invalid files. Commands: `agent.listSkills`, `agent.showSkills`, `agent.newSkill`,
  `agent.setSkillEnabled`, `agent.deleteSkill`, `agent.skillActions` (a row's ⋯), `agent.openSkill` (a row's click; a built-in one read-only). State:
  `ide://agent/skills`. Rust: `src-tauri/src/ipc/skills.rs` lets the fs commands read the user
  skills folders and write the IDE's own; `skills_delete_user` (`skillsIpc`) deletes one there.
  Test: `tests/scripts/skills-m7-5.jsonc`.
- **D221.** The user skills folders are watched (`skillsIpc.watch` / `setWatched`, Rust's
  recursive `skills_watcher`), so the list holds until a change (30 s only without a watcher);
  the open folder's skills folders keep to file events (a watch handle would keep them "in use"
  on Windows). Skills with `paths` and nested `<folder>/.claude/skills` aren't in the prompt:
  `SkillsService.noteFor` (through `sessions.fileNote`) offers them with the first read / edit /
  write result of a file they cover, once per chat (`session.toldSkills`, saved). A user's own
  skill pre-approves its `allowed-tools` for its /name turn or the rest of the turn use_skill
  loaded it in (`ToolHost.preApprove`, `session.preApproveForTurn`); a project's only shows them.
  `context: fork` (+ `agent`, `model`) runs one in a subagent (`runForked`); `model` / `effort`
  hold for its /name turn (`nextTurnModel`, `nextTurnEffort`). Skills used before a summary are
  named in it (`skillsUsedIn`). Test: `tests/scripts/agent-skills-m7-7.jsonc`.
- **Patterns on other tools (D221, `core/agent/toolRules.ts`):** `Read(…)`, `Edit(…)`,
  `Write(…)` path patterns (gitignore rules, `/` anchored, `//` absolute, `~/` home) and
  `WebFetch` / `WebFetch(domain:…)` in commands' and skills' `allowed-tools` (pre-approval,
  `preApprovedCall`; web.fetch through `session.preApproves` in the IDE-command handler) and
  `disallowed-tools` (`callDisallowed` refuses those calls). D229: `Read(…)` also covers search
  and find_files, as Claude Code's covers Grep and Glob: a search limited to a refused folder is
  refused, and `withoutRefusedResults` (sessionTurn.ts) leaves refused files out of their results.
  `WebSearch(…)` is the whole web_search tool (Claude Code has no pattern for it). A skill loaded
  with use_skill sets its `effort` for the rest of the turn (`ToolHost.setTurnEffort`; the request
  options are read per request). A nested skill whose name is taken is `folder:name`
  (`apps/web:deploy`, `withNestedSkills`; `/apps/web:deploy` parses), as Claude Code names them.
- **Approvals and state (D221):** get_state asks before showing the selection in a file
  auto-approve protects (`stateSelection.ts`); write_file's freshness check keeps fingerprints
  in the saved chat (`Changeset.seenJSON`, `textFingerprint`); a save over another window's
  newer save of the same chat is refused (`agent_session_save` with `expect`,
  `agent_session_version`) and the chat asks which to keep (`agent.resolveChatConflict`,
  `session.conflict`, `savedElsewhere` in `ide://agent/session`).

## Model roles, subagents and the Agents page (D195)
- `session.ts`: a turn runs on the answering agent's model (D288 removed `agent.planModel` and
  `agent.buildModel`: Plato's model plans, the main agent's builds). `subagent()` runs a subagent on its own model (`subModel`, `subChat`);
  `startBackground` runs one alongside the chat and `deliverReport` brings its report back
  (into the running turn, or a new one). `autoReview` starts the reviewer after a turn that
  changed files (`agent.autoReview`, via `sessions.reviewSpec`).
- `subagents.ts`: `SubagentRegistry` reads the agent files (`<IDE folder>/agents`,
  `.claude/agents`, the user's agents folder) over the built-ins (`core/agent/subagents.ts`), the
  `delegate` tool, `agent.setSubagent`, `agent.deleteSubagent`, `agent.stopSubagents`,
  `ide://agent/subagents`. Choices per subagent live in `agent.subagents`.
- `agentConfig.ts`: the Agents page (`agent.showAgentConfig`, Customize → Agents) and
  `agent.chooseModel` (main, mode:plan|build, subagent:<name>, feature:<x>, external:<agent>).
  Since D287 it's one grid of cards: the main agent (Main: its one model; opens its editor), your
  agents (click: the editor; switch; model; source badge Project / You / Claude Code; "…" and
  right-click: Chat with it, Edit, Duplicate, Open file, Delete), Explore and Review (Built in:
  a switch and a model; Duplicate), a dashed "New agent" card (templates under it while there are
  none), the delegate switch, then the external agents. The AI features
  are no longer on it (Settings and the status bar). Styles: `src/styles/agent-config.css`.

## Agents with faces: the agent editor (D230)
- `agentEditor.ts`: the dock view `agent.agentEditor`, one tab per agent (state `{ name }`), a
  draft (`{ draft, template?, scope?, from? }`, not restored after a restart) until Create agent.
  A centered column: templates (draft), the face picker (`facePicker.ts`: Model icon / Character, D270; big face + Shuffle,
  12 candidate faces with "show others", 8 colors; radio groups with one tab stop each), Name
  (the label; the id comes from it once and never changes), Role, What does it do?, Instructions
  (auto-grow, character count), Model (`agent.chooseModel {for: subagent:<name>}`; a draft's is
  kept until create), Access (Read only / Can edit files / Full; Advanced: tools, max steps),
  Where it lives (draft: Every project, the default since D233 / This project; then the path, Open file, Reveal) and a sticky
  footer (draft: Create agent; agent: on/off, "Saved", Delete, Duplicate, Chat with it). Each
  field writes the file 400 ms after the last change (`setHeaderFields` / `setBody`, unknown keys
  kept); the file read again on disk reloads the form; a deleted file closes the tab. Keys:
  Enter in a one-line field creates (draft) or saves now; Esc leaves a field, and on an empty
  draft closes it.
- `agentEditorCommands.ts`: `agent.newAgent {template?, scope?}` (a draft tab),
  `agent.createAgent {label, description, role?, instructions?, icon?, access?, tools?,
  maxSteps?, model?, scope?, name?}` (writes the file; what Create agent runs),
  `agent.editAgent {name?}`, `agent.duplicateAgent {name}` (a draft copy, built-ins too),
  `agent.newSubagent` (kept: with `name` it creates at once, else the editor) and
  `ide://agent/agents` (name, label, role, face code, description, model, access, source
  project | user | claude-code | builtin, path, enabled). Chat with it runs `agent.chatWith`.
- Model icons (D270): `icon: model` (or none) shows the logo of the model the agent uses, drawn
  by `ui/AgentFace.ts` through the resolver `index.ts` sets (`setModelFaceResolver`) and redrawn
  in place when the models change (`refreshModelFaces`); the default for new agents and the team.
- DOM-free (`core/agent/agentTemplates.ts`, tested): access levels ↔ header fields
  (`accessOf`, `accessFields`, `accessFile`, `EDIT_TOOLS`), the templates (Builder, D233; Code reviewer, Test
  writer, Docs writer, Refactorer, Debugger, Researcher, Blank) and `faceChoices`.
- Styles: `src/styles/agent-editor.css`.

## Helpers in their own git worktree (D231)
- `isolatedHelpers.ts` (+ `core/agent/isolatedHelpers.ts`, tested): `delegate` with
  `isolated: true`, or to an agent whose file says `isolation: worktree` (read by
  `parseSubagentFile`; `isolated: false` overrides it), asks once ("Start a helper in a
  worktree"; full access answers) and starts a worktree agent for that agent through
  `WorktreeRegistry.starter` (`worktreeAgents.ts`' `startOne`): branch
  `agent/<agent>-<task words>`, the setup step, a window of its own. The handoff carries the
  agent's mode (`custom:<name>`), label, instructions and the parent chat (`helper`); the window
  starts its chat in that mode (or, when the mode isn't there — a file not committed, a folder not
  trusted — puts the instructions in the first message, `helperTask`). The tool returns at once.
- Refused (a tool error the model can act on, `isolationRefusal`): a chat that can't change files
  (Ask / Plan, read-only agents), a folder that isn't a git repository, a read-only agent, more
  than `agent.isolatedHelpers.max` (default 3) at work. A window that doesn't open (test runs)
  removes the worktree and branch again.
- Progress: every 3 s while any works, the worktree registry's reading of the helper's saved chat
  (`helperOutcome`: starting, working, waiting — for the user in its window, with a notification
  to open it —, stopping, done, error, stopped). A notice line in the parent chat follows it. When
  it ends, its last reply comes back to the parent chat as a message (`helperReport`, like a
  background subagent's report: into the running turn or a turn of its own) and a notification
  offers Review changes (`agent.compareWorktrees`) and Merge (`agent.applyWorktree`, asks first).
  A parent chat not open in this window: the report is kept (`undelivered`, saved) and delivered
  when that chat opens here (the notification has Open its chat); dropped if the chat was deleted
  (D232).
- Limits (D232): the helper gets the delegating chat's tools intersected with its agent's (plus
  `update_plan` / `ask_user`), carried in the handoff as `tools`; its window's chat keeps them as
  `session.toolLimit` (saved), whatever mode it ends up in. An agent whose tools only read is
  refused. Stop while it starts (after the question, after setup) and any failure after the
  worktree exists remove the fresh worktree, branch and record.
- Stop: windows share only files, so `agent.stopHelper {helper}` leaves a request in the global
  state (`agentStops`, ten-minute TTL); the helper's window (`watchForStop`, while its turn runs)
  reads it every 3 s and runs `agent.stop`. A closed helper window counts as stopped. Helpers are
  not in `session.background`: the parent chat's own Stop doesn't stop them.
- Commands: `agent.helpers {helper?, action?: open|review|merge|stop}`, `agent.stopHelper`;
  `agent.startInWorktree` takes `agent` (one of the user's agents: its chat mode). State
  `ide://agent/helpers` (`helpers`: id, parent, agent, label, role, icon, branch, folder, task,
  state, files / added / removed, elapsedMs; `max`), saved with the workspace
  (`agent.isolatedHelpers`) and followed again after a restart. UI script:
  `tests/scripts/isolated-m7-10.jsonc` (the window mode: decisions and refusals; no windows in
  test runs).

### Helpers without a window (D246: headless, the default)
- `agent.isolatedHelpers.window` (default false; `helpersInWindows`) picks the mode when a helper
  starts; the window mode above stays as it was. Headless: `startOne` (`WorktreeStart.headless`)
  makes the branch, worktree, record (`WorktreeAgent.headless`) and setup, and skips the handoff
  and window; `IsolatedHelpers.startHere` lets the worktree in as an extra Rust root
  (`fsIpc.allowRoot`), ties the chat's tools to it (`toolRoots.ts` `setToolRoot`, with the
  worktree's PORT / WORKTREE_*), and makes the chat here (`sessions.get(id)`: `folder` the
  worktree, so it isn't one of this folder's chats and shows "Started in …"; the model,
  `toolLimit`, auto-apply, the agent's mode or its instructions) and sends `headlessHelperTask`
  (helperTask plus where it is and what's refused). A start that fails removes the worktree,
  branch and record. The tool result names the helper id (its chat id).
- **Tools on the worktree** (`toolRoots.ts`, keyed by the chat's id so explore and subagents in
  it follow): `tools.ts` `root(host)` / `resolve` (`helperPath`: a path in the main folder — the
  frozen prompt names that one — lands on the same place in the worktree; anything else is
  refused), `ignored` / `writeRefusal` (the agent's exclusions by worktree-relative path),
  run_command's cwd and env (and `processTools.ts` / `backgroundProcesses.ts` for background
  ones), find_files (`indexIpc.query` with `root`: Rust walks the worktree) and search
  (`searchIn`: `searchIpc.start` with `root`, detached). `call_command` refuses commands that act
  on the window's folder (`actsOnWindowFolder`: git, editor, fs, terminal, search…). The
  changeset's accepted edits in the worktree stay out of the window's undo history.
  (`extensionFiles.ts`: read_file / list_dir on an installed extension's folder, D176, split from
  `tools.ts` to keep it under ~1200 lines.)
- **Rust scope** (`fs::Workspace`): `allow_root` takes only a linked worktree of the open
  folder's repository (its `.git` file's `commondir` leads to the same git folder);
  `resolve` / `resolve_entry` / `root_of` cover the extra roots (reads, writes, listings, deletes
  — never the root itself —, run_command's cwd); `scope_root` for `search_start` / `index_query`
  with `root`. Commands `workspace_allow_root`, `workspace_forget_root`. A folder change clears
  them. The root is let in when the helper starts and forgotten when it ends; a tool gate
  (`registerIsolatedHelpers`) lets it in again for a later turn in its chat (a follow-up, after a
  restart). `exec_run` passes PORT / WORKTREE_* on (besides CLAUDE_*).
- **Progress** (`headlessState`, `headlessProgress`): from the chat here (running → working,
  waiting, idle → done / error / stopped by its "Stopped" notice); a chat not here any more (the
  window restarted) is read from its saved form (busy there → stopped). The worktree registry's
  overview counts the chat being here as its window (`chatHere`). Waiting: a notification with
  Open its chat (`agent.openThread`). The report, Review changes / Merge, the limit and the tool
  limit are as in the window mode; the final counts are read fresh from git.
- **Stop:** `agent.stopHelper` stops its chat here at once. **Follow-ups:** `sendToHelper(helpers,
  helperId, text)` (`helpers.send`): a headless helper gets the message at its next step
  (`session.enqueue`, "queued") or as a new turn when idle ("sent"); a window helper's window
  reads `agentHelperMessages` in the global state (`watchForStop`'s tick, half-hour TTL) and
  sends it to its chat ("queued"). "unknown": no such helper, finished or stopping.
- A helper can't start helpers (`isolationRefusal` `nested`). `agent.helpers` `open` and the
  worktree overview's Open show a headless helper's chat here (a window would be a second writer
  of it); deleting its worktree stops it.
- Left: its chat's diff / checkpoint restore after it ended need the root again (only a tool call
  lets it back in); rules, memory, skills and the code index stay the window's (design note 4);
  a window helper's message sent as its turn ends waits for the TTL. UI script:
  `tests/scripts/helpers-headless-m7-16.jsonc`.

## Group chats and handoffs (D231)
- `groupChat.ts` (+ `core/agent/groupChat.ts`, tested): a group chat is an ordinary session with
  `session.members` (2–6 agent names, `agent` for the main agent; saved in the meta). Each turn
  is one member's: `sendNow` asks `groupTurn` who answers and runs the turn in that member's mode
  (`memberMode`: its instructions, tools and model, as in a chat with it alone); the message
  carries `roomBrief` (who's in the room, how to hand over, its own instructions; tagged
  `<group_chat>` so a resend replaces it) instead of the mode rules. Routing: the first member
  the message @mentions answers, the others it mentions after, in order (`routeMessage`); no
  mention → the agent that spoke last. Mentioning an agent not in the group brings it in.
- Agents answering each other: a reply that opens a line with `@Name` (or has `→ @Name`) hands
  the next turn to that member (`handoffMentions`); `continueGroup` runs it as a turn of its own
  after a hidden harness message (`auto: "group"`, `handoffNote`, not shown: `turns.ts` starts a new
  layout turn there). Agent-to-agent turns per user message: `agent.groupChat.maxAutoTurns`
  (default 4; 0 = only the agents you mention), then "Paused after N replies…" (`nextInChain`).
  Stop, an error, your queued message or a background report ends the round
  (`session.groupChain`).
- D232: a message sent while a member answers waits (it isn't a steer in a group chat) and starts
  its own round; a member whose agent file is gone isn't routed to (`answering`, a line says who
  answers instead); other members' earlier replies go to the model as `[Label] …` (LoopDeps
  `speakerLabels` → `toMessages`); an external agent (ACP) as the chat's model answers as the member
  whose turn it is (`sendNow`'s external branch, the hand-off note sent as its message:
  `sendExternal` `existing`). Handoff buttons for agents that aren't there are hidden.
- Speakers: every reply records `speaker` (the member, or the agent a chat is with); a group chat
  shows the face (18 px) and name above a reply when the speaker changes (`speakerHeader`, one pass
  per change of the chat), a chat with one agent only after a handoff. The chat header, the Chats
  row and the composer's members pill show the members' stacked faces (`groupFaces`).
- Composer (`view/memberMentions.ts`): "@" in a group chat lists the members (↑/↓, Enter or Tab
  completes `@Label `, Esc closes; "Files and context…" opens the usual @ picker); the members pill
  mentions one or opens "Agents in this chat…"; the mode pill and Shift+Tab are off (each agent has
  its own mode). The effort and access pills read "Effort" and "Access" (D273,
  `showMembersEffort` / `showMembersAccess` in `menus.ts`): each agent's own, kept in
  `agent.subagents` (`effort`, `access`) through `agent.setSubagent`; the main agent's are the
  chat's.
- Mentions in messages (D274, `view/mentionMarks.ts`): your messages and replies color each
  `@agent` and `@channel` / `@everyone` / `@all` (`mentionRanges`), not in code or links; an
  agent's mention has a hover with its name, role and description. Who can be named is
  `mentionTargets(session)` (D275): the known agents plus the chat's members, any case.
- Handoffs (VS Code's custom agents): `handoffs:` in an agent file (or a `.github/agents/*.agent.md`)
  — `{label, agent, prompt?, send?}` — parsed into `SubagentDef.handoffs` / `CustomMode.handoffs`,
  shown as buttons under that agent's latest reply; the reply's actions also have "Hand to another
  agent…". `agent.handoff {session?, to?, prompt?, send?}` switches the chat's mode (a notice says
  so) and puts the prompt in the box or sends it; in a group chat the agent answers next (it joins
  if it isn't in it).
- Commands: `agent.newGroupChat {members?, title?}` (the Chats nav's New group chat, the agents
  row's "Start a group chat with…"; picks when fewer than 2), `agent.setGroupMembers {session?,
  members?}` (`[]` ends the group), `agent.handoff`. State: `ide://agent` sessions' `members` and
  `speaker`, `ide://agent/session`'s `members` and each reply's `speaker`. Styles:
  `src/styles/agent-group.css`. UI script: `tests/scripts/group-m7-10.jsonc`.

## The main agent (D196)
- Presets (D196: named snapshots of every model) were removed in D287.
- The main agent can be an external agent: `agent.selectModel` with `acp/<agent>` also sets
  `agent.model`, and new chats start with it (`sessions.ts`). The Agents page shows the chat in
  use (its model, or the external agent with its own model).
- Attachments: "Add to project" on a card (`agent.addAttachmentToProject`, `uploads.ts`) writes the
  upload into the folder; the image viewer (`view/shots.ts`) opens beside the chat it was opened
  from when there's room (Slack's way), else over the window.

## Rules, mentions, slash commands and checkpoints (D200)
- **Restore checkpoint** (`checkpointCommands.ts`, `session.rewind`): each of your messages has a
  Restore button (`agent.restoreToMessage { item?, files? }`, default your latest message): the
  chat goes back to before it (the text returns to the box) and, unless `files: false`, the files
  the agent changed since are put back from the checkpoints. `restoreFiles` (`sessionRewind.ts`) is shared with
  `agent.restoreCheckpoint`; `changeset.afterRestore` drops what was put back from the review.
  Editing or retrying a message whose turn changed files asks first (`askUndoFiles`: Undo and
  send / Keep changes / Cancel); `agent.editMessage` and `agent.retry` take `files: "undo" |
  "keep"`. Steered messages share their turn's checkpoint.
- **Rules** (`rules.ts` + `core/agent/rules.ts`, tested): every rules file, not the first found —
  root `AGENTS.md`, `CLAUDE.md` (with `@path` imports, 5 deep), `CLAUDE.local.md`,
  `.github/copilot-instructions.md`, `.cursorrules`, `.cursor/rules/*.mdc` (`alwaysApply`,
  `globs`, `description`), `.github/instructions/*.instructions.md` (`applyTo`), subfolders'
  `AGENTS.md` / `CLAUDE.md` (from the index), and the user's own `<config>/AGENTS.md` and
  `~/.claude/CLAUDE.md`. Other tools' files only with `agent.thirdPartyConfigs`. Always-on rules
  go in a new chat's prompt (duplicates once, 24 000 characters); folder and glob rules are
  listed there and attached to the result of the first read_file / edit_file / write_file of a
  file they cover (`session.withRules`, once per chat: `session.attachedRules`, saved, cleared by a
  summary or a cut). `agent.listRules` (the ⋯ menu's Rules…) and `ide://agent/rules` say which
  are active and why. Nested folders of rules (D203): a subfolder's own `.cursor/rules`
  (`web/.cursor/rules/x.mdc`) holds for files under that subfolder only (`alwaysApply` becomes a
  folder rule; its globs match relative to the subfolder, or from the root; a description rule is
  listed "for files in web/"), and subfolders inside `.cursor/rules` and `.github/instructions`
  are read too. They come from the index (`nestedRuleFiles`: gitignored folders are skipped,
  shallowest first, 60 at most), leave out what the agent's ignore rules hide (`.aiignore`), and
  share the rules cache.
- **@-mentions** (`mentions.ts` + `core/agent/mentions.ts`, tested): `@git` (uncommitted diff and
  new files), `@commit <hash>`, `@branch` (against origin/main, origin/master, main or master),
  `@chat <id>` (another chat's transcript, start and end within 24 000 characters), `@rules` and
  `@symbol <path>:<line> <name>` (the definition's code; names from the repository map,
  `RepoMapService.symbols`, also offered in the @ picker as you type). The + menu has them.
- **Slash commands** (`slashCommands.ts` + `core/agent/slash.ts`, tested): built-ins include `/compact`,
  `/clear` (a new chat in place of this one), `/model [name]`, `/review [focus]`
  (`agent.reviewChanges` on the uncommitted changes with this chat's model) and `/init` (the agent
  writes AGENTS.md as a change under review); D389 added Claude Code's, below. Prompt files from `<IDE folder>/commands`,
  `.claude/commands`, `.cursor/commands`, `<config>/commands` and `~/.claude/commands` (Rust lets
  the frontend read those two, `ipc/settings.rs`); front matter `description`, `argument-hint`,
  `model` (that message's model), `allowed-tools` (`Bash(prefix:*)` pre-approves shell lines);
  `$ARGUMENTS`, `$1`…`$9`, `!`command`` (run in the folder after approval as run_command decides,
  the card from `session.askBeforeSend`; output in place) and `@file` (its text added).
  Subfolders (D203): `.claude/commands/frontend/test.md` is `/frontend:test` (Claude Code's
  naming; 3 levels, 200 files per folder; `commandNameFor` / `commandFileFor`). `allowed-tools`
  (commas or spaces) narrows that command's turn (`session.nextTurnTools` → `turnAllowedTools`,
  `commandTools`): only the tools it names (Claude Code's names map to ours: `Bash(…)` →
  run_command and its process tools, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `Task`, `WebSearch`,
  `TodoWrite`; our own names and `mcp__server[__tool]` as they are) plus every read-only tool; the
  next message has all of them again. Claude Code itself uses the list to pre-approve, not to
  narrow; here a project's command can't pre-approve, so narrowing is the safe reading. D207: in
  the user's own command files (`<config>/commands`, `~/.claude/commands`) `allowed-tools` also
  pre-approves those tools for the turn (`TurnTools.preApproved`, `preApprovedCall`,
  `session.askForCall`: `Bash(prefix:*)` lines, whole tools by name, `mcp__server`), as full
  access would — Ask patterns, delete and MCP protection, destructive calls and the denylist still
  ask. `disallowed-tools` (or `disallowedTools`) takes whole tools away for the turn (read-only
  ones too) and refuses matching `Bash(…)` lines (`lineDisallowed`: run_command and `!` lines).
- **Built-ins after Claude Code's, and the inline lists** (D389): `BUILTIN_COMMANDS` holds every
  built-in with its other names (`aliases`: `/new` and `/reset` are `/clear`, `/cost` `/usage`,
  `/subagents` `/agents`, `/settings` `/config`…); `canonicalSlash` turns one into its command
  before `agent.send` reads it. `slashBuiltins.ts` registers the ones that act on the chat
  (`sessionSlash`, run by `agent.send` after `actionSlash`): `/undo` (the newest checkpoint),
  `/rewind`, `/fork`, `/resume`, `/rename`, `/export`, `/copy`, `/context` (a note: tokens,
  messages, tool calls), `/usage`, `/effort`, `/plan`, `/todos`, `/tasks`, `/security-review`,
  the pages (`/memory`, `/agents`, `/skills`, `/rules`, `/mcp`, `/hooks`, `/permissions`,
  `/config`), `/add-dir`, `/help`, `/release-notes`, `/bug`; and `/btw` (`btw.ts`): a side
  question answered by the chat's model from the end of the transcript (24 000 characters), no
  tools, streamed into a notice with `aside` (`renderAside`, closed by `agent.dismissNotice`):
  notices never reach the model. `view/slashList.ts` is the "/" list over the composer (as wide
  as the box, `.agent-suggest-list`), ranked by `rankSlashCommands` (name prefix, other name,
  contains, description words' starts); keys are taken in the capture phase, before the
  composer's own. The "@" list (`view/memberMentions.ts`) opens in every chat and offers
  `agent.mentionItems` (files, context mentions, web addresses, symbols: what the @ picker
  loads) besides the agents; "Browse files and context…" opens the picker.
## MCP prompts, resources and elicitation; ACP resume; web search (D200)
- `composerExtras.ts`: slash-command and @-mention sources other files register
  (`registerSlashSource`, `registerMentionSource`); `commands.ts` asks them in `agent.slash`,
  `agent.send` (`expandExtraSlash`), `agent.mention`, `mentionLabel` / `mentionContext`, and the
  composer's cards (`extraMentionCard`).
- `mcpFeatures.ts`: MCP prompts as `/mcp__<server>__<prompt> args` (`core/mcp/prompts.ts` parses
  the arguments; a missing required one is asked), resources as `@mcp <server> <uri>`,
  `agent.mcpResources` (agent-discoverable; asks under `agent.mcpProtection`), `agent.mcpPrompts`,
  and elicitation in quick inputs (`core/mcp/elicitation.ts`: Answer… / Decline, Esc cancels; one
  at a time). `mcp.ts` gives each client the handler (`clients.elicit`), counts prompts and
  resources in the status, and passes remote servers' early messages through.
- `acp.ts`: `session/load` after a restart when the agent advertises `loadSession` (the session
  id is saved with the chat as `acpResume`; the replay isn't shown again); otherwise the first
  message after a restart carries a recap. `available_commands_update` → the agent's own
  commands in the slash list (`registerAgentSlashCommands`), sent to it as typed.
- `webSearch.ts` (+ `core/agent/webSearch.ts`, Rust `ai/search.rs`): `web.search`, the
  `web_search` tool (left out with `agent.webFetch.enabled` off; answers how to set up when
  `agent.webSearch.provider` is off), `agent.setupWebSearch` (keys in the secrets file as
  `websearch.<provider>`, asked in a hidden box), `@web search <words>`. Settings:
  `agent.webSearch.provider` (off, brave, tavily, exa, searxng), `agent.webSearch.searxngUrl`,
  `agent.webSearch.maxResults`; `agent.webFetch.autoApprove` covers searches too.
- Test: `tests/scripts/agent-m7-1-mcp.jsonc`.

## Deferred tools, web search options, questions about pages (D319-D321)
- **Deferred tools** (`deferredTools.ts` + `core/agent/toolSearch.ts`, tested; Claude Code's
  ToolSearch): `agent.deferTools` (auto: more than 30 MCP tools or ~25 000 characters of their
  definitions; always; never; D204's `agent.mcp.toolSchemas` is read when it's left on auto).
  `session.splitTools()` splits a turn's tools: MCP tools not loaded are named in a note after the
  system prompt (`LoopDeps.system`), and `tool_search { query, max_results }` (`select:a,b`,
  keywords, `+word` required in the name) returns their definitions. What a chat loaded is read
  from its done tool_search items (`loadedToolNames`): kept across turns, summaries and restarts,
  undone by a rewind. The turn's tool list (`sessionTurn.ts`) grows by the loaded tools at its end
  (`withLoadedTools`; the loop reads `deps.tools()` each step); a call of a deferred tool not loaded
  gets `notLoadedMessage` (`deps.deferredTools` lets text-protocol models' calls of one through).
  `session.callableTools()` (deferred ones too) is what `runTool` and subagents' named tools use;
  a subagent's list never has tool_search. `ide://agent/session` has `deferredTools` /
  `loadedTools` while deferring.
- **On-demand built-ins** (D390): `ON_DEMAND_TOOLS` (run_workflow, monitor, schedule, watch_pr,
  hand_off_task, message_chat, list_chats, search_chats, enter/exit_worktree, generate_image,
  save_image, chat_attachments, suggest_skill/extension/mcp_server, mcp_status, read_guide) are
  deferred on auto and always (never sends them), MCP's threshold aside. Called by name without a
  search, one runs (`notLoaded` passes it) and `loadedTools(items)` (tool_search results plus the
  on-demand tools called) keeps it offered after. What the IDE's prompts ask for by name stays
  sent (wrap_up, report_findings, schedule_wakeup, widget_guide). `chatTools` leaves out
  enter/exit_worktree and watch_pr with no folder open (`NEEDS_FOLDER`).
- **web_search options** (`core/agent/webSearch.ts` `searchPlan`, `filterByDomains`; Rust
  `ai/search.rs` `SearchOptions`, `post_body`): `allowed_domains`, `blocked_domains` (Tavily and
  Exa: API fields, Exa one list; Brave and SearXNG: `site:` for one allowed domain and `-site:` per
  blocked one; the results are filtered for every provider), `mode` extended (twice the results,
  Tavily's advanced depth, the top three pages read with `fetchPage`, 3 000 characters each).
  Results end with `SOURCES_RULE`. `web.search` takes `allowedDomains`, `blockedDomains`, `mode`.
- **web_fetch `prompt`** (`webFetchQuestion.ts` + `core/agent/webQuestion.ts`, tested): the page
  (up to 100 000 characters) goes to `host.subagent` with the question in parts of 24 000 (at most
  four; the answers that found something are merged); the model is `agent.webFetch.model`, else
  the Explore agent's, else the chat's; its usage is logged as a subagent's. No model, or one
  that fails: the page's text, capped at 8 000, with a note.
- Test: `tests/scripts/agent-deferred-m7-62.jsonc`.
## Background commands (D201)
Claude Code's `run_in_background` / BashOutput / KillShell.
- `run_command` with `background: true` (or a command that looks like a server) starts the
  command through `execIpc` (no terminal) after the usual permission check, waits up to 12 s for
  its first output or server address (`processTools.ts` `runInBackground`), and returns its id
  (`bg1`…). A server address opens in the browser tab as before (`agent.openServers`).
- `process_output { id, filter? }` (read-only): what it printed since the last read, or only the
  new lines matching `filter` (a regular expression, else plain text); dropped output is counted.
  Without `id`, the chat's background commands. `kill_process { id }` ends it and what it started.
- `processOutput.ts` (DOM-free, tested): `OutputBuffer` (1 MB per command, read cursor,
  escape sequences and progress redraws cleaned), `outputFilter`.
- `backgroundProcesses.ts`: the window's `backgroundProcesses` (per chat, at most 8 running per
  chat, the last 10 ended kept). Killed when the chat is deleted (`agent.deleteSession`), the
  folder closes and the window ends (Rust: the IDE's job object, D180; a reloaded page, D163).
  Stop doesn't end them (a server from an earlier step keeps running); Stop during the start does.
- `processCommands.ts`: `agent.listProcesses {session?}`, `agent.killProcess {id}`,
  `agent.showProcessOutput {id}` (a read-only tab), `ide://agent/processes`.
- The chat's list above the message box (`view/processes.ts`, D286) became the chip under the
  conversation and the Background tasks view (D326, below). `view/processOutput.ts`
  (D286): `agent.processOutput`, a panel tab following one command's output live, with Stop; the
  step that started one has View output (`view/steps.ts`).
- Test: `tests/scripts/tasks-m7-2.jsonc`.

## Rules editing, MCP client, worktree agents, auto-approve, @docs (D204)
- **Rules** (`rulesPage.ts` + `core/agent/ruleEditing.ts`, tested): the Rules page (dock view
  `agent.rules`; `agent.showRules`, the ⋯ menu's Rules…, Settings → Agent): every rule with its
  source, scope, subagents and an on/off switch (`agent.setRuleEnabled` → `agent.rules.disabled`),
  edited in place (`agent.updateRule` writes the file's own front matter), deleted
  (`agent.deleteRule`) or created from a template (`agent.createRule`: Cursor .mdc, an AGENTS.md
  section, Copilot .instructions.md, Claude Code .claude/rules). `.claude/rules/*.md` (`paths`) is
  read too. **Subagents** (Claude Code's convention): custom, general and reviewer subagents get the
  always-on rules (plan and explore don't; `omitClaudeMd` / `omitRules` leaves them out); a
  definition's `rules:` preloads more; a rule's `subagents:` front matter names the subagents it's
  for (`*`, `none`). `ide://agent/subagents` lists each one's `projectRules`. D207: folder and
  matching-files rules come with a subagent's read_file / edit_file / write_file of a file they
  cover, once per run (`SubagentSpec.ruleNeeds`, `RulesService.forSubagentFile`,
  `subagentRulesForFile`), not in its prompt.
- **MCP** (`mcpSampling.ts`, `mcpPage.ts`, `mcpResources.ts`; models in `core/mcp/sampling.ts`,
  `templates.ts`, `gallery.ts`; OAuth in Rust `mcp/oauth.rs`): sampling with
  approval (`agent.mcp.sampling`, `agent.setMcpSampling`, `ide://agent/mcp/sampling`), OAuth sign-in
  (`agent.mcpSignIn`, `agent.mcpSignOut`), resource templates and subscriptions
  (`ide://agent/mcp/subscriptions`, `registerSendContext` in `composerExtras.ts`), the MCP servers
  page with the gallery (`agent.showMcpPage`, `agent.mcpGallery`, `agent.installMcpServer`,
  `agent.removeMcpServer`, `agent.openMcpConfig`). Tool schemas on demand became deferred tools
  (D319, below).
  D207: remote servers in `mcpRemote.ts` (POSTs, the standing GET stream with reconnect, and the
  step-up sign-in on 403 `insufficient_scope`: `agent.mcpSignIn { restart: false }`, then the call
  once more; `stream` / `streamReconnects` in `ide://agent/mcp`); sampling answers reviewed when
  the user approved the request (a dialog: send, edit, reject; `agent.reviewMcpSampling`,
  `reviews` in `ide://agent/mcp/sampling`) and images sent to models that read them; the MCP
  registry (`mcpRegistry.ts` + `core/mcp/registry.ts`: `agent.searchMcpRegistry`,
  `agent.mcp.registryUrl`, "Search the MCP registry…" in New MCP server, the built-in list
  offline; `agent.installMcpServer { id | registry }`).
- **Auto-approve** (`autoApprove.ts` + `core/agent/autoApprove.ts`, tested; `toolGate.ts`):
  `agent.autoApprove` for reads, edits, commands, browser, web, MCP; the Auto-approve page
  (`agent.showAutoApprove`), `agent.setAutoApprove`, `ide://agent/autoApprove`. D207: find_files
  and search through call_command (`search.run`, `quickOpen.search`) leave out paths a reads Ask
  pattern covers, like search; "Always" on a protected read or edit saves `/<that file>` (a
  leading `/` anchors at the root; an exact file beats any glob) and on a browser or web question
  the page's domain (`saveAlways`, `alwaysPattern`), with a notice in the chat.
- **Risky folders** (`riskyGuard.ts` + `core/security/`, tested; D213): a tool gate (first of
  `toolGate.ts`'s gates) asks before the agent works in a risky open folder (Downloads, home,
  Desktop, temp, a drive root) and before any path, working folder or command line in a
  Downloads folder — even with full access; "Allow" counts for that chat until the folder
  closes. find_files, search and list_dir leave out a Downloads folder the chat wasn't allowed
  into. Writes to other agents' config and startup files (`.codex/`, `.claude/settings.json`,
  MCP lists, `.bashrc`…) ask every time. External agents (`acp.ts`) ask before starting in a
  risky folder, for fs/terminal requests into Downloads, and their permission requests on those
  files lose "Always". The folder's own rules, skills, subagents and MCP servers aren't loaded in
  restricted mode or a risky folder (`projectInstructionsBlocked`; `ide://agent/rules`
  `projectBlocked`). State: `ide://agent/riskyFolders`.
- **@docs** (`docs.ts`, `docsPage.ts` + `core/agent/docsIndex.ts`, tested; Rust `agent/docs.rs`):
  `agent.docs.sources`, `agent.addDocs`, `agent.refreshDocs`, `agent.removeDocs`,
  `agent.searchDocs`, `agent.showDocs`, `@docs:<name>` mentions, `ide://agent/docs`. D207:
  sitemap.xml seeds the crawl, pages that need JavaScript are counted (`needsJavaScript`,
  `javaScriptPages`), `agent.docs.refreshDays` (7) reads old sources again
  (`agent.refreshStaleDocs`).
- **Worktree agents** (`worktreeRuns.ts`, `worktreePages.ts` + `core/agent/worktrees.ts`, tested;
  Rust `agent/worktree.rs`): setup step (`agent.worktree.copyFiles`, `agent.worktree.setupScript`),
  PORT per worktree (`agent.worktree.basePort` / `portStep`, the window's env), best of N
  (`agent.bestOfN`), the overview (`agent.worktreeAgents`), compare (`agent.compareWorktrees`),
  apply (`agent.applyWorktree`), `ide://agent/worktrees`. The saved chat's meta has `status`.
  D207: the setup script gets PORT / WORKTREE_* too; each window is started with its chat as a tag
  (`app_new_window` keeps the process, `app_windows_alive` asks), so a window closed mid-turn shows
  Stopped; pages read again every 2 s; Apply's conflicts are kept on the record and
  `agent.resolveWorktreeConflicts` opens them in the merge editor (`git.openMergeEditor`).
  D222: a tag this window doesn't know (it restarted) is answered from the window registry by the
  worktree's folder (`app_windows_alive` with `folders`); each tick stats the chats
  (`agent_session_stamps`) and reads only the ones saved since (`planWorktreeRead`, `slimChat`);
  the diff follows the chat (at most every 6 s) or is read every 30 s. Test:
  `tests/scripts/agent-worktrees-m7-7.jsonc`.
- Styles: `src/styles/agent-pages.css`; page builders `view/pageKit.ts`
  (every Customize page uses its `pageGroup`, `addButton` and `cardRow`, the Skills page's layout, D399). Test:
  `tests/scripts/agent-m7-5.jsonc` (with `tests/fixtures/sample/tools/mock-mcp-extra.mjs`).

## External agents without a folder, their usage, reviews and own writes (D208)

- No folder open: `acp.ts` starts the agent in the chat's private folder (`scratchIpc.dir`, Rust
  `agent/scratch.rs`); its fs requests go through `scratchIpc.read` / `write` and anything outside
  that folder is refused (`confine`, also with a folder: only files inside it). Opening a folder
  restarts it there (`startedFor`). `acpOneShot.ts` uses a shared one-off folder the same way.
- Usage: each turn is one record (`recordAgentUsage`, `core/agent/usageLog.ts` `makeAgentRecord`,
  provider `acp:<agent>`, model `acp:<agent>/<its model>`): the tokens from the prompt answer's
  `usage` (`client.lastUsage`), the cost as the difference of `usage_update`'s cumulative cost;
  no tokens → `unreported` (a request, cost unknown). `usage_update`'s `used`/`size` drive the
  chat's context meter. The Usage page names these "external agent", "subscription or not
  reported".
- Files the agent writes itself (`acpChanges.ts` `TurnWatch`): git's dirty files' texts at the
  turn's start, compared after it (clean files with HEAD), plus the files its steps name (a diff's
  old text when given); the changes go into the changeset as already written
  (`Changeset.adopt`), shown on the step that named them or one "Changed files" step. A file
  no step named counts only if it changed while one of the turn's steps that can write was
  running (`core/acp/turnChanges.ts` `changedByAgent`, the steps' times in `stepWindows`, D403);
  others (the person, a formatter, another agent) are left out with a note. Test:
  `tests/scripts/acp-foreign-changes-m7-117.jsonc`.
- Reviews (`acpReviews.ts`): Codex's Guardian review steps become `item.review` on the step they
  reviewed (`targetItemId`), or a compact `acp:review` row until it appears; rows show tags
  (`toolTags`: the shell, the review line) and readable tooltips (`toolTooltip`).
- Test: `tests/scripts/acp-m7-6.jsonc` (the mock agent's "agent writes itself" and "scratch
  check").

**External agents get the IDE's tools (D211):** `acp.ts` passes the lent MCP server in `session/new` and `session/load` when the agent advertises `mcpCapabilities.http`; `agent.externalAgents.ideTools` turns it off; `ide://agent/session` → `ideTools`.
With them on, each message carries the IDE state (`ideState`: editor, problems, git, open browser tabs and their console errors, D365) as an `<ide_state>` context block; `browser.console` is a core command, listed as `browser_console`.

**D223 (MCP and external agents):**
- Agents without `mcpCapabilities.http` get the same server as a stdio one: the IDE's own executable with `--mcp-stdio-proxy <url>` and the token in `IDE_MCP_PROXY_TOKEN` (`ideMcpServer` in `core/mcp/agentAccess.ts`, Rust `mcp/stdio_proxy.rs`); `ide://agent/ideTools` says `http` or `stdio` per chat.
- `acpChanges.ts`: a finished step's named files are compared at once and go under review on its card (`liveChanges` in `acp.ts`); the end of the turn compares them again (a later step may undo or change more). Files a step names before it runs are read then (git-ignored ones included); a file the user saves in the IDE during the turn is compared from that save on (`files.didSave`); up to 1000 dirty files / 64 MB are read at the start, 1000 compared, the rest counted in the "Changed files" step.
- Per-model usage: `_meta.quota.model_usage` (`promptModelUsage`, `core/acp/display.ts`) → one usage record per model when there are two or more; the extra ones are `part` (tokens, no request, no cost of their own).
- The `--help` model probe quotes a program path with spaces (`helpCommandLine`; PowerShell's `& '…'`).
- `mcp.ts`: password inputs are stored under `mcp.input.<name>::<input>@<identity hash>` (`serverIdentity`: the address without its query, or the program and its arguments without version pins), so another config's server of the same name doesn't get the key; the user's own servers (settings, user mcp.json) still use a key stored under the name alone. `pickString` inputs (VS Code's) and registry `choices` are asked as a pick. A call waiting on a step-up sign-in shows it on its row (`watchStepUp`; `ide://agent/mcp` `signingIn`). A server's stop aborts its sampling requests (the question, the model, the review).
- `mcpSampling.ts`: requests over 200k characters of text or 15 MB of media are refused; a model hint only applies unasked when it costs no more (`hintAllowed`); audio is transcribed by voice input's speech-to-text service and sent as text.
- Registry entries (`core/mcp/registry.ts` `runnerRisks`): `docker run --privileged`, host namespaces, `--cap-add`, `--device`, `--security-opt`, mounts of `/`, system folders, the home folder or docker's socket, and `npx -c/--call` are refused (`refused` in `agent.searchMcpRegistry`); host mounts, ports, root, other package indexes are listed as warnings in the install question. Remote addresses with `{variables}` become inputs.

## External agents from the ACP agent registry (D215)

- `acpRegistry.ts`: the agents of the ACP agent registry (agentclientprotocol/registry). The list
  is the bundled snapshot (`src/assets/acp-registry/registry.json`, made by
  `scripts/gen-acp-registry.mjs`; quarantined and GPL/LGPL/AGPL agents left out), then the copy
  fetched last time, then the CDN when the gallery opens (once per window) or on
  `agent.registry.refresh` — all through Rust (`core/ipc/acpAgents.ts`). Parsing and checks are
  `core/acp/registry.ts`. Installing: a binary agent is downloaded for this platform into
  `<data>/acp-agents/<id>/<version>/` (SHA-256 checked when listed; "not checksum-verified"
  otherwise), an npx / uvx agent runs through npx / uvx (Node.js / uv named when missing), and a
  binary agent whose program is on PATH (cursor-agent, kimi, goose…) can use that. Installing
  always asks (a dialog for the user, a card in the agent's chat that full access doesn't skip);
  installed agents are kept in the global state (`acpAgents`) and `externalAgents()` lists them
  after the presets and extensions' agents as `acp/<name>`, so they get the D213 risky-folder
  questions and the D211 lent MCP server like every external agent. The four presets map to their
  registry ids (claude-acp, codex-acp, gemini, github-copilot-cli) and keep their own install.
- `view/agentGallery.ts`: the cards under "Use an agent you already have" (search, Install / Use
  / Update / Remove / Details); installed registry agents get a row above, like the presets.
  The Agents page's External agents branch has Browse agents….
- Commands: `agent.registry.list`, `agent.registry.refresh`, `agent.registry.install`,
  `agent.registry.uninstall`, `agent.registry.cancelInstall`, `agent.registry.details`,
  `agent.registry.browse`. State: `ide://agent/registry`.
- Test: `tests/scripts/acp-registry-m7-6.jsonc` (a local registry and archive from
  `tests/fixtures/setup/acp-registry-m7-6.mjs`, around `tools/mock-acp.mjs`).

## Hooks, custom modes, the codebase index, pull requests, read-only paths (D227)
- `hooks.ts` + `core/agent/hooks.ts`: the user's `agent.hooks` and a trusted folder's
  `.claude/settings.json` hooks (approved per SHA-256 of their commands), Claude Code's format.
  `sessionTurn.ts` runs `PreToolUse` / `PostToolUse` around every tool call (`hookedTool`, also
  for subagents), `UserPromptSubmit` before a message and `Stop` after the verify step. D371:
  `SessionStart` (`session.startHooks`, the chat's first message after a start, reopen, /clear or
  summary: `hookStart`), `SessionEnd` (`endHooks`: /clear, `forget`, the window closing),
  `PreCompact` (`compactWith`), `Notification` (`attention.ts`, waiting for the user),
  `SubagentStart` / `SubagentStop` (`runSubagent`). Plugins' hooks get every event too. Hooks run
  through `execIpc.run` with the event on stdin and `CLAUDE_PROJECT_DIR`; Stop cancels them.
  `ide://agent/hooks`.
- `customModes.ts` + `core/agent/chatModes.ts`: `agent.customModes` and a trusted folder's
  `.github/chatmodes/*.chatmode.md` / `.github/agents/*.agent.md`, as `custom:<name>` chat modes
  (`sessionTypes.ts` `modeRules`, `session.ts` `tools()`); `agent.createChatMode`;
  `ide://agent/chatModes`.
- `codeIndex.ts` + `core/agent/codeIndex.ts` (+ Rust `ai/embed.rs`, `ai_embed`): the opt-in
  codebase index (`agent.codebaseIndex.enabled`, `.model`), the `codebase_search` tool,
  `agent.codebaseSearch`, `agent.rebuildCodebaseIndex`, `ide://agent/codebaseIndex`. Stored with
  the @docs indexes in app data (`code-<hash of the folder>`).
- `chatPullRequests.ts`: `agent.createPullRequest` (the "…" menu's Open pull request) and the
  link from `github.didCreatePullRequest` (`session.pullRequest`, saved with the chat).
- `riskyGuard.ts` `readOnlyTarget`: `agent.readOnlyPaths`, refused before any question.
- `core/acp/modes.ts`: external agents' session modes, set at each turn from the IDE's
  permission settings (`acp.ts` `syncMode`).

## m7.12 (D233): protocol switches, shared helper reports, pure group routing, @docs by meaning
- **A skill's model of the other tool protocol** takes over mid-turn (`sessionTurn.ts`
  `switchModel`, now run in the loop's `beforeStep`, before the step's messages are built).
  `core/agent/conversation.ts` `toMessages` renders the history in the new model's protocol:
  native calls (no `raw`) as `<tool_call>` blocks (`textProtocol.ts` `toolCallText`) for a
  text-protocol model, text-protocol calls as native calls with their results for a native one.
  The prompt prefix changes once at the switch; every later request renders the same bytes.
- **Helper reports for a chat that isn't open where the helper finished** go to a store every
  window reads (Rust `agent/reports.rs`: `agent_report_put` / `_list` / `_claim`; a claim renames
  the file first, so exactly one window takes a report). Each window looks every 5 s while it has
  chats, and when a chat opens (`isolatedHelpers.ts` `deliverPending`).
- **Group routing is pure** (`groupChat.ts` `groupTurn` returns `commit()`): members a message
  brings in, the round's queue and the hand-off take effect only once the turn starts (after the
  UserPromptSubmit hooks and the model choice; for external agents `sendExternal`'s `onStart`).
- **"@Rev" in a chat with one agent** makes it a group of that agent and the ones named
  (`core/agent/groupChat.ts` `membersAfterMentions`), and Rev answers. `agent.inviteAgent
  { agent, answerNext? }` (agent-callable; for an agent, its own chat) brings one in by name or
  label; during a turn the invited agent answers after the current reply. The delegate tool's
  description says the difference and lists agents with their labels.
- **The details panel's context split** uses the shown speaker's mode (`session.toolsFor(mode)`).
- **The worktree overview** follows the saved chats' folder (Rust `agent_sessions_watch`, a
  watcher of `agent/sessions`; `worktreeRuns.ts` `follow()`, `core/agent/worktrees.ts`
  `chatsInBatch`); a 15 s check remains for windows that closed and worktree changes between saves.
- **@docs** (`docs.ts`): `agent.docs.embeddings.enabled` (off; AGENTS.md rule 8) embeds each
  source's passages when it's read (`agent.docs.embeddings.model`, else the codebase index's
  model; Ollama or any OpenAI-compatible `/embeddings` through `ai_embed`) and a question is
  matched by words and meaning (`core/agent/docsIndex.ts` `hybridSearch`, reciprocal rank
  fusion); lexical whenever vectors are missing, from another model, or the model fails.
  `agent.docs.renderJavaScript` (off) reads pages that need JavaScript in a hidden incognito
  window (Rust `agent/render.rs`, `docs_render`; the page's script may only call
  `docs_render_post`, capability `docs-render`), 20 s at most per page.
- **External agents** (`acpChanges.ts`): without git, the folder is listed with sizes and times
  at the turn's start and end (Rust `agent/tree.rs`, `agent_tree_stats`: .gitignore honored,
  dependency and build folders skipped, 20 000 files) and small files are read at the start, so a
  change no step names is found. Git-ignored files no step names stay out, as in VS Code. A user's
  save after a step showed the agent changing the file keeps the turn's start as the baseline
  (`core/acp/turnChanges.ts` `baselineAfterSave`). Codex's `/status` text becomes
  `session.externalLimits` (`core/acp/planLimits.ts`; `ide://agent/session` `planLimits`).

## m7.13 (D234): the main agent's name and face, chat tabs with faces
- **The main agent's name and face** (`mainAgent.ts`): `agent.mainAgent.name` and
  `agent.mainAgent.icon` (user settings), set on the Agents page (the face opens the face picker,
  the name is a field) or with `agent.setMainAgent { name?, icon? }` (`icon: "random"` shuffles).
  The `mainAgent` signal feeds the chats bar, the chat header, group chats (`groupChat.ts`
  `knownAgents`: labels, faces, the room brief, "@Name") and the Chat with picker. Its member id
  stays `agent`, so saved chats, mentions and handoffs keep working after a rename.
  `ide://agent/mainAgent`: `{ id, name, icon }`.
- **A chat's tab shows its agents' faces** (`groupChat.ts` `chatFaceElement`; the view type's
  `iconElement`): a group chat's faces, else its agent's face in its state (working, waiting).
- **A group chat is busy as the member whose turn it is** in the chats bar (`session.speaking`,
  the signal under `turnSpeaker`), not as the main agent (its mode).
- **A member's replies carry their speaker from the start** (`core/agent/loop.ts`): before, they
  got it when the turn ended, so the turn's later requests labelled the member's own earlier steps
  `[Agent]`, and models copied the tag. A step with only tool calls gets no label, and a reply's
  leading `[Name]` is taken out (`conversation.ts` `stripSpeakerTag`).

## m7.14 (D235): a group member's own model in a chat on an external agent
- **A member with its own model answers on it** (`sessionTurn.ts` `memberModelChoice`): in a chat
  on an external agent, a turn whose member's agent file names an IDE model goes through the IDE's
  loop on that model; other members (and "Same as the chat") are still the external agent. An
  `acp/…` or missing model keeps the external agent.
- **The external agent hears what it missed** (`sessionExternal.ts`): `session.externalSeen` is the
  last item its own session saw; what came after is sent with its next message as "Said in this
  chat since your last turn", speakers named (`compact.ts` `transcript(…, nameOf)`). Its recaps
  (first start, restart) name speakers too.
- **The chat header redraws when the agents list changes** (`view.ts`): a group chat's faces
  read `customModes`, so adding an agent no longer leaves a member with a stand-in face.

## m7.14 (D236): "+ ▾", a new chat with an agent
- **`agent.newChatMenu { x?, y?, session? }`** (`newChatMenu.ts`): the ▾ beside + in the Chats
  view's header and a chat's header. The main agent, then the user's agents (faces through
  `MenuItem.iconElement`, roles on the right), "Group chat with …" when opened from a group chat,
  New group chat…, Agents and models. Without `x` / `y` it's `agent.chatWith`'s picker.
- The sidebar's `ViewAction.dropdown` draws a narrow ▾ against the action before it (as the dock's
  `TabAction.dropdown`), and stays a ▾ when the view is moved to the dock.

## m7.15 (D237, D238): channels, direct messages and threads (Slack's model)
- **Model** (`core/agent/rooms.ts`, DOM-free, tested): a channel is a `Room` (id, name, members,
  purpose, `session` its conversation, `memory`, `task`); a direct message is `dm:<agent>` (its
  conversation in `roomService.ts` `dmSessions`). A conversation is a chat with `session.room`; a
  thread is a chat with `session.parent` (the message it answers: session, item, author, text).
  Both are saved in the chat's meta, with `first` / `last` / `lastBy` / `replies` for the lists
  (`sessionStore.ts` `threadPreview`). Also `threadRoom` (chats from before channels),
  `threadsByMessage`, `boardColumns` / `inboxGroups`, `roomActivity`, `isUnread`, `withNote`,
  `roomBriefLine` (`[Channel] …`: channel, purpose, task, notes, a thread's parent; sent with
  each message, not shown in the bubble), `taskRoomName`. The code says "room" because a Tauri
  Channel is something else here.
- **The team** (`core/agent/builtInAgents.ts`): Builder, Reviewer and Tester from the agent
  templates (the Reviewer keeps the built-in reviewer subagent's instructions), loaded as source
  `team` after the files, so a file with the same name replaces one, and after the user's own chat
  modes (`customModes.ts`). The main agent's default name is the product's (`mainAgent.ts`).
- **Channels** (`roomService.ts`): `rooms` and `dmSessions` (workspace state `agent.channels`,
  `{ rooms, dms }`; a folder without starts with `#general`). `roomSession(room)` makes a room's
  conversation the first time. Commands: `agent.openChannel`, `agent.showInbox`,
  `agent.newConversation`, `agent.postToChannel`, `agent.replyInThread { session, item }`,
  `agent.readThread { session? | channel? }`, `agent.createChannel`, `agent.editChannel` (and
  `…Members`, `…Purpose`), `agent.archiveChannel`, `agent.deleteChannel` (D270: it and its
  conversations, asked once), `agent.rememberInChannel`,
  `agent.channelMemory`, `agent.createTaskChannel`, `agent.closeTaskChannel`, `agent.openThread`.
  `ide://agent/channels`.
- **Unread** (`unread.ts`): when each conversation was last seen (workspace state `agent.seen`,
  with `since`); the chat view marks it seen while it's on screen.
- **Views:** `chatsView.ts` (D291: the sidebar, id still `agent.chats`: every chat by day,
  newest first, then other folders'; search; bold when unread; D377: Ctrl/Shift+click selects
  several (Delete / Archive / Open together, `agent.deleteSessions`), rows drag onto the dock
  through `services.dragViews`; `channelsView.ts`, Slack's
  sidebar of D237, was kept unregistered and is gone since D394), the channel tab (only the Inbox now: a room's
  conversation opens in the thread tab, `setRoomConversation`) (dock type `agent.room`, state
  `{ room }`: the chat view on the room's conversation, `AgentViewHost.room`; `inbox` is
  `inboxView.ts`, a list or a board), the thread tab (the chat view; a thread shows its parent
  message on top and "Thread in #general ›"). Messages get **Reply in thread** and, when they have
  threads, a replies row (`view/items.ts` `repliesRow`).
- **One tab each** (`threadTabs.ts`): `showRoomTab` / `showThreadTab` reuse the preview tab of
  their kind (or an empty chat's tab); `newTab` opens one that stays. `DockService.replaceTab`.

## m7.15 (D239): start free with OpenCode
- Since D401 OpenCode is the ACP registry's OpenCode V2 (`catalog.ts` SUGGESTED_REGISTRY_AGENTS:
  listed with the presets, Install downloads it), no longer a preset.
- `freeStart.ts`: the empty chat's **Start free with OpenCode** card (`setupPrompt`'s `extra`) and
  `agent.startFree` (`agent.registry.install` opencode-v2 from a download when missing, then
  `agent.chooseModel` main `acp/<its name>`). Delete it and its two calls in `index.ts` if
  OpenCode drops its free tier.

## m7.17 (D249): agents and modes apart, an agent on an external agent, the Channels view
- **Who and how** (`session.ts`): `chatMode` is the agent (`custom:<name>`, or the main agent's
  mode), `workMode` Plan or Ask on one of the user's agents (saved). `work()`, `overlay(mode)`,
  `setWork()`, `setAgent()` (takes the agent's start mode). `toolsFor` narrows an overlay to
  reading tools (plus the plan); `sessionTurn.ts` `soloRules` adds the mode's rules; the plan's
  Build note (`planReadyText`). `agent.setChatAgent`; `agent.setChatMode` sets the mode;
  `agent.build` hands a read-only agent's plan to Builder. `ide://agent/session` has `work`.
- **Start modes:** `core/agent/subagents.ts` `startMode` (`mode:`), `agentFile.ts`,
  `agentTemplates.ts` (planner: plan, chat: ask), `builtInAgents.ts` `TEAM_START_MODES`,
  `chatModes.ts` `CustomMode.startMode`; the editor's **Starts in**; `roomService.ts` `joinRoom`
  applies it when a direct message's agent changes.
- **Composer** (`view/composer.ts`): the pill (face, name, "· Plan"), the menu (Agent / Mode
  headings, `ui/Menu.ts` `heading`), Shift+Tab over the modes.
- **External agents for agents:** `agentConfig.ts` `agent.chooseModel` and the editor's model menu
  list them; `sessionTurn.ts` `memberExternal`; `sessionExternal.ts` `externalFor` clears
  `externalSeen` when another agent had the chat.
- **Channels view** (`channelsView.ts`, removed in D394): no add rows or pages; `newChatMenu.ts`
  `agent.channelsMenu` is the title bar's ⋯.

## m7.16 (D245): the team, @all, follow-ups, agents from a description, Recent
- **The team** (`core/agent/builtInAgents.ts`): Planner, Builder, Chat (templates `planner`,
  `builder`, `chat` in `agentTemplates.ts`); since D272 Plato (`planner`, Plan) and Gabby
  (`chat`, Ask), no builder, and `agent.resetAgents` (Reset to defaults) writes them again. `subagents.ts` `seedTeam` writes each once
  (global state `teamAgentsWritten`; `teamAgentsSeeded` reads as `FIRST_TEAM`).
  `roomService.ts` restores an untouched #general with the new team (`rooms.ts` `withNewTeam`).
- **`@all`** (`core/agent/groupChat.ts` `mentionsEveryone`, `routeTogether`, tested):
  `groupTurn` returns `together`; `sessionTurn.ts` starts them with `groupTogether.ts`
  `startTogether` once the turn's deps exist (`commit(true)`); an external agent's turn calls
  `commit()` and they're queued. Each answer is a `runSubagent` run (read-only tools, the
  member's model, `session.background` for Stop), added as that member's reply when no turn runs.
  Setting `agent.groupChat.answerTogether`. `view/memberMentions.ts` suggests `@all`.
- **Follow-ups:** `session.background` records have `message(text, from)`; `startBackground`
  keeps an inbox that `runSubagent` drains through `takeQueued`. `subagents.ts`
  `messageBackground`, the `message_subagent` tool (falls back to `sendToHelper`) and
  `agent.messageSubagent`; the details card's subagent rows have a Message button.
- **Agent files** (`core/agent/subagents.ts`): `mapTools` keeps `mcp__…`; `toolListed`;
  `disallowedTools`, `acceptEdits` (`chatModes.ts` `deny` / `acceptEdits`;
  `sessionTurn.ts` `autoApply`).
- **Generate** (`core/agent/agentDraft.ts`, tested; `agentEditorCommands.ts`
  `agent.generateAgent`; the editor's **Describe it…** chip and `AgentEditorState.generated`).
- **Recent** (`threadList.ts` `otherChats`;
  `rooms.ts` `recentChats`, `shortAge`).

### Design note: best of N in one window (steps 1–3 built for headless helpers, D246)
A chat is tied to its window's folder in many places, so N chats in N worktrees inside one window
need a per-chat folder, threaded through:
1. **Tools** — built (headless helpers): `toolRoots.ts` gives a chat (by id) its worktree;
   `tools.ts` `root(host)` / `resolve`, run_command's cwd and env, background commands,
   `list_dir`, `find_files` (Rust `index_query` with `root`) and `search` (Rust `search_start`
   with `root`) go through it; explore and subagents follow, being the same chat. `repoMap.ts`
   and `browserTools.ts` needed nothing (the repo map is the prompt's, the browser the window's).
2. **The fs scope** — built: `fs::Workspace` extra roots (`allow_root`: a linked worktree of the
   open folder's repository only; `forget_root`; cleared on a folder change).
3. **Changeset and checkpoints** — built as far as helpers need: writes, reads, trash and
   checkpoints work through the extra root while it's let in; the window's undo history leaves
   the worktree's files out. Opening one of its diffs in the editor after the helper ended needs
   the root again (left).
4. **Rules, memory, skills, the index, language servers**: built for the open folder (the frozen
   system prompt is keyed by `workspace.root`); per chat they'd be keyed by the chat's folder.
   Language servers and the codebase index stay the window's: the chats' worktrees get no
   diagnostics (as worktree windows' agents have today only in their own window). A headless
   helper uses the main folder's (the same repository); its paths in the prompt map onto its
   worktree (`helperPath`).
5. **The window's own state** (git panel, explorer) stays on the main folder; the compare page
   (`worktreePages.ts`) already reads each worktree's diff through git. IDE commands that act on
   the window's folder are refused to a helper (`actsOnWindowFolder`).
Next: `agent.bestOfN { inWindow: true }` can start each model's chat the way `startHere` does
(a headless worktree agent per model, without the helper report). Until then best of N opens one
window per model (D193).

## Multi-root workspaces (D251)
With several folders open (a `.code-workspace` file), the agent works in all of them; with one
folder everything is as before.
- **Paths.** The model writes and reads paths as the workspace does: relative to the first folder,
  or with a folder's name in front (`api/src/x.ts`). `core/agent/workspaceFolders.ts` (tested):
  `sandboxPath` (the file sandbox: inside any folder, nothing else; `..` collapsed first),
  `resolveInFolders` / `relativeInFolders`, `inputPathsIn` (call_command inputs), `pathReadings`
  (agent.autoApprove patterns match the workspace path and the path inside its folder) and
  `FolderIgnores` (each folder's `.aiignore` / `.cursorignore` / `agent.ignoreFiles` / defaults,
  matched relative to that folder; nested folders: any of them excluding hides it). `tools.ts`,
  `ignore.ts` (`agentFolders`, `agentIgnoredInFirst` for a helper's worktree), `stateSelection.ts`,
  `autoApprove.ts`. `list_dir` without a path lists every folder.
- **Risk and protection.** `riskyGuard.ts` `riskyTargets`: the folder a path is in (search / find:
  every folder) asks on its own; protected config files and `agent.readOnlyPaths` are judged
  relative to the folder holding the file; `projectInstructionsBlocked(services, folder)`.
  `ide://agent/riskyFolders` adds `folders` (name, path, risk, instructionsBlocked).
  `core/agent/toolRules.ts`: `RuleContext.folders`, so allowed- / disallowed-tools path patterns
  hold in every folder.
- **Hooks** (`hooks.ts`): every folder's `.claude/settings*.json`, each run in its folder; one
  approval signs all of them (`core/agent/hooks.ts` `hookSignatureText`: one folder is signed as
  before), so a folder that adds hooks asks again.
- **MCP** (`mcp.ts`, `mcpConfigFiles.ts` `folderMcpFiles` / `workspaceMcpFolders`): every
  trusted, non-risky folder's mcp.json files (labelled `api/.vscode/mcp.json`); a folder's server
  runs in that folder (`${workspaceFolder}`, cwd, envFile); MCP roots list every folder.
  `agent.addMcpServer`, `agent.installMcpServer`, `agent.openMcpConfig` take `folder`.
- **External agents** (`acp.ts`, `acpChanges.ts`): ACP has one cwd (the first folder); file
  requests in any folder are allowed, every folder is checked for risk before it starts, and the
  turn's changes are found in every folder (`TurnWatch` holds a `FolderWatch` per folder; another
  folder uses git when it is a found repository's root, else the listing).
- **Context.** The prompt lists the folders (`context.ts` `workspaceLine`); the repo map, the
  codebase index (one store under the workspace file; a single folder's store unchanged) and
  `@` file picks cover every folder. Rules (`rules.ts`, `core/agent/rules.ts` `ruleInFolder`): the
  first folder's as before, another folder's named `api/AGENTS.md` and covering only its files.
  Skills, slash commands, chat modes and subagents come from every folder's settings folder
  (labelled with the folder). New skill / command / chat mode / project agent / rule take
  `folder` (`workspaceFolder` for agent.createRule; `workspaceFolderPick.ts`).
- **Chats** (`chatWorkspace.ts`, `core/agent/chatWorkspace.ts`): a chat stores the window's
  first folder as `meta.workspace` (one folder, as always, and a multi-root workspace too: its
  file isn't the key, since an untitled workspace's file changes on "Save workspace as…"); a
  window takes as its own a chat stored with its first folder, or with its workspace file (chats
  saved while the file was the key). The "Started in …" banner and the details panel's folder use
  the same matching, labelled with `locationLabel`.
- Everything per folder reloads on `workspace.onDidChangeFolders`.

## Schedules and wake-ups (D253)

- `attention.ts` (D254): a chat that asks a question or an approval, or whose turn (a group
  round, counted once) ends while the window is in the background flashes the taskbar
  (`windowIpc.requestAttention`, Rust `app_request_attention`) and leaves a notification with
  Show; `agent.notifyWhenAway` (on).

- `schedules.ts` (+ `core/agent/schedules.ts`, tested: parsing "when", the next run, limits,
  descriptions): `ScheduleService` keeps the folder's schedules in the workspace state
  (`agent.schedules`) and runs one timer (at most a minute) for the soonest; a due one sends its
  prompt to a chat (`deliverAutoMessage` in `sessionSubagents.ts`, `auto: "schedule"`), a channel or
  an agent's DMs (`agent.postToChannel`) or a new chat with an agent (`agent.chatWith`). The
  `schedule` tool (add / list / cancel; asks before a repeat or work sent elsewhere), commands
  `agent.schedule`, `agent.schedules`, `agent.cancelSchedule`, `agent.runScheduleNow`, state
  `ide://agent/schedules`, the details panel's Background rows (`scheduledMessages`,
  `schedulesOf`), the chat's ⋯ and the Channels ⋯.
- `processTools.ts`: run_command's `notify_on_exit` (the process's `notify`, `exitNotice`; delivered
  by `registerSchedules` on `backgroundProcesses.onDidEnd`, `auto: "process"`), process_output's
  `wait_for` / `timeout_seconds`.
- Group chats: automatic messages carry `to` (the member they're for); `pendingFor` routes a
  resumed turn to it, and `takeQueued` leaves another member's reports for that member's turn.
  `newContext` sends a member's brief or a channel's line only when it changed; a channel's or a
  DM's own conversation has `agent.channels.contextTokens` as its budget (`conversationBudget`).
- `chatCommands.ts`: `agent.showMessage { session, item }` (a thread's parent quote) opens the
  conversation centred on that message (`messageReveal` in `threadTabs.ts`).

## Monitors, pull request watches, forks, messages between chats (D322–D325)
All four bring news into a chat as automatic messages (`deliverAutoMessage`, now returning the
item, with `auto: "monitor" | "pr" | "chat"`; `view/autoNews.ts` draws them: a quiet line, or for
another chat's message its text with the sender's name opening it). `backgroundNews.ts` registers
the three services (one line in index.ts).
- `monitors.ts` (+ `core/agent/monitor.ts`: `LineSplitter`, `MonitorEvents` batching / flood
  limit, `monitorTimeout`, the texts): the `monitor` tool { command, description, timeout_ms,
  cwd }. It asks like run_command (`askToRun`, moved out of run_command in `tools.ts`, with
  `commandFolder`), starts a background process (`backgroundProcesses.start`, so it has a bg id,
  shows in the chat's list, the details panel and `ide://agent/processes`, and `kill_process`
  stops it) marked `monitor`; `onChunk` feeds its lines. Lines within 200 ms are one message;
  more than 20 messages or 2000 lines a minute stops it; it expires after `timeout_ms` (5 min
  default, 30 max) with one message; exiting on its own sends its last lines and an end message;
  killed: nothing. State `ide://agent/monitors`.
- `prWatches.ts` (+ `core/agent/prWatch.ts`: `prSnapshot` from `gh pr view` and the review
  threads, `diffPr`, `prEventText`, `nextPollDelay`): `PrWatchService`, one pull request per chat,
  saved with the folder (`agent.prWatches`); polls every 60 s (doubling on errors up to 15 min)
  through `createGithubIpc(root)` (`prView`, `prThreads`), never overlapping; the first look is
  the baseline. Tool `watch_pr` { action: watch | unwatch | status, number }; commands
  `agent.watchPullRequest`, `agent.unwatchPullRequest`, `agent.checkPullRequestNow`; state
  `ide://agent/prWatches`; the details panel's row (`view/detailsPullRequest.ts`,
  `ChatDetailsData.background.pullRequest`).
- Auto-merge (D352, `core/agent/prAutoMerge.ts`: `mergeDecision` from a snapshot, which now has
  reviewDecision, isDraft, autoMerge and mergeState; `mergedByIdeText`, `autoMergeLine`): opt-in
  per pull request. `watch_pr` { action: auto_merge, method? } asks the user once per pull
  request (`PrWatchService.confirmed`), `auto_merge_off` cancels; command
  `agent.autoMergePullRequest { session?, method?, off? }` (the user's: the agent is sent to
  watch_pr; no method → a pick), a button on the details row and the Background tasks row.
  `setAutoMerge`: `repoAutoMerge` allowed → `prAutoMerge` (gh pr merge --auto, mode github);
  else, or when that fails, mode ide: a look where `mergeDecision` is ready runs `prMerge`, ends
  the watch and posts "merged by auto-merge" (a failed merge turns it off and says why). Saved
  with the watch.
- `subagents.ts` delegate `fork: true` (+ `core/agent/fork.ts`: `FORK_DEF`, `forkTranscript`,
  `forkBudget`, `forkSystem`): `agent` becomes optional (a copy of the agent: `FORK_DEF`); the
  conversation as a transcript (first request plus the newest messages, older tool results
  shorter, about a third of the window) goes into the subagent's system prompt; it always runs
  in the background with the read-only tools, or isolated (the transcript then opens its task).
- `chatMessaging.ts` (+ `core/agent/chatMessages.ts`: texts, `readChatMessage`, `SendLimiter`,
  `wentIdle`, `chatAgentOf`): `list_chats` (this folder's chats: saved and loaded, not archived)
  and `message_chat` { chat, message, notify_when_idle }: asks once per sender and target chat
  (`kind: "agent"`), at most 20 sends per chat in 10 minutes, not read-only (no Ask or Plan mode).
  notify_when_idle watches the target's status and items (an effect) and posts one note back.

## Workflow scripts (D338)
Claude Code's Workflow tool: a script that runs subagents deterministically, in the background.
- `core/agent/workflow.ts` (DOM-free, tested): `parseWorkflowScript` reads `export const meta = {...}`
  as a literal (`readLiteral`: never evaluated; variables, calls, spreads and `${}` refused) and
  keeps the body's line numbers; `parallel` (a barrier, a throwing thunk is null, `limit`) and
  `pipeline` (no barrier, stages get (previous, item, index)); `WorkflowRuntime` runs agent()
  calls: the `CallCache` (resume: by prompt and the options that change an answer, each result
  once), `maxAgents`, the `Limiter` (agents at once), a schema's JSON parsed and checked
  (`schemaIssues`, a subset of JSON Schema) and asked once more when invalid; `workflowEndText`.
- `src/workers/workflow.worker.ts`: the script runs here, locked down as an extension's worker
  (`src/workers/lockdown.ts`, now shared) with only agent / parallel / pipeline / phase / log /
  args; `Date.now()`, `Math.random()` and `new Date()` throw (a resume must make the same calls).
- `workflows.ts`: the `run_workflow` tool { script | path, args, resume_from } (not offered with
  agent.workflows.enabled or agent.delegate off; never to subagents): asks (`kind: "tool"`, the
  meta's description and phases, the script as code; "always" for the chat), returns a run id at
  once. Each agent() is one of the chat's background subagents (`host.background` with
  `onReport` / `onUsage`: `startBackground` hands its report back instead of messaging the chat,
  and shows no notice): `general` or `agentType`, read-only tools, its model or its phase's. The
  run is one of `session.background` (the chat's Stop and deleting it stop it); the wall-clock
  cap fails it. Its end (done or failed; not a user's stop) is an automatic message,
  `auto: "workflow"` (a quiet line). Runs stay in memory for the window (`workflowRuns`, 20).
- `view/workflows.ts` `WorkflowCards`: the card under the latest message (after the plan) while a
  run runs, and after it until the user's next message: name, status, agents done, tokens, Stop,
  the agents by phase.
- Editing agents (D351, `core/agent/workflowEditing.ts`): agent() with `isolation: "worktree"`
  runs as a headless worktree helper (`IsolatedHelpers.startForWorkflow`: no ask, no chat line,
  its end goes to the run through a waiter instead of a message). `editingCalls` finds those
  calls in the script's text for the permission card (a run without them refuses one at run
  time); at most `agent.workflows.maxEditingAgents` (3) per run; `files: [...]` claims paths
  (`FileClaims`: overlapping ones wait); a schema gets one try. agent() returns
  `{ result, branch, folder, changes, files }`; the record's `worktree` feeds the card's row
  (branch, changes, Review / Merge → `agent.helpers`) and the end message (`worktreeLines`, with
  branches that changed the same files). Refused when the chat can't edit or isn't in a git
  repository; Stop stops its helpers (their worktrees stay).
- Commands `agent.listWorkflows`, `agent.stopWorkflow { id?, session? }`; state
  `ide://agent/workflows`. Settings `agent.workflows.enabled` (on), `.maxAgents` (10),
  `.concurrency` (4), `.timeoutMinutes` (30).

## Agents only (D286)
- The Agents page (`agentConfig.ts`): the main agent (one model; its name and face open
  `mainAgentEditor.ts` in the agent editor tab, `agent.editAgent {name: "agent"}`), your agents,
  the delegate switch, external agents. The built-in helpers aren't listed: explore and the
  reviewer take their models from `agent.subagents` like any subagent (D288),
  `general` is the agent in a fresh context, the built-in `plan` stands in only without a planner
  of your own (`SubagentRegistry.delegable` / `get`; Claude Code's `Plan`, `general-purpose`,
  `Explore` map there). The delegate step reads "Handed to <label>".
- The composer's agent pill (`view/composer.ts` `chatModeMenu`): agents only; Plan and Ask with
  the main agent only when no agent does them; Shift+Tab `cycleSteps()`: main → planner → chat
  partner. A chat's agent and work mode stay separate underneath (Build, group chats, external
  agents' modes).
- `facePicker.ts`: Shuffle, faces and colors show only for Character.

## Agents and subagents (D288)
- The registry (`subagents.ts`) reads two kinds: **agents** (the agents folders: personas you talk
  to) and **subagents** (Claude Code's `.claude/agents`, the project's and `~/.claude/agents`, plus
  the built-in explore, plan, reviewer, general). `SubagentDef.kind` / `isSubagent` (core) tell
  them apart; `registry.agents()`, `subagents()`, `delegable()`, `subagent(name)` (Claude Code's
  names alias: `general-purpose`, `Explore`, `Plan`). Each kind has its own names.
- Tools (`registry.tools()`): `delegate` + `message_subagent` run a subagent (agent.delegate);
  `hand_off` (agent.handOff) runs `agent.inviteAgent`, which queues the agent to answer next, one
  already in the chat too (handed back), never the one answering. Subagents never get `delegate`
  or `hand_off` (`subagentTools`).
- Commands: `agent.newSubagent` (a Claude Code file in `.claude/agents`, opened),
  `agent.editSubagent` (opens its file; a built-in one is copied there first with
  `subagentFile`), `agent.setSubagent`, `agent.deleteSubagent`,
  `agent.chooseModel {for: "subagent:<name>"}`. `agent.editAgent` on a subagent goes to
  `agent.editSubagent`.
- UI: `subagentsSection.ts`, the Subagents section of the main agent's page
  (`mainAgentEditor.ts`): the master switch, a row per subagent (source badge, description, model
  chip, Customize/Edit, switch), New subagent. The Agents page has the hand-off switch and a link.
- State: `ide://agent/subagents` lists both with `kind`; `ide://agent/agents` only agents.
- Model chips: `modelChooser.ts` (`chooseModelAt`, `modelChipLabel`, the `AI_FEATURES` list the
  Agents page shows) opens `view/modelPicker.ts` with a `target` (`showModelChooser`;
  `chooserContext` is set by index.ts) instead of agent.chooseModel's plain list.
- An agent's own model of an external agent: `SubagentChoice.agentModel` (`agentExternalModel`);
  sessionTurn passes the answering agent's to `sendExternal` → `AcpBackend.prompt({model})` →
  `syncModel` (not remembered; unset: back to `agent.externalAgentChoices`).
  `AgentSession.syncExternalModel` does it ahead of a turn when the chat's agent changes.
- Settings: `modelChoices.ts` registers a `SettingPicker` (workbench/settings.ts
  `registerPicker`, drawn by settings/controls.ts as a button) for `agent.model`,
  `agent.fallbackModel` and each feature's model, opening the model picker with a `set` target.
- Per agent: an agent file's `subagents:` (`SubagentDef.subagents`, `allowsSubagent`,
  `subagentsField`) lists the subagents it may run. `registry.tools(speaker)` (index.ts passes the
  agent answering: `turnSpeaker`, else `soloSpeaker`) offers `delegate` with only those;
  `agentAsMode` denies the explore tool to an agent not allowed Explore. The agent editor shows the
  section on every agent's page (`agentEditor.ts` `subagentsField`, saved like its other fields).

## Hand-offs, plan documents, chat search, loops, the guide (D329–D333)
`chatFlow.ts` registers them (one line in index.ts, after the schedules, whose service it takes).
- `handOff.ts` (+ `core/agent/handOff.ts`): `hand_off_task` { title, remaining_plan }, Claude
  Code's hand_off_to_session. A new chat (`sessions.get()`, same agent and model, not opened)
  starts at once (`sendNow`) with the plan as its first message and this conversation as hidden
  context (`forkTranscript`, D324, up to the call); the call's `detail` is that chat, drawn as a
  "Moved to a new chat" card with Open chat (`view/chatFlowCards.ts` via `turnCard`). Not
  read-only (Agent mode only); a turn tool (`TURN_TOOL_NAMES`): subagents never get it.
  propose_task (D303) offers a task; this moves work in progress.
- `planDocs.ts` (+ `core/agent/planDoc.ts`): a Plan turn's answer is saved (`savePlanDoc`, called
  where sessionTurn adds the "Plan ready" notice) as `<user config>/plans/<chat id>.md`; the latest
  such notice draws as the plan card (title, steps, "edited", folded or open with the file's
  Markdown; Build / Open to edit / Keep planning). `agent.build` sends `planBuildMessage` (the file
  as edited, else "the plan above"); in Plan mode a message carries the edited file once
  (`planEditContext` in sendCommands). Saves of the file (`files.didSave`) redraw the card.
  Commands `agent.openPlan`, `agent.keepPlanning`; state `ide://agent/planDoc`.
- `chatSearch.ts` (+ `core/agent/chatSearch.ts`: query words, scoring, snippets, ranking, tested):
  `search_chats` { query, limit } over this folder's saved chats (read once per saved version,
  by stamp) and the loaded ones, the asking chat left out: titles, user messages and answers, no
  tool output; hits name messages by number (#n). `agent.searchChats` (a box and a pick for a
  person), `agent.openChatMessage` { session, message } (→ `agent.showMessage`).
- `chatLoops.ts` (+ `core/agent/chatLoop.ts`: `/loop` arguments, the check's text, folding quiet
  checks, tested): `/loop [interval] <prompt>` (`builtinSlash` in slashCommands.ts) starts a
  loop; each next check is a one-off schedule (`ScheduleService.add`, `auto: "schedule"`) whose
  text opens with "Loop check N (/loop". Fixed: the next is set when one is sent. Self-paced:
  `schedule_wakeup` { delay_seconds 60–3600, prompt, reason, noop, stop } sets it (offered only
  in a chat with a loop); a turn that ends without it ends the loop. 7 days at most. The strip
  above the box (`LoopStrip`: pace, next check, counts, Stop = `agent.stopLoop`), check lines
  (`loopTickRow`), quiet checks folded into "N quiet checks" (`collapseQuietTicks` before
  `layoutTurns`). `agent.startLoop`; saved with the folder (`agent.loops`); `ide://agent/loops`.
- `guideTool.ts` (+ `core/agent/guideSearch.ts`): `read_guide` { query | page } over the bundled
  user guide (the help extension's `help.readDocs`, so an installed build has it); the built-in
  `guide` subagent (core/agent/subagents.ts, read-only: read_guide, find_commands, get_state;
  `GUIDE_TOOLS` keeps read_guide for read-only and background runs) answers how-to questions about
  the IDE citing the page; context.ts sends such questions to it.
## Background tasks view, WebSocket monitors (D326–D328)
- `core/agent/backgroundTasks.ts` (DOM-free, tested): `BackgroundTask` (kind subagent | helper |
  command | monitor | pr, status running | done | failed | stopped), `splitTasks` (running oldest
  first, finished newest first, minus those cleared), `chipLines` (the chip's two lines),
  `taskTime`, `stepsLabel`, `subagentTitle`, `commandStatus`, `capItems`.
- `subagentRuns.ts`: every subagent run in the window (`runSubagent` registers it: delegate,
  explore, forks, skills run in a subagent, background runs, the automatic review) with its brief,
  model, times, status, a Stop of its own and its conversation (the loop's own list, live; a
  capped copy once it ends: its brief and its last 400 items; 30 finished kept per chat). Not
  saved. `SubagentSpec` gained `title`, `agentName`, `runId`; `delegate` a `description` (3-5
  words, the row's title).
- `backgroundTasks.ts`: gathers a chat's tasks (subagent runs, worktree helpers, background
  commands and monitors, its pull request watch; `backgroundTaskSource`), commands
  `agent.showBackgroundTasks {session?, task?}` (opens the view beside the chat; `task` opens a
  transcript), `agent.stopBackgroundTask {session?, id}`, `agent.clearBackgroundTasks {session?}`
  (hides finished ones: a per-chat time; drops finished runs), state `ide://agent/background`.
- `view/backgroundTasks.ts`: the dock view `agent.backgroundTasks` (header: title, clear finished,
  expand, close; Running (N), Finished (N) folding with Show more past 10; a subagent row's title
  opens its transcript, "N tasks · 1 failed" opens its tool calls, each to its command and output;
  a command row opens to `$ command` and its output, live). Drawn whole and morphed in, clicks by
  `data-action` on the root. `view/taskTranscript.ts`: the transcript page (back, title, time,
  Stop, expand, close; the brief folded to four lines; Model; the work laid out by `turns.ts` and
  drawn by `items.ts` / `steps.ts` with a quiet `ItemHost`), finished runs too; a helper working
  in this window shows its chat, one in another window opens it.
- `view/backgroundChip.ts`: the chip under the conversation (`view.ts` puts it after the plan and
  the wrap-up). It replaced `view/processes.ts`, the strip above the message box (D326). The
  details panel's Background card links to the view.
- WebSocket monitors (D328): the `monitor` tool takes `ws: { url, protocols? }` instead of
  `command`. `monitorSocket.ts` asks first (`askToConnect`: a card with the address unless
  agent.runCommands is auto in a trusted folder or full), opens it in Rust
  (`monitorSocketIpc`, `src-tauri/src/agent/socket.rs`) and runs it as a background entry
  (`backgroundProcesses.startWith` with a `ProcessRunner`; `command` is the address, `monitor.ws`
  set). Each text frame is one event (`wsFrameEvent`: a multiline frame stays one, long ones cut
  at 2000 characters), a binary frame `[binary frame, N bytes]`, an error an event of its own;
  the close ends the watch (`monitorEndText` kind `closed`, `wsCloseLabel`). Same batching, flood
  limit and timeout as a command's.
## The command sandbox and the chat in a worktree (D336, D337)
- `sandboxRun.ts` (+ `core/agent/sandbox.ts`: `planSandbox`, `sandboxScope`,
  `looksSandboxBlocked`, `sandboxResultNote`, `sandboxStartError`; Rust `exec/sandbox.rs`):
  `agent.sandbox` auto | off. `sandboxPlanFor(services, args)` decides per command: in the
  sandbox where the system has one (`exec_sandbox_info`, read once: `loadSandboxInfo`), outside on
  `run_command { sandbox: false }`, which `askToRun` (its new `sandbox` argument) always asks, even
  with full access, never "always", with the plan's `card` line as the card's detail. run_command
  (foreground and `runInBackground`) and `monitor` pass `sandbox: true` to `execIpc.run`
  (`backgroundProcesses.start`'s new last argument); a sandboxed result ends with
  `[sandboxed: …]`, its summary with "· sandboxed", and a failure that looks like the sandbox's
  carries the retry hint. State `ide://agent/sandbox`.
- D348–D350 (`core/agent/sandboxPolicy.ts`: `sandboxPolicy`, `projectAllowances`,
  `withProjectAllowance`, `cleanHost`, `parseAllowanceArgs`; `core/agent/sandbox.ts`:
  `networkMode`, `sandboxArg`): each sandboxed command carries a policy (`currentSandboxPolicy`:
  `agent.sandbox.denyRead`, `agent.sandbox.allowWrite` / `allowHosts`, and the open folder's entry
  in `agent.sandbox.projects`, all user scope) as `execIpc.run`'s `sandbox` (an object now;
  `runInBackground` and `backgroundProcesses.start` take it too). The permission card's line says
  what's hidden, allowed and how the network is limited; the result names the hosts the network
  filter refused (`ExecResult.blockedHosts`) and what couldn't be hidden (`sandboxNotes`).
  `sandboxAllowTool.ts`: tool `suggest_sandbox_allowance { hosts?, folders?, reason }` (offered
  only while `agent.sandbox` is `auto`, `session.ts`; not to subagents), drawn by
  `view/sandboxCard.ts` (through `discoveryCards.ts`). Commands: `agent.allowSandboxSuggestion`
  (the card's Allow: writes `agent.sandbox.projects`, hidden from the agent),
  `agent.sandboxUnhideSecrets` (Windows: the hidden secrets' labels back; hidden from the agent).
- D392: the policy carries `protectFolders` (the IDE's project folder names, `PROTECT_FOLDERS`
  from product.json's `workspaceFolderName` and its aliases) for Rust's
  `exec/sandbox_protect.rs`; on Windows `exec_run` arms `git/guard.rs` instead, and
  `git.trustSettings` lets git run again.
- `chatWorktrees.ts` (+ `core/agent/chatWorktree.ts`: `chatWorktreeBranch`, `parseChatWorktree`,
  `changedFiles`, `removalLoss`, the texts): tools `enter_worktree { name?, path? }` and
  `exit_worktree { action: keep | remove }` (joined to `sessions.extraTools`). A new worktree is
  made by the worktree registry's `starter` (`headless: true`, the new `WorktreeStart.chat` so its
  record goes by the chat's id); an existing one by path gets a record when it has none. The chat's
  tools follow `setToolRoot` (as a headless helper's; the helpers' tool gate re-allows the folder);
  `chatWorktreeNote` goes with each message (`sessionTurn.ts`); `worktreeMeta` /
  `restoreChatWorktree` save and load it (`sessionStore.ts`, `meta.worktree`). Remove asks first
  (`host.ask`, danger) when `git status --porcelain` or `rev-list base..HEAD` find work. The
  header's chip is `view/worktreeChip.ts`; command `agent.chatWorktree` (review, merge, leave,
  remove); state `ide://agent/chatWorktrees`.

## Plugins, chats in other windows, notifications to the phone (D358–D360)
- `plugins.ts` (+ `core/agent/plugins.ts`: `parsePluginManifest`, `parseMarketplace`,
  `parsePluginSource`, `parseMarketplaceInput`, `pluginParts`, `substitutePluginRoot`,
  `parsePluginsFile`, `findInstalled`; Rust `ipc/plugins.rs`): Claude Code plugins. Marketplaces
  (a folder copied, or a git URL / owner/repo cloned shallow with the user's git) live in
  `<data>/plugins/marketplaces/<slug>`, installed plugins in `<data>/plugins/cache/<market>/<name>`,
  the record in `<data>/plugins/plugins.json` (`plugins_save_record`; the fs commands read the folder,
  only `plugins_copy` / `plugins_clone` / `plugins_remove` write it). `agent.installPlugin` always
  asks (`confirmWithOptions`, the hooks and MCP servers unticked, with what they run); a test run
  answers with `hooks` / `mcp`. `pluginContributions.ts` holds `activePlugins` (the enabled ones'
  folders, hooks table and servers, `${CLAUDE_PLUGIN_ROOT}` resolved), read by `skills.ts`
  (`SkillFolder.prefix`: `<plugin>:<skill>`), `slashCommands.ts` (`commandFolders(...).prefix`:
  `/<plugin>:<command>`, the plain name too; user commands), `subagents.ts` (user subagents, never
  where new ones are written), `hooks.ts` (with the user's own, no folder approval) and `mcp.ts` (a
  `settings` source labeled `plugin <name>`). `/plugin …` is an `actionSlash` handler
  (`slashCommands.ts`, run by `agent.send` instead of sending). Commands `agent.showPlugins`,
  `agent.addPluginMarketplace`, `agent.updatePluginMarketplace`, `agent.removePluginMarketplace`,
  `agent.listPlugins`, `agent.installPlugin`, `agent.uninstallPlugin`, `agent.setPluginEnabled`;
  page `pluginsPage.ts` (Customize → Plugins); state `ide://agent/plugins`.
- `chatWindows.ts` (+ `core/agent/windowChats.ts`; Rust `agent/window_chats.rs`,
  `ipc/agent_windows.rs`): list_chats and message_chat reach chats open in the IDE's other windows.
  Each window publishes its loaded chats every 4 s when they change (60 s heartbeat) to
  `<data>/agent/window-chats/<pid>.json`; `agent_windows_list` returns the other windows' records
  whose instance answers a ping (`instances::server::other_live_pids`; by age without a registry).
  A message is a mail in `<data>/agent/chat-mail/` (the D233 reports store, `reports::*_at`),
  claimed exactly once by the window that has the chat loaded (looked at every 2 s) and delivered
  with `deliverAutoMessage` as `Message from chat "T" (id) in window "folder"`; with
  notify_when_idle that window's `whenIdle` mails the idle note back. The card for one
  (`view/autoNews.ts`) names the window and doesn't open the chat here.
- `phoneNotify.ts` (+ `core/agent/webhook.ts`; Rust `ipc/notify.rs`): `agent.notify.webhook`
  { kind: ntfy | discord | slack | json, url | secret+host }. The notify tool also calls
  `sendToPhone` (its result says whether the phone got it). `notify_webhook_post` takes the URL, or
  reads the secret `notify.webhook`; https only (http to localhost), 10 s, 8 KB, headers Title /
  Tags / Priority only. Commands `agent.setNotifyWebhook`, `agent.clearNotifyWebhook`,
  `agent.testNotifyWebhook`; state `ide://agent/notifyWebhook`.

## Images in the chat (D381)
- **Chat images** (`core/agent/chatImages.ts`, tested): `media?: ChatImage[]` on assistant and
  tool items, ids `img1`, `img2`… (`nextImageId`, never reused); `toMessages` adds `imageNote`
  to the reply or the tool's result so the model knows the ids. The loop turns a stream's
  `image` events into the reply's media and a `ToolOutcome.media` into the tool item's.
- **Kept** (`previews.ts` `keepChatImages`, from `saveSessionNow`): each image once to
  `agentStoreIpc.mediaPut` (Rust `agent::media_put`, `<data>/agent/media/<chat>/<id>.bin`) and a
  preview; `itemsForSaving` drops the bytes of stored ones. `chatImageTools.ts` `chatImageBytes`
  reads them back (memory, media folder, preview).
- **View** (`view/chatImages.ts`): `chatImageGallery` under a reply (`items.ts`) or a work group
  (`view.ts` `workGallery`, cached by `galleryKey`), with a "Creating image" placeholder for a
  running generate_image (`pendingImages`, shaped by its `size`); a tool with media shows no screenshot
  thumbnails. The viewer's items take `full()` (`shots.ts`): it swaps the preview for the whole
  image and Download / Add to project use it.
- **Tools** (`chatImageTools.ts`): `save_image { image, path, overwrite? }` (in `chatTools`;
  `toolWriteTarget` from `tools.ts`; `convertImage` through a canvas) and `generate_image
  { prompt, size?, path?, reference_images? }` (in `extraTools`, off with
  `agent.imageGeneration.enabled`; `imageModel` picks `agent.imageGeneration.model`, the chat's
  model when it draws, a listed `outputImages` model, `gpt-image-1` on OpenAI; `usesImagesApi` →
  `aiIpc.generateImage`, else `aiIpc.chat` with `modalities`).
- **Models that draw:** `ModelInfo.outputImages` (OpenRouter's `output_modalities`);
  `sessionUsage.requestOptions` adds `modalities: ["image", "text"]`; Rust `openai.rs`
  `image_event` reads `delta.images` and image parts of `content`.
- **MCP / ACP:** `McpClient.call` returns `images` (image parts, embedded image resources);
  `mcp.ts` makes them media (and PNGs for vision). `acp.ts` takes an `image` content block of
  `agent_message_chunk`.
- State: `ide://agent/session` items' `images` (id, mime, name, source). Test:
  `tests/scripts/agent-images-m7-110.jsonc` (mock provider in `tests/fixtures/mock-images.mjs`).
