// The main agent in the agent editor (D286): the same page as your agents', with what can be
// changed of it: its face (or its model's logo), its name and its model. Its instructions are the
// project's rules and your memory, and it's always on, so those fields aren't there; links go
// where they are set. Everything writes through commands (agent.setMainAgent, agent.chooseModel).
// Under it, the Subagents section (D288): the workers every agent can run.

import { encodeFace, MODEL_ICON } from "../../core/agent/faces";
import { h, on, replaceChildren } from "../../core/dom/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import { FacePicker } from "./facePicker";
import { DEFAULT_MAIN_AGENT_NAME, mainAgent } from "./mainAgent";
import { chooseModelAt, modelChipLabel } from "./modelChooser";
import type { ProviderRegistry } from "./providers";
import type { SubagentRegistry } from "./subagents";
import { subagentsSection } from "./subagentsSection";

/** The model new chats start with, as the Agents page shows it (null: none connected yet). */
export function mainModelKey(
  services: WorkbenchServices,
  providers: ProviderRegistry,
): string | null {
  return services.settings.peek<string>("agent.model") || providers.defaultModel()?.key || null;
}

/** Draws the main agent's page into `body`; `ui` owns its listeners. */
export function drawMainAgentEditor(
  body: HTMLElement,
  ui: DisposableStore,
  services: WorkbenchServices,
  providers: ProviderRegistry,
  registry: SubagentRegistry,
): void {
  const run = (command: string, input: unknown = {}) =>
    void services.dispatcher.execute(command, input).catch((err: unknown) => {
      services.notifications.show("error", err instanceof Error ? err.message : String(err));
    });
  const me = mainAgent.peek();

  const back = h(
    "button",
    { class: "ae-crumb-link", type: "button", "data-command": "agent.showAgentConfig" },
    "Agents",
  );
  setTooltip(back, "Back to your agents");
  ui.add(on(back, "click", () => run("agent.showAgentConfig")));
  const here = h("span", { class: "ae-crumb-here", "aria-current": "page" }, me.label);
  const crumbs = h(
    "nav",
    { class: "ae-crumbs", "aria-label": "Breadcrumb" },
    back,
    h("span", { class: "ae-crumb-sep", "aria-hidden": "true" }, icon("chevron-right")),
    here,
  );

  const faceHost = h("div");
  const picker = ui.add(
    new FacePicker(faceHost, {
      face: me.face,
      model: me.face.model !== undefined,
      modelKey: () => mainModelKey(services, providers),
      // Its built-in face has no color of its own (0): a pick gets the first.
      onPick: (face) =>
        run("agent.setMainAgent", { icon: encodeFace({ ...face, color: face.color || 1 }) }),
      onModel: () => run("agent.setMainAgent", { icon: MODEL_ICON }),
    }),
  );

  const name = h("input", {
    class: "input ae-input",
    type: "text",
    maxlength: "40",
    value: me.label,
    placeholder: DEFAULT_MAIN_AGENT_NAME,
    spellcheck: "false",
    autocomplete: "off",
    id: "ae-main-name",
  }) as HTMLInputElement;
  const saveName = () => {
    if (name.value.trim() !== mainAgent.peek().label)
      run("agent.setMainAgent", { name: name.value });
  };
  ui.add(on(name, "change", saveName));
  ui.add(
    on(name, "keydown", (e) => {
      if (e.key === "Enter") name.blur();
    }),
  );

  const model = h("button", {
    class: "ac-model ae-model",
    type: "button",
    "aria-haspopup": "menu",
  });
  ui.add(on(model, "click", () => chooseModelAt(model, services, registry, "main")));

  const link = (label: string, command: string) => {
    const b = h("button", { class: "link-button", type: "button" }, label);
    ui.add(on(b, "click", () => run(command)));
    return b;
  };

  const chat = h(
    "button",
    { class: "button button-primary ae-chat", type: "button" },
    icon("message-square-code"),
    "Chat with it",
  );
  ui.add(on(chat, "click", () => run("agent.newSession")));

  const subagentsHost = h("div", { class: "ae-subagents-host" });
  void registry.refresh();

  replaceChildren(
    body,
    crumbs,
    faceHost,
    h(
      "div",
      { class: "ae-fields" },
      h(
        "div",
        { class: "ae-field", "data-for": "label" },
        h("label", { class: "ae-label", for: "ae-main-name" }, "Name"),
        name,
        h(
          "span",
          { class: "ae-hint" },
          "The main agent: it talks with you, builds, and hands work to your agents.",
        ),
      ),
      h(
        "div",
        { class: "ae-field ae-inline", "data-for": "model" },
        h("span", { class: "ae-label" }, "Model"),
        model,
      ),
      h(
        "div",
        { class: "ae-field", "data-for": "instructions" },
        h("span", { class: "ae-label" }, "Instructions"),
        h(
          "p",
          { class: "ae-hint" },
          "Its instructions are the project's rules (AGENTS.md and the like) and your memory: ",
          link("Rules", "agent.showRules"),
          " · ",
          link("Memory", "agent.openMemory"),
          ".",
        ),
      ),
    ),
    subagentsHost,
    h(
      "div",
      { class: "ae-footer" },
      h("span", { class: "ae-note" }),
      h("div", { class: "ae-footer-actions" }, chat),
    ),
  );

  // The section follows its settings and files (a model picked, a file added in .claude/agents).
  const sectionUi = ui.add(new DisposableStore());
  ui.add(
    effect(() => {
      services.settings.version.value;
      registry.list.value;
      registry.problems.value;
      providers.models.value;
      sectionUi.clear();
      replaceChildren(subagentsHost, subagentsSection(sectionUi, services, registry));
      return undefined;
    }),
  );

  // Its name, face and model follow changes made elsewhere (the Channels menu, the model menu).
  ui.add(
    effect(() => {
      const now = mainAgent.value;
      services.settings.version.value;
      providers.models.value;
      here.textContent = now.label;
      if (document.activeElement !== name && name.value !== now.label) name.value = now.label;
      picker.set(now.face, now.face.model !== undefined);
      picker.refreshModel();
      const key = mainModelKey(services, providers);
      replaceChildren(
        model,
        icon("box"),
        h("span", { class: "ac-model-name" }, key ? modelChipLabel(services, key) : "No model yet"),
        icon("chevron-down"),
      );
      return undefined;
    }),
  );
}
