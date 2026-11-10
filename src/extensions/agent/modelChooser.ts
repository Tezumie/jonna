// Model chips (D288): every chip that sets a model (the main agent's, an agent's, a subagent's,
// an AI feature's) opens the chat's model picker for it, with the providers' rail, search,
// favorites and an external agent's own models. What each target allows and shows is here; the
// pick goes through agent.chooseModel like the commands do. The AI features listed on the Agents
// page live here too, so a feature's name reads the same in its picker.

import { isSubagent } from "../../core/agent/subagents";
import type { IconName } from "../../ui/Icon";
import type { WorkbenchServices } from "../../workbench/services";
import { cachedSettings } from "./acp";
import { AGENT_FEATURES } from "./acpOneShot";
import { FEATURE_MODEL_SETTING } from "./languageModel";
import { mainAgent } from "./mainAgent";
import { agentExternalModel, type SubagentRegistry, subagentModel } from "./subagents";
import { chooserContext, showModelChooser } from "./view/modelPicker";

/**
 * The AI features outside the chat (D288, the owner's ask): each with its switch (the setting
 * that turns it on, D172) and its model (FEATURE_MODEL_SETTING, via agent.chooseModel).
 */
export const AI_FEATURES: readonly {
  id: keyof typeof FEATURE_MODEL_SETTING;
  label: string;
  detail: string;
  icon: IconName;
  setting: string;
  /** The setting's default (an unset setting reads as it). */
  on: boolean;
}[] = [
  {
    id: "edit",
    label: "Edit with AI",
    detail: "Ctrl+K in the editor rewrites the selected lines, reviewed change by change",
    icon: "wand-sparkles",
    setting: "editor.inlineEdit.enabled",
    on: false,
  },
  {
    id: "completion",
    label: "Suggestions as you type",
    detail: "Ghost text as you type; a fast local code model works best",
    icon: "text-cursor-input",
    setting: "editor.inlineCompletions.enabled",
    on: false,
  },
  {
    id: "nextEdit",
    label: "Next-edit suggestions",
    detail: "After a change, suggests the edit that should follow",
    icon: "lightbulb",
    setting: "editor.nextEdit.enabled",
    on: false,
  },
  {
    id: "commit",
    label: "Generate commit message",
    detail: "A button in Source control writes it from the staged changes",
    icon: "git-commit-horizontal",
    setting: "git.aiCommitMessage.enabled",
    on: true,
  },
  {
    id: "memory",
    label: "Memory tidy-up",
    detail: "Merges and prunes the agent's memory now and then, for you to review",
    icon: "brain",
    setting: "agent.memory.autoTidyUp",
    on: true,
  },
];

const SAME_AS_CHAT = { label: "Same as the chat" };

/**
 * A model key as a chip shows it: the model's name, or an external agent with the model it was
 * last given ("Claude Code · Sonnet 5.5", agent.externalAgentChoices).
 */
export function modelChipLabel(
  services: WorkbenchServices,
  key: string,
  /** One of your agents' own model of the external agent (D288). */
  own?: string,
): string {
  if (!key.startsWith("acp/")) return key.slice(key.indexOf("/") + 1);
  const name = key.slice(4);
  const offered = cachedSettings(name)?.find((x) => x.category === "model");
  const id =
    own ??
    services.settings.peek<Record<string, Record<string, string>>>("agent.externalAgentChoices")?.[
      name
    ]?.model;
  const model = id ? (offered?.options.find((o) => o.id === id)?.name ?? id) : "";
  return model ? `${name} · ${model}` : name;
}

/**
 * Opens the picker for `target` (agent.chooseModel's: main, subagent:<name>, feature:<id>) at
 * `anchor`. Anything else (an external agent's own models) gets agent.chooseModel's list.
 */
export function chooseModelAt(
  anchor: HTMLElement,
  services: WorkbenchServices,
  subagents: SubagentRegistry | null,
  target: string,
): void {
  const colon = target.indexOf(":");
  const kind = colon < 0 ? target : target.slice(0, colon);
  const name = colon < 0 ? "" : target.slice(colon + 1);
  const settings = services.settings;
  if (kind === "main") {
    showModelChooser(anchor, services, {
      for: target,
      title: `${mainAgent.peek().label}'s model, for new chats and this one`,
      current:
        settings.peek<string>("agent.model") ||
        chooserContext.registry?.defaultModel()?.key ||
        null,
      agents: true,
    });
    return;
  }
  if (kind === "subagent") {
    const def = subagents?.get(name);
    showModelChooser(anchor, services, {
      for: target,
      title: `sets ${def?.label ?? name}'s model everywhere`,
      current: def ? subagentModel(services, def) : null,
      agentModel: agentExternalModel(services, name),
      ownAgentModel: true,
      inherit: SAME_AS_CHAT,
      // One of your agents can answer through an external agent (D249); a subagent can't.
      agents: !def || !isSubagent(def),
    });
    return;
  }
  const feature = kind === "feature" ? AI_FEATURES.find((f) => f.id === name) : undefined;
  if (feature) {
    showModelChooser(anchor, services, {
      for: target,
      title: `the model for ${feature.label}`,
      current: settings.peek<string>(FEATURE_MODEL_SETTING[feature.id]) || null,
      inherit: SAME_AS_CHAT,
      // Commit messages and memory can be one external agent's prompt (D207).
      agents: AGENT_FEATURES.has(feature.id),
    });
    return;
  }
  void services.dispatcher
    .execute("agent.chooseModel", { for: target })
    .catch((err: unknown) =>
      services.notifications.show("error", err instanceof Error ? err.message : String(err)),
    );
}
