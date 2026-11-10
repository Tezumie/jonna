// Breakpoint commands (D143, D145): toggle (F9), add with a condition, hit count or log message,
// edit them, enable / disable, remove; triggered breakpoints (wait for another one to be hit);
// which exceptions stop; and the editor margin's right-click menu (VS Code's "Add conditional
// breakpoint…", "Add logpoint…", "Add triggered breakpoint…", "Edit breakpoint"…).
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { showContextMenu } from "../../ui/Menu";
import type { WorkbenchServices } from "../../workbench/services";
import { type Breakpoint, parseHitCondition } from "./breakpoints";
import type { DebugController } from "./controller";
import { isWaiting, triggerCandidates } from "./triggers";

type Field = "condition" | "hitCondition" | "logMessage";

const PROMPTS: Record<Field, { prompt: (line: number) => string; placeholder: string }> = {
  condition: {
    prompt: (line) => `Stop at line ${line} only when this is true (empty: always)`,
    placeholder: "e.g. i > 10",
  },
  hitCondition: {
    prompt: (line) => `Stop at line ${line} from which hit? (5, >5, ==5, %3 for every third)`,
    placeholder: "e.g. 5",
  },
  logMessage: {
    prompt: (line) => `Log at line ${line} instead of stopping ({expression} is filled in)`,
    placeholder: "e.g. total is {total}",
  },
};

export function registerBreakpointCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  debug: DebugController,
  helpers: {
    abs(path: string): string;
    rel(path: string): string;
    activeEditor(): Promise<{ path: string; line: number } | null>;
  },
): { out(b: Breakpoint): Record<string, unknown> } {
  const { dispatcher, quickInput } = services;
  const { abs, rel, activeEditor } = helpers;
  const store = debug.breakpoints;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Debug", ...c }));

  const out = (b: Breakpoint) => ({
    id: b.id,
    path: rel(b.path),
    line: b.line,
    enabled: b.enabled,
    ...(b.condition ? { condition: b.condition } : {}),
    ...(b.hitCondition ? { hitCondition: b.hitCondition } : {}),
    ...(b.logMessage ? { logMessage: b.logMessage } : {}),
    ...(b.triggeredBy !== undefined ? { triggeredBy: b.triggeredBy } : {}),
    ...(b.triggeredIn?.length ? { triggeredIn: b.triggeredIn } : {}),
    ...(isWaiting(b) ? { waiting: true } : {}),
    ...(b.verified !== undefined ? { verified: b.verified } : {}),
  });
  const target = async (path?: string, line?: number) => {
    const active = path && line ? null : await activeEditor();
    const p = path ? abs(path) : active?.path;
    const l = line ?? active?.line;
    if (!p || !l) throw new Error("No file: open one or pass `path` and `line`.");
    return { path: p, line: l };
  };
  const validHit = (h: string | undefined) => {
    if (h?.trim() && !parseHitCondition(h))
      throw new Error(`"${h}" isn't a hit count: use 5, >5, >=5, ==5 or %3.`);
  };
  const fieldSchema = {
    condition: s.string().describe("Stop only when this expression is true").optional(),
    hitCondition: s
      .string()
      .describe("Stop from the Nth hit: '5' (= '>=5'), '>5', '==5', '%3' (every third)")
      .optional(),
    logMessage: s
      .string()
      .describe("A logpoint: print this instead of stopping; {expression} is filled in")
      .optional(),
    triggeredBy: s
      .integer()
      .describe(
        "A triggered breakpoint: the id of the breakpoint it waits for (ide://debug). It's set in a session only once that one was hit there; reset when the session ends",
      )
      .optional(),
  };
  const validTrigger = (id: number | undefined, self?: number) => {
    if (id === undefined) return;
    if (id === self || !store.get(id))
      throw new Error(`No breakpoint ${id} to wait for: ide://debug lists the breakpoints' ids.`);
    if (self !== undefined && !triggerCandidates(store.list.peek(), self).some((b) => b.id === id))
      throw new Error(`Breakpoint ${id} waits for this one: they'd wait for each other forever.`);
  };
  /**
   * Asks which breakpoint line `line`'s breakpoint (`id`, null when not added yet) waits for:
   * an id, null for none (it stops like any other), undefined when cancelled.
   */
  const pickTrigger = async (id: number | null, line: number) => {
    const candidates = triggerCandidates(store.list.peek(), id);
    const current = id === null ? undefined : store.get(id)?.triggeredBy;
    if (!candidates.length)
      throw new Error("There's no other breakpoint to wait for: add the one to wait for first.");
    const items = [
      ...(current !== undefined
        ? [{ id: "none", label: "None", description: "Stop like any other breakpoint" }]
        : []),
      ...candidates.map((b) => ({
        id: String(b.id),
        label: `${basename(b.path)}:${b.line}`,
        description: [
          rel(b.path),
          b.condition ? `when ${b.condition}` : "",
          b.id === current ? "current" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    ];
    const picked = await quickInput.pick(items, {
      placeholder: `Line ${line} waits for this breakpoint to be hit`,
    });
    if (!picked) return undefined;
    return picked.id === "none" ? null : Number(picked.id);
  };

  register({
    id: "debug.toggleBreakpoint",
    title: "Toggle breakpoint",
    description:
      "Adds a breakpoint on a line, or removes the one there (default: the active editor's cursor line).",
    input: s.object({
      path: s.string().describe("File (relative to the workspace or absolute)").optional(),
      line: s.integer({ min: 1 }).describe("1-based line").optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ path, line }) => {
      const t = await target(path, line);
      const added = store.toggle(t.path, t.line);
      return { added: added !== null, line: t.line };
    },
  });
  register({
    id: "debug.setBreakpoint",
    title: "Add breakpoint",
    description:
      "Adds (or replaces) a breakpoint: plain, conditional (`condition`), counted (`hitCondition`), a logpoint (`logMessage`, prints instead of stopping) or triggered (`triggeredBy`: waits for another breakpoint to be hit first).",
    input: s.object({
      path: s.string().describe("File (relative to the workspace or absolute)"),
      line: s.integer({ min: 1 }).describe("1-based line"),
      ...fieldSchema,
    }),
    effects: ["write"],
    agent: "discoverable",
    run: ({ path, line, condition, hitCondition, logMessage, triggeredBy }) => {
      validHit(hitCondition);
      validTrigger(triggeredBy, store.at(abs(path), line)?.id);
      return out(
        store.add(abs(path), line, {
          ...(condition ? { condition } : {}),
          ...(hitCondition ? { hitCondition } : {}),
          ...(logMessage ? { logMessage } : {}),
          ...(triggeredBy !== undefined ? { triggeredBy } : {}),
        }),
      );
    },
  });
  register({
    id: "debug.editBreakpoint",
    title: "Edit breakpoint…",
    description:
      "Asks for a breakpoint's condition, hit count, log message or the breakpoint it waits for (`triggeredBy`, VS Code's 'Wait for breakpoint'), on the cursor's line when no id; one is added if needed.",
    input: s.object({
      id: s.integer().optional(),
      path: s.string().optional(),
      line: s.integer({ min: 1 }).optional(),
      what: s.enum(["condition", "hitCondition", "logMessage", "triggeredBy"] as const).optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ id, path, line, what }) => {
      let bp = id === undefined ? undefined : store.get(id);
      if (!bp) {
        const t = await target(path, line);
        bp = store.at(t.path, t.line) ?? store.add(t.path, t.line);
      }
      if (what === "triggeredBy") {
        const trigger = await pickTrigger(bp.id, bp.line);
        if (trigger === undefined) return { changed: false };
        store.update(bp.id, { triggeredBy: trigger ?? undefined, enabled: true });
        return { changed: true };
      }
      const field: Field = what ?? "condition";
      const value = await quickInput.prompt({
        prompt: PROMPTS[field].prompt(bp.line),
        value: bp[field] ?? "",
        placeholder: PROMPTS[field].placeholder,
        ...(field === "hitCondition"
          ? {
              validate: (v: string) =>
                v.trim() && !parseHitCondition(v) ? "Use 5, >5, >=5, ==5 or %3" : undefined,
            }
          : {}),
      });
      if (value === undefined) return { changed: false };
      store.update(bp.id, { [field]: value.trim() || undefined, enabled: true });
      return { changed: true };
    },
  });
  // The command's former name (D143).
  register({
    id: "debug.editBreakpointCondition",
    title: "Edit breakpoint condition…",
    description: "Asks for the condition of a breakpoint (empty: always stop).",
    input: s.object({ id: s.integer().optional() }),
    effects: ["write"],
    agent: "hidden",
    run: ({ id }, ctx) => ctx.execute("debug.editBreakpoint", { id, what: "condition" }),
  });
  for (const [id, title, what] of [
    ["debug.addConditionalBreakpoint", "Add conditional breakpoint…", "condition"],
    ["debug.addLogpoint", "Add logpoint…", "logMessage"],
  ] as const)
    register({
      id,
      title,
      description: `${title.replace("…", "")} on the cursor's line (asks for it).`,
      input: s.object({ path: s.string().optional(), line: s.integer({ min: 1 }).optional() }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ path, line }, ctx) => {
        const t = await target(path, line);
        const existed = store.at(t.path, t.line) !== undefined;
        const r = (await ctx.execute("debug.editBreakpoint", { ...t, what })) as {
          changed: boolean;
        };
        // Cancelled: no breakpoint left behind that the user didn't ask for.
        const bp = store.at(t.path, t.line);
        if (!r.changed && !existed && bp) store.remove(bp.id);
        return r;
      },
    });
  register({
    id: "debug.addTriggeredBreakpoint",
    title: "Add triggered breakpoint…",
    description:
      "Adds a breakpoint that waits for another one: it's set in a debug session only once `triggeredBy` (a breakpoint id from ide://debug; asked when left out) was hit there, and waits again when the session ends (VS Code's triggered breakpoints). On the cursor's line unless `path` and `line` say.",
    input: s.object({
      path: s.string().describe("File (relative to the workspace or absolute)").optional(),
      line: s.integer({ min: 1 }).describe("1-based line").optional(),
      triggeredBy: s.integer().describe("Id of the breakpoint to wait for").optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ path, line, triggeredBy }) => {
      const t = await target(path, line);
      const existing = store.at(t.path, t.line);
      validTrigger(triggeredBy, existing?.id);
      const trigger = triggeredBy ?? (await pickTrigger(existing?.id ?? null, t.line));
      if (trigger === undefined) return { added: false };
      if (existing) {
        store.update(existing.id, { triggeredBy: trigger ?? undefined, enabled: true });
        return { added: false, breakpoint: out(store.get(existing.id) ?? existing) };
      }
      const bp = store.add(t.path, t.line, trigger === null ? {} : { triggeredBy: trigger });
      return { added: true, breakpoint: out(bp) };
    },
  });
  register({
    id: "debug.removeBreakpoint",
    title: "Remove breakpoint",
    description: "Removes a breakpoint by id (ide://debug lists them).",
    input: s.object({ id: s.integer() }),
    effects: ["write"],
    agent: "discoverable",
    run: ({ id }) => {
      store.remove(id);
      return { removed: id };
    },
  });
  register({
    id: "debug.removeAllBreakpoints",
    title: "Remove all breakpoints",
    description: "Removes every breakpoint (or those of one file).",
    input: s.object({ path: s.string().optional() }),
    effects: ["write"],
    agent: "discoverable",
    run: ({ path }) => {
      store.removeAll(path ? abs(path) : undefined);
      return { breakpoints: store.list.peek().length };
    },
  });
  register({
    id: "debug.setBreakpointEnabled",
    title: "Enable or disable a breakpoint",
    description:
      "Enables or disables a breakpoint by id (a disabled one is kept but doesn't stop).",
    input: s.object({ id: s.integer(), enabled: s.boolean() }),
    effects: ["write"],
    agent: "hidden",
    run: ({ id, enabled }) => {
      store.update(id, { enabled });
      return { id, enabled };
    },
  });
  register({
    id: "debug.toggleAllBreakpoints",
    title: "Enable or disable all breakpoints",
    description: "Disables every breakpoint when any is enabled, else enables them all.",
    input: s.empty(),
    effects: ["write"],
    run: () => {
      const any = store.list.peek().some((b) => b.enabled);
      store.setAllEnabled(!any);
      return { enabled: !any };
    },
  });
  for (const [id, title, key, description] of [
    [
      "debug.toggleUncaughtExceptions",
      "Toggle pausing on uncaught exceptions",
      "uncaught",
      "Stops (or no longer stops) where an exception nothing catches is thrown.",
    ],
    [
      "debug.toggleCaughtExceptions",
      "Toggle pausing on caught exceptions",
      "caught",
      "Stops (or no longer stops) wherever an exception is thrown, even one that is caught.",
    ],
  ] as const)
    register({
      id,
      title,
      description,
      input: s.object({ on: s.boolean().optional() }),
      effects: ["write"],
      agent: "discoverable",
      run: ({ on }) => {
        store[key].value = on ?? !store[key].peek();
        return { [key]: store[key].peek() };
      },
    });

  // Right-click in the breakpoint margin.
  const run = (command: string, input: unknown) =>
    void dispatcher.execute(command, input).catch((err: unknown) => {
      services.notifications.show("error", err instanceof Error ? err.message : String(err));
    });
  sub.add(
    services.debugMarks.onGutterContextMenu(({ path, line, x, y }) => {
      const bp = store.at(path, line);
      const at = { path, line };
      const items = bp
        ? [
            {
              label: "Remove breakpoint",
              icon: "trash-2" as const,
              run: () => run("debug.removeBreakpoint", { id: bp.id }),
            },
            {
              label: "Edit condition…",
              icon: "pencil" as const,
              run: () => run("debug.editBreakpoint", { id: bp.id, what: "condition" }),
            },
            {
              label: "Edit hit count…",
              icon: "pencil" as const,
              run: () => run("debug.editBreakpoint", { id: bp.id, what: "hitCondition" }),
            },
            {
              label: "Edit log message…",
              icon: "pencil" as const,
              run: () => run("debug.editBreakpoint", { id: bp.id, what: "logMessage" }),
            },
            {
              label: "Wait for breakpoint…",
              icon: "pencil" as const,
              run: () => run("debug.editBreakpoint", { id: bp.id, what: "triggeredBy" }),
            },
            {
              label: bp.enabled ? "Disable breakpoint" : "Enable breakpoint",
              icon: bp.enabled ? ("circle-minus" as const) : ("circle-dot" as const),
              separatorBefore: true,
              run: () => run("debug.setBreakpointEnabled", { id: bp.id, enabled: !bp.enabled }),
            },
          ]
        : [
            {
              label: "Add breakpoint",
              icon: "circle-dot" as const,
              run: () => run("debug.setBreakpoint", at),
            },
            {
              label: "Add conditional breakpoint…",
              icon: "circle-dot" as const,
              run: () => run("debug.addConditionalBreakpoint", at),
            },
            {
              label: "Add logpoint…",
              icon: "circle-dot" as const,
              run: () => run("debug.addLogpoint", at),
            },
            {
              label: "Add triggered breakpoint…",
              icon: "circle-dot" as const,
              run: () => run("debug.addTriggeredBreakpoint", at),
            },
            ...(debug.state.peek() === "stopped"
              ? [
                  {
                    label: "Run to line",
                    icon: "play" as const,
                    separatorBefore: true,
                    run: () => run("debug.runToCursor", at),
                  },
                ]
              : []),
          ];
      sub.add(showContextMenu(x, y, items));
    }),
  );
  return { out };
}
