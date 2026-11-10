// Agents in their own git worktrees (D193): "Start in a worktree" gives a task a branch and a
// folder of its own (`git worktree add`) and opens a window there whose agent starts on it, so
// several tasks run at once without touching each other's files. Back in the main window,
// "Agent worktrees" lists them: open one, have another model review its changes, merge it, or
// delete it. Reviews (`agent.reviewChanges`) also work on uncommitted changes, the staged ones,
// a branch, or a chat's pending edits: a new chat (Ask mode, any model — a second opinion)
// reads the diff and reports problems, most severe first.

import { customModeId, findCustomMode } from "../../core/agent/chatModes";
import { helperTask } from "../../core/agent/isolatedHelpers";
import {
  bestOfBranches,
  nextIndex,
  portSettings,
  type WorktreeAgent,
  worktreeEnv,
} from "../../core/agent/worktrees";
import { diffLines, splitLines } from "../../core/diff/index";
import { agentStoreIpc, worktreeAgentIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { gitIpc, type Worktree } from "../../core/ipc/git";
import { appIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, joinPath, samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import type { AgentHandoff } from "../../workbench/persistence";
import type { WorkbenchServices } from "../../workbench/services";
import { defaultWorktreePath } from "../git/worktrees";
import { externalAgents } from "./acpAgents";
import { customModes } from "./customModes";
import { newId } from "./ids";
import { watchForStop } from "./isolatedHelpers";
import type { ProviderRegistry } from "./providers";
import type { SessionManager } from "./sessions";
import type { ChatMode } from "./sessionTypes";
import {
  registerWorktreeRegistry,
  type WorktreeRegistry,
  type WorktreeStart,
  type WorktreeStarted,
} from "./worktreeRuns";

const HANDOFF_TTL = 10 * 60 * 1000;
const DIFF_LIMIT = 120_000;
export const AGENT_BRANCH_PREFIX = "agent/";

/** "agent/fix-login-redirect" from a task. */
export function agentBranchName(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-");
  return `${AGENT_BRANCH_PREFIX}${slug || "task"}`;
}

/** A diff of one file's pending edit, in unified form (hunks without context lines). */
export function fileDiff(path: string, original: string | null, proposed: string): string {
  const a = splitLines(original ?? "");
  const b = splitLines(proposed);
  const strip = (l: string) => l.replace(/\r?\n$/, "");
  const out = [`--- ${original === null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  for (const c of diffLines(a, b)) {
    out.push(
      `@@ -${c.originalStart + 1},${c.originalEnd - c.originalStart} +${c.modifiedStart + 1},${c.modifiedEnd - c.modifiedStart} @@`,
      ...a.slice(c.originalStart, c.originalEnd).map((l) => `-${strip(l)}`),
      ...b.slice(c.modifiedStart, c.modifiedEnd).map((l) => `+${strip(l)}`),
    );
  }
  return out.join("\n");
}

/** The message a reviewing chat gets: what to look for, then the diff. */
export function reviewPrompt(what: string, diff: string, focus?: string): string {
  return [
    `Review ${what} as a careful senior engineer. Report concrete problems only — bugs, edge cases, security issues, missing error handling, missing or wrong tests, confusing code — each with the file and line, most severe first, and a suggested fix. Don't restate what the change does. If it looks good, say so in one line. Read files around the change when you need more context, but don't edit anything.`,
    // D313: the findings as a card the user can open and have fixed.
    "Verify each finding against the code before reporting it: drop what you can't back with a concrete failure. If you have the report_findings tool, call it once with the findings that survived (an empty list if none), most severe first, each with its failure scenario, and then answer in one or two lines without listing them again; otherwise list them in your answer.",
    focus ? `Pay particular attention to: ${focus}` : "",
    "```diff",
    diff.trim() || "(no changes)",
    "```",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function registerWorktreeAgents(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  providers: ProviderRegistry,
): WorktreeRegistry {
  const { dispatcher, persistence, quickInput, workspace, notifications } = services;
  const register = (c: Parameters<typeof dispatcher.register>[0]) =>
    sub.add(dispatcher.register(c));
  const currentBranch = async (): Promise<string | null> =>
    (await gitIpc.status().catch(() => null))?.branch?.head ?? null;
  const registry = registerWorktreeRegistry(sub, services);

  /**
   * One agent in a new worktree (D193): the branch and folder, the setup step (D204: untracked
   * files copied, the project's script run), then a window with its own PORT whose chat starts
   * on the task.
   */
  const startOne = async (
    ctx: { execute: (id: string, input?: unknown) => Promise<unknown> },
    opts: WorktreeStart,
  ): Promise<WorktreeStarted | null> => {
    const root = workspace.root.peek();
    if (!root) throw new Error("Open a git repository first.");
    const taken = new Set((await gitIpc.branches().catch(() => [])).map((b) => b.name));
    let name = opts.branch;
    for (let i = 2; taken.has(name) && i < 50; i++) name = `${opts.branch}-${i}`;
    const created = (await ctx.execute("git.createWorktree", {
      // The folder's own repository (D220: no "Choose a repository" picker).
      repository: ".",
      branch: name,
      ...(opts.base && { base: opts.base }),
      // Next to the repository, named after the branch (git.createWorktree's default).
      path: defaultWorktreePath(root, name),
      open: "no",
    })) as { created: string | null } | null;
    const folder = created?.created;
    if (!folder) return null;
    // The commit it starts from: what its changes are compared against.
    const head =
      (await gitIpc.worktrees().catch(() => [])).find((w) => samePath(w.path, folder))?.head ?? "";
    await registry.prune();
    const index = nextIndex(registry.agents.peek());
    const ports = portSettings(
      services.settings.peek<unknown>("agent.worktree.basePort"),
      services.settings.peek<unknown>("agent.worktree.portStep"),
    );
    const env = worktreeEnv(index, ports);
    const model = opts.model ?? sessions.find(undefined)?.model.peek() ?? undefined;
    const record: WorktreeAgent = {
      chat: opts.chat ?? newId("s"),
      branch: name,
      folder,
      base: head || "HEAD",
      task: opts.task,
      ...(model && { model }),
      startedAt: Date.now(),
      index,
      port: Number(env.PORT),
      ...(opts.group && { group: opts.group }),
      ...(opts.headless && { headless: true }),
    };
    registry.add(record);
    try {
      const setup = opts.setup ? await registry.setup(record) : undefined;
      // Stopped while it was set up: no window, no task (the caller removes the worktree).
      if (opts.cancelled?.())
        return {
          branch: name,
          folder,
          spawned: false,
          cancelled: true,
          chat: record.chat,
          port: record.port,
          setup,
        };
      if (setup?.state === "failed")
        notifications.show(
          "warning",
          `The setup script failed in ${name} (exit ${setup.exitCode ?? "?"}): the agent starts anyway.`,
          { title: "Agent worktree" },
        );
      // A headless helper: its chat starts in this window (the caller's), no handoff, no window.
      if (opts.headless)
        return {
          branch: name,
          folder,
          spawned: false,
          headless: true,
          chat: record.chat,
          port: record.port,
          setup,
        };
      const handoff: AgentHandoff = {
        id: record.chat,
        folder,
        task: opts.task,
        ...(model && { model }),
        from: root,
        branch: name,
        at: Date.now(),
        ...(opts.mode && { mode: opts.mode }),
        ...(opts.label && { label: opts.label }),
        ...(opts.instructions?.trim() && { instructions: opts.instructions }),
        ...(opts.helper && { helper: opts.helper }),
        ...(opts.tools && { tools: opts.tools }),
      };
      // From disk: another window may have changed the list since this one loaded it.
      await persistence.loadGlobal();
      const fresh = (persistence.globalState().agentHandoffs ?? []).filter(
        (h) => Date.now() - h.at < HANDOFF_TTL,
      );
      await persistence.saveGlobal({ agentHandoffs: [...fresh, handoff] });
      // Tagged with its chat: the overview can tell when the window closes (D207).
      const spawned = await appIpc.newWindow(folder, env, record.chat);
      return { branch: name, folder, spawned, chat: record.chat, port: record.port, setup };
    } catch (err) {
      // Nothing started in it yet: the worktree, branch and record made a moment ago go (D232),
      // straight through git (the Delete worktree command asks first).
      await gitIpc.worktreeOp("forceRemove", folder).catch(() => {});
      await gitIpc.repoOp("forceDeleteBranch", name).catch(() => {});
      registry.remove(record.chat);
      throw err;
    }
  };
  // Helpers in worktrees (D231) start the same way, without a command context of their own.
  registry.starter = (opts) =>
    startOne({ execute: (id, input) => dispatcher.execute(id, input) }, opts);
  registry.chatHere = (chat) => sessions.find(chat) !== undefined;

  register({
    id: "agent.startInWorktree",
    title: "New agent in a worktree…",
    category: "Agent",
    description:
      "Starts an agent on `task` in a git worktree of its own (a new branch, default agent/<task words>, from `base`, default the current commit) and a new window, so it works in parallel without touching this folder. First the setup step runs there (agent.worktree.copyFiles copied from this folder, agent.worktree.setupScript run; `setup` false skips it), and the window gets its own PORT (agent.worktree.basePort + n × portStep). `agent`: one of the user's agents (ide://agent/agents) whose chat mode it runs in (its instructions, tools and model). `model` defaults to this chat's (an agent with a model of its own uses that). Follow it with agent.worktreeAgents; compare, review, apply, merge or delete it with agent.worktrees.",
    input: s.object({
      task: s.string().describe("What the agent should do").optional(),
      branch: s.string().describe("Branch name (default agent/<task words>)").optional(),
      base: s.string().describe("Start point (default the current commit)").optional(),
      model: s.string().describe("provider/model or acp/<agent>").optional(),
      setup: s.boolean().describe("Run the setup step (default true)").optional(),
      agent: s.string().describe("One of the user's agents, by name (its chat mode)").optional(),
    }),
    effects: ["write", "exec"],
    when: "gitRepo",
    agent: "discoverable",
    run: async ({ task, branch, base, model, setup, agent }, ctx) => {
      if (!workspace.root.peek()) throw new Error("Open a git repository first.");
      const mode = agent ? findCustomMode(customModes.peek(), customModeId(agent)) : undefined;
      if (agent && !mode?.agent)
        throw new Error(`No agent named ${agent} (ide://agent/agents lists them).`);
      let text = task?.trim();
      if (!text && ctx.caller.kind === "user")
        text = (
          await quickInput.prompt({
            prompt: "What should the agent work on? It gets a branch and a window of its own.",
          })
        )?.trim();
      if (!text) return { started: null };
      const started = await startOne(ctx, {
        task: text,
        branch: branch?.trim() || agentBranchName(text),
        base,
        // The mode brings its own model (applied per turn there, like any chat with it).
        model,
        setup: setup !== false,
        ...(mode?.agent && {
          mode: customModeId(mode.name),
          label: mode.agent.label,
          instructions: mode.instructions,
        }),
      });
      if (!started) return { started: null };
      if (started.spawned)
        notifications.show("info", `Started an agent on ${started.branch} in a new window.`, {
          title: "Agent worktree",
        });
      return started;
    },
  });

  register({
    id: "agent.bestOfN",
    title: "Best of N: one task, several agents…",
    category: "Agent",
    description:
      "Gives one task to several models (or external agents) at once, each in a worktree and window of its own (setup step and PORT as agent.startInWorktree), then opens the compare page: their changes side by side, with Apply this one. `models`: 2–6 of provider/model or acp/<agent> (asked when a person runs it).",
    input: s.object({
      task: s.string().optional(),
      models: s.array(s.string(), { maxItems: 6 }).optional(),
      base: s.string().optional(),
      setup: s.boolean().optional(),
    }),
    effects: ["write", "exec"],
    when: "gitRepo",
    agent: "discoverable",
    run: async ({ task, models, base, setup }, ctx) => {
      if (!workspace.root.peek()) throw new Error("Open a git repository first.");
      let text = task?.trim();
      if (!text && ctx.caller.kind === "user")
        text = (
          await quickInput.prompt({
            prompt: "What should the agents work on? Each model gets a worktree and a window.",
          })
        )?.trim();
      if (!text) return { started: [] };
      let chosen: string[] = [...new Set<string>(models ?? [])];
      while (chosen.length < 2 && ctx.caller.kind === "user") {
        const picked = await quickInput.pick(
          [
            ...providers.models
              .peek()
              .filter((m) => !chosen.includes(m.key))
              .map((m) => ({ id: m.key, label: m.model, description: m.provider.name })),
            ...externalAgents(services)
              .filter((a) => !chosen.includes(`acp/${a.name}`))
              .map((a) => ({ id: `acp/${a.name}`, label: a.name, description: "external agent" })),
          ],
          {
            placeholder: `Model ${chosen.length + 1} of at least 2${chosen.length ? ` (chosen: ${chosen.join(", ")})` : ""}`,
          },
        );
        if (!picked) return { started: [] };
        chosen.push(picked.id);
      }
      if (chosen.length < 2) throw new Error("Best of N needs at least two models.");
      chosen = chosen.slice(0, 6);
      const group = newId("g");
      const taken = new Set((await gitIpc.branches().catch(() => [])).map((b) => b.name));
      const branches = bestOfBranches(agentBranchName(text), chosen, taken);
      const started = [];
      for (const [i, model] of chosen.entries()) {
        const one = await startOne(ctx, {
          task: text,
          branch: branches[i] ?? `${agentBranchName(text)}-${i + 1}`,
          base,
          model,
          group,
          setup: setup !== false,
        });
        if (one) started.push(one);
      }
      await ctx.execute("agent.compareWorktrees", { group }).catch(() => {});
      return { group, started };
    },
  });

  register({
    id: "agent.applyWorktree",
    title: "Apply a worktree agent's changes",
    category: "Agent",
    description:
      "Brings a worktree agent's changes (against the commit it started from, committed or not, new files included) into this folder with git apply --3way: they arrive staged, conflicts marked. `agent`: its branch or chat id. Asks first when a person runs it.",
    input: s.object({ agent: s.string() }),
    effects: ["write"],
    when: "gitRepo",
    agent: "discoverable",
    run: async ({ agent }, ctx) => {
      const found = registry.find(agent);
      if (!found) throw new Error(`No worktree agent ${agent} (ide://agent/worktrees lists them).`);
      if (
        ctx.caller.kind === "user" &&
        !(await confirmAction(
          `Apply ${found.branch}?`,
          "Its changes are applied to this folder (staged, conflicts marked).",
          "Apply",
        ))
      )
        return { applied: [] };
      const { files, conflicts } = await worktreeAgentIpc.apply(found.folder, found.base);
      registry.update(found.chat, { applied: Date.now(), conflicts });
      if (conflicts.length)
        // Conflicts go to the 3-way merge editor (D207), not only git's markers.
        notifications.show(
          "warning",
          `Applied ${files.length} file${files.length === 1 ? "" : "s"} from ${found.branch}; ${conflicts.length} ${conflicts.length === 1 ? "has a conflict" : "have conflicts"}: ${conflicts.slice(0, 3).join(", ")}${conflicts.length > 3 ? "…" : ""}.`,
          {
            title: "Agent worktree",
            actions: [
              {
                label: conflicts.length === 1 ? "Resolve in merge editor" : "Resolve conflicts…",
                run: () =>
                  void dispatcher
                    .execute("agent.resolveWorktreeConflicts", { agent: found.chat })
                    .catch(() => {}),
              },
            ],
          },
        );
      else
        notifications.show(
          "info",
          files.length
            ? `Applied ${files.length} file${files.length === 1 ? "" : "s"} from ${found.branch}.`
            : `${found.branch} has no changes to apply.`,
        );
      return { applied: files, conflicts, branch: found.branch };
    },
  });

  register({
    id: "agent.resolveWorktreeConflicts",
    title: "Resolve a worktree agent's conflicts",
    category: "Agent",
    description:
      "After agent.applyWorktree left conflicts: opens a conflicted file in the 3-way merge editor (git.openMergeEditor: the agent's version as Incoming, this folder's as Current). `file` picks one; without it a person picks from the list (one file opens directly). Files already resolved drop out of the list.",
    input: s.object({
      agent: s.string().describe("Its branch or chat id"),
      file: s.string().describe("A conflicted file (folder-relative)").optional(),
    }),
    effects: [],
    when: "gitRepo",
    agent: "discoverable",
    run: async ({ agent, file }, ctx) => {
      const found = registry.find(agent);
      if (!found) throw new Error(`No worktree agent ${agent} (ide://agent/worktrees lists them).`);
      // Still unmerged in git's eyes (a file resolved and staged since isn't offered again).
      const status = await gitIpc.status().catch(() => null);
      const unmerged = new Set((status?.files ?? []).filter((f) => f.conflict).map((f) => f.path));
      const left = (found.conflicts ?? []).filter((f) => !status || unmerged.has(f));
      if (left.length !== (found.conflicts ?? []).length)
        registry.update(found.chat, { conflicts: left });
      if (!left.length) {
        if (ctx.caller.kind === "user")
          notifications.show("info", `${found.branch}'s conflicts are resolved.`);
        return { conflicts: [] };
      }
      let target = file && left.includes(file) ? file : undefined;
      if (file && !target) throw new Error(`${file} has no conflict from ${found.branch}.`);
      if (!target && (left.length === 1 || ctx.caller.kind !== "user")) target = left[0];
      if (!target) {
        const picked = await quickInput.pick(
          left.map((f) => ({
            id: f,
            label: basename(f),
            description: f,
            icon: "git-merge" as const,
          })),
          { placeholder: `Conflicts from ${found.branch}: open one in the merge editor` },
        );
        target = picked?.id;
      }
      if (!target) return { conflicts: left };
      await ctx.execute("git.openMergeEditor", { path: target });
      return { opened: target, conflicts: left };
    },
  });

  // A window opened on a worktree with a task waiting: start its chat on it.
  const taken = new Set<string>();
  const takeHandoff = async () => {
    const root = workspace.root.peek();
    if (!root) return;
    const all = persistence.globalState().agentHandoffs ?? [];
    const mine = all.find(
      (h) => samePath(h.folder, root) && Date.now() - h.at < HANDOFF_TTL && !taken.has(h.id),
    );
    // Marked before anything waits: a second call (open + start) can't take it too.
    if (mine) taken.add(mine.id);
    const rest = all.filter((h) => h !== mine && Date.now() - h.at < HANDOFF_TTL);
    if (rest.length !== all.length) await persistence.saveGlobal({ agentHandoffs: rest });
    if (!mine) return;
    // Taken already (an older copy of the list written back by another window): skip.
    if (await agentStoreIpc.load(mine.id).catch(() => null)) return;
    const session = sessions.get(mine.id);
    if (mine.model) session.model.value = mine.model;
    // A helper never gets more tools than the chat that started it, whatever mode it's in (D232).
    if (Array.isArray(mine.tools))
      session.toolLimit = mine.tools.filter((t): t is string => typeof t === "string");
    session.title.value = mine.task.replace(/\s+/g, " ").slice(0, 60);
    // One of the user's agents (D231): its chat mode, once this window has read the agents; a
    // mode it can't find (an agent file not committed, a folder not trusted yet) is replaced by
    // its instructions in the first message.
    const mode = mine.mode ? await waitForMode(mine.mode) : false;
    if (mine.mode && mode) session.chatMode.value = mine.mode as ChatMode;
    await dispatcher.execute("agent.openSession", { session: session.id }).catch(() => {});
    const message = mine.helper
      ? helperTask({
          from: basename(mine.from),
          branch: mine.branch,
          task: mine.task,
          ...(mine.label && { label: mine.label }),
          ...(!mode && mine.instructions && { instructions: mine.instructions }),
        })
      : [
          `You're working in a git worktree of ${basename(mine.from)}: this folder, on branch ${mine.branch}. Commit your work on this branch when it's done; don't switch branches.`,
          !mode && mine.instructions
            ? `Your instructions${mine.label ? ` as ${mine.label}` : ""}:\n\n${mine.instructions}`
            : "",
          `The task:\n\n${mine.task}`,
        ]
          .filter(Boolean)
          .join("\n\n");
    await dispatcher
      .execute("agent.send", { message, session: session.id, wait: false })
      .catch((err: unknown) =>
        notifications.show("error", err instanceof Error ? err.message : String(err)),
      );
    // The chat that started a helper may ask it to stop (D231): looked for while it works.
    if (mine.helper) watchForStop(sub, services, session);
  };
  /** Whether a mode shows up among this window's chat modes within a few seconds. */
  const waitForMode = async (id: string): Promise<boolean> => {
    for (let i = 0; i < 25; i++) {
      if (findCustomMode(customModes.peek(), id)) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  };
  sub.add(workspace.onDidOpen(() => void takeHandoff()));
  if (workspace.root.peek()) void takeHandoff();

  register({
    id: "agent.worktrees",
    title: "Agent worktrees",
    category: "Agent",
    description:
      "Lists the worktrees on agent/ branches with how far each is ahead of the current branch. Pick one to open its window (a headless helper's chat, here), review its changes with another model, merge it into the current branch, or delete it (worktree and branch). `branch` + `action` (open, review, merge, delete) act directly.",
    input: s.object({
      branch: s.string().optional(),
      action: s.enum(["open", "review", "merge", "delete"] as const).optional(),
    }),
    effects: ["write"],
    when: "gitRepo",
    agent: "discoverable",
    run: async ({ branch, action }, ctx) => {
      const head = await currentBranch();
      const list = (await gitIpc.worktrees()).filter(
        (w): w is Worktree & { branch: string } =>
          !!w.branch && w.branch.startsWith(AGENT_BRANCH_PREFIX) && !w.main,
      );
      const rows = await Promise.all(
        list.map(async (w) => ({
          worktree: w,
          ahead: head
            ? (await gitIpc.logRange(`${head}..${w.branch}`, 200).catch(() => [])).length
            : 0,
        })),
      );
      let target = branch ? rows.find((r) => r.worktree.branch === branch) : undefined;
      if (!target && !branch && ctx.caller.kind === "user") {
        if (!rows.length) {
          notifications.show(
            "info",
            "No agent worktrees yet. Start one with New agent in a worktree… (Agent panel's … menu).",
          );
          return { worktrees: [] };
        }
        const picked = await quickInput.pick(
          rows.map((r) => ({
            id: r.worktree.branch,
            label: r.worktree.branch,
            description: `${r.ahead} commit${r.ahead === 1 ? "" : "s"} ahead of ${head ?? "HEAD"}`,
            detail: r.worktree.path,
            icon: "folder-git-2" as const,
          })),
          { placeholder: "Agent worktrees" },
        );
        target = rows.find((r) => r.worktree.branch === picked?.id);
      }
      if (!target)
        return {
          worktrees: rows.map((r) => ({
            branch: r.worktree.branch,
            path: r.worktree.path,
            ahead: r.ahead,
          })),
        };
      let what = action;
      if (!what && ctx.caller.kind === "user")
        what = (
          await quickInput.pick(
            [
              { id: "open", label: "Open its window", icon: "app-window" as const },
              { id: "review", label: "Review its changes (another model)", icon: "eye" as const },
              {
                id: "merge",
                label: `Merge into ${head ?? "the current branch"}`,
                icon: "git-merge" as const,
              },
              {
                id: "delete",
                label: "Delete the worktree and its branch",
                icon: "trash-2" as const,
              },
            ],
            { placeholder: target.worktree.branch },
          )
        )?.id as typeof action;
      const w = target.worktree;
      const headless = registry.find(w.branch)?.headless === true;
      // A headless helper has no window: its chat opens here (a window would be a second writer
      // of that chat).
      if (what === "open" && headless) {
        const chat = registry.find(w.branch)?.chat ?? "";
        return ctx.execute("agent.openThread", { session: chat });
      }
      if (what === "open") {
        // Its own PORT again, and tagged so the overview knows the window (D207).
        const record = registry.find(w.branch);
        const env = record
          ? worktreeEnv(
              record.index,
              portSettings(
                services.settings.peek<unknown>("agent.worktree.basePort"),
                services.settings.peek<unknown>("agent.worktree.portStep"),
              ),
            )
          : undefined;
        return { opened: await appIpc.newWindow(w.path, env, record?.chat) };
      }
      if (what === "review")
        return ctx.execute("agent.reviewChanges", {
          range: `${head ?? "HEAD"}...${w.branch}`,
          label: `the changes on ${w.branch}`,
        });
      if (what === "merge") return ctx.execute("git.merge", { branch: w.branch, repository: "." });
      if (what === "delete") {
        // A headless helper still working there stops first (its tools would lose their folder).
        const chat = registry.find(w.branch)?.chat;
        if (headless && chat) sessions.find(chat)?.stop("its worktree was deleted");
        await ctx.execute("git.deleteWorktree", { path: w.path, force: true, repository: "." });
        await ctx
          .execute("git.deleteBranch", { branch: w.branch, force: true, repository: "." })
          .catch(() => {});
        const record = registry.find(w.branch);
        if (record) registry.remove(record.chat);
        return { deleted: w.branch };
      }
      return { worktree: w.branch };
    },
  });

  register({
    id: "agent.reviewChanges",
    title: "Review changes with the agent…",
    category: "Agent",
    description:
      "A second opinion: a new chat in Ask mode (`model`: any model or external agent, default this chat's) reads a diff and reports problems, most severe first. `scope`: uncommitted (default), staged, branch (this branch against `base`, default its upstream or main) or pending (a chat's unapplied edits); or give `range` (\"main...feature\").",
    input: s.object({
      scope: s.enum(["uncommitted", "staged", "branch", "pending"] as const).optional(),
      range: s.string().describe("A git range instead of scope").optional(),
      base: s.string().describe("For scope branch: compare against this").optional(),
      session: s.string().describe("For scope pending: whose edits").optional(),
      model: s.string().describe("provider/model or acp/<agent>").optional(),
      focus: s.string().describe("What to look at especially").optional(),
      label: s.string().optional(),
    }),
    effects: ["read"],
    agent: "hidden",
    run: async ({ scope, range, base, session, model, focus, label }, ctx) => {
      let diff = "";
      let what = label ?? "";
      if (range) {
        diff = await gitIpc.diffRange(range, DIFF_LIMIT);
        what ||= `the changes in ${range}`;
      } else if ((scope ?? "uncommitted") === "pending") {
        const from = sessions.find(session);
        if (!from) throw new Error("No agent chat.");
        diff = from.changeset.files
          .peek()
          .map((f) => fileDiff(f.path, f.original, f.deleted ? "" : f.proposed))
          .join("\n")
          .slice(0, DIFF_LIMIT);
        what ||= "the agent's pending edits";
      } else if (scope === "branch") {
        const head = await currentBranch();
        // The default branch (not the upstream: a pushed branch would show nothing).
        const names = new Set((await gitIpc.branches().catch(() => [])).map((b) => b.name));
        const against =
          base ??
          ["origin/main", "origin/master", "main", "master"].find(
            (n) => names.has(n) && n !== head,
          ) ??
          "main";
        diff = await gitIpc.diffRange(`${against}...${head ?? "HEAD"}`, DIFF_LIMIT);
        what ||= `this branch (${head ?? "HEAD"}) against ${against}`;
      } else if (scope === "staged") {
        diff = await gitIpc.diff(true, DIFF_LIMIT);
        what ||= "the staged changes";
      } else {
        // Tracked changes (staged and not), then new files git doesn't track yet.
        diff = await gitIpc
          .diffRange("HEAD", DIFF_LIMIT)
          .catch(
            async () =>
              `${await gitIpc.diff(true, DIFF_LIMIT)}\n${await gitIpc.diff(false, DIFF_LIMIT)}`,
          );
        const root = workspace.root.peek();
        const untracked = ((await gitIpc.status().catch(() => null))?.files ?? [])
          .filter((f) => f.worktree === "?")
          .slice(0, 30);
        for (const f of untracked) {
          if (!root || diff.length > DIFF_LIMIT) break;
          const text = await fsIpc
            .read(joinPath(root, f.path))
            .then((b) => new TextDecoder().decode(b.slice(0, 20_000)))
            .catch(() => null);
          if (text !== null && !text.includes("\u0000"))
            diff += `\n${fileDiff(f.path, null, text)}`;
        }
        what ||= "the uncommitted changes";
      }
      if (!diff.trim()) throw new Error(`Nothing to review: ${what} are empty.`);
      // Which model gives the second opinion: asked when the user runs it.
      // The reviewer subagent's model (the Agents page), when one is set, comes first (D195).
      const reviewerModel =
        services.settings.peek<Record<string, { model?: string }>>("agent.subagents")?.reviewer
          ?.model || undefined;
      let reviewer = model ?? (ctx.caller.kind === "user" ? undefined : reviewerModel);
      if (!reviewer && ctx.caller.kind === "user") {
        const current = sessions.find(undefined)?.model.peek() ?? providers.defaultModel()?.key;
        const models = providers.models.peek();
        const picked = await quickInput.pick(
          [
            ...[
              ...models.filter((m) => m.key === reviewerModel),
              ...models.filter((m) => m.key !== reviewerModel),
            ].map((m) => ({
              id: m.key,
              label: m.model,
              description: `${m.provider.name}${m.key === reviewerModel ? " · the reviewer's" : ""}${m.key === current ? " · this chat's" : ""}`,
            })),
            ...externalAgents(services).map((a) => ({
              id: `acp/${a.name}`,
              label: a.name,
              description: `external agent${current === `acp/${a.name}` ? " · this chat's" : ""}`,
            })),
          ],
          { placeholder: "Which model reviews? (a different one gives a second opinion)" },
        );
        if (!picked) return null;
        reviewer = picked.id;
      }
      const opened = (await ctx.execute("agent.newSession")) as { session: string };
      const target = sessions.get(opened.session);
      if (reviewer) target.model.value = reviewer;
      target.chatMode.value = "ask";
      target.title.value = `Review: ${what}`.slice(0, 60);
      await ctx.execute("agent.send", {
        message: reviewPrompt(what, diff, focus),
        session: target.id,
        wait: false,
      });
      return { session: target.id, reviewing: what, model: reviewer ?? null };
    },
  });
  return registry;
}
