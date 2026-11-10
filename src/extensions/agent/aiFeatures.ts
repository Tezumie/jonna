// AI features outside the chat (D230, like VS Code's Copilot status menu): a sparkle in the status
// bar opens a list of the features that call a model — Edit with AI, suggestions as you type,
// next-edit suggestions, commit messages, memory tidy-up — each with a check when it's on; picking
// one turns it on or off, and "Choose models…" opens their settings. The switches are the same
// settings as Settings → AI in the editor (they moved off the Agents page, which is about agents).
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

interface AiFeature {
  setting: string;
  label: string;
  detail: string;
}

export const AI_FEATURES: readonly AiFeature[] = [
  { setting: "editor.inlineEdit.enabled", label: "Edit with AI", detail: "Ctrl+K in the editor" },
  {
    setting: "editor.inlineCompletions.enabled",
    label: "Suggestions as you type",
    detail: "Ghost text in the editor",
  },
  {
    setting: "editor.nextEdit.enabled",
    label: "Next-edit suggestions",
    detail: "Tab to the next change",
  },
  {
    setting: "git.aiCommitMessage.enabled",
    label: "Commit messages",
    detail: "Generate in Source control",
  },
  {
    setting: "agent.memory.autoTidyUp",
    label: "Memory tidy-up",
    detail: "Daily, you review the changes",
  },
];

export function registerAiFeatures(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, settings, quickInput, statusBar, state } = services;
  const on = (f: AiFeature) => settings.peek<boolean>(f.setting) === true;

  sub.add(
    dispatcher.register({
      id: "agent.aiFeatures",
      title: "AI features…",
      category: "AI",
      description:
        "Lists the AI features outside the chat (Edit with AI, suggestions as you type, next-edit suggestions, commit messages, memory tidy-up) with whether each is on; picking one turns it on or off. `toggle` (a setting key from ide://ai/features) does that without asking; `models` opens their settings.",
      input: s.object({
        toggle: s.string().describe("A feature's setting key, to turn on or off").optional(),
        models: s.boolean().describe("Open the AI features settings").optional(),
      }),
      effects: ["write"],
      agent: "hidden",
      run: async ({ toggle, models }, ctx) => {
        if (models) return ctx.execute("settings.open", { category: "AI features" });
        let key = toggle;
        if (!key) {
          const picked = await quickInput.pick(
            [
              ...AI_FEATURES.map((f) => ({
                id: f.setting,
                label: f.label,
                description: on(f) ? "On" : "Off",
                detail: f.detail,
                icon: on(f) ? ("circle-check" as const) : ("circle-dashed" as const),
              })),
              {
                id: "models",
                label: "Choose models…",
                detail: "Which model each feature uses",
                icon: "settings" as const,
              },
            ],
            { placeholder: "AI features: pick one to turn it on or off" },
          );
          if (!picked) return null;
          if (picked.id === "models")
            return ctx.execute("settings.open", { category: "AI features" });
          key = picked.id;
        }
        const feature = AI_FEATURES.find((f) => f.setting === key);
        if (!feature) throw new Error(`Not an AI feature: ${key} (see ide://ai/features).`);
        const next = !on(feature);
        await ctx.execute("settings.set", { key: feature.setting, value: next });
        return { feature: feature.label, enabled: next };
      },
    }),
  );

  sub.add(
    statusBar.add({
      id: "agent.aiFeatures",
      name: "AI features",
      alignment: "right",
      priority: 14,
      text: () => {
        for (const f of AI_FEATURES) settings.get(f.setting);
        return "$(sparkles)";
      },
      tooltip: () => {
        const enabled = AI_FEATURES.filter(on).map((f) => f.label);
        return enabled.length
          ? `AI features: ${enabled.join(", ")}`
          : "AI features: all off (click to choose)";
      },
      command: "agent.aiFeatures",
    }),
  );

  sub.add(
    state.register("ide://ai/features", {
      description:
        "The AI features outside the chat and whether each is on (agent.aiFeatures { toggle: setting } turns one on or off).",
      get: () => AI_FEATURES.map((f) => ({ ...f, enabled: on(f) })),
    }),
  );
}
