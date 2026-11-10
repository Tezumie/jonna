// A server's Configure dialog (D205, like Cursor's "Configure <server>"): where it's configured
// with its on / off switch, its sign-in, sampling, and its tools grouped into reads and writes,
// each with a switch (the agent doesn't see a tool that's off), Enable all / Disable all per
// group, Reload (restart) and Done. The IDE's own tools open the same dialog, read-only, with the
// commands the agent can call too. Commands: agent.configureMcpServer, agent.setMcpServerEnabled,
// agent.setMcpToolEnabled; the settings are agent.mcp.disabledServers and agent.mcp.disabledTools.
import { h, on } from "../../core/dom/index";
import { mcpClientIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { mergeServers, type ResolvedServer } from "../../core/mcp/config";
import { samplingPolicy } from "../../core/mcp/sampling";
import { product } from "../../core/product";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import { icon } from "../../ui/Icon";
import { logo } from "../../ui/Logo";
import type { WorkbenchServices } from "../../workbench/services";
import type { McpClients } from "./mcp";
import { disabledServers, disabledTools } from "./mcpConfigFiles";
import type { SessionManager } from "./sessions";

/** The id the IDE's own tools go by in these commands. */
export const BUILTIN_SERVER = "builtin";

/** The agent's own tools a new chat has now, once each (MCP servers' aren't among them). */
export const builtinTools = (sessions: SessionManager) => [
  ...new Map(sessions.builtinTools().map((x) => [x.spec.name, x])).values(),
];

/**
 * The commands the agent may call through call_command: `all` of them, and how many are
 * `usable` now (the rest wait for their `when`: a folder, a git repository, an editor…; only
 * those are listed by find_commands at the moment).
 */
export function agentCommandCount(services: WorkbenchServices): { all: number; usable: number } {
  const listed = services.dispatcher.list().filter((c) => c.agent !== "hidden");
  return { all: listed.length, usable: listed.filter((c) => c.enabled).length };
}

interface ToolRow {
  name: string;
  readOnly: boolean;
  description: string;
}

export function registerMcpConfigure(
  sub: DisposableStore,
  services: WorkbenchServices,
  clients: McpClients,
  sessions: SessionManager,
  serverUrl: (sv: ResolvedServer, root: string) => Promise<string | null>,
): void {
  const { dispatcher, settings } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "Agent", ...c }));

  const setDisabledServer = async (server: string, enabled: boolean) => {
    const off = disabledServers(services);
    if (enabled) off.delete(server);
    else off.add(server);
    await settings.update("agent.mcp.disabledServers", [...off].sort(), "user");
  };
  const setDisabledTools = async (server: string, tools: string[], enabled: boolean) => {
    const all = disabledTools(services);
    const off = all.get(server) ?? new Set<string>();
    for (const t of tools) {
      if (enabled) off.delete(t);
      else off.add(t);
    }
    const next: Record<string, string[]> = {};
    for (const [name, set] of all) if (name !== server && set.size) next[name] = [...set].sort();
    if (off.size) next[server] = [...off].sort();
    await settings.update("agent.mcp.disabledTools", next, "user");
  };

  register({
    id: "agent.setMcpServerEnabled",
    title: "Turn an MCP server on or off",
    description:
      "Turns an MCP server on or off for the agent (agent.mcp.disabledServers): a server that's off is listed but never started.",
    input: s.object({ server: s.string(), enabled: s.boolean() }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: async ({ server, enabled }) => {
      await setDisabledServer(server, enabled);
      return { server, enabled };
    },
  });

  register({
    id: "agent.setMcpToolEnabled",
    title: "Turn MCP tools on or off",
    description:
      "Turns some of an MCP server's tools on or off (agent.mcp.disabledTools): the agent doesn't see a tool that's off. `tools` names them; `*` is every tool the running server lists.",
    input: s.object({
      server: s.string(),
      tools: s.array(s.string()),
      enabled: s.boolean(),
    }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: async ({ server, tools, enabled }) => {
      const names = tools.includes("*")
        ? (clients.serverTools(server) ?? []).map((t) => t.name)
        : tools;
      await setDisabledTools(server, names, enabled);
      return { server, tools: names, enabled };
    },
  });

  register({
    id: "agent.configureMcpServer",
    title: "Configure an MCP server…",
    description:
      "Opens a server's Configure dialog: where it's configured and its switch, sign-in, sampling, and its tools (reads and writes) to turn on or off. `builtin` shows the IDE's own tools.",
    input: s.object({ server: s.string() }),
    effects: [],
    agent: "hidden",
    palette: false,
    run: async ({ server }) => {
      const store = new DisposableStore();
      const content = h("div", { class: "dialog-form mcp-config" });
      const builtin = server === BUILTIN_SERVER;
      const sv = builtin
        ? null
        : (mergeServers(await clients.sources()).find((x) => x.name === server) ?? null);
      if (!builtin && !sv) throw new Error(`No MCP server named ${server}.`);
      const run = (command: string, input: unknown) =>
        void dispatcher.execute(command, input).catch((err: unknown) => {
          services.notifications.show("error", err instanceof Error ? err.message : String(err));
        });
      const section = (title: string, lead: string | null, ...children: (Node | null)[]) =>
        h(
          "section",
          { class: "mcp-config-section" },
          h("h3", { class: "mcp-config-title" }, title),
          lead ? h("p", { class: "mcp-config-lead" }, lead) : null,
          ...children,
        );
      const box = (...children: (Node | null)[]) =>
        h("div", { class: "mcp-config-box" }, ...children);
      const switchBox = (label: string, checked: boolean, change: (v: boolean) => void) => {
        const el = h("input", {
          type: "checkbox",
          class: "switch",
          "aria-label": label,
        }) as HTMLInputElement;
        el.checked = checked;
        draw.add(on(el, "change", () => change(el.checked)));
        return el;
      };
      const toolGroup = (title: string, rows: ToolRow[], off: Set<string>, editable: boolean) => {
        if (!rows.length) return null;
        let bulk: HTMLElement | null = null;
        if (editable) {
          const select = h(
            "select",
            { class: "input input-sm mcp-config-bulk", "aria-label": `${title}: all` },
            h("option", { value: "" }, off.size ? "Some off" : "All on"),
            h("option", { value: "on" }, "Turn all on"),
            h("option", { value: "off" }, "Turn all off"),
          ) as HTMLSelectElement;
          draw.add(
            on(select, "change", () => {
              if (!select.value) return;
              run("agent.setMcpToolEnabled", {
                server,
                tools: rows.map((r) => r.name),
                enabled: select.value === "on",
              });
            }),
          );
          bulk = select;
        }
        return box(
          h("div", { class: "mcp-config-group" }, h("span", null, title), bulk),
          ...rows.map((r) =>
            h(
              "div",
              { class: "mcp-config-tool", title: r.description },
              h("code", null, r.name),
              editable
                ? switchBox(r.name, !off.has(r.name), (v) =>
                    run("agent.setMcpToolEnabled", { server, tools: [r.name], enabled: v }),
                  )
                : h("span", { class: "mcp-config-note" }, r.readOnly ? "read" : "asks"),
            ),
          ),
        );
      };
      let draw = new DisposableStore();
      store.add({ dispose: () => draw.dispose() });
      let signedIn: boolean | null = null;
      const url = sv ? await serverUrl(sv, clients.folderOfServer(sv) ?? "") : null;
      const refreshSignIn = async () => {
        signedIn =
          sv && url
            ? ((await mcpClientIpc.oauthStatus(sv.name, url).catch(() => null))?.signedIn ?? false)
            : null;
      };
      await refreshSignIn();
      const render = () => {
        draw.dispose();
        draw = new DisposableStore();
        if (builtin) {
          const commands = agentCommandCount(services);
          const tools: ToolRow[] = builtinTools(sessions).map((x) => ({
            name: x.spec.name,
            readOnly: x.readOnly,
            description: x.spec.description,
          }));
          content.replaceChildren(
            section(
              "Tools",
              `Always on: the agent's own tools. It also calls the IDE's commands through find_commands and call_command: ${commands.all} of them (git, terminals, editors, layout, settings, extensions…), ${commands.usable} usable right now; the others need a folder, a git repository, an open editor or the like first.`,
              toolGroup(
                "Reads",
                tools.filter((x) => x.readOnly),
                new Set(),
                false,
              ),
              toolGroup(
                "Writes",
                tools.filter((x) => !x.readOnly),
                new Set(),
                false,
              ),
            ),
          );
          return;
        }
        if (!sv) return;
        const off = disabledServers(services);
        const enabled = !off.has(sv.name);
        const status = clients.statuses.peek().find((x) => x.name === sv.name);
        const listed = clients.serverTools(sv.name);
        const toolsOff = disabledTools(services).get(sv.name) ?? new Set<string>();
        const rows: ToolRow[] = (listed ?? []).map((t) => ({
          name: t.name,
          readOnly: t.annotations?.readOnlyHint === true,
          description: t.description ?? t.title ?? "",
        }));
        const sampling = h(
          "select",
          { class: "input input-sm", "aria-label": "Sampling" },
          ...[
            ["ask", "Ask each time"],
            ["allow", "Allow"],
            ["deny", "Deny"],
          ].map(([id, text]) => h("option", { value: id }, text)),
        ) as HTMLSelectElement;
        sampling.value = samplingPolicy(settings.peek<unknown>("agent.mcp.sampling"), sv.name);
        draw.add(
          on(sampling, "change", () =>
            run("agent.setMcpSampling", { server: sv.name, policy: sampling.value }),
          ),
        );
        content.replaceChildren(
          section(
            "Source",
            "Where this server is configured.",
            box(
              h(
                "div",
                { class: "mcp-config-line" },
                icon(sv.source.kind === "workspace" ? "folder" : "users"),
                h(
                  "span",
                  { class: "mcp-config-main" },
                  h("strong", null, sv.source.kind === "workspace" ? "Workspace" : "User"),
                  h("span", { class: "mcp-config-note" }, sv.source.label),
                ),
                switchBox(`${sv.name} on`, enabled, (v) =>
                  run("agent.setMcpServerEnabled", { server: sv.name, enabled: v }),
                ),
              ),
            ),
          ),
          ...(url
            ? [
                section(
                  "Sign-in",
                  null,
                  box(
                    h(
                      "div",
                      { class: "mcp-config-line" },
                      icon("globe"),
                      h(
                        "span",
                        { class: "mcp-config-main" },
                        h("strong", null, url.replace(/^https?:\/\//, "").split("/")[0] ?? url),
                        h(
                          "span",
                          { class: "mcp-config-note" },
                          signedIn ? "Signed in" : "Not signed in",
                        ),
                      ),
                      (() => {
                        const b = h(
                          "button",
                          { class: "button button-secondary button-sm", type: "button" },
                          signedIn ? "Sign out" : "Sign in",
                        );
                        draw.add(
                          on(b, "click", () => {
                            void dispatcher
                              .execute(signedIn ? "agent.mcpSignOut" : "agent.mcpSignIn", {
                                server: sv.name,
                              })
                              .catch(() => {})
                              .then(refreshSignIn)
                              .then(render);
                          }),
                        );
                        return b;
                      })(),
                    ),
                  ),
                ),
              ]
            : []),
          section(
            "Sampling",
            "May it ask your model to write text for it?",
            box(h("div", { class: "mcp-config-line" }, icon("sparkles"), sampling)),
          ),
          section(
            "Tools",
            enabled
              ? "Turn individual tools on or off; the agent doesn't see one that's off."
              : "The server is off.",
            listed
              ? toolGroup(
                  "Reads",
                  rows.filter((x) => x.readOnly),
                  toolsOff,
                  true,
                )
              : box(
                  h(
                    "p",
                    { class: "mcp-config-note" },
                    status?.state === "failed"
                      ? `It didn't start: ${status.error ?? "see the agent's output"}.`
                      : enabled
                        ? "Its tools are listed once it has started (with the agent's next message, or Reload)."
                        : "Turn it on to see its tools.",
                  ),
                ),
            listed
              ? toolGroup(
                  "Writes",
                  rows.filter((x) => !x.readOnly),
                  toolsOff,
                  true,
                )
              : null,
          ),
        );
      };
      store.add(
        effect(() => {
          clients.statuses.value;
          settings.version.value;
          render();
          return undefined;
        }),
      );
      const choice = await showDialog<"done" | "reload">({
        title: builtin ? `${product.nameShort} (built in)` : `Configure ${server}`,
        titleIcon: builtin ? logo(22) : icon(url ? "globe" : "server"),
        message: builtin ? "" : "1 source",
        content,
        size: "md",
        actions: [{ label: "Done", value: "done", variant: "primary" }],
        leftActions: builtin ? [] : [{ label: "Reload", value: "reload" }],
        cancelValue: "done",
      });
      store.dispose();
      if (choice === "reload" && sv) {
        await dispatcher.execute("agent.mcpServers", { restart: sv.name }).catch(() => {});
        return dispatcher.execute("agent.configureMcpServer", { server });
      }
      return { closed: true };
    },
  });
}
