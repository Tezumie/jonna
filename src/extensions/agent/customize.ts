// The Customize page (D205, dock view `agent.customize`, like Cursor's): one tab for the
// agent's set-up pages instead of a tab each — Models and providers, Agents, Rules,
// Auto-approve, MCP servers, Docs. A search box and a row of chips pick the section; the
// section's own page (its DockViewDescriptor, no longer a tab type of its own) is shown below.
// Every way in (agent.showSetup, agent.showAgentConfig, agent.showRules, agent.showAutoApprove,
// agent.showMcpPage, agent.showDocs, agent.customize) opens this tab at its section.
import type { Json } from "../../core/dock/index";
import { h, on } from "../../core/dom/index";
import { Emitter } from "../../core/events/index";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { type IconName, icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type {
  DockView,
  DockViewContext,
  DockViewDescriptor,
  TabAction,
} from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";

export const CUSTOMIZE_VIEW = "agent.customize";

export interface CustomizeSection {
  id: string;
  label: string;
  icon: IconName;
  /** What it holds: shown as the chip's tooltip, searched by the box. */
  detail: string;
  /** More words the search box finds it by (provider names, "subagents"…). */
  keywords?: string;
  order: number;
  /** The page itself; only `create` is used. */
  page: Pick<DockViewDescriptor, "create">;
}

/** The sections, in order; extensions of the agent add theirs (registerCustomize). */
const sections = signal<CustomizeSection[]>([]);
let live: CustomizeView | null = null;

/** Adds a section (removed when the returned disposable is). */
export function addCustomizeSection(section: CustomizeSection): Disposable {
  sections.value = [...sections.peek().filter((x) => x.id !== section.id), section].sort(
    (a, b) => a.order - b.order,
  );
  return toDisposable(() => {
    sections.value = sections.peek().filter((x) => x !== section);
  });
}

/** The sections in their order (D409: the Chats view's right-click on Customize lists them). */
export function customizeSections(): readonly Pick<CustomizeSection, "id" | "label" | "icon">[] {
  return sections.peek();
}

/** Opens the Customize tab at `section` (the first one without). */
export function openCustomize(services: WorkbenchServices, section?: string): { tabId: string } {
  if (section && !sections.peek().some((x) => x.id === section))
    throw new Error(
      `No Customize section "${section}" (${sections
        .peek()
        .map((x) => x.id)
        .join(", ")}).`,
    );
  live?.show(section ?? null);
  const tabId = services.dock.openView(CUSTOMIZE_VIEW, section ? { section } : null, "main", true);
  return { tabId };
}

const stateSection = (state: Json | null): string | null =>
  state && typeof state === "object" && !Array.isArray(state) && typeof state.section === "string"
    ? state.section
    : null;

class CustomizeView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly query = signal("");
  private readonly current = signal<string | null>(null);
  private readonly chips: HTMLElement;
  private readonly body: HTMLElement;
  private readonly search: HTMLInputElement;
  private child: { id: string; view: DockView; store: DisposableStore } | null = null;
  private visible = false;

  constructor(
    state: Json | null,
    private readonly ctx: DockViewContext,
    services: WorkbenchServices,
  ) {
    // Agent settings › Customize (D270): the agent's other settings, on the settings page.
    const back = h(
      "button",
      { class: "ae-crumb-link", type: "button", "data-command": "settings.open" },
      "Agent settings",
    );
    setTooltip(back, "The agent's other settings: modes, approvals, tools…");
    this.store.add(
      on(back, "click", () => {
        void services.dispatcher.execute("settings.open", { category: "Agent" }).catch(() => {});
      }),
    );
    const crumbs = h(
      "nav",
      { class: "ae-crumbs customize-crumbs", "aria-label": "Breadcrumb" },
      back,
      h("span", { class: "ae-crumb-sep", "aria-hidden": "true" }, icon("chevron-right")),
      h("span", { class: "ae-crumb-here", "aria-current": "page" }, "Customize"),
    );
    this.search = h("input", {
      class: "input customize-search-input",
      type: "search",
      placeholder: "Search models, agents, rules, MCP servers, docs…",
      "aria-label": "Search Customize",
      spellcheck: "false",
    }) as HTMLInputElement;
    this.chips = h("div", { class: "segmented customize-chips", role: "tablist" });
    this.body = h("div", { class: "customize-body" });
    this.element = h(
      "div",
      { class: "customize", tabindex: "-1" },
      h(
        "div",
        { class: "customize-top" },
        crumbs,
        h("div", { class: "customize-search" }, icon("search"), this.search),
        this.chips,
      ),
      this.body,
    );
    this.store.add(this.changed);
    this.current.value = stateSection(state);
    this.store.add(
      on(this.search, "input", () => {
        this.query.value = this.search.value;
      }),
    );
    this.store.add(
      on(this.search, "keydown", (e) => {
        if (e.key !== "Enter") return;
        const first = this.matching()[0];
        if (first) this.show(first.id);
      }),
    );
    this.store.add(
      effect(() => {
        this.renderChips(sections.value, this.query.value, this.current.value);
        return undefined;
      }),
    );
    // A section that arrives later (or goes) shows up without reopening.
    this.store.add(
      effect(() => {
        const list = sections.value;
        const want = this.current.value;
        if (!list.length) return undefined;
        const id = want && list.some((x) => x.id === want) ? want : (list[0]?.id ?? null);
        if (id && this.child?.id !== id) queueMicrotask(() => this.mount(id));
        return undefined;
      }),
    );
    live = this;
  }

  private matching(): CustomizeSection[] {
    const q = this.query.peek().trim().toLowerCase();
    const list = sections.peek();
    if (!q) return list;
    return list.filter((x) =>
      `${x.label} ${x.detail} ${x.keywords ?? ""} ${x.id}`.toLowerCase().includes(q),
    );
  }

  private renderChips(list: CustomizeSection[], query: string, current: string | null): void {
    const q = query.trim().toLowerCase();
    const active = this.child?.id ?? current;
    const none = !!q && !this.matching().length;
    this.chips.replaceChildren(
      // Every chip hidden by the search: say so rather than an empty row.
      ...(none
        ? [h("span", { class: "customize-none" }, `No section matches “${query.trim()}”`)]
        : []),
      ...list.map((x) => {
        const hit =
          !q || `${x.label} ${x.detail} ${x.keywords ?? ""} ${x.id}`.toLowerCase().includes(q);
        const chip = h(
          "button",
          {
            class: `segment customize-chip${x.id === active ? " is-active is-selected" : ""}`,
            type: "button",
            role: "tab",
            "aria-selected": String(x.id === active),
            "data-section": x.id,
            title: x.detail,
          },
          icon(x.icon),
          h("span", null, x.label),
        );
        chip.hidden = !hit;
        chip.addEventListener("click", () => this.show(x.id));
        return chip;
      }),
    );
  }

  /** Switches to `id` (null: keep the current one, or the first). */
  show(id: string | null): void {
    if (id === null) return;
    this.current.value = id;
    this.ctx.updateState({ section: id });
    this.mount(id);
  }

  private mount(id: string): void {
    if (this.store.isDisposed || this.child?.id === id) return;
    const section = sections.peek().find((x) => x.id === id);
    if (!section) return;
    this.unmount();
    const store = new DisposableStore();
    const ctx: DockViewContext = {
      tabId: this.ctx.tabId,
      updateState: () => {},
      close: () => this.ctx.close(),
      pin: () => this.ctx.pin(),
      flash: () => this.ctx.flash(),
    };
    const view = section.page.create(null, ctx);
    store.add(view);
    if (view.onDidChange) store.add(view.onDidChange(() => this.changed.fire()));
    this.child = { id, view, store };
    this.body.replaceChildren(view.element);
    this.body.dataset.section = id;
    if (this.visible) view.onShow?.();
    this.renderChips(sections.peek(), this.query.peek(), id);
    this.changed.fire();
  }

  private unmount(): void {
    if (!this.child) return;
    if (this.visible) this.child.view.onHide?.();
    this.child.store.dispose();
    this.child = null;
    this.body.replaceChildren();
  }

  update(state: Json): void {
    const id = stateSection(state);
    if (id) this.show(id);
  }

  title(): string {
    return "Customize";
  }

  actions(): TabAction[] {
    return this.child?.view.actions?.() ?? [];
  }

  onShow(): void {
    this.visible = true;
    this.child?.view.onShow?.();
  }

  onHide(): void {
    this.visible = false;
    this.child?.view.onHide?.();
  }

  onResize(): void {
    this.child?.view.onResize?.();
  }

  onWindowChanged(win: Window): void {
    this.child?.view.onWindowChanged?.(win);
  }

  focus(): void {
    if (this.child?.view.focus) this.child.view.focus();
    else this.element.focus();
  }

  serialize(): Json {
    const id = this.child?.id ?? this.current.peek();
    return id ? { section: id } : null;
  }

  dispose(): void {
    if (live === this) live = null;
    this.unmount();
    this.store.dispose();
  }
}

export function registerCustomize(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, dock } = services;
  sub.add(
    dock.views.register({
      type: CUSTOMIZE_VIEW,
      title: () => "Customize",
      icon: () => "sliders-horizontal",
      singleton: true,
      defaultPlacement: "main",
      editorLike: true,
      create: (state, ctx) => new CustomizeView(state, ctx, services),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.customize",
      title: "Customize…",
      category: "Agent",
      description:
        "Opens the Customize tab: the agent's models and providers, agents and subagents, rules, skills, slash commands, auto-approve, MCP servers and docs, one section at a time. `section` picks one: models, agents, rules, skills, commands, autoApprove, mcp, docs.",
      input: s.object({
        section: s
          .string()
          .describe("models, agents, rules, skills, commands, autoApprove, mcp or docs")
          .optional(),
      }),
      effects: [],
      agent: "hidden",
      run: ({ section }) => openCustomize(services, section),
    }),
  );
}
