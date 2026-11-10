// The ACP registry's agents as a gallery of cards (D215) under "Use an agent you already have" on
// the Models page: icon, name, version, license and description, with Install / Use / Update /
// Remove / Details (repository, website, license, authors, how it's distributed). A search box
// filters by name. Opening it fetches the registry once per window (the bundled or cached list
// shows meanwhile). The page shows it behind "View more agents" (D216). Every button runs a command (agent.registry.*, agent.selectModel…).
import type { RegistryAgent } from "../../../core/acp/registry";
import { filterAgents } from "../../../core/acp/registry";
import { h, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { effect, signal } from "../../../core/reactive/index";
import { type IconName, icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { WorkbenchServices } from "../../../workbench/services";
import { type AcpRegistryState, formatBytes, host } from "../acpRegistry";

export interface GalleryDeps {
  services: WorkbenchServices;
  registry: AcpRegistryState;
  /** A built-in preset's program found (true), missing (false) or not looked up yet. */
  presetFound: (preset: string) => boolean | undefined;
  /** The chat Use applies to. */
  session?: () => string | undefined;
}

export class AgentGallery implements Disposable {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly query = signal("");
  private readonly search: HTMLInputElement;
  private readonly status: HTMLElement;
  private readonly grid: HTMLElement;

  constructor(private readonly deps: GalleryDeps) {
    const { registry } = deps;
    this.search = h("input", {
      class: "input acp-gallery-search",
      type: "search",
      placeholder: "Search agents",
      "aria-label": "Search agents",
      spellcheck: "false",
    }) as HTMLInputElement;
    this.status = h("span", { class: "acp-gallery-status" });
    const refresh = h(
      "button",
      { class: "button button-ghost button-sm acp-gallery-refresh", type: "button" },
      icon("refresh-cw"),
      "Refresh",
    );
    setTooltip(refresh, "Fetch the ACP agent registry again");
    this.grid = h("div", { class: "acp-gallery-grid", role: "list" });
    this.element = h(
      "div",
      { class: "acp-gallery" },
      h(
        "div",
        { class: "acp-gallery-top" },
        h("div", { class: "acp-gallery-search-box" }, icon("search"), this.search),
        refresh,
      ),
      this.status,
      this.grid,
    );
    this.store.add(on(refresh, "click", () => void this.run("agent.registry.refresh")));
    this.store.add(
      on(this.search, "input", () => {
        this.query.value = this.search.value;
      }),
    );
    this.store.add(
      effect(() => {
        this.renderStatus();
        return undefined;
      }),
    );
    this.store.add(
      effect(() => {
        this.renderGrid();
        return undefined;
      }),
    );
    // agent.registry.browse: once the page has put the gallery on screen, its search box.
    this.store.add(
      effect(() => {
        if (!registry.focusSearch.value) return undefined;
        let tries = 0;
        // After the tab has been shown and focused (it puts its own focus and scroll back first).
        const timer = setInterval(() => {
          if ((++tries < 6 || !this.search.isConnected) && tries < 40) return;
          clearInterval(timer);
          registry.focusSearch.value = false;
          if (!this.search.isConnected) return;
          this.search.scrollIntoView({ block: "start" });
          this.search.focus();
        }, 50);
        return () => clearInterval(timer);
      }),
    );
    void registry.load();
  }

  private opened = false;

  /** The page showed the gallery (View more agents): look for programs and fetch the list. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    const { registry } = this.deps;
    void registry.detect();
    // Opening the list is when it's fetched (once per window; Refresh fetches again).
    void registry.refreshOnce().then(() => registry.detect(true));
  }

  /** Re-renders what reads settings or found programs (the page calls this on its changes). */
  update(): void {
    this.renderGrid();
  }

  private run(command: string, input: unknown = {}): Promise<unknown> {
    return this.deps.services.dispatcher.execute(command, input).catch((err: unknown) => {
      this.deps.services.notifications.show(
        "error",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    });
  }

  private renderStatus(): void {
    const r = this.deps.registry;
    const source = r.source.value;
    const error = r.error.value;
    const count = r.agents.value.length;
    const text = r.refreshing.value
      ? "Checking the ACP registry…"
      : source === "registry"
        ? `${count} agents from the ACP registry, updated just now.`
        : `${count} agents from the ACP registry (${source === "cached" ? "the copy from last time" : "the list built in"})${error ? `: couldn't reach it (${error.split("\n")[0]?.slice(0, 120)})` : ""}.`;
    this.status.textContent = text;
    this.status.classList.toggle("is-error", !!error && !r.refreshing.value);
  }

  private renderGrid(): void {
    const r = this.deps.registry;
    // Read for the effect: these change what the cards say.
    r.installing.value;
    r.installedVersion.value;
    r.expanded.value;
    r.runtimes.value;
    r.onPath.value;
    r.platform.value;
    this.deps.services.settings.version.value;
    const agents = filterAgents(r.agents.value, this.query.value);
    const cards = agents.map((a) => this.card(a));
    this.grid.replaceChildren(
      ...(cards.length
        ? cards
        : [h("p", { class: "acp-gallery-empty" }, `No agent matches "${this.query.peek()}".`)]),
    );
  }

  private button(
    label: string,
    glyph: IconName | null,
    click: () => unknown,
    primary = false,
  ): HTMLElement {
    const el = h(
      "button",
      {
        class: `button ${primary ? "button-primary" : "button-secondary"} button-sm`,
        type: "button",
      },
      glyph ? icon(glyph) : null,
      label,
    );
    on(el, "click", () => void click());
    return el;
  }

  private card(agent: RegistryAgent): HTMLElement {
    const { registry, session } = this.deps;
    const d = registry.describe(agent);
    const use = (name: string) =>
      this.button("Use", "agent", () =>
        this.run("agent.selectModel", {
          model: `acp/${name}`,
          ...(session?.() && { session: session() }),
        }),
      );
    const actions: (HTMLElement | null)[] = [];
    let state = "";
    if (d.progress) {
      const { phase, received, total } = d.progress;
      state =
        phase === "download"
          ? `Downloading ${formatBytes(received)}${total ? ` of ${formatBytes(total)}` : ""}…`
          : phase === "verify"
            ? "Checking the download…"
            : "Unpacking…";
      actions.push(
        this.button("Cancel", "x", () =>
          this.run("agent.registry.cancelInstall", { id: agent.id }),
        ),
      );
    } else if (d.preset) {
      const found = this.deps.presetFound(d.preset);
      state = found === true ? "Installed · built in" : "Built in";
      actions.push(
        found === true
          ? use(d.preset)
          : found === false
            ? this.button(
                "Install",
                "download",
                () => this.run("agent.installAgent", { name: d.preset }),
                true,
              )
            : null,
      );
    } else if (d.installed) {
      const i = d.installed;
      state =
        i.kind === "binary"
          ? `Installed ${i.version}${i.verified ? " · checksum verified" : " · not checksum-verified"}`
          : i.kind === "path"
            ? `Uses ${i.command} on your PATH`
            : `Installed · runs with ${i.kind}`;
      actions.push(use(i.name));
      if (d.update)
        actions.push(
          this.button(`Update to ${agent.version}`, "download", () =>
            this.run("agent.registry.install", { id: agent.id, from: "download" }),
          ),
        );
      actions.push(
        this.button("Remove", "trash-2", () =>
          this.run("agent.registry.uninstall", { id: agent.id }),
        ),
      );
    } else if (!d.choice && !d.onPath) {
      state = `Not available for this computer${registry.platform.value ? ` (${registry.platform.value})` : ""}`;
    } else {
      state = d.onPath
        ? `Found ${d.onPath} on your PATH`
        : d.needs
          ? `Needs ${d.needs}`
          : d.choice?.kind === "binary"
            ? d.choice.target.sha256
              ? `Download from ${host(d.choice.target.archive)} · checksum verified`
              : `Download from ${host(d.choice.target.archive)} · not checksum-verified`
            : `Runs with ${d.choice?.kind ?? ""}`;
      const install = this.button(
        "Install",
        "download",
        () => this.run("agent.registry.install", { id: agent.id }),
        true,
      );
      if (d.needs)
        setTooltip(
          install,
          d.needs === "Node.js"
            ? "Needs Node.js (npx): install it from nodejs.org first"
            : "Needs uv (uvx): install it first",
        );
      actions.push(install);
    }
    const open = registry.expanded.value.has(agent.id);
    const details = this.button(open ? "Hide details" : "Details", "info", () =>
      this.run("agent.registry.details", { id: agent.id }),
    );
    details.setAttribute("aria-expanded", String(open));
    actions.push(details);
    const installedTag = d.installed || (d.preset && this.deps.presetFound(d.preset) === true);
    return h(
      "div",
      {
        class: { "acp-card": true, "is-installed": !!installedTag, "is-open": open },
        role: "listitem",
        "data-agent-id": agent.id,
      },
      h(
        "div",
        { class: "acp-card-head" },
        agentIcon(agent),
        h(
          "div",
          { class: "acp-card-title" },
          h("span", { class: "acp-card-name" }, agent.name),
          h("span", { class: "acp-card-meta" }, `${agent.version} · ${agent.license}`),
        ),
      ),
      agent.description ? h("p", { class: "acp-card-desc" }, agent.description) : null,
      h("span", { class: "acp-card-state" }, state),
      d.progress
        ? h(
            "progress",
            {
              class: "acp-card-progress",
              max: String(d.progress.total ?? 1),
              ...(d.progress.total && { value: String(d.progress.received) }),
              "aria-label": `Installing ${agent.name}`,
            },
            null,
          )
        : null,
      h("div", { class: "acp-card-actions" }, ...actions),
      open ? this.details(agent) : null,
    );
  }

  private link(label: string, url: string): HTMLElement {
    const el = h("button", { class: "ai-link acp-card-link", type: "button" }, label);
    setTooltip(el, url);
    on(el, "click", () => void this.run("agent.openLink", { url }));
    return el;
  }

  private details(agent: RegistryAgent): HTMLElement {
    const platform = this.deps.registry.platform.value;
    const target = platform ? agent.distribution.binary?.[platform] : undefined;
    const ways: string[] = [];
    if (agent.distribution.binary)
      ways.push(
        target
          ? `Binary for ${platform}: ${host(target.archive)}, runs ${target.cmd} ${target.args.join(" ")} (${target.sha256 ? "SHA-256 listed" : "no SHA-256"})`
          : `Binary for ${Object.keys(agent.distribution.binary).join(", ")}`,
      );
    if (agent.distribution.npx) ways.push(`npx ${agent.distribution.npx.package}`);
    if (agent.distribution.uvx) ways.push(`uvx ${agent.distribution.uvx.package}`);
    const row = (label: string, ...value: (HTMLElement | string | null)[]) =>
      h("div", { class: "acp-card-detail" }, h("dt", null, label), h("dd", null, ...value));
    return h(
      "dl",
      { class: "acp-card-details" },
      agent.repository
        ? row("Repository", this.link(host(agent.repository), agent.repository))
        : null,
      agent.website ? row("Website", this.link(host(agent.website), agent.website)) : null,
      row("License", agent.licenseUrl ? this.link(agent.license, agent.licenseUrl) : agent.license),
      agent.authors.length ? row("Authors", agent.authors.join(", ")) : null,
      row("Distribution", ways.join(" · ")),
      row("Id", agent.id),
    );
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** The agent's icon: one-color SVGs as a mask in the text color (reads in light and dark). */
export function agentIcon(agent: Pick<RegistryAgent, "name" | "icon">): HTMLElement {
  const box = h("span", { class: "acp-icon", "aria-hidden": "true" });
  if (agent.icon?.mono) {
    const mask = h("span", { class: "acp-icon-mask" });
    mask.style.setProperty("--logo", `url("${agent.icon.src}")`);
    box.append(mask);
  } else if (agent.icon) box.append(h("img", { src: agent.icon.src, alt: "", draggable: "false" }));
  else box.append(agent.name.slice(0, 1).toUpperCase());
  return box;
}
