// MCP sampling (D204, the 2025-06-18 specification's `sampling/createMessage`): a server asks the
// client to run a prompt on the user's model. The user stays in the loop: each request is shown
// and approved (once, or always for that server), or refused; `agent.mcp.sampling` sets a
// server's answer ahead (`{ "github": "allow", "*": "deny" }`). This module holds the request's
// shape, the policy, the gate that asks, and the conversion to and from chat messages; DOM-free
// and tested. extensions/agent/mcpSampling.ts asks and runs the model. D207: image content goes
// to models that read images (else the request is refused, saying why), and with "ask" the user
// reviews the answer (send, edit, reject) before it goes back.

export interface SamplingContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface SamplingMessage {
  role: "user" | "assistant";
  content: SamplingContent | SamplingContent[];
}

export interface SamplingRequest {
  messages: SamplingMessage[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  modelPreferences?: {
    hints?: { name?: string }[];
    costPriority?: number;
    speedPriority?: number;
    intelligencePriority?: number;
  };
  includeContext?: string;
}

export interface SamplingResult {
  role: "assistant";
  content: { type: "text"; text: string };
  model: string;
  stopReason: string;
}

export type SamplingPolicy = "ask" | "allow" | "deny";

/** Most tokens a server may ask for (its maxTokens is capped to this). */
export const SAMPLING_MAX_TOKENS = 8192;

/** A request from the wire, checked (null: not a usable request). */
export function readSamplingRequest(params: unknown): SamplingRequest | null {
  if (!params || typeof params !== "object") return null;
  const p = params as Record<string, unknown>;
  if (!Array.isArray(p.messages) || p.messages.length === 0) return null;
  const messages: SamplingMessage[] = [];
  for (const m of p.messages) {
    if (!m || typeof m !== "object") return null;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return null;
    if (!content || typeof content !== "object") return null;
    messages.push({ role, content: content as SamplingMessage["content"] });
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const maxTokens = num(p.maxTokens);
  const temperature = num(p.temperature);
  return {
    messages,
    ...(typeof p.systemPrompt === "string" && { systemPrompt: p.systemPrompt }),
    ...(maxTokens !== undefined && {
      maxTokens: Math.max(1, Math.min(SAMPLING_MAX_TOKENS, Math.floor(maxTokens))),
    }),
    ...(temperature !== undefined && { temperature: Math.max(0, Math.min(2, temperature)) }),
    ...(Array.isArray(p.stopSequences) && {
      stopSequences: p.stopSequences.filter((x): x is string => typeof x === "string").slice(0, 8),
    }),
    ...(p.modelPreferences && typeof p.modelPreferences === "object"
      ? { modelPreferences: p.modelPreferences as SamplingRequest["modelPreferences"] }
      : {}),
    ...(typeof p.includeContext === "string" && { includeContext: p.includeContext }),
  };
}

const partsOf = (content: SamplingMessage["content"]) =>
  Array.isArray(content) ? content : [content];

/** Image types the providers take (Anthropic, OpenAI-compatible and Ollama all read these). */
export const SAMPLING_IMAGE_TYPES = ["image/png", "image/jpeg"] as const;

const isImage = (c: SamplingContent) =>
  c.type === "image" &&
  typeof c.data === "string" &&
  c.data.length > 0 &&
  (SAMPLING_IMAGE_TYPES as readonly string[]).includes(c.mimeType ?? "");

/** Audio the speech-to-text services take (D223: transcribed, then sent as text). */
export const SAMPLING_AUDIO_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
] as const;

export const isSamplingAudio = (c: SamplingContent): boolean =>
  c.type === "audio" &&
  typeof c.data === "string" &&
  c.data.length > 0 &&
  (SAMPLING_AUDIO_TYPES as readonly string[]).includes((c.mimeType ?? "").split(";")[0] ?? "");

/** The user messages' audio blocks, in order (what a transcription pass turns into text). */
export function samplingAudio(request: SamplingRequest): SamplingContent[] {
  return request.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => partsOf(m.content).filter(isSamplingAudio));
}

/** Transcripts of audio blocks (by the block), filled in by the caller before toChatMessages. */
export type Transcripts = ReadonlyMap<SamplingContent, string>;

/** One content block as text (an image that goes along as an image has no text). */
function contentText(
  c: SamplingContent,
  role: SamplingMessage["role"],
  transcripts?: Transcripts,
): string | null {
  if (c.type === "text") return c.text ?? "";
  if (role === "user" && isImage(c)) return null;
  const heard = transcripts?.get(c);
  if (heard !== undefined) return `[audio, transcribed]: ${heard}`;
  return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""} omitted]`;
}

export interface SamplingChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Base64 images (a user message's image content, D207). */
  images?: string[];
}

/** The request as chat messages for the provider (the system prompt first). */
export function toChatMessages(
  request: SamplingRequest,
  transcripts?: Transcripts,
): SamplingChatMessage[] {
  const out: SamplingChatMessage[] = [];
  if (request.systemPrompt?.trim()) out.push({ role: "system", content: request.systemPrompt });
  for (const m of request.messages) {
    const parts = partsOf(m.content);
    const images = m.role === "user" ? parts.filter(isImage).map((c) => c.data as string) : [];
    out.push({
      role: m.role,
      content: parts
        .map((c) => contentText(c, m.role, transcripts))
        .filter((t): t is string => t !== null)
        .join("\n"),
      ...(images.length && { images }),
    });
  }
  return out;
}

/** How many images the request sends to the model. */
export function samplingImageCount(request: SamplingRequest): number {
  return toChatMessages(request).reduce((n, m) => n + (m.images?.length ?? 0), 0);
}

/**
 * Why the request can't run on a model (`vision`: it reads images), or null (D207): images go
 * to a model that reads them (PNG or JPEG, in the server's user messages); audio and other
 * content are refused rather than dropped, so the server isn't answered about a prompt the
 * model never saw.
 */
export function samplingContentProblem(
  request: SamplingRequest,
  vision: boolean,
  /** Audio is transcribed first (D223): a speech-to-text service is set up. */
  transcribes = false,
): string | null {
  for (const m of request.messages)
    for (const c of partsOf(m.content)) {
      if (c.type === "text") continue;
      if (c.type === "audio") {
        if (m.role !== "user")
          return "audio in the server's own (assistant) messages isn't supported";
        if (!isSamplingAudio(c))
          return `${c.mimeType || "unknown"} audio isn't supported (WAV, MP3, M4A, OGG, WebM, FLAC are)`;
        if (!transcribes)
          return "audio needs speech to text: connect Groq or OpenAI, or set agent.voice.provider";
        continue;
      }
      if (c.type === "image") {
        if (m.role !== "user")
          return "images in the server's own (assistant) messages aren't supported";
        if (!isImage(c))
          return `${c.mimeType || "unknown"} images aren't supported (PNG and JPEG are)`;
        if (!vision) return "the model doesn't read images: pick a vision model for MCP sampling";
        continue;
      }
      return `${c.type} content isn't supported (text, images and audio are)`;
    }
  return null;
}

/** The most text a request may send (its messages and system prompt, D223): about 50k tokens. */
export const SAMPLING_MAX_PROMPT_CHARS = 200_000;
/** The most image and audio data, base64 (a few pictures or a minute or two of audio). */
export const SAMPLING_MAX_MEDIA_CHARS = 20_000_000;

/**
 * Why a request is too big to run, or null (D223): a server could otherwise send a prompt the
 * size of a book to the user's paid model with one approval, or none under "allow".
 */
export function samplingSizeProblem(request: SamplingRequest): string | null {
  let text = request.systemPrompt?.length ?? 0;
  let media = 0;
  for (const m of request.messages)
    for (const c of partsOf(m.content)) {
      if (c.type === "text") text += c.text?.length ?? 0;
      else media += typeof c.data === "string" ? c.data.length : 0;
    }
  if (text > SAMPLING_MAX_PROMPT_CHARS)
    return `the prompt is ${Math.round(text / 1000)}k characters (at most ${SAMPLING_MAX_PROMPT_CHARS / 1000}k)`;
  if (media > SAMPLING_MAX_MEDIA_CHARS)
    return `its images and audio are ${Math.round((media * 3) / 4 / 1_000_000)} MB (at most ${Math.round((SAMPLING_MAX_MEDIA_CHARS * 3) / 4 / 1_000_000)} MB)`;
  return null;
}

/** A model a request could run on, with what's known of its price per million tokens. */
export interface SamplingCandidate {
  key: string;
  /** On this computer (Ollama, a local server): no cost. */
  local: boolean;
  price?: { input: number; output: number } | undefined;
}

/**
 * Whether a server's model hint may replace the model it would get (D223). When the user is
 * asked, they see the model and decide. When nobody is (the "allow" policy, or "always" for the
 * window), a hint only picks a model that costs no more: a local one, or one whose input and
 * output prices are both known and no higher. A hint never turns a free (local) default into a
 * paid model, and a model with no known price isn't taken unasked.
 */
export function hintAllowed(
  hinted: SamplingCandidate,
  fallback: SamplingCandidate | null,
  asked: boolean,
): boolean {
  if (asked || hinted.key === fallback?.key || hinted.local) return true;
  if (!fallback || fallback.local || !hinted.price || !fallback.price) return false;
  return hinted.price.input <= fallback.price.input && hinted.price.output <= fallback.price.output;
}

/** What the approval shows: the system prompt and the messages, cut to `max` characters. */
export function samplingPreview(request: SamplingRequest, max = 1200): string {
  const lines = [
    ...(request.systemPrompt?.trim() ? [`system: ${request.systemPrompt}`] : []),
    ...request.messages.map(
      (m) =>
        `${m.role}: ${partsOf(m.content)
          .map((c) =>
            c.type === "text" ? (c.text ?? "") : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""}]`,
          )
          .join("\n")}`,
    ),
  ];
  const text = lines.join("\n\n");
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

/** The model the server would like (its first hint), as a name to look for. */
export function preferredModel(request: SamplingRequest): string | null {
  const hint = request.modelPreferences?.hints?.find((h) => typeof h.name === "string" && h.name);
  return hint?.name ?? null;
}

export function samplingResult(
  text: string,
  model: string,
  stopReason = "endTurn",
): SamplingResult {
  return { role: "assistant", content: { type: "text", text }, model, stopReason };
}

/** A server's policy from `agent.mcp.sampling` (its own entry, else `*`, else ask). */
export function samplingPolicy(setting: unknown, server: string): SamplingPolicy {
  const map = setting && typeof setting === "object" && !Array.isArray(setting) ? setting : {};
  const pick = (v: unknown): SamplingPolicy | null =>
    v === "allow" || v === "deny" || v === "ask" ? v : null;
  return (
    pick((map as Record<string, unknown>)[server]) ??
    pick((map as Record<string, unknown>)["*"]) ??
    "ask"
  );
}

export type SamplingAnswer = "once" | "always" | "deny";

/**
 * Decides whether a server's request runs: its policy, then this window's "always" answers, then
 * the user. Requests from one server wait for each other (one prompt at a time); a refusal is the
 * spec's user-rejected error.
 */
export class SamplingGate {
  private readonly allowed = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly policy: (server: string) => SamplingPolicy,
    private readonly ask: (server: string, request: SamplingRequest) => Promise<SamplingAnswer>,
  ) {}

  /** Whether this window already said yes to every request from `server`. */
  alwaysAllowed(server: string): boolean {
    return this.allowed.has(server);
  }

  forget(server?: string): void {
    if (server) this.allowed.delete(server);
    else this.allowed.clear();
  }

  decide(server: string, request: SamplingRequest): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const policy = this.policy(server);
      if (policy === "deny") return false;
      if (policy === "allow" || this.allowed.has(server)) return true;
      const answer = await this.ask(server, request).catch(() => "deny" as const);
      if (answer === "always") this.allowed.add(server);
      return answer !== "deny";
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}

/** The user's look at the answer before it goes back (D207): sent as it is, edited, or not. */
export type SamplingReview = { action: "send"; text?: string } | { action: "reject" };

/** The result to send after a review, or null when the user rejected it. */
export function reviewedResult(
  result: SamplingResult,
  review: SamplingReview,
): SamplingResult | null {
  if (review.action === "reject") return null;
  if (review.text === undefined || review.text === result.content.text) return result;
  return { ...result, content: { type: "text", text: review.text } };
}

/** The JSON-RPC error for a refused request (MCP uses -1 for "user rejected"). */
export const SAMPLING_REJECTED = { code: -1, message: "The user declined the sampling request." };
