// The agent's background commands for the user and scripts (D201): list them, show one's output,
// stop one (the chat's list calls these), and `ide://agent/processes`. They're all killed when the
// folder closes and when the extension stops (the window closes).
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { type BackgroundProcess, backgroundProcesses, runningFor } from "./backgroundProcesses";
import type { SessionManager } from "./sessions";
import { PROCESS_OUTPUT_VIEW, processOutputView } from "./view/processOutput";

function describe(p: BackgroundProcess, withOutput = false) {
  return {
    id: p.id,
    session: p.session,
    command: p.command,
    cwd: p.cwd,
    status: p.status,
    ...(p.exitCode !== null && { exitCode: p.exitCode }),
    ...(p.error && { error: p.error }),
    startedAt: new Date(p.startedAt).toISOString(),
    runningFor: runningFor(p),
    urls: p.urls,
    // A monitor (D322): what it watches and the events it sent.
    ...(p.monitor && { monitor: { description: p.monitor.description, events: p.monitor.events } }),
    /** Characters the agent hasn't read yet. */
    unread: p.output.unread,
    // Not in ide://agent/processes: agents read state, and one chat mustn't read another's
    // output (process_output checks the chat; D201).
    ...(withOutput && { outputTail: p.output.tail(1500) }),
  };
}

export function registerProcessCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  const { dispatcher, state, workspace } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));
  // The folder closed (or another opened): its servers and watchers go with it.
  sub.add(workspace.onDidClose(() => backgroundProcesses.killAll()));
  sub.add({ dispose: () => backgroundProcesses.killAll() });

  sub.add(services.dock.views.register(processOutputView(services)));

  const find = (id: string) => {
    const p = backgroundProcesses.get(id);
    if (!p) throw new Error(`No background command "${id}" (agent.listProcesses shows them).`);
    return p;
  };

  register({
    id: "agent.listProcesses",
    title: "Agent background commands",
    description:
      "The commands agent chats started in the background (dev servers, watchers): id, chat, command, status, server URLs, how long they've run, the end of their output. `session` limits it to one chat.",
    input: s.object({ session: s.string().optional() }),
    effects: ["read"],
    agent: "hidden",
    run: ({ session }) => {
      const id = session ? (sessions.find(session)?.id ?? session) : undefined;
      return { processes: backgroundProcesses.list(id).map((p) => describe(p, true)) };
    },
  });

  register({
    id: "agent.killProcess",
    title: "Stop an agent background command",
    description:
      "Stops a command an agent chat started in the background (by its id, e.g. bg1), and what it started.",
    input: s.object({ id: s.string() }),
    effects: ["exec"],
    agent: "hidden",
    run: async ({ id }) => {
      const p = find(id);
      return { id: p.id, stopped: await backgroundProcesses.kill(p.id) };
    },
  });

  register({
    id: "agent.showProcessOutput",
    title: "Show an agent background command's output",
    description:
      "Opens what a background command of an agent chat prints, live (D286: it follows new output while the command runs, with Stop), in a panel tab, without changing what the agent reads next.",
    input: s.object({ id: s.string() }),
    effects: [],
    agent: "hidden",
    run: (input) => {
      const p = find(input.id);
      const { dock } = services;
      const open = dock
        .tabs(PROCESS_OUTPUT_VIEW)
        .find((t) => stateField(t.viewState, "id") === p.id);
      if (open) {
        dock.activateTab(open.id, true);
        return { tab: open.id };
      }
      return { tab: dock.openView(PROCESS_OUTPUT_VIEW, { id: p.id }, "bottom", true) };
    },
  });

  sub.add(
    state.register("ide://agent/processes", {
      description:
        "Commands agent chats started in the background (run_command with background: true; D201): id (bg1…), chat, command, folder, status (running, exited, killed, failed), exit code, server URLs, how long, unread characters (the output itself only through process_output and Output).",
      get: () => ({ processes: backgroundProcesses.list().map((p) => describe(p)) }),
    }),
  );
}
