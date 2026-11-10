// What extensions see of the debugger (D255, VS Code's debug namespace beyond adapters): IDE events
// when a session starts, ends or becomes the focused one (with its resolved configuration and
// parent, D295), when its adapter sends an event of its own (onDidReceiveDebugSessionCustomEvent),
// when the focused thread or frame changes (activeStackItem) and when breakpoints change (the
// extensions runtime forwards them as `ide.debug.onDid…`); and the hidden commands behind
// DebugSession.customRequest, getDebugProtocolBreakpoint and debug.activeDebugConsole.
import type { DisposableStore } from "../../core/lifecycle/index";
import { pathKey } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { DebugSessionEventInfo, WorkbenchServices } from "../../workbench/services";
import type { DebugController, RunningSession } from "./controller";

/** How long customRequest waits for a session that is still starting. */
const STARTING_WAIT_MS = 15_000;

/** A session as extensions are told of it (VS Code's DebugSession's data). */
export function sessionInfo(rs: {
  id: string;
  name: string;
  parentId: string | null;
  config: { type?: unknown; raw: Record<string, unknown>; workspaceFolder?: string };
}): DebugSessionEventInfo {
  return {
    id: rs.id,
    name: rs.name,
    type: typeof rs.config.type === "string" ? rs.config.type : "",
    configuration: rs.config.raw,
    ...(rs.parentId && { parentSession: rs.parentId }),
    ...(rs.config.workspaceFolder && { workspaceFolder: rs.config.workspaceFolder }),
  };
}

/** The focused thread, or its selected frame while stopped (VS Code's debug.activeStackItem). */
export function activeStackItem(
  rs: {
    state: string;
    threadId: number | null;
    frames: readonly { id: number }[];
    frameIndex: number;
  } | null,
): { threadId: number; frameId?: number } | null {
  if (!rs || rs.threadId === null) return null;
  const frame = rs.state === "stopped" ? rs.frames[rs.frameIndex] : undefined;
  return frame ? { threadId: rs.threadId, frameId: frame.id } : { threadId: rs.threadId };
}

export function registerDebugExtensionEvents(
  sub: DisposableStore,
  services: WorkbenchServices,
  debug: DebugController,
): void {
  const { events } = services;

  let known = new Map<string, DebugSessionEventInfo>();
  sub.add(
    effect(() => {
      const now = new Map(debug.sessions.value.map((rs) => [rs.id, sessionInfo(rs)]));
      for (const [id, s] of now) if (!known.has(id)) events.emit("debug.didStartSession", s);
      for (const [id, s] of known) if (!now.has(id)) events.emit("debug.didTerminateSession", s);
      known = now;
      return undefined;
    }),
  );
  let focused: string | null = null;
  sub.add(
    effect(() => {
      const rs = debug.focused.value;
      const id = rs?.id ?? null;
      if (id !== focused) {
        focused = id;
        events.emit("debug.didChangeActiveSession", rs ? sessionInfo(rs) : null);
      }
      return undefined;
    }),
  );
  // The focused thread or frame (VS Code's onDidChangeActiveStackItem).
  let stackKey = "";
  sub.add(
    effect(() => {
      const rs = debug.focused.value;
      const item = rs
        ? activeStackItem({
            state: rs.state.value,
            threadId: rs.threadId.value,
            frames: rs.frames.value,
            frameIndex: rs.frameIndex.value,
          })
        : null;
      const key = rs && item ? `${rs.id}:${item.threadId}:${item.frameId ?? ""}` : "";
      if (key === stackKey) return undefined;
      stackKey = key;
      events.emit(
        "debug.didChangeActiveStackItem",
        rs && item ? { session: sessionInfo(rs), ...item } : null,
      );
      return undefined;
    }),
  );
  let first = true;
  sub.add(
    effect(() => {
      debug.breakpoints.list.value;
      debug.other.functions.value;
      // Not for the list as it loads.
      if (first) first = false;
      else events.emit("debug.didChangeBreakpoints", {});
      return undefined;
    }),
  );

  // Adapters' own events go to extensions as they come (VS Code's custom events), from when a
  // session has its debugger (before it starts: an adapter may send one while initializing).
  sub.add(
    debug.onDidAttachDebugger((rs) => {
      const session = rs.session;
      if (!session?.onCustomEvent) return;
      rs.store.add(
        session.onCustomEvent(({ event, body }) =>
          events.emit("debug.didReceiveCustomEvent", { session: sessionInfo(rs), event, body }),
        ),
      );
    }),
  );

  /** A session by id (default: the focused one), waiting while its debugger starts. */
  const sessionFor = async (session?: string): Promise<RunningSession> => {
    const find = () =>
      session ? debug.sessions.peek().find((x) => x.id === session) : debug.focused.peek();
    let rs = find();
    const deadline = Date.now() + STARTING_WAIT_MS;
    while (rs && !rs.session && !rs.ended && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      rs = find();
    }
    if (!rs?.session)
      throw new Error(session ? `No running session ${session}.` : "No debug session is running.");
    return rs;
  };

  sub.add(
    services.dispatcher.register({
      id: "debug.customRequest",
      title: "Send a request to a debug session",
      category: "Debug",
      description:
        "Sends a Debug Adapter Protocol request to a running session (`session` from ide://debug; default: the focused one) and returns its body, VS Code's DebugSession.customRequest: `command` (e.g. \"evaluate\", or the adapter's own), `arguments`.",
      input: s.object({
        session: s.string().optional(),
        command: s.string(),
        arguments: s.unknown().optional(),
      }),
      effects: ["exec"],
      agent: "hidden",
      palette: false,
      run: async ({ session, command, arguments: args }) => {
        const rs = await sessionFor(session);
        if (!rs.session?.customRequest)
          throw new Error(`${rs.name} isn't a Debug Adapter Protocol session.`);
        return rs.session.customRequest(
          command,
          args && typeof args === "object" ? (args as Record<string, unknown>) : {},
        );
      },
    }),
  );

  sub.add(
    services.dispatcher.register({
      id: "debug.protocolBreakpoint",
      title: "A breakpoint as a debug session placed it",
      category: "Debug",
      description:
        "VS Code's DebugSession.getDebugProtocolBreakpoint: the Debug Adapter Protocol breakpoint (verified, line, message) session `session` placed for line breakpoint `id` (ide://debug breakpoints), or null when it hasn't placed it.",
      input: s.object({ session: s.string(), id: s.integer() }),
      effects: ["read"],
      agent: "hidden",
      palette: false,
      run: ({ session, id }) => {
        const rs = debug.sessions.peek().find((x) => x.id === session);
        const bp = debug.breakpoints.list.peek().find((b) => b.id === id);
        if (!rs || !bp) return null;
        const key = pathKey(bp.path);
        const at = rs.sentIds.get(key)?.indexOf(bp.id) ?? -1;
        const placed = at >= 0 ? rs.placed.get(key)?.[at] : undefined;
        if (!placed) return null;
        return {
          id: bp.id,
          verified: placed.verified,
          line: placed.line ?? bp.line,
          source: { path: bp.path },
          ...(placed.message && { message: placed.message }),
        };
      },
    }),
  );

  sub.add(
    services.dispatcher.register({
      id: "debug.appendToConsole",
      title: "Write to the debug console",
      category: "Debug",
      description:
        "Writes text to the debug console (VS Code's debug.activeDebugConsole.append): the focused session's console, or every console while none runs.",
      input: s.object({ text: s.string() }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: ({ text }) => {
        const rs = debug.focused.peek();
        const line = { kind: "output" as const, text };
        if (rs) debug.printFor(rs, line);
        else debug.print(line);
        return null;
      },
    }),
  );
}
