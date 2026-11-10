// The MCP servers section of Customize (D204, simplified like Cursor's in D205): the built-in
// tools (the IDE's own, always on) and the agent's servers as rows with their state and tool
// count — a row's ⋯ (agent.mcpServerActions) signs in or out, sets sampling, restarts or
// removes it — and New MCP server (agent.newMcpServer: a custom one in mcp.json, or one of the
// popular servers from core/mcp/gallery.ts). Commands: agent.showMcpPage,
// agent.installMcpServer, agent.removeMcpServer, agent.mcpSignIn, agent.mcpSignOut,
// agent.mcpGallery, agent.builtinTools (and agent.setMcpSampling, mcpSampling.ts). A server's own
// icon (its `serverInfo.icons`, or the registry's server.json `icons`; core/mcp/icons.ts) shows
// on its row and in the registry search: data: pictures as they are, https ones fetched by the
// backend (core/ipc/remoteImage.ts), the server / globe glyph otherwise.
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { fsIpc } from "../../core/ipc/fs";
import { remoteImages } from "../../core/ipc/remoteImage";
import { appIpc, type McpSignInStatus, mcpClientIpc, openerIpc } from "../../core/ipc/system";
import { DisposableStore } from "../../core/lifecycle/index";
import { mergeServers, type ResolvedServer, substitute } from "../../core/mcp/config";
import { galleryConfig, galleryEntry, MCP_GALLERY, searchGallery } from "../../core/mcp/gallery";
import { type McpIcon, pickIcon } from "../../core/mcp/icons";
import { samplingPolicy } from "../../core/mcp/sampling";
import { product } from "../../core/product";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import { icon } from "../../ui/Icon";
import { logo } from "../../ui/Logo";
import type { DockView } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { addCustomizeSection, openCustomize } from "./customize";
import type { McpClients } from "./mcp";
import {
  disabledServers,
  disabledTools,
  folderMcpFile,
  mcpConfigVersion,
  removeServerEntry,
  userMcpPath,
  writeServerEntry,
} from "./mcpConfigFiles";
import {
  agentCommandCount,
  BUILTIN_SERVER,
  builtinTools,
  registerMcpConfigure,
} from "./mcpConfigure";
import { lookUpRegistry, registerMcpRegistry, registryHit, searchRegistry } from "./mcpRegistry";
import type { SessionManager } from "./sessions";
import { addButton, pageGroup, pageHeader, runCommand, tag } from "./view/pageKit";
import { pickWorkspaceFolder } from "./workspaceFolderPick";

/** The address a remote server is reached at (its config's url, variables filled). */
async function serverUrl(server: ResolvedServer, root: string): Promise<string | null> {
  if (!server.config.url) return null;
  const home = (await appIpc.info().catch(() => null))?.homeDir ?? null;
  return substitute(server.config, { workspaceFolder: root, userHome: home }, () => "").url ?? null;
}

/** "User", "Workspace", or where else it's configured (Claude Desktop…). */
function scopeLabel(source: ResolvedServer["source"]): string {
  if (source.kind === "workspace") return "Workspace";
  if (source.label === "user mcp.json" || source.kind === "settings") return "User";
  return source.label;
}

/** The picture's URL to show (data:, or a blob: of an https one the backend fetched), or null. */
async function iconUrl(icon: McpIcon): Promise<string | null> {
  if (icon.src.startsWith("data:")) return icon.src;
  return (await remoteImages.url(icon.src)) ?? null;
}

/**
 * A server's own icon in place of `fallback` (its glyph): shown once the picture is there, the
 * glyph again if it doesn't load. One-color SVGs are drawn in the text color.
 */
function serverIcon(
  icons: readonly McpIcon[] | undefined,
  theme: "light" | "dark",
  fallback: Element,
  st: DisposableStore,
): Element {
  const icon = pickIcon(icons ?? [], theme, Math.ceil(20 * (window.devicePixelRatio || 1)));
  if (!icon) return fallback;
  if (icon.mono) {
    const mask = h("span", { class: "mcp-row-image is-mono", "aria-hidden": "true" });
    mask.style.setProperty("--logo", `url("${icon.src}")`);
    return mask;
  }
  const box = h("span", { class: "mcp-row-glyph" }, fallback);
  void iconUrl(icon).then((url) => {
    if (!url) return;
    const img = h("img", { class: "mcp-row-image", src: url, alt: "", draggable: "false" });
    st.add(on(img, "error", () => box.replaceChildren(fallback)));
    box.replaceChildren(img);
  });
  return box;
}

/** A registry entry's icon for the search list (null: its glyph), waiting at most `ms`. */
async function pickerImage(
  icons: readonly McpIcon[] | undefined,
  theme: "light" | "dark",
  ms = 1500,
): Promise<string | null> {
  const icon = pickIcon(icons ?? [], theme, Math.ceil(16 * (window.devicePixelRatio || 1)));
  // A one-color SVG needs the text color (a mask), which a list row's picture can't take.
  if (!icon || icon.mono) return null;
  return Promise.race([
    iconUrl(icon).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

class McpPageView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly render = this.store.add(new DisposableStore());
  private readonly body: HTMLElement;
  private servers: ResolvedServer[] = [];
  private signIn = new Map<string, McpSignInStatus>();

  constructor(
    private readonly services: WorkbenchServices,
    private readonly clients: McpClients,
    private readonly sessions: SessionManager,
  ) {
    this.body = h("div", { class: "ai-setup mcp-page" });
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.body);
    this.store.add(
      effect(() => {
        clients.statuses.value;
        mcpConfigVersion.value;
        services.settings.version.value;
        services.workspace.root.value;
        services.workspace.folders.value;
        void this.reload();
        return undefined;
      }),
    );
  }

  private async reload(): Promise<void> {
    this.servers = mergeServers(await this.clients.sources());
    const signIn = new Map<string, McpSignInStatus>();
    for (const sv of this.servers) {
      const url = await serverUrl(sv, this.clients.folderOfServer(sv) ?? "");
      if (url) {
        const st = await mcpClientIpc.oauthStatus(sv.name, url).catch(() => null);
        if (st) signIn.set(sv.name, st);
      }
    }
    this.signIn = signIn;
    this.draw();
  }

  private run(command: string, input: unknown = {}): Promise<unknown> {
    return runCommand(this.services, command, input);
  }

  private draw(): void {
    this.render.clear();
    const st = this.render;
    const statuses = this.clients.statuses.peek();
    const row = (
      key: Record<string, string>,
      glyph: Element,
      name: string,
      badge: string | null,
      detail: string,
      dot: "ok" | "error" | "off" | null,
      open: () => unknown,
      more: (() => unknown) | null,
    ): HTMLElement => {
      const el = h(
        "div",
        { class: "mcp-row", ...key, tabindex: "0", role: "button" },
        h(
          "span",
          { class: "mcp-row-icon" },
          glyph,
          dot ? h("span", { class: `mcp-row-dot is-${dot}` }) : null,
        ),
        h(
          "span",
          { class: "mcp-row-main" },
          h(
            "span",
            { class: "mcp-row-title" },
            h("span", { class: "mcp-row-name" }, name),
            badge ? tag(badge) : null,
          ),
          h("span", { class: "mcp-row-detail" }, detail),
        ),
        more
          ? (() => {
              const b = h(
                "button",
                {
                  class: "icon-button mcp-row-more",
                  type: "button",
                  "aria-label": `More for ${name}`,
                },
                icon("ellipsis"),
              );
              st.add(
                on(b, "click", (ev) => {
                  ev.stopPropagation();
                  void more();
                }),
              );
              return b;
            })()
          : null,
      );
      st.add(on(el, "click", () => void open()));
      st.add(
        on(el, "keydown", (ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            void open();
          }
        }),
      );
      return el;
    };
    const builtin = row(
      { "data-builtin": "true" },
      logo(20, "mcp-row-logo"),
      product.nameShort,
      "Built in",
      `${builtinTools(this.sessions).length} tools and ${agentCommandCount(this.services).all} IDE commands`,
      "ok",
      () => this.run("agent.configureMcpServer", { server: BUILTIN_SERVER }),
      null,
    );
    const off = disabledServers(this.services);
    const toolsOff = disabledTools(this.services);
    const rows = this.servers.map((sv) => {
      const status = statuses.find((x) => x.name === sv.name);
      const isOff = off.has(sv.name);
      const enabledTools = (status?.tools ?? 0) - (toolsOff.get(sv.name)?.size ?? 0);
      const signed = this.signIn.get(sv.name);
      const remote = !!sv.config.url;
      const detail = isOff
        ? "Off"
        : status?.needsSignIn
          ? "Needs sign-in"
          : status?.state === "failed"
            ? `Failed${status.error ? `: ${status.error}` : ""}`
            : status?.state === "running"
              ? `${Math.max(0, enabledTools)} tools enabled${remote && signed?.signedIn ? " · signed in" : ""}`
              : "Starts with the agent's next message";
      // Its own icon: what the running server said, else what the registry listed for it.
      const icons = status?.icons ?? registryHit(sv.name)?.icons;
      return row(
        { "data-server": sv.name },
        serverIcon(icons, this.services.theme.theme.peek(), icon(remote ? "globe" : "server"), st),
        sv.name,
        scopeLabel(sv.source),
        detail,
        isOff
          ? "off"
          : status?.state === "running"
            ? "ok"
            : status?.state === "failed" || status?.needsSignIn
              ? "error"
              : "off",
        () => this.run("agent.configureMcpServer", { server: sv.name }),
        () => this.run("agent.mcpServerActions", { server: sv.name }),
      );
    });
    const add = addButton(st, "New", () => this.run("agent.newMcpServer"), {
      "data-new": "true",
      title: "Add a custom server, or one of the popular ones",
    });
    this.body.replaceChildren(
      pageHeader("MCP servers", null),
      pageGroup(
        "Connected",
        rows.length + 1,
        [
          addButton(st, "Edit mcp.json", () => this.run("agent.openMcpConfig"), {}, "file-json"),
          add,
        ],
        [h("div", { class: "mcp-list" }, builtin, ...rows)],
        { "data-group": "connected" },
      ),
    );
  }

  focus(): void {
    this.element.focus();
  }

  serialize(): Json {
    return null;
  }

  dispose(): void {
    this.store.dispose();
  }
}

export function registerMcpPage(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  clients: McpClients,
): void {
  const { dispatcher, workspace, quickInput, notifications } = services;
  registerMcpRegistry(sub, services);
  sub.add(
    addCustomizeSection({
      id: "mcp",
      label: "MCP",
      icon: "server",
      detail: "Servers the agent uses: sign-in, sampling, restart, and popular ones to add",
      keywords: "mcp servers tools gallery oauth",
      order: 50,
      page: { create: () => new McpPageView(services, clients, sessions) },
    }),
  );
  registerMcpConfigure(sub, services, clients, sessions, serverUrl);
  const resolved = async (name: string) => {
    const sv = mergeServers(await clients.sources()).find((x) => x.name === name);
    if (!sv) throw new Error(`No MCP server named ${name}.`);
    return sv;
  };
  const restart = async (name: string) => {
    await clients.stop([name]);
    await clients.ensure(sessions.find(undefined) ?? undefined).catch(() => {});
  };

  sub.add(
    dispatcher.register({
      id: "agent.showMcpPage",
      title: "MCP servers",
      category: "Agent",
      description:
        "Opens Customize at MCP servers: the built-in tools and the agent's servers (state, tools, sign-in, sampling, restart, remove); New MCP server adds a custom or popular one.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => openCustomize(services, "mcp"),
    }),
  );

  // The page's rows (D205): New MCP server (custom, or one of the popular ones), a server's
  // actions, and the built-in tools.
  sub.add(
    dispatcher.register({
      id: "agent.newMcpServer",
      title: "New MCP server…",
      category: "Agent",
      description:
        "Adds an MCP server: a custom one (opens mcp.json to write it) or one of the popular servers (agent.installMcpServer).",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: async (_input, ctx) => {
        const installed = new Set(mergeServers(await clients.sources()).map((x) => x.name));
        const picked = await quickInput.pick(
          [
            {
              id: "",
              label: "Custom server…",
              description: "write it in mcp.json",
              icon: "file-json" as const,
            },
            {
              id: "\0registry",
              label: "Search the MCP registry…",
              description: "registry.modelcontextprotocol.io",
              icon: "search" as const,
            },
            ...MCP_GALLERY.map((e, i) => ({
              id: e.id,
              label: e.title,
              description: installed.has(e.id) ? "installed" : e.description,
              detail: e.kind === "remote" ? "remote" : `needs ${e.needs}`,
              disabled: installed.has(e.id),
              ...(i === 0 && { separator: "Popular" }),
            })),
          ],
          { placeholder: "Add an MCP server" },
        );
        if (!picked) return { added: false };
        if (!picked.id) return ctx.execute("agent.openMcpConfig", {});
        if (picked.id === "\0registry") {
          // D207: the registry, searched as you type (the built-in list when it's unreachable).
          let latest = 0;
          const hit = await quickInput.pickDynamic({
            placeholder: "Search the MCP registry (servers aren't checked by the IDE)",
            load: async (query) => {
              const mine = ++latest;
              await new Promise((r) => setTimeout(r, 300));
              if (mine !== latest) return { items: [] };
              const r = await searchRegistry(services, query);
              const theme = services.theme.theme.peek();
              // The rows on screen only, briefly: results mustn't wait on slow icon hosts.
              const images = await Promise.all(
                r.servers.map((e, i) => (i < 12 ? pickerImage(e.icons, theme, 400) : null)),
              );
              if (mine !== latest) return { items: [] };
              return {
                items: r.servers.map((e, i) => ({
                  id: e.id,
                  label: e.title,
                  icon: e.kind === "remote" ? ("globe" as const) : ("server" as const),
                  ...(images[i] && { image: images[i] }),
                  description: installed.has(e.id) ? "installed" : e.description,
                  detail:
                    "registryName" in e
                      ? `${e.registryName} · ${e.kind === "remote" ? "remote" : `needs ${e.needs}`}`
                      : `built in · ${e.kind === "remote" ? "remote" : `needs ${e.needs}`}`,
                  disabled: installed.has(e.id),
                })),
                ...(r.error
                  ? {
                      message: `The registry couldn't be searched (${r.error}): the built-in list.`,
                    }
                  : !r.servers.length
                    ? { message: "Nothing in the registry matches." }
                    : {}),
              };
            },
          });
          if (!hit) return { added: false };
          return ctx.execute("agent.installMcpServer", { id: hit.id });
        }
        return ctx.execute("agent.installMcpServer", { id: picked.id });
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.mcpServerActions",
      title: "MCP server actions…",
      category: "Agent",
      description:
        "What to do with one MCP server: sign in or out (remote ones), sampling (ask, allow, deny), restart, remove.",
      input: s.object({ server: s.string() }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: async ({ server }, ctx) => {
        const sv = await resolved(server);
        const url = await serverUrl(sv, clients.folderOfServer(sv) ?? "");
        const signed = url ? await mcpClientIpc.oauthStatus(sv.name, url).catch(() => null) : null;
        const sampling = samplingPolicy(
          services.settings.peek<unknown>("agent.mcp.sampling"),
          server,
        );
        const removable = sv.source.kind === "workspace" || sv.source.label === "user mcp.json";
        const items = [
          ...(url && !signed?.signedIn
            ? [{ id: "signIn", label: "Sign in", icon: "log-in" as const }]
            : []),
          ...(url && signed?.signedIn
            ? [{ id: "signOut", label: "Sign out", icon: "log-out" as const }]
            : []),
          { id: "configure", label: "Configure…", icon: "settings" as const },
          {
            id: "toggle",
            label: disabledServers(services).has(server) ? "Turn on" : "Turn off",
            icon: "ban" as const,
          },
          { id: "restart", label: "Restart", icon: "refresh-cw" as const },
          {
            id: "sampling",
            label: "Sampling…",
            description: sampling,
            detail: "May it ask the agent's model to write text for it?",
            icon: "sparkles" as const,
          },
          {
            id: "config",
            label: "Edit mcp.json",
            description: sv.source.label,
            icon: "file-json" as const,
          },
          ...(removable ? [{ id: "remove", label: "Remove", icon: "trash-2" as const }] : []),
        ];
        const picked = await quickInput.pick(items, { placeholder: sv.name });
        switch (picked?.id) {
          case "signIn":
            return ctx.execute("agent.mcpSignIn", { server });
          case "signOut":
            return ctx.execute("agent.mcpSignOut", { server });
          case "configure":
            return ctx.execute("agent.configureMcpServer", { server });
          case "toggle":
            return ctx.execute("agent.setMcpServerEnabled", {
              server,
              enabled: disabledServers(services).has(server),
            });
          case "restart":
            return ctx.execute("agent.mcpServers", { restart: server });
          case "config":
            return ctx.execute("agent.openMcpConfig", {});
          case "remove":
            return ctx.execute("agent.removeMcpServer", { name: server });
          case "sampling": {
            const policy = await quickInput.pick(
              [
                { id: "ask", label: "Ask each time" },
                { id: "allow", label: "Allow" },
                { id: "deny", label: "Deny" },
              ].map((x) => ({ ...x, description: x.id === sampling ? "current" : "" })),
              { placeholder: `Sampling for ${server}` },
            );
            return policy
              ? ctx.execute("agent.setMcpSampling", { server, policy: policy.id })
              : { changed: false };
          }
          default:
            return { done: false };
        }
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.builtinTools",
      title: "The agent's built-in tools",
      category: "Agent",
      description:
        "Lists the agent's own tools (files, search, terminal, git, browser, editor…), the IDE's built-in tool server.",
      input: s.empty(),
      effects: ["read"],
      agent: "hidden",
      run: async (_input, ctx) => {
        const tools = builtinTools(sessions);
        if (ctx.caller.kind === "user")
          await quickInput.pick(
            tools.map((x) => ({
              id: x.spec.name,
              label: x.spec.name,
              description: x.readOnly ? "reads" : "",
              detail: x.spec.description,
            })),
            { placeholder: `${product.nameShort}: ${tools.length} built-in tools` },
          );
        return { tools: tools.map((x) => ({ name: x.spec.name, readOnly: x.readOnly })) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.mcpGallery",
      title: "MCP server gallery",
      category: "Agent",
      description:
        "The built-in list of popular MCP servers (id, title, what it does, local or remote, what it needs), optionally matching `query`. Install one with agent.installMcpServer { id }.",
      input: s.object({ query: s.string().optional() }),
      effects: ["read"],
      agent: "discoverable",
      palette: false,
      run: ({ query }) => ({
        servers: (query ? searchGallery(query) : MCP_GALLERY).map((e) => ({
          id: e.id,
          title: e.title,
          description: e.description,
          kind: e.kind,
          ...(e.needs && { needs: e.needs }),
          ...(e.oauth && { signIn: true }),
        })),
      }),
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.installMcpServer",
      title: "Install an MCP server…",
      category: "Agent",
      description:
        "Installs a server from the gallery (agent.mcpGallery) or the MCP registry (agent.searchMcpRegistry; `registry` names one by its registry name): writes it into this folder's mcp.json (`scope` folder, the default with a folder open) or the user's mcp.json (`scope` user, every folder), with its inputs declared (keys are asked for in a hidden box when it starts). An agent's request asks the user first; a registry server shows what it runs before it's written.",
      input: s.object({
        id: s.string(),
        registry: s
          .string()
          .describe("The registry name (io.github.owner/server) when it wasn't searched for")
          .optional(),
        scope: s.enum(["folder", "user"] as const).optional(),
        name: s.string().describe("Name to give it (default the gallery id)").optional(),
        folder: s
          .string()
          .describe(
            "Multi-root workspaces, scope folder: the folder (path or name) to install it in",
          )
          .optional(),
      }),
      effects: ["write", "exec"],
      agent: "discoverable",
      run: async ({ id, scope, name, registry, folder }, ctx) => {
        const hit = registryHit(id) ?? (registry ? await lookUpRegistry(services, registry) : null);
        const entry = galleryEntry(id) ?? hit ?? undefined;
        if (!entry)
          throw new Error(
            `No gallery server ${id} (agent.mcpGallery and agent.searchMcpRegistry list them).`,
          );
        const runs =
          entry.config.url ?? [entry.config.command, ...(entry.config.args ?? [])].join(" ");
        // Registry entries aren't vetted: a person sees what it runs before it's written.
        if (
          hit &&
          !galleryEntry(id) &&
          ctx.caller.kind === "user" &&
          !(await confirmAction(
            `Install ${entry.title} from the MCP registry?`,
            `${hit.registryName}${entry.homepage ? ` (${entry.homepage})` : ""} runs: ${runs}.${entry.warnings?.length ? ` Note: it ${entry.warnings.join("; ")}.` : ""} It runs with your permissions; the IDE doesn't check registry servers.`,
            "Install",
          ))
        )
          return { installed: false };
        const root = workspace.root.peek();
        let where = scope ?? (root ? "folder" : "user");
        if (!scope && ctx.caller.kind === "user" && root) {
          const picked = await quickInput.pick(
            [
              { id: "folder", label: "This folder", description: "its mcp.json" },
              { id: "user", label: "Every folder", description: "your own mcp.json" },
            ],
            { placeholder: `Install ${entry.title} for…` },
          );
          if (!picked) return { installed: false };
          where = picked.id as "folder" | "user";
        }
        if (ctx.caller.kind !== "user" && ctx.caller.kind !== "test") {
          const session = sessions.find(undefined);
          if (!session) throw new Error("No agent chat to ask the user in.");
          const answer = await session.ask({
            title: `Install MCP server ${entry.title}?`,
            heading: `Install ${entry.title}?`,
            detail: `${entry.description}${entry.warnings?.length ? ` Note: it ${entry.warnings.join("; ")}.` : ""} It runs with your permissions.`,
            code: runs,
            kind: "tool",
            evenWithFullAccess: true,
          });
          if (answer === "deny") return { installed: false, reason: "The user declined." };
        }
        // D251: in a multi-root workspace, the folder given, the active editor's, or the one picked.
        const target =
          where === "folder" && root
            ? await pickWorkspaceFolder(services, folder, `Install ${entry.title} in which folder?`)
            : null;
        if (where === "folder" && root && !target) return { installed: false };
        const path =
          where === "folder"
            ? target
              ? await folderMcpFile(target)
              : null
            : userMcpPath(services);
        if (!path) throw new Error("Open a folder to install a server for it, or use scope user.");
        const { server, inputs } = galleryConfig(entry);
        const serverName = (name ?? entry.id).replace(/[^\w-]/g, "_");
        await writeServerEntry(path, serverName, server, inputs);
        // Installing approves it (a folder's server would ask before its first start).
        await clients.approveInstalled(serverName);
        await clients.stopAll();
        notifications.show(
          "info",
          `Installed ${entry.title}. It starts with the agent's next message${entry.oauth ? "; sign in on the MCP servers page" : ""}.`,
        );
        return { installed: true, name: serverName, file: path };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.removeMcpServer",
      title: "Remove an MCP server",
      category: "Agent",
      description:
        "Removes a server from the mcp.json it's configured in (this folder's or the user's) and signs out of it. Asks first when a person runs it.",
      input: s.object({ name: s.string() }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ name }, ctx) => {
        const sv = await resolved(name);
        const path =
          sv.source.kind === "workspace"
            ? clients.fileOfSource(sv.source)
            : sv.source.label === "user mcp.json"
              ? userMcpPath(services)
              : null;
        if (!path)
          throw new Error(
            `${name} comes from ${sv.source.label}: remove it there (Edit mcp.json, or the settings).`,
          );
        if (
          ctx.caller.kind === "user" &&
          !(await confirmAction(`Remove MCP server ${name}?`, `From ${sv.source.label}.`, "Remove"))
        )
          return { removed: false };
        await clients.stop([name]);
        const removed = await removeServerEntry(path, name);
        await mcpClientIpc.oauthSignOut(name).catch(() => {});
        return { removed };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.mcpSignIn",
      title: "Sign in to an MCP server",
      category: "Agent",
      description:
        "Signs in to a remote MCP server with OAuth (the MCP authorization spec: discovery, dynamic client registration, PKCE): the sign-in page opens in the browser and comes back to the IDE; the tokens stay in the OS keychain (or the IDE's secrets file without one), never shown, and are refreshed when they expire. Then the server restarts (unless `restart` is false). A server that refuses a call for lack of scope (403 insufficient_scope) leads here too, asking for the extra scopes.",
      input: s.object({
        server: s.string(),
        restart: s
          .boolean()
          .describe("Restart the server after (default true; a step-up retries its call instead)")
          .optional(),
      }),
      effects: ["network"],
      agent: "hidden",
      run: async ({ server, restart: again }) => {
        const sv = await resolved(server);
        const url = await serverUrl(sv, clients.folderOfServer(sv) ?? "");
        if (!url) throw new Error(`${server} isn't a remote server: nothing to sign in to.`);
        const oauth = (sv.config as { oauth?: { clientId?: unknown } }).oauth;
        const clientId = typeof oauth?.clientId === "string" ? oauth.clientId : undefined;
        const begun = await mcpClientIpc.oauthBegin(server, url, product.nameLong, clientId);
        // UI tests have no browser: the IDE visits the page itself (the mock signs in at once).
        const testing = !!(await appIpc.info().catch(() => null))?.testScript;
        if (!testing) {
          await openerIpc.openUrl(begun.authorizeUrl);
          notifications.show("info", `Finish signing in to ${server} in your browser.`);
        }
        const status = await mcpClientIpc.oauthFinish(begun.flow, testing);
        notifications.show("info", `Signed in to ${server}.`);
        if (again !== false) await restart(server);
        return { server, ...status };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.mcpSignOut",
      title: "Sign out of an MCP server",
      category: "Agent",
      description: "Forgets a remote MCP server's OAuth tokens; the next start asks to sign in.",
      input: s.object({ server: s.string() }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ server }) => {
        await mcpClientIpc.oauthSignOut(server);
        await clients.stop([server]);
        return { server, signedIn: false };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "agent.openMcpConfig",
      title: "Open mcp.json",
      category: "Agent",
      description:
        "Opens the mcp.json the agent's servers are added to: this folder's (.vscode/mcp.json or the IDE folder's), or the user's when no folder is open. In a multi-root workspace, `folder` (path or name) says which folder's; without it, the active editor's folder, else the user picks.",
      input: s.object({
        folder: s.string().describe("Multi-root workspaces: the folder (path or name)").optional(),
      }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: async ({ folder }, ctx) => {
        const root = workspace.root.peek()
          ? await pickWorkspaceFolder(services, folder, "Open which folder's mcp.json?")
          : null;
        if (workspace.root.peek() && !root) return null;
        const path = root ? await folderMcpFile(root) : userMcpPath(services);
        if (!path) throw new Error("No settings folder.");
        const exists = await fsIpc.stat(path).then(
          () => true,
          () => false,
        );
        if (!exists) await fsIpc.write(path, new TextEncoder().encode('{\n  "servers": {}\n}\n'));
        return ctx.execute("editor.openFile", { path });
      },
    }),
  );
}
