// Extension bisect's commands and state (bisect.ts; VS Code's Help → Start extension bisect):
// start (half of the running extensions off, then a restart), answer each round (Good now /
// This is bad / Stop; a status bar item and a notification ask after each restart), and at the
// end offer to disable the culprit. `ide://extensions/bisect` shows where it stands.
import { sessionIpc } from "../../core/ipc/diagnostics";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { type BisectAnswer, type BisectState, nextBisect, roundsLeft, startBisect } from "./bisect";
import type { ExtensionManager } from "./manager";

export function registerBisect(
  sub: DisposableStore,
  services: WorkbenchServices,
  manager: ExtensionManager,
  register: WorkbenchServices["dispatcher"]["register"],
): void {
  const { notifications, statusBar, state } = services;
  const current = signal<BisectState | null>(null);
  /** The last bisect's result this session (for the state path). */
  let lastResult: { culprit: string | null } | null = null;
  // The registry is read on every refresh: follow it (bisect survives the restarts).
  let asked = false;
  sub.add(
    effect(() => {
      manager.records.value;
      current.value = manager.bisect;
      return undefined;
    }),
  );
  const nameOf = (id: string) => manager.get(id)?.manifest?.displayName ?? id;

  /** Restarts for the next round, or (restart false: tests, quick checks) applies it live. */
  const apply = async (next: BisectState | null, restart: boolean): Promise<boolean> => {
    if (!restart) {
      await manager.setBisect(next);
      return false;
    }
    if (!(await services.workspace.confirmClose("window"))) return false;
    await manager.setBisect(next, false);
    await services.persistence.flush();
    const restarting = await sessionIpc.relaunch(null, true);
    // The restart didn't happen (a development run): the round applies live instead.
    if (!restarting) await manager.refresh();
    return restarting;
  };

  const describe = (st: BisectState) => ({
    active: true,
    round: st.round,
    roundsLeftAtMost: roundsLeft(st),
    total: st.total,
    suspects: st.candidates,
    off: st.off,
  });

  register({
    id: "extensions.startBisect",
    title: "Start extension bisect",
    category: "Help",
    description:
      "Finds the extension behind a problem (VS Code's extension bisect): turns half of the running extensions off and restarts; after each restart answer with extensions.bisectAnswer (good: the problem is gone; bad: it's still there) until one is left, then it offers to disable it. `restart: false` applies each round without restarting. Unsaved files are asked about first.",
    input: s.object({
      confirm: s.boolean().describe("Ask first, explaining what happens (default true)").optional(),
      restart: s.boolean().describe("Restart between rounds (default true)").optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ confirm, restart }) => {
      if (await sessionIpc.extensionsOff())
        throw new Error("Extensions are off for this session: restart with them on first.");
      if (manager.bisect) throw new Error("Extension bisect is already under way.");
      const running = manager.records
        .peek()
        .filter((r) => r.manifest && manager.isRunning(r.id))
        .map((r) => r.id);
      if (!running.length) throw new Error("No extension is running, so none can be the cause.");
      if (confirm !== false) {
        const answer = await showDialog<"start" | "cancel">({
          title: "Start extension bisect?",
          message: `Extension bisect finds the extension that causes a problem: it turns half of the ${running.length} running extensions off and restarts, and you say whether the problem is still there, until one is left (at most ${roundsLeft(startBisect(running))} rounds).`,
          actions: [
            { label: "Cancel", value: "cancel", variant: "secondary" },
            { label: "Start", value: "start", variant: "primary" },
          ],
          cancelValue: "cancel",
          defaultValue: "start",
        });
        if (answer !== "start") return { started: false };
      }
      const first = startBisect(running);
      asked = true;
      const restarting = await apply(first, restart !== false);
      return { started: true, restarting, ...describe(first) };
    },
  });

  const finish = async (culprit: string | null, disable: boolean | undefined) => {
    lastResult = { culprit };
    await apply(null, false);
    if (culprit === null) {
      notifications.show(
        "info",
        "Extension bisect is done: the problem happens with the extensions off, so it isn't caused by one of them.",
        { title: "Extension bisect" },
      );
      return { done: true, culprit: null };
    }
    const name = nameOf(culprit);
    const off =
      disable ??
      (await showDialog<"disable" | "keep">({
        title: "Extension bisect is done",
        message: `${name} (${culprit}) causes the problem.`,
        actions: [
          { label: "Keep it", value: "keep", variant: "secondary" },
          { label: "Disable it", value: "disable", variant: "primary" },
        ],
        cancelValue: "keep",
        defaultValue: "disable",
      })) === "disable";
    if (off) await manager.setEnabled(culprit, false);
    return { done: true, culprit, disabled: off };
  };

  register({
    id: "extensions.bisectAnswer",
    title: "Extension bisect: answer",
    category: "Help",
    description:
      "Answers this round of extension bisect: good (the problem is gone now), bad (it's still there) or stop. Without an answer, asks with a quick pick. Goes on to the next round (a restart unless `restart: false`) or, at the end, names the extension and offers to disable it (`disable` answers that).",
    input: s.object({
      answer: s.enum(["good", "bad", "stop"] as const).optional(),
      restart: s.boolean().describe("Restart for the next round (default true)").optional(),
      disable: s.boolean().describe("At the end: disable the culprit without asking").optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ answer, restart, disable }) => {
      const st = manager.bisect;
      if (!st) throw new Error("Extension bisect isn't under way (Help → Start extension bisect).");
      let chosen = answer;
      if (!chosen) {
        const picked = await services.quickInput.pick(
          [
            { id: "good", label: "Good now", detail: "The problem is gone." },
            { id: "bad", label: "This is bad", detail: "The problem is still there." },
            { id: "stop", label: "Stop bisect", detail: "Turn every extension back on." },
          ],
          { placeholder: `Extension bisect, round ${st.round}: is the problem still there?` },
        );
        if (!picked) return { answered: false };
        chosen = picked.id === "good" || picked.id === "bad" ? picked.id : "stop";
      }
      if (chosen === "stop") {
        lastResult = null;
        await apply(null, false);
        return { stopped: true };
      }
      const step = nextBisect(st, chosen as BisectAnswer);
      if (step.done) return finish(step.culprit, disable);
      const restarting = await apply(step.state, restart !== false);
      return { done: false, restarting, ...describe(step.state) };
    },
  });

  register({
    id: "extensions.stopBisect",
    title: "Stop extension bisect",
    category: "Help",
    description: "Stops extension bisect: every extension it turned off runs again.",
    input: s.empty(),
    effects: ["write"],
    agent: "hidden",
    when: "extensionBisectActive",
    run: async () => {
      if (!manager.bisect) return { stopped: false };
      await apply(null, false);
      return { stopped: true };
    },
  });

  sub.add(
    effect(() => {
      services.context.set("extensionBisectActive", current.value !== null);
      return undefined;
    }),
  );

  sub.add(
    statusBar.add({
      id: "extensions.bisect",
      name: "Extension bisect",
      alignment: "left",
      priority: 89,
      text: () => {
        const st = current.value;
        return st ? `$(search) Bisect: round ${st.round}` : "";
      },
      tooltip: () =>
        "Extension bisect: half of the suspects are off. Is the problem still there? Click to answer.",
      command: "extensions.bisectAnswer",
    }),
  );

  // After the restart into a round: ask (once per session), without blocking the window.
  sub.add(
    effect(() => {
      const st = current.value;
      if (!st || asked) return undefined;
      asked = true;
      const run = (answer: "good" | "bad" | "stop") => () =>
        void services.dispatcher.execute("extensions.bisectAnswer", { answer }).catch(() => {});
      notifications.show(
        "info",
        `Round ${st.round}: ${st.off.length} of ${st.candidates.length} suspects are off. Check whether the problem is still there, then answer here or with the status bar item.`,
        {
          title: "Extension bisect",
          actions: [
            { label: "Good now", run: run("good") },
            { label: "This is bad", run: run("bad") },
          ],
        },
      );
      return undefined;
    }),
  );

  sub.add(
    state.register("ide://extensions/bisect", {
      description:
        "Extension bisect (extensions.startBisect): whether it's under way, the round, the suspects left and the ones off this round; `last` is the result of one that ended this session.",
      get: () => {
        const st = current.value;
        return st ? describe(st) : { active: false, ...(lastResult && { last: lastResult }) };
      },
    }),
  );
}
