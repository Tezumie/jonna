// Built-in MCP server control (D64): starts/stops the Rust server with the `mcp.enabled` setting,
// keeps its catalog (commands → tools, state paths → resources) current, and runs forwarded calls
// as caller `{ kind: "mcp", client }` so the permission policy decides. Status bar shows it.

import type { CommandInfo } from "../../core/dispatcher/index";
import type { BuiltinExtension } from "../../core/extensions/index";
import { isTauri } from "../../core/ipc/invoke";
import { clipboardIpc, type McpInfo, type McpRequest, mcpIpc } from "../../core/ipc/system";
import { mcpAgentAccess } from "../../core/mcp/agentAccess";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import manifest from "./extension.json";
import { registerIdeIntegration } from "./ideIntegration";

const CATALOG_REFRESH_MS = 5000;

/** The Claude Code command line that connects to this server. */
export function claudeCodeCommand(info: McpInfo): string {
  return `claude mcp add --transport http ide ${info.url} --header "Authorization: Bearer ${info.token}"`;
}

export const mcpExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, settings, state, statusBar, events, notifications } = services;
    const running = signal<McpInfo | null>(null);
    let lastCatalog = "";

    const pushCatalog = () => {
      if (!running.peek()) return;
      const tools = dispatcher
        .list()
        .filter((c: CommandInfo) => c.agent !== "hidden" && !c.id.startsWith("mcp."))
        .map((c) => ({
          command: c.id,
          title: c.category ? `${c.category}: ${c.title}` : c.title,
          description: c.description,
          inputSchema: c.inputSchema,
          core: c.agent === "core",
          readOnly: c.effects.every((e) => e === "read"),
        }));
      const resources = state.list().map((p) => ({ uri: p.path, description: p.description }));
      const key = JSON.stringify([tools.map((t) => t.command), resources.map((r) => r.uri)]);
      if (key === lastCatalog) return;
      lastCatalog = key;
      void mcpIpc.setCatalog(tools, resources).catch(() => {});
    };

    const handle = (request: McpRequest) => {
      // Only Claude Code's WebSocket cancels calls (D223); nothing to drop here.
      if (request.kind === "cancel") return;
      const caller = { kind: "mcp" as const, client: request.client };
      const work =
        request.kind === "call"
          ? dispatcher.execute(request.command, request.input ?? {}, caller)
          : state.get(request.uri, { budget: 50_000 }).then((snap) => snap.value);
      const fail = (err: unknown) =>
        mcpIpc.respond(request.id, null, err instanceof Error ? err.message : String(err));
      // A result that can't be sent (not JSON) still answers, with why: the client would wait.
      void work
        .then((result) => mcpIpc.respond(request.id, result).catch(fail), fail)
        .catch(() => {});
    };

    /** External agents borrowing the server (D211): it stays up while any does. */
    const borrowers = new Set<string>();
    const enabled = () => settings.peek<boolean>("mcp.enabled") === true || borrowers.size > 0;
    /**
     * The start in flight, shared: the setting's effect and mcp.start both call start(), and
     * stop() must wait for it, or a server that finishes starting after Stop keeps running.
     */
    let starting: Promise<void> | null = null;
    const start = (): Promise<void> => {
      if (!isTauri() || running.peek()) return Promise.resolve();
      if (starting) return starting;
      const attempt = (async () => {
        try {
          running.value = await mcpIpc.start(handle);
          lastCatalog = "";
          pushCatalog();
        } catch (err) {
          notifications.show(
            "error",
            `MCP server didn't start: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          starting = null;
        }
        // Turned off while it started: the stop() that ran then found nothing to stop yet.
        if (!enabled()) await stop();
      })();
      starting = attempt;
      return attempt;
    };
    /** `force` stops even if the setting is on again (disposal); otherwise a stale stop yields. */
    const stop = async (force = false) => {
      if (starting) {
        await starting;
        if (!force && enabled()) return;
      }
      if (!running.peek()) return;
      await mcpIpc.stop().catch(() => {});
      running.value = null;
    };

    sub.add(
      effect(() => {
        const on = settings.get<boolean>("mcp.enabled") === true;
        // Off with chats still borrowing it (D211): it stops when the last one leaves.
        if (on) void start();
        else if (borrowers.size === 0) void stop();
        return undefined;
      }),
    );
    mcpAgentAccess.provide({
      acquire: async (owner) => {
        borrowers.add(owner);
        await start();
        const info = running.peek();
        if (!info) borrowers.delete(owner);
        return info ? { url: info.url, token: info.token } : null;
      },
      release: (owner) => {
        if (!borrowers.delete(owner)) return;
        if (!enabled()) void stop();
      },
    });
    sub.add({ dispose: () => mcpAgentAccess.provide(null) });
    sub.add(events.on("command.registered", () => queueMicrotask(pushCatalog)));
    const timer = setInterval(pushCatalog, CATALOG_REFRESH_MS);
    sub.add({ dispose: () => clearInterval(timer) });
    sub.add({ dispose: () => void stop(true) });

    sub.add(
      statusBar.add({
        id: "mcp",
        name: "MCP servers",
        alignment: "right",
        priority: 10,
        text: () => (running.value ? "$(radio) MCP" : ""),
        tooltip: () => {
          const info = running.value;
          return info ? `MCP server on ${info.url} (click for connection info)` : "";
        },
        command: "mcp.showConnectionInfo",
      }),
    );

    sub.add(
      dispatcher.register({
        id: "mcp.start",
        title: "Start MCP server",
        category: "MCP",
        description: "Turns on the MCP server (sets mcp.enabled) and shows how to connect.",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        run: async (_input, ctx) => {
          await settings.update("mcp.enabled", true, "user");
          await start();
          await ctx.execute("mcp.showConnectionInfo");
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "mcp.stop",
        title: "Stop MCP server",
        category: "MCP",
        description:
          "Turns off the MCP server (clears mcp.enabled); connected clients are cut off.",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        run: async () => {
          await settings.update("mcp.enabled", false, "user");
          await stop();
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "mcp.showConnectionInfo",
        title: "Show MCP connection info",
        category: "MCP",
        description:
          "Shows the server URL and token, and the Claude Code command that connects to it.",
        input: s.empty(),
        effects: [],
        agent: "hidden",
        run: async () => {
          const info = running.peek();
          if (!info) throw new Error('The MCP server is off. Run "MCP: Start MCP server".');
          const command = claudeCodeCommand(info);
          const choice = await showDialog<"copy" | "close">({
            title: "Connect an agent over MCP",
            message: `URL: ${info.url}\nToken: ${info.token}\n\nClaude Code:\n${command}\n\nThe port and token change every time the server starts (see docs/mcp.md).`,
            actions: [
              { label: "Close", value: "close" },
              { label: "Copy Claude Code command", value: "copy", variant: "primary" },
            ],
            cancelValue: "close",
            size: "lg",
          });
          if (choice === "copy") {
            await clipboardIpc.writeText(command).then(
              () => notifications.show("info", "Command copied."),
              () =>
                notifications.show(
                  "warning",
                  "Couldn't copy; select the text in the dialog instead.",
                ),
            );
          }
        },
      }),
    );
    // Claude Code's /ide (D204).
    registerIdeIntegration(sub, services);
    sub.add(
      state.register("ide://mcp", {
        description: "MCP server: whether it runs and its URL (the token is not exposed here).",
        get: () => ({
          enabled: settings.peek("mcp.enabled") === true,
          running: running.peek() !== null,
          url: running.peek()?.url ?? null,
        }),
      }),
    );
  },
};
