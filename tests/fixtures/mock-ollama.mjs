// A scripted stand-in for Ollama's HTTP API (/api/tags, /api/show, /api/chat streaming NDJSON,
// /api/generate with `suffix` for fill-in-the-middle),
// used by tests/scripts/agent.jsonc. Usage: node mock-ollama.mjs [port] (default 11999).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { handleImages, imagesScripted } from "./mock-images.mjs";
import { handleRemoteMcp } from "./mock-remote-mcp.mjs";
import { handleSpeech } from "./mock-speech.mjs";

const port = Number(process.argv[2] ?? 11999);
// The model the mock offers, and its context window: the website's screenshots set these to
// look like a real local model (website-handoff/screenshots.jsonc).
const modelName = process.env.MOCK_OLLAMA_MODEL || "mock-coder:1b";
const contextLength = Number(process.env.MOCK_OLLAMA_CONTEXT) || 8192;
// With a context set, token counts are estimated from the request (a quarter of its characters)
// instead of the fixed 10 / 5 the tests expect.
const estimateTokens = !!process.env.MOCK_OLLAMA_CONTEXT;

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--)
    if (messages[i].role === "user")
      // The IDE state that opens each user message (D112) isn't what the user typed.
      return (
        messages[i].content
          .replace(/<ide_state>[\s\S]*?<\/ide_state>\s*/, "")
          // A compaction summary opening the message isn't what the user typed either.
          .replace(/^Summary of the conversation so far[\s\S]*?\n\n(?=[^\n]*$)/, "")
          // The chat-title request on a chat's first message (D124).
          .replace(/\s*\(Start your reply with a short title[^\n]*\)\s*$/, "")
          .toLowerCase()
      );
  return "";
}

/** The scripted reply: { thinking?, text?, tool? }. */
/** Like a model that follows the title request (D124): the first answer opens with a title. */
function reply(messages) {
  // D174: a small model that reviews the diff instead of writing a message (as Qwen did); the
  // IDE then asks it to turn that into a message (REWRITE_SYSTEM).
  if (String(messages[0]?.content).startsWith("You turn a description of code changes"))
    return { text: "Update the review notes\n\n- Add a line asking for a review" };
  if (
    String(messages[0]?.content).startsWith("You write git commit messages") &&
    String(messages[1]?.content).includes("please-review")
  )
    return {
      text: "The diff you've provided shows changes to a notes file.\n\n---\n\n### ✅ **Key changes**\n- A line asking for a review",
    };
  // D294: a chat whose first reply came without a title is named by one short request.
  if (String(messages[0]?.content).startsWith("You name chats."))
    return {
      text: JSON.stringify(messages).includes("off by a cent")
        ? "Invoice totals off by a cent"
        : "Named by mock.",
    };
  // git.generateCommitMessage: a reasoning model's habit of thinking inline first.
  if (String(messages[0]?.content).startsWith("You write git commit messages"))
    return {
      text: "<think>The notes changed.</think>\nUpdate the notes\n\nAdd a line about tests.",
    };
  const r = scripted(messages);
  const asked = messages.some(
    (m) => m.role === "user" && String(m.content).includes("(Start your reply with a short title"),
  );
  const answered = messages.some((m) => m.role === "assistant" && m.content);
  // "no title": a model that ignores the ask (D294: the chat is then named by one request).
  const untitled = lastUser(messages).includes("no title");
  if (asked && !answered && r.text && !r.tool && !untitled && !r.text.startsWith("<title>"))
    return { ...r, text: `<title>Mock chat title</title>\n${r.text}` };
  return r;
}

/**
 * Headless helpers (helpers-headless-m7-16.jsonc): the parent delegates with isolated; the helper,
 * running in the same window, writes a file, searches and finds it, is refused an IDE command on
 * the window's folder, commits with run_command and reports what it saw; the parent's next turn
 * (the report) says whether the helper's tools all worked in its worktree. A follow-up sent while
 * it works shows up in its report. Null: not one of these.
 */
function headlessScripted(messages, user, last) {
  if (user.includes("delegate headless work") && last.role !== "tool")
    return {
      tool: {
        name: "delegate",
        arguments: {
          agent: "general",
          task: "headless-task: write helper.txt",
          isolated: true,
        },
      },
    };
  if (user.includes("report from helper"))
    return { text: `Helper reported: ${user.includes("helper-ok") ? "ok" : "not ok"}` };
  if (!user.includes("headless-task")) return null;
  const tool = last.role === "tool" ? last.tool_name : null;
  const result = (name) =>
    String(messages.findLast((m) => m.role === "tool" && m.tool_name === name)?.content ?? "");
  if (!tool)
    return {
      tool: { name: "write_file", arguments: { path: "helper.txt", content: "helper-line\n" } },
    };
  if (tool === "write_file")
    return { tool: { name: "search", arguments: { query: "helper-line" } } };
  if (tool === "search")
    return { tool: { name: "find_files", arguments: { query: "helper.txt" } } };
  if (tool === "find_files")
    return { tool: { name: "call_command", arguments: { id: "git.stageAll", input: {} } } };
  if (tool === "call_command")
    return {
      tool: {
        name: "run_command",
        arguments: {
          command:
            "git add -A && git commit -q -m helper-commit && git rev-parse --abbrev-ref HEAD && node -e \"console.log('PORT='+process.env.PORT)\"",
        },
      },
    };
  const checks = {
    search: result("search").includes("helper.txt:1"),
    find: result("find_files").includes("helper.txt"),
    refused: result("call_command").includes("not on your worktree"),
    branch: result("run_command").includes("agent/general-headless-task"),
    port: /PORT=\d+/.test(result("run_command")),
  };
  const followUp = messages.some(
    (m) => m.role === "user" && String(m.content).includes("also-note-this"),
  );
  const ok = Object.values(checks).every(Boolean);
  return {
    text: `Helper report: ${JSON.stringify(checks)}${followUp ? " follow-up seen" : ""} helper-${ok ? "ok" : "bad"}`,
  };
}

/**
 * D213 (risky-folder-m7-6.jsonc): "riskyd213 read <path>" / "riskyd213 write <path>" make one
 * read_file / write_file call and report whether it was denied; null: not one of these.
 */
function riskyScripted(user, last) {
  const m = /^riskyd213 (read|write) (\S+)/.exec(user);
  if (!m) return null;
  const name = m[1] === "read" ? "read_file" : "write_file";
  if (last.role === "tool" && last.tool_name === name) {
    const content = String(last.content);
    const verdict = content.includes("didn't allow")
      ? "denied"
      : content.includes("riskyd213-content")
        ? "read it"
        : "done";
    return { text: `Risky ${m[1]}: ${verdict}` };
  }
  return {
    tool: {
      name,
      arguments: m[1] === "read" ? { path: m[2] } : { path: m[2], content: "{}\n" },
    },
  };
}

/**
 * D207 (agentA-m7-6.jsonc): slash commands' allowed / disallowed tools, rules on a subagent's
 * reads, find_files and call_command search gated by auto-approve, "Always" saved as a pattern.
 * Every prompt starts with "agenta" so nothing else answers it; null: not one of these.
 */
function agentAScripted(user, last) {
  const tool = last.role === "tool" ? last.tool_name : null;
  const has = (s) => String(last.content).includes(s);
  if (user.includes("the user ran the command /agenta-pre"))
    return tool === "run_command"
      ? { text: `Pre: ${has("agenta-pre-ok") ? "ran" : "-"}` }
      : { tool: { name: "run_command", arguments: { command: "echo agenta-pre-ok" } } };
  if (user.includes("the user ran the command /agenta-proj"))
    return tool === "run_command"
      ? { text: `Proj: ${has("denied") ? "denied" : "ran"}` }
      : { tool: { name: "run_command", arguments: { command: "echo agenta-proj-ok" } } };
  if (user.includes("the user ran the command /agenta-nopush"))
    return tool === "run_command"
      ? { text: `Nopush: ${has("disallowed-tools") ? "refused" : "ran"}` }
      : { tool: { name: "run_command", arguments: { command: "git push origin main" } } };
  // The subagent's own conversation: its task is the user message.
  if (user.includes("agenta-sub task"))
    return tool === "read_file"
      ? { text: `Sub saw: ${has("agenta-sub-rule-marker") ? "rule" : "-"}` }
      : { tool: { name: "read_file", arguments: { path: "sub2/x.txt" } } };
  if (user.includes("agenta delegate") && !tool)
    return {
      tool: {
        name: "delegate",
        arguments: { agent: "general", task: "agenta-sub task: read sub2/x.txt and report" },
      },
    };
  if (user.includes("agenta find files"))
    return tool === "find_files"
      ? {
          text: `Found: ${has("agenta-secret") ? "secret" : "-"}/${has("agenta-open") ? "open" : "-"}/${has("protects left out") ? "noted" : "-"}`,
        }
      : { tool: { name: "find_files", arguments: { query: "agenta-" } } };
  if (user.includes("agenta search by command"))
    return tool === "call_command"
      ? {
          text: `Cmd search: ${has("agenta-secret") ? "secret" : "-"}/${has("agenta-open") ? "open" : "-"}`,
        }
      : {
          tool: {
            name: "call_command",
            arguments: { id: "search.run", input: { query: "agenta-content-marker" } },
          },
        };
  if (user.includes("agenta read the secret"))
    return tool === "read_file"
      ? { text: `Read secret: ${has("agenta-content-marker") ? "yes" : "no"}` }
      : { tool: { name: "read_file", arguments: { path: "agenta-secret.txt" } } };
  if (user.includes("agenta fetch the page"))
    return tool === "call_command"
      ? { text: `Fetched: ${has("denied") ? "denied" : "yes"}` }
      : {
          tool: {
            name: "call_command",
            arguments: { id: "web.fetch", input: { url: "http://127.0.0.1:11999/docs-site/" } },
          },
        };
  return null;
}

/** The IDE's data folder name (product.json), for the user skills folder (D221). */
const dataFolder = JSON.parse(
  readFileSync(new URL("../../product.json", import.meta.url), "utf8"),
).dataFolderName;

/**
 * D221 (agent-skills-m7-7.jsonc): skills offered with a read's result, a user skill's
 * pre-approved command, a forked skill and its subagent, a disallowed read, the editor's
 * selection through get_state, a skill written into the user folder from outside. Every prompt
 * starts with "skills221" or is a skill's / command's run; null: not one of these.
 */
function skills221Scripted(user, last) {
  const tool = last.role === "tool" ? last.tool_name : null;
  const content = String(last.content ?? "");
  const read = /^skills221 read (\S+)/.exec(user);
  if (read)
    return tool === "read_file"
      ? {
          text: `Offered: ${[...content.matchAll(/^- ([a-z0-9-]+): /gm)].map((m) => m[1]).join(",") || "none"}`,
        }
      : { tool: { name: "read_file", arguments: { path: read[1] } } };
  const pre = /the user ran the skill \/(d221-pre|d221-proj)\b/.exec(user);
  if (pre)
    return tool === "run_command"
      ? { text: `${pre[1]}: ${content.includes("d221-pre-ok") ? "ran" : "denied"}` }
      : { tool: { name: "run_command", arguments: { command: "echo d221-pre-ok" } } };
  if (user.includes("the user ran the skill /d221-fork"))
    return tool === "use_skill"
      ? {
          text: `Fork: ${content.includes("ran in a subagent") && content.includes("d221-forked-done") ? "ok" : "-"}/${content.includes("args") ? "args" : "-"}`,
        }
      : { tool: { name: "use_skill", arguments: { name: "d221-fork", arguments: "the deps" } } };
  // The forked skill's subagent: its task is the skill's instructions.
  if (user.includes("carry out the skill d221-fork"))
    return { text: `d221-forked-done ${user.includes("fork body: the deps") ? "args" : "-"}` };
  if (user.includes("the user ran the command /d221-nosecret"))
    return tool === "read_file"
      ? { text: `Nosecret: ${content.includes("disallowed-tools") ? "refused" : "read"}` }
      : { tool: { name: "read_file", arguments: { path: "secrets.txt" } } };
  if (user.startsWith("skills221 state"))
    return tool === "get_state"
      ? {
          text: `Selection: ${content.includes("d221-secret-selection") ? "shown" : content.includes("didn't allow") ? "hidden" : "?"}`,
        }
      : { tool: { name: "get_state", arguments: { path: "ide://editors/active" } } };
  if (user.startsWith("skills221 make a watched skill"))
    return tool === "run_command"
      ? { text: `Made: ${content.includes("exit 0") ? "ok" : "-"}` }
      : {
          tool: {
            name: "run_command",
            arguments: {
              // The agent's commands run in PowerShell on Windows (no mkdir -p / printf there).
              command:
                process.platform === "win32"
                  ? `$d = Join-Path $HOME '${dataFolder}\\skills\\d221-watch'; New-Item -ItemType Directory -Force $d | Out-Null; [IO.File]::WriteAllText((Join-Path $d 'SKILL.md'), (('---', 'name: d221-watch', 'description: Watched skill', '---', 'Body', '') -join [char]10))`
                  : `mkdir -p "$HOME/${dataFolder}/skills/d221-watch" && printf '%s\\n' '---' 'name: d221-watch' 'description: Watched skill' '---' 'Body' > "$HOME/${dataFolder}/skills/d221-watch/SKILL.md"`,
            },
          },
        };
  return null;
}

/** The model the request asked for (D195: plan, build and subagent models are told apart). */
let currentModel = "";
/**
 * D231 (group-m7-10.jsonc): group chats and handoffs. The member answering is named in the room
 * brief its turn carries ("You are Scout"); the chat's task is its first "grp231 …" message.
 * null: not one of these.
 */
function groupScripted(messages, user) {
  const task = messages
    .filter((m) => m.role === "user")
    .map((m) => String(m.content).toLowerCase())
    .find((c) => c.includes("grp231 "));
  if (!task) return null;
  const me = /you are (scout|forge) \(/.exec(user)?.[1];
  const own = user.includes(`${me}-instr-marker`) ? "own" : "-";
  if (task.includes("grp231 plan")) {
    if (me === "scout")
      return { text: `Scout (${own}): the plan is ready.\n@Forge can you build it?` };
    if (me === "forge")
      return {
        text: `Forge (${own}): built it after ${user.includes("scout handed") ? "Scout" : "?"}.`,
      };
  }
  if (task.includes("grp231 ping")) {
    if (me === "scout") return { text: "Scout: ping\n@Forge your turn" };
    if (me === "forge") return { text: "Forge: pong\n→ @Scout your turn" };
  }
  if (task.includes("grp231 both")) return { text: `${me ?? "?"} answered.` };
  // Handoffs in a chat with one agent: the planner's reply, then the implementer's.
  if (user.includes("grp231 implement now"))
    return { text: `Implemented by ${user.includes("forge-instr-marker") ? "forge" : "?"}` };
  if (task.includes("grp231 solo")) return { text: "Plan done: hand it to the builder." };
  return null;
}

/** FIM requests from src/counted.ts (D224's suggestion cache test). */
let countedRequests = 0;
/** Turns of the "build the demo" scenario so far (each writes into a folder of its own). */
let demoTurns = 0;

/**
 * D255 (extension-builder-m7-20.jsonc): an extension built the way the build-extension skill
 * says, a step per tool call: load the skill, create, validate, read its status, try its
 * command. The answer says what each step saw. Null: not this.
 */
function d254Scripted(messages, user, last) {
  if (!user.includes("d254 build extension")) return null;
  const tools = messages.filter((m) => m.role === "tool").map((m) => String(m.content ?? ""));
  const call = (name, args) => ({ tool: { name, arguments: args } });
  const id = "local.word-count";
  switch (tools.length) {
    case 0:
      return call("use_skill", { name: "build-extension" });
    case 1:
      return call("call_command", {
        id: "extensions.create",
        input: { name: "word-count", displayName: "Word count", description: "Counts words." },
      });
    case 2:
      return call("call_command", { id: "extensions.validate", input: { id } });
    case 3:
      return call("get_state", { path: `ide://extensions?id=${id}` });
    case 4: {
      // The command its template registered, from the extension's state.
      const command = /"([\w-]+\.hello)"/.exec(tools[3] ?? "")?.[1] ?? "word-count.hello";
      return call("call_command", { id: "extensions.try", input: { id, command } });
    }
    default: {
      const system = String(messages[0]?.content ?? "");
      return {
        text: [
          `Listed: ${system.includes("build-extension") ? "yes" : "no"}`,
          `Skill: ${(tools[0] ?? "").includes("VS Code's API here") ? "yes" : "no"}`,
          `Created: ${(tools[1] ?? "").includes(id) ? "yes" : "no"}`,
          `Valid: ${/error/i.test(tools[2] ?? "") && !/"errors":\s*\[\]/.test(tools[2] ?? "") ? "no" : "yes"}`,
          `Active: ${(tools[3] ?? "").includes('"active"') ? "yes" : "no"}`,
          `Tried: ${(tools[4] ?? "").includes("greeted") ? "yes" : "no"}`,
        ].join("; "),
      };
    }
  }
}

/**
 * Package C (agent-ask-m7-54.jsonc, agent-findings-m7-55.jsonc): ask_user with two questions (a
 * preview on the first's options), then what came back; report_findings on two of the sample's
 * files, and when asked to fix them, a re-report with outcomes. Null: not one of these.
 */
function pkgCScripted(messages, user) {
  const from = messages.findLastIndex((m) => m.role === "user");
  const results = messages
    .slice(from + 1)
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));
  if (user.includes("pkgc ask")) {
    if (!results.length)
      return {
        tool: {
          name: "ask_user",
          arguments: {
            questions: [
              {
                question: "Which auth method?",
                header: "Auth method",
                options: [
                  {
                    label: "OAuth (Recommended)",
                    description: "Sign in with GitHub",
                    preview: "```ts\nawait signIn('github')\n```",
                  },
                  {
                    label: "Password",
                    description: "A form of our own",
                    preview: "[ email    ]\n[ password ]\n[ Sign in  ]",
                  },
                ],
              },
              {
                question: "Which parts?",
                header: "Parts",
                multiSelect: true,
                options: [
                  { label: "Tests", description: "Run the suite" },
                  { label: "Docs", description: "Update the guide" },
                  { label: "Lint", description: "Biome" },
                ],
              },
            ],
          },
        },
      };
    const r = results[0] ?? "";
    const auth = /Which auth method\? → ([^\n]*)/.exec(r)?.[1] ?? "?";
    const parts = /Which parts\? → ([^\n]*)/.exec(r)?.[1] ?? "?";
    return { text: `pkgC asked: auth=${auth}; parts=${parts}` };
  }
  const findings = [
    {
      file: "src/util.ts",
      line: 2,
      summary: "The helper returns undefined for an empty list.",
      short_summary: "Empty list returns undefined",
      failure_scenario: "util([]) → undefined, and the caller crashes on .length",
      category: "correctness",
      verdict: "CONFIRMED",
    },
    {
      file: "src/main.ts",
      line: 3,
      summary: "The result is logged twice.",
      short_summary: "Logged twice",
      failure_scenario: "running main prints every line two times",
      category: "simplification",
      verdict: "PLAUSIBLE",
    },
  ];
  if (user.includes("pkgc findings"))
    return results.length
      ? { text: "pkgC reported findings." }
      : { tool: { name: "report_findings", arguments: { findings } } };
  if (user.includes("fix this review finding") || user.includes("fix these review findings"))
    return results.length
      ? { text: `pkgC fixed: ${user.includes("src/util.ts:2") ? "util" : "?"}` }
      : {
          tool: {
            name: "report_findings",
            arguments: {
              findings: [
                { ...findings[0], outcome: "fixed" },
                { ...findings[1], outcome: "no_change_needed" },
              ],
            },
          },
        };
  return null;
}

/**
 * Package B (D306-D311): the search tool's modes (agent-search-m7-50.jsonc), read before edit and
 * changed-on-disk notes (agent-read-guard-m7-51.jsonc), a cut command output read back. Also the
 * older edit scenarios ("rename the title", "break the code"), which now read the file first, as
 * the edit tools require (D309). Null: none of these.
 */
function pkgBScripted(messages, user, last) {
  const from = messages.findLastIndex((m) => m.role === "user");
  const results = messages.slice(from + 1).filter((m) => m.role === "tool");
  const text = (i) => String(results[i]?.content ?? "");
  const yes = (ok) => (ok ? "yes" : "no");
  // Read first, then the edit the scenario always made.
  const edits = [
    [
      "rename the title",
      {
        path: "README.md",
        old_string: "# Sample workspace",
        new_string: "# Renamed workspace",
      },
    ],
    [
      "break the code",
      {
        path: "src/main.ts",
        old_string: "console.log(add(total, 2));",
        new_string: "console.log(add(total, missingName));",
      },
    ],
  ];
  const edit = edits.find(([phrase]) => user.includes(phrase));
  if (edit) {
    if (!results.length) return { tool: { name: "read_file", arguments: { path: edit[1].path } } };
    if (results.length === 1 && last.role === "tool" && last.tool_name === "read_file")
      return { tool: { name: "edit_file", arguments: edit[1] } };
    return null;
  }
  if (user.includes("pkgb search")) {
    const steps = [
      { name: "search", arguments: { pattern: "hello", "-C": 1, path: "notes.txt" } },
      { name: "search", arguments: { pattern: "hello", output_mode: "count" } },
      {
        name: "search",
        arguments: { pattern: "line", output_mode: "files_with_matches", head_limit: 1 },
      },
      { name: "find_files", arguments: { query: "**/*.ts" } },
    ];
    const next = steps[results.length];
    if (next) return { tool: next };
    return {
      text: [
        `PKGB search: context=${yes(text(0).includes("notes.txt:1: hello world") && text(0).includes("notes.txt-2- second line"))}`,
        `count=${yes(/^notes\.txt:1$/m.test(text(1)) && /^README\.md:1$/m.test(text(1)))}`,
        `paging=${yes(text(2).includes("pass offset: 1"))}`,
        `glob=${yes(text(3).includes("src/main.ts") && text(3).includes("src/util.ts") && !text(3).includes("README"))}`,
      ].join(" "),
    };
  }
  if (user.includes("pkgb output")) {
    if (!results.length)
      return {
        tool: {
          name: "run_command",
          arguments: {
            command: "node -e \"for(let i=1;i<=3000;i++)console.log('row',i)\"",
          },
        },
      };
    const id = (/kept as (out\d+)/.exec(text(0)) ?? [])[1];
    if (results.length === 1 && id)
      return { tool: { name: "process_output", arguments: { id, offset: 1500, limit: 2 } } };
    return {
      text: `PKGB output: kept=${yes(!!id)} read=${yes(/1500\| row 1500\n\s+1501\| row 1501/.test(text(1)))}`,
    };
  }
  if (user.includes("pkgb guard edit")) {
    const steps = [
      {
        name: "edit_file",
        arguments: { path: "pkgb-guard.txt", old_string: "alpha", new_string: "ALPHA" },
      },
      { name: "read_file", arguments: { path: "pkgb-guard.txt" } },
      {
        name: "edit_file",
        arguments: { path: "pkgb-guard.txt", old_string: "alpha", new_string: "ALPHA" },
      },
    ];
    const next = steps[results.length];
    if (next) return { tool: next };
    return {
      text: `PKGB guard: refused=${yes(text(0).includes("haven't read pkgb-guard.txt"))} edited=${yes(!text(2).startsWith("Error"))}`,
    };
  }
  if (user.includes("pkgb guard notice")) {
    // The note with the user's message: the file changed while the agent waited.
    const raw = String(messages[from]?.content ?? "");
    const steps = [
      {
        name: "run_command",
        arguments: {
          command:
            "node -e \"require('fs').appendFileSync('pkgb-guard.txt','delta'+String.fromCharCode(10))\"",
        },
      },
      // Shown whole, the change counts as read: this edit needs no new read.
      {
        name: "edit_file",
        arguments: { path: "pkgb-guard.txt", old_string: "gamma", new_string: "GAMMA" },
      },
    ];
    const next = steps[results.length];
    if (next) return { tool: next };
    return {
      text: [
        `PKGB notice: between=${yes(raw.includes("pkgb-guard.txt changed since you last read it") && raw.includes("+gamma"))}`,
        `mid=${yes(text(0).includes("pkgb-guard.txt changed since you last read it") && text(0).includes("+delta"))}`,
        `edit=${yes(!text(1).startsWith("Error"))}`,
      ].join(" "),
    };
  }
  return null;
}

/**
 * D322–D325 (agent-monitor-m7-66, agent-chats-m7-67, agent-prwatch-m7-68): a monitor whose
 * events and end come back as messages, one that expires; another chat messaged (list_chats,
 * then message_chat with notify_when_idle) and its idle note; a pull request watched, its news.
 * Null: not one of these.
 */
function pkgFScripted(messages, user, last) {
  const since = messages.slice(messages.findLastIndex((m) => m.role === "user") + 1);
  const results = since.filter((m) => m.role === "tool").map((m) => String(m.content ?? ""));
  const allUser = messages
    .filter((m) => m.role === "user")
    .map((m) => String(m.content))
    .join("\n")
    .toLowerCase();
  // ---- monitor ----
  if (user.includes("pkgf monitor"))
    return last.role !== "tool"
      ? {
          tool: {
            name: "monitor",
            arguments: {
              command:
                "node -e \"setTimeout(()=>{console.log('pkgf-event one');console.log('pkgf-event two')},1500);setTimeout(()=>process.exit(0),8000)\"",
              description: "pkgf events",
              timeout_ms: 60000,
            },
          },
        }
      : {
          text: `PkgF monitor started: ${String(last.content).includes("Monitor bg") ? "yes" : "no"}`,
        };
  if (user.includes("(pkgf events) ended"))
    return {
      text: `PkgF monitor ended; events seen: ${allUser.includes("pkgf-event two") ? "yes" : "no"}`,
    };
  if (user.includes("(pkgf events):"))
    return { text: `PkgF events: ${(user.match(/pkgf-event/g) ?? []).length}` };
  if (user.includes("pkgf expire"))
    return last.role !== "tool"
      ? {
          tool: {
            name: "monitor",
            arguments: {
              command: 'node -e "setInterval(()=>{},1000)"',
              description: "pkgf expiry",
              timeout_ms: 5000,
            },
          },
        }
      : { text: "PkgF expiring monitor started" };
  if (user.includes("(pkgf expiry) expired")) return { text: "PkgF saw the expiry" };
  // ---- messages between chats ----
  // The relayed message first: it names the sending chat, whose title is "pkgF message a chat".
  if (user.includes("message from chat") && user.includes("pkgf-relay"))
    return { text: "PkgF relay answered" };
  if (user.includes("pkgf message a chat")) {
    if (results.length === 0) return { tool: { name: "list_chats", arguments: {} } };
    if (results.length === 1) {
      const id = /^(s[0-9a-z]+) ·/m.exec(results[0] ?? "")?.[1] ?? "none";
      return {
        tool: {
          name: "message_chat",
          arguments: {
            chat: id,
            message: "pkgF-relay: please say hi",
            notify_when_idle: true,
          },
        },
      };
    }
    return { text: `PkgF sent: ${(results[1] ?? "").startsWith("Sent to") ? "yes" : "no"}` };
  }
  if (user.includes("is idle now"))
    return {
      text: `PkgF got the idle note: ${user.includes("pkgf relay answered") ? "with the answer" : "no answer"}`,
    };
  // ---- pull request watch ----
  if (user.includes("pkgf watch pr"))
    return last.role !== "tool"
      ? { tool: { name: "watch_pr", arguments: { number: 7 } } }
      : { text: `PkgF watching: ${String(last.content).startsWith("Watching #7") ? "yes" : "no"}` };
  if (user.startsWith("pull request #7")) {
    if (user.includes(": merged")) return { text: "PkgF PR merged" };
    return {
      text: `PkgF PR news: failed=${/checks? failed/.test(user) ? "yes" : "no"} comment=${user.includes("please add a test") ? "yes" : "no"}`,
    };
  }
  return null;
}

/**
 * pkgD (browser-agent-m7-58.jsonc, D316–D318): the browser tools Claude Code's match, on the mock
 * dev server's /agent-lab.html: find, a batch of input by coordinate, page text, the script runner,
 * dark mode and tabs. Each answer says what the tool results showed.
 */
function pkgDScripted(messages, user) {
  if (!user.includes("pkgd ")) return null;
  const results = messages
    .slice(messages.findLastIndex((m) => m.role === "user"))
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content ?? ""));
  const step = (list, answer) => {
    const next = list[results.length];
    return next ? { tool: next } : { text: answer() };
  };
  const at = (i) => results[i] ?? "";
  if (user.includes("pkgd find"))
    return step([{ name: "browser_snapshot", arguments: { find: "count clicks" } }], () => {
      const ref = /button "Count clicks" \[ref=(e\d+)\]/.exec(at(0));
      return `pkgD find: ${ref ? "found" : `missing ${at(0).slice(0, 300)}`}`;
    });
  if (user.includes("pkgd batch"))
    return step(
      [
        {
          name: "browser_batch",
          arguments: {
            actions: [
              {
                name: "browser_act",
                input: {
                  action: "left_click",
                  coordinate: [80, 28],
                  action_summary: "Clicks the counter",
                },
              },
              { name: "browser_act", input: { action: "double_click", coordinate: [80, 28] } },
              { name: "browser_act", input: { action: "right_click", coordinate: [80, 28] } },
              { name: "browser_act", input: { action: "left_click", coordinate: [240, 25] } },
              { name: "browser_act", input: { action: "type", text: "hello" } },
              { name: "browser_act", input: { action: "key", key: "Backspace", repeat: 2 } },
              { name: "browser_act", input: { action: "key", key: "shift+Enter" } },
              {
                name: "browser_act",
                input: { action: "drag", start_coordinate: [50, 75], coordinate: [240, 90] },
              },
              {
                name: "browser_act",
                input: {
                  action: "scroll",
                  coordinate: [85, 170],
                  scroll_direction: "down",
                  scroll_amount: 2,
                },
              },
              { name: "screenshot", input: { region: [0, 0, 200, 150], scale: 0.5 } },
            ],
          },
        },
      ],
      () => {
        const r = at(0);
        const stopped = /Stopped at step (\d+)/.exec(r);
        return `pkgD batch: ${stopped ? `stopped at ${stopped[1]}: ${r.slice(-400)}` : r.includes("[10] screenshot") ? "all ran" : `odd ${r.slice(0, 300)}`}`;
      },
    );
  if (user.includes("pkgd stop"))
    return step(
      [
        {
          name: "browser_batch",
          arguments: {
            actions: [
              { name: "browser_act", input: { action: "click", ref: "e99999" } },
              { name: "browser_act", input: { action: "reload" } },
            ],
          },
        },
      ],
      () =>
        `pkgD stop: ${at(0).includes("Stopped at step 1 of 2") ? "stopped at 1" : at(0).slice(0, 300)}`,
    );
  if (user.includes("pkgd text"))
    return step([{ name: "browser_snapshot", arguments: { text: true, max_chars: 2000 } }], () =>
      at(0).includes("Text of its main content") && at(0).includes("input tools are tried")
        ? "pkgD text: main"
        : `pkgD text: ${at(0).slice(0, 300)}`,
    );
  if (user.includes("pkgd eval"))
    return step(
      [
        {
          name: "browser_eval",
          arguments: { code: "const r = await Promise.resolve(21);\nr * 2" },
        },
        { name: "browser_eval", arguments: { code: "document.getElementById('log').textContent" } },
        { name: "browser_eval", arguments: { code: "missingThing.x" } },
      ],
      () => {
        const value = /number: (\d+)/.exec(at(0))?.[1] ?? at(0).slice(0, 200);
        const log = /string: "([^"]*)"/.exec(at(1))?.[1] ?? at(1).slice(0, 300);
        const error = at(2).includes("ReferenceError") ? "ReferenceError" : at(2).slice(0, 200);
        return `pkgD eval: ${value} | log: ${log} | error: ${error}`;
      },
    );
  if (user.includes("pkgd dark"))
    return step(
      [
        { name: "browser_inspect", arguments: { what: "resize", colorScheme: "dark" } },
        {
          name: "browser_eval",
          arguments: {
            code: "[getComputedStyle(document.body).backgroundColor, matchMedia('(prefers-color-scheme: dark)').matches]",
          },
        },
        { name: "browser_inspect", arguments: { what: "resize", colorScheme: "auto" } },
      ],
      () =>
        `pkgD dark: ${at(1)
          .replace(/\s+/g, " ")
          .replace(/^.*?array: /, "")}`,
    );
  if (user.includes("pkgd tabs")) {
    const opened = /"tab":\s*"([^"]+)"/.exec(at(0))?.[1] ?? "none";
    return step(
      [
        {
          name: "browser_act",
          arguments: { action: "new_tab", url: "http://localhost:11998/about" },
        },
        { name: "browser_inspect", arguments: { what: "tabs" } },
        { name: "browser_act", arguments: { action: "close_tab", tab: opened } },
      ],
      () => {
        const listed = (at(1).match(/^- /gm) ?? []).length;
        const current = at(1).includes(`${opened} (current`) ? "new is current" : "not current";
        return `pkgD tabs: ${listed} listed, ${current}, ${at(2).includes('"closed": true') ? "closed" : at(2).slice(0, 200)}`;
      },
    );
  }
  return null;
}

/** pkgK's workflow script: two scouts in parallel, then a judge with a schema. */
function pkgKScript(judge) {
  return [
    "export const meta = { name: 'pkgk-demo', description: 'PkgK demo: two scouts, then a judge', phases: [{ title: 'Scout' }, { title: 'Judge' }] }",
    "const found = await parallel(['alpha', 'beta'].map((k) => () => agent('pkgk-scout ' + k + ': name one file', { label: 'scout ' + k, phase: 'Scout' })))",
    "log('scouts done: ' + found.length)",
    `const verdict = await agent('${judge}: pick one of ' + found.join(' | '), { label: 'judge', phase: 'Judge', schema: { type: 'object', properties: { pick: { type: 'string' } }, required: ['pick'] } })`,
    "return { found, verdict }",
  ].join("\n");
}

/**
 * pkgP (agent-workflow-edit-m7-93, agent-automerge-m7-94; D351, D352): a workflow whose one agent
 * edits in a worktree of its own (it writes pkgp.txt there; its end message names its branch and
 * changes), and watch_pr's auto_merge (the IDE merges the pull request once it's ready and says
 * so). Null: not one of these.
 */
function pkgPScripted(messages, user, last) {
  if (String(messages[0]?.content ?? "").startsWith("You compress a coding agent")) return null;
  // The workflow's editing agent: its own chat, in its worktree.
  if (user.includes("pkgp-editor: write pkgp.txt"))
    return last.role === "tool" && last.tool_name === "write_file"
      ? { text: "pkgp edited pkgp.txt" }
      : { tool: { name: "write_file", arguments: { path: "pkgp.txt", content: "pkgp-line\n" } } };
  if (user.includes("(pkgp-edit) finished"))
    return {
      text: `PkgP workflow: branch=${/branch agent\/general-pkgp-editor/.test(user) ? "yes" : "no"}, changed=${user.includes("1 file changed") ? "yes" : "no"}, said=${user.includes("pkgp edited pkgp.txt") ? "yes" : "no"}`,
    };
  if (user.includes("pkgp run an editing workflow"))
    return last.role !== "tool"
      ? {
          tool: {
            name: "run_workflow",
            arguments: {
              script: [
                "export const meta = { name: 'pkgp-edit', description: 'PkgP: one agent edits in a worktree', phases: [{ title: 'Edit' }] }",
                "const r = await agent('pkgp-editor: write pkgp.txt', { label: 'pkgp editor', phase: 'Edit', isolation: 'worktree', files: ['pkgp.txt'] })",
                "return { branch: r && r.branch, changes: r && r.changes, said: r && r.result }",
              ].join("\n"),
            },
          },
        }
      : {
          text: `PkgP workflow started: ${String(last.content).includes("started in the background") ? "yes" : "no"}`,
        };
  // Auto-merge: the IDE's message when it merged it.
  if (user.includes("merged by auto-merge (squash)")) return { text: "PkgP merged: yes" };
  if (user.includes("pkgp auto-merge pr"))
    return last.role !== "tool"
      ? { tool: { name: "watch_pr", arguments: { action: "auto_merge", method: "squash" } } }
      : {
          text: `PkgP auto-merge: ${String(last.content).includes("Auto-merge is on for #7") ? "on" : "off"} (${String(last.content).includes("the IDE merges it") ? "by the IDE" : "by GitHub"})`,
        };
  return null;
}

/**
 * pkgK (agent-workflow-m7-81.jsonc, D338): run_workflow with a two-phase script of three agents
 * whose answers are fixed (the scouts' text, the judge's JSON); the end message's result is read
 * back. "pkgk resume" runs it again with the judge's prompt changed: the scouts come from the
 * cache. Null: not one of these.
 */
function pkgKScripted(messages, user, last) {
  // A compaction request quotes the conversation: not ours.
  if (String(messages[0]?.content ?? "").startsWith("You compress a coding agent")) return null;
  // The workflow's end, as an automatic message.
  if (user.includes("(pkgk-demo) finished"))
    return {
      text: `PkgK result: pick=${user.includes('"pick": "pkgk found alpha.txt"') ? "alpha" : "none"}, cached=${/(\d+) cached/.exec(user)?.[1] ?? 0}`,
    };
  // The workflow's agents (each prompt is its subagent's task).
  if (user.includes("pkgk-judge")) return { text: '{"pick": "pkgk found alpha.txt"}' };
  const scout = /pkgk-scout (alpha|beta)/.exec(user);
  if (scout) return { text: `pkgk found ${scout[1]}.txt` };
  if (user.includes("pkgk run a workflow"))
    return last.role !== "tool"
      ? { tool: { name: "run_workflow", arguments: { script: pkgKScript("pkgk-judge") } } }
      : {
          text: `PkgK workflow started: ${String(last.content).includes("started in the background") ? "yes" : "no"}`,
        };
  if (user.includes("pkgk resume the workflow")) {
    const id = messages
      .map((m) => /Workflow (wf\d+) \(pkgk-demo\) started/.exec(String(m.content))?.[1])
      .find(Boolean);
    return last.role !== "tool"
      ? {
          tool: {
            name: "run_workflow",
            arguments: { script: pkgKScript("pkgk-judge again"), resume_from: id ?? "wf1" },
          },
        }
      : {
          text: `PkgK resumed: ${String(last.content).includes("reusing") ? "yes" : "no"}`,
        };
  }
  return null;
}

/**
 * pkgM (agent-skills-suggest-m7-85, agent-mcp-discover-m7-86; D342, D343): suggest_skill, the
 * same again (refused: once per conversation), suggest_mcp_server, mcp_status. Each answer says
 * what its tool returned. Null: not one of these.
 */
/**
 * The card gallery (agent-card-gallery.jsonc): the cards no package scenario shows, an Open VSX
 * extension card and the plan-first question. Null: not one of these.
 */
function galleryScripted(messages, user) {
  if (!user.includes("gallery ")) return null;
  const from = messages.findLastIndex((m) => m.role === "user");
  const results = messages.slice(from + 1).filter((m) => m.role === "tool");
  if (user.includes("gallery extension"))
    return results.length
      ? { text: "Gallery: an extension card." }
      : {
          tool: {
            name: "suggest_extension",
            arguments: { query: "prettier", reason: "Formats the code on save" },
          },
        };
  if (user.includes("gallery plan first"))
    return results.length
      ? { text: "Gallery: going on without a plan." }
      : {
          tool: {
            name: "enter_plan_mode",
            arguments: { reason: "Several files change: worth agreeing on the approach first." },
          },
        };
  return null;
}

function pkgMScripted(messages, user) {
  if (!user.includes("pkgm ")) return null;
  const from = messages.findLastIndex((m) => m.role === "user");
  const result = messages
    .slice(from + 1)
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content))[0];
  const call = (name, args) => ({ tool: { name, arguments: args } });
  const shown = (r) => /card: ([^.]*)\./.exec(r)?.[1] ?? r.slice(0, 160);
  if (user.includes("pkgm suggest a skill")) {
    if (result === undefined)
      return call("suggest_skill", {
        keywords: ["release notes", "pkgm house style"],
        reason: "Release notes in your house style, every release",
      });
    return { text: `PkgM skill card: ${shown(result)}` };
  }
  if (user.includes("pkgm once more please")) {
    if (result === undefined)
      return call("suggest_skill", { keywords: ["release notes"], reason: "Again" });
    return { text: `PkgM again: ${result.includes("already suggested") ? "refused" : "shown"}` };
  }
  if (user.includes("pkgm find a weather server")) {
    if (result === undefined)
      return call("suggest_mcp_server", {
        query: "weather forecast",
        reason: "Live forecasts for the trip planner",
      });
    return { text: `PkgM servers: ${shown(result)}` };
  }
  if (user.includes("pkgm check the mcp servers")) {
    if (result === undefined) return call("mcp_status", {});
    const broken = /- pkgm-broken: (\w+)/.exec(result)?.[1] ?? "missing";
    return { text: `PkgM status: pkgm-broken ${broken}` };
  }
  return null;
}

/**
 * pkgI (agent-widget-m7-77.jsonc, agent-ask-skip-m7-78.jsonc, D334-D335): widget_guide, then an
 * SVG widget and an HTML one whose button calls sendPrompt; the widget's message answered; an
 * ask_user card skipped, and two questions (one skipped) sent with Ctrl+Enter. Null: not these.
 */
function pkgIScripted(messages, user) {
  if (!user.includes("pkgi ")) return null;
  const from = messages.findLastIndex((m) => m.role === "user");
  const results = messages
    .slice(from + 1)
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));
  if (user.includes("pkgi widget clicked")) return { text: "PkgI got the widget's message." };
  if (user.includes("pkgi widgets")) {
    if (results.length === 0) return { tool: { name: "widget_guide", arguments: {} } };
    if (results.length === 1)
      return {
        tools: [
          {
            name: "show_widget",
            arguments: {
              title: "pkgi_chart",
              loading_messages: ["Plotting the bars"],
              widget_code:
                '<svg viewBox="0 0 320 120" role="img" aria-label="Three bars"><rect x="20" y="60" width="60" height="50" style="fill: var(--label-1)"/><rect x="130" y="30" width="60" height="80" style="fill: var(--label-2)"/><rect x="240" y="10" width="60" height="100" style="fill: var(--label-3)"/><line x1="10" y1="110" x2="310" y2="110" style="stroke: var(--border-subtle)"/></svg>',
            },
          },
          {
            name: "show_widget",
            arguments: {
              title: "pkgi_counter",
              loading_messages: ["Wiring the button"],
              widget_code:
                '<style>.row { display: flex; gap: 8px; align-items: center; padding: 4px 0; }</style><div class="row"><button id="ask">Ask about 3</button><span id="state">ready</span></div><script>document.getElementById("ask").addEventListener("click", () => { document.getElementById("state").textContent = "sent"; sendPrompt("PkgI widget clicked: 3"); });</script>',
            },
          },
        ],
      };
    return { text: "PkgI drew two widgets." };
  }
  if (user.includes("pkgi ask skip")) {
    if (!results.length)
      return {
        tool: {
          name: "ask_user",
          arguments: {
            questions: [
              {
                question: "Which color?",
                header: "Color",
                options: [
                  { label: "Red", description: "Warm" },
                  { label: "Blue", description: "Cool" },
                ],
              },
            ],
          },
        },
      };
    return { text: `PkgI ask result: ${results[0]}` };
  }
  if (user.includes("pkgi ask two")) {
    if (!results.length)
      return {
        tool: {
          name: "ask_user",
          arguments: {
            questions: [
              {
                question: "Which color?",
                header: "Color",
                options: [
                  { label: "Red", description: "Warm" },
                  { label: "Blue", description: "Cool" },
                ],
              },
              {
                question: "Which sizes?",
                header: "Sizes",
                multiSelect: true,
                options: [
                  { label: "Small", description: "S" },
                  { label: "Medium", description: "M" },
                  { label: "Large", description: "L" },
                ],
              },
            ],
          },
        },
      };
    const r = results[0] ?? "";
    const color = /Which color\? → ([^\n]*)/.exec(r)?.[1] ?? "?";
    const sizes = /Which sizes\? → ([^\n]*)/.exec(r)?.[1] ?? "?";
    return { text: `PkgI ask two: color=${color} sizes=${sizes}` };
  }
  return null;
}

/**
 * pkgN (browser-trusted-m7-90.jsonc, D346) on the mock dev server's /trusted.html: the agent
 * clicks the button and types into the field with browser_act; each answer says whether the
 * result reported trusted input.
 */
function pkgNScripted(messages, user) {
  if (!user.includes("pkgn ")) return null;
  const results = messages
    .slice(messages.findLastIndex((m) => m.role === "user"))
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content ?? ""));
  const at = (i) => results[i] ?? "";
  const trusted = (text) => (/"input":\s*"trusted"/.test(text) ? "trusted" : text.slice(0, 300));
  const act = (args, label) =>
    results.length
      ? { text: `pkgN ${label}: ${trusted(at(0))}` }
      : { tool: { name: "browser_act", arguments: args } };
  if (user.includes("pkgn press the button"))
    return act(
      { action: "click", selector: "#hit", action_summary: "Presses the button" },
      "press",
    );
  if (user.includes("pkgn type in the field"))
    return act({ action: "type", selector: "#field", text: "Hi" }, "type");
  return null;
}

/**
 * pkgL (browser-upload-m7-82.jsonc, browser-gif-m7-83.jsonc; D339, D340) on the mock dev
 * server's /upload.html: a workspace file into the file input, a screenshot dropped on the drop
 * zone, a path outside the workspace refused, and a short recording. Each answer says what the
 * tool results showed.
 */
function pkgLScripted(messages, user) {
  if (!user.includes("pkgl ")) return null;
  const results = messages
    .slice(messages.findLastIndex((m) => m.role === "user"))
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content ?? ""));
  const at = (i) => results[i] ?? "";
  const step = (list, answer) => {
    const next = list[results.length];
    return next ? { tool: next } : { text: answer() };
  };
  if (user.includes("pkgl upload"))
    return step(
      [
        {
          name: "browser_act",
          arguments: {
            action: "upload",
            selector: "#photo",
            files: ["upload-me.txt"],
            action_summary: "Picks the file",
          },
        },
      ],
      () => `pkgL upload: ${at(0).includes("upload-me.txt") ? "set" : at(0).slice(0, 300)}`,
    );
  if (user.includes("pkgl drop")) {
    const shot = /\(id (shot\d+)\)/.exec(at(0))?.[1] ?? "none";
    return step(
      [
        { name: "screenshot", arguments: { target: "page", scale: 0.5 } },
        {
          name: "browser_act",
          arguments: { action: "upload", selector: "#zone", screenshot: shot },
        },
      ],
      () =>
        `pkgL drop: ${at(1).includes("dropped") && at(1).includes(shot) ? "dropped" : at(1).slice(0, 300)}`,
    );
  }
  if (user.includes("pkgl outside"))
    return step(
      [
        {
          name: "browser_act",
          arguments: { action: "upload", selector: "#photo", files: ["../outside.txt"] },
        },
      ],
      () =>
        `pkgL outside: ${at(0).includes("outside the workspace") ? "refused" : at(0).slice(0, 300)}`,
    );
  if (user.includes("pkgl record"))
    return step(
      [
        { name: "browser_act", arguments: { action: "start_recording" } },
        {
          name: "browser_act",
          arguments: { action: "click", selector: "#count", action_summary: "Counts a click" },
        },
        { name: "browser_act", arguments: { action: "wait", duration: 1.5 } },
        {
          name: "browser_act",
          arguments: {
            action: "left_click",
            coordinate: [40, 60],
            action_summary: "Clicks by point",
          },
        },
        { name: "browser_act", arguments: { action: "stop_recording" } },
      ],
      () => {
        const frames = Number(/Recorded (\d+) frames?/.exec(at(4))?.[1] ?? 0);
        return `pkgL record: ${frames >= 2 ? "gif" : at(4).slice(0, 300)}`;
      },
    );
  return null;
}

/**
 * pkgH (D329-D333): a task handed off to a new chat, which carries on with the conversation
 * (agent-handoff-m7-73); Plan mode's plan as a document, built as the user edited it
 * (agent-plandoc-m7-74); search_chats finding another chat (agent-search-chats-m7-75); a
 * self-paced loop: a wake-up, two quiet checks, then stop (agent-loop-m7-76). Null: not one.
 */
function pkgHScripted(messages, user) {
  if (!user.includes("pkgh")) return null;
  const from = messages.findLastIndex((m) => m.role === "user");
  const results = messages
    .slice(from + 1)
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));
  const call = (name, args) => ({ tool: { name, arguments: args } });
  // The new chat a task was handed to: its first message is the plan (checked before the
  // hand-off's own trigger, which its attached conversation quotes).
  if (user.includes("pkgh-continue")) {
    if (results.length === 0) return call("list_dir", { path: "." });
    return {
      text: `PkgH carried on (${user.includes("<conversation>") && user.includes("pkgh handoff") ? "with" : "without"} the conversation).`,
    };
  }
  if (user.includes("pkgh handoff")) {
    if (results.length === 0)
      return {
        text: "**Moving the long task to its own chat.** It carries on there while I answer you.",
        tool: {
          name: "hand_off_task",
          arguments: {
            title: "Pkgh long task",
            remaining_plan: "pkgh-continue: list the folder, then report what is in it.",
          },
        },
      };
    return {
      text: `PkgH answered the new question (${(results[0] ?? "").startsWith("Handed off") ? "handed off" : "not handed off"}).`,
    };
  }
  if (user.includes("pkgh plan doc"))
    return {
      text: "# Pkgh plan\n\n1. Write the readme\n2. Check that it reads well",
    };
  if (user.includes("build it: carry out the plan"))
    return {
      text: `PkgH built the ${user.includes("pkgh-user-edit") ? "edited" : "original"} plan.`,
    };
  if (user.includes("pkgh zebra notes")) return { text: "PkgH noted the zebra crossing." };
  if (user.includes("pkgh search chats")) {
    if (results.length === 0) return call("search_chats", { query: "zebra crossing", limit: 3 });
    const found = results[0] ?? "";
    return {
      text: `PkgH search: ${found.includes("#1 (user)") && found.includes("zebra") ? "found the zebra chat" : `nothing (${found.slice(0, 80)})`}.`,
    };
  }
  if (user.includes("pkgh loop")) {
    const n = Number(/loop check (\d+) \(\/loop/.exec(user)?.[1] ?? 1);
    if (results.length === 0) {
      const args = {
        delay_seconds: 120,
        prompt: "pkgh loop check the build",
        reason: "Builds take a few minutes.",
      };
      if (n >= 4)
        return call("schedule_wakeup", { ...args, stop: true, reason: "The build is green." });
      return call("schedule_wakeup", { ...args, ...(n >= 2 && { noop: true }) });
    }
    return { text: `PkgH loop check ${n} done.` };
  }
  return null;
}

/**
 * pkgG (agent-bgtasks-m7-70 / m7-71, D326–D328): the Background tasks view. A background subagent
 * that calls a tool, has one fail, then waits a long time (so the test sees it running and stops
 * it) beside a background command that keeps printing; a quick foreground subagent and two
 * background commands that end (one fails); a monitor over the mock dev server's WebSocket.
 * Null: not one of these.
 */
function pkgGScripted(messages, user, last) {
  const since = messages.slice(messages.findLastIndex((m) => m.role === "user") + 1);
  const results = since.filter((m) => m.role === "tool").map((m) => String(m.content ?? ""));
  // ---- the subagents' own conversations (their brief is their user message) ----
  if (user.includes("pkgg-sub:")) {
    if (results.length === 0) return { tool: { name: "list_dir", arguments: { path: "." } } };
    if (results.length === 1)
      return { tool: { name: "read_file", arguments: { path: "pkgg-missing-file.txt" } } };
    // Long enough for the test to look at it running; it's stopped before this answers.
    return { delayMs: 90000, text: "PkgG sub report: done." };
  }
  if (user.includes("pkgg-quick:"))
    return results.length === 0
      ? { tool: { name: "list_dir", arguments: { path: "." } } }
      : { text: "PkgG quick report: the folder is there." };
  // ---- m7-70: a background subagent and a background command ----
  if (user.includes("pkgg start work")) {
    if (last.role !== "tool")
      return {
        tools: [
          {
            name: "delegate",
            arguments: {
              agent: "general",
              description: "Pkgg probe task",
              task: "pkgg-sub: look at the folder and report.",
              background: true,
            },
          },
          {
            name: "run_command",
            arguments: {
              command:
                "node -e \"console.log('pkgg-tick');setInterval(()=>console.log('pkgg-tick'),1000)\"",
              background: true,
            },
          },
        ],
      };
    return { text: "PkgG started both." };
  }
  // ---- m7-71: finished tasks ----
  if (user.includes("pkgg quick work")) {
    if (results.length === 0)
      return {
        tool: {
          name: "delegate",
          arguments: {
            agent: "general",
            description: "Pkgg quick check",
            task: "pkgg-quick: list the folder.",
          },
        },
      };
    if (results.length === 1)
      return {
        tools: [
          {
            name: "run_command",
            arguments: { command: "node -e \"console.log('pkgg-ok')\"", background: true },
          },
          {
            name: "run_command",
            arguments: { command: 'node -e "process.exit(3)"', background: true },
          },
        ],
      };
    return { text: "PkgG quick done." };
  }
  // ---- m7-71: a monitor over a WebSocket (the mock dev server's /pkgg-events) ----
  if (user.includes("pkgg watch socket"))
    return last.role !== "tool"
      ? {
          tool: {
            name: "monitor",
            arguments: {
              ws: { url: "ws://127.0.0.1:11998/pkgg-events" },
              description: "pkgg frames",
              timeout_ms: 60000,
            },
          },
        }
      : {
          text: `PkgG socket monitor started: ${String(last.content).includes("Monitor bg") ? "yes" : "no"}`,
        };
  if (user.includes("(pkgg frames) ended"))
    return {
      text: `PkgG socket closed: ${user.includes("code 1000") && user.includes("pkgg done") ? "yes" : "no"}`,
    };
  if (user.includes("(pkgg frames):"))
    return {
      text: `PkgG frames: ${(user.match(/pkgg-frame/g) ?? []).length}, multiline: ${user.includes("pkgg-frame two\nsecond line") ? "yes" : "no"}, binary: ${user.includes("[binary frame, 5 bytes]") ? "yes" : "no"}`,
    };
  return null;
}

/**
 * pkgJ (agent-sandbox-m7-79.jsonc, agent-worktree-m7-80.jsonc; D336, D337): a sandboxed command
 * that writes next to the folder is refused, then run outside the sandbox (which asks); the chat
 * enters a worktree, writes and commits there, and leaves it (kept). Null: not one of these.
 */
function pkgJScripted(messages, user) {
  if (!user.includes("pkgj ")) return null;
  const from = messages.findLastIndex((m) => m.role === "user");
  const results = messages
    .slice(from + 1)
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));
  const call = (name, args) => ({ tool: { name, arguments: args } });
  if (user.includes("pkgj sandbox write outside")) {
    const write =
      "node -e \"require('fs').writeFileSync('../pkgj-outside.txt','x');console.log('pkgj-'+'wrote')\"";
    if (results.length === 0) return call("run_command", { command: write });
    if (results.length === 1) return call("run_command", { command: write, sandbox: false });
    const first = results[0] ?? "";
    const second = results[1] ?? "";
    return {
      text: [
        "PkgJ sandbox:",
        `blocked=${!first.includes("pkgj-wrote") && first.includes("[sandboxed:") ? "yes" : "no"}`,
        `hint=${first.includes("sandbox: false") ? "yes" : "no"}`,
        `outside=${second.includes("pkgj-wrote") && !second.includes("[sandboxed:") ? "ran" : "no"}`,
      ].join(" "),
    };
  }
  if (user.includes("pkgj sandbox write inside")) {
    if (results.length === 0)
      return call("run_command", {
        command:
          "node -e \"require('fs').writeFileSync('pkgj-inside.txt','x');console.log('pkgj-inside-'+'ok')\"",
      });
    const first = results[0] ?? "";
    return {
      text: `PkgJ inside: ${first.includes("pkgj-inside-ok") && first.includes("[sandboxed:") ? "ok" : first}`,
    };
  }
  if (user.includes("pkgj enter a worktree")) {
    if (results.length === 0) return call("enter_worktree", { name: "pkgj-wt" });
    if (results.length === 1)
      return call("write_file", { path: "pkgj-wt.txt", content: "from the worktree\n" });
    if (results.length === 2)
      return call("run_command", {
        command: "git add -A && git commit -q -m pkgj-commit && git rev-parse --abbrev-ref HEAD",
      });
    return {
      text: [
        "PkgJ worktree:",
        `entered=${(results[0] ?? "").includes("branch agent/pkgj-wt") ? "yes" : results[0]}`,
        `branch=${(results[2] ?? "").includes("agent/pkgj-wt") ? "yes" : results[2]}`,
      ].join(" "),
    };
  }
  if (user.includes("pkgj leave the worktree")) {
    if (results.length === 0) return call("exit_worktree", { action: "keep" });
    const left = results[0] ?? "";
    return {
      text: `PkgJ left: ${left.includes("agent/pkgj-wt and its folder stay") ? "kept" : left}`,
    };
  }
  return null;
}

/**
 * pkgQ (agent-desktop-m7-95.jsonc, agent-ide-gif-m7-96.jsonc; D353, D354): the computer tool asks
 * for access before it acts (a screenshot, a click; the tests deny, so nothing is captured or
 * clicked) and refuses a card number before asking; and a recording of the IDE window with the
 * screenshot tool's record start / stop. Each answer says what the tool results showed.
 */
function pkgQScripted(messages, user) {
  const results = messages
    .slice(messages.findLastIndex((m) => m.role === "user"))
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content ?? ""));
  const at = (i) => results[i] ?? "";
  const step = (list, answer) => {
    const next = list[results.length];
    return next ? { tool: next } : { text: answer() };
  };
  if (user.includes("pkgq desktop look"))
    return step(
      [{ name: "computer", arguments: { action: "screenshot", action_summary: "Looks" } }],
      () => `PkgQ look: ${at(0).includes("didn't allow") ? "denied" : at(0).slice(0, 300)}`,
    );
  if (user.includes("pkgq desktop click"))
    return step(
      [
        {
          name: "computer",
          arguments: { action: "left_click", coordinate: [5, 5], action_summary: "Clicks" },
        },
      ],
      () => `PkgQ click: ${at(0).includes("didn't allow") ? "denied" : at(0).slice(0, 300)}`,
    );
  if (user.includes("pkgq desktop card"))
    return step(
      [{ name: "computer", arguments: { action: "type", text: "4111 1111 1111 1111" } }],
      () => `PkgQ card: ${at(0).includes("payment card") ? "refused" : at(0).slice(0, 300)}`,
    );
  // D374: the clipboard, asked for like an app: write, then read it back.
  if (user.includes("pkgq desktop clipboard"))
    return step(
      [
        { name: "computer", arguments: { action: "write_clipboard", text: "pkgq-clip-374" } },
        { name: "computer", arguments: { action: "read_clipboard" } },
      ],
      () =>
        `PkgQ clipboard: ${at(1).includes("pkgq-clip-374") ? "read back" : at(1).slice(0, 300)}`,
    );
  if (user.includes("pkgq record the ide"))
    return step(
      [
        { name: "screenshot", arguments: { target: "ide", record: "start" } },
        { name: "list_dir", arguments: { path: "." } },
        { name: "screenshot", arguments: { record: "stop" } },
      ],
      () => {
        const frames = Number(/Recorded (\d+) frames?/.exec(at(2))?.[1] ?? 0);
        return `PkgQ ide gif: ${frames >= 1 ? "card" : at(2).slice(0, 300)}`;
      },
    );
  return null;
}

/**
 * pkgS (agent-plugins-m7-100.jsonc, D358): a plugin's slash command reaches the model as the
 * command's text; the chat's prompt lists the plugin's skill. Null: not one of these.
 */
function pkgSScripted(messages, user) {
  const greet = /pkgs greet: say hello to ([\w-]+)/.exec(user);
  if (greet) return { text: `PKGS greeted ${greet[1]}.` };
  if (user.includes("pkgs which skills")) {
    const system = String(messages[0]?.content ?? "");
    return {
      text: `PKGS plugin skill listed: ${system.includes("pkgs-hello:greeting") ? "yes" : "no"}.`,
    };
  }
  return null;
}

/**
 * pkgO (agent-sandbox-net-m7-92; D348–D350): the command sandbox's network filter and hidden
 * secrets. "pkgo sandbox net": curl to a host that isn't allowed (refused by the filter, nothing
 * leaves the machine), then suggest_sandbox_allowance for it. "pkgo sandbox read": reading a
 * hidden folder fails. "pkgo sandbox card": the card alone (the card gallery).
 */
function pkgOScripted(messages, user) {
  if (!user.includes("pkgo sandbox ")) return null;
  const from = messages.findLastIndex((m) => m.role === "user");
  const results = messages
    .slice(from + 1)
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));
  const call = (name, args) => ({ tool: { name, arguments: args } });
  const suggest = () =>
    call("suggest_sandbox_allowance", {
      hosts: ["example.com"],
      reason: "pkgo: the download needs example.com",
    });
  if (user.includes("pkgo sandbox net")) {
    if (results.length === 0)
      return call("run_command", { command: "curl.exe -sS https://example.com/" });
    if (results.length === 1) return suggest();
    const first = results[0] ?? "";
    return {
      text: [
        "PkgO net:",
        `refused=${first.includes("refused example.com") ? "yes" : "no"}`,
        `sandboxed=${first.includes("[sandboxed:") ? "yes" : "no"}`,
        `card=${(results[1] ?? "").includes("Shown to the user as a card") ? "yes" : results[1]}`,
      ].join(" "),
    };
  }
  // D372: a background command refused a host while it runs.
  if (user.includes("pkgo sandbox background")) {
    if (results.length === 0)
      return call("run_command", {
        command: "while ($true) { curl.exe -sS https://example.org/; Start-Sleep -Seconds 2 }",
        background: true,
      });
    return { text: "PkgO background started." };
  }
  if (user.includes("pkgo sandbox read")) {
    if (results.length === 0)
      return call("run_command", { command: "Get-Content ../pkgo-secret/key.txt" });
    const first = results[0] ?? "";
    return {
      text: `PkgO read: ${!first.includes("pkgo-secret-value") && first.includes("[sandboxed:") ? "hidden" : first}`,
    };
  }
  if (user.includes("pkgo sandbox card")) {
    if (results.length === 0) return suggest();
    return { text: "PkgO card shown." };
  }
  return null;
}

/**
 * D300 (agent-plan-m7-45.jsonc): the plan sent with the first call, then advance: true with the
 * call that starts the next step, then the answer (the turn's end finishes the step it was on).
 */
function d300Scripted(messages, user) {
  if (!user.includes("d300 plan")) return null;
  const results = messages
    .slice(messages.findLastIndex((m) => m.role === "user"))
    .filter((m) => m.role === "tool").length;
  if (results === 0)
    return {
      tools: [
        {
          name: "update_plan",
          arguments: {
            steps: [
              { text: "Look at the folder", status: "in_progress" },
              { text: "Look again", status: "pending" },
              { text: "Report back", status: "pending" },
            ],
          },
        },
        { name: "list_dir", arguments: { path: "." } },
      ],
    };
  if (results === 2)
    return {
      tools: [
        { name: "update_plan", arguments: { advance: true } },
        { name: "list_dir", arguments: { path: "." } },
      ],
    };
  return { text: "D300 looked twice." };
}

/**
 * pkgE (agent-deferred-m7-62.jsonc, D319-D321): the echo server's tools deferred, a call of one
 * not loaded, a keyword tool_search, then the loaded tool; web_search with domains and web_fetch
 * with a question. The answer says what each step saw. Null: not one of these.
 */
function pkgEScripted(messages, user) {
  const system = String(messages[0]?.content ?? "");
  // A web_fetch question goes to the model with the page: answer it from the page.
  if (system.startsWith("You read a web page for a coding agent"))
    return {
      text: `Answer from the page: ${/Mock docs/.test(String(messages[1]?.content)) ? "it is the mock docs site" : "not found"}`,
    };
  if (!user.includes("pkge ")) return null;
  const from = messages.findLastIndex((m) => m.role === "user");
  const results = messages
    .slice(from + 1)
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));
  const call = (name, args) => ({ tool: { name, arguments: args } });
  if (user.includes("pkge deferred tools")) {
    if (results.length === 0) return call("mcp__echo__echo", { text: "hello" });
    if (results.length === 1)
      return call("tool_search", { query: "+echo upper case", max_results: 1 });
    if (results.length === 2) return call("mcp__echo__echo", { text: "hello" });
    return {
      text: [
        "pkgE deferred:",
        `first=${(results[0] ?? "").includes("Load it with tool_search") ? "helpful" : "other"}`,
        `search=${(results[1] ?? "").includes('"name":"mcp__echo__echo"') ? "loaded" : "none"}`,
        `echo=${(results[2] ?? "").includes("HELLO") ? "HELLO" : results[2]}`,
        `listed=${system.includes("- mcp__echo__ask:") ? "ask" : "-"}`,
        `echoListed=${system.includes("- mcp__echo__echo:") ? "yes" : "no"}`,
      ].join(" "),
    };
  }
  if (user.includes("pkge web")) {
    if (results.length === 0)
      return call("web_search", {
        query: "tauri",
        allowed_domains: ["example.com"],
        blocked_domains: ["blocked.example.com"],
      });
    if (results.length === 1)
      return call("web_fetch", {
        url: "http://127.0.0.1:11999/docs-site/",
        prompt: "What site is this?",
      });
    return {
      text: [
        "pkgE web:",
        `search=${(results[0] ?? "").includes("Sources:") ? "sources-rule" : "no-rule"}`,
        `syntax=${(results[0] ?? "").includes("site:example.com") ? "site" : "none"}`,
        `blocked=${(results[0] ?? "").includes("https://blocked.example.com") ? "shown" : "hidden"}`,
        `fetch=${(results[1] ?? "").includes("Answer from the page: it is the mock docs site") ? "answered" : results[1]}`,
      ].join(" "),
    };
  }
  return null;
}

/**
 * D253 (agent-d253.jsonc): three reads in one step, a schedule run now, a background command
 * that says when it ends, a PDF read as text. Null: not one of these.
 */
function d253Scripted(messages, user, last) {
  const toolText = (i) => String(messages.filter((m) => m.role === "tool")[i]?.content ?? "");
  if (user.includes("d253 read three"))
    return last.role !== "tool"
      ? {
          tools: ["one.txt", "two.txt", "three.txt"].map((path) => ({
            name: "read_file",
            arguments: { path },
          })),
        }
      : {
          text: `Read in order: ${[0, 1, 2].map((i) => (/content-(\w+)/.exec(toolText(i)) ?? [])[1] ?? "?").join(", ")}`,
        };
  if (user.includes("d253 schedule"))
    return last.role !== "tool"
      ? {
          tool: {
            name: "schedule",
            arguments: { when: "in 10 minutes", prompt: "d253-scheduled-ping: check the build" },
          },
        }
      : {
          text: `Schedule: ${String(last.content).startsWith("Scheduled") ? "made" : last.content}`,
        };
  if (user.includes("d253-scheduled-ping")) return { text: "Got the scheduled ping." };
  if (user.includes("d253 watch"))
    return last.role !== "tool"
      ? {
          tool: {
            name: "run_command",
            arguments: {
              command:
                "node -e \"console.log('bg-started');setTimeout(()=>console.log('bg-finished'),20000)\"",
              background: true,
              notify_on_exit: true,
            },
          },
        }
      : {
          text: `Watching: ${String(last.content).includes("message when it ends") ? "yes" : "no"}`,
        };
  if (user.includes("ended (you asked to be told)"))
    return {
      text: `Saw it end: ${user.includes("bg-finished") ? "with its output" : "no output"}`,
    };
  if (user.includes("d253 pdf"))
    return last.role !== "tool"
      ? { tool: { name: "read_file", arguments: { path: "doc.pdf" } } }
      : {
          text: `PDF: ${String(last.content).includes("Hello from a PDF") && String(last.content).includes("Page 2") ? "read" : "not read"}`,
        };
  return null;
}

/**
 * D292 (agent-tools-m7-39.jsonc): ask_user with notes and several picks, edit_file with several
 * edits in one call, and the web_fetch tool, one after another in one turn; then what each gave.
 */
function d292Scripted(messages, user) {
  if (!user.includes("d292 tools")) return null;
  const from = messages.findLastIndex((m) => m.role === "user");
  const results = messages
    .slice(from + 1)
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));
  const steps = [
    {
      name: "ask_user",
      arguments: {
        question: "Which parts should I do?",
        options: ["Tests", "Docs", "Lint"],
        descriptions: ["Run the suite", "Update the guide", ""],
        multi_select: true,
      },
    },
    { name: "write_file", arguments: { path: "d292.txt", content: "alpha\nbeta\n" } },
    {
      name: "edit_file",
      arguments: {
        path: "d292.txt",
        edits: [
          { old_string: "alpha", new_string: "one" },
          { old_string: "beta", new_string: "two" },
        ],
      },
    },
    { name: "web_fetch", arguments: { url: "http://127.0.0.1:11999/docs-site/" } },
  ];
  const next = steps[results.length];
  if (next) return { tool: next };
  const answered = (results[0] ?? "").replace("The user answered: ", "");
  const edited = results[2]?.startsWith("Error") ? "failed" : "ok";
  const fetched = results[3]?.includes("127.0.0.1:11999/docs-site") ? "ok" : "failed";
  return { text: `D292 answered=${answered} edit=${edited} fetch=${fetched}` };
}

/**
 * pkgA (D301–D303; agent-wrapup-m7-46, agent-chapters-m7-47, agent-propose-m7-48): wrap_up
 * refused once (too long) then shown with a question and two replies; chapters (refused at the
 * chat's very start, then two in the second message); a proposed task, and its brief answered.
 */
function pkgAScripted(messages, user) {
  if (!user.includes("pkga")) return null;
  const from = messages.findLastIndex((m) => m.role === "user");
  const results = messages
    .slice(from + 1)
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));
  if (user.includes("pkga wrapup")) {
    if (results.length === 0)
      return {
        tools: [
          {
            name: "update_plan",
            arguments: {
              steps: [
                { text: "Look at the folder", status: "in_progress" },
                { text: "Report back", status: "pending" },
              ],
            },
          },
          { name: "list_dir", arguments: { path: "." } },
        ],
      };
    if (results.length === 2)
      return { tool: { name: "wrap_up", arguments: { recap: "a".repeat(303) } } };
    if (results.length === 3)
      return {
        tools: [
          { name: "update_plan", arguments: { advance: true } },
          {
            name: "wrap_up",
            arguments: {
              recap: "You have a folder with a few files. Nothing changed yet.",
              ask: "Want me to tidy it up?",
              actions: [{ label: "Yes, tidy" }, { label: "Not now" }],
              blocked: true,
            },
          },
        ],
      };
    return {
      text: `PkgA wrapped up (first try: ${results[2]?.includes("ran 303") ? "ran 303" : "?"}).`,
    };
  }
  if (user.includes("pkga chapters one")) {
    if (results.length === 0)
      return { tool: { name: "mark_chapter", arguments: { title: "Too early" } } };
    return { text: `PkgA first (${results[0]?.startsWith("Error") ? "refused" : "marked"}).` };
  }
  if (user.includes("pkga chapters two")) {
    if (results.length === 0)
      return {
        tools: [
          { name: "mark_chapter", arguments: { title: "Second look", summary: "Looking again" } },
          { name: "list_dir", arguments: { path: "." } },
        ],
      };
    if (results.length === 2)
      return {
        tools: [
          { name: "mark_chapter", arguments: { title: "Wrapping up" } },
          { name: "list_dir", arguments: { path: "." } },
        ],
      };
    return { text: "PkgA chapters done." };
  }
  if (user.includes("pkga propose")) {
    if (results.length === 0)
      return {
        tool: {
          name: "propose_task",
          arguments: {
            title: "Add a readme",
            brief: "pkga task brief: write a README for this folder.",
          },
        },
      };
    return { text: "PkgA proposed." };
  }
  if (user.includes("pkga task brief")) return { text: "PkgA task started." };
  return null;
}

/**
 * pkgR (agent-widget-stream-m7-97, agent-output-style-m7-98, agent-statusline-m7-99; D355–D357):
 * a widget whose code streams in slowly (on the Anthropic route, which streams tool arguments in
 * chunks: `streamArgs`), a report of the output style the system prompt carries, and a plain
 * answer for the status line to follow.
 */
function pkgRScripted(messages, user) {
  if (!user.startsWith("pkgr ")) return null;
  const system = messages[0]?.role === "system" ? String(messages[0].content) : "";
  const results = messages
    .slice(messages.findLastIndex((m) => m.role === "user"))
    .filter((m) => m.role === "tool").length;
  if (user.includes("pkgr widget stream")) {
    if (results > 0) return { text: "PkgR widget streamed." };
    const bars = Array.from(
      { length: 14 },
      (_, i) =>
        `<div class="row"><span class="name">Item ${i + 1}</span><span class="bar" style="width:${20 + i * 5}%"></span></div>`,
    ).join("\n");
    return {
      tool: {
        name: "show_widget",
        arguments: {
          loading_messages: ["Laying out the bars", "Painting the frame"],
          title: "pkgr_stream",
          widget_code: `<style>.row{display:flex;gap:8px;align-items:center;height:14px}.name{width:64px;color:var(--fg-muted)}.bar{height:8px;background:var(--accent);border-radius:4px}</style>\n<div id="bars">\n${bars}\n</div>\n<p id="done">Waiting for the script</p>\n<script>document.getElementById("done").textContent = "The script ran";\nconst tall = document.createElement("div");\ntall.style.height = "420px";\ndocument.body.firstElementChild.appendChild(tall);</script>`,
        },
      },
      // About 2 KB in 70-character pieces every 150 ms: drawn over 4 seconds or so.
      streamArgs: { chunk: 70, delayMs: 150 },
    };
  }
  if (user.includes("pkgr style report")) {
    const style = system.includes("PKGR-PIRATE-MARKER")
      ? "pirate"
      : system.includes("★ Insight") && system.includes("TODO(human)")
        ? "learning"
        : system.includes("★ Insight")
          ? "explanatory"
          : "default";
    const coding = system.includes("Read a file (read_file) before editing it");
    return { text: `PkgR style: ${style}, coding=${coding}.` };
  }
  if (user.includes("pkgr status ping")) return { text: "PkgR status pong." };
  return null;
}

/**
 * D389 (agent-slash-m7-108.jsonc): /btw's side question gets the chat so far and no tools; the
 * answer says whether the chat's earlier reply was in what it was given.
 */
function d389Scripted(messages, user) {
  if (!user.includes("side question: d389")) return null;
  const system = messages[0]?.role === "system" ? String(messages[0].content) : "";
  const saw = user.includes("pkgr status pong") ? "saw the chat" : "no chat";
  return {
    text: `D389 aside: ${saw}, ${system.includes("side question") ? "aside prompt" : "?"}.`,
  };
}

/**
 * The website's screenshots (website-handoff/screenshots.jsonc): chats that read like real work
 * in its demo project (an invoices API). Triggered by their ordinary wording, so the screenshots
 * show no test phrases. Null: not one of these.
 */
function demoScripted(messages, user) {
  const results = messages
    .slice(messages.findLastIndex((m) => m.role === "user"))
    .filter((m) => m.role === "tool").length;
  if (user.includes("off by a cent")) {
    const total = "src/invoices/total.js";
    const tests = "src/invoices/total.test.js";
    if (results === 0)
      return {
        thinking:
          "**Tracing the totals**\nA one-cent drift on some orders smells like float rounding. Let me find where totals are rounded.",
        tools: [
          {
            name: "update_plan",
            arguments: {
              steps: [
                { text: "Find where totals are rounded", status: "in_progress" },
                { text: "Fix the rounding", status: "pending" },
                { text: "Add a test and run the suite", status: "pending" },
              ],
            },
          },
          { name: "search", arguments: { pattern: "toFixed|Math.round", path: "src" } },
        ],
      };
    if (results === 2)
      return {
        tools: [
          { name: "read_file", arguments: { path: total } },
          { name: "read_file", arguments: { path: tests } },
        ],
      };
    if (results === 4)
      return {
        thinking:
          "**Found it**\n`toFixed(2)` rounds the binary float, and 1.005 is stored as 1.00499…, so it rounds down. Each line is rounded and then summed, so the drift adds up. Working in whole cents fixes both.",
        tools: [
          { name: "update_plan", arguments: { advance: true } },
          {
            name: "edit_file",
            arguments: {
              path: total,
              old_string:
                "export function lineTotal(line) {\n  return Number((line.unitPrice * line.quantity).toFixed(2));\n}\n\nexport function invoiceTotal(lines, taxRate = 0) {\n  const subtotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);\n  return Number((subtotal * (1 + taxRate)).toFixed(2));\n}",
              new_string:
                "// Money is added up in whole cents: toFixed rounds the binary float (1.005 is 1.00499…).\nconst toCents = (dollars) => Math.round((dollars + Number.EPSILON) * 100);\n\nexport function lineTotal(line) {\n  return toCents(line.unitPrice * line.quantity) / 100;\n}\n\nexport function invoiceTotal(lines, taxRate = 0) {\n  const subtotal = lines.reduce((sum, line) => sum + toCents(line.unitPrice * line.quantity), 0);\n  return Math.round(subtotal * (1 + taxRate)) / 100;\n}",
            },
          },
        ],
      };
    if (results === 6)
      return {
        tool: {
          name: "edit_file",
          arguments: {
            path: tests,
            old_string:
              "  assert.equal(invoiceTotal([{ unitPrice: 10, quantity: 2 }], 0.25), 25);\n});\n",
            new_string:
              '  assert.equal(invoiceTotal([{ unitPrice: 10, quantity: 2 }], 0.25), 25);\n});\n\ntest("half cents round up, also across lines", () => {\n  assert.equal(lineTotal({ unitPrice: 1.005, quantity: 1 }), 1.01);\n  assert.equal(invoiceTotal([{ unitPrice: 0.335, quantity: 3 }, { unitPrice: 1.005, quantity: 1 }]), 2.02);\n});\n',
          },
        },
      };
    if (results === 7)
      return {
        tools: [
          { name: "update_plan", arguments: { advance: true } },
          { name: "run_command", arguments: { command: "node --test" } },
        ],
      };
    if (results === 9)
      return {
        tools: [
          { name: "update_plan", arguments: { advance: true } },
          {
            name: "wrap_up",
            arguments: {
              recap:
                "Invoice totals are now added up in whole cents, so half cents round up and no longer drift across lines. A test covers it; the suite passes. Nothing committed.",
              ask: "Commit the fix?",
              actions: [{ label: "Commit" }, { label: "Not yet" }],
            },
          },
        ],
      };
    return {
      text: "<title>Invoice totals off by a cent</title>\n`lineTotal` rounded with `toFixed(2)`, which rounds the **binary** float: `1.005` is stored as `1.00499…`, so it became `1.00`. Every line was rounded before summing, so bigger orders drifted further. Totals are now added up in whole cents:\n\n```js\nconst toCents = (dollars) => Math.round((dollars + Number.EPSILON) * 100);\n```\n\n- `src/invoices/total.js`: lines and the subtotal in cents, tax applied once at the end.\n- `src/invoices/total.test.js`: half cents on one line and across lines.\n\nAll 9 tests pass.",
    };
  }
  // #general with @all: the main agent answers, and the built-in team (Plato plans, Gabby talks it
  // through) beside it; groupTogether.ts asks each one to "answer … as <label>".
  if (user.includes("what's left for 1.4")) {
    const as = /answer the user's last message as (\S+?)\.?$/.exec(user.trim())?.[1];
    const role = as === "plato" ? "plan" : as === "gabby" ? "ask" : null;
    if (role === "plan")
      return {
        text: "Order I'd suggest: review the rounding fix first, since it changes totals; then paging; then the notes, which mention both.",
      };
    if (role === "ask")
      return {
        text: "Paging is the only breaking change, so the upgrade guide needs just one line for it.",
      };
    return {
      text: "<title>What's left for 1.4</title>\nThree things before 1.4:\n1. **Cursor paging** for `GET /invoices` (replaces `page`).\n2. **The cent rounding fix:** done, waiting for review.\n3. **Release notes:** drafted.\n\nI can start on the paging now.",
    };
  }
  if (user.includes("add rate limiting to the public api"))
    return {
      text: "<title>Rate limiting for the public API</title>\nA token bucket per API key fits best here: `src/server.js` already reads the key in `authenticate`, so the limiter can sit right after it.\n\n1. **Bucket:** 60 requests a minute, bursts of 20, kept in memory (one instance today).\n2. **Reply:** `429` with `Retry-After`, plus `RateLimit-Remaining` on every response.\n3. **Later:** move the buckets to Redis when you run more than one instance.\n\nWant me to build it?",
    };
  if (user.includes("why does ci fail on windows"))
    return {
      text: "<title>CI fails on Windows only</title>\nThe Windows job fails in `exports.test.js`: the test compares a CSV against a fixture with `\\n` endings, and Git checks the fixture out with `\\r\\n` on Windows.\n\nTwo ways to fix it:\n- add `*.csv text eol=lf` to `.gitattributes`, or\n- normalize line endings in the test before comparing.\n\nThe first one also keeps the files consistent for everyone.",
    };
  if (user.includes("write release notes for 1.4"))
    return {
      text: "<title>Release notes for 1.4</title>\n## 1.4\n\n- **Invoices:** totals add up in whole cents, so orders no longer drift by a cent.\n- **Customers:** search by email domain.\n- **API:** `GET /invoices` pages with `cursor` instead of `page`.\n\nOne breaking change: `page` is gone. I left a note for the upgrade guide.",
    };
  return null;
}

function scripted(messages) {
  const demo = demoScripted(messages, lastUser(messages));
  if (demo) return demo;
  const d389 = d389Scripted(messages, lastUser(messages));
  if (d389) return d389;
  const last = messages[messages.length - 1];
  const user = lastUser(messages);
  // Editor features (D106): Edit with AI, and completions.
  const system = messages[0]?.role === "system" ? messages[0].content : "";
  const skills221 = skills221Scripted(user, last);
  if (skills221) return skills221;
  const agentA = agentAScripted(user, last);
  if (agentA) return agentA;
  const risky = riskyScripted(user, last);
  if (risky) return risky;
  const headless = headlessScripted(messages, user, last);
  if (headless) return headless;
  const d253 = d253Scripted(messages, user, last);
  if (d253) return d253;
  const d300 = d300Scripted(messages, user);
  if (d300) return d300;
  if (pkgPScripted(messages, user, last)) return pkgPScripted(messages, user, last);
  if (pkgRScripted(messages, user)) return pkgRScripted(messages, user);
  if (imagesScripted(messages, user)) return imagesScripted(messages, user);
  if (pkgNScripted(messages, user)) return pkgNScripted(messages, user);
  if (pkgKScripted(messages, user, last)) return pkgKScripted(messages, user, last);
  // Compaction (D109) before the package scenarios: its request quotes the conversation, whose
  // earlier messages may hold their trigger phrases ("rename the title").
  if (system.startsWith("You compress a coding agent"))
    return { text: "- Goal: mock summary of the work." };
  if (pkgEScripted(messages, user)) return pkgEScripted(messages, user);
  const pkgA = pkgAScripted(messages, user);
  if (pkgA) return pkgA;
  const pkgC = pkgCScripted(messages, user);
  if (pkgC) return pkgC;
  const pkgB = pkgBScripted(messages, user, last);
  if (pkgB) return pkgB;
  const pkgF = pkgFScripted(messages, user, last);
  if (pkgF) return pkgF;
  const pkgD = pkgDScripted(messages, user);
  if (pkgD) return pkgD;
  const pkgH = pkgHScripted(messages, user);
  if (pkgH) return pkgH;
  const pkgG = pkgGScripted(messages, user, last);
  if (pkgG) return pkgG;
  if (pkgJScripted(messages, user)) return pkgJScripted(messages, user);
  if (pkgLScripted(messages, user)) return pkgLScripted(messages, user);
  if (pkgIScripted(messages, user)) return pkgIScripted(messages, user);
  if (pkgMScripted(messages, user)) return pkgMScripted(messages, user);
  if (galleryScripted(messages, user)) return galleryScripted(messages, user);
  if (user.includes("pkgq ")) return pkgQScripted(messages, user);
  if (pkgSScripted(messages, user)) return pkgSScripted(messages, user);
  const pkgO = pkgOScripted(messages, user);
  if (pkgO) return pkgO;
  const d292 = d292Scripted(messages, user);
  if (d292) return d292;
  const d254 = d254Scripted(messages, user, last);
  if (d254) return d254;
  const group231 = groupScripted(messages, user);
  if (group231) return group231;
  // D204 (agent-m7-5.jsonc): MCP sampling answered by this model, a tool whose schema loads on
  // demand, and @docs passages.
  if (system.startsWith("You summarize.")) return { text: "Sampled answer" };
  if (user.includes("please summarize via mcp") && last.role !== "tool")
    return { tool: { name: "mcp__extra__summarize", arguments: {} } };
  if (last.role === "tool" && last.tool_name === "mcp__extra__summarize")
    return last.content.includes("Load it with tool_search")
      ? { tool: { name: "tool_search", arguments: { query: "select:mcp__extra__summarize" } } }
      : { text: `Extra said: ${last.content}` };
  if (user.includes("please summarize via mcp") && last.tool_name === "tool_search")
    return { tool: { name: "mcp__extra__summarize", arguments: {} } };
  // D207 (agentB-m7-6.jsonc): a remote server's tools, and sampling with an image.
  if (system.startsWith("You describe images.")) return { text: "Described" };
  const remoteCall = /please call remote (\w+)/.exec(user);
  if (remoteCall && last.role !== "tool")
    return { tool: { name: `mcp__remote__${remoteCall[1]}`, arguments: {} } };
  if (user.includes("please look via mcp") && last.role !== "tool")
    return { tool: { name: "mcp__extra__look", arguments: {} } };
  // D206 (skills-m7-5.jsonc): a skill listed in the prompt is loaded with use_skill; /name runs one.
  const skillAsk = /use the ([a-z0-9-]+) skill/.exec(user);
  if (skillAsk && last.role !== "tool")
    return String(system).includes(`- ${skillAsk[1]}: `)
      ? { tool: { name: "use_skill", arguments: { name: skillAsk[1] } } }
      : { text: `Skill not listed: ${skillAsk[1]}` };
  if (last.role === "tool" && last.tool_name === "use_skill")
    return {
      text: `Skill loaded: ${/checker-body-marker|describe the workflow/i.test(last.content) ? "body" : "-"}/${last.content.includes("- ref.md") ? "files" : "-"}`,
    };
  if (user.includes("the user ran the skill /"))
    return {
      text: `Skill run: ${user.includes("checker-body-marker") ? "body" : "-"}/${user.includes("args are v2") ? "args" : "-"}`,
    };
  if (user.includes("from the mock documentation"))
    return {
      text: `Docs said: ${(user.match(/widgets spin when[^.\n]*/i) ?? ["nothing"])[0]}`,
    };
  // D195: the reviewer subagent reads the README, then reports with the model it ran on.
  if (system.startsWith("You review code."))
    return last.role === "tool"
      ? { text: `Reviewer report on ${currentModel}: looks fine` }
      : { tool: { name: "read_file", arguments: { path: "README.md" } } };
  if (user.includes("report from subagent reviewer"))
    return { text: `Got the report: ${user.includes("looks fine") ? "fine" : "?"}` };
  if (last.role === "tool" && last.tool_name === "delegate")
    return { text: `Delegated: ${last.content.split("\n")[0]}` };
  // D231: a helper in a worktree of its own (the call's flag, or the agent's isolation: worktree).
  if (user.includes("delegate isolated work"))
    return {
      tool: {
        name: "delegate",
        arguments: { agent: "general", task: "Add a line to README.md", isolated: true },
      },
    };
  if (user.includes("delegate to forge"))
    return {
      tool: { name: "delegate", arguments: { agent: "forge", task: "Add a line to notes.txt" } },
    };
  if (user.includes("delegate a background review"))
    return {
      tool: {
        name: "delegate",
        arguments: { agent: "reviewer", task: "Review README.md", background: true },
      },
    };
  if (user.includes("delegate a review"))
    return {
      tool: { name: "delegate", arguments: { agent: "reviewer", task: "Review README.md" } },
    };
  if (user.includes("which model answers") || user.includes("build it: carry out the plan"))
    return { text: `Answered by ${currentModel}` };
  // Next-edit suggestions (D193): the line after the one changed.
  if (user.includes("predict the next edit (or none)"))
    return { text: "<<<LINES 2-2\n  return a + b; // checked\n>>>" };
  if (user.includes("use the echo server") && last.role !== "tool")
    return { tool: { name: "mcp__echo__echo", arguments: { text: "hello" } } };
  // D200: elicitation, list_changed, MCP prompts and resources, web search.
  if (user.includes("ask me through mcp") && last.role !== "tool")
    return { tool: { name: "mcp__echo__ask", arguments: {} } };
  if (user.includes("grow the echo server") && last.role !== "tool")
    return { tool: { name: "mcp__echo__grow", arguments: {} } };
  if (user.includes("run the late tool") && last.role !== "tool")
    return { tool: { name: "mcp__echo__late", arguments: {} } };
  if (user.includes("search the web for") && last.role !== "tool")
    return {
      tool: {
        name: "web_search",
        arguments: { query: (user.match(/search the web for (.+)$/m) ?? ["", "x"])[1] },
      },
    };
  if (last.role === "tool" && last.tool_name === "web_search")
    return {
      text: `Search said: ${(last.content.match(/1\. ([^\n]+)/) ?? ["", last.content.slice(0, 120)])[1]}`,
    };
  if (user.includes("mock review prompt for"))
    return {
      text: `Prompt arrived: ${(user.match(/mock review prompt for (\w+)/) ?? ["", "?"])[1]}`,
    };
  if (user.includes("the mock notes say")) return { text: "Resource arrived: resources work." };
  if (user.includes("(search results") || user.includes('web search for "'))
    return { text: `Mention said: ${(user.match(/1\. ([^\n]+)/) ?? ["", "nothing"])[1]}` };
  // A model stuck in a loop (D142): the same sentence over and over while reasoning.
  if (user.includes("ramble"))
    return {
      thinking: `Let me think. ${"So we need to name the project my-app or something else. ".repeat(80)}`,
      text: "never reached",
    };
  // Compaction (D109).
  if (system.startsWith("You compress a coding agent"))
    return { text: "- Goal: mock summary of the work." };
  // Tidying up memory (D110): merge the notes into one file.
  if (system.startsWith("You curate a coding agent's project memory"))
    return {
      text: "=== file: testing.md ===\n# Testing\n- Run the tests with npm test (tidied)\n",
    };
  if (system.startsWith("You edit code")) {
    // "two changes" (D172): the selection with its first line changed and a line added at the
    // end: two hunks to review one by one.
    const prompt = String(last.content);
    if (prompt.includes("Instruction: two changes")) {
      const selection = (prompt.match(/<selection>\n([\s\S]*?)\n<\/selection>/) ?? ["", ""])[1];
      const lines = selection.split("\n");
      lines[0] = "# Two changes";
      lines.push("- added by mock");
      return { text: `\`\`\`md\n${lines.join("\n")}\n\`\`\`` };
    }
    return { text: "```md\n# Edited by mock\n```" };
  }
  // The explore sub-agent (D127): reads the README, then reports.
  if (system.startsWith("You are a read-only code explorer"))
    return last.role === "tool"
      ? { text: `Report: ${(last.content.match(/#\s*([^\n]+)/) ?? ["", "?"])[1]}` }
      : { tool: { name: "read_file", arguments: { path: "README.md" } } };
  if (system.startsWith("You are a code completion engine")) return { text: "completed()" };
  // Earlier attachments (D211): list them, look at the first image, answer.
  if (user.includes("look at my earlier attachment")) {
    const since = messages.findLastIndex((m) => m.role === "user");
    const results = messages.slice(since + 1).filter((m) => m.role === "tool");
    if (!results.length) return { tool: { name: "chat_attachments", arguments: {} } };
    if (results.length === 1) {
      const id = (String(results[0].content).match(/(m\d+-\w+) — message \d+, image/) ?? [])[1];
      return id
        ? { tool: { name: "chat_attachments", arguments: { id } } }
        : { text: `Attachment check: no image in ${String(results[0].content).slice(0, 200)}` };
    }
    const got = results[1];
    const saw =
      (got.images?.length ?? 0) > 0
        ? "saw an image"
        : String(got.content).includes("The image is attached")
          ? "image returned"
          : "no image";
    return { text: `Attachment check: ${saw}` };
  }
  // Screenshots during a turn (D155): two of the IDE, then an answer.
  if (user.includes("take two screenshots")) {
    const shots = messages.filter((m) => m.role === "tool").length;
    return shots < 2
      ? { tool: { name: "screenshot", arguments: { target: "ide" } } }
      : { text: "Took two screenshots." };
  }
  // A long run of writes with a plan (D154): the IDE reminds about the plan, the model ticks it.
  if (messages.some((m) => m.role === "user" && String(m.content).includes("build the demo"))) {
    const tools = messages.filter((m) => m.role === "tool");
    const reminded = tools.some((m) => String(m.content).includes("Reminder from the IDE"));
    // Each demo turn writes files of its own: a later chat's writes would be refused over files it
    // never read (D309).
    if (!tools.length) demoTurns++;
    if (!tools.length)
      return {
        tool: {
          name: "update_plan",
          arguments: {
            steps: [
              { text: "Write the files", status: "in_progress" },
              { text: "Check them", status: "pending" },
            ],
          },
        },
      };
    if (reminded && last.tool_name === "update_plan") return { text: "Demo built." };
    if (reminded)
      return {
        tool: {
          name: "update_plan",
          arguments: {
            steps: [
              { text: "Write the files", status: "done" },
              { text: "Check them", status: "in_progress" },
            ],
          },
        },
      };
    return {
      tool: {
        name: "write_file",
        arguments: {
          path: `demo${demoTurns}/file${tools.length}.txt`,
          content: `line one\nline ${tools.length} ${Date.now()}\n`,
        },
      },
    };
  }
  // Changing the IDE (D179): asks even with full access; what it opens can be closed again.
  if (user.includes("make the editor font bigger"))
    return last.role === "tool"
      ? { text: `Font: ${last.content.slice(0, 60)}` }
      : {
          tool: {
            name: "call_command",
            arguments: { id: "settings.set", input: { key: "editor.fontSize", value: 15 } },
          },
        };
  if (user.includes("open the notes for me"))
    return last.role === "tool"
      ? { text: `Opened: ${last.content.slice(0, 60)}` }
      : {
          tool: {
            name: "call_command",
            arguments: { id: "editor.openFile", input: { path: "notes.txt" } },
          },
        };
  // Deletion protection (D179): asks even with full access.
  if (user.includes("clear the scratch folder"))
    return last.role === "tool"
      ? { text: `Cleared: ${last.content.slice(0, 80)}` }
      : { tool: { name: "run_command", arguments: { command: "rm -rf scratch-d179" } } };
  // An IDE command in auto mode (D153): asks nothing when commands run automatically.
  if (user.includes("set a breakpoint please"))
    return last.role === "tool"
      ? { text: `Breakpoint set: ${last.content.includes("main.ts") ? "main.ts" : "?"}` }
      : {
          tool: {
            name: "call_command",
            arguments: { id: "debug.setBreakpoint", input: { path: "src/main.ts", line: 1 } },
          },
        };
  // Display tools (D171): cards and a question come as tool calls; charts and diagrams are
  // Mermaid in the text (D172). The question waits for a click or a typed answer.
  if (user.includes("show the rich blocks") || user.includes("ask me which")) {
    // This turn's tool results only (after the last user message).
    const from = messages.findLastIndex((m) => m.role === "user");
    const results = messages
      .slice(from + 1)
      .filter((m) => m.role === "tool")
      .map((m) => String(m.content));
    const answered = results.find((r) => r.startsWith("The user answered: "));
    if (answered) return { text: `${answered.slice(19)} it is.` };
    if (user.includes("ask me which"))
      return {
        tool: {
          name: "ask_user",
          arguments: { question: "Which test runner?", options: ["Vitest", "Jest"] },
        },
      };
    const steps = [
      {
        name: "show_links",
        arguments: {
          items: [
            { path: "README.md", line: 1, note: "the overview" },
            { path: "src/main.ts", note: "the entry point" },
            {
              title: "Postgres docs",
              url: "https://www.postgresql.org/docs/",
              note: "the reference",
            },
          ],
        },
      },
      {
        name: "ask_user",
        arguments: { question: "Which database should I use?", options: ["SQLite", "Postgres"] },
      },
    ];
    const next = steps[results.length];
    const overview = [
      "Here's the overview: signups follow visits, about $r = 0.97$.",
      "",
      "```mermaid",
      "xychart-beta",
      '  title "Visits by month"',
      "  x-axis [Jan, Feb, Mar, Apr]",
      '  y-axis "Visits" 0 --> 300',
      "  bar [120, 180, 260, 210]",
      "  line [30, 45, 70, 64]",
      "```",
      "",
      "```mermaid",
      "flowchart LR",
      "  A[Request] --> B{Cached?}",
      "  B -->|yes| C[Answer]",
      "  B -->|no| D[Database] --> C",
      "```",
      "",
      "$$\\sum_{i=1}^{n} x_i = \\frac{n(n+1)}{2}$$",
    ].join("\n");
    if (next) return { ...(results.length === 0 && { text: overview }), tool: next };
    return { text: "Done." };
  }
  // Full access (D163): a command on the denylist runs without asking; the reply is wrapped in
  // <result> tags like some free models do.
  if (user.includes("tidy the scratch folder")) {
    if (!messages.some((m) => m.role === "tool"))
      return { tool: { name: "run_command", arguments: { command: "rm -rf scratch-d163" } } };
    return { text: "<result>\nTidied the scratch folder.\n</result>" };
  }
  // A message sent while the agent works (D151): a slow step, then the message joins the turn.
  if (messages.some((m) => m.role === "user" && String(m.content).includes("start the slow job"))) {
    if (
      messages.some(
        (m) => m.role === "user" && String(m.content).includes("while you were working"),
      )
    )
      return { text: `Got it, thanks: ${user.split("\n").pop()}` };
    if (!messages.some((m) => m.role === "tool"))
      return {
        tool: {
          name: "run_command",
          arguments: { command: "sleep 3 && echo slow-done" },
        },
      };
    return { text: "The slow job is done." };
  }
  // D371: whether a SessionStart hook's output reached the model.
  if (user.includes("what did the hooks say"))
    return {
      text: `Hooks said: ${messages.some((m) => String(m.content).includes("session-start-marker")) ? "start" : "nothing"}`,
    };
  // D370: a reply long enough to scroll.
  if (user.includes("write a long answer"))
    return {
      text: Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of the long answer.`).join(
        "\n\n",
      ),
    };
  // Send now (D363): a long command, or a reply that takes its time; the message cuts it short.
  if (
    messages.some((m) => m.role === "user" && /start the long (job|essay)/.test(String(m.content)))
  ) {
    if (
      messages.some(
        (m) => m.role === "user" && String(m.content).includes("while you were working"),
      )
    )
      return { text: `Read at once: ${user.split("\n").pop()}` };
    if (messages.some((m) => m.role === "user" && String(m.content).includes("long essay")))
      return { delayMs: 60000, text: "The essay, at last." };
    if (!messages.some((m) => m.role === "tool"))
      return {
        tool: { name: "run_command", arguments: { command: "sleep 60 && echo long-done" } },
      };
    return { text: "The long job is done." };
  }
  // D200: a subfolder's AGENTS.md and a glob rule come with the read; the prompt lists them.
  if (user.includes("read the sub file"))
    return last.role === "tool"
      ? {
          text: `Sub rules: ${last.content.includes("sub-rule-marker") ? "folder" : "-"}/${last.content.includes("glob-rule-marker") ? "glob" : "-"}/${system.includes("- sub/AGENTS.md (for files in sub/)") ? "listed" : "-"}`,
        }
      : { tool: { name: "read_file", arguments: { path: "sub/notes.md" } } };
  // D203: a subfolder's .cursor/rules and a .github/instructions subfolder's rule come with the
  // read of a file under that subfolder.
  if (user.includes("read the nested rule file"))
    return last.role === "tool"
      ? {
          text: `Nested rules: ${last.content.includes("nested-cursor-marker") ? "cursor" : "-"}/${last.content.includes("deep-instructions-marker") ? "instructions" : "-"}/${last.content.includes("outside-marker") ? "outside" : "-"}`,
        }
      : { tool: { name: "read_file", arguments: { path: "web/src/App.tsx" } } };
  // D200: slash commands with $1, a shell line's output and an @file; /init writes AGENTS.md.
  if (user.includes("the user ran the command /shellcmd"))
    return {
      text: `Shellcmd: ${(user.match(/topic is (\w+)/) ?? ["", "?"])[1]}/${user.includes("\nshellout\n") ? "shell" : "-"}/${user.includes("contents of sub/notes.md") ? "file" : "-"}`,
    };
  if (user.includes("the user ran /init"))
    return last.role === "tool"
      ? { text: "Wrote AGENTS.md." }
      : {
          tool: {
            name: "write_file",
            arguments: { path: "AGENTS.md", content: "# Agents\n\nRun the tests with npm test.\n" },
          },
        };
  if (user.includes("the uncommitted changes (git diff head"))
    return { text: `Git mention: ${user.includes("hunks.txt") ? "has hunks" : "?"}` };
  // D201: a command in the background — start it, read its new output (filtered), stop it. The
  // id comes from the earlier run_command result ("in the background as bg1").
  const bgId = () => {
    for (const m of [...messages].reverse()) {
      const id = String(m.content ?? "").match(/in the background as (bg\d+)/)?.[1];
      if (id) return id;
    }
    return "bg1";
  };
  if (user.includes("start the background ticker"))
    return last.role === "tool"
      ? {
          text: `Background: ${/in the background as bg\d+/.test(last.content) ? bgId() : "not started"}`,
        }
      : {
          tool: {
            name: "run_command",
            arguments: {
              command:
                "node -e \"console.log('watching for changes');setInterval(()=>console.log('tick'),2500)\"",
              background: true,
            },
          },
        };
  // D367: a background command that serves an address (a dev server): a server, no spinner.
  if (user.includes("start the background server"))
    return last.role === "tool"
      ? {
          text: `Server: ${/in the background as bg\d+/.test(last.content) ? "started" : "not started"}`,
        }
      : {
          tool: {
            name: "run_command",
            arguments: {
              command:
                "node -e \"console.log('  Local:   http://localhost:11996/');setInterval(()=>{},1000)\"",
              background: true,
            },
          },
        };
  if (user.includes("read the ticker output"))
    return last.role === "tool"
      ? {
          text: `Ticker said: ${/^tick$/m.test(last.content) ? "tick" : last.content.split("\n")[0]}`,
        }
      : { tool: { name: "process_output", arguments: { id: bgId(), filter: "^tick$" } } };
  if (user.includes("stop the background ticker"))
    return last.role === "tool"
      ? { text: `Kill said: ${last.content.split("\n")[0]}` }
      : { tool: { name: "kill_process", arguments: { id: bgId() } } };
  // A multi-step turn (the chat's layout, D151): think, read, run, then answer with code.
  if (user.includes("tour the project")) {
    const steps = messages.filter((m) => m.role === "tool").length;
    if (steps === 0)
      return {
        thinking: "**Looking around**\nI should read the README first.",
        text: "I'll start with the README.",
        tool: { name: "read_file", arguments: { path: "README.md" } },
      };
    if (steps === 1)
      return {
        thinking: "**Checking the tools**\nNow run something small.",
        tool: { name: "run_command", arguments: { command: "echo tour-ok" } },
      };
    return {
      thinking: "**Wrapping up**\nEverything checks out.",
      text: "All set. The project is a small sample with a README and a `src` folder.\n\n```ts\nconsole.log(add(1, 2));\n```\n\nWant me to add tests next?",
    };
  }
  if (last.role === "tool" && last.tool_name === "explore")
    return { text: `Explorer said: ${last.content.split("\n")[0]}` };
  if (last.role === "tool") {
    if (last.tool_name === "read_file") {
      if (last.content.includes("excluded from the agent")) return { text: "Refused: excluded." };
      const first = last.content.split("\n").find((l) => /\|\s*#/.test(l)) ?? "";
      return { text: `The README says: ${first.replace(/^\s*\d+\|\s*/, "")}` };
    }
    if (last.tool_name?.startsWith("mcp__")) return { text: `MCP said: ${last.content}` };
    if (last.tool_name === "browser_snapshot") {
      const button = last.content.match(/button "([^"]+)" \[ref=(e\d+)\]/);
      return button
        ? { tool: { name: "browser_act", arguments: { action: "click", ref: button[2] } } }
        : { text: "No button on the page." };
    }
    if (last.tool_name === "browser_act")
      return { text: `Clicked: ${last.content.includes("Increment") ? "Increment" : "?"}` };
    if (last.tool_name === "edit_file" && user.includes("break"))
      return {
        text: last.content.includes("new error")
          ? `Checker said: ${(last.content.match(/- line [^\n]+/) ?? [""])[0]}`
          : "Checker said nothing.",
      };
    if (last.tool_name === "update_plan") return { text: "Planned." };
    if (last.tool_name === "remember") return { text: `Noted: ${last.content}` };
    if (last.tool_name === "recall")
      return { text: `Recalled: ${last.content.trim().split("\n").pop()}` };
    if (last.tool_name === "run_command")
      return {
        text: last.content.includes("agent-ran")
          ? "The command printed agent-ran."
          : last.content.includes("cd-ok")
            ? "The command printed cd-ok."
            : "The command didn't run.",
      };
    return { text: "Done." };
  }
  // The verify step (D127): a change, then — when the check fails — the fix it asks for.
  if (user.includes("the project check"))
    return { tool: { name: "write_file", arguments: { path: "fixed.txt", content: "ok\n" } } };
  // D227: a write to a read-only path (agent.readOnlyPaths) is refused.
  if (user.includes("write the editor settings"))
    return {
      tool: { name: "write_file", arguments: { path: ".vscode/settings.json", content: "{}" } },
    };
  if (user.includes("make a checked change"))
    return { tool: { name: "write_file", arguments: { path: "changed.txt", content: "x\n" } } };
  if (user.includes("explore the readme"))
    return {
      tool: {
        name: "explore",
        arguments: { task: "What does the README say?", thoroughness: "quick" },
      },
    };
  // D111: a custom slash command's prompt arrives with the message; Cursor rules in the prompt.
  if (user.includes("the user ran the command /greet"))
    return { text: `Greeting: ${(user.match(/say hello to (\w+)/) ?? ["", "?"])[0]}` };
  if (user.includes("what are the rules"))
    return {
      text: `Rules: ${(system.match(/Project rules from \.cursorrules:\n(.+)/) ?? ["", "none"])[1].toLowerCase()}`,
    };
  if (user.includes("remember that"))
    return {
      tool: {
        name: "remember",
        arguments: { topic: "Testing", note: "Run the tests with npm test" },
      },
    };
  if (user.includes("what do you remember"))
    return {
      text: system.includes("testing.md — Testing")
        ? "From memory: testing.md."
        : "My memory is empty.",
    };
  if (user.includes("recall testing"))
    return { tool: { name: "recall", arguments: { topic: "testing" } } };
  if (user.includes("cd into the folder")) {
    const root = (system.match(/The open folder is (.+?)\. OS:/) ?? ["", "."])[1];
    return {
      tool: { name: "run_command", arguments: { command: `cd "${root}" && echo cd-ok` } },
    };
  }
  if (user.includes("page")) return { tool: { name: "browser_snapshot", arguments: {} } };
  if (user.includes("plan the work"))
    return {
      tool: {
        name: "update_plan",
        arguments: {
          steps: [
            { text: "Read the code", status: "done" },
            { text: "Make the change", status: "in_progress" },
            { text: "Run the tests", status: "pending" },
          ],
        },
      },
    };
  // D199: an ignored secret file, and a file with two separate changes (per-hunk review).
  if (user.includes("read the env file"))
    return { tool: { name: "read_file", arguments: { path: ".env" } } };
  if (user.includes("make the hunk file") && last.role !== "tool")
    return {
      tool: {
        name: "write_file",
        arguments: { path: "hunks.txt", content: "alpha\nbeta\ngamma\ndelta\nepsilon\n" },
      },
    };
  if (user.includes("change the hunk file") && last.role !== "tool")
    return {
      tool: {
        name: "write_file",
        arguments: {
          path: "hunks.txt",
          content: "alpha-new\nbeta\ngamma\ndelta\nepsilon-new\n",
        },
      },
    };
  // A group member on its own model in a chat on an external agent (D235).
  if (user.includes("acpmixed")) return { text: "Rev on its own model." };
  if (user.includes("break"))
    return {
      tool: {
        name: "edit_file",
        arguments: {
          path: "src/main.ts",
          old_string: "console.log(add(total, 2));",
          new_string: "console.log(add(total, missingName));",
        },
      },
    };
  if (user.includes("read"))
    return {
      text: "Let me read it.",
      tool: { name: "read_file", arguments: { path: "README.md" } },
    };
  if (user.includes("rename"))
    return {
      tool: {
        name: "edit_file",
        arguments: {
          path: "README.md",
          old_string: "# Sample workspace",
          new_string: "# Renamed workspace",
        },
      },
    };
  // Not the note a denied slash-command shell line leaves ("(not run: the user said no)").
  if (user.replace(/\(not run: [^)]*\)/g, "").includes("run"))
    return { tool: { name: "run_command", arguments: { command: "echo agent-ran" } } };
  return { thinking: "The user said hello.", text: "Hello from mock." };
}

let lastAnthropicSystem = null;

/** The Anthropic request as neutral messages for reply(), and the SSE answer. */
async function anthropicMessages(body, res) {
  const system = (body.system ?? []).map((b) => b.text).join("\n");
  const messages = [{ role: "system", content: system }];
  const names = {};
  let thinkingBack = 0;
  for (const m of body.messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") names[b.id] = b.name;
      if (b.type === "thinking" && b.signature) thinkingBack++;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      messages.push({ role: "assistant", content: text });
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_result")
        messages.push({
          role: "tool",
          tool_name: names[b.tool_use_id],
          content: b.content.map((c) => c.text ?? "").join(""),
        });
      else if (b.type === "text") messages.push({ role: "user", content: b.text });
    }
  }
  // A conversation's first message starts afresh (another script's chat came before it).
  if (body.messages?.length === 1) lastAnthropicSystem = null;
  const sameSystem = lastAnthropicSystem === null || lastAnthropicSystem === system;
  lastAnthropicSystem = system;
  currentModel = body.model ?? "";
  let r = reply(messages);
  if (lastUser(messages).includes("cache report"))
    r = {
      text: `Cache: auto=${!!body.cache_control} system=${!!body.system?.[0]?.cache_control} stableSystem=${sameSystem} thinkingBack=${thinkingBack} temperature=${"temperature" in body} state=${JSON.stringify(body.messages).includes("<ide_state>")}`,
    };
  // Anthropic's rate-limit headers (D201: the Usage page shows them).
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "anthropic-ratelimit-requests-limit": "50",
    "anthropic-ratelimit-requests-remaining": "49",
    "anthropic-ratelimit-requests-reset": new Date(Date.now() + 30_000).toISOString(),
    "anthropic-ratelimit-input-tokens-limit": "30000",
    "anthropic-ratelimit-input-tokens-remaining": "28790",
  });
  const ev = (data) => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  ev({
    type: "message_start",
    message: {
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: sameSystem ? 1000 : 0,
        cache_creation_input_tokens: 200,
        output_tokens: 1,
      },
    },
  });
  let i = 0;
  if (r.thinking && body.thinking) {
    ev({
      type: "content_block_start",
      index: i,
      content_block: { type: "thinking", thinking: "", signature: "" },
    });
    ev({
      type: "content_block_delta",
      index: i,
      delta: { type: "thinking_delta", thinking: r.thinking },
    });
    ev({
      type: "content_block_delta",
      index: i,
      delta: { type: "signature_delta", signature: `sig${i}` },
    });
    ev({ type: "content_block_stop", index: i++ });
  }
  if (r.text) {
    ev({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
    for (const part of r.text.match(/.{1,6}/gs) ?? [])
      ev({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: part } });
    ev({ type: "content_block_stop", index: i++ });
  }
  if (r.tool) {
    ev({
      type: "content_block_start",
      index: i,
      content_block: { type: "tool_use", id: `toolu_${Date.now()}`, name: r.tool.name, input: {} },
    });
    // pkgR (D355): arguments that stream in pieces, slowly, as a model writing a big call.
    const json = JSON.stringify(r.tool.arguments);
    const size = r.streamArgs?.chunk ?? json.length;
    const pieces = [];
    for (let at = 0; at < json.length; at += size) pieces.push(json.slice(at, at + size));
    for (const piece of pieces) {
      if (res.destroyed) return;
      ev({
        type: "content_block_delta",
        index: i,
        delta: { type: "input_json_delta", partial_json: piece },
      });
      if (r.streamArgs) await new Promise((done) => setTimeout(done, r.streamArgs.delayMs));
    }
    ev({ type: "content_block_stop", index: i++ });
  }
  ev({
    type: "message_delta",
    delta: { stop_reason: r.tool ? "tool_use" : "end_turn" },
    usage: { output_tokens: 7 },
  });
  ev({ type: "message_stop" });
  res.end();
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    // A remote MCP server with OAuth and a standing stream (D207): mock-remote-mcp.mjs.
    if (handleRemoteMcp(req, res, body, `http://127.0.0.1:${port}`)) return;
    // Image models (D381): mock-images.mjs.
    if (await handleImages(req, res, body)) return;
    // Dictation's speech model (D384): mock-speech.mjs.
    if (handleSpeech(req, res)) return;
    // A small documentation site for @docs (D204): robots.txt keeps out /docs-site/private.
    const docsPages = {
      "/robots.txt": `User-agent: *\nDisallow: /docs-site/private\nSitemap: http://127.0.0.1:${port}/docs-site2/sitemap.xml\n`,
      // D207: a sitemap that lists a page no link reaches, and a page that needs JavaScript.
      "/docs-site2/sitemap.xml": `<?xml version="1.0"?><urlset><url><loc>http://127.0.0.1:${port}/docs-site2/</loc></url><url><loc>http://127.0.0.1:${port}/docs-site2/orphan.html</loc></url><url><loc>http://127.0.0.1:${port}/docs-site2/app.html</loc></url><url><loc>http://127.0.0.1:${port}/docs-site/guide.html</loc></url></urlset>`,
      "/docs-site2/":
        "<html><head><title>Second docs</title></head><body><h1>Second docs</h1><p>The start page links nowhere.</p></body></html>",
      "/docs-site2/orphan.html":
        "<html><head><title>Orphan</title></head><body><h1>Orphan</h1><p>Gizmos hum quietly when idle.</p></body></html>",
      "/docs-site2/app.html":
        '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
      "/docs-site/":
        '<html><head><title>Mock docs</title></head><body><h1>Mock docs</h1><p>Start here.</p><a href="guide.html">Guide</a> <a href="widgets.html">Widgets</a> <a href="private/secret.html">Secret</a> <a href="https://example.com/out">Out</a></body></html>',
      "/docs-site/guide.html":
        '<html><head><title>Guide</title></head><body><h1>Guide</h1><p>Install the toolkit with one command.</p><a href="./">Home</a></body></html>',
      "/docs-site/widgets.html":
        "<html><head><title>Widgets</title></head><body><h1>Widgets</h1><p>Widgets spin when clicked and stop on release.</p></body></html>",
      "/docs-site/private/secret.html": "<html><body>secret</body></html>",
    };
    const docsPage = docsPages[req.url ?? ""];
    if (docsPage !== undefined) {
      res.writeHead(200, {
        "content-type":
          req.url === "/robots.txt"
            ? "text/plain"
            : req.url?.endsWith(".xml")
              ? "application/xml"
              : "text/html",
      });
      res.end(docsPage);
      return;
    }
    // The MCP registry (D207): /v0.1/servers?search=… and one server's latest version.
    if (req.url?.startsWith("/v0.1/servers")) {
      const entries = [
        {
          name: "io.github.mock/weather",
          title: "Mock weather",
          description: "Weather from a mock registry",
          version: "1.0.0",
          packages: [
            {
              registryType: "npm",
              identifier: "@mock/weather-mcp",
              version: "1.0.0",
              transport: { type: "stdio" },
              environmentVariables: [
                { name: "WEATHER_KEY", isSecret: true, isRequired: true, description: "Key" },
              ],
            },
          ],
        },
        {
          name: "io.github.mock/notes-remote",
          description: "Notes over HTTP",
          version: "2.0.0",
          remotes: [
            {
              type: "streamable-http",
              url: "https://notes.example/mcp",
              headers: [{ name: "Authorization", value: "Bearer {notes_token}", isSecret: true }],
            },
          ],
        },
      ];
      const url = new URL(req.url, "http://x");
      const one = /^\/v0\.1\/servers\/([^/]+)\/versions\/latest$/.exec(url.pathname);
      res.writeHead(200, { "content-type": "application/json" });
      if (one) {
        const found = entries.find((e) => e.name === decodeURIComponent(one[1]));
        res.end(JSON.stringify(found ? { server: found, _meta: {} } : {}));
        return;
      }
      const q = (url.searchParams.get("search") ?? "").toLowerCase();
      const hits = entries.filter((e) => `${e.name} ${e.description}`.toLowerCase().includes(q));
      res.end(
        JSON.stringify({
          servers: hits.map((server) => ({ server, _meta: {} })),
          metadata: { count: hits.length },
        }),
      );
      return;
    }
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          models: [
            {
              name: modelName,
              size: 1_000_000_000,
              details: { family: "mock", parameter_size: "1B", quantization_level: "Q4_0" },
            },
          ],
        }),
      );
      return;
    }
    // Embeddings (D227): a bag of words hashed into 64 numbers, so texts that share words are
    // close (the codebase index's tests find code by its words).
    if (req.url === "/v1/embeddings") {
      const request = JSON.parse(body);
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      const vector = (text) => {
        const v = new Array(64).fill(0);
        for (const word of String(text)
          .toLowerCase()
          .match(/[a-z]{3,}/g) ?? []) {
          let h = 0;
          for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
          v[h % 64] += 1;
        }
        return v;
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: inputs.map((t, index) => ({ index, embedding: vector(t) })),
          model: request.model,
        }),
      );
      return;
    }
    if (req.url === "/api/show") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          capabilities: ["completion", "tools", "thinking"],
          model_info: { "mock.context_length": contextLength },
        }),
      );
      return;
    }
    if (req.url === "/api/chat") {
      const request = JSON.parse(body);
      currentModel = request.model ?? "";
      // D180: "which tools" answers with the tools offered (Ask and Plan modes offer fewer).
      const r = lastUser(request.messages).includes("which tools do you have")
        ? {
            text: `Tools: ${(request.tools ?? []).map((t) => t.function?.name).join(", ")}.`,
          }
        : reply(request.messages);
      // A reply that takes its time (pkgG: a subagent seen while it works).
      if (r.delayMs) await new Promise((done) => setTimeout(done, r.delayMs));
      if (res.destroyed) return;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const send = (message, done = false) =>
        res.write(
          `${JSON.stringify({ model: request.model, message: { role: "assistant", content: "", ...message }, done })}\n`,
        );
      if (r.thinking) send({ thinking: r.thinking });
      if (r.text) for (const part of r.text.match(/.{1,6}/gs) ?? []) send({ content: part });
      // Several calls in one step (D253: they run together when they only read).
      const calls = r.tools ?? (r.tool ? [r.tool] : []);
      if (calls.length) send({ tool_calls: calls.map((c) => ({ function: c })) });
      res.end(
        `${JSON.stringify({ model: request.model, done: true, done_reason: "stop", prompt_eval_count: estimateTokens ? Math.ceil(body.length / 4) : 10, eval_count: estimateTokens ? Math.ceil(JSON.stringify(r).length / 4) : 5, message: { role: "assistant", content: "" } })}\n`,
      );
      return;
    }
    // Fill-in-the-middle (D204): /api/generate with `suffix`. A model named "*nofim*" has no
    // insert template (Ollama's 400); otherwise the middle says what it saw, so tests can check
    // the prompt carried the code before the cursor, the suffix and the context snippets.
    if (req.url === "/api/generate") {
      const request = JSON.parse(body);
      if (typeof request.suffix === "string" && String(request.model).includes("nofim")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `${request.model} does not support insert` }));
        return;
      }
      const prompt = String(request.prompt ?? "");
      const suffix = String(request.suffix ?? "");
      const line = prompt.slice(prompt.lastIndexOf("\n") + 1);
      // After "return ": the whole two-line middle, or its rest when part of it was accepted.
      // D224: ", imports" when the prompt carried an imported file's declarations; in a file named
      // counted.ts each answer is numbered ("// #2": the second request), so a test sees whether
      // the IDE asked again or reused a suggestion.
      const counted = prompt.includes("Path: src/counted.ts");
      if (counted) countedRequests++;
      const mark = counted ? ` // #${countedRequests}` : "";
      const full = `fimDone(${suffix.trim() ? "suffix" : "end"}${prompt.includes("Compare this snippet from") ? ", context" : ""}${prompt.includes("Imported from") ? ", imports" : ""})${mark}\nsecond line`;
      const typed = /return ?(\S*)$/.exec(line)?.[1];
      const middle =
        typed !== undefined && full.startsWith(typed)
          ? full.slice(typed.length)
          : `fim_middle()${mark}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: request.model,
          response: middle,
          done: true,
          done_reason: "stop",
          prompt_eval_count: Math.ceil(prompt.length / 4),
          eval_count: 6,
        }),
      );
      return;
    }
    // A SearXNG instance (D200): /search?q=…&format=json.
    if (req.url?.startsWith("/search")) {
      const q = new URL(req.url, "http://x").searchParams.get("q") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          query: q,
          results: [
            {
              title: `Mock result for ${q}`,
              url: "https://example.com/mock",
              content: "A <b>mock</b> snippet",
            },
            { title: "Second", url: "https://example.com/two", content: "Two" },
            // pkgE (D320): a result from a blocked domain, which the IDE filters out.
            ...(q.includes("-site:")
              ? [{ title: "Blocked", url: "https://blocked.example.com/x", content: "Blocked" }]
              : []),
          ],
        }),
      );
      return;
    }
    // A rejected key (D164): the setup page's Connect reports it and saves nothing.
    const auth = `${req.headers.authorization ?? ""} ${req.headers["x-api-key"] ?? ""}`;
    if (auth.includes("bad-key")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
      return;
    }
    // Anthropic's Messages API (D112): the same scripted replies, as SSE, with cache usage.
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      const model = {
        id: "claude-mock",
        type: "model",
        max_input_tokens: 200000,
        max_tokens: 64000,
        capabilities: { thinking: { supported: true }, image_input: { supported: true } },
      };
      res.end(JSON.stringify(req.url.startsWith("/v1/models/") ? model : { data: [model] }));
      return;
    }
    if (req.url === "/v1/messages") {
      anthropicMessages(JSON.parse(body), res);
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
});
// A connection reset mustn't end the mock (and every agent test after it).
server.on("clientError", (_err, s) => s.destroy());
server.listen(port, "127.0.0.1", () => process.stderr.write(`mock-ollama on ${port}\n`));
