// Which models and endpoints suit suggestions as you type (D204): the FIM endpoint a provider
// has, and a fast local code model to suggest among the installed ones. Used by the agent
// extension's language model service (it knows the providers) and the editor (its state and
// hints). DOM-free and tested (editor/ai/fim.test.ts).

export type FimStyle = "ollama" | "openai" | "mistral" | "deepseek";
/** editor.inlineCompletions.fim: "auto" uses FIM where the provider is known to have it. */
export type FimMode = "auto" | "always" | "never";

export interface ProviderInfo {
  kind: "ollama" | "openai" | "anthropic";
  baseUrl: string;
}

/** Which FIM endpoint to use for a provider, or null for the chat prompt. */
export function fimStyle(provider: ProviderInfo, mode: FimMode): FimStyle | null {
  if (mode === "never" || provider.kind === "anthropic") return null;
  if (/api\.anthropic\.com/i.test(provider.baseUrl)) return null;
  if (provider.kind === "ollama") return "ollama";
  if (/(^|\.|\/\/)mistral\.ai(\/|:|$)/i.test(provider.baseUrl)) return "mistral";
  if (/(^|\.|\/\/)deepseek\.com(\/|:|$)/i.test(provider.baseUrl)) return "deepseek";
  // Any other OpenAI-compatible server: only when asked (many ignore `suffix` silently).
  return mode === "always" ? "openai" : null;
}

/** What `suggestCompletionModel` reads from the model list. */
export interface ModelCandidate {
  /** "provider/model". */
  key: string;
  model: string;
  providerKind: "ollama" | "openai" | "anthropic";
  /** Bytes on disk (Ollama). */
  size?: number;
  /** Cloud-hosted (an Ollama ":cloud" model). */
  remote?: boolean;
}

/** Code models trained for fill-in-the-middle. */
const FIM_MODEL =
  /(qwen2\.5-coder|qwen3-coder|deepseek-coder|starcoder|codegemma|codellama|code-?llama|codestral|stable-code|granite[\w.-]*code|codeqwen)/i;

/** What to install when nothing suits (Ollama's tag). */
export const RECOMMENDED_COMPLETION_MODEL = "qwen2.5-coder:1.5b-base";

/**
 * A fast model for suggestions among the installed ones: a local FIM-trained code model, the
 * smallest that isn't tiny (a 0.5B model guesses poorly), else the smallest. Null: none.
 */
export function suggestCompletionModel(models: readonly ModelCandidate[]): string | null {
  const fit = models.filter(
    (m) => m.providerKind === "ollama" && !m.remote && FIM_MODEL.test(m.model),
  );
  if (!fit.length) return null;
  const size = (m: ModelCandidate) => m.size ?? Number.MAX_SAFE_INTEGER;
  const sorted = [...fit].sort((a, b) => size(a) - size(b));
  return (sorted.find((m) => size(m) >= 800_000_000) ?? sorted[0])?.key ?? null;
}
