# How the agent works

A map of the IDE's agent: what happens on each message, everything it can use, and every switch
that changes it. ✅ means on by default and ⬜ off by default. Setting names are in `code`. The
Agents page (`agent.showAgentConfig`, D195, D286–D288) and Customize (`agent.customize`) are
diagram 3 as live screens.

## 1. One message, start to finish

```mermaid
flowchart TD
  U([You type a message]) --> C{Composer}
  C -->|"@-mentions, attached files, pastes, images"| CTX[Context added]
  C -->|"/compact, /btw, /undo… (Claude Code's slash commands, D389)"| COMPACT[Summarize, rewind, side questions]
  C -->|"dictation (agent.voice.enabled ✅:<br/>Whisper on this computer or a provider)"| C
  CS["Changeset<br/>(pending edits)"]
  CTX --> MODE{"Who answers<br/>the main agent · Plato (plans) · Gabby (asks) · yours<br/>each in a mode: Agent · Plan · Ask"}
  MODE --> WHO{"Which model?<br/>the answering agent's own<br/>(the main agent's: agent.model)"}

  WHO -->|"IDE's own models:<br/>Ollama, OpenAI-compatible, Anthropic, OpenRouter…"| LOOP
  WHO -->|"External agent over ACP:<br/>Claude Code · Codex · Gemini CLI · Copilot ·<br/>OpenCode · the ACP registry's"| ACP

  subgraph LOOP["Built-in agent loop (up to agent.maxSteps = 150)"]
    direction TB
    PROMPT["System prompt<br/>+ IDE state + rules + memory index<br/>+ repo map (agent.repoMap.enabled ✅)"]
    PROMPT --> MODEL[Model answers]
    MODEL -->|text| REPLY[Reply streams in]
    MODEL -->|tool call| GATE{"Allowed?"}
    GATE -->|read-only| RUN[Run the tool]
    GATE -->|needs a yes| CARD["Permission card:<br/>once · always · deny"]
    CARD --> RUN
    RUN --> RESULT[Result back to the model]
    RESULT --> MODEL
    MODEL -.->|"context full<br/>(agent.autoCompact ✅)"| SUM[Summarize older turns]
    SUM -.-> MODEL
  end

  subgraph ACP["External agent (its own loop)"]
    direction TB
    START["Starts as a subprocess<br/>(its own model + reasoning,<br/>agent.externalAgentChoices)"]
    START --> ITS[Its tools run]
  end
  ITS -->|"reads / writes files"| CS
  ITS -->|asks permission| CARD2[Same permission cards]

  RUN -->|"edit_file / write_file"| CS
  CS --> REVIEW{"Edit mode<br/>Review edits · Auto-apply"}
  REVIEW -->|review| DIFF["Diff tabs: accept / reject per file"]
  REVIEW -->|auto| APPLY[Applied + checkpoint]
  DIFF --> APPLY
  APPLY --> CHECK["Checks after edits<br/>agent.checkEdits ✅ · agent.verify = auto<br/>agent.formatOnFinish ⬜"]
  CHECK --> DONE([Turn ends])
  REPLY --> DONE
  DONE -->|"agent.notifyWhenDone ✅"| NOTE[Notification]
  DONE -->|"after 5 chats + 24 h<br/>(agent.memory.autoTidyUp ✅)"| DREAM["Memory tidy-up runs by itself<br/>(you review its changes before they apply)"]
```

## 2. What the agent can use

```mermaid
flowchart LR
  AG((Agent))

  AG --> FILES[Files]
  FILES --> F1[read_file]
  FILES --> F2[list_dir]
  FILES --> F3[find_files]
  FILES --> F4[search]
  FILES --> F5["edit_file / write_file<br/>→ changeset"]
  FILES --> F6["explore (subagent,<br/>agent.explore ✅)"]
  FILES --> F7["codebase_search<br/>(agent.codebaseIndex.enabled ⬜)"]
  FILES --> F8["generate_image / save_image<br/>(agent.imageGeneration.enabled ✅)"]

  AG --> SUBS["delegate (agent.delegate ✅):<br/>subagents, privately"]
  SUBS --> SB1["Explore · Plan · Review (read-only)"]
  SUBS --> SB2["General purpose (the agent's tools)"]
  SUBS --> SB3["your own: .claude/agents<br/>(the project's and your home's)"]
  SUBS --> SB4["background: true · fork: true<br/>(read-only, report comes back later)"]
  AG --> HAND["hand_off (agent.handOff ✅):<br/>another agent answers next, in the open"]
  AG --> WF["run_workflow<br/>(agent.workflows.enabled ✅)"]

  AG --> SHELL[Terminal]
  SHELL --> S1["run_command<br/>agent.runCommands: ask · auto · full"]
  S1 --> S2["agent.allowedCommands /<br/>agent.deniedCommands"]
  S1 --> S3["agent.sandbox ⬜<br/>(the OS sandbox; git settings and<br/>agent config stay read-only, D392)"]
  SHELL --> S4["process_output · kill_process · monitor"]

  AG --> IDE["The IDE itself<br/>(agent.ideControl ✅)"]
  IDE --> I1["find_commands / call_command<br/>(every IDE command)"]
  IDE --> I2["get_state (ide:// state)"]
  IDE --> I3[screenshot]

  AG --> WEB[Browser and web]
  WEB --> W1["browser_snapshot / act / inspect /<br/>console / eval / batch"]
  WEB --> W2["web_fetch<br/>(agent.webFetch.enabled ✅)"]
  WEB --> W3["web_search<br/>(agent.webSearch.provider, off)"]
  AG --> DESK["computer: desktop control, Windows<br/>(agent.computerUse.enabled ⬜)"]

  AG --> MEM[Memory]
  MEM --> M1["remember / recall<br/>(agent.memory.enabled ✅)"]
  MEM --> M2["Project memory<br/>(IDE folder/memory)"]
  MEM --> M3["User memory<br/>(every project)"]

  AG --> TALK[Talking to you]
  TALK --> T1["ask_user (choices)"]
  TALK --> T2["update_plan (to-do list)"]
  TALK --> T3["show_links · show_widget ·<br/>report_findings · wrap_up"]

  AG --> TS["tool_search: rarely used tools and many MCP tools,<br/>named only until loaded (agent.deferTools, D390)"]
  AG --> MCP["MCP servers<br/>mcp__server__tool<br/>(many: named only, tool_search loads them)"]
  MCP --> MC1["settings + user mcp.json<br/>+ Claude Code plugins' servers"]
  MCP --> MC2["IDE folder/mcp.json · .vscode/mcp.json ·<br/>.mcp.json (trusted, approved once)"]
  MCP --> MC3["Claude Desktop · Claude Code · Cursor<br/>(agent.mcp.discovery ⬜)"]
  MCP --> MC4[Extensions' servers]
```

## 3. Everything you can configure

```mermaid
flowchart LR
  ROOT((Agent))

  ROOT --> MC[Models and context]
  subgraph MCg[" "]
    MC1["Main agent · agent.model (a model or an external agent)<br/>each of your agents: one model of its own"]
    MC2["Reasoning · agent.thinking = auto<br/>Effort · agent.effort = default"]
    MC3["Context length · 16k local · 200k cloud<br/>Prompt cache · 5m"]
    MC4["Ollama ✅ · custom providers"]
    MC5["Backup model · agent.fallbackModel"]
  end
  MC --> MC1 & MC2 & MC3 & MC4 & MC5

  ROOT --> FM[Models for each feature]
  subgraph FMg[" "]
    FM1["Edit with AI ⬜"]
    FM2["Suggestions as you type ⬜"]
    FM3["Next-edit suggestions ⬜"]
    FM4["Commit messages ✅"]
    FM5["Memory tidy-up ✅"]
  end
  FM --> FM1 & FM2 & FM3 & FM4 & FM5

  ROOT --> EA[External agents]
  subgraph EAg[" "]
    EA1["Claude Code · Codex · Gemini CLI · Copilot · OpenCode"]
    EA2["Each one's model + reasoning"]
    EA3["Custom ACP agents · the ACP registry's"]
  end
  EA --> EA1 & EA2 & EA3

  ROOT --> SUB[Agents, subagents and helpers]
  subgraph SUBg[" "]
    SUB1["Explore ✅ · Plan ✅ · Review ✅ · General purpose ✅<br/>each: on/off + model (agent.subagents)"]
    SUB2["Your own agents (the agents folders)<br/>and subagents (.claude/agents)"]
    SUB3["Review automatically ⬜ (agent.autoReview)"]
    SUB4["Agents in worktrees · Review changes"]
    SUB5["Hand off to each other ✅ (agent.handOff)"]
  end
  SUB --> SUB1 & SUB2 & SUB3 & SUB4 & SUB5

  ROOT --> CV[Conversation]
  subgraph CVg[" "]
    CV1["Stream text ✅ · auto titles ✅ · rich blocks ✅"]
    CV2["Ctrl+Enter to send ⬜ · while working: queue"]
    CV3["Notify when done ✅ · dictation ✅<br/>Output style · status line · phone webhook"]
  end
  CV --> CV1 & CV2 & CV3

  ROOT --> CT[Context and tools]
  subgraph CTg[" "]
    CT1["Repo map ✅ · auto-compact ✅ · max steps 150"]
    CT2["Web fetch ✅ · auto-approve ⬜ · web search (off)"]
    CT3["Read other tools' rules ✅ · skills · plugins"]
    CT4["Memory ✅ · images ✅ · codebase index ⬜"]
  end
  CT --> CT1 & CT2 & CT3 & CT4

  ROOT --> EX[Execution and approvals]
  subgraph EXg[" "]
    EX1["Commands: ask · auto · full access<br/>Sandbox ⬜ (agent.sandbox)"]
    EX2["Allowed / denied commands · auto-approve per kind"]
    EX3["IDE control ✅ · close what it opened ⬜<br/>Desktop control ⬜ (Windows)"]
    EX4["Protection: browser ⬜ · MCP ⬜ · deletes ⬜"]
  end
  EX --> EX1 & EX2 & EX3 & EX4

  ROOT --> AP[Applying changes]
  subgraph APg[" "]
    AP1["Edit mode: review · auto-apply"]
    AP2["Check edits ✅ · verify auto"]
    AP3["Format on finish ⬜"]
    AP4["Reload browser ✅ · open dev servers ✅<br/>Follow the agent's edits ⬜ (agent.followEdits)"]
  end
  AP --> AP1 & AP2 & AP3 & AP4

  ROOT --> IN[Integrations]
  subgraph INg[" "]
    IN1["MCP servers (files + settings)"]
    IN2["Other tools' MCP servers ⬜"]
    IN3["The IDE's own MCP server ⬜"]
  end
  IN --> IN1 & IN2 & IN3
```

## 4. Working in parallel and checking work

```mermaid
flowchart LR
  MAIN[Main window] -->|New agent in a worktree| WT["git worktree<br/>branch agent/…"]
  WT --> WIN[New window: its own agent]
  WIN -->|commits| BR[(agent/… branch)]
  MAIN -->|Agent worktrees| LIST{Pick one}
  LIST --> OPEN[Open its window]
  LIST --> REV["Review with another model<br/>(Ask mode chat)"]
  LIST --> MERGE[Merge into your branch]
  LIST --> DEL[Delete worktree + branch]
  MAIN -->|Review changes| SCOPE{"uncommitted · staged ·<br/>branch · pending edits"}
  SCOPE --> REV
```

## 5. Subagents

```mermaid
flowchart TD
  A[Main agent] -->|"delegate {agent, task}"| S["Subagent<br/>own prompt · own tools · own model"]
  S -->|"reads, searches (and edits for General purpose)"| T[Tools]
  S -->|"report only"| A
  A -->|"delegate {background: true}"| B["Background subagent<br/>read-only"]
  B -.->|"report arrives as a message"| A
  A -->|"turn changed files<br/>(agent.autoReview ⬜)"| R[Review in the background]
  R -.-> A
  A -->|"hand_off {agent}"| H["Another agent (Plato, Gabby, yours)<br/>answers next in the chat, can hand back"]
```

Subagents never get `delegate` or `hand_off`. Each agent's file can list the subagents it may run
(`subagents:`; no key means all, `none` means none).

Subagent files (`.claude/agents/*.md`, in the project or your home folder) use Claude Code's
format:

```md
---
name: test-runner
description: Runs the tests and fixes what fails. Use after changing code.
tools: read_file, search, run_command      (Read, Grep, Bash… work too)
model: inherit                              (or provider/model, or sonnet / opus / haiku)
permissionMode: plan                        (optional: read-only)
maxTurns: 30                                (optional)
---
You run the project's tests…
```
