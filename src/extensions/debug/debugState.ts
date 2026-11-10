// `ide://debug` (D143): the focused session, every session, breakpoints of every kind,
// exception settings, watches and the debug console, as agents read them.
import type { Disposable } from "../../core/lifecycle/index";
import type { ReadonlySignal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { Breakpoint } from "./breakpoints";
import type { DebugController } from "./controller";
import { disassemblyState } from "./disassembly";
import type { InlineValuesState } from "./inlineValuesView";
import type { Watches } from "./watches";

export function registerDebugState(
  services: WorkbenchServices,
  debug: DebugController,
  watches: Watches,
  helpers: {
    rel(path: string): string;
    bpOut(b: Breakpoint): Record<string, unknown>;
    inlineValues: ReadonlySignal<InlineValuesState | null>;
  },
): Disposable {
  const { rel, bpOut, inlineValues } = helpers;
  return services.state.register("ide://debug", {
    description:
      "The debugger: the focused session's state (inactive, starting, running, stopped), configuration, why it stopped, the exception it stopped on, its call stack (path, line); every session (id, name, parent, state, threads, whether its debugger can step into a chosen call or restart frames); breakpoints (line, function, data; verified; a triggered one's `triggeredBy` id and `waiting` until that one is hit), the inline values shown while paused (`inlineValues`), exception settings, watches, and the debug console: which session's is shown (`consoleSession`), the consoles to pick from (`consoles`, debug.selectConsole) and the shown one's last lines.",
    get: () => {
      const frames = debug.frames.peek();
      const info = debug.stopInfo.peek();
      const focused = debug.focused.peek();
      const ex = focused?.exception.peek();
      return {
        state: debug.state.peek(),
        configuration: debug.config.peek()?.name ?? null,
        session: focused?.id ?? null,
        sessions: debug.sessions.peek().map((rs) => ({
          id: rs.id,
          name: rs.name,
          type: rs.config.type,
          kind: rs.kind,
          state: rs.state.peek(),
          ...(rs.parentId ? { parent: rs.parentId } : {}),
          ...(rs.compound
            ? {
                compound: rs.compound,
                stopAll: debug.compoundInfo(rs.compound)?.stopAll ?? false,
              }
            : {}),
          ...(rs.pid !== undefined ? { pid: rs.pid } : {}),
          ...(rs.capabilities.peek().stepInTargets ? { canStepIntoTargets: true } : {}),
          ...(rs.capabilities.peek().restartFrame ? { canRestartFrame: true } : {}),
          threads: rs.threads.peek().map((t) => ({
            id: t.id,
            name: t.name,
            stopped: t.stopped,
            ...(t.reason ? { reason: t.reason } : {}),
          })),
        })),
        ...(ex
          ? {
              exception: {
                id: ex.exceptionId,
                breakMode: ex.breakMode,
                ...(ex.description ? { description: ex.description } : {}),
              },
            }
          : {}),
        ...(info
          ? { stopped: { reason: info.reason, ...(info.text ? { text: info.text } : {}) } }
          : {}),
        frames: frames.map((f) => ({
          name: f.name,
          path: f.path ? rel(f.path) : null,
          line: f.line,
          ...(f.canRestart === false ? { canRestart: false } : {}),
        })),
        frameIndex: debug.frameIndex.peek(),
        breakpoints: debug.breakpoints.list.peek().map(bpOut),
        // `name = value` after lines of the stopped file (debug.inlineValues).
        inlineValues: (() => {
          const shown = inlineValues.peek();
          return shown ? { path: rel(shown.path), lines: shown.lines.slice(0, 200) } : null;
        })(),
        functionBreakpoints: debug.other.functions.peek().map((f) => ({
          name: f.name,
          enabled: f.enabled,
          ...(f.condition ? { condition: f.condition } : {}),
          ...(f.hitCondition ? { hitCondition: f.hitCondition } : {}),
          ...(f.verified !== undefined ? { verified: f.verified } : {}),
        })),
        instructionBreakpoints: debug.other.instructions.peek().map((b) => ({
          address: b.address,
          enabled: b.enabled,
          ...(b.verified !== undefined ? { verified: b.verified } : {}),
        })),
        // The disassembly view, while it's open (D229).
        disassembly: disassemblyState.peek(),
        dataBreakpoints: debug.other.data.peek().map((d) => ({
          id: d.id,
          description: d.description,
          accessType: d.accessType,
          enabled: d.enabled,
          session: d.sessionId,
          ...(d.verified !== undefined ? { verified: d.verified } : {}),
        })),
        exceptionFilters: (focused?.capabilities.peek().exceptionFilters.length
          ? focused.capabilities.peek().exceptionFilters
          : debug.other.filters.peek()
        ).map((f) => ({
          filter: f.filter,
          label: f.label,
          enabled: debug.other.filterOn(f.filter),
          ...(debug.other.filterChoices.peek()[f.filter]?.condition
            ? { condition: debug.other.filterChoices.peek()[f.filter]?.condition }
            : {}),
        })),
        watches: watches.expressions.peek().map((expression) => {
          const v = watches.values.peek().get(expression);
          return {
            expression,
            ...(v ? { value: v.value } : {}),
            ...(v?.error ? { error: true } : {}),
          };
        }),
        uncaughtExceptions: debug.breakpoints.uncaught.peek(),
        caughtExceptions: debug.breakpoints.caught.peek(),
        // The console shown (one session's, D209) and the ones to pick from.
        consoleSession: debug.consoles.selected.peek(),
        consoles: debug.consoleList(),
        console: debug.consoles.shown
          .peek()
          .slice(-40)
          .map((l) => `${l.kind === "input" ? "› " : ""}${l.text.replace(/\n$/, "")}`)
          .join("\n"),
      };
    },
  });
}
