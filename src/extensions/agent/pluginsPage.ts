// Customize → Plugins (D358): Claude Code plugins. The installed ones first (each with what it
// brings and a ⋯ to enable, disable, let its hooks or MCP servers run, or uninstall), then each
// marketplace added with its plugins and an Install button; "Add marketplace" in the header.
// Every button runs a command (plugins.ts); `agent.showPlugins` opens the page.
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { icon } from "../../ui/Icon";
import type { DockView } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { addCustomizeSection, openCustomize } from "./customize";
import type { PluginContents, PluginService } from "./plugins";
import { addButton, emptyNote, pageGroup, pageHeader, runCommand } from "./view/pageKit";

function summary(c: PluginContents | { error: string } | undefined): string {
  if (!c) return "";
  if ("error" in c) return c.error;
  const parts = [
    c.commands.length && `${c.commands.length} command${c.commands.length === 1 ? "" : "s"}`,
    c.skills.length && `${c.skills.length} skill${c.skills.length === 1 ? "" : "s"}`,
    c.agents.length && `${c.agents.length} subagent${c.agents.length === 1 ? "" : "s"}`,
    c.hooks.length && `${c.hooks.length} hook${c.hooks.length === 1 ? "" : "s"}`,
    c.mcpServers.length &&
      `${c.mcpServers.length} MCP server${c.mcpServers.length === 1 ? "" : "s"}`,
    c.outputStyles.length &&
      `${c.outputStyles.length} output style${c.outputStyles.length === 1 ? "" : "s"}`,
    c.lspServers.length &&
      `${c.lspServers.length} language server${c.lspServers.length === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return parts.join(" · ");
}

class PluginsView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly render = this.store.add(new DisposableStore());
  private readonly body: HTMLElement;

  constructor(
    private readonly services: WorkbenchServices,
    private readonly plugins: PluginService,
  ) {
    this.body = h("div", { class: "ai-setup plugins-page" });
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.body);
    this.store.add(
      effect(() => {
        plugins.version.value;
        this.draw();
        return undefined;
      }),
    );
  }

  private run(command: string, input: unknown = {}): void {
    void runCommand(this.services, command, input);
  }

  private more(
    label: string,
    items: { id: string; label: string; run: () => void }[],
  ): HTMLElement {
    const button = h(
      "button",
      { class: "icon-button mcp-row-more", type: "button", "aria-label": label },
      icon("ellipsis"),
    );
    this.render.add(
      on(button, "click", (e) => {
        e.stopPropagation();
        void this.services.quickInput
          .pick(
            items.map(({ id, label: l }) => ({ id, label: l })),
            { placeholder: label },
          )
          .then((picked) => items.find((i) => i.id === picked?.id)?.run());
      }),
    );
    return button;
  }

  private row(
    attrs: Record<string, string>,
    title: string,
    detail: string,
    ...end: HTMLElement[]
  ): HTMLElement {
    return h(
      "div",
      { class: "mcp-row", ...attrs },
      h("span", { class: "mcp-row-icon" }, icon("puzzle")),
      h(
        "span",
        { class: "mcp-row-main" },
        h("span", { class: "mcp-row-title" }, h("span", { class: "mcp-row-name" }, title)),
        h("span", { class: "mcp-row-detail" }, detail),
      ),
      ...end,
    );
  }

  private group(
    title: string,
    count: number,
    attrs: Record<string, string>,
    head: HTMLElement[],
    rows: HTMLElement[],
    empty: string,
  ): HTMLElement {
    return pageGroup(
      title,
      count,
      head,
      [rows.length ? h("div", { class: "mcp-list" }, ...rows) : emptyNote(empty)],
      attrs,
    );
  }

  private draw(): void {
    this.render.clear();
    const st = this.render;
    const add = addButton(st, "Add marketplace", () => this.run("agent.addPluginMarketplace"), {
      "data-action": "add-marketplace",
    });

    /** A plugin's row: what it brings, what's on, and its menu (switches, then `extra`). */
    const pluginRow = (
      p: { id: string; enabled: boolean; hooks: boolean; mcp: boolean; lsp: boolean },
      description: string,
      extra: { id: string; label: string; run: () => void }[],
      note?: string,
    ) => {
      const c = this.plugins.contentsOf(p.id);
      const has = (k: "hooks" | "mcpServers" | "lspServers") =>
        !!c && !("error" in c) && c[k].length > 0;
      const flags = [
        !p.enabled && "off",
        has("hooks") && (p.hooks ? "hooks on" : "hooks off"),
        has("mcpServers") && (p.mcp ? "MCP on" : "MCP off"),
        has("lspServers") && (p.lsp ? "language servers on" : "language servers off"),
        note,
      ].filter(Boolean);
      const set = (input: Record<string, boolean>) => () =>
        this.run("agent.setPluginEnabled", { plugin: p.id, ...input });
      return this.row(
        { "data-plugin": p.id, ...(p.enabled ? {} : { "data-disabled": "true" }) },
        p.id,
        [summary(c) || description, flags.join(", ")].filter(Boolean).join(" — "),
        this.more(`More for ${p.id}`, [
          {
            id: "toggle",
            label: p.enabled ? "Disable" : "Enable",
            run: set({ enabled: !p.enabled }),
          },
          ...(has("hooks")
            ? [
                {
                  id: "hooks",
                  label: p.hooks ? "Stop its hooks" : "Let its hooks run",
                  run: set({ hooks: !p.hooks }),
                },
              ]
            : []),
          ...(has("mcpServers")
            ? [
                {
                  id: "mcp",
                  label: p.mcp ? "Stop its MCP servers" : "Let its MCP servers start",
                  run: set({ mcp: !p.mcp }),
                },
              ]
            : []),
          ...(has("lspServers")
            ? [
                {
                  id: "lsp",
                  label: p.lsp ? "Stop its language servers" : "Let its language servers start",
                  run: set({ lsp: !p.lsp }),
                },
              ]
            : []),
          ...extra,
        ]),
      );
    };
    const installed = this.plugins.installed().map((p) =>
      pluginRow({ ...p, lsp: p.lsp === true }, p.description ?? "", [
        {
          id: "uninstall",
          label: "Uninstall",
          run: () => this.run("agent.uninstallPlugin", { plugin: p.id }),
        },
      ]),
    );
    // Installed by Claude Code (D375): used in place; switched here for the IDE only.
    const described = this.plugins.describe() as {
      claudeCode: {
        id: string;
        enabled: boolean;
        enabledInClaudeCode: boolean;
        hooks: boolean;
        mcp: boolean;
        lsp: boolean;
      }[];
    };
    const fromClaude = described.claudeCode.map((p) =>
      pluginRow(p, "", [], p.enabledInClaudeCode ? undefined : "off in Claude Code"),
    );

    const markets = this.plugins.marketplaces().map((m) => {
      const cat = this.plugins.catalog(m.name);
      const rows =
        cat && !("error" in cat)
          ? cat.plugins.map((p) => {
              const id = `${p.name}@${m.name}`;
              const has =
                this.plugins.installed().some((x) => x.id === id) ||
                this.plugins.claudePlugins().some((x) => x.id === id);
              const end: HTMLElement[] = [];
              if (has) end.push(h("span", { class: "mcp-row-detail" }, "Installed"));
              else {
                const install = h(
                  "button",
                  {
                    class: "button button-secondary button-sm",
                    type: "button",
                    "data-install": id,
                  },
                  "Install",
                );
                st.add(on(install, "click", () => this.run("agent.installPlugin", { plugin: id })));
                end.push(install);
              }
              return this.row({ "data-available": id }, p.name, p.description ?? "", ...end);
            })
          : [];
      const source = m.source.kind === "git" ? m.source.url : m.source.path;
      // Claude Code's own (D375): it keeps it up to date; nothing to update or remove here.
      const isClaude = this.plugins.isClaudeMarketplace(m.name);
      return this.group(
        isClaude ? `${m.name} (Claude Code)` : m.name,
        rows.length,
        { "data-marketplace": m.name, title: source },
        isClaude
          ? []
          : [
              this.more(`More for ${m.name}`, [
                {
                  id: "update",
                  label: "Update",
                  run: () => this.run("agent.updatePluginMarketplace", { name: m.name }),
                },
                {
                  id: "remove",
                  label: "Remove",
                  run: () => this.run("agent.removePluginMarketplace", { name: m.name }),
                },
              ]),
            ],
        rows,
        cat && "error" in cat ? cat.error : "No plugins listed.",
      );
    });

    this.body.replaceChildren(
      pageHeader("Plugins", null),
      this.group(
        "Installed",
        installed.length,
        { "data-scope": "installed" },
        [add],
        installed,
        "None yet. Add a marketplace, then install what you trust.",
      ),
      ...(fromClaude.length
        ? [
            this.group(
              "From Claude Code",
              fromClaude.length,
              { "data-scope": "claude-code" },
              [],
              fromClaude,
              "",
            ),
          ]
        : []),
      ...(markets.length
        ? markets
        : [
            h(
              "p",
              { class: "mcp-config-note" },
              "No marketplaces yet: add one (GitHub owner/repo, a git URL or a folder), or type /plugin marketplace add in the chat.",
            ),
          ]),
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

export function registerPluginsPage(
  sub: DisposableStore,
  services: WorkbenchServices,
  plugins: PluginService,
): void {
  sub.add(
    addCustomizeSection({
      id: "plugins",
      label: "Plugins",
      icon: "puzzle",
      detail:
        "Claude Code plugins from marketplaces: commands, skills, subagents, hooks, MCP servers",
      keywords: "plugin marketplace claude install",
      order: 38,
      page: { create: () => new PluginsView(services, plugins) },
    }),
  );
  sub.add(
    services.dispatcher.register({
      category: "Agent",
      id: "agent.showPlugins",
      title: "Plugins…",
      description:
        "Opens Customize at Plugins (D358): the installed Claude Code plugins and the marketplaces added, to install, enable or remove one.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => {
        void plugins.reload();
        return openCustomize(services, "plugins");
      },
    }),
  );
}
