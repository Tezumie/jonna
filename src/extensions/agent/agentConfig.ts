// The Agents page (D195, redesigned in D230, one grid since D287): the main agent and your agents
// as cards with their faces (click one to edit it in the agent editor), the hand-off switch, the
// AI features outside the chat (a switch and a model each) and the external agents. Subagents
// are in the agent editor (D288).
// Everything on it runs a command (`agent.chooseModel`, `agent.setSubagent`, `agent.editAgent`,
// `agent.newAgent`, `settings.set`…), so the agent can drive it too; `ide://agent/agents` and
// `ide://agent/subagents` show the same as data. The AI features are in Settings and the status
// bar too (D230); `agent.chooseModel {for: "feature:…"}` sets their models.

import { AGENT_TEMPLATES } from "../../core/agent/agentTemplates";
import { agentFace as faceOf } from "../../core/agent/faces";
import { MAIN_MEMBER } from "../../core/agent/groupChat";
import { agentLabel, isSubagent, type SubagentDef } from "../../core/agent/subagents";
import type { Json } from "../../core/dock/index";
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { agentFace } from "../../ui/AgentFace";
import { icon } from "../../ui/Icon";
import { type MenuItem, showMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import type { DockView } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { cachedSettings } from "./acp";
import { externalAgents } from "./acpAgents";
import { AGENT_FEATURES } from "./acpOneShot";
import { agentSourceLabel } from "./agentEditor";
import { addCustomizeSection, openCustomize } from "./customize";
import { FEATURE_MODEL_SETTING } from "./languageModel";
import { mainAgent } from "./mainAgent";
import { AI_FEATURES, chooseModelAt, modelChipLabel } from "./modelChooser";
import type { ProviderRegistry } from "./providers";
import type { SessionManager } from "./sessions";
import {
  agentExternalModel,
  type SubagentRegistry,
  subagentChoices,
  subagentEnabled,
  subagentModel,
} from "./subagents";

const short = (key: string) => key.slice(key.indexOf("/") + 1);

class AgentConfigView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly render = this.store.add(new DisposableStore());
  private readonly body: HTMLElement;
  /** The main agent's face picker is open. */

  constructor(
    private readonly services: WorkbenchServices,
    private readonly providers: ProviderRegistry,
    private readonly registry: SubagentRegistry,
    private readonly sessions: SessionManager,
  ) {
    this.body = h("div", { class: "ai-setup ac-page" });
    this.element = h("div", { class: "ai-page", tabindex: "-1" }, this.body);
    void registry.refresh();
    this.store.add(
      effect(() => {
        services.settings.version.value;
        mainAgent.value;
        providers.models.value;
        registry.list.value;
        // The main agent is the chat in use: its model (an external agent too) and its own.
        const active = sessions.active.value;
        const chat = active ? sessions.find(active) : undefined;
        chat?.model.value;
        chat?.agentSettings.value;
        this.draw();
        return undefined;
      }),
    );
  }

  private run(command: string, input: unknown = {}): void {
    void this.services.dispatcher
      .execute(command, input)
      .catch((err: unknown) =>
        this.services.notifications.show("error", err instanceof Error ? err.message : String(err)),
      );
  }

  private button(
    cls: string,
    label: (Node | string)[],
    command: string,
    input: unknown = {},
    key?: string,
  ): HTMLElement {
    const b = h(
      "button",
      { class: cls, type: "button", ...(key && { "data-key": key }) },
      ...label,
    );
    this.render.add(on(b, "click", () => this.run(command, input)));
    return b;
  }

  /** A model chip: the model in use (or "Same as the chat"), click to change. */
  private modelChip(
    target: string,
    model: string | null,
    inheritLabel = "Same as the chat",
    /** One of your agents' own model of an external agent (D288). */
    own?: string,
  ): HTMLElement {
    const chip = h(
      "button",
      {
        class: { "ac-model": true, "is-inherit": !model },
        type: "button",
        "data-for": target,
        "data-key": `model:${target}`,
      },
      icon("box"),
      h(
        "span",
        { class: "ac-model-name" },
        model ? modelChipLabel(this.services, model, own) : inheritLabel,
      ),
      icon("chevron-down"),
    );
    setTooltip(
      chip,
      model ? `${model}, click to change` : "Uses the chat's model, click to pick another",
    );
    this.render.add(
      on(chip, "click", () => chooseModelAt(chip, this.services, this.registry, target)),
    );
    return chip;
  }

  /** A model key as people read it: an external agent with the model it uses, or the model. */
  private label(key: string): string {
    if (!key.startsWith("acp/")) return short(key);
    const name = key.slice(4);
    const chat = this.sessions.find(undefined);
    const live =
      chat?.model.peek() === key && chat.agentSettings.peek()?.agent === name
        ? chat.agentSettings.peek()?.settings.find((x) => x.category === "model")
        : undefined;
    const offered = live ?? cachedSettings(name)?.find((x) => x.category === "model");
    const id =
      live?.current ??
      this.services.settings.peek<Record<string, Record<string, string>>>(
        "agent.externalAgentChoices",
      )?.[name]?.model;
    const model = id ? (offered?.options.find((o) => o.id === id)?.name ?? id) : "";
    return model ? `${name} · ${model}` : name;
  }

  /**
   * "Model setup": the preset the models are on (D196) — its name, "· changed" once they differ
   * from it, or None — with Update / Revert / Save as new / Apply.
   */
  private toggle(
    label: string,
    checked: boolean,
    key: string,
    change: (on: boolean) => void,
  ): HTMLElement {
    const box = h("input", {
      type: "checkbox",
      class: "switch",
      role: "switch",
      "aria-label": label,
      "data-key": key,
    }) as HTMLInputElement;
    box.checked = checked;
    box.setAttribute("aria-checked", String(checked));
    this.render.add(on(box, "change", () => change(box.checked)));
    return box;
  }

  private section(title: string, lead: string | null, ...children: (Node | null)[]): HTMLElement {
    return this.sectionWith(title, lead, null, ...children);
  }

  /** A section with a button beside its title. */
  private sectionWith(
    title: string,
    lead: string | null,
    action: HTMLElement | null,
    ...children: (Node | null)[]
  ): HTMLElement {
    return h(
      "section",
      { class: "ag-section" },
      h(
        "div",
        { class: "ag-section-head" },
        h(
          "div",
          { class: "ag-section-top" },
          h("h2", { class: "ag-section-title" }, title),
          action,
        ),
        lead ? h("p", { class: "ag-section-lead" }, lead) : null,
      ),
      ...children,
    );
  }

  // ---- Main agent ------------------------------------------------------------------------

  /**
   * The main agent (D287): a card like your agents', first in the grid: its face, name, role
   * (Agent), what it does and its one model; always on, so no switch. The card opens it in the
   * agent editor (its face, name and model).
   */
  private mainCard(): HTMLElement {
    const s = this.services.settings;
    const chatSession = this.sessions.find(undefined);
    const mainKey =
      chatSession?.model.peek() ||
      s.peek<string>("agent.model") ||
      this.providers.defaultModel()?.key ||
      null;
    const me = mainAgent.peek();
    const open = h(
      "button",
      { class: "ag-card-open", type: "button", "data-key": "open:main" },
      me.label,
    );
    setTooltip(open, `Edit ${me.label}: its face, name and model`);
    this.render.add(on(open, "click", () => this.run("agent.editAgent", { name: MAIN_MEMBER })));
    const desc = mainKey?.startsWith("acp/")
      ? "Runs the chat on an external agent, with its own loop and tools; hands work to your agents."
      : "Talks with you, builds, and hands work to your agents.";
    const card = h(
      "article",
      { class: "ag-card ag-card-main ac-node", "data-node": "main" },
      h(
        "div",
        { class: "ag-card-head" },
        agentFace(me.face, { size: 40 }),
        h(
          "div",
          { class: "ag-card-title" },
          h("h3", { class: "ag-card-name" }, open),
          h("span", { class: "ag-role" }, "Agent"),
        ),
      ),
      h("p", { class: "ag-card-desc" }, desc),
      h(
        "div",
        { class: "ag-card-foot" },
        this.modelChip("main", mainKey ? `x/${this.label(mainKey)}` : null, "No model yet"),
        h("span", { class: "ag-badge" }, "Main"),
      ),
    );
    return card;
  }

  // ---- Your agents -----------------------------------------------------------------------

  /** Reset to defaults (D272): agent.resetAgents asks first and says what goes. */
  private resetButton(): HTMLElement {
    const button = h(
      "button",
      {
        class: "button button-ghost button-sm page-add ag-reset",
        type: "button",
        "data-command": "agent.resetAgents",
      },
      icon("rotate-ccw"),
      "Reset to defaults",
    );
    setTooltip(button, "Your agents back to the default ones, as a new install has them");
    this.render.add(on(button, "click", () => this.run("agent.resetAgents")));
    return button;
  }

  private menuItems(def: SubagentDef): MenuItem[] {
    const builtin = def.source === "builtin";
    const enabled = subagentEnabled(this.services, def.name);
    return [
      ...(builtin
        ? []
        : [
            {
              label: "Chat with it",
              icon: "message-square-code" as const,
              disabled: !enabled,
              run: () => this.run("agent.chatWith", { agent: def.name }),
            },
            {
              label: "Edit",
              icon: "pencil" as const,
              run: () => this.run("agent.editAgent", { name: def.name }),
            },
          ]),
      ...(def.name === "explore"
        ? []
        : [
            {
              label: "Duplicate",
              icon: "copy" as const,
              run: () => this.run("agent.duplicateAgent", { name: def.name }),
            },
          ]),
      ...(def.path
        ? [
            {
              label: "Open file",
              icon: "file-text" as const,
              run: () => this.run("editor.openFile", { path: def.path }),
            },
          ]
        : []),
      ...(builtin
        ? []
        : [
            {
              label: "Delete…",
              icon: "trash-2" as const,
              destructive: true,
              separatorBefore: true,
              run: () => this.run("agent.deleteSubagent", { name: def.name }),
            },
          ]),
    ];
  }

  private menuButton(def: SubagentDef): HTMLElement {
    const label = `More actions for ${agentLabel(def)}`;
    const b = h(
      "button",
      {
        class: "icon-button ag-more",
        type: "button",
        "aria-label": label,
        "aria-haspopup": "menu",
        "data-key": `more:${def.name}`,
      },
      icon("ellipsis"),
    );
    setTooltip(b, "More actions");
    this.render.add(on(b, "click", () => showMenu(b, this.menuItems(def), { label })));
    return b;
  }

  private contextMenu(el: HTMLElement, def: SubagentDef): void {
    this.render.add(
      on(el, "contextmenu", (e) => {
        e.preventDefault();
        showMenu({ x: e.clientX, y: e.clientY }, this.menuItems(def), agentLabel(def));
      }),
    );
  }

  private subagentModelChip(def: SubagentDef): HTMLElement {
    const model = subagentModel(this.services, def);
    const fromFile =
      def.model && def.model !== "inherit" && !subagentChoices(this.services)[def.name]?.model;
    return this.modelChip(
      `subagent:${def.name}`,
      model,
      fromFile ? (def.model ?? "") : "Same as the chat",
      agentExternalModel(this.services, def.name),
    );
  }

  private agentCard(def: SubagentDef): HTMLElement {
    const enabled = subagentEnabled(this.services, def.name);
    const label = agentLabel(def);
    const open = h(
      "button",
      { class: "ag-card-open", type: "button", "data-key": `open:${def.name}` },
      label,
    );
    setTooltip(open, `Edit ${label}`);
    this.render.add(on(open, "click", () => this.run("agent.editAgent", { name: def.name })));
    const description = def.description;
    const card = h(
      "article",
      {
        class: { "ag-card": true, "ac-node": true, "is-off": !enabled },
        "data-node": `subagent:${def.name}`,
      },
      h(
        "div",
        { class: "ag-card-head" },
        agentFace(faceOf(def.icon, def.name, subagentModel(this.services, def)), { size: 40 }),
        h(
          "div",
          { class: "ag-card-title" },
          h("h3", { class: "ag-card-name" }, open),
          def.role ? h("span", { class: "ag-role" }, def.role) : null,
        ),
        this.toggle(`Use ${label}`, enabled, `switch:${def.name}`, (v) =>
          this.run("agent.setSubagent", { name: def.name, enabled: v }),
        ),
      ),
      h("p", { class: "ag-card-desc" }, description),
      h(
        "div",
        { class: "ag-card-foot" },
        this.subagentModelChip(def),
        h("span", { class: "ag-badge" }, agentSourceLabel(def)),
        this.menuButton(def),
      ),
    );
    setTooltip(card.querySelector(".ag-card-desc") as HTMLElement, description);
    this.contextMenu(card, def);
    return card;
  }

  private newAgentCard(empty: boolean): HTMLElement {
    const card = h(
      "button",
      { class: "ag-card ag-new", type: "button", "data-key": "new-agent" },
      h("span", { class: "ag-new-icon" }, icon("plus")),
      h("span", { class: "ag-new-name" }, "New agent"),
      h(
        "span",
        { class: "ag-new-detail" },
        empty ? "A face, a name and what it does" : "From a template or blank",
      ),
    );
    this.render.add(on(card, "click", () => this.run("agent.newAgent")));
    return card;
  }

  private templateChips(): HTMLElement {
    return h(
      "div",
      { class: "ag-templates" },
      h("span", { class: "ag-templates-label" }, "Or start from"),
      ...AGENT_TEMPLATES.filter((t) => t.id !== "blank").map((t) => {
        const b = this.button(
          "ag-template",
          [t.label],
          "agent.newAgent",
          { template: t.id },
          `template:${t.id}`,
        );
        setTooltip(b, t.description);
        return b;
      }),
    );
  }

  // ---- External agents ----------------------------------------------

  // ---- AI features --------------------------------------------------------------------------

  private featureRow(f: (typeof AI_FEATURES)[number]): HTMLElement {
    const s = this.services.settings;
    const on = s.peek<boolean>(f.setting) ?? f.on;
    const model = s.peek<string>(FEATURE_MODEL_SETTING[f.id]) || null;
    const chip = this.modelChip(`feature:${f.id}`, model);
    chip.toggleAttribute("disabled", !on);
    return h(
      "div",
      { class: { "ag-row": true, "ac-node": true, "is-off": !on }, "data-node": `feature:${f.id}` },
      h("span", { class: "ag-row-icon" }, icon(f.icon)),
      h(
        "div",
        { class: "ag-row-main" },
        h("span", { class: "ag-row-name" }, f.label),
        h("span", { class: "ag-row-detail" }, f.detail),
      ),
      chip,
      this.toggle(f.label, on, `on:feature:${f.id}`, (v) =>
        this.run("settings.set", { key: f.setting, value: v }),
      ),
    );
  }

  /**
   * An external agent: what it is, no model of its own here (D288). Its model is picked as an
   * agent's (on the agent's card or in the chat), so there's one place for it, not two.
   */
  private externalRow(a: { name: string; description?: string; command: string }): HTMLElement {
    const row = h(
      "div",
      { class: "ag-row ac-node", "data-node": `external:${a.name}` },
      h("span", { class: "ag-row-icon" }, icon("terminal")),
      h(
        "div",
        { class: "ag-row-main" },
        h("span", { class: "ag-row-name" }, a.name),
        h("span", { class: "ag-row-detail" }, a.description ?? a.command),
      ),
    );
    return row;
  }

  // ---- The page --------------------------------------------------------------------------

  private draw(): void {
    // The control that had focus keeps it across the redraw (keyboard use).
    const active = this.body.ownerDocument.activeElement;
    const key =
      active instanceof HTMLElement && this.body.contains(active) ? active.dataset.key : undefined;
    this.drawPage();
    if (key) this.body.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus();
  }

  private drawPage(): void {
    this.render.clear();
    const all = this.registry.list.value;
    // Agents only (D288): subagents are in the agent editor's Subagents section.
    const mine = all.filter((d) => !isSubagent(d));
    // The grid's own New agent card adds one; Customize hides this title (its chip names it).
    const header = h(
      "div",
      { class: "ai-header" },
      h("div", null, h("h1", { class: "ai-title" }, "Agents")),
    );
    const handOffOn = this.services.settings.peek<boolean>("agent.handOff") !== false;
    const handOff = h(
      "label",
      { class: "ag-switch-row" },
      this.toggle("Let agents hand work to each other", handOffOn, "handOff", (v) =>
        this.run("settings.set", { key: "agent.handOff", value: v }),
      ),
      h(
        "span",
        { class: "ag-switch-text" },
        h("span", null, "Let agents hand work to each other"),
        h(
          "span",
          { class: "ag-switch-detail" },
          "An agent can bring another into the chat to answer next, and be handed back",
        ),
      ),
    );
    // Subagents (D288) are workers, not agents you talk to: they're on the main agent's page.
    const subagentsLink = h(
      "p",
      { class: "ag-problems" },
      `Subagents, the workers your agents run privately for a task (Explore, Plan, Review…), are on ${mainAgent.peek().label}'s page: `,
      this.button(
        "link-button",
        ["Subagents"],
        "agent.editAgent",
        { name: MAIN_MEMBER },
        "subagents",
      ),
      ".",
    );
    const problems = this.registry.problems.value.filter(
      (p) => !/[\\/]\.claude[\\/]agents[\\/]/.test(p),
    );
    replaceChildren(
      this.body,
      header,
      this.sectionWith(
        "Your agents",
        null,
        this.resetButton(),
        h(
          "div",
          { class: "ag-grid" },
          this.mainCard(),
          ...mine.map((d) => this.agentCard(d)),
          this.newAgentCard(mine.length === 0),
        ),
        mine.length === 0 ? this.templateChips() : null,
        problems.length
          ? h(
              "p",
              { class: "ag-problems" },
              `Not read as agents (they need a header with name and description): ${problems.map((p) => basename(p)).join(", ")}`,
            )
          : null,
        handOff,
        subagentsLink,
      ),
      this.section(
        "AI features",
        null,
        h("div", { class: "ag-rows" }, ...AI_FEATURES.map((f) => this.featureRow(f))),
      ),
      this.sectionWith(
        "External agents",
        null,
        this.button(
          "button button-ghost button-sm page-add",
          [icon("plus"), "Add"],
          "agent.registry.browse",
          {},
          "browse",
        ),
        h(
          "div",
          { class: "ag-rows" },
          ...externalAgents(this.services).map((a) => this.externalRow(a)),
        ),
      ),
    );
  }

  serialize(): Json {
    return null;
  }

  dispose(): void {
    this.store.dispose();
  }
}

export function registerAgentConfig(
  sub: DisposableStore,
  services: WorkbenchServices,
  providers: ProviderRegistry,
  registry: SubagentRegistry,
  sessions: SessionManager,
): void {
  const { dispatcher, quickInput, settings } = services;
  sub.add(
    addCustomizeSection({
      id: "agents",
      label: "Agents",
      icon: "bot",
      detail:
        "The main agent and its models, your agents, the built-in helpers and external agents",
      keywords: "agents subagents faces modes plan build external claude codex models presets",
      order: 20,
      page: { create: () => new AgentConfigView(services, providers, registry, sessions) },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.showAgentConfig",
      title: "Configure agents…",
      category: "Agent",
      description:
        "Opens the Agents page: the main agent and your agents as cards (on/off, model, edit, chat with it, duplicate, delete), the switch letting agents hand work to each other, external agents. Subagents are in the agent editor (agent.editAgent).",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => openCustomize(services, "agents"),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.chooseModel",
      title: "Choose a model for part of the agent…",
      category: "Agent",
      description:
        "Sets the model of one part of the agent. `for`: main (the chat in use and new chats; a provider/model or acp/<external agent>), subagent:<name> (one of your agents or a subagent), feature:<edit|completion|nextEdit|commit|memory>, external:<agent>. `model`: provider/model (an external agent: one of its own model ids); empty: the chat's model (or the agent's default). Lists the choices when `model` is omitted.",
      input: s.object({
        for: s.string(),
        model: s.string().optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ for: target, model }) => {
        const [kind, ...rest] = target.split(":");
        const name = rest.join(":");
        let value = model;
        // The choices: the IDE's models (an external agent: its own, from its last start).
        if (value === undefined) {
          await providers.refreshIfStale(5000, 3000);
          const offer =
            kind === "external" ? cachedSettings(name)?.find((x) => x.category === "model") : null;
          if (kind === "external" && !offer)
            throw new Error(
              `${name}'s models are known once it has started: pick it in the chat's model menu first.`,
            );
          const items = offer
            ? offer.options.map((o) => ({ id: o.id, label: o.name, description: o.description }))
            : [
                ...(kind === "main"
                  ? []
                  : [
                      {
                        id: "",
                        label: "Same as the chat",
                        description: providers.defaultModel()?.model ?? "",
                      },
                    ]),
                ...providers.models
                  .peek()
                  .filter((m) => !m.key.startsWith("acp/"))
                  .map((m) => ({ id: m.key, label: m.model, description: m.provider.name })),
                // The main agent can be an external agent (its own loop, tools and models); so can
                // one of your agents, for its own turns in a chat (D249); commit messages and
                // memory tidy-up can use one too (D207, D216).
                ...(kind === "main" ||
                kind === "subagent" ||
                (kind === "feature" && AGENT_FEATURES.has(name))
                  ? externalAgents(services).map((a, i) => ({
                      id: `acp/${a.name}`,
                      label: a.name,
                      description: "external agent",
                      ...(i === 0 && { separator: "External agents" }),
                    }))
                  : []),
              ];
          const picked = await quickInput.pick(
            items.map((i) => ({ ...i, ...(i.description === undefined && { description: "" }) })),
            { placeholder: "Pick a model" },
          );
          if (!picked) return null;
          value = picked.id;
        }
        if (value?.startsWith("acp/") && kind === "feature" && !AGENT_FEATURES.has(name))
          throw new Error(
            `${name} needs a model; external agents only write commit messages and tidy memory.`,
          );
        if (value && kind !== "external" && !value.startsWith("acp/") && !providers.find(value))
          throw new Error(`No model ${value} (see Models and providers).`);
        if (kind === "main") {
          if (!value) throw new Error("The main agent needs a model.");
          // The chat in use switches too, and new chats start with it (agent.selectModel).
          await dispatcher.execute("agent.selectModel", {
            model: value,
            ...(sessions.find(undefined) && { session: sessions.find(undefined)?.id }),
          });
        } else if (kind === "subagent")
          await dispatcher.execute("agent.setSubagent", { name, model: value ?? "" });
        else if (kind === "feature" && name in FEATURE_MODEL_SETTING)
          await settings.update(
            FEATURE_MODEL_SETTING[name as keyof typeof FEATURE_MODEL_SETTING],
            value || undefined,
            "user",
          );
        else if (kind === "external") {
          const all = {
            ...(settings.peek<Record<string, Record<string, string>>>(
              "agent.externalAgentChoices",
            ) ?? {}),
          };
          all[name] = { ...(all[name] ?? {}), model: value ?? "" };
          await settings.update("agent.externalAgentChoices", all, "user");
        } else throw new Error(`Not a part of the agent: ${target}.`);
        return { for: target, model: value || "inherit" };
      },
    }),
  );
}
