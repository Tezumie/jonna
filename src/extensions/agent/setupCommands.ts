// AI setup (D164): connecting and removing model providers without prompts (the setup page and
// the first-run card call these), finding Ollama and the agent CLIs, pulling a starter model, and
// opening the "AI models" page. Keys go to the native side (never into settings).

import { aiIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { execIpc } from "../../core/ipc/process";
import { dialogIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { isAbsolute } from "../../core/paths/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { ACP_PRESETS } from "./acpAgents";
import {
  AGENT_SETUP,
  brandPresetFor,
  connectError,
  PROVIDER_PRESETS,
  providerId,
  STARTER_OLLAMA_MODEL,
  withoutProvider,
  withProvider,
} from "./catalog";
import { openCustomize } from "./customize";
import { IMAGE_EXTENSIONS, imageDataUrl, isImageDataUrl, MAX_IMAGE_BYTES } from "./providerImage";
import { matchPresets } from "./providerMatch";
import { OLLAMA_ID, type ProviderRegistry } from "./providers";

/** What the setup UI shows besides the providers' statuses (D164). */
export class SetupState {
  /** Programs found on this machine (ollama, claude, codex…); null until looked up. */
  readonly installed = signal<ReadonlyMap<string, boolean> | null>(null);
  /** The chat showing the first-run card on demand ("AI: Show setup"), even with models. */
  readonly preview = signal<string | null>(null);
  /** Bumped when a provider's own image changes (they live in the global state, D212). */
  readonly images = signal(0);
}

/** The image the user picked for a provider (D212), if any. */
export function providerImage(services: WorkbenchServices, id: string): string | undefined {
  const url = services.persistence.globalState().providerImages?.[id];
  return isImageDataUrl(url) ? url : undefined;
}

async function saveProviderImage(
  services: WorkbenchServices,
  setup: SetupState,
  id: string,
  dataUrl: string | null,
): Promise<void> {
  await services.persistence.saveGlobal((current) => {
    const images = { ...(current.providerImages ?? {}) };
    if (dataUrl) images[id] = dataUrl;
    else delete images[id];
    return { providerImages: images };
  });
  setup.images.value++;
}

export function registerSetupCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  providers: ProviderRegistry,
  setup: SetupState,
): void {
  const { dispatcher, settings } = services;
  const register: typeof dispatcher.register = (c) =>
    sub.add(dispatcher.register({ category: "AI", ...c }));

  register({
    id: "agent.showSetup",
    title: "Models and providers",
    description:
      "Opens the AI models page: connected providers, adding one with a key, Ollama, and agent CLIs (Claude Code, Codex, Gemini CLI, GitHub Copilot). `firstRun` shows the agent panel's first-run card instead (a preview, even with models).",
    input: s.object({ firstRun: s.boolean().optional() }),
    effects: [],
    agent: "hidden",
    run: async ({ firstRun }, ctx) => {
      if (firstRun) {
        const opened = (await ctx.execute("agent.newSession", {})) as { session?: string } | null;
        setup.preview.value = opened?.session ?? null;
        return { shown: "firstRun", session: opened?.session };
      }
      return { shown: "page", ...openCustomize(services, "models") };
    },
  });

  register({
    id: "agent.previewSetup",
    title: "Preview first-run setup",
    description:
      "Opens a new chat showing the first-run setup card, as a new user without models sees it (even when models are set up). Close preview hides it.",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    run: (_input, ctx) => ctx.execute("agent.showSetup", { firstRun: true }),
  });

  register({
    id: "agent.closeSetupPreview",
    title: "Close AI setup preview",
    description: "Hides the first-run card shown by agent.showSetup { firstRun: true }.",
    input: s.empty(),
    effects: [],
    agent: "hidden",
    palette: false,
    run: () => {
      setup.preview.value = null;
    },
  });

  register({
    id: "agent.connectProvider",
    title: "Connect model provider",
    description: `Connects a provider without prompts: a preset \`id\` (${PROVIDER_PRESETS.map((p) => p.id).join(", ")}; azure and bedrock also take their \`baseUrl\`) or a custom \`name\` + \`baseUrl\`, with its \`apiKey\` and, for a custom one, an optional \`image\` (a data URL from agent.chooseProviderImage). The key is checked by listing the models first; nothing is saved if that fails. Returns the model count, or the reason it failed.`,
    input: s.object({
      id: s.string().optional(),
      name: s.string().optional(),
      baseUrl: s.string().optional(),
      apiKey: s.string().describe("Stored outside settings; never shown again").optional(),
      image: s.string().describe("A PNG/SVG/JPEG/WebP data URL shown as its logo").optional(),
    }),
    effects: ["write", "network"],
    agent: "hidden",
    run: async ({ id, name, baseUrl, apiKey, image }) => {
      const preset = PROVIDER_PRESETS.find((p) => p.id === id);
      const url = (baseUrl ?? preset?.baseUrl ?? "").trim().replace(/\/+$/, "");
      if (!/^https?:\/\/\S+$/.test(url))
        return {
          ok: false,
          error: preset?.editAddress
            ? `Type your ${preset.name} address.`
            : "Type an http(s) address.",
        };
      const label = name?.trim() || preset?.name || new URL(url).hostname;
      const pid = id ?? providerId(label);
      if (pid === OLLAMA_ID) return { ok: false, error: "Ollama is found automatically." };
      const kind = preset?.kind ?? (/api\.anthropic\.com/.test(url) ? "anthropic" : "openai");
      const key = apiKey?.trim() ?? "";
      if (preset?.needsKey && !key && !(await aiIpc.hasKey(pid).catch(() => false)))
        return { ok: false, error: `Paste your ${label} API key.` };
      const already = providers.providers().some((p) => p.id === pid);
      // A new key is checked under a scratch id first: a mistyped key never replaces a working
      // one, and nothing is saved for a provider that doesn't answer.
      const probe = key ? `${pid}.check` : pid;
      if (key) await aiIpc.setKey(probe, key);
      try {
        const models = await aiIpc.listModels({ id: probe, kind, baseUrl: url });
        if (key) {
          await aiIpc.setKey(pid, key);
          await aiIpc.setKey(probe, null).catch(() => {});
        }
        await settings.update(
          "agent.providers",
          withProvider(settings.peek<unknown>("agent.providers"), {
            id: pid,
            name: label,
            kind,
            baseUrl: url,
          }),
          "user",
        );
        if (image && isImageDataUrl(image)) await saveProviderImage(services, setup, pid, image);
        await providers.refresh();
        // The first provider (or one with a natural first model) gives the default model when
        // none that's available is chosen.
        const wanted = settings.peek<string>("agent.model");
        const available = providers.models.peek();
        if (!(wanted && (wanted.startsWith("acp/") || available.some((m) => m.key === wanted)))) {
          const mine = available.filter((m) => m.provider.id === pid);
          const pick =
            mine.find((m) => m.model === preset?.defaultModel) ??
            mine.find((m) => !/embed|whisper|tts|dall-e|image|moderation|audio/i.test(m.model));
          if (pick) await settings.update("agent.model", pick.key, "user");
        }
        return { ok: true, id: pid, models: models.length };
      } catch (err) {
        if (key) await aiIpc.setKey(probe, null).catch(() => {});
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, id: pid, error: connectError(message), detail: message, already };
      }
    },
  });

  register({
    id: "agent.removeProvider",
    title: "Remove model provider",
    description: "Removes a provider from agent.providers and forgets its API key.",
    input: s.object({ id: s.string() }),
    effects: ["write"],
    agent: "hidden",
    run: async ({ id }) => {
      await settings.update(
        "agent.providers",
        withoutProvider(settings.peek<unknown>("agent.providers"), id),
        "user",
      );
      await aiIpc.setKey(id, null).catch(() => {});
      if (providerImage(services, id)) await saveProviderImage(services, setup, id, null);
      // Its model was the default: the next available one takes over.
      if (settings.peek<string>("agent.model")?.startsWith(`${id}/`))
        await settings.update("agent.model", undefined, "user").catch(() => {});
      await providers.refresh();
      return { removed: id };
    },
  });

  register({
    id: "agent.forgetProviders",
    title: "Remove all model providers and API keys",
    description:
      "Removes every connected model provider (agent.providers) and forgets every stored API key (the reset option in Settings, D166).",
    input: s.empty(),
    effects: ["write", "destructive"],
    agent: "hidden",
    palette: false,
    run: async () => {
      const ids = new Set([
        ...providers.providers().map((p) => p.id),
        ...PROVIDER_PRESETS.map((p) => p.id),
      ]);
      for (const id of ids) {
        await aiIpc.setKey(id, null).catch(() => {});
        await aiIpc.setKey(`${id}.check`, null).catch(() => {});
      }
      await settings.update("agent.providers", undefined, "user").catch(() => {});
      await services.persistence.saveGlobal({ providerImages: {} });
      setup.images.value++;
      await providers.refresh();
      return { removed: [...ids] };
    },
  });

  register({
    id: "agent.chooseProviderImage",
    title: "Choose an image for a model provider",
    description: `Asks for an image file (${IMAGE_EXTENSIONS.join(", ")}, up to ${MAX_IMAGE_BYTES / 1024} KB) to show as a custom provider's logo, and returns it as a data URL (\`dataUrl\`) for agent.connectProvider's \`image\`; nothing is saved. \`path\` (absolute, or relative to the open folder) skips the file dialog. Returns { cancelled: true } when nothing was picked, or { ok: false, error }.`,
    input: s.object({ path: s.string().optional() }),
    effects: ["read"],
    agent: "hidden",
    palette: false,
    run: async ({ path }) => {
      const root = services.workspace.root.peek();
      const picked =
        (path && (root && !isAbsolute(path) ? services.workspace.resolve(path) : path)) ||
        (await dialogIpc.pickFile("Choose an image", undefined, [
          { name: "Images", extensions: [...IMAGE_EXTENSIONS] },
        ]));
      if (!picked) return { cancelled: true };
      try {
        const real = await fsIpc.allowFile(picked);
        if ((await fsIpc.stat(real)).size > MAX_IMAGE_BYTES)
          return {
            ok: false,
            error: `That image is over ${MAX_IMAGE_BYTES / 1024} KB. Pick a smaller one.`,
          };
        return imageDataUrl(real, await fsIpc.read(real));
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  register({
    id: "agent.setProviderImage",
    title: "Set a model provider's image",
    description:
      "Shows an image the user picks (or the file at `path`) as a connected provider's logo, kept on this computer; `clear` goes back to its letter badge. A provider that is a known service already shows that service's logo.",
    input: s.object({
      id: s.string(),
      path: s.string().optional(),
      clear: s.boolean().optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: async ({ id, path, clear }, ctx) => {
      if (!providers.providers().some((p) => p.id === id))
        return { ok: false, error: `No provider with id ${id}.` };
      if (clear) {
        await saveProviderImage(services, setup, id, null);
        return { ok: true, cleared: id };
      }
      const chosen = (await ctx.execute("agent.chooseProviderImage", path ? { path } : {})) as {
        ok?: boolean;
        dataUrl?: string;
        error?: string;
        cancelled?: boolean;
      };
      if (!chosen.ok || !chosen.dataUrl) return { ...chosen, ok: false };
      await saveProviderImage(services, setup, id, chosen.dataUrl);
      return { ok: true, id };
    },
  });

  register({
    id: "agent.matchProviderPresets",
    title: "Find a model provider preset",
    description:
      'The provider presets a typed name could mean, best first ("groqai" is Groq, "together" Together AI), each with its id, name, base URL and a 0-100 score; with `baseUrl`, also the preset whose service that address is (api.groq.com is groq).',
    input: s.object({ name: s.string().optional(), baseUrl: s.string().optional() }),
    effects: [],
    agent: "hidden",
    palette: false,
    run: ({ name, baseUrl }) => ({
      matches: matchPresets(name ?? "").map((m) => ({
        id: m.preset.id,
        name: m.preset.name,
        baseUrl: m.preset.baseUrl,
        score: m.score,
      })),
      ...(baseUrl !== undefined && {
        forAddress: brandPresetFor({ id: "", name: "", baseUrl })?.id ?? null,
      }),
    }),
  });

  sub.add(
    services.state.register("ide://agent/providerPresets", {
      description:
        "The model provider presets the AI models page offers (D212): id, name, base URL, whether a key is needed, whether it's on the first rows (featured) or under View more, and whether it's connected; plus each connected provider's preset (matched by id, address, host or name) and whether it has an image of its own.",
      get: () => {
        const configured = providers.providers();
        return {
          presets: PROVIDER_PRESETS.map((p) => ({
            id: p.id,
            name: p.name,
            baseUrl: p.baseUrl,
            needsKey: p.needsKey,
            featured: p.featured === true,
            connected: configured.some((c) => brandPresetFor(c)?.id === p.id),
          })),
          providers: configured.map((c) => ({
            id: c.id,
            name: c.name,
            preset: brandPresetFor(c)?.id ?? null,
            image: !!providerImage(services, c.id),
          })),
        };
      },
    }),
  );

  register({
    id: "agent.detectTools",
    title: "Find Ollama and agent CLIs",
    description:
      "Looks for Ollama and the agent CLIs (claude, codex, gemini, copilot) on this machine; the setup page shows the result.",
    input: s.empty(),
    effects: ["read"],
    agent: "hidden",
    palette: false,
    run: async () => {
      const names = ["ollama", ...ACP_PRESETS.map((p) => AGENT_SETUP[p.name]?.program ?? "")];
      const found = await execIpc.installed(names).catch(() => names.map(() => false));
      const map = new Map(names.map((n, i) => [n, found[i] === true]));
      setup.installed.value = map;
      return Object.fromEntries(map);
    },
  });

  register({
    id: "agent.pullStarterModel",
    title: "Download a starter model (Ollama)",
    description: `Runs \`ollama pull ${STARTER_OLLAMA_MODEL}\` in a terminal; the model appears once it's downloaded.`,
    input: s.object({ model: s.string().optional() }),
    effects: ["exec"],
    agent: "hidden",
    run: async ({ model }) => {
      const name = model ?? STARTER_OLLAMA_MODEL;
      if (!/^[\w.:/-]+$/.test(name)) throw new Error("Not a model name.");
      // Not awaited: a download takes minutes; the terminal shows its progress.
      void dispatcher
        .execute("terminal.runCommand", { command: `ollama pull ${name}` })
        .catch(() => {});
      return { pulling: name };
    },
  });

  register({
    id: "agent.signInAgent",
    title: "Sign in to an agent CLI",
    description:
      "Runs an agent CLI's own sign-in (Claude Code's `claude /login`, `codex login`…) in a terminal, where the user follows it.",
    input: s.object({ name: s.string() }),
    effects: ["exec"],
    agent: "hidden",
    run: async ({ name }) => {
      const info = AGENT_SETUP[name];
      if (!info) throw new Error(`No agent named ${name}.`);
      void dispatcher.execute("terminal.runCommand", { command: info.signIn }).catch(() => {});
      return { signingIn: name };
    },
  });

  register({
    id: "agent.signOutAgent",
    title: "Sign out of an agent CLI",
    description:
      "Runs an agent CLI's own sign-out (Claude Code's `claude /logout`, `codex logout`…) in a terminal (D401). Gemini CLI has none: its sign-in (/auth) changes the account.",
    input: s.object({ name: s.string() }),
    effects: ["exec"],
    agent: "hidden",
    run: async ({ name }) => {
      const info = AGENT_SETUP[name];
      if (!info) throw new Error(`No agent named ${name}.`);
      if (!info.signOut)
        throw new Error(`${name} has no sign-out of its own: Sign in changes the account.`);
      void dispatcher.execute("terminal.runCommand", { command: info.signOut }).catch(() => {});
      return { signingOut: name };
    },
  });

  register({
    id: "agent.installAgent",
    title: "Install an agent CLI",
    description:
      "Runs the install command of an agent CLI (Claude Code, Codex, Gemini CLI, GitHub Copilot) in a terminal, then its sign-in.",
    input: s.object({ name: s.string() }),
    effects: ["exec"],
    agent: "hidden",
    run: async ({ name }) => {
      const info = AGENT_SETUP[name];
      if (!info) throw new Error(`No agent named ${name}.`);
      // Two commands, one after the other: a joining ";" is a separator in PowerShell and the
      // POSIX shells but an argument to npm in cmd.exe ("&&" isn't valid in PowerShell 5.1).
      void (async () => {
        await dispatcher.execute("terminal.runCommand", { command: info.install });
        // Installed: the setup page and the chat's card show it now, not after a restart.
        await dispatcher.execute("agent.detectTools", {}).catch(() => {});
        await dispatcher.execute("terminal.runCommand", { command: info.signIn });
      })().catch(() => {});
      return { installing: name };
    },
  });
}
