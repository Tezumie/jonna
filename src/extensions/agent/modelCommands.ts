// agent.* commands for models and providers (split from commands.ts in D221): refresh, select
// (including external ACP agents and feature models), add an OpenAI-compatible provider, store
// an API key.

import { aiIpc } from "../../core/ipc/agent";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { externalAgents } from "./acpAgents";
import { AGENT_FEATURES, agentFor } from "./acpOneShot";
import { PROVIDER_PRESETS } from "./catalog";
import { FEATURE_MODEL_SETTING } from "./languageModel";
import { agentPickKey, toggledFavorite, withRecent } from "./modelPicks";
import { describeModel, type ProviderRegistry } from "./providers";
import type { SessionManager } from "./sessions";

export function registerModelCommands(
  register: WorkbenchServices["dispatcher"]["register"],
  services: WorkbenchServices,
  sessions: SessionManager,
  providers: ProviderRegistry,
): void {
  const { quickInput, settings, notifications } = services;
  const sessionInput = s.string().describe("Session id (default: the active session)").optional();
  /** The model picker's Recent list (D227). */
  const remember = (key: string) =>
    settings
      .update("agent.recentModels", withRecent(settings.peek("agent.recentModels"), key), "user")
      .catch(() => {});
  register({
    id: "agent.toggleFavoriteModel",
    title: "Star or unstar a model",
    description:
      "Adds a model to the model picker's favorites, or takes it out (agent.favoriteModels). `model`: provider/model, acp/<agent>, or acp/<agent>#<its own model id>.",
    input: s.object({ model: s.string().describe("The model's key") }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ model }) => {
      const next = toggledFavorite(settings.peek("agent.favoriteModels"), model);
      await settings.update("agent.favoriteModels", next, "user");
      return { model, favorite: next.includes(model) };
    },
  });
  register({
    id: "agent.refreshModels",
    title: "Refresh agent models",
    description: "Lists the models of Ollama and the configured providers again.",
    input: s.empty(),
    effects: ["read"],
    run: async () => {
      await providers.refresh();
      return providers.models.peek().map((m) => ({ model: m.key, info: describeModel(m) }));
    },
  });

  register({
    id: "agent.selectModel",
    title: "Select agent model…",
    description:
      "Sets the model of a session (and the default for new ones). Lists the models when `model` is omitted.",
    input: s.object({
      model: s.string().describe("provider/model, e.g. ollama/qwen3:8b").optional(),
      session: sessionInput,
      provider: s.string().describe("Only list this provider's models").optional(),
      agentModel: s
        .string()
        .describe("With acp/<agent>: that agent's own model (see agent.setAgentModel)")
        .optional(),
      agentLevel: s.string().describe("With acp/<agent>: its reasoning level").optional(),
    }),
    effects: [],
    agent: "hidden",
    run: async ({ model, session, provider, agentModel, agentLevel }) => {
      await providers.refreshIfStale(5000, 3000);
      let key = model;
      if (!key) {
        const picked = await quickInput.pick(
          providers.models
            .peek()
            .filter((m) => !provider || m.provider.id === provider)
            .map((m) => ({ id: m.key, label: m.model, description: describeModel(m) })),
          { placeholder: provider ? "Search models" : "Select a model" },
        );
        if (!picked) return null;
        key = picked.id;
      }
      if (key.startsWith("acp/")) {
        const name = key.slice(4);
        if (!externalAgents(services).some((x) => x.name === name))
          throw new Error(`No external agent named ${name}.`);
        const target = sessions.find(session);
        if (target) {
          target.model.value = key;
          void target.save();
          // Its own model first (a launch-flag one must be known before it starts), then it
          // starts so the menu knows its models (D193, D194).
          if (agentModel !== undefined) await target.setAgentSetting("model", agentModel);
          if (agentLevel !== undefined) await target.setAgentSetting("thought_level", agentLevel);
          void target.prepareExternal().catch(() => {});
        }
        // New chats start with it too: the main agent (D196).
        await settings.update("agent.model", key, "user").catch(() => {});
        await remember(agentPickKey(name, agentModel));
        return { model: key };
      }
      const choice = providers.find(key) ?? providers.models.peek().find((m) => m.model === key);
      if (!choice) throw new Error(`Model ${key} isn't available (see "Refresh agent models").`);
      const sess = sessions.find(session);
      // The chat remembers it (a reopened chat used its old model).
      if (sess) {
        sess.model.value = choice.key;
        void sess.save();
      }
      await settings.update("agent.model", choice.key, "user").catch(() => {});
      await remember(choice.key);
      return { model: choice.key };
    },
  });

  register({
    id: "agent.setAgentModel",
    title: "Select the external agent's model…",
    description:
      "For a chat with an external agent (Claude Code, Codex, Gemini CLI, Copilot): sets the model it uses, or with `setting: thought_level` its reasoning level, from the choices it offers (`ide://agent/session` agentSettings). Lists them when `value` is omitted. Remembered for that agent's next chats (agent.externalAgentChoices).",
    input: s.object({
      value: s.string().describe("A choice's id, from agentSettings").optional(),
      setting: s.enum(["model", "thought_level"]).describe("Default model").optional(),
      session: sessionInput,
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ value, setting, session }) => {
      const target = sessions.find(session);
      if (!target) throw new Error("No agent chat.");
      const category = setting ?? "model";
      if (value === undefined) await target.prepareExternal();
      let pick = value;
      if (pick === undefined) {
        const offered = target.agentSettings.peek()?.settings.find((x) => x.category === category);
        if (!offered) throw new Error("This agent doesn't offer a choice here.");
        const picked = await quickInput.pick(
          offered.options.map((o) => ({
            id: o.id,
            label: o.id === offered.current ? `${o.name}  ✓` : o.name,
            ...((o.description ?? o.group) && { description: o.description ?? o.group }),
          })),
          { placeholder: category === "model" ? "Select a model" : "Select a reasoning level" },
        );
        if (!picked) return null;
        pick = picked.id;
      }
      await target.setAgentSetting(category, pick);
      return { [category]: pick };
    },
  });

  register({
    id: "agent.selectFeatureModel",
    title: "Select the model for an AI feature…",
    description:
      "Sets which model an AI feature outside the chat uses (D174): `feature` edit (Edit with AI, Ctrl+K), completion (suggestions as you type), commit (Generate commit message), nextEdit or memory. `model` as provider/model, or empty for the chat's default model; for commit and memory also `acp/<agent>` (Claude Code, Codex, Gemini CLI, GitHub Copilot answer one prompt, D207). Lists the choices when omitted.",
    input: s.object({
      feature: s.enum(["edit", "completion", "commit", "nextEdit", "memory"]),
      model: s.string().describe("provider/model; empty: the chat's default model").optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ feature, model }) => {
      let key = model;
      if (key === undefined) {
        await providers.refreshIfStale(5000, 3000);
        const current = settings.peek<string>(FEATURE_MODEL_SETTING[feature]) ?? "";
        const picked = await quickInput.pick(
          [
            {
              id: "",
              label: "Same as the chat",
              description: providers.defaultModel()?.model ?? "the default model",
            },
            ...providers.models
              .peek()
              .filter((m) => !m.key.startsWith("acp/"))
              .map((m) => ({ id: m.key, label: m.model, description: describeModel(m) })),
            // An agent you have (D207): commit messages and memory, which aren't typed against.
            ...(AGENT_FEATURES.has(feature)
              ? externalAgents(services).map((a, i) => ({
                  id: `acp/${a.name}`,
                  label: a.name,
                  description: "external agent · its own sign-in · slower",
                  ...(i === 0 && { separator: "Agents" }),
                }))
              : []),
          ].map((it) => (it.id === current ? { ...it, label: `${it.label}  ✓` } : it)),
          { placeholder: "Select the model for this feature" },
        );
        if (!picked) return null;
        key = picked.id;
      }
      if (
        key &&
        !(AGENT_FEATURES.has(feature) && agentFor(services, key)) &&
        !(providers.find(key) ?? providers.models.peek().find((m) => m.model === key))
      )
        throw new Error(`Model ${key} isn't available (see "Refresh agent models").`);
      await settings.update(FEATURE_MODEL_SETTING[feature], key, "user");
      return { feature, model: key || null };
    },
  });

  register({
    id: "agent.addProvider",
    title: "Add model provider…",
    description:
      "Adds a model provider to agent.providers: a preset (OpenRouter, OpenAI, Anthropic, Groq, Mistral, DeepSeek, Azure OpenAI, LM Studio, vLLM… see ide://agent/providerPresets) or any OpenAI-compatible base URL, and asks for its API key when it needs one.",
    input: s.object({
      id: s.string().optional(),
      name: s.string().optional(),
      baseUrl: s.string().optional(),
      apiKey: s.string().describe("Stored outside settings; never shown again").optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ id, name, baseUrl, apiKey }) => {
      // Presets for the common hosted and local servers; "Other" asks for any base URL.
      let preset = PROVIDER_PRESETS.find((p) => p.baseUrl === baseUrl || p.id === id);
      if (!baseUrl && !preset) {
        const picked = await quickInput.pick(
          [
            ...PROVIDER_PRESETS.map((p) => ({
              id: p.id,
              label: p.name,
              description: p.baseUrl || (p.addressPlaceholder ?? ""),
            })),
            { id: "\u0000other", label: "Other OpenAI-compatible server…", description: "" },
          ],
          { placeholder: "Which provider?" },
        );
        if (!picked) return null;
        preset = PROVIDER_PRESETS.find((p) => p.id === picked.id);
      }
      const url =
        baseUrl ??
        // Azure's and Bedrock's address is the user's own resource or region (D212): asked.
        (preset?.editAddress ? undefined : preset?.baseUrl) ??
        (await quickInput.prompt({
          prompt: preset?.editAddress
            ? `Your ${preset.name} address`
            : "Base URL of an OpenAI-compatible API",
          ...(preset?.baseUrl && { value: preset.baseUrl }),
          placeholder:
            preset?.addressPlaceholder ??
            "http://127.0.0.1:1234/v1 (LM Studio) · https://openrouter.ai/api/v1",
          validate: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : "Type an http(s) URL."),
        }));
      if (!url) return null;
      const label =
        name ??
        preset?.name ??
        (await quickInput.prompt({ prompt: "Name", value: new URL(url.trim()).hostname })) ??
        "Provider";
      const pid =
        id ??
        preset?.id ??
        (label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") ||
          "provider");
      // Hosted APIs need a key: ask for it now (stored by the native side, never in settings).
      if (preset?.needsKey || apiKey) {
        const key =
          apiKey ??
          (await quickInput.prompt({
            prompt: `API key for ${label}${preset?.keyHint ? ` (${preset.keyHint})` : ""}`,
            placeholder: preset?.keyPlaceholder ?? "sk-…",
          }));
        if (key === undefined) return null;
        if (key.trim()) await aiIpc.setKey(pid, key.trim());
      }
      const list = (settings.peek<unknown[]>("agent.providers") ?? []).filter(
        (p) => (p as { id?: string } | null)?.id !== pid,
      );
      await settings.update(
        "agent.providers",
        [...list, { id: pid, name: label, kind: preset?.kind ?? "openai", baseUrl: url.trim() }],
        "user",
      );
      await providers.refresh();
      // A provider with a natural first model (OpenRouter's free router) becomes the default
      // unless a model that's available is already chosen.
      const wanted = settings.peek<string>("agent.model");
      const available = providers.models.peek();
      const suggested = preset?.defaultModel
        ? available.find((m) => m.provider.id === pid && m.model === preset?.defaultModel)
        : undefined;
      if (
        suggested &&
        !(wanted && (wanted.startsWith("acp/") || available.some((m) => m.key === wanted)))
      )
        await settings.update("agent.model", suggested.key, "user");
      const status = providers.statuses.peek().find((x) => x.id === pid);
      if (status?.state !== "ok")
        notifications.show(
          "warning",
          `${label}: ${status?.error ?? "no answer"}. If it needs a key, use "Set model provider API key…".`,
        );
      return {
        id: pid,
        models: providers.models.peek().filter((m) => m.provider.id === pid).length,
      };
    },
  });

  register({
    id: "agent.setApiKey",
    title: "Set model provider API key…",
    description:
      "Stores an API key for a provider (kept in app data, outside settings; never shown again).",
    input: s.object({ provider: s.string().optional() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ provider }) => {
      const ids = providers
        .providers()
        .map((p) => ({ id: p.id, label: p.name, description: p.baseUrl }));
      const pid = provider ?? (await quickInput.pick(ids, { placeholder: "Which provider?" }))?.id;
      if (!pid) return null;
      const key = await quickInput.prompt({
        prompt: `API key for ${pid} (empty removes it)`,
        placeholder: "sk-…",
      });
      if (key === undefined) return null;
      await aiIpc.setKey(pid, key.trim() || null);
      await providers.refresh();
      return { provider: pid, stored: !!key.trim() };
    },
  });
}
