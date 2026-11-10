// Running the agent's hooks (D227, core/agent/hooks.ts): the user's `agent.hooks` (user settings
// only: a folder's IDE settings mustn't add commands) and, in a trusted folder, the `hooks` of its
// `.claude/settings.json` and `.claude/settings.local.json` (Claude Code's, so a project's hooks
// work for both). A folder's hooks run the repository's commands, so they are approved per
// content (SHA-256), like a folder's MCP servers. Each hook runs in the folder with the event as
// JSON on stdin and CLAUDE_PROJECT_DIR set, through the same runner as the agent's commands
// (PowerShell on Windows). Stop ends running hooks.
// D251: in a multi-root workspace every folder's hooks count, each run in its own folder (with
// CLAUDE_PROJECT_DIR set to it); one approval covers the set of all of them, so a folder that
// adds hooks asks again. The user's own hooks run in the first folder.
import {
  combineDecisions,
  type FolderHookSet,
  type HookCommand,
  type HookDecision,
  type HookEvent,
  type HookFields,
  type HookTable,
  hookDecision,
  hookInput,
  hookSignatureText,
  hooksFor,
  labelHooks,
  mergeHooks,
  parseHooks,
} from "../../core/agent/hooks";
import { fsIpc } from "../../core/ipc/fs";
import { execIpc } from "../../core/ipc/process";
import type { DisposableStore } from "../../core/lifecycle/index";
import { isWindowsPath, joinPath, pathKey } from "../../core/paths/index";
import { parseJsonc } from "../../core/settings/jsonc";
import type { WorkbenchServices } from "../../workbench/services";
import { activePlugins, pluginLabel } from "./pluginContributions";
import type { AgentSession } from "./session";

const FOLDER_FILES = [".claude/settings.json", ".claude/settings.local.json"];

/** What the approval card shows: every command, up to a size it can hold. */
const SHOWN_CHARS = 4000;

/** The most of a hook's output kept: its end, where the JSON answer is. */
const KEPT_OUTPUT = 64_000;

/**
 * A signature of the folders' hook commands (what the user approved): SHA-256, so a changed set
 * can't be made to look like the approved one. With each folder in it: an approval in one
 * repository doesn't carry to another whose same command names a script of its own.
 */
async function signature(sets: readonly FolderHookSet[]): Promise<string> {
  const bytes = new TextEncoder().encode(hookSignatureText(sets, pathKey));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** This page load, in hook command ids: a reload's ids never repeat the last load's. */
const PAGE_LOAD = Date.now().toString(36);

export class AgentHooks {
  /** Folder hook signatures the user allowed (saved per workspace). */
  approved = new Set<string>();
  /** Declined in this folder, and allowed once per chat (`<chat> <sig>`): not asked again. */
  private declined = new Set<string>();
  private allowedOnce = new Set<string>();
  private seq = 0;

  constructor(private readonly services: WorkbenchServices) {}

  /** A new folder: nothing of its hooks declined or allowed yet. */
  folderChanged(): void {
    this.declined.clear();
    this.allowedOnce.clear();
  }

  /** One folder's hooks, read fresh each time: they're small files. */
  private async hooksOf(root: string): Promise<HookTable> {
    const tables: HookTable[] = [];
    for (const rel of FOLDER_FILES) {
      try {
        const text = new TextDecoder().decode(await fsIpc.read(joinPath(root, rel)));
        const parsed = parseJsonc(text);
        if (parsed.ok) tables.push(parseHooks((parsed.value as { hooks?: unknown })?.hooks, rel));
      } catch {
        // No such file, or not JSON: no hooks from it.
      }
    }
    return mergeHooks(...tables);
  }

  /** Every folder's hooks (trusted workspaces only), the first folder first. */
  private async folderHooks(): Promise<(FolderHookSet & { name: string })[]> {
    const { workspace, trust } = this.services;
    const root = workspace.root.peek();
    if (!root || !trust.trusted) return [];
    const folders = workspace.folders.peek().length
      ? workspace.folders.peek()
      : [{ path: root, name: root }];
    const sets = await Promise.all(
      folders.map(async (f) => ({ root: f.path, name: f.name, table: await this.hooksOf(f.path) })),
    );
    return sets.filter((s) => Object.keys(s.table).length);
  }

  /** The hooks to run, each set with the folder it runs in. */
  private async table(
    session: AgentSession,
    ask = true,
  ): Promise<{ cwd: string; table: HookTable }[]> {
    const primary = this.services.workspace.root.peek() ?? "";
    const user = [
      {
        cwd: primary,
        table: parseHooks(this.services.settings.peek("agent.hooks"), "user settings"),
      },
      // D358: the enabled plugins' hooks the user let run when installing them.
      ...activePlugins
        .peek()
        .filter((p) => p.hooks)
        .map((p) => ({ cwd: primary, table: parseHooks(p.hooks, pluginLabel(p.name)) })),
    ];
    const sets = await this.folderHooks();
    if (!sets.length) return user;
    // With several folders, each command says which folder set it.
    const several = this.services.workspace.folders.peek().length > 1;
    const withFolders = [
      ...user,
      ...sets.map((s) => ({ cwd: s.root, table: several ? labelHooks(s.table, s.name) : s.table })),
    ];
    const sig = await signature(sets);
    if (this.approved.has(sig) || this.allowedOnce.has(`${session.id} ${sig}`)) return withFolders;
    // A chat that's ending (SessionEnd) can't ask: only what was allowed runs.
    if (this.declined.has(sig) || session.cancelled || !ask) return user;
    const commands = sets
      .flatMap((s) =>
        Object.values(s.table).flatMap((groups) =>
          groups.flatMap((g) =>
            g.commands.map((c) => (several ? `${c.command}   # ${s.name}` : c.command)),
          ),
        ),
      )
      .join("\n");
    // All of it, or said that it's cut (and then no "always": the user hasn't seen it all).
    const cut = commands.length > SHOWN_CHARS;
    const answer = await session.ask({
      title: "Run this folder's agent hooks?",
      heading: "Run this folder's agent hooks?",
      detail: several
        ? `The .claude/settings.json of ${sets.map((s) => s.name).join(", ")} set${sets.length === 1 ? "s" : ""} commands that run on the agent's events (its tools, each message, a chat's start and end, when it stops…), each in its folder. They run with your permissions.`
        : "The folder's .claude/settings.json sets commands that run on the agent's events (its tools, each message, a chat's start and end, when it stops…). They run with your permissions.",
      code: cut
        ? `${commands.slice(0, SHOWN_CHARS)}\n… ${commands.length - SHOWN_CHARS} more characters: read .claude/settings.json`
        : commands,
      kind: "tool",
      ...(!cut && { always: several ? "always for this workspace" : "always for this folder" }),
      evenWithFullAccess: true,
    });
    // Stopped while asking isn't a no: it asks again next time.
    if (session.cancelled) return user;
    if (answer === "deny") {
      this.declined.add(sig);
      return user;
    }
    this.allowedOnce.add(`${session.id} ${sig}`);
    if (answer === "always") {
      this.approved.add(sig);
      this.services.persistence.scheduleSave();
    }
    return withFolders;
  }

  /**
   * Runs the hooks for an event; null when there are none. A failed hook (not 0 or 2) shows as a
   * notice in the chat and blocks nothing.
   */
  async run(
    session: AgentSession,
    event: HookEvent,
    fields: HookFields,
  ): Promise<HookDecision | null> {
    // Hooks run in the folder: with none open there's nowhere to run them. A chat's end runs
    // even after a Stop (the chat is closing; nothing waits on it).
    const ending = event === "SessionEnd";
    if (!this.services.workspace.root.peek() || (session.cancelled && !ending)) return null;
    const tables = await this.table(session, !ending);
    // Each command with the folder it runs in (its folder's hooks there, the user's in the first).
    const commands: (HookCommand & { cwd: string })[] = tables.flatMap((t) =>
      hooksFor(t.table, event, fields).map((c) => ({ ...c, cwd: t.cwd })),
    );
    if (!commands.length || (session.cancelled && !ending)) return null;
    // Claude Code's hooks say "$CLAUDE_PROJECT_DIR"/…: in PowerShell (Windows folders, not WSL's)
    // that's a script variable, unset, so it's set from the environment first.
    const prefixFor = (cwd: string) =>
      isWindowsPath(cwd) && !/^\\\\wsl(\.localhost|\$)\\/i.test(cwd)
        ? "$CLAUDE_PROJECT_DIR = $env:CLAUDE_PROJECT_DIR; "
        : "";
    // Stop ends the hooks that are running (they'd hold the turn until their timeout).
    // Unique across page loads too (the counter starts again at each one).
    const ids = commands.map(() => `hook-${session.id}-${PAGE_LOAD}-${++this.seq}`);
    const stop = () => {
      for (const id of ids) void execIpc.cancel(id).catch(() => {});
    };
    session.stopHandlers.add(stop);
    session.hookStops.add(stop);
    let decisions: HookDecision[];
    try {
      decisions = await Promise.all(
        commands.map(async (c, i): Promise<HookDecision> => {
          let output = "";
          const cwd = c.cwd;
          const input = hookInput(event, { sessionId: session.id, cwd, ...fields });
          try {
            const r = await execIpc.run(
              ids[i] ?? `hook-${session.id}-${++this.seq}`,
              `${prefixFor(cwd)}${c.command}`,
              // Claude Code's project hooks name their scripts with CLAUDE_PROJECT_DIR.
              { cwd, timeoutMs: c.timeoutMs, stdin: input, env: { CLAUDE_PROJECT_DIR: cwd } },
              (chunk) => {
                output += chunk;
                if (output.length > KEPT_OUTPUT * 2) output = output.slice(-KEPT_OUTPUT);
              },
            );
            if (r.cancelled) return { block: false, reason: "", context: "" };
            const d = hookDecision(
              { exitCode: r.exitCode, output: output.slice(-KEPT_OUTPUT), timedOut: r.timedOut },
              event,
            );
            return d.error
              ? { ...d, error: `${event} hook \`${c.command}\` (${c.source}): ${d.error}` }
              : d;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
              block: false,
              reason: "",
              context: "",
              error: `${event} hook \`${c.command}\` didn't run: ${message}`,
            };
          }
        }),
      );
    } finally {
      session.stopHandlers.delete(stop);
      session.hookStops.delete(stop);
    }
    const all = combineDecisions(decisions);
    if (all.error && !session.cancelled) session.hookNotice(all.error);
    return all;
  }
}

export function registerHooks(sub: DisposableStore, services: WorkbenchServices): AgentHooks {
  const hooks = new AgentHooks(services);
  sub.add(services.workspace.onDidOpen(() => hooks.folderChanged()));
  // Folders added or removed: the set of hooks is another one (its signature differs anyway).
  sub.add(services.workspace.onDidChangeFolders(() => hooks.folderChanged()));
  sub.add(
    services.state.register("ide://agent/hooks", {
      description:
        "The agent's hooks from user settings (agent.hooks, Claude Code's format) and how many folder hook sets were approved (in a multi-root workspace one set covers every folder's hooks).",
      get: () => ({
        user: parseHooks(services.settings.peek("agent.hooks"), "user settings"),
        folderApproved: hooks.approved.size,
      }),
    }),
  );
  sub.add(
    services.persistence.register("agent.hooksApproved", {
      save: () => [...hooks.approved],
      restore: (data) => {
        hooks.approved = new Set(
          Array.isArray(data) ? data.filter((x): x is string => typeof x === "string") : [],
        );
      },
    }),
  );
  return hooks;
}
