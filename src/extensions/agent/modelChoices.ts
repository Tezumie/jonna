// The model settings in the Settings editor (D216; D288: the chat's model picker): the default
// model, the backup model and each AI feature's model open the same picker as a model chip, with
// the providers' rail, search and favorites, a first row for "nothing of its own", and the external
// agents where a setting can use one (the default model, commit messages, memory tidy-up).
import type { Disposable } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";
import { AGENT_FEATURES } from "./acpOneShot";
import { FEATURE_MODEL_SETTING } from "./languageModel";
import { AI_FEATURES, modelChipLabel } from "./modelChooser";
import { describeModel, type ProviderRegistry } from "./providers";
import { showModelChooser } from "./view/modelPicker";

interface ModelSetting {
  key: string;
  /** Said beside the picker's heading. */
  title: string;
  /** The empty value's name, and what it means. */
  empty: (providers: ProviderRegistry) => { label: string; detail?: string };
  agents: boolean;
}

export function registerModelChoices(
  services: WorkbenchServices,
  providers: ProviderRegistry,
): Disposable[] {
  const sameAsChat = () => ({
    label: "Same as the chat",
    detail: providers.defaultModel()?.model ?? "the chat's default model",
  });
  const settings: ModelSetting[] = [
    {
      key: "agent.model",
      title: "the model new chats start with",
      empty: () => ({
        label: "First available",
        detail: providers.defaultModel()?.model ?? "the first local model",
      }),
      agents: true,
    },
    {
      key: "agent.fallbackModel",
      title: "the backup model at a usage limit",
      empty: () => ({ label: "None", detail: "the turn stops at the limit" }),
      agents: false,
    },
    ...Object.entries(FEATURE_MODEL_SETTING).map(([feature, key]) => ({
      key,
      title: `the model for ${AI_FEATURES.find((f) => f.id === feature)?.label ?? feature}`,
      empty: sameAsChat,
      agents: AGENT_FEATURES.has(feature),
    })),
  ];
  return settings.map((m) =>
    services.settings.registerPicker(m.key, {
      label: (value) => {
        if (!value) {
          const empty = m.empty(providers);
          return { text: empty.label, ...(empty.detail && { detail: empty.detail }) };
        }
        const found = providers.find(value);
        return {
          text: modelChipLabel(services, value),
          detail: found
            ? describeModel(found)
            : value.startsWith("acp/")
              ? "External agent"
              : "Not available now",
        };
      },
      open: (anchor, value, set) => {
        showModelChooser(anchor, services, {
          for: m.key,
          title: m.title,
          current: value || null,
          inherit: m.empty(providers),
          agents: m.agents,
          set: async (model) => set(model),
        });
      },
    }),
  );
}
