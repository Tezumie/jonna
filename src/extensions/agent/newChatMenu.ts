// The "+ ▾" (D236; D291 for the plain chat panel) in the Chats view's title bar, as VS Code's chat
// and terminal "+ ▾": a new chat with one of the agents (each with its face), a new group chat,
// and the Agents page. Also here: the view's ⋯ (agent.channelsMenu).

import type { FaceSpec } from "../../core/agent/faces";
import { MAIN_MEMBER } from "../../core/agent/groupChat";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import { agentFace } from "../../ui/AgentFace";
import { type MenuItem, showContextMenu } from "../../ui/Menu";
import type { WorkbenchServices } from "../../workbench/services";
import { knownAgents } from "./groupChat";
import { rooms } from "./roomService";
import type { SessionManager } from "./sessions";

export function registerNewChatMenu(
  sub: DisposableStore,
  services: WorkbenchServices,
  _sessions: SessionManager,
): void {
  const { dispatcher } = services;
  sub.add(
    dispatcher.register({
      id: "agent.newChatMenu",
      title: "Talk to…",
      category: "Agent",
      description:
        "The ▾ beside + (D291): a new chat with one of the agents, a new group chat, the Agents page. `x` / `y`: where to open it (without them: agent.chatWith's picker).",
      input: s.object({ x: s.number().optional(), y: s.number().optional() }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: ({ x, y }) => {
        if (x === undefined || y === undefined) return dispatcher.execute("agent.chatWith", {});
        const run =
          (command: string, input: unknown = {}) =>
          () =>
            void dispatcher.execute(command, input).catch(() => {});
        const face = (spec: FaceSpec) => () => agentFace(spec, { size: 16 });
        const agents = knownAgents();
        const items: MenuItem[] = [
          ...agents.map((a) => ({
            label: a.label,
            keybinding: a.name === MAIN_MEMBER ? "Agent" : (a.role ?? ""),
            iconElement: face(a.face),
            run: run("agent.chatWith", { agent: a.name }),
          })),
          {
            label: "New group chat…",
            icon: "users",
            separatorBefore: true,
            run: run("agent.newGroupChat"),
          },
          {
            label: "Agents and models",
            icon: "settings",
            run: run("agent.showAgentConfig"),
          },
        ];
        showContextMenu(x, y, items);
        return { agents: agents.length };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.channelsMenu",
      title: "Agent pages…",
      category: "Agent",
      description:
        "The Chats view's ⋯ (D249, D291): Sessions…, Scheduled messages, Manage providers, MCP servers, Agent memory, Tidy up memory, Archived channels and Agent settings. `x` / `y`: where to open it (without them: the command palette's list).",
      input: s.object({ x: s.number().optional(), y: s.number().optional() }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: async ({ x, y }) => {
        const run =
          (command: string, input: unknown = {}) =>
          () =>
            void dispatcher.execute(command, input).catch(() => {});
        const items: MenuItem[] = [
          // Agents and Usage are rows of the Chats view (D291).
          { label: "Sessions…", icon: "history", run: run("agent.showHistory") },
          // D253: what's scheduled in this folder.
          { label: "Scheduled messages", icon: "clock", run: run("agent.schedules") },
          {
            label: "Manage providers",
            icon: "plug",
            separatorBefore: true,
            run: run("agent.showSetup"),
          },
          { label: "MCP servers", icon: "server", run: run("agent.showMcpPage") },
          { label: "Agent memory", icon: "brain", run: run("agent.openMemory") },
          { label: "Tidy up memory", icon: "sparkles", run: run("agent.dream") },
          ...(rooms.peek().some((r) => r.archived && !r.task)
            ? [
                {
                  label: "Archived channels…",
                  icon: "archive" as const,
                  separatorBefore: true,
                  run: run("agent.restoreChannel"),
                },
              ]
            : []),
          {
            label: "Agent settings",
            icon: "settings",
            separatorBefore: true,
            run: run("settings.open", { category: "Agent" }),
          },
        ];
        if (x === undefined || y === undefined) {
          const picked = await services.quickInput.pick(
            items.map((it, i) => ({ id: String(i), label: it.label })),
            { placeholder: "Open which agent page?" },
          );
          if (picked) items[Number(picked.id)]?.run?.();
          return picked ? { opened: picked.label } : null;
        }
        showContextMenu(x, y, items);
        return { items: items.length };
      },
    }),
  );
}
