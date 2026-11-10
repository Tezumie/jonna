// The built-in agent's toolset (PLAN §8.2): small on purpose (local models handle a dozen tools,
// not hundreds); everything else is reachable through find_commands / call_command. File edits go to
// the changeset (review) — never straight to disk; commands that change things ask the user in the
// conversation (permission policy, D70).

import type { QuestionAnswer } from "../../core/agent/askUser";
import { approveDecision, commandDecision, readApproveRules } from "../../core/agent/autoApprove";
import { type PlanStep, parsePlan } from "../../core/agent/compact";
import type { Item } from "../../core/agent/conversation";
import { applyEdits, type Edit, nearestRegion, withLineEndingsOf } from "../../core/agent/edits";
import { actsOnWindowFolder, helperPath } from "../../core/agent/isolatedHelpers";
import type { ToolOutcome } from "../../core/agent/loop";
import { applyPlanUpdate } from "../../core/agent/plan";
import {
  type SandboxPlan,
  sandboxArg,
  sandboxResultNote,
  sandboxStartError,
} from "../../core/agent/sandbox";
import {
  asText,
  closest,
  commandLine,
  errorText,
  headText,
  namespaces,
  rankCommands,
  structuredError,
} from "../../core/agent/toolText";
import {
  inFolders,
  pathReadings,
  relativeInFolders,
  resolveInFolders,
  sandboxPath,
} from "../../core/agent/workspaceFolders";
import type { ToolSpec } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { execIpc } from "../../core/ipc/process";
import { isAbsolute, isWithin, rebase, relativePath, resolveInRoot } from "../../core/paths/index";
import { isIdeControl } from "../../core/permissions/ideControl";
import type { WorkbenchServices } from "../../workbench/services";
import { AGENT_READ_MAX_BYTES, type Changeset, readDiskForAgent } from "./changeset";
import { listExtensionFolder, READ_LIMIT, readExtensionFile } from "./extensionFiles";
import {
  agentFolders,
  agentIgnored,
  agentIgnoredInFirst,
  agentIgnoredRel,
  agentWriteRefusal,
  ignoredInInput,
  ignoredMessage,
  workspaceInputPaths,
} from "./ignore";
import { cleanPathArg } from "./pathArg";
import {
  commandAllowed,
  commandDenied,
  DEFAULT_DENIED_COMMANDS,
  looksLikeServer,
  mayDeleteFiles,
  normalizedCommandParts,
  permissionKey,
  splitLeadingCd,
} from "./permissions";
import { keepCutOutput, PROCESS_TOOLS, runInBackground } from "./processTools";
import {
  isNotebook,
  mediaKind,
  readImageForAgent,
  readLines,
  readNotebook,
  readPdfForAgent,
  readPdfPages,
} from "./readFileOutput";
import { readGuard } from "./readGuard";
import { hiddenInDownloads } from "./riskyGuard";
import { sandboxInfo, sandboxPlanFor } from "./sandboxRun";
import { findFilesTool, type SearchToolHelpers, searchTool } from "./searchTools";
import { guardSelection } from "./stateSelection";
import { helperEnvOf, helperRootOf, toolRootFor } from "./toolRoots";

// Shared helpers of the agent's tools: argument checks, workspace-confined paths, output trimming.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const ANSI_OSC = new RegExp(`${ESC}\\][^${BEL}]*${BEL}`, "g");
const OUTPUT_LIMIT = 16000;
/** A foreground command's output kept at most (its start goes past it), and after a drop. */
const KEEP_OUTPUT = 4_000_000;
const KEEP_OUTPUT_AFTER_DROP = 3_000_000;

function str(v: unknown, name: string): string {
  if (typeof v !== "string" || !v) throw new Error(`"${name}" is required (a string).`);
  return v;
}

/** The folder the chat's tools work in: a headless helper's worktree, else the open folder. */
function root(host: ToolHost): string {
  const r = toolRootFor(host.services, host.session);
  if (!r) throw new Error("No folder is open.");
  return r;
}

/**
 * Workspace path from model input (relative or absolute); never outside the workspace's folders
 * (D251: any of them; a relative path may start with a folder's name).
 */
function resolve(host: ToolHost, path: unknown): string {
  const r = root(host);
  const cleaned = cleanPathArg(str(path, "path"));
  const worktree = helperRootOf(host.session);
  if (worktree) {
    const abs = resolveInRoot(r, cleaned);
    // A headless helper: a path in the main folder (its prompt names that one) means the same
    // file in its worktree; it never reaches the main folder.
    const inTree = helperPath(abs, worktree, host.services.workspace.root.peek(), {
      isWithin,
      rebase,
    });
    if (!inTree) throw new Error(`${String(path)} is outside your worktree (${worktree}).`);
    return inTree;
  }
  const abs = sandboxPath(agentFolders(host.services), cleaned);
  if (!abs) throw new Error(`${String(path)} is outside the workspace.`);
  return abs;
}

/**
 * Excluded from the agent (D199). A headless helper's worktree isn't the open folder the
 * patterns were loaded for: its files are judged by their path inside it.
 */
function ignored(host: ToolHost, abs: string, isDir = false): boolean {
  const worktree = helperRootOf(host.session);
  return worktree
    ? isWithin(worktree, abs) &&
        agentIgnoredInFirst(host.services, relativePath(worktree, abs), isDir)
    : agentIgnored(host.services, abs, isDir);
}

/** Why the agent may not write `abs` (an excluded file, a rule file), or null. */
function writeRefusal(host: ToolHost, abs: string): string | null {
  return (
    agentWriteRefusal(host.services, abs, rel(host, abs)) ??
    (ignored(host, abs) ? ignoredMessage(rel(host, abs)) : null)
  );
}

/**
 * Where a tool other than the file tools may write `path` (save_image, D381): the absolute path
 * and its name for the model, or why it may not.
 */
export function toolWriteTarget(
  host: ToolHost,
  path: unknown,
): { abs: string; name: string } | { refusal: string } {
  try {
    const abs = resolve(host, path);
    const refusal = writeRefusal(host, abs);
    return refusal ? { refusal } : { abs, name: rel(host, abs) };
  } catch (err) {
    return { refusal: err instanceof Error ? err.message : String(err) };
  }
}

/** How a path is named to the model: relative to the worktree, else as the workspace writes it. */
const rel = (host: ToolHost, abs: string) => {
  const worktree = helperRootOf(host.session);
  if (worktree) return relativePath(worktree, abs) || ".";
  root(host);
  return relativeInFolders(agentFolders(host.services), abs) || ".";
};

/**
 * A path inside a loaded extension's folder that isn't in the workspace (an installed one): read
 * and list tools may look there (to compare with or learn from it), through the extension
 * store's own reader, which stays inside the folder (D176). Null for anything else.
 */
function extensionTarget(
  host: ToolHost,
  path: unknown,
): { id: string; root: string; rel: string } | null {
  if (typeof path !== "string" || !path) return null;
  const r = host.services.workspace.root.peek();
  const cleaned = cleanPathArg(path);
  if (!isAbsolute(cleaned)) return null;
  const folders = agentFolders(host.services);
  if (inFolders(folders, resolveInFolders(folders, cleaned))) return null;
  // A headless helper's own worktree (or a main-folder path mapped onto it).
  const worktree = helperRootOf(host.session);
  if (worktree && helperPath(resolveInRoot(worktree, cleaned), worktree, r, { isWithin, rebase }))
    return null;
  for (const f of host.services.extensionGate.folders())
    if (isWithin(f.root, cleaned)) {
      const inner = relativePath(f.root, cleaned);
      return { id: f.id, root: f.root, rel: inner === "." ? "" : inner };
    }
  return null;
}

function tail(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `… [${text.length - limit} earlier characters omitted]\n${text.slice(-limit)}`;
}

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
});

export interface ToolHost {
  services: WorkbenchServices;
  session: string;
  turn(): number;
  changeset: Changeset;
  autoApply(): boolean;
  /** Inline permission card: once / always (adds the pattern to the allowlist) / deny. */
  ask(request: {
    title: string;
    detail?: string;
    always?: string;
    /** The "always" checkbox's own words (D353: "Allow for this chat"). */
    alwaysLabel?: string;
    /** A second, lasting choice (D374). */
    remember?: { label: string; run(): void };
    danger?: boolean;
    /** A short title for the card ("Run a command") and what it's about, shown as code. */
    heading?: string;
    code?: string;
    kind?: "command" | "ide" | "tool" | "agent";
    /** Asked even in full-access mode (deletion, MCP protection; D179). */
    evenWithFullAccess?: boolean;
  }): Promise<"once" | "always" | "deny">;
  /** Live output of run_command (the panel shows it in the tool row). */
  output(itemId: string, chunk: string): void;
  cancelled(): boolean;
  /** The session's plan now (update_plan changes it). */
  plan(): readonly PlanStep[];
  /** Replaces the session's plan (update_plan). */
  setPlan(steps: PlanStep[]): void;
  /**
   * Waits for the user's answer to the ask_user card of tool call `itemId` (D171): the choice
   * they clicked or what they typed; null when the turn is stopped.
   */
  question?(itemId: string): Promise<QuestionAnswer | null>;
  /** The conversation so far (suggest_extension's once-per-conversation rule, D314). */
  items?(): readonly Item[];
  /**
   * Runs a sub-agent with its own context on the same model (the explore tool, D127): only the
   * named tools, its own system prompt, a step limit. Resolves with its final answer.
   */
  subagent?(spec: SubagentSpec): Promise<string>;
  /** The tools this turn has, by name (what a subagent may be given, D195). */
  toolNames?(): string[];
  /** Starts a subagent in the background (D195); its report comes back as a message. Its id. */
  background?(spec: SubagentSpec & { name: string }): string;
  /**
   * Pre-approves `allowed-tools` entries for the rest of the turn (a user's own skill loaded with
   * use_skill, D221).
   */
  preApprove?(entries: readonly string[]): void;
  /**
   * The reasoning effort for the rest of the turn (a skill's `effort`, loaded with use_skill:
   * D229, as Claude Code applies it for the rest of the current turn).
   */
  setTurnEffort?(effort: string): void;
  /**
   * The model for the rest of the turn (a skill's `model`, loaded with use_skill, D232); `by`
   * names it in the chat's notice.
   */
  setTurnModel?(model: string, by: string): void;
  /** The rest of the turn works in the chat's mode as it is now (enter_plan_mode, D304). */
  followChatMode?(): void;
}

/** What a subagent run gets (explore, delegate, D127 / D195). */
export interface SubagentSpec {
  system: string;
  task: string;
  tools: string[];
  maxSteps: number;
  progress(line: string): void;
  /** How the Background tasks view names it (D326): a short description; else its task's line. */
  title?: string;
  /** Which agent runs it (explore, general…), for the Background tasks view. */
  agentName?: string;
  /** Its id in the Background tasks view (a background run's own); else a new one. */
  runId?: string;
  /** Its own model (provider/model, a model name or a Claude alias); else the turn's. */
  model?: string | null;
  /** Its own stop (a background run); else the turn's. */
  cancelled?: () => boolean;
  /** Where its request ids are kept (a background run's own set). */
  requests?: Set<string>;
  /**
   * Which subagent it is, for the project's rules (D207): folder and matching-files rules come
   * with its reads and edits of the files they cover, as for the main agent. None: no rules.
   */
  ruleNeeds?: { name: string; rules?: readonly string[]; omitRules?: boolean };
  /**
   * A workflow's agent (D338), started with `background`: its report comes here (null: stopped;
   * `error`: it failed) instead of to the chat as a message, and the chat shows no notice for it.
   */
  onReport?(report: string | null, error?: string): void;
  /** Each of its model requests' tokens and cost (a workflow's usage, D338). */
  onUsage?(usage: { input: number; output: number; cost: number | null }): void;
}

export interface AgentTool {
  spec: ToolSpec;
  readOnly: boolean;
  /** From an MCP server, not one of the IDE's own tools. */
  mcp?: true;
  /**
   * May run at the same time as the other calls of its step (D253). Default: `readOnly`. A
   * read-only tool that waits on the user (ask_user) says false.
   */
  concurrent?: boolean;
  /** Short verb for the panel row ("Read", "Ran"). */
  verb: string;
  /** The row's target (path, command, query). */
  target(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, host: ToolHost, itemId: string): Promise<ToolOutcome>;
}

// Agent tools that reach beyond files: run_command (approved shell commands, live output),
// get_state (ide:// paths), find_commands / call_command (the dispatcher, under the policy).
export const IDE_TOOLS: AgentTool[] = [
  {
    spec: {
      name: "run_command",
      description:
        "Run a shell command in the workspace (build, test, git, package managers). Returns exit code and output. It already runs in the open folder: don't `cd` into it (use `cwd` for a subfolder). Servers and watchers (`npm run dev`, `node server.js`, `python -m http.server`, `tsc --watch`) need `background: true`: they keep running with an id (bg1), you get their first output and URLs (open one with browser.open via call_command), then read new output with process_output and stop them with kill_process. A foreground command is stopped at its timeout. The user may have to approve it. Where the system allows, it runs sandboxed (writes only in the folder and temp; the result says so).",
      parameters: obj(
        {
          command: { type: "string" },
          cwd: { type: "string", description: "Folder, relative to the workspace (default: root)" },
          timeoutMs: {
            type: "integer",
            description: "Default 120000, at most 3600000 (foreground only)",
          },
          background: {
            type: "boolean",
            description:
              "Keep it running in the background with an id (servers, watchers): see process_output, kill_process",
          },
          notify_on_exit: {
            type: "boolean",
            description:
              "With background: get a message when it ends (exit code and last lines), for a long build or test run you don't want to keep checking",
          },
          sandbox: {
            type: "boolean",
            description:
              "false: run outside the sandbox, with the user's full rights (asks the user every time). Only when it failed because the sandbox blocked it",
          },
        },
        ["command"],
      ),
    },
    readOnly: false,
    verb: "Ran",
    target: (a) => {
      const command = String(a.command ?? "");
      return splitLeadingCd(command)?.rest ?? command;
    },
    async run(args, host, itemId) {
      let command = str(args.command, "command");
      // `cwd: ""` (models fill every field) is the root, not a path that's "required".
      if (cwdArg(args.cwd) === undefined && args.cwd !== undefined)
        args = { ...args, cwd: undefined };
      // `cd <somewhere in the folder> && …`: run the rest there instead (and don't ask about cd).
      const lead = splitLeadingCd(command);
      if (lead && typeof args.cwd !== "string") {
        // A folder outside the project (or cmd's `cd /d`) isn't taken: the command asks as is.
        let dir: string | null = null;
        try {
          dir = resolve(host, lead.dir);
        } catch {}
        // resolve() keeps it inside the workspace (or the helper's worktree).
        if (dir) {
          command = lead.rest;
          args = { ...args, command, cwd: dir };
        }
      }
      const settings = host.services.settings;
      // In the sandbox where there is one (D336); `sandbox: false` asks.
      const plan = await sandboxPlanFor(host.services, args);
      // Asked as run_command always asks (D322: the monitor tool asks the same way).
      const refused = await askToRun(host, command, args, plan);
      if (refused) return refused;
      if (args.background === true || (args.background !== false && looksLikeServer(command))) {
        if (host.cancelled()) return { result: "Stopped by the user.", isError: true };
        // Approved above: it runs on in the background with an id (D201, processTools.ts).
        const cwd = typeof args.cwd === "string" ? resolve(host, args.cwd) : root(host);
        const started = await runInBackground(
          host,
          itemId,
          command,
          cwd,
          rel(host, cwd),
          args.notify_on_exit === true,
          sandboxArg(plan),
        );
        // A dev server: show it (D117) — the user sees the result without asking, and the
        // browser tools can look at it. A tab already showing it is reused.
        const url = started.urls[0];
        if (started.running && url && settings.peek<boolean>("agent.openServers") !== false) {
          const ok = await host.services.dispatcher
            .execute("browser.open", { url, largest: true })
            .then(() => true)
            .catch(() => false);
          if (ok)
            started.result += `\nOpened ${url} in the IDE's browser tab (check it with get_state ide://browser or the browser commands).`;
        }
        const { urls: _urls, running: _running, ...outcome } = started;
        return outcome;
      }
      // Stopped while asking or saving "always": the command never starts (D161).
      if (host.cancelled()) return { result: "Stopped by the user.", isError: true };
      let output = "";
      // Characters dropped from the start of a huge output (what's kept is saved whole, D311).
      let dropped = 0;
      // A headless helper's commands run in its worktree, with its PORT (as its window's would).
      const worktree = helperRootOf(host.session);
      const ran = await execIpc
        .run(
          itemId,
          command,
          {
            ...(typeof args.cwd === "string"
              ? { cwd: resolve(host, args.cwd) }
              : worktree && { cwd: worktree }),
            ...(worktree && { env: helperEnvOf(host.session) }),
            // An hour at most: longer-running commands belong in the background.
            timeoutMs: Math.min(Number(args.timeoutMs) || 120000, 3_600_000),
            ...(plan.sandboxed && { sandbox: sandboxArg(plan) }),
          },
          (chunk) => {
            // A chatty build must not grow without bound: past KEEP_OUTPUT, its start goes.
            output += chunk;
            if (output.length > KEEP_OUTPUT) {
              dropped += output.length - KEEP_OUTPUT_AFTER_DROP;
              output = output.slice(-KEEP_OUTPUT_AFTER_DROP);
            }
            host.output(itemId, chunk);
          },
        )
        .catch((err: unknown) => {
          // The sandbox couldn't start (D336): the command never ran.
          if (!plan.sandboxed) throw err;
          return err instanceof Error ? err.message : String(err);
        });
      if (typeof ran === "string")
        return { result: sandboxStartError(ran), isError: true, summary: "sandbox failed" };
      const r = ran;
      // Strip ANSI escapes for the model.
      const plain = output.replace(ANSI_CSI, "").replace(ANSI_OSC, "");
      const seconds = (r.durationMs / 1000).toFixed(1);
      const status = r.timedOut ? "timed out" : r.cancelled ? "cancelled" : `exit ${r.exitCode}`;
      // A server run in the foreground dies at the timeout: say so, so the model doesn't claim it runs.
      const stopped = r.timedOut
        ? "\nThe process was STOPPED at the timeout — it is not running now. For servers and watchers, run it again with background: true."
        : "";
      // A cut output is kept whole for process_output (D311).
      const kept =
        plain.length > OUTPUT_LIMIT ? keepCutOutput(host.session, command, plain, dropped) : "";
      const box = sandboxInfo();
      const sandboxNote =
        r.sandboxed && box
          ? sandboxResultNote({
              info: box,
              failed: r.exitCode !== 0,
              output: plain,
              ...(plan.policy && { policy: plan.policy }),
              ...(r.blockedHosts && { blockedHosts: r.blockedHosts }),
              ...(r.sandboxNotes && { notes: r.sandboxNotes }),
            })
          : "";
      return {
        result: `$ ${command}\n${tail(plain, OUTPUT_LIMIT)}\n[${status} after ${seconds}s]${stopped}${kept}${sandboxNote}`,
        isError: r.exitCode !== 0,
        summary: `${status} · ${seconds}s${r.sandboxed ? " · sandboxed" : ""}`,
        detail: tail(plain, 4000),
      };
    },
  },
  {
    spec: {
      name: "get_state",
      description:
        "Read IDE state: ide://editors/active (open file, cursor, selection), ide://diagnostics (errors), ide://git/status, ide://terminals, ide://workspace, ide://layout, ide://browser, ide://events?since=<n> (what changed since you last looked) …",
      parameters: obj(
        {
          path: {
            type: "string",
            description: "An ide:// path (a query like ?brief=1 is passed on)",
          },
          offset: {
            type: "number",
            description:
              "Continue a long result from this character (within what the state's size budget kept; ask a narrower path for more)",
          },
        },
        ["path"],
      ),
    },
    readOnly: true,
    verb: "Looked at",
    target: (a) => String(a.path ?? ""),
    async run(args, host) {
      const path = str(args.path, "path");
      try {
        const snap = await host.services.state.get(path, { budget: 12000 });
        // The editor's selection in an excluded or protected file (D199, D221).
        snap.value = await guardSelection(host, snap.value);
        const text = asText(snap.value) + (snap.notes.length ? `\n(${snap.notes.join("; ")})` : "");
        return {
          result: headText(text, OUTPUT_LIMIT, numberArg(args.offset)),
          summary: snap.truncated ? "truncated" : undefined,
        };
      } catch (err) {
        const near = closest(
          path,
          host.services.state.list().map((p) => p.path),
        );
        return { result: errorText(structuredError(err, near)), isError: true };
      }
    },
  },
  {
    spec: {
      name: "find_commands",
      description:
        'Look up the IDE\'s commands (open files, git, terminals, layout, settings, extensions…). { query: words } → the best matches, one line each (id — effects — asks — what it does); { namespace: "git" } → every command there; {} → the namespaces; { ids: [...] } → full descriptions and input schemas for call_command.',
      parameters: obj(
        {
          query: { type: "string" },
          namespace: { type: "string", description: 'An id prefix, e.g. "git", "editor"' },
          ids: { type: "array", items: { type: "string" }, description: "Full details of these" },
        },
        [],
      ),
    },
    readOnly: true,
    verb: "Looked up",
    target: (a) =>
      String(a.query ?? a.namespace ?? (Array.isArray(a.ids) ? a.ids.join(", ") : "") ?? ""),
    async run(args, host) {
      const all = host.services.dispatcher.list().filter((c) => c.agent !== "hidden" && c.enabled);
      const asks = (c: (typeof all)[number]) => asksFor(host, c);
      if (Array.isArray(args.ids) && args.ids.length) {
        const out = args.ids.map((id) => {
          const c = all.find((x) => x.id === id);
          if (!c) {
            const near = closest(
              String(id),
              all.map((x) => x.id),
            );
            return {
              id,
              error: `Unknown command.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`,
            };
          }
          return {
            id: c.id,
            title: c.title,
            description: c.description,
            effects: c.effects,
            asks: asks(c),
            input: c.inputSchema,
          };
        });
        return { result: JSON.stringify(out, null, 1), summary: `${out.length} commands` };
      }
      const ns = typeof args.namespace === "string" ? args.namespace.replace(/\.$/, "") : "";
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!ns && !query)
        return {
          result: `Namespaces (commands): ${namespaces(all)}.\nList one with { namespace }, search with { query }.`,
          summary: "namespaces",
        };
      const hits = ns
        ? all.filter((c) => c.id.startsWith(`${ns}.`)).sort((a, b) => a.id.localeCompare(b.id))
        : rankCommands(all, query).slice(0, 20);
      if (!hits.length) {
        const near = ns
          ? closest(
              ns,
              namespaces(all)
                .split(", ")
                .map((x) => x.split(" ")[0] ?? ""),
            )
          : [];
        return {
          result: `No commands found.${near.length ? ` Namespaces like it: ${near.join(", ")}.` : " Try fewer words, or find_commands {} for the namespaces."}`,
          summary: "0 commands",
        };
      }
      return {
        result: `${hits.map((c) => commandLine(c, asks(c))).join("\n")}\n(Full input schemas: find_commands { ids: [...] }.)`,
        summary: `${hits.length} commands`,
      };
    },
  },
  {
    spec: {
      name: "call_command",
      description:
        "Run an IDE command by id (see find_commands) with its input. Commands that change things may ask the user (find_commands says which). A long result is cut: pass offset to read on.",
      parameters: obj(
        {
          id: { type: "string" },
          input: { type: "object" },
          offset: { type: "number", description: "Continue a long result from this character" },
        },
        ["id"],
      ),
    },
    readOnly: false,
    verb: "Ran command",
    target: (a) => String(a.id ?? ""),
    async run(args, host) {
      const id = str(args.id, "id");
      // A headless helper works in its worktree; these commands act on the window's folder.
      const worktree = helperRootOf(host.session);
      if (worktree && actsOnWindowFolder(id))
        return {
          result: `Error: ${id} acts on the IDE window's folder (${host.services.workspace.root.peek() ?? "none"}), not on your worktree (${worktree}). Use read_file, edit_file, write_file, list_dir, search, find_files and run_command (git too): they work in your worktree.`,
          isError: true,
          summary: "not in a worktree",
        };
      // Excluded files stay excluded through IDE commands too (editor.getText, git.fileHistory…).
      const hidden = ignoredInInput(host.services, host.services.workspace.root.peek(), args.input);
      if (hidden) return { result: ignoredMessage(hidden), isError: true, summary: "excluded" };
      // A file agent.autoApprove protects asks first through IDE commands too (editor.getText,
      // fs.* …), as read_file and edit_file do: a command was a way around the question.
      const folders = agentFolders(host.services);
      const rules = readApproveRules(host.services.settings.peek<unknown>("agent.autoApprove"));
      const guarded = folders.length
        ? workspaceInputPaths(host.services, args.input)
            .flatMap((abs) => pathReadings(folders, abs))
            .find(
              (p) =>
                approveDecision(rules, "reads", p) === "ask" ||
                approveDecision(rules, "edits", p) === "ask",
            )
        : undefined;
      if (guarded) {
        const answer = await host.ask({
          title: `${id} on ${guarded}`,
          heading: "Use a protected file",
          code: `${id} ${guarded}`,
          kind: "tool",
          detail: "agent.autoApprove says to ask before reading or changing this file.",
          evenWithFullAccess: true,
        });
        if (answer === "deny")
          return {
            result: `The user denied ${id} on ${guarded}.`,
            denied: true,
            summary: "denied",
          };
      }
      let result: unknown;
      try {
        result = await host.services.dispatcher.execute(id, args.input ?? {}, {
          kind: "agent",
          session: host.session,
        });
      } catch (err) {
        const ids = host.services.dispatcher
          .list()
          .filter((c) => c.agent !== "hidden")
          .map((c) => c.id);
        const near = host.services.dispatcher.has(id) ? [] : closest(id, ids);
        const e = structuredError(err, near);
        return {
          result: errorText(e),
          isError: true,
          summary: e.code === "denied" ? "denied" : "failed",
          ...(e.code === "denied" && { denied: true }),
        };
      }
      // Search results through call_command (search.run, quickOpen.search) drop excluded files
      // and those agent.autoApprove asks before reading, like the search and find_files tools.
      const approve = readApproveRules(host.services.settings.peek<unknown>("agent.autoApprove"));
      const hiddenRel = (p: unknown) =>
        typeof p === "string" &&
        (agentIgnoredRel(host.services, p) ||
          readProtected(host, approve, p) ||
          hiddenInDownloads(host.services, host.session, p));
      if (
        result &&
        typeof result === "object" &&
        Array.isArray((result as { results?: unknown }).results)
      )
        result = {
          ...(result as object),
          results: (result as { results: unknown[] }).results.filter(
            (m) => !(m && typeof m === "object" && hiddenRel((m as { path?: unknown }).path)),
          ),
        };
      if (
        id === "quickOpen.search" &&
        result &&
        typeof result === "object" &&
        Array.isArray((result as { files?: unknown }).files)
      )
        result = {
          ...(result as object),
          files: (result as { files: unknown[] }).files.filter(
            (f) =>
              !hiddenRel(
                f && typeof f === "object" ? (f as { path?: unknown }).path : (f as unknown),
              ),
          ),
        };
      // A screenshot command's image goes to the model as an image, not as base64 text.
      const png =
        result &&
        typeof result === "object" &&
        typeof (result as { png?: unknown }).png === "string"
          ? (result as { png: string }).png
          : undefined;
      const shown = png ? { ...(result as object), png: "(image attached)" } : result;
      // Text as text; a document keeps its beginning, a log its end (wishlist 2, 3).
      const text = asText(shown);
      const isLog =
        /log|output|history/i.test(id) ||
        (Array.isArray(shown) && shown.every((x) => typeof x === "string"));
      return {
        result:
          isLog && !args.offset
            ? tail(text, OUTPUT_LIMIT)
            : headText(text, OUTPUT_LIMIT, numberArg(args.offset)),
        summary: "done",
        ...(png && { images: [png] }),
      };
    },
  },
  // Background commands: their output and Stop (D201).
  ...PROCESS_TOOLS,
];

/**
 * run_command's permission check (D70, D117, D179, D204): null when `command` may run, else the
 * outcome to return (denied). The monitor tool (D322) asks the same way.
 */
export async function askToRun(
  host: ToolHost,
  command: string,
  args: Record<string, unknown>,
  /** Where it runs (D336): outside the sandbox on the model's request always asks. */
  sandbox?: SandboxPlan,
): Promise<ToolOutcome | null> {
  const settings = host.services.settings;
  // agent.autoApprove's commands patterns (D204): true runs it without asking, false always
  // asks (even with full access); with neither, the allow- and denylists decide as before.
  const approveRules = readApproveRules(settings.peek<unknown>("agent.autoApprove"));
  // An Ask pattern also sees the line as the denylist reads it: `C:\Git\cmd\git.exe push` or
  // `git -C sub push` still asks for `"git push": false` (never allows more).
  const rule = normalizedCommandParts(command).some(
    (part) => commandDecision(approveRules, part) === "ask",
  )
    ? "ask"
    : commandDecision(approveRules, command);
  // "auto" (D117): everything runs without asking except the denylist — like Cursor's
  // auto-run with a denylist and VS Code's terminal auto-approve rules. Not in a folder that
  // isn't trusted (D103): its package scripts, Makefile and agent.verifyCommand are the
  // folder's programs, and a cloned repository's files can steer the agent to run them.
  const mode = settings.peek<string>("agent.runCommands");
  const untrusted = mode === "auto" && host.services.trust.trusted !== true;
  const auto =
    rule !== "ask" &&
    mode !== "ask" &&
    !untrusted &&
    !commandDenied(command, [
      ...DEFAULT_DENIED_COMMANDS,
      ...(settings.peek<string[]>("agent.deniedCommands") ?? []),
    ]);
  // Deletion protection (D179): a line that may delete files asks, even with full access
  // and even when the allowlist has it.
  const protectDelete =
    settings.peek<boolean>("agent.deleteProtection") === true && mayDeleteFiles(command);
  const allowed =
    !protectDelete &&
    sandbox?.outsideAsked !== true &&
    rule !== "ask" &&
    (auto ||
      rule === "allow" ||
      commandAllowed(command, settings.peek<string[]>("agent.allowedCommands") ?? []));
  if (!allowed) {
    const always = permissionKey(command);
    const cwd = cwdArg(args.cwd);
    const folder =
      cwd !== undefined && rel(host, resolve(host, cwd)) !== "."
        ? `In ${rel(host, resolve(host, cwd))}.`
        : "";
    // Where it runs (D336): in the sandbox, or outside it.
    const where = [folder, sandbox?.card ?? ""].filter(Boolean).join(" ");
    const answer = await host.ask({
      title: `Run \`${command}\``,
      heading: "Run a command",
      code: command,
      kind: "command",
      ...(where && { detail: where }),
      ...(protectDelete || sandbox?.outsideAsked
        ? { evenWithFullAccess: true, danger: true }
        : rule === "ask"
          ? {
              evenWithFullAccess: true,
              detail: "agent.autoApprove says to ask before this command.",
            }
          : {
              always,
              ...(untrusted && {
                detail:
                  "This folder isn't trusted, so commands ask even in automatic mode (Manage workspace trust to change it).",
              }),
            }),
    });
    if (answer === "deny")
      return {
        result: "The user denied running this command.",
        denied: true,
        summary: "denied",
      };
    if (answer === "always") {
      const list = host.services.settings.peek<string[]>("agent.allowedCommands") ?? [];
      await host.services.settings
        .update("agent.allowedCommands", [...list, always], "user")
        .catch(() => {});
    }
  }
  return null;
}

/** The folder a command runs in (`cwd` from the model, else the chat's root), and its label. */
export function commandFolder(host: ToolHost, cwd: unknown): { abs: string; label: string } {
  const dir = cwdArg(cwd);
  const abs = dir !== undefined ? resolve(host, dir) : root(host);
  return { abs, label: rel(host, abs) };
}

/** A command's `cwd` from the model: a blank one (a model filling every field) is none. */
function cwdArg(cwd: unknown): string | undefined {
  return typeof cwd === "string" && cwd.trim() ? cwd : undefined;
}

/**
 * Whether agent.autoApprove asks before reading a workspace-relative result path (search, find):
 * by its workspace path and, in a multi-root workspace, by its path in its folder.
 */
function readProtected(
  host: ToolHost,
  rules: ReturnType<typeof readApproveRules>,
  rel: string,
): boolean {
  if (approveDecision(rules, "reads", rel) === "ask") return true;
  const folders = agentFolders(host.services);
  if (folders.length <= 1 || helperRootOf(host.session)) return false;
  return pathReadings(folders, resolveInFolders(folders, rel)).some(
    (p) => approveDecision(rules, "reads", p) === "ask",
  );
}

/** The path helpers searchTools.ts builds search and find_files with. */
const SEARCH_HELPERS: SearchToolHelpers = { resolve, rel, readProtected };

const numberArg = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/**
 * Whether calling the command now asks the user (wishlist 9), following the permission policy
 * (core/permissions createM2Policy, main.ts agentAlwaysAsks) and the agent's handler
 * (agent/index.ts, session.ask): "no", "yes", "every time", "if the line is denied" (a terminal
 * line in automatic mode) or "refused" (turned off).
 */
function asksFor(
  host: ToolHost,
  c: { id: string; effects: readonly string[] },
): "no" | "yes" | "every time" | "if the line is denied" | "refused" {
  const settings = host.services.settings;
  const readOnly = c.effects.every((e) => e === "read");
  const web = c.id === "web.fetch" || c.id === "web.search";
  if (web && settings.peek<boolean>("agent.webFetch.enabled") === false) return "refused";
  // Browser protection: page actions (not reading the page) ask every time, whatever the mode.
  if (
    c.id.startsWith("browser.") &&
    !(c.effects.length > 0 && readOnly) &&
    settings.peek<boolean>("agent.browserProtection") === true
  )
    return "every time";
  const ideControl =
    isIdeControl(c.id, c.effects) && settings.peek<boolean>("agent.ideControl") !== false;
  if (ideControl) return c.effects.includes("destructive") ? "every time" : "yes";
  if (readOnly) return "no";
  if (web && settings.peek<boolean>("agent.webFetch.autoApprove") === true) return "no";
  const mode = settings.peek<string>("agent.runCommands");
  // Full access: nothing else waits for an answer.
  if (mode === "full") return "no";
  if (c.effects.includes("destructive")) return "every time";
  if (mode === "auto" && host.services.trust.trusted)
    return SHELL_LINE_COMMANDS.has(c.id) ? "if the line is denied" : "no";
  return "yes";
}

/** IDE commands that type a command line into a terminal (checked against the denylist). */
const SHELL_LINE_COMMANDS = new Set(["terminal.sendText", "terminal.runCommand", "terminal.start"]);

export const CORE_TOOLS: AgentTool[] = [
  {
    spec: {
      name: "read_file",
      description: `Read a text file with line numbers (up to ${READ_LIMIT} lines; use offset for more). Shows your pending edits if any. Read a file before you edit it. An image (png, jpg, gif, webp…) is attached for you to see; a PDF is read as its text (pages: "1-5", at most 20 a call; needed past 10 pages); a Jupyter notebook (.ipynb) as its cells with outputs (offset and limit count cells).`,
      parameters: obj(
        {
          path: { type: "string", description: "File path, relative to the workspace" },
          offset: { type: "integer", description: "First line (1-based)" },
          limit: { type: "integer", description: `Lines to read (max ${READ_LIMIT})` },
          pages: { type: "string", description: 'PDF pages, e.g. "1-5" or "3"' },
        },
        ["path"],
      ),
    },
    readOnly: true,
    verb: "Read",
    target: (a) => String(a.path ?? ""),
    async run(args, host) {
      const ext = extensionTarget(host, args.path);
      if (ext) return readExtensionFile(ext, args);
      const path = resolve(host, args.path);
      if (ignored(host, path))
        return { result: ignoredMessage(rel(host, path)), isError: true, summary: "excluded" };
      // Pending edits and open buffers are text already; a file only on disk is checked for size
      // and binary content before it is read (a huge or binary file froze the UI and went to the
      // model as garbage).
      let text = host.changeset.staged(path) ?? host.services.quickDiff.bufferText(path);
      if (text === null) {
        const disk = await readDiskForAgent(path);
        const fail = (result: string, summary: string) => ({
          result: `Error: ${result}`,
          isError: true,
          summary,
        });
        if (disk.kind === "missing") return fail(`${rel(host, path)} doesn't exist.`, "not found");
        if (disk.kind === "folder")
          return fail(`${rel(host, path)} is a folder; use list_dir.`, "folder");
        // An image is shown to the model; a PDF is read as its text (D253).
        const media = mediaKind(path);
        const size = disk.kind === "tooLarge" ? disk.size : 0;
        if (media === "image") return readImageForAgent(path, rel(host, path), size);
        if (media === "pdf") {
          const pdf = await readPdfForAgent(path, rel(host, path), size);
          if ("result" in pdf) return pdf;
          return readPdfPages(rel(host, path), pdf, args);
        }
        if (disk.kind === "binary")
          return fail(`${rel(host, path)} is a binary file; it can't be read as text.`, "binary");
        if (disk.kind === "tooLarge")
          return fail(
            `${rel(host, path)} is too large to read (${(disk.size / 1048576).toFixed(1)} MB, the limit is ${AGENT_READ_MAX_BYTES / 1048576} MB). Use search to find the lines you need, or run_command with a tool like head or sed to read a part of it.`,
            "too large",
          );
        text = disk.text;
      }
      host.changeset.noteSeen(path, text);
      // A notebook as its cells (D310); its JSON is what edits and the read guard compare.
      if (isNotebook(path)) return readNotebook(rel(host, path), text, args);
      return readLines(rel(host, path), text, args);
    },
  },
  {
    spec: {
      name: "list_dir",
      description:
        "List a folder (default: the workspace root), up to depth 3. Ignored folders (node_modules, build output) are shown but not expanded.",
      parameters: obj(
        { path: { type: "string" }, depth: { type: "integer", description: "1-3 (default 1)" } },
        [],
      ),
    },
    readOnly: true,
    verb: "Listed",
    target: (a) => String(a.path ?? "."),
    async run(args, host) {
      const ext = extensionTarget(host, args.path);
      if (ext) return listExtensionFolder(ext, Math.min(3, Math.max(1, Number(args.depth) || 1)));
      const depth = Math.min(3, Math.max(1, Number(args.depth) || 1));
      // A multi-root workspace without a path: each folder, named, with its entries (D251).
      const folders = agentFolders(host.services);
      const everyFolder = !args.path && folders.length > 1 && !helperRootOf(host.session);
      const start = args.path ? resolve(host, args.path) : root(host);
      const out: string[] = [];
      const LIMIT = 500;
      let more = 0;
      const walk = async (dir: string, level: number, indent: string) => {
        if (out.length >= LIMIT) return;
        const entries = await fsIpc.listDir(dir);
        for (const e of entries) {
          if (e.name === ".git") continue;
          // One huge folder is capped too, not only the walk into the next one.
          if (out.length >= LIMIT) {
            more++;
            continue;
          }
          // Excluded from the agent (D199): named, not opened.
          const hidden = ignored(host, e.path, e.kind === "dir");
          // A Downloads folder the chat wasn't allowed into (D213): named, not opened.
          const downloads =
            !hidden && hiddenInDownloads(host.services, host.session, rel(host, e.path));
          out.push(
            `${indent}${e.name}${e.kind === "dir" ? "/" : ""}${hidden ? " (excluded from the agent)" : downloads ? " (in Downloads: ask the user first)" : e.ignored ? " (ignored)" : ""}`,
          );
          if (e.kind === "dir" && level < depth && !e.ignored && !hidden && !downloads)
            // A link to a folder outside the project can't be listed: noted, not fatal (D161).
            await walk(e.path, level + 1, `${indent}  `).catch(() =>
              out.push(`${indent}  (can't list: a link outside the folder?)`),
            );
        }
      };
      if (everyFolder) {
        out.push("(The workspace's folders: relative paths start with the folder's name.)");
        for (const f of folders) {
          out.push(`${f.name}/ (${f.path})`);
          await walk(f.path, 1, "  ").catch(() => out.push("  (can't list)"));
        }
      } else await walk(start, 1, "");
      if (more) out.push(`… and ${more} more (list a subfolder, or use find_files)`);
      return { result: out.join("\n") || "(empty)", summary: `${out.length} entries` };
    },
  },
  // find_files and search (D306, D307): searchTools.ts.
  findFilesTool(SEARCH_HELPERS),
  searchTool(SEARCH_HELPERS),
  {
    spec: {
      name: "edit_file",
      description:
        "Replace text in a file you have read with read_file in this chat (an edit to a file you haven't read, or that changed since, is refused). old_string must appear in the file exactly once: copy it from read_file's output (without the line-number prefix) with 2-4 lines of context, keeping the indentation. new_string replaces it. Set replace_all to change every occurrence. Several changes to one file go in one call as `edits` (each { old_string, new_string }, applied in order, all or none) instead of one call each. For new files or full rewrites use write_file. Changes go to the user for review.",
      parameters: obj(
        {
          path: { type: "string", description: "File path, relative to the folder" },
          old_string: { type: "string", description: "The exact text to replace" },
          new_string: { type: "string", description: "The text to put instead" },
          replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
          edits: {
            type: "array",
            description:
              "Several changes to this file at once, in place of old_string / new_string: applied in order; if one doesn't match, none is made",
            items: {
              type: "object",
              properties: {
                old_string: { type: "string" },
                new_string: { type: "string" },
                replace_all: { type: "boolean" },
              },
              required: ["old_string", "new_string"],
            },
          },
        },
        ["path"],
      ),
    },
    readOnly: false,
    verb: "Edited",
    target: (a) => String(a.path ?? ""),
    async run(args, host) {
      const path = resolve(host, args.path);
      const refusal = writeRefusal(host, path);
      if (refusal) return { result: refusal, isError: true, summary: "excluded" };
      const current = await host.changeset.current(path);
      const early = editsFrom(args);
      // All or none: an `edits` item without its old_string / new_string isn't skipped quietly.
      if (Array.isArray(args.edits) && args.edits.length > 0 && early.length !== args.edits.length)
        return {
          result:
            'Error: every item of `edits` needs old_string and new_string (new_string "" to delete). Nothing was changed.',
          isError: true,
          summary: "edit failed",
        };
      // Creating a file with edit_file (old = "") is what some models do; allow it.
      if (current === null && early.length > 0 && early.every((e) => e.old === ""))
        return propose(host, path, early.map((e) => e.new).join("\n"));
      if (current === null)
        return {
          result: `Error: ${rel(host, path)} doesn't exist; use write_file to create it.`,
          isError: true,
          summary: "not found",
        };
      const edits = early;
      if (edits.length === 0)
        return { result: "Error: give old_string and new_string.", isError: true };
      // Read before edit, and not changed since (D309).
      const unread = readGuard(host.changeset, path, rel(host, path), current, "edit_file");
      if (unread) return unread;
      const r = applyEdits(current, edits);
      if (!r.ok) {
        // The edit that failed (of several, the one applyEdits names), for its text and region.
        const failing = edits[r.index ?? 0] ?? edits.find((e) => e.old);
        // Give the model the real text so the next attempt can copy it instead of guessing.
        const lines = current.split("\n").length;
        const shown =
          lines <= 150
            ? `The file's current content (${lines} lines):\n${current}`
            : `The closest part of the file:\n${nearestRegion(current, failing?.old ?? "") ?? current.split("\n").slice(0, 60).join("\n")}`;
        const sent = failing?.old ?? "";
        return {
          result: `Error: ${r.error} Nothing was changed. Your old_string was:\n${sent.slice(0, 600)}\n---\nCopy old_string exactly from the file below (or use write_file to replace the whole file).\n${shown}`,
          isError: true,
          summary: "edit failed",
        };
      }
      const done = await propose(host, path, r.text);
      if (r.approximate?.length)
        done.result += `\n\nNote: old_string didn't match exactly; the closest block was replaced (around line ${r.approximate.join(", ")}). Read that part back to check it's what you meant.`;
      return done;
    },
  },
  {
    spec: {
      name: "write_file",
      description:
        "Create a file, or replace a file's whole content (an existing file must be read with read_file first). Prefer edit_file for changes to existing files. Written to disk at once; the user reviews it afterwards.",
      parameters: obj({ path: { type: "string" }, content: { type: "string" } }, [
        "path",
        "content",
      ]),
    },
    readOnly: false,
    verb: "Wrote",
    target: (a) => String(a.path ?? ""),
    async run(args, host) {
      const path = resolve(host, args.path);
      const refusal = writeRefusal(host, path);
      if (refusal) return { result: refusal, isError: true, summary: "excluded" };
      // No content isn't an empty file: a call without it (a model's slip) emptied the file.
      if (typeof args.content !== "string")
        return {
          result:
            'Error: "content" is required (a string, the whole file). Nothing was written; for an empty file pass "".',
          isError: true,
          summary: "no content",
        };
      const current = await host.changeset.current(path);
      // Replacing a file whole needs it read first (D309), and unchanged since the agent last
      // read or wrote it (the user typed, a formatter ran): else that change would go unseen.
      if (current !== null) {
        const unread = readGuard(host.changeset, path, rel(host, path), current, "write_file");
        if (unread) return unread;
      }
      return propose(host, path, withLineEndingsOf(current, args.content));
    },
  },
  ...IDE_TOOLS,
];

async function propose(host: ToolHost, path: string, text: string): Promise<ToolOutcome> {
  const before = await host.changeset.current(path);
  // New compile/syntax errors go back to the model right away (D107), like an editor's squiggles.
  // Checked before the write (D199): once on disk, the open editor reloads and its markers would
  // count the new errors as old ones.
  const errors =
    host.services.settings.peek<boolean>("agent.checkEdits") === false
      ? null
      : await host.services.codeCheck.newErrors(path, text, before).catch(() => null);
  // Stopped while the language service checked (D161): nothing is written; it stays a proposal.
  const file = await host.changeset.propose(path, text, host.turn(), {
    staged: host.cancelled(),
  });
  const { added, removed } = host.changeset.stat(file);
  const name = rel(host, path);
  const problems = errors?.length
    ? `\n\nThe language service reports ${errors.length === 1 ? "a new error" : `${errors.length} new errors`} in ${name} after this change — fix ${errors.length === 1 ? "it" : "them"}:\n${errors.map((e) => `- line ${e.line}:${e.column}: ${e.message.split("\n")[0]}`).join("\n")}`
    : "";
  const summary = `+${added} −${removed}${errors?.length ? ` · ${errors.length} error${errors.length === 1 ? "" : "s"}` : ""}`;
  // Open with unsaved edits of the user's: written into the editor, which stays unsaved —
  // commands and tests still see the file on disk (D161).
  const open = host.services.quickDiff.bufferText(path);
  const disk = open === null ? null : await readDiskForAgent(path);
  const unsaved =
    open !== null && (disk?.kind !== "text" || disk.text !== open)
      ? ` It's open in the editor with the user's unsaved changes, so it isn't saved to disk yet: commands and tests see the old file until the user saves.`
      : "";
  // Auto-apply needs no review (stopped while the language service checked: it stays under
  // review). In Review mode the file is written too (D199); the user reviews it afterwards.
  if (host.autoApply() && !host.cancelled()) {
    await host.changeset.accept([path]);
    return {
      result: `Applied to ${name} (+${added} −${removed}).${unsaved}${problems}`,
      summary,
      changes: [path],
    };
  }
  return {
    result: `Wrote ${name} (+${added} −${removed}); the user reviews it afterwards.${unsaved || " It's on disk: commands and tests see it."}${problems}`,
    summary,
    changes: [path],
  };
}

/**
 * The edits of an edit_file call, tolerating what smaller models send: one edit at the top level,
 * `edits` as a JSON string, and the other tools' names (old_string/new_string, old_str/new_str,
 * search/replace, find/replace).
 */
export function editsFrom(args: Record<string, unknown>): Edit[] {
  let raw: unknown = args.edits ?? args.changes;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = undefined;
    }
  }
  // `edits: []` beside a top-level old_string (models that fill every field): that edit.
  const list =
    Array.isArray(raw) && raw.length > 0
      ? raw
      : raw && typeof raw === "object" && !Array.isArray(raw)
        ? [raw]
        : [args];
  const pick = (o: Record<string, unknown>, keys: string[]) => {
    for (const k of keys) if (typeof o[k] === "string") return o[k] as string;
    return undefined;
  };
  const out: Edit[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const oldText = pick(o, [
      "old_string",
      "old",
      "old_str",
      "oldString",
      "oldText",
      "old_text",
      "search",
      "find",
      "from",
      "original",
    ]);
    const newText = pick(o, [
      "new_string",
      "new",
      "new_str",
      "newString",
      "newText",
      "new_text",
      "replace",
      "replacement",
      "to",
      "updated",
    ]);
    if (oldText === undefined || newText === undefined) continue;
    out.push({
      old: oldText,
      new: newText,
      all: o.all === true || o.replace_all === true || o.replaceAll === true,
    });
  }
  return out;
}

/**
 * The agent's own checklist (D109, D300): a card under the conversation's latest message,
 * re-sent with every request. The whole list once, then small changes (advance, done, start)
 * sent together with the call that starts the next step, so it costs no request of its own.
 */
export const PLAN_TOOL: AgentTool = {
  spec: {
    name: "update_plan",
    description:
      "The checklist the user follows your work by, for any task with more than one step (editing files, running more than one command). First call: the whole plan as steps, short imperative phrases (at most ~7 words), the step you're starting in_progress and the rest pending; send it in the same reply as your first other tool call, never in a reply of its own. Then, as each step finishes, send { advance: true } in the same reply as the call that begins the next step (it marks the step in progress done and starts the next). Out of order: { done: [2], start: 4 } (1-based). Plan changed (the user asked for something else, or you learned more): the whole list again. Keep exactly one step in_progress while you work. A step you're on when your reply ends is marked done for you.",
    parameters: obj(
      {
        steps: {
          type: "array",
          description: "The whole plan, in order: replaces the current one.",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["text", "status"],
          },
        },
        advance: {
          type: "boolean",
          description: "Marks the step in progress done and starts the next pending one.",
        },
        done: {
          type: "array",
          items: { type: "integer" },
          description: "Step numbers (1-based) now done.",
        },
        start: { type: "integer", description: "The step number (1-based) now in progress." },
      },
      [],
    ),
  },
  readOnly: true,
  verb: "Updated plan",
  target: (a) => {
    const steps = parsePlan(a);
    if (steps?.length)
      return `${steps.filter((s) => s.status === "done").length}/${steps.length} done`;
    return (a as { advance?: unknown } | null)?.advance ? "next step" : "";
  },
  async run(args, host) {
    const r = applyPlanUpdate(host.plan(), args);
    if ("error" in r) return { result: `Error: ${r.error}`, isError: true };
    host.setPlan(r.steps);
    const done = r.steps.filter((s) => s.status === "done").length;
    const current = r.steps.find((s) => s.status === "in_progress");
    return {
      result: `Plan updated (${done}/${r.steps.length} done${current ? `; now: ${current.text}` : ""}).`,
      summary: `${done}/${r.steps.length} done`,
    };
  },
};
