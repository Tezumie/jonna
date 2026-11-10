// Inspecting a paused program (D143): run to cursor, setting a variable, watch expressions,
// selecting a stack frame, stepping into a chosen call, restarting a frame, reading variables
// and evaluating in the debug console.
import type { DisposableStore } from "../../core/lifecycle/index";
import { pathKey } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { DebugConfigurations } from "./configurations";
import type { DebugController } from "./controller";
import { stepTargetAt } from "./stepTargets";
import type { Watches } from "./watches";

export function registerInspectCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  debug: DebugController,
  watches: Watches,
  configs: DebugConfigurations,
): void {
  const { dispatcher } = services;
  const { abs, activeEditor } = configs;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Debug", ...c }));
  const sessionInput = s
    .string()
    .describe("A session's id or name (ide://debug sessions); default: the focused session")
    .optional();
  /** The active editor's file and cursor (1-based). */
  const editorCursor = async (): Promise<{ path: string; line: number; column: number } | null> => {
    const snap = await services.state.get("ide://editors/active").catch(() => null);
    const v = snap?.value as {
      absolutePath?: string | null;
      cursor?: { line: number; column?: number };
    } | null;
    return v?.absolutePath && v.cursor
      ? { path: v.absolutePath, line: v.cursor.line, column: v.cursor.column ?? 1 }
      : null;
  };

  // Run to cursor, changing values, watches.
  register({
    id: "debug.runToCursor",
    title: "Run to cursor",
    description:
      "While paused: runs until a line (default: the active editor's cursor line) and stops there.",
    input: s.object({
      path: s.string().optional(),
      line: s.integer({ min: 1 }).optional(),
    }),
    effects: ["exec"],
    when: "debugState == 'stopped'",
    agent: "discoverable",
    run: async ({ path, line }) => {
      const active = path && line ? null : await activeEditor();
      const p = path ? abs(path) : active?.path;
      const l = line ?? active?.line;
      if (!p || !l) throw new Error("No file: open one or pass `path` and `line`.");
      await debug.runTo(p, l);
      return { state: debug.state.peek() };
    },
  });
  register({
    id: "debug.setVariable",
    title: "Set variable value…",
    description:
      "While paused: sets a variable to an expression's value. `container` is the ref of its scope or object (from debug.variables); without `value`, asks.",
    input: s.object({
      container: s
        .integer({ min: 1 })
        .describe("Its scope's or object's ref; default: the paused frame's scope that has it")
        .optional(),
      name: s.string(),
      value: s.string().describe("A JavaScript / Python… expression").optional(),
      current: s.string().describe("Shown when asking").optional(),
    }),
    effects: ["exec"],
    when: "debugState == 'stopped'",
    agent: "discoverable",
    run: async ({ container, name, value, current }) => {
      const next =
        value ??
        (await services.quickInput.prompt({
          prompt: `New value of ${name}`,
          value: current ?? "",
        }));
      if (next === undefined || !next.trim()) return { changed: false };
      let target = container;
      if (target === undefined) {
        const session = debug.active;
        for (const scope of debug.scopes.peek()) {
          if (scope.expensive || !session) continue;
          const vars = await session.variables(scope.ref).catch(() => []);
          if (vars.some((v) => v.name === name)) {
            target = scope.ref;
            break;
          }
        }
        if (target === undefined) throw new Error(`No variable "${name}" in the paused frame.`);
      }
      const r = await debug.setVariable(target, name, next);
      return { changed: true, value: r.value };
    },
  });
  register({
    id: "debug.addWatch",
    title: "Add watch expression…",
    description:
      "Adds an expression to Watch: evaluated in the selected frame each time the program stops (kept per folder).",
    input: s.object({ expression: s.string().optional() }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ expression }) => {
      const e =
        expression ??
        (await services.quickInput.prompt({
          prompt: "Expression to watch",
          placeholder: "e.g. user.name",
        }));
      if (e?.trim()) watches.add(e);
      return { watches: watches.expressions.peek() };
    },
  });
  register({
    id: "debug.editWatch",
    title: "Edit watch expression…",
    description: "Changes a watch expression (empty removes it).",
    input: s.object({ expression: s.string(), next: s.string().optional() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ expression, next }) => {
      const e =
        next ??
        (await services.quickInput.prompt({ prompt: "Expression to watch", value: expression }));
      if (e !== undefined) watches.replace(expression, e);
      return { watches: watches.expressions.peek() };
    },
  });
  register({
    id: "debug.removeWatch",
    title: "Remove watch expression",
    description: "Removes an expression from Watch.",
    input: s.object({ expression: s.string() }),
    effects: ["write"],
    agent: "discoverable",
    run: ({ expression }) => {
      watches.remove(expression);
      return { watches: watches.expressions.peek() };
    },
  });
  register({
    id: "debug.removeAllWatches",
    title: "Remove all watch expressions",
    description: "Empties Watch.",
    input: s.empty(),
    effects: ["write"],
    run: () => {
      watches.clear();
      return { watches: [] };
    },
  });

  // Inspecting.
  register({
    id: "debug.selectFrame",
    title: "Select stack frame",
    description:
      "Shows a frame of the call stack (0 = where it stopped): its line, its variables. `session` and `threadId` pick another session's or thread's stack first.",
    input: s.object({
      index: s.integer({ min: 0 }),
      session: sessionInput,
      threadId: s.integer().optional(),
    }),
    effects: [],
    when: "inDebugMode",
    agent: "discoverable",
    run: async ({ index, session, threadId }) => {
      const rs = debug.sessionFor(session);
      const thread = threadId ?? rs.threadId.peek();
      if (rs.id !== debug.focusedId.peek() || (thread !== null && thread !== rs.threadId.peek()))
        await debug.selectThread(rs.id, thread ?? 1);
      await debug.selectFrame(index, true, rs);
      return { frame: rs.frames.peek()[index]?.name ?? null };
    },
  });
  register({
    id: "debug.stepIntoTarget",
    title: "Step into target",
    description:
      "While paused, where the debugger can (stepIntoTargetsSupported: debugpy, lldb-dap, GDB…): steps into one chosen call of the current line (VS Code's Step into target). `targetId` picks one (without it: the call under the editor's cursor, else asks; `list: true` only lists them).",
    input: s.object({
      targetId: s.integer().describe("A target's id from an earlier `list: true`").optional(),
      list: s.boolean().describe("Only list the targets").optional(),
      path: s.string().describe("The editor's file (the editor menu passes it)").optional(),
      session: sessionInput,
    }),
    effects: ["exec"],
    when: "debugState == 'stopped' && stepIntoTargetsSupported",
    agent: "discoverable",
    run: async ({ targetId, list, session }) => {
      const targets = await debug.stepInTargets(session);
      const listed = targets.map((t) => ({
        id: t.id,
        label: t.label,
        ...(t.line !== undefined ? { line: t.line } : {}),
      }));
      if (list) return { targets: listed };
      let target = targetId === undefined ? undefined : targets.find((t) => t.id === targetId);
      if (targetId !== undefined && !target)
        throw new Error(`No step-in target ${targetId}. Targets: ${JSON.stringify(listed)}`);
      if (!targets.length) {
        services.notifications.show("info", "Step targets aren't available here.");
        return { stepped: null, targets: [] };
      }
      // The call under the cursor, when the debugger says where its calls are (VS Code's).
      const top = debug.sessionFor(session).frames.peek()[0];
      const cursor = target ? null : await editorCursor();
      if (!target && cursor && top?.path && pathKey(cursor.path) === pathKey(top.path))
        target = stepTargetAt(targets, cursor.line, cursor.column);
      if (!target) {
        const picked = await services.quickInput.pick(
          targets.map((t) => ({
            id: String(t.id),
            label: t.label,
            ...(t.line !== undefined ? { description: `line ${t.line}` } : {}),
          })),
          { placeholder: "Step into which call?" },
        );
        target = picked ? targets.find((t) => String(t.id) === picked.id) : undefined;
        if (!target) return { stepped: null };
      }
      await debug.stepInTarget(target.id, session);
      return { stepped: target.label };
    },
  });
  register({
    id: "debug.restartFrame",
    title: "Restart frame",
    description:
      "While paused, where the debugger can (restartFrameSupported: Node, browsers, adapters with supportsRestartFrame): runs a call stack frame again from its start and stops there (VS Code's Restart frame). `index` 0 is where it stopped; default: the selected frame.",
    input: s.object({
      index: s
        .integer({ min: 0 })
        .describe("The frame (0 = top); default: the selected one")
        .optional(),
      session: sessionInput,
      threadId: s.integer().optional(),
    }),
    effects: ["exec"],
    when: "debugState == 'stopped' && restartFrameSupported",
    agent: "discoverable",
    run: async ({ index, session, threadId }) => {
      const rs = debug.sessionFor(session);
      const frame = await debug.restartFrame(index ?? rs.frameIndex.peek(), {
        ...(session !== undefined ? { session } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
      });
      return { restarted: frame.name };
    },
  });
  register({
    id: "debug.variables",
    title: "Variables",
    description:
      "The variables of the focused session's selected stack frame (its first scope, e.g. Local), or the children of a variable (`ref` from an earlier answer) or of a scope by name.",
    input: s.object({
      scope: s.string().describe("Scope name, e.g. 'Local', 'Closure', 'Globals'").optional(),
      ref: s.integer({ min: 1 }).describe("A variable's ref (children)").optional(),
    }),
    effects: ["read"],
    when: "debugState == 'stopped'",
    agent: "discoverable",
    run: async ({ scope, ref }) => {
      const session = debug.active;
      if (!session || debug.state.peek() !== "stopped")
        throw new Error("The program isn't paused.");
      const frame = debug.frames.peek()[debug.frameIndex.peek()];
      const scopes = frame ? await session.scopes(frame.id) : debug.scopes.peek();
      const target =
        ref ??
        (scope
          ? scopes.find((x) => x.name.toLowerCase() === scope.toLowerCase())?.ref
          : scopes.find((x) => !x.expensive)?.ref);
      if (!target)
        throw new Error(
          `No scope${scope ? ` "${scope}"` : ""}. Scopes: ${scopes.map((x) => x.name).join(", ")}`,
        );
      const vars = await session.variables(target);
      return { scopes: scopes.map((x) => x.name), ref: target, variables: vars.slice(0, 200) };
    },
  });
  register({
    id: "debug.evaluate",
    title: "Evaluate in debug console",
    description:
      "Evaluates an expression in a session (default: the one whose debug console is shown, else the focused one): in its selected frame while paused, else in the program. Printed in that session's debug console.",
    input: s.object({
      expression: s.string(),
      session: s.string().describe("Session id or name from ide://debug").optional(),
    }),
    effects: ["exec"],
    when: "inDebugMode",
    agent: "discoverable",
    run: async ({ expression, session }) => {
      // The console's own session (VS Code's REPL evaluates in the session it shows): the
      // focused one when the console shown is its own (a child process writes into its
      // parent's console but evaluates in itself), else the shown console's session.
      const shown = debug.consoles.selected.peek();
      const focused = debug.focused.peek();
      const own =
        focused && (shown === null || debug.consoleKey(focused) === shown)
          ? focused.id
          : shown && debug.session(shown)
            ? shown
            : undefined;
      const rs = debug.sessionFor(session ?? own);
      debug.printFor(rs, { kind: "input", text: expression });
      try {
        const r = await debug.evaluate(expression, rs.id);
        debug.printFor(rs, { kind: "result", text: r.value, ...(r.ref ? { ref: r.ref } : {}) });
        return { value: r.value, ref: r.ref, session: rs.id };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debug.printFor(rs, { kind: "error", text: message });
        throw new Error(message);
      }
    },
  });
}
