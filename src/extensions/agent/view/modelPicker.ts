// The model picker (D227, like T3 Chat's): a rail of the providers and agents the user has added
// (logo, name in the tooltip), Favorites and Recent first; beside it a search box and the chosen
// tab's models, each with a star. Typing searches every provider. Picking runs agent.selectModel
// (which keeps the Recent list); the star runs agent.toggleFavoriteModel. D288: the same picker sets
// any model chip's model (an agent's, a subagent's, an AI feature's): `showModelChooser` with a
// target, whose pick runs agent.chooseModel (an external agent's own model too).
import type { AcpSetting } from "../../../core/acp/client";
import type { RegistryIcon } from "../../../core/acp/registry";
import { h, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import type { WorkbenchServices } from "../../../workbench/services";
import { cachedSettings } from "../acp";
import { type ExternalAgentConfig, externalAgents } from "../acpAgents";
import { AGENT_SETUP } from "../catalog";
import { chatModelKey } from "../chatAgentModel";
import { memberInfo } from "../groupChat";
import { agentPickKey, parsePick, pickList, priceLabel, withRecent } from "../modelPicks";
import { describeModel, OLLAMA_ID, type ProviderRegistry } from "../providers";
import type { AgentSession } from "../session";
import { agentExternalModel } from "../subagents";
import { priceOf } from "../usage";
import { agentMark, providerMark } from "./brandMark";

/** What a picker opened from a model chip sets (D288), not a chat's model. */
export interface ModelTarget {
  /** Said beside the heading: "sets Plato's model". */
  title: string;
  /** Its model key now ("acp/<agent>" for an external agent); null: the inherited one. */
  current: string | null;
  /**
   * With `current` an external agent: the model of it this target uses (D288: one of your
   * agents' own); unset: the one remembered for the external agent.
   */
  agentModel?: string | undefined;
  /** An external agent's own model is this target's, not the external agent's for everyone. */
  ownAgentModel?: boolean;
  /** The first row, for "no model of its own" ("Same as the chat"); absent: none. */
  inherit?: { label: string; detail?: string };
  /** External agents can be picked. */
  agents: boolean;
  /** A pick key (modelPicks.ts), or null for the inherited one. */
  pick(key: string | null): void;
}

export interface ModelPickerDeps {
  services: WorkbenchServices;
  registry: ProviderRegistry;
  /** The chat it picks for (and whose external agent reports its models live). */
  session?: AgentSession;
  target?: ModelTarget;
  /** Which agent programs are installed (null: not looked yet). */
  installed: ReadonlyMap<string, boolean> | null;
  /** An ACP registry agent's icon, by registry id. */
  registryIcon?: (id: string) => RegistryIcon | undefined;
  /** A chat with this agent of the user's: a pick sets its model, not the chat's (D242). */
  agent?: string | null;
}

interface Row {
  /** The pick key (modelPicks.ts): what the star saves. */
  key: string;
  label: string;
  detail?: string;
  /** Where it's from, shown in Favorites and search results. */
  source: string;
  mark: () => HTMLElement;
  current: boolean;
}

interface Tab {
  id: string;
  name: string;
  mark: () => HTMLElement;
  rows: Row[];
  /** Shown instead of (or above) rows: a provider that isn't reachable, an agent not started. */
  note?: { text: string; action?: { label: string; run(): void } };
}

/** The open picker (one at a time) and the button that opened it. */
let open: { anchor: HTMLElement; close(): void } | null = null;

/** Opens the picker above (or below) `anchor`; a second press on the anchor closes it. */
export function showModelPicker(anchor: HTMLElement, deps: ModelPickerDeps): Disposable {
  if (open?.anchor === anchor) {
    open.close();
    return toDisposable(() => {});
  }
  open?.close();
  const picker = new ModelPicker(anchor, deps);
  const close = () => picker.dispose();
  open = { anchor, close };
  picker.onClose = () => {
    if (open?.close === close) open = null;
  };
  return toDisposable(close);
}

/**
 * What a model chip's picker needs from the agent extension (set once by index.ts, so a page
 * doesn't carry it): the providers, which agent programs are installed, the registry's icons.
 */
export const chooserContext: {
  registry: ProviderRegistry | null;
  installed: () => ReadonlyMap<string, boolean> | null;
  registryIcon?: (id: string) => RegistryIcon | undefined;
} = { registry: null, installed: () => null };

/** The key of the "same as ..." row (not a model key). */
const INHERIT = "=inherit";

/**
 * A model chip's picker (D288): the chat's picker for `for` (agent.chooseModel's target: main,
 * subagent:<name>, feature:<id>...). An external agent's own model is remembered for that agent
 * (agent.externalAgentChoices, one per external agent) and the target set to the agent.
 * Falls back to agent.chooseModel's list before the agent extension has set the context.
 */
export function showModelChooser(
  anchor: HTMLElement,
  services: WorkbenchServices,
  target: Omit<ModelTarget, "pick"> & {
    for: string;
    /** Writes the pick instead of agent.chooseModel (a setting's own value, D288). */
    set?: (model: string) => Promise<unknown>;
  },
): Disposable {
  const registry = chooserContext.registry;
  const run = (command: string, input: unknown) =>
    services.dispatcher.execute(command, input).then(
      () => true,
      (err: unknown) => {
        services.notifications.show("error", err instanceof Error ? err.message : String(err));
        return false;
      },
    );
  if (!registry) {
    if (!target.set) void run("agent.chooseModel", { for: target.for });
    return toDisposable(() => {});
  }
  void registry.refreshIfStale(30_000, 0);
  const set = target.set;
  const pick = async (key: string | null) => {
    if (key === null) {
      if (set) await set("");
      else await run("agent.chooseModel", { for: target.for, model: "" });
      return;
    }
    const { model, agentModel } = parsePick(key);
    if (set) {
      // An external agent's own model is the one remembered for it (a setting holds acp/<name>).
      if (
        agentModel !== undefined &&
        !(await run("agent.chooseModel", { for: `external:${model.slice(4)}`, model: agentModel }))
      )
        return;
      await set(model);
    } else if (target.ownAgentModel && target.for.startsWith("subagent:")) {
      // One of your agents (D288): Claude Code · Sonnet is its own, the main agent keeps Opus.
      const name = target.for.slice("subagent:".length);
      if (!(await run("agent.setSubagent", { name, model, agentModel: agentModel ?? "" }))) return;
    } else {
      if (
        agentModel !== undefined &&
        !(await run("agent.chooseModel", { for: `external:${model.slice(4)}`, model: agentModel }))
      )
        return;
      if (!(await run("agent.chooseModel", { for: target.for, model }))) return;
    }
    // Recent, as the chat's picks are.
    const recent = withRecent(services.settings.peek("agent.recentModels"), key);
    await services.settings.update("agent.recentModels", recent, "user").catch(() => {});
  };
  return showModelPicker(anchor, {
    services,
    registry,
    installed: chooserContext.installed(),
    ...(chooserContext.registryIcon && { registryIcon: chooserContext.registryIcon }),
    target: { ...target, pick: (key) => void pick(key) },
  });
}

class ModelPicker implements Disposable {
  onClose: (() => void) | null = null;
  private readonly store = new DisposableStore();
  private readonly element: HTMLElement;
  private readonly rail = h("div", { class: "model-picker-rail", role: "tablist" });
  private readonly search = h("input", {
    class: "input model-picker-search",
    type: "text",
    placeholder: "Search models…",
    "aria-label": "Search models",
    spellcheck: "false",
  }) as HTMLInputElement;
  private readonly title = h("div", { class: "model-picker-title" });
  private readonly list = h("div", { class: "model-picker-list", role: "listbox" });
  private tabs: Tab[] = [];
  private tab = "";
  private rows: Row[] = [];
  private active = 0;
  private disposed = false;

  constructor(
    private readonly anchor: HTMLElement,
    private readonly deps: ModelPickerDeps,
  ) {
    const doc = anchor.ownerDocument;
    const footer = this.footer();
    this.element = h(
      "div",
      { class: "model-picker", role: "dialog", "aria-label": "Models" },
      this.rail,
      h(
        "div",
        { class: "model-picker-main" },
        h("div", { class: "model-picker-head" }, icon("search"), this.search),
        this.title,
        this.list,
        footer,
      ),
    );
    doc.body.append(this.element);
    this.store.add(toDisposable(() => this.element.remove()));
    // The chat's tab closed (Ctrl+W) while it was open: its anchor left the page, so it goes too
    // (it would pick a model for a chat that's gone).
    // A chip's picker stays: its page redraws (a star changes a setting) and the chip is new.
    const gone = setInterval(() => {
      if (!anchor.isConnected && !deps.target) this.dispose();
    }, 500);
    this.store.add(toDisposable(() => clearInterval(gone)));
    // Its keys are its own while it's open: the IDE's bindings (Ctrl+PageDown switching dock
    // tabs under it, Ctrl+1 focusing an editor group) would act behind it first.
    this.store.add(deps.services.keyboard.suspend());
    // Lists change while it's open (a refresh, a star, the agent reporting its models).
    this.store.add(
      effect(() => {
        deps.registry.models.value;
        deps.registry.statuses.value;
        deps.session?.agentSettings.value;
        deps.session?.model.value;
        deps.services.settings.get("agent.favoriteModels");
        deps.services.settings.get("agent.recentModels");
        this.build();
        return undefined;
      }),
    );
    this.place();
    this.store.add(on(this.search, "input", () => this.render(true)));
    this.store.add(on(this.element, "keydown", (e) => this.key(e as KeyboardEvent)));
    // One listener each for the rail and the list (they're rebuilt on every change).
    this.store.add(
      on(this.rail, "click", (e) => {
        const b = (e.target as Element).closest<HTMLElement>("[data-tab]");
        if (!b) return;
        if (!b.dataset.tab) return this.run("agent.showSetup");
        this.tab = b.dataset.tab;
        this.search.value = "";
        this.renderRail();
        this.render(true);
        this.search.focus();
      }),
    );
    this.store.add(
      on(this.list, "click", (e) => {
        const target = e.target as Element;
        if (target.closest(".model-picker-note-action")) return this.noteAction?.();
        const row = target.closest<HTMLElement>(".model-picker-row");
        const key = row?.dataset.key;
        if (!key) return;
        if (target.closest(".model-picker-star"))
          this.run("agent.toggleFavoriteModel", { model: key }, false);
        else this.select(key);
      }),
    );
    this.store.add(
      on(this.list, "mousemove", (e) => {
        const row = (e.target as Element).closest<HTMLElement>(".model-picker-row");
        const index = row ? this.rows.findIndex((r) => r.key === row.dataset.key) : -1;
        if (!row || index < 0 || index === this.active) return;
        this.active = index;
        this.list.querySelector(".model-picker-row.is-active")?.classList.remove("is-active");
        row.classList.add("is-active");
      }),
    );
    // A press outside closes it; one on the anchor is left to the anchor's click (it toggles).
    const press = (e: Event) => {
      const t = e.target as Node | null;
      if (t && (this.element.contains(t) || anchor.contains(t))) return;
      if ((t as Element | null)?.closest?.(".menu")) return; // the presets menu
      this.dispose();
    };
    doc.addEventListener("pointerdown", press, { capture: true });
    this.store.add(
      toDisposable(() => doc.removeEventListener("pointerdown", press, { capture: true })),
    );
    const win = doc.defaultView;
    const blur = () => this.dispose();
    win?.addEventListener("blur", blur);
    win?.addEventListener("resize", blur);
    this.store.add(
      toDisposable(() => {
        win?.removeEventListener("blur", blur);
        win?.removeEventListener("resize", blur);
      }),
    );
    this.search.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Asked before the store removes the element: once it's gone the focus is on the body, and
    // Esc left the focus nowhere instead of back on the pill.
    const hadFocus = this.element.contains(this.anchor.ownerDocument.activeElement);
    this.store.dispose();
    this.onClose?.();
    if (hadFocus && this.anchor.isConnected) this.anchor.focus();
  }

  /** Above the anchor when there's more room there (the composer is at the bottom). */
  private place(): void {
    const win = this.anchor.ownerDocument.defaultView ?? window;
    const r = this.anchor.getBoundingClientRect();
    const width = Math.min(440, win.innerWidth - 16);
    const above = r.top > win.innerHeight - r.bottom;
    const room = (above ? r.top : win.innerHeight - r.bottom) - 12;
    const style = this.element.style;
    style.width = `${width}px`;
    style.maxHeight = `${Math.max(200, Math.min(440, room))}px`;
    style.left = `${Math.max(8, Math.min(r.right - width, win.innerWidth - width - 8))}px`;
    if (above) style.bottom = `${win.innerHeight - r.top + 6}px`;
    else style.top = `${r.bottom + 6}px`;
  }

  private current(): string | undefined {
    const { session, registry, target } = this.deps;
    if (target) return target.current ?? undefined;
    return (session && chatModelKey(session)) ?? registry.defaultModel()?.key;
  }

  /** The tabs: Favorites, each provider, each agent the user has (or uses). */
  private build(): void {
    const { services, registry } = this.deps;
    const current = this.current();
    const tabs: Tab[] = [];
    for (const status of registry.statuses.peek()) {
      const mark = () => providerMark(services, status);
      const models = registry.models.peek().filter((m) => m.provider.id === status.id);
      const tab: Tab = {
        id: `p:${status.id}`,
        name: status.name,
        mark,
        rows: models.map((m) => ({
          key: m.key,
          label: m.model,
          detail: [
            describeModel(m).replace(`${m.provider.name} · `, "").replace(m.provider.name, ""),
            priceLabel(priceOf(services, registry, m.key)),
          ]
            .filter(Boolean)
            .join(" · "),
          source: status.name,
          mark,
          current: m.key === current,
        })),
      };
      if (status.state === "loading") tab.note = { text: "Loading models…" };
      else if (status.id === OLLAMA_ID && status.state === "unreachable")
        tab.note = {
          text: "Ollama isn't running. Start it, or get it at ollama.com.",
          action: {
            label: "Get Ollama",
            run: () => this.run("agent.openLink", { url: "https://ollama.com/download" }),
          },
        };
      else if (status.state !== "ok")
        tab.note = {
          text: `${status.name}: ${status.error ?? "unavailable"}`,
          action: { label: "Manage providers", run: () => this.run("agent.showSetup") },
        };
      else if (!models.length)
        tab.note = {
          text:
            status.id === OLLAMA_ID ? "No models yet: run `ollama pull qwen3:8b`." : "No models.",
        };
      tabs.push(tab);
    }
    for (const agent of this.agents(current)) tabs.push(this.agentTab(agent, current));
    const byKey = new Map(tabs.flatMap((t) => t.rows.map((r) => [r.key, r] as const)));
    const resolve = (k: string) => byKey.get(k);
    const rowsOf = (keys: readonly string[]) => keys.map(resolve).filter((r): r is Row => !!r);
    // Favorites (bookmarked) and Recent (picked lately): two tabs at the top of the rail.
    const fav: Tab = {
      id: "favorites",
      name: "Favorites",
      mark: () => h("span", { class: "model-picker-glyph-tab" }, icon("bookmark")),
      rows: rowsOf(pickList(services.settings.peek("agent.favoriteModels"))),
    };
    if (!fav.rows.length) fav.note = { text: "Bookmark models to keep them here." };
    const recent: Tab = {
      id: "recent",
      name: "Recent",
      mark: () => h("span", { class: "model-picker-glyph-tab" }, icon("clock")),
      rows: rowsOf(pickList(services.settings.peek("agent.recentModels"))),
    };
    if (!recent.rows.length) recent.note = { text: "The models you pick show up here." };
    this.tabs = [fav, recent, ...tabs];
    if (!this.tab) {
      const home = tabs.find((t) => t.rows.some((r) => r.current));
      this.tab = fav.rows.length ? fav.id : recent.rows.length || !home ? recent.id : home.id;
    }
    if (!this.tabs.some((t) => t.id === this.tab)) this.tab = fav.id;
    this.renderRail();
    this.render(false);
  }

  /** The note's button's action (the list's click listener runs it). */
  private noteAction: (() => void) | null = null;

  /** External agents worth listing: installed, added by the user, or in use. */
  private agents(current: string | undefined): ExternalAgentConfig[] {
    const { services, installed, target } = this.deps;
    if (target && !target.agents) return [];
    return externalAgents(services).filter((a) => {
      if (current === `acp/${a.name}`) return true;
      const program = AGENT_SETUP[a.name]?.program;
      if (!program) return true; // an extension's, the registry's or the user's own
      const has = installed?.get(program);
      return has ?? !!cachedSettings(a.name);
    });
  }

  private agentTab(agent: ExternalAgentConfig, current: string | undefined): Tab {
    const { services, session } = this.deps;
    const name = agent.name;
    const isCurrent = current === `acp/${name}`;
    const live = session?.agentSettings.peek();
    const offer: readonly AcpSetting[] | null =
      live?.agent === name ? live.settings : cachedSettings(name);
    const remembered =
      services.settings.peek<Record<string, Record<string, string>>>(
        "agent.externalAgentChoices",
      )?.[name] ?? {};
    const model = offer?.find((s) => s.category === "model");
    // A target's or the chat's agent's own model of it (D288) comes first.
    const target = this.deps.target;
    const own = target
      ? target.agentModel
      : this.deps.agent
        ? agentExternalModel(services, this.deps.agent)
        : undefined;
    const chosen = model
      ? (own ??
        (live?.agent === name && !target ? model.current : (remembered.model ?? model.current)))
      : null;
    const mark = () => agentMark(services, name, this.deps.registryIcon);
    const rows: Row[] = [
      {
        key: agentPickKey(name),
        label: model ? `${name} (its default model)` : name,
        detail: agent.command,
        source: name,
        mark,
        current: isCurrent && !model,
      },
      ...(model?.options ?? []).map((o) => ({
        key: agentPickKey(name, o.id),
        label: o.name,
        ...(o.description && { detail: o.description }),
        source: name,
        mark,
        current: isCurrent && o.id === chosen,
      })),
    ];
    const tab: Tab = { id: `a:${name}`, name, mark, rows };
    if (!offer) {
      tab.note = { text: "Its models show here after it starts once." };
      if (isCurrent) void session?.prepareExternal().catch(() => {});
    } else if (!model) tab.note = { text: `${name} doesn't offer a choice of model.` };
    if (agent.modelFlag)
      tab.note = {
        text: tab.note?.text ?? `${name} takes any model name.`,
        action: {
          label: "Other model…",
          run: () => {
            this.dispose();
            void services.quickInput
              .prompt({ prompt: `Model for ${name} (the name its --model takes)` })
              .then((value) =>
                value?.trim() ? this.select(agentPickKey(name, value.trim())) : undefined,
              );
          },
        },
      };
    return tab;
  }

  private renderRail(): void {
    const buttons = this.tabs.map((t) => {
      const b = h(
        "button",
        {
          class: { "model-picker-tab": true, "is-selected": t.id === this.tab },
          type: "button",
          role: "tab",
          "aria-selected": String(t.id === this.tab),
          "aria-label": t.name,
          "data-tab": t.id,
        },
        t.mark(),
      );
      setTooltip(b, t.name);
      return b;
    });
    const manage = h(
      "button",
      {
        class: "model-picker-tab model-picker-manage",
        type: "button",
        "aria-label": "Manage models and providers",
        "data-tab": "",
      },
      icon("settings"),
    );
    setTooltip(manage, "Manage models and providers");
    this.rail.replaceChildren(...buttons, h("span", { class: "model-picker-rail-gap" }), manage);
  }

  /** The list: the tab's rows, or every tab's rows matching the search. */
  private render(resetActive: boolean): void {
    const query = this.search.value.trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    const tab = this.tabs.find((t) => t.id === this.tab);
    let rows: Row[];
    let heading: string;
    if (words.length) {
      const seen = new Set<string>();
      rows = this.tabs
        // Every provider and agent in rail order (not Favorites or Recent: their rows are theirs).
        .slice(2)
        .flatMap((t) => t.rows)
        .filter((r) => {
          const text = `${r.label} ${r.source} ${r.key}`.toLowerCase();
          if (seen.has(r.key) || !words.every((w) => text.includes(w))) return false;
          seen.add(r.key);
          return true;
        })
        .slice(0, 300);
      heading = rows.length
        ? `${rows.length} match${rows.length === 1 ? "" : "es"}`
        : "No models match";
    } else {
      rows = tab?.rows ?? [];
      heading = tab?.name ?? "";
    }
    // A chip's picker: its "same as the chat" row first (not when searching).
    const inherit = this.deps.target?.inherit;
    if (inherit && !words.length)
      rows = [
        {
          key: INHERIT,
          label: inherit.label,
          ...(inherit.detail && { detail: inherit.detail }),
          source: "",
          mark: () => h("span", { class: "model-picker-glyph-tab" }, icon("box")),
          current: this.deps.target?.current === null,
        },
        ...rows,
      ];
    this.rows = rows;
    const showSource = words.length > 0 || this.tab === "favorites" || this.tab === "recent";
    if (resetActive || this.active >= rows.length)
      this.active = Math.max(
        0,
        rows.findIndex((r) => r.current),
      );
    // In an agent's direct messages a pick sets that agent's model, wherever it works (D244).
    const agent = this.deps.agent;
    const target = this.deps.target;
    this.title.textContent = target
      ? `${heading} · ${target.title}`
      : agent
        ? `${heading} · sets ${memberInfo(agent).label}'s model everywhere`
        : heading;
    const children: HTMLElement[] = [];
    const note = !words.length ? tab?.note : undefined;
    this.noteAction = note?.action?.run ?? null;
    if (note) {
      const action = note.action
        ? h(
            "button",
            { class: "ai-link model-picker-note-action", type: "button" },
            note.action.label,
          )
        : null;
      children.push(h("div", { class: "model-picker-note" }, h("span", null, note.text), action));
    }
    // Search results span every provider and agent: each one's under its name, so OpenCode's
    // free models aren't read as OpenRouter's.
    let group = "";
    // Read once per draw, not per row (D379: hundreds of rows per keystroke).
    this.favorites = new Set(pickList(this.deps.services.settings.peek("agent.favoriteModels")));
    rows.forEach((r, i) => {
      if (words.length && r.source && r.source !== group) {
        group = r.source;
        children.push(h("div", { class: "model-picker-group", role: "presentation" }, group));
      }
      children.push(this.row(r, i, showSource && !words.length));
    });
    this.list.replaceChildren(...children);
    this.list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }

  /** The favorite models, read once per draw. */
  private favorites = new Set<string>();

  private row(r: Row, index: number, showSource: boolean): HTMLElement {
    const starred = this.favorites.has(r.key);
    const star =
      r.key === INHERIT
        ? null
        : h(
            "span",
            {
              class: { "model-picker-star": true, "is-on": starred },
              role: "button",
              "aria-label": starred
                ? `Remove ${r.label} from favorites`
                : `Add ${r.label} to favorites`,
            },
            icon("bookmark"),
          );
    if (star) setTooltip(star, starred ? "Remove from favorites" : "Add to favorites");
    const el = h(
      "div",
      {
        class: {
          "model-picker-row": true,
          "is-current": r.current,
          "is-active": index === this.active,
        },
        role: "option",
        "aria-selected": String(r.current),
        "data-key": r.key,
      },
      showSource ? r.mark() : null,
      h(
        "span",
        { class: "model-picker-text" },
        h("span", { class: "model-picker-label" }, r.label),
        showSource || r.detail
          ? h(
              "span",
              { class: "model-picker-detail" },
              [showSource ? r.source : "", r.detail ?? ""].filter(Boolean).join(" · "),
            )
          : null,
      ),
      r.current ? icon("check") : null,
      // Ctrl+1…9 picks a favorite (T3 Chat's ⌘1…): the key on its row.
      starred && this.tab === "favorites" && !this.search.value.trim() && index < 9
        ? h("kbd", { class: "model-picker-key" }, `Ctrl+${index + 1}`)
        : null,
      star,
    );
    return el;
  }

  private footer(): HTMLElement {
    const refresh = h(
      "button",
      { class: "icon-button", type: "button", "aria-label": "Refresh models" },
      icon("refresh-cw"),
    );
    setTooltip(refresh, "Refresh models");
    this.store.add(on(refresh, "click", () => this.run("agent.refreshModels", {}, false)));
    return h("div", { class: "model-picker-foot" }, h("span", { class: "diff-spacer" }), refresh);
  }

  private key(e: KeyboardEvent): void {
    const onRail = this.rail.contains(e.target as Node);
    if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      // The Nth favorite, from any tab (not the workbench's Ctrl+1 editor group).
      e.preventDefault();
      e.stopPropagation();
      const favorites = pickList(this.deps.services.settings.peek("agent.favoriteModels"));
      const all = new Map(
        this.tabs.slice(1).flatMap((t) => t.rows.map((r) => [r.key, r] as const)),
      );
      const key = favorites.filter((k) => all.has(k))[Number(e.key) - 1];
      if (key) this.select(key);
    } else if (onRail && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      // Up and down the rail: the tab follows the focus.
      e.preventDefault();
      this.moveTab(e.key === "ArrowDown" ? 1 : -1);
      this.rail.querySelector<HTMLElement>(".model-picker-tab.is-selected")?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.dispose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!this.rows.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      this.active = (this.active + step + this.rows.length) % this.rows.length;
      this.render(false);
    } else if (e.key === "Enter" && e.target === this.search && !e.isComposing) {
      e.preventDefault();
      const r = this.rows[this.active];
      if (r) this.select(r.key);
    } else if ((e.key === "PageDown" || e.key === "PageUp") && e.ctrlKey) {
      // Ctrl+PageDown / PageUp: the next or previous tab.
      e.preventDefault();
      this.moveTab(e.key === "PageDown" ? 1 : -1);
    }
  }

  private moveTab(step: 1 | -1): void {
    const at = this.tabs.findIndex((t) => t.id === this.tab);
    const next = this.tabs[(at + step + this.tabs.length) % this.tabs.length];
    if (!next) return;
    this.tab = next.id;
    this.search.value = "";
    this.renderRail();
    this.render(true);
  }

  private select(key: string): void {
    const target = this.deps.target;
    if (target) {
      this.dispose();
      target.pick(key === INHERIT ? null : key);
      return;
    }
    const session = this.deps.session;
    if (!session) return;
    const { model, agentModel } = parsePick(key);
    const agent = this.deps.agent;
    // The agent's own model (as on the Agents page), an external agent's own model too (D288:
    // Plato on Claude Code · Sonnet while the main agent stays on Opus).
    if (agent) {
      this.run("agent.setSubagent", { name: agent, model, agentModel: agentModel ?? "" });
      // The chat's connection follows at once, so its pill says what will answer.
      if (model.startsWith("acp/")) void session.syncExternalModel();
      return;
    }
    this.run("agent.selectModel", {
      model,
      session: session.id,
      ...(agentModel !== undefined && { agentModel }),
    });
  }

  /** Runs a command (errors as a notification); closes the picker unless `keep` is false. */
  private run(command: string, input: unknown = {}, close = true): void {
    const { services } = this.deps;
    if (close) this.dispose();
    void services.dispatcher
      .execute(command, input)
      .catch((err: unknown) =>
        services.notifications.show("error", err instanceof Error ? err.message : String(err)),
      );
  }
}
