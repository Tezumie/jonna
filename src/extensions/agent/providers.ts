// Where models come from: Ollama on this machine (found automatically at agent.ollama.url, default
// http://127.0.0.1:11434 — every installed model appears, no setup) plus any OpenAI-compatible
// endpoints and Anthropic's native API in agent.providers (LM Studio, llama.cpp, vLLM, OpenRouter,
// OpenAI, Anthropic…; API keys are set
// with "Agent: Set API key" and stay in Rust). Model choices are "<provider>/<model>".
import { aiIpc, type ModelDetails, type ModelInfo, type ProviderRef } from "../../core/ipc/agent";
import { type ReadonlySignal, signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";

export interface ModelChoice {
  /** "<providerId>/<modelId>" */
  key: string;
  provider: ProviderRef & { name: string };
  model: string;
  info: ModelInfo;
}

export interface ProviderStatus {
  id: string;
  name: string;
  kind: ProviderRef["kind"];
  baseUrl: string;
  state: "loading" | "ok" | "unreachable" | "error";
  error?: string;
  models: number;
}

interface ConfiguredProvider {
  id: string;
  name?: string;
  kind: "openai" | "ollama" | "anthropic";
  baseUrl: string;
}

export const OLLAMA_ID = "ollama";

export class ProviderRegistry {
  private readonly modelList = signal<readonly ModelChoice[]>([]);
  private readonly statusList = signal<readonly ProviderStatus[]>([]);
  readonly models: ReadonlySignal<readonly ModelChoice[]> = this.modelList;
  readonly statuses: ReadonlySignal<readonly ProviderStatus[]> = this.statusList;
  private readonly details = new Map<string, Promise<ModelDetails>>();
  private refreshing: Promise<void> | null = null;
  /** The provider list the refresh in flight is listing. */
  private refreshingKey = "";
  private refreshedAt = 0;

  constructor(private readonly services: WorkbenchServices) {}

  providers(): (ProviderRef & { name: string })[] {
    const s = this.services.settings;
    const out: (ProviderRef & { name: string })[] = [];
    if (s.peek<boolean>("agent.ollama.enabled") !== false)
      out.push({
        id: OLLAMA_ID,
        name: "Ollama",
        kind: "ollama",
        baseUrl: s.peek<string>("agent.ollama.url") || "http://127.0.0.1:11434",
      });
    const configured = s.peek<ConfiguredProvider[]>("agent.providers");
    for (const p of Array.isArray(configured) ? configured : []) {
      if (!p || typeof p.id !== "string" || typeof p.baseUrl !== "string" || p.id === OLLAMA_ID)
        continue;
      out.push({
        id: p.id,
        name: p.name ?? p.id,
        // Anthropic as OpenAI-compatible (older settings) uses the native API (prompt caching).
        kind:
          p.kind === "ollama"
            ? "ollama"
            : p.kind === "anthropic" || /api\.anthropic\.com/.test(p.baseUrl)
              ? "anthropic"
              : "openai",
        baseUrl: p.baseUrl,
      });
    }
    return out;
  }

  /** Refreshes when the last refresh is older than `maxAgeMs`; waits at most `waitMs` for it. */
  refreshIfStale(maxAgeMs: number, waitMs: number): Promise<void> {
    if (Date.now() - this.refreshedAt < maxAgeMs) return Promise.resolve();
    return Promise.race([this.refresh(), new Promise<void>((done) => setTimeout(done, waitMs))]);
  }

  /** Lists every provider's models (all at once; a slow or missing provider doesn't block others). */
  refresh(): Promise<void> {
    // A refresh already listing other providers (the Ollama address just changed): this one
    // waits for it, then lists the current ones, rather than answering with the old list (D226).
    const key = JSON.stringify(this.providers());
    if (this.refreshing && key !== this.refreshingKey)
      return this.refreshing.then(() => this.refresh());
    this.refreshingKey = key;
    this.refreshing ??= (async () => {
      const providers = this.providers();
      // First load (or a changed provider list) shows "loading"; background refreshes keep the
      // current list on screen until the new one arrives.
      const known = new Set(this.statusList.peek().map((st) => st.id));
      if (!providers.every((p) => known.has(p.id)))
        this.statusList.value = providers.map((p) => ({ ...p, state: "loading", models: 0 }));
      const results = await Promise.all(
        providers.map(async (p) => {
          try {
            const models = await aiIpc.listModels(p);
            return { p, models, status: { ...p, state: "ok" as const, models: models.length } };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const state = /connect/i.test(message) ? ("unreachable" as const) : ("error" as const);
            return {
              p,
              models: [] as ModelInfo[],
              status: { ...p, state, error: message, models: 0 },
            };
          }
        }),
      );
      this.statusList.value = results.map((r) => r.status);
      this.modelList.value = results.flatMap((r) =>
        r.models.map((info) => ({
          key: `${r.p.id}/${info.id}`,
          provider: r.p,
          model: info.id,
          info,
        })),
      );
      this.refreshedAt = Date.now();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  find(key: string): ModelChoice | undefined {
    return this.modelList.peek().find((m) => m.key === key);
  }

  /** Capabilities (tools, thinking, context length), cached per model. */
  detailsFor(choice: ModelChoice): Promise<ModelDetails> {
    let p = this.details.get(choice.key);
    if (!p) {
      p = aiIpc.modelDetails(choice.provider, choice.model).catch(() => ({
        tools: null,
        thinking: null,
        vision: null,
        contextLength: null,
      }));
      this.details.set(choice.key, p);
    }
    return p;
  }

  /** The model to use: the setting if it's available, else the first local model, else any. */
  defaultModel(): ModelChoice | undefined {
    const wanted = this.services.settings.peek<string>("agent.model");
    const models = this.modelList.peek();
    return (
      (wanted ? models.find((m) => m.key === wanted || m.model === wanted) : undefined) ??
      models.find((m) => !m.info.remote) ??
      // Hosted only: OpenRouter's free router before the first model of a long catalog.
      models.find((m) => m.model === "openrouter/free") ??
      models[0]
    );
  }
}

/** "4.9 GB · 8.2B · Q4_K_M" */
export function describeModel(m: ModelChoice): string {
  const parts: string[] = [];
  if (m.info.remote) parts.push("cloud");
  if (m.info.size) parts.push(`${(m.info.size / 1e9).toFixed(1)} GB`);
  if (m.info.parameterSize) parts.push(m.info.parameterSize);
  if (m.info.quantization) parts.push(m.info.quantization);
  return [m.provider.name, ...parts].join(" · ");
}
