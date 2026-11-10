// The Subagents section of the agent editor (D288): the workers an agent runs for a task, as in
// Claude Code — the built-in Explore, Plan, Review and General purpose, and Claude Code's files in
// the project's and your `.claude/agents`. Each row: its name and source, what it does, its model,
// Customize/Edit, a switch. On the main agent's page the switches turn a subagent on or off for
// everyone (agent.setSubagent, agent.delegate); on one of your agents' pages they say which it may
// run (its file's `subagents:`, written by the page). A subagent's model and instructions are
// shared: every agent runs the same one. Everything else runs a command (agent.chooseModel,
// agent.editSubagent, agent.newSubagent); `ide://agent/subagents` shows the same as data.

import { agentLabel, allowsSubagent, type SubagentDef } from "../../core/agent/subagents";
import { h, on } from "../../core/dom/index";
import type { DisposableStore } from "../../core/lifecycle/index";
import { icon } from "../../ui/Icon";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import { chooseModelAt } from "./modelChooser";
import {
  type SubagentRegistry,
  subagentChoices,
  subagentEnabled,
  subagentModel,
} from "./subagents";

const short = (key: string) => key.slice(key.indexOf("/") + 1);

/** Where a subagent comes from, as its badge says. */
function sourceLabel(def: SubagentDef): string {
  if (def.source === "builtin") return "Built in";
  return def.source === "project" ? "Project" : "You";
}

/** On one of your agents' pages: which subagents it may run, and how to change that. */
export interface SubagentsFor {
  /** Its id (the section's `data-agent`). */
  name: string;
  /** Its name for the hint ("Gabby can run…"). */
  label: string;
  /** Its `subagents:` list; null: all. */
  allowed: readonly string[] | null;
  /** The main agent's name, where they're turned on or off for everyone. */
  mainLabel: string;
  change(name: string, allowed: boolean): void;
}

/** The section, drawn fresh by its page (which redraws on settings and registry changes). */
export function subagentsSection(
  ui: DisposableStore,
  services: WorkbenchServices,
  registry: SubagentRegistry,
  forAgent?: SubagentsFor,
): HTMLElement {
  const run = (command: string, input: unknown = {}): Promise<void> =>
    services.dispatcher.execute(command, input).then(
      () => undefined,
      (err: unknown) => {
        services.notifications.show("error", err instanceof Error ? err.message : String(err));
      },
    );
  const delegateOn = services.settings.peek<boolean>("agent.delegate") !== false;

  const master = h("input", {
    type: "checkbox",
    class: "switch",
    role: "switch",
    "aria-label": "Let agents run subagents",
    "data-key": "delegate",
  }) as HTMLInputElement;
  master.checked = delegateOn;
  master.setAttribute("aria-checked", String(delegateOn));
  ui.add(
    on(
      master,
      "change",
      () => void run("settings.set", { key: "agent.delegate", value: master.checked }),
    ),
  );

  const add = h(
    "button",
    { class: "button button-secondary ae-sub-new", type: "button", "data-key": "new-subagent" },
    icon("plus"),
    "New subagent",
  );
  setTooltip(add, "A Claude Code subagent file in the project's .claude/agents");
  ui.add(on(add, "click", () => void run("agent.newSubagent")));

  const rows = registry
    .subagents()
    .map((def) => subagentRow(def, ui, services, registry, run, delegateOn, forAgent));
  const problems = registry.problems.peek().filter((p) => /[\\/]\.claude[\\/]agents[\\/]/.test(p));

  return h(
    "section",
    {
      class: "ae-subagents",
      "data-for": "subagents",
      "data-agent": forAgent?.name ?? "agent",
      "aria-label": "Subagents",
    },
    h(
      "div",
      { class: "ae-sub-head" },
      h(
        "div",
        { class: "ae-sub-titles" },
        h("h2", { class: "ae-sub-title" }, "Subagents"),
        h(
          "p",
          { class: "ae-hint" },
          forAgent
            ? `The workers ${forAgent.label} can run for a task: each works privately in a fresh context and reports back. Their models and instructions are shared by all your agents.`
            : "Workers any of your agents can run for a task: each works privately in a fresh context and reports back, as in Claude Code. Your own are files in .claude/agents.",
        ),
      ),
      add,
    ),
    forAgent
      ? delegateOn
        ? null
        : h(
            "p",
            { class: "ae-hint" },
            `Subagents are off for every agent (on ${forAgent.mainLabel}'s page).`,
          )
      : h(
          "label",
          { class: "ag-switch-row ae-sub-master" },
          master,
          h(
            "span",
            { class: "ag-switch-text" },
            h("span", null, "Let agents run subagents"),
            h("span", { class: "ag-switch-detail" }, "Off: agents do every task themselves"),
          ),
        ),
    h("div", { class: { "ae-sub-list": true, "is-off": !delegateOn } }, ...rows),
    problems.length
      ? h(
          "p",
          { class: "ae-hint is-error" },
          `Not read (no name or description in its header): ${problems.join(", ")}`,
        )
      : null,
  );
}

function subagentRow(
  def: SubagentDef,
  ui: DisposableStore,
  services: WorkbenchServices,
  registry: SubagentRegistry,
  run: (command: string, input?: unknown) => Promise<void>,
  delegateOn: boolean,
  forAgent: SubagentsFor | undefined,
): HTMLElement {
  const label = agentLabel(def);
  const on_ = subagentEnabled(services, def.name);
  // One of your agents' pages: its own list (a subagent off for everyone stays off for it).
  const enabled = forAgent
    ? on_ && allowsSubagent({ subagents: forAgent.allowed ?? undefined }, def.name)
    : on_;
  const box = h("input", {
    type: "checkbox",
    class: "switch",
    role: "switch",
    "aria-label": `${label} on`,
    "data-key": `on:${def.name}`,
  }) as HTMLInputElement;
  box.checked = enabled;
  box.setAttribute("aria-checked", String(enabled));
  box.disabled = forAgent
    ? !on_ || (!delegateOn && def.name !== "explore")
    : !delegateOn && def.name !== "explore";
  if (forAgent && !on_) setTooltip(box, `Off for every agent (on ${forAgent.mainLabel}'s page)`);
  ui.add(
    on(box, "change", async () => {
      if (forAgent) {
        forAgent.change(def.name, box.checked);
        return;
      }
      // Explore is its tool, which has a setting of its own (agent.explore): both follow, one
      // write after the other (the same settings file).
      if (def.name === "explore")
        await run("settings.set", { key: "agent.explore", value: box.checked });
      await run("agent.setSubagent", { name: def.name, enabled: box.checked });
    }),
  );

  const model = subagentModel(services, def);
  // A model its file names (not one picked here) shows as its file's.
  const fromFile =
    def.model && def.model !== "inherit" && !subagentChoices(services)[def.name]?.model;
  const chip = h(
    "button",
    {
      class: { "ac-model": true, "ae-sub-model": true, "is-inherit": !model },
      type: "button",
      "aria-haspopup": "menu",
      "data-key": `model:${def.name}`,
    },
    icon("box"),
    h("span", { class: "ac-model-name" }, model ? short(model) : "Same as the chat"),
    icon("chevron-down"),
  );
  setTooltip(chip, fromFile ? `${label}'s model (from its file)` : `${label}'s model`);
  ui.add(on(chip, "click", () => chooseModelAt(chip, services, registry, `subagent:${def.name}`)));

  const builtin = def.source === "builtin";
  const edit = h(
    "button",
    { class: "icon-button ae-sub-edit", type: "button", "data-key": `edit:${def.name}` },
    icon(builtin ? "copy" : "pencil"),
  );
  setTooltip(
    edit,
    builtin
      ? `Customize: copy ${label} to .claude/agents and open it (your copy replaces it)`
      : `Open ${def.path ?? "its file"}`,
  );
  edit.setAttribute("aria-label", builtin ? `Customize ${label}` : `Edit ${label}`);
  ui.add(on(edit, "click", () => void run("agent.editSubagent", { name: def.name })));

  return h(
    "div",
    {
      class: { "ae-sub-row": true, "is-off": !enabled },
      "data-subagent": def.name,
    },
    h(
      "div",
      { class: "ae-sub-text" },
      h(
        "div",
        { class: "ae-sub-name" },
        h("span", { class: "ae-sub-label" }, label),
        h("span", { class: "ag-badge" }, sourceLabel(def)),
        def.name === "explore" ? h("span", { class: "ag-badge" }, "Explore tool") : null,
      ),
      h("p", { class: "ae-sub-desc" }, def.description),
    ),
    h("div", { class: "ae-sub-actions" }, chip, edit, box),
  );
}
