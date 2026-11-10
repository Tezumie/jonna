// Text generation for editor features (D106): inline edit (Ctrl+K) and ghost-text completions use
// the same providers as the agent, and so do commit messages. Each has its own model setting
// (editor.inlineEdit.model, editor.inlineCompletions.model, git.aiCommitMessage.model, chosen on
// the AI models page, D174); empty uses the agent's model. No tools, no thinking, short
// outputs, cancellable.

import { type FimMode, fimStyle, suggestCompletionModel } from "../../core/agent/completionModels";
import { aiIpc } from "../../core/ipc/agent";
import type {
  FillRequest,
  GenerateRequest,
  LanguageModelService,
  WorkbenchServices,
} from "../../workbench/services";
import { AGENT_FEATURES, agentFor, runAgentPrompt } from "./acpOneShot";
import { newId } from "./ids";
import type { ModelChoice, ProviderRegistry } from "./providers";
import { RepetitionWatch } from "./repetition";
import { priceOf } from "./usage";
import { recordUsage } from "./usageLog";

/** The setting naming each feature's model (empty: the agent's model). */
export const FEATURE_MODEL_SETTING: Record<GenerateRequest["purpose"], string> = {
  edit: "editor.inlineEdit.model",
  completion: "editor.inlineCompletions.model",
  commit: "git.aiCommitMessage.model",
  nextEdit: "editor.nextEdit.model",
  memory: "agent.memory.model",
  // /btw (D389) answers with the chat's own model (`request.model`).
  aside: "",
};

export function createLanguageModel(
  services: WorkbenchServices,
  providers: ProviderRegistry,
): LanguageModelService {
  /** Why the completion model is the one it is (ide://editor/inlineCompletions). */
  let picked: "setting" | "suggested" | "default" | null = null;
  const choose = (purpose: GenerateRequest["purpose"]): ModelChoice | undefined => {
    const wanted = services.settings.peek<string>(FEATURE_MODEL_SETTING[purpose]);
    if (wanted) {
      if (purpose === "completion") picked = "setting";
      return providers.find(wanted) ?? providers.models.peek().find((m) => m.model === wanted);
    }
    // Suggestions as you type want a fast model (D204): a small local code model when one is
    // installed, rather than the agent's (often big, or paid per token) one.
    if (purpose === "completion") {
      const suggested = suggestCompletionModel(
        providers.models.peek().map((m) => ({
          key: m.key,
          model: m.model,
          providerKind: m.provider.kind,
          ...(typeof m.info.size === "number" && { size: m.info.size }),
          remote: m.info.remote,
        })),
      );
      const found = suggested ? providers.find(suggested) : undefined;
      picked = found ? "suggested" : "default";
      if (found) return found;
    }
    return providers.defaultModel();
  };
  /** Models whose provider answered "no FIM" this run: they get the chat prompt (D204). */
  const noFim = new Set<string>();
  const fimMode = (): FimMode => {
    const v = services.settings.peek<string>("editor.inlineCompletions.fim");
    return v === "always" || v === "never" ? v : "auto";
  };
  const styleFor = (choice: ModelChoice) =>
    noFim.has(choice.key) ? null : fimStyle(choice.provider, fimMode());
  return {
    model: (purpose) => {
      const wanted = services.settings.peek<string>(FEATURE_MODEL_SETTING[purpose]) ?? "";
      if (AGENT_FEATURES.has(purpose) && agentFor(services, wanted)) return wanted;
      return choose(purpose)?.key ?? null;
    },
    completionInfo: () => {
      const choice = choose("completion");
      return {
        model: choice?.key ?? null,
        fim: choice ? styleFor(choice) : null,
        picked: choice ? picked : null,
      };
    },
    async fill(request: FillRequest) {
      await providers.refreshIfStale(60_000, 3000);
      const choice = choose("completion");
      if (!choice) return null;
      const style = styleFor(choice);
      if (!style) return null;
      if (request.signal?.aborted) return "";
      const requestId = newId("f");
      const abort = () => void aiIpc.cancel(requestId).catch(() => {});
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        const reply = await aiIpc.fim(requestId, {
          provider: {
            id: choice.provider.id,
            kind: choice.provider.kind,
            baseUrl: choice.provider.baseUrl,
          },
          style,
          model: choice.model,
          prompt: request.prompt,
          suffix: request.suffix,
          maxTokens: request.maxTokens,
          temperature: 0.1,
          ...(request.stop?.length && { stop: request.stop }),
        });
        if (!reply.supported) {
          noFim.add(choice.key);
          return null;
        }
        recordUsage(services, {
          source: "completion",
          choice,
          event: {
            kind: "done",
            stopReason: "stop",
            inputTokens: reply.inputTokens,
            outputTokens: reply.outputTokens,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          },
          price: priceOf(services, providers, choice.key),
        });
        return reply.text;
      } catch (err) {
        if (request.signal?.aborted) return "";
        throw err;
      } finally {
        request.signal?.removeEventListener("abort", abort);
      }
    },
    async generate(request) {
      // An external agent picked for this feature (D207): one prompt over ACP, its answer's text.
      const wanted =
        request.model ??
        services.settings.peek<string>(FEATURE_MODEL_SETTING[request.purpose]) ??
        "";
      const agent =
        AGENT_FEATURES.has(request.purpose) || request.model ? agentFor(services, wanted) : null;
      if (agent) {
        const text = await runAgentPrompt(
          services,
          agent,
          `${request.system}\n\nAnswer with the text only: no tools, no files, no preamble.\n\n${request.prompt}`,
          request.signal,
          undefined,
          request.purpose === "memory" ? "memory" : "commit",
        );
        request.onText?.(text);
        return text;
      }
      await providers.refreshIfStale(60_000, 3000);
      const choice =
        (request.model &&
          (providers.find(request.model) ??
            providers.models.peek().find((m) => m.model === request.model))) ||
        choose(request.purpose);
      if (!choice)
        throw new Error(
          "No model is available: start Ollama or add a provider in the agent panel's model menu.",
        );
      const requestId = newId("g");
      let text = "";
      const watch = new RepetitionWatch();
      let stuck: string | null = null;
      const abort = () => void aiIpc.cancel(requestId).catch(() => {});
      if (request.signal?.aborted) return "";
      request.signal?.addEventListener("abort", abort, { once: true });
      try {
        await aiIpc.chat(
          requestId,
          {
            provider: choice.provider,
            model: choice.model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.prompt },
            ],
            think: false,
            noCache: true,
            temperature: request.purpose === "completion" ? 0.1 : 0.2,
            ...(request.maxTokens && { maxTokens: request.maxTokens }),
          },
          (event) => {
            // The usage history (D201): which feature asked, not only the chat.
            if (event.kind === "done")
              recordUsage(services, {
                // A side question (/btw) is the chat's use.
                source: request.purpose === "aside" ? "chat" : request.purpose,
                choice,
                event,
                price: priceOf(services, providers, choice.key),
              });
            if (stuck) return;
            if (event.kind === "text" || event.kind === "thinking") {
              stuck = watch.push(event.kind, event.text);
              if (stuck) abort();
            }
            if (event.kind === "text") {
              text += event.text;
              request.onText?.(text);
            }
          },
        );
        if (stuck) throw new Error(stuck);
      } catch (err) {
        if (stuck) throw new Error(stuck);
        if (request.signal?.aborted) return text;
        throw err;
      } finally {
        request.signal?.removeEventListener("abort", abort);
      }
      return text;
    },
  };
}
