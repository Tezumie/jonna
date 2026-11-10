// MCP sampling (D204): a server's `sampling/createMessage` runs on the user's model after they
// say yes. The request shows in a quick input (the server, the model, the start of the prompt:
// Allow once / Always allow this server in this window / Deny / Show the whole prompt);
// `agent.mcp.sampling` answers for a server ahead ("allow", "deny", "ask"; "*" for the rest),
// set on the MCP servers page. The model is the one the server hints at when it's connected,
// else the active chat's, else the default; no tools, no thinking, `maxTokens` capped. The usage
// log counts it as "MCP sampling". The model is in core/mcp/sampling.ts.
// D207: a request the user approved here ("ask") also has its answer reviewed before it goes
// back: a dialog with the text to send as it is, edit, or reject (agent.reviewMcpSampling, which
// tests and agents' callers use too). Images in the request go to a model that reads them;
// otherwise the request is refused with the reason. D223: audio is transcribed by voice input's
// speech-to-text service first; prompts over the size cap are refused; unasked, a model hint
// only picks a model that costs no more; a server that stops takes its requests with it.
import { pickVoiceProvider } from "../../core/agent/voice";
import { aiIpc } from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import {
  hintAllowed,
  preferredModel,
  reviewedResult,
  SAMPLING_MAX_TOKENS,
  type SamplingAnswer,
  type SamplingCandidate,
  type SamplingContent,
  SamplingGate,
  type SamplingRequest,
  type SamplingResult,
  type SamplingReview,
  samplingAudio,
  samplingContentProblem,
  samplingImageCount,
  samplingPolicy,
  samplingPreview,
  samplingResult,
  samplingSizeProblem,
  toChatMessages,
} from "../../core/mcp/sampling";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { newId } from "./ids";
import type { McpClients } from "./mcp";
import type { ModelChoice, ProviderRegistry } from "./providers";
import type { SessionManager } from "./sessions";
import { priceOf } from "./usage";
import { recordUsage } from "./usageLog";
import { textArea } from "./view/pageKit";

interface PendingReview {
  id: string;
  server: string;
  model: string;
  text: string;
  resolve(review: SamplingReview): void;
  /** Closes the dialog when the answer came another way (the command). */
  close: AbortController;
}

export interface SamplingLogEntry {
  server: string;
  at: number;
  model: string | null;
  outcome: "answered" | "denied" | "failed" | "rejected";
  /** The user changed the answer before it went back (D207). */
  edited?: boolean;
  images?: number;
  chars?: number;
  error?: string;
}

export function registerMcpSampling(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  providers: ProviderRegistry,
  clients: McpClients,
): SamplingGate {
  const log: SamplingLogEntry[] = [];
  const note = (e: SamplingLogEntry) => {
    log.push(e);
    if (log.length > 50) log.shift();
  };

  const candidate = (m: ModelChoice): SamplingCandidate => ({
    key: m.key,
    local: m.provider.kind === "ollama" && !m.info.remote,
    price: priceOf(services, providers, m.key),
  });

  /**
   * The model the server hints at when it's connected, else the active chat's, else the default.
   * Unasked (D223), a hint only picks a model that costs no more than that one.
   */
  const chooseModel = (request: SamplingRequest, asked: boolean): ModelChoice | undefined => {
    const chat = sessions.find(undefined)?.model.peek();
    const fallback =
      (chat && !chat.startsWith("acp/") && providers.find(chat)) || providers.defaultModel();
    const hint = preferredModel(request)?.toLowerCase();
    const models = providers.models.peek().filter((m) => !m.key.startsWith("acp/"));
    if (hint) {
      const hinted = models.find((m) => m.key.toLowerCase().includes(hint));
      if (hinted && hintAllowed(candidate(hinted), fallback ? candidate(fallback) : null, asked))
        return hinted;
    }
    return fallback;
  };

  /** Speech to text for audio in a request (D223): voice input's service, if one is set up. */
  const transcriber = async () => {
    const all = providers.providers();
    const named = services.settings.peek<string>("agent.voice.provider") ?? "";
    const keyed = named
      ? all
      : (
          await Promise.all(
            all.map(async (p) => ((await aiIpc.hasKey(p.id).catch(() => false)) ? [p] : [])),
          )
        ).flat();
    return pickVoiceProvider(
      keyed,
      named,
      services.settings.peek<string>("agent.voice.model") ?? "",
    );
  };

  const transcribe = async (request: SamplingRequest, stopped: AbortSignal) => {
    const audio = samplingAudio(request);
    const out = new Map<SamplingContent, string>();
    if (!audio.length) return out;
    const voice = await transcriber();
    if (!voice) return out;
    const language = services.settings.peek<string>("agent.voice.language") ?? "";
    for (const c of audio) {
      if (stopped.aborted) break;
      out.set(
        c,
        await aiIpc.transcribe(
          { id: voice.provider.id, kind: voice.provider.kind, baseUrl: voice.provider.baseUrl },
          voice.model,
          c.data as string,
          (c.mimeType ?? "audio/wav").split(";")[0] ?? "audio/wav",
          language || undefined,
        ),
      );
    }
    return out;
  };

  /** Requests the user approved by hand: their answers are reviewed too (D207). */
  const askedUser = new WeakSet<SamplingRequest>();
  const reviews = signal<readonly PendingReview[]>([]);
  let nextReview = 1;

  const finishReview = (id: string | undefined, review: SamplingReview): PendingReview | null => {
    const r = id ? reviews.peek().find((x) => x.id === id) : reviews.peek()[0];
    if (!r) return null;
    reviews.value = reviews.peek().filter((x) => x !== r);
    r.close.abort();
    r.resolve(review);
    return r;
  };

  /** Shows the answer; the dialog's buttons run agent.reviewMcpSampling. */
  const reviewAnswer = (
    server: string,
    model: string,
    text: string,
    stopped: AbortSignal,
  ): Promise<SamplingReview> =>
    new Promise((resolve) => {
      const pending: PendingReview = {
        id: `r${nextReview++}`,
        server,
        model,
        text,
        resolve,
        close: new AbortController(),
      };
      reviews.value = [...reviews.peek(), pending];
      // The server stopped: nobody would get the answer (D223).
      stopped.addEventListener("abort", () => finishReview(pending.id, { action: "reject" }), {
        once: true,
      });
      const box = textArea("The answer to send", text, 10);
      void showDialog<"send" | "reject" | "closed">({
        title: `Send this answer to ${server}?`,
        message: `MCP server ${server} asked your model (${model}). Check the answer, change it if you like, then send it or reject it (the server is told you said no).`,
        content: box,
        size: "md",
        actions: [
          { label: "Reject", value: "reject", variant: "danger" },
          { label: "Send", value: "send", variant: "primary" },
        ],
        cancelValue: "closed",
        signal: pending.close.signal,
      }).then((choice) => {
        if (!reviews.peek().includes(pending)) return; // answered by the command
        void services.dispatcher
          .execute("agent.reviewMcpSampling", {
            id: pending.id,
            action: choice === "send" ? "send" : "reject",
            ...(choice === "send" && { text: box.value }),
          })
          .catch(() => finishReview(pending.id, { action: "reject" }));
      });
    });

  /** Each request's "its server stopped" signal (D223), for the question and the run. */
  const stoppedOf = new WeakMap<SamplingRequest, AbortSignal>();

  const ask = async (server: string, request: SamplingRequest): Promise<SamplingAnswer> => {
    askedUser.add(request);
    const model = chooseModel(request, true);
    const preview = samplingPreview(request, 2000).replace(/\s+/g, " ");
    const audio = samplingAudio(request).length;
    const stopped = stoppedOf.get(request);
    for (;;) {
      if (stopped?.aborted) return "deny";
      // The server stopped while asked: the question goes away (its answer would reach nobody).
      let asking = true;
      const close = () => {
        if (asking) services.quickInput.cancel();
      };
      stopped?.addEventListener("abort", close, { once: true });
      const picked = await services.quickInput.pick(
        [
          {
            id: "once",
            label: "Allow once",
            description: `${model ? `on ${model.key}` : ""}${audio ? `; its audio goes to your speech-to-text service first` : ""}`,
          },
          {
            id: "always",
            label: `Always allow ${server}`,
            description: "In this window (MCP servers page: for good)",
          },
          { id: "deny", label: "Deny", description: "The server is told you said no" },
          { id: "show", label: "Show the whole prompt…" },
        ],
        {
          placeholder: `MCP server ${server} wants to use your model: ${preview.slice(0, 160)}${preview.length > 160 ? "…" : ""}`,
        },
      );
      asking = false;
      stopped?.removeEventListener("abort", close);
      if (!picked || picked.id === "deny" || stopped?.aborted) return "deny";
      if (picked.id === "show") {
        await services.dispatcher
          .execute("editor.openReadOnly", {
            title: `${server} sampling request.txt`,
            content: `MCP server ${server} asks your model (${model?.key ?? "no model"}), up to ${request.maxTokens ?? SAMPLING_MAX_TOKENS} tokens:\n\n${samplingPreview(request, 100_000)}`,
          })
          .catch(() => {});
        continue;
      }
      return picked.id === "always" ? "always" : "once";
    }
  };

  const gate = new SamplingGate(
    (server) => samplingPolicy(services.settings.peek<unknown>("agent.mcp.sampling"), server),
    ask,
  );

  const run = async (
    server: string,
    request: SamplingRequest,
    stopped: AbortSignal,
  ): Promise<SamplingResult | null> => {
    const choice = chooseModel(request, askedUser.has(request));
    if (!choice) throw new Error("No model is available for MCP sampling.");
    const images = samplingImageCount(request);
    const vision = images
      ? (await providers.detailsFor(choice).catch(() => null))?.vision !== false
      : true;
    const audio = samplingAudio(request).length;
    const problem = samplingContentProblem(
      request,
      vision,
      audio ? !!(await transcriber()) : false,
    );
    if (problem) throw new Error(`MCP sampling with ${choice.key}: ${problem}.`);
    const transcripts = await transcribe(request, stopped);
    if (stopped.aborted) throw new Error(`MCP server ${server} stopped.`);
    const id = newId("g");
    let text = "";
    // The server stopped (D223): the model stops too, nothing more is spent on an answer
    // nobody reads.
    const cancel = () => void aiIpc.cancel(id).catch(() => {});
    stopped.addEventListener("abort", cancel, { once: true });
    await aiIpc
      .chat(
        id,
        {
          provider: choice.provider,
          model: choice.model,
          messages: toChatMessages(request, transcripts),
          think: false,
          noCache: true,
          ...(request.temperature !== undefined && { temperature: request.temperature }),
          maxTokens: request.maxTokens ?? 1024,
        },
        (event) => {
          if (event.kind === "text") text += event.text;
          if (event.kind === "done")
            recordUsage(services, {
              source: "sampling",
              choice,
              event,
              price: priceOf(services, providers, choice.key),
            });
        },
      )
      .finally(() => stopped.removeEventListener("abort", cancel));
    if (stopped.aborted) throw new Error(`MCP server ${server} stopped.`);
    const result = samplingResult(text, choice.model);
    if (!askedUser.has(request)) {
      note({
        server,
        at: Date.now(),
        model: choice.key,
        outcome: "answered",
        chars: text.length,
        ...(images && { images }),
      });
      return result;
    }
    // The user approved the request: they see the answer before the server does (the spec's
    // SHOULD, D207).
    const reviewed = reviewedResult(result, await reviewAnswer(server, choice.key, text, stopped));
    note({
      server,
      at: Date.now(),
      model: choice.key,
      outcome: reviewed ? "answered" : "rejected",
      chars: reviewed?.content.text.length ?? 0,
      ...(reviewed && reviewed !== result && { edited: true }),
      ...(images && { images }),
    });
    return reviewed;
  };

  clients.sample = async (server, request, stopped) => {
    // Too big to send, asked or not (D223).
    const tooBig = samplingSizeProblem(request);
    if (tooBig) {
      note({ server, at: Date.now(), model: null, outcome: "failed", error: tooBig });
      throw new Error(`MCP sampling refused: ${tooBig}.`);
    }
    stoppedOf.set(request, stopped);
    if (!(await gate.decide(server, request)) || stopped.aborted) {
      note({ server, at: Date.now(), model: null, outcome: "denied" });
      return null;
    }
    try {
      // null: the user rejected the answer (the server hears "user rejected", like a denial).
      return await run(server, request, stopped);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      note({ server, at: Date.now(), model: null, outcome: "failed", error: message });
      throw err;
    }
  };
  sub.add({ dispose: () => (clients.sample = async () => null) });

  sub.add(
    services.state.register("ide://agent/mcp/sampling", {
      description:
        "MCP sampling (D204): each server's policy (agent.mcp.sampling: allow, deny or ask; \"*\" for the rest), the servers allowed for this window, the last requests (server, model, answered / denied / failed / rejected, edited, images) and the answers waiting for the user's review (D207).",
      get: () => ({
        policy: services.settings.peek<unknown>("agent.mcp.sampling") ?? {},
        allowedThisWindow: clients
          .runningServers()
          .map((r) => r.name)
          .filter((n) => gate.alwaysAllowed(n)),
        recent: [...log].reverse(),
        reviews: reviews.value.map((r) => ({
          id: r.id,
          server: r.server,
          model: r.model,
          chars: r.text.length,
        })),
      }),
    }),
  );
  sub.add({
    dispose: () => {
      for (const r of [...reviews.peek()]) finishReview(r.id, { action: "reject" });
    },
  });

  sub.add(
    services.dispatcher.register({
      id: "agent.reviewMcpSampling",
      title: "Answer an MCP sampling review",
      category: "Agent",
      description:
        "Answers the review of an MCP sampling result waiting for the user (ide://agent/mcp/sampling reviews; the oldest without `id`): `send` it to the server (with `text`, the edited answer instead), or `reject` it (the server is told the user said no).",
      input: s.object({
        id: s.string().optional(),
        action: s.enum(["send", "reject"] as const),
        text: s.string().describe("The answer to send instead of the model's").optional(),
      }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: ({ id, action, text }) => {
        const review: SamplingReview =
          action === "send" ? { action, ...(text !== undefined && { text }) } : { action };
        const r = finishReview(id, review);
        if (!r) throw new Error("No MCP sampling answer is waiting for review.");
        return {
          id: r.id,
          server: r.server,
          action,
          edited: text !== undefined && text !== r.text,
        };
      },
    }),
  );

  sub.add(
    services.dispatcher.register({
      id: "agent.setMcpSampling",
      title: "MCP sampling for a server",
      category: "Agent",
      description:
        'Sets whether an MCP server may run prompts on your model (sampling): allow (no question), deny, or ask each time (the default). `server` "*" sets it for servers without their own entry. Written to agent.mcp.sampling in the user settings.',
      input: s.object({
        server: s.string(),
        policy: s.enum(["allow", "deny", "ask"] as const),
      }),
      effects: ["write"],
      agent: "hidden",
      palette: false,
      run: async ({ server, policy }, ctx) => {
        const current = services.settings.peek<unknown>("agent.mcp.sampling");
        const map: Record<string, string> =
          current && typeof current === "object" && !Array.isArray(current)
            ? { ...(current as Record<string, string>) }
            : {};
        if (policy === "ask") delete map[server];
        else map[server] = policy;
        if (policy !== "allow") gate.forget(server === "*" ? undefined : server);
        await ctx.execute("settings.set", { key: "agent.mcp.sampling", value: map });
        return { server, policy };
      },
    }),
  );
  return gate;
}
