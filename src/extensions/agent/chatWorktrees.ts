// The chat itself in a git worktree (D337, Claude Code's EnterWorktree / ExitWorktree):
// enter_worktree makes a branch and folder of its own (the worktree agents' way: next to the
// repository, agent/<name>, setup step and PORT; worktreeAgents.ts) or enters an existing worktree
// of this repository by path, and the chat's tools then work there (toolRoots.ts, as a headless
// helper's do; the open folder isn't touched). exit_worktree leaves it: keep (the branch stays for
// review and merge, which go through the worktree agents' record: agent.compareWorktrees,
// agent.applyWorktree) or remove (asks first when that would lose changes or commits). The chat
// remembers its worktree (meta.worktree) and the header shows the branch (view/worktreeChip.ts).
// Only when the user asks for a worktree. Never links node_modules (or anything) into it.
// Command: agent.chatWorktree; state: ide://agent/chatWorktrees. Model: core/agent/chatWorktree.ts.

import {
  type ChatWorktree,
  changedFiles,
  chatWorktreeBranch,
  enteredText,
  leftText,
  parseChatWorktree,
  removalLoss,
} from "../../core/agent/chatWorktree";
import type { ToolOutcome } from "../../core/agent/loop";
import { portSettings, worktreeEnv } from "../../core/agent/worktrees";
import { fsIpc } from "../../core/ipc/fs";
import { gitIpc } from "../../core/ipc/git";
import { execIpc } from "../../core/ipc/process";
import type { DisposableStore } from "../../core/lifecycle/index";
import { samePath } from "../../core/paths/index";
import { effect, type ReadonlySignal, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { backgroundProcesses } from "./backgroundProcesses";
import { newId } from "./ids";
import type { SessionManager } from "./sessions";
import { helperRootOf, setToolRoot } from "./toolRoots";
import type { AgentTool, ToolHost } from "./tools";
import type { WorktreeRegistry } from "./worktreeRuns";

const worktrees = signal<ReadonlyMap<string, ChatWorktree>>(new Map());

/** The chats working in a worktree, by chat id (the header's branch button follows it). */
export const chatWorktrees: ReadonlySignal<ReadonlyMap<string, ChatWorktree>> = worktrees;

/** The PORT / WORKTREE_* a worktree's commands get, by its record (set by the registration). */
let envOf: (agent: string) => Record<string, string> = () => ({});

function setWorktree(session: string, w: ChatWorktree | null): void {
  const next = new Map(worktrees.peek());
  if (w) next.set(session, w);
  else next.delete(session);
  worktrees.value = next;
  // Its tools on the worktree, with its PORT as its window would have (null: the window's folder).
  setToolRoot(session, w?.folder ?? null, w ? envOf(w.agent) : {});
}

/** With each message of a chat in a worktree (sessionTurn.ts): where its tools work. */
export function chatWorktreeNote(session: string): string {
  const w = worktrees.peek().get(session);
  return w
    ? `This chat works in the git worktree ${w.folder} (branch ${w.branch}), not the open folder ${w.from}: your file tools, searches and commands act there. Leave it with exit_worktree.`
    : "";
}

/** What a chat saves about its worktree (sessionStore.ts, meta). */
export function worktreeMeta(session: string): { worktree?: ChatWorktree } {
  const w = worktrees.peek().get(session);
  return w ? { worktree: w } : {};
}

/**
 * A loaded chat that was in a worktree goes on there. The folder is let into Rust's scope by the
 * tool gate before its next tool call (isolatedHelpers.ts), which also says when it's gone.
 */
export function restoreChatWorktree(session: string, raw: unknown): void {
  const w = parseChatWorktree(raw);
  if (w) setWorktree(session, w);
  else if (worktrees.peek().has(session)) setWorktree(session, null);
}

/** Runs git in `folder` (let into scope first); its output, or null when it failed. */
async function gitIn(folder: string, args: string): Promise<string | null> {
  let out = "";
  const r = await execIpc
    .run(newId("wt"), `git ${args}`, { cwd: folder, timeoutMs: 30_000 }, (c) => {
      out += c;
    })
    .catch(() => null);
  return r && r.exitCode === 0 ? out : null;
}

export function registerChatWorktrees(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  registry: WorktreeRegistry,
): void {
  const { dispatcher, quickInput, notifications, workspace } = services;

  const save = (session: string) => void sessions.find(session)?.save();

  envOf = (agent: string): Record<string, string> => {
    const record = registry.find(agent);
    if (!record) return {};
    return worktreeEnv(
      record.index,
      portSettings(
        services.settings.peek<unknown>("agent.worktree.basePort"),
        services.settings.peek<unknown>("agent.worktree.portStep"),
      ),
    );
  };

  const enter = async (session: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
    const here = worktrees.peek().get(session);
    if (here)
      return {
        result: `Error: this chat already works in the worktree ${here.folder} (${here.branch}). Call exit_worktree first.`,
        isError: true,
      };
    if (helperRootOf(session))
      return {
        result: "Error: you already work in a worktree of your own (a helper's).",
        isError: true,
      };
    const root = workspace.root.peek();
    if (!root || services.context.get("gitRepo") !== true)
      return {
        result: "Error: the open folder isn't a git repository, so there's no worktree to make.",
        isError: true,
      };
    const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : null;
    // The record goes by the chat's id; a chat that kept an earlier worktree gives the next one
    // an id of its own, so the kept one can still be reviewed and merged.
    const recordId = registry.find(session) ? newId("s") : session;
    let w: ChatWorktree;
    let setupNote = "";
    if (path) {
      // An existing worktree of this repository (not the open folder itself).
      const list = await gitIpc.worktrees().catch(() => []);
      const found = list.find((x) => samePath(x.path, path));
      if (!found || samePath(found.path, root))
        return {
          result: `Error: ${path} isn't a linked worktree of this repository.${
            list.length > 1
              ? ` Its worktrees: ${list
                  .filter((x) => !samePath(x.path, root))
                  .map((x) => x.path)
                  .join(", ")}.`
              : ""
          }`,
          isError: true,
        };
      try {
        await fsIpc.allowRoot(found.path);
      } catch (err) {
        return {
          result: `Error: ${found.path} can't be entered: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      // Its record, for review and merge: one the worktree agents have already, else a new one
      // (compared against where it is now: the changes this chat makes).
      const known = registry.agents.peek().find((a) => samePath(a.folder, found.path));
      const branch = found.branch?.replace(/^refs\/heads\//, "") || found.head.slice(0, 12);
      if (!known) {
        const index = Math.max(0, ...registry.agents.peek().map((a) => a.index)) + 1;
        const env = worktreeEnv(
          index,
          portSettings(
            services.settings.peek<unknown>("agent.worktree.basePort"),
            services.settings.peek<unknown>("agent.worktree.portStep"),
          ),
        );
        registry.add({
          chat: recordId,
          branch,
          folder: found.path,
          base: found.head || "HEAD",
          task: sessions.find(session)?.title.peek() ?? "A chat's worktree",
          startedAt: Date.now(),
          index,
          port: Number(env.PORT),
          headless: true,
        });
      }
      w = {
        folder: found.path,
        branch,
        agent: known?.chat ?? recordId,
        from: root,
        created: false,
      };
    } else {
      const named = chatWorktreeBranch(args.name, session);
      if ("error" in named) return { result: `Error: ${named.error}`, isError: true };
      const starter = registry.starter;
      if (!starter)
        return { result: "Error: worktrees aren't available in this window.", isError: true };
      let started: Awaited<ReturnType<typeof starter>>;
      try {
        started = await starter({
          task: sessions.find(session)?.title.peek() ?? "A chat's worktree",
          branch: named.branch,
          setup: true,
          headless: true,
          chat: recordId,
        });
      } catch (err) {
        return {
          result: `Error: the worktree couldn't be created: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      if (!started) return { result: "Error: the worktree wasn't created.", isError: true };
      try {
        await fsIpc.allowRoot(started.folder);
      } catch (err) {
        return {
          result: `Error: the worktree ${started.folder} was made but can't be entered: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
      if (started.setup?.state === "failed")
        setupNote = ` Its setup step failed (exit ${started.setup.exitCode ?? "?"}): check before relying on it.`;
      else if (started.setup?.copied.length)
        setupNote = ` Copied into it: ${started.setup.copied.join(", ")}.`;
      w = {
        folder: started.folder,
        branch: started.branch,
        agent: started.chat,
        from: root,
        created: true,
      };
    }
    setWorktree(session, w);
    save(session);
    return { result: enteredText(w, setupNote), summary: w.branch };
  };

  /**
   * Leaves the chat's worktree. `confirm`: asked before a removal that would lose uncommitted
   * changes or commits (false: kept).
   */
  const leave = async (
    session: string,
    action: "keep" | "remove",
    confirm: (loss: string, w: ChatWorktree) => Promise<boolean>,
  ): Promise<ToolOutcome> => {
    const w = worktrees.peek().get(session);
    if (!w)
      return {
        result: "Error: this chat isn't in a worktree it entered with enter_worktree.",
        isError: true,
      };
    if (action === "remove") {
      if (!w.created)
        return {
          result: `Error: ${w.folder} wasn't made by enter_worktree, so it isn't removed from here. Leave it with action keep.`,
          isError: true,
        };
      await fsIpc.allowRoot(w.folder).catch(() => {});
      const status = await gitIn(w.folder, "status --porcelain");
      const base = registry.find(w.agent)?.base;
      const ahead =
        base && base !== "HEAD" ? await gitIn(w.folder, `rev-list --count ${base}..HEAD`) : "0";
      // Can't tell (git failed): asked as if it had changes.
      const loss =
        status === null || ahead === null
          ? "Its changes couldn't be checked: removing it may delete work."
          : removalLoss({ changed: changedFiles(status), commits: Number(ahead.trim()) || 0 });
      if (loss && !(await confirm(loss, w)))
        return {
          result: `The user kept the worktree ${w.folder} (${loss}) You're still working in it.`,
          denied: true,
          summary: "kept",
        };
      // Its background commands run in the folder that goes.
      for (const p of backgroundProcesses.list(session))
        if (p.status === "running") await backgroundProcesses.kill(p.id);
      setWorktree(session, null);
      await gitIpc.worktreeOp("forceRemove", w.folder).catch(() => {});
      await gitIpc.repoOp("forceDeleteBranch", w.branch).catch(() => {});
      await fsIpc.forgetRoot(w.folder).catch(() => {});
      registry.remove(w.agent);
    } else setWorktree(session, null);
    save(session);
    return { result: leftText(w, action), summary: action === "remove" ? "removed" : "kept" };
  };

  const enterTool: AgentTool = {
    spec: {
      name: "enter_worktree",
      description:
        "Move this chat into a git worktree, only when the user asks for one: a new branch (agent/<name>) and folder next to the repository, or an existing worktree of this repository by `path`. From then on your file tools, searches and commands work there, not in the open folder. Commit there; leave with exit_worktree.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "For a new one: its name (letters, digits, . _ -; default from the chat)",
          },
          path: { type: "string", description: "Enter this existing worktree instead" },
        },
        required: [],
      },
    },
    readOnly: false,
    concurrent: false,
    verb: "Entered worktree",
    target: (a) => String(a.path ?? a.name ?? ""),
    run: (args, host) => enter(host.session, args),
  };

  const exitTool: AgentTool = {
    spec: {
      name: "exit_worktree",
      description:
        "Leave the worktree enter_worktree moved this chat into; your tools work in the open folder again. keep: the branch and folder stay for the user to review and merge. remove: deletes them (only one enter_worktree made; asks the user first when uncommitted changes or commits would be lost).",
      parameters: {
        type: "object",
        properties: { action: { type: "string", enum: ["keep", "remove"] } },
        required: ["action"],
      },
    },
    readOnly: false,
    concurrent: false,
    verb: "Left worktree",
    target: (a) => String(a.action ?? ""),
    run: (args, host: ToolHost) =>
      leave(host.session, args.action === "remove" ? "remove" : "keep", async (loss, w) => {
        const answer = await host.ask({
          title: `Remove the worktree ${w.branch}`,
          heading: "Remove a worktree",
          code: w.folder,
          kind: "tool",
          detail: loss,
          danger: true,
          evenWithFullAccess: true,
        });
        return answer !== "deny";
      }),
  };

  const previous = sessions.extraTools;
  sessions.extraTools = (session) => [...previous(session), enterTool, exitTool];

  // Deleted elsewhere (agent.worktrees → Delete, or the folder went): the chat comes back here.
  // Only a record seen before and gone now counts (the list loads after the chats may have).
  const seen = new Set<string>();
  sub.add(
    effect(() => {
      const agents = new Set(registry.agents.value.map((a) => a.chat));
      for (const [chat, w] of worktrees.peek()) {
        if (agents.has(w.agent)) seen.add(w.agent);
        else if (seen.has(w.agent)) {
          seen.delete(w.agent);
          setWorktree(chat, null);
          save(chat);
        }
      }
      return undefined;
    }),
  );
  sub.add({ dispose: () => (envOf = () => ({})) });

  sub.add(
    dispatcher.register({
      id: "agent.chatWorktree",
      title: "Chat's worktree…",
      category: "Agent",
      description:
        "A chat working in a git worktree (enter_worktree, D337): review its changes (the compare page), merge them into this folder (agent.applyWorktree, asks first), leave it (keep the branch) or leave and remove it (asks when that loses changes or commits). `session`: the chat (default the active one). A person running it picks the action.",
      input: s.object({
        session: s.string().optional(),
        action: s.enum(["review", "merge", "leave", "remove"] as const).optional(),
      }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ session, action }, ctx) => {
        const id = session ?? sessions.find(undefined)?.id;
        const w = id ? worktrees.peek().get(id) : undefined;
        if (!id || !w) throw new Error("That chat isn't working in a worktree.");
        let what = action;
        if (!what && ctx.caller.kind === "user")
          what = (
            await quickInput.pick(
              [
                { id: "review", label: "Review its changes", icon: "eye" as const },
                { id: "merge", label: "Merge into this folder", icon: "git-merge" as const },
                { id: "leave", label: "Leave the worktree (keep it)", icon: "log-out" as const },
                ...(w.created
                  ? [{ id: "remove", label: "Leave and remove it", icon: "trash-2" as const }]
                  : []),
              ],
              { placeholder: `${w.branch} · ${w.folder}` },
            )
          )?.id as typeof action;
        if (what === "review") return ctx.execute("agent.compareWorktrees", { agents: [w.agent] });
        if (what === "merge") return ctx.execute("agent.applyWorktree", { agent: w.agent });
        if (what === "leave" || what === "remove") {
          const out = await leave(id, what === "remove" ? "remove" : "keep", (loss) =>
            confirmAction("Remove the worktree?", `${w.branch}: ${loss}`, "Remove", true),
          );
          if (!out.isError && !out.denied)
            notifications.show(
              "info",
              what === "remove"
                ? `Removed ${w.branch}.`
                : `This chat works in ${w.from} again; ${w.branch} is kept.`,
            );
          return { left: !out.isError && !out.denied, result: out.result };
        }
        return { worktree: w };
      },
    }),
  );

  sub.add(
    services.state.register("ide://agent/chatWorktrees", {
      description:
        "Chats working in a git worktree (enter_worktree, D337): per chat its folder, branch, the worktree agents' record (agent.compareWorktrees / agent.applyWorktree take it), the folder it came from, and whether enter_worktree made it.",
      get: () => ({
        chats: [...worktrees.peek()].map(([session, w]) => ({ session, ...w })),
      }),
    }),
  );
}
