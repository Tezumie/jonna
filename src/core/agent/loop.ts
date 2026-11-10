// The agent loop for one user turn: ask the model, run the tools it calls, feed results back, until
// it answers without calling tools (or the step limit / cancel). Native tool calling when the model
// supports it; otherwise (or after the provider says "does not support tools") the text protocol.
// Everything outside (provider, tools, UI updates) is injected, so this is tested with fakes.

import type { ChatEvent, ChatMessage, ToolSpec } from "../ipc/agent";
import { type ChatImage, nextImageId } from "./chatImages";
import {
  type Item,
  LIMIT_NOTE,
  type SpeakerLabels,
  stripEchoedState,
  stripSpeakerTag,
  toMessages,
} from "./conversation";
import { parseToolCalls, toolsPrompt } from "./textProtocol";
import { splitTitle } from "./title";

export interface ToolOutcome {
  /** What the model sees. */
  result: string;
  isError?: boolean;
  denied?: boolean;
  summary?: string;
  detail?: string;
  changes?: string[];
  /** Base64 PNGs (screenshots) shown to vision models after the result. */
  images?: string[];
  /**
   * Images the call made, shown in the chat with an id each (generate_image, an MCP tool's, D381):
   * base64 `data` of type `mime`, a file name it suggests.
   */
  media?: { mime: string; data: string; name?: string; source?: string }[];
}

export interface LoopDeps {
  system(): string;
  tools(): ToolSpec[];
  /** Deferred tools' names (D319): not offered, but a text-protocol call of one is still a call. */
  deferredTools?(): readonly string[];
  chat(
    request: { messages: ChatMessage[]; tools: ToolSpec[] },
    onEvent: (e: ChatEvent) => void,
  ): Promise<void>;
  execute(
    call: { id: string; name: string; arguments: unknown },
    item: Extract<Item, { type: "tool" }>,
  ): Promise<ToolOutcome>;
  /** Items changed (re-render). */
  update(): void;
  newId(): string;
  cancelled(): boolean;
  budgetChars: number;
  maxSteps: number;
  /** The model takes images (screenshots go to it); otherwise only their description. */
  vision?: boolean;
  /** Before each model call (compaction near the context limit, D109). */
  beforeStep?(): Promise<void>;
  /** Keep sent messages unchanged while they fit (providers with prompt caching, D112). */
  stableMessages?: boolean;
  /**
   * A group chat's members (D232): earlier replies by another member go to the model labelled
   * with who wrote them. Asked per request (the speaker changes between turns).
   */
  speakerLabels?: () => SpeakerLabels | null;
  /** The chat still wants a title from the model (D124): `<title>…</title>` is taken out. */
  title?: { wanted(): boolean; set(title: string): void };
  /**
   * Messages the user sent while the turn ran (D151), taken before each model call: they join the
   * conversation there, and a turn that would end goes on to answer them.
   */
  takeQueued?(): Item[];
  hasQueued?(): boolean;
  /**
   * Send now (D363): the user wants the waiting messages read now. The step being written (or
   * the tools left to run) ends there, and the next step takes them. `phase` says what the step
   * is doing, so the session cuts short the right thing (the request, or the running commands).
   */
  interrupt?: {
    requested(): boolean;
    clear(): void;
    phase(phase: "model" | "tools" | null): void;
  };
  /**
   * The provider said the request is over the model's context (the 4-characters-per-token
   * estimate was off): summarize the older part and say whether that freed anything, so the
   * step is tried once more instead of failing the turn (Claude Code's reactive compaction).
   */
  recoverOverflow?(): Promise<boolean>;
  /**
   * Whether a call may run at the same time as the calls beside it in the step (D253): reads,
   * searches, subagents. Neighbouring calls that may all run together; the rest one at a time,
   * in the order the model asked. Absent: all one at a time.
   */
  concurrent?(call: { name: string; arguments: unknown }): boolean;
}

/** At most this many of a step's calls run at once (a model asking for 30 reads waits a little). */
export const MAX_PARALLEL_CALLS = 8;

/**
 * The step's calls in the order they run: each group's calls run together, the groups one after
 * another. A call that can't run alongside others is a group of its own, so nothing runs out of
 * the order the model gave relative to a write.
 */
export function callGroups<T extends { name: string; arguments: unknown }>(
  calls: readonly T[],
  concurrent: ((call: T) => boolean) | undefined,
): T[][] {
  const groups: T[][] = [];
  let open: T[] | null = null;
  for (const call of calls) {
    if (concurrent?.(call)) {
      if (!open) {
        open = [];
        groups.push(open);
      }
      open.push(call);
    } else {
      open = null;
      groups.push([call]);
    }
  }
  return groups;
}

/** Runs `run` over `items`, at most `limit` at a time; resolves when all have finished. */
export async function inParallel<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await run(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface LoopState {
  items: Item[];
  /** Use <tool_call> text instead of native tool calling. */
  textProtocol: boolean;
}

export class NoToolsError extends Error {}

/** The request didn't fit the model's context (thrown by `chat`, see `isContextOverflow`). */
export class ContextOverflowError extends Error {}

/**
 * The model can't go on (its usage limit, D254) and the turn moves to another one: the step is
 * taken again, after `beforeStep` switched the model (thrown by `chat` before anything streamed).
 */
export class SwitchModelError extends Error {}

/** Runs until the model stops calling tools. Returns how many model calls were made. */
export async function runTurn(state: LoopState, deps: LoopDeps): Promise<number> {
  let steps = 0;
  /** Replies cut off at the output limit in a row (D157): carried on twice, then it stops. */
  let cutOff = 0;
  /** The last step went on only to answer a queued message (D160). */
  let forQueue = false;
  /** A context overflow was recovered from once this turn (a second one fails it). */
  let overflowRecovered = false;
  /** Steps taken again on another model (D254): at most twice a turn. */
  let switches = 0;
  // One tool list for the whole turn: a list that changes between steps (a browser tab opened)
  // would invalidate the provider's prompt cache on every change. `deps.tools` keeps it so; it
  // grows only by the tools a tool_search loaded (D319), read before each step.
  let tools = deps.tools();
  while (steps < deps.maxSteps && !deps.cancelled()) {
    await deps.beforeStep?.();
    if (deps.cancelled()) break;
    tools = deps.tools();
    deps.interrupt?.clear();
    const queued = deps.takeQueued?.() ?? [];
    if (queued.length) {
      state.items.push(...queued);
      deps.update();
    } else if (forQueue) break; // taken back meanwhile: nothing to answer, the turn is done
    forQueue = false;
    steps++;
    const labels = deps.speakerLabels?.() ?? null;
    const assistant: Extract<Item, { type: "assistant" }> = {
      type: "assistant",
      id: deps.newId(),
      text: "",
      thinking: "",
      streaming: true,
      // Its writer from the start, not when the turn ends: the turn's next requests would
      // otherwise label the member's own earlier steps as the main agent's.
      ...(labels?.current && { speaker: labels.current }),
    };
    state.items.push(assistant);
    deps.update();
    const system =
      state.textProtocol && tools.length
        ? `${deps.system()}\n\n${toolsPrompt(tools)}`
        : deps.system();
    const clean = (text: string) =>
      labels ? stripSpeakerTag(stripEchoedState(text)) : stripEchoedState(text);
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...toMessages(state.items.slice(0, -1), {
        textProtocol: state.textProtocol,
        budgetChars: deps.budgetChars,
        vision: deps.vision ?? false,
        stable: deps.stableMessages ?? false,
        ...(labels && { speakerLabels: labels }),
      }),
    ];
    const calls: { id: string; name: string; arguments: unknown }[] = [];
    let stopReason = "";
    const started = Date.now();
    let thinkingDone = false;
    let raw = "";
    let draftScanned = 0;
    let draftAt = 0;
    /** Text-protocol calls' ids by block (D376): the drawn widget's card is the finished one's. */
    const textIds: string[] = [];
    let titled = false;
    const visible = new VisibleText();
    deps.interrupt?.phase("model");
    try {
      await deps.chat({ messages, tools: state.textProtocol ? [] : tools }, (e) => {
        if (e.kind === "thinking") assistant.thinking += e.text;
        else if (e.kind === "reasoning")
          assistant.reasoning = [...(assistant.reasoning ?? []), e.block];
        else if (e.kind === "text") {
          if (assistant.thinking && !thinkingDone) {
            assistant.thinkingMs = Date.now() - started;
            thinkingDone = true;
          }
          raw += e.text;
          // The line break after a title can arrive in the next piece.
          if (titled) {
            const trimmed = raw.trimStart();
            if (trimmed !== raw) visible.reset(); // `raw` changed at the front, not just grew
            raw = trimmed;
          }
          if (deps.title?.wanted()) {
            const split = splitTitle(raw);
            if (split.title) {
              deps.title.set(split.title);
              raw = split.text;
              visible.reset();
              titled = true;
            } else if (split.pending) {
              deps.update();
              return;
            }
          }
          // Hide <tool_call> blocks (and a half-written one) from the visible text while streaming.
          // Incremental: rescanning the whole reply on every delta was quadratic in its length.
          assistant.text = clean(state.textProtocol ? visible.update(raw) : raw);
          // Every ~1000 characters, not every delta (a long <tool_call> would be rescanned); a
          // widget being written every 150 ms, so it's drawn as it comes (D376, as D355 natively).
          const drawing =
            STREAMED_TEXT_TOOLS.has(assistant.toolDraft?.name ?? "") &&
            Date.now() - draftAt >= TEXT_DRAFT_MS;
          if (state.textProtocol && (raw.length - draftScanned >= 1000 || drawing)) {
            draftScanned = raw.length;
            draftAt = Date.now();
            const draft = textToolDraft(raw);
            if (draft) {
              const block = draft.block ?? 0;
              if (draft.args !== undefined) textIds[block] ??= deps.newId();
              const id = textIds[block];
              assistant.toolDraft = {
                name: draft.name,
                ...(draft.path && { path: draft.path }),
                chars: draft.chars,
                ...(id && { id }),
                ...(draft.args !== undefined && { args: draft.args }),
              };
            } else delete assistant.toolDraft;
          }
        } else if (e.kind === "image") {
          // A model that draws (D381): the image joins the reply, with an id the chat keeps. A
          // link instead of the bytes stays a link (pages aren't loaded from the network).
          if (e.data) {
            const media = assistant.media ?? [];
            media.push({ id: nextImageId(state.items), mime: e.mime, data: e.data });
            assistant.media = media;
          } else if (e.url) raw += `\n\n[Image](${e.url})\n`;
        } else if (e.kind === "toolProgress") {
          // A widget's code so far (D355); a report without it keeps the call's last.
          const before = assistant.toolDraft;
          const args = e.arguments ?? (before?.id === e.id ? before?.args : undefined);
          assistant.toolDraft = {
            name: e.name,
            ...(e.path && { path: e.path }),
            chars: e.chars,
            ...(e.id && { id: e.id }),
            ...(args !== undefined && { args }),
          };
        } else if (e.kind === "toolCall")
          calls.push({ id: e.id, name: e.name, arguments: e.arguments });
        else if (e.kind === "done") stopReason = e.stopReason;
        deps.update();
      });
    } catch (err) {
      deps.interrupt?.phase(null);
      // Send now cut the reply short: what was written stays, the next step reads the message.
      if (deps.interrupt?.requested() && !deps.cancelled()) {
        assistant.streaming = false;
        delete assistant.toolDraft;
        if (!assistant.text.trim() && !assistant.thinking)
          state.items.splice(state.items.indexOf(assistant), 1);
        deps.update();
        continue;
      }
      if (err instanceof NoToolsError && !state.textProtocol) {
        // Retry this step with the text protocol. (By identity: a retry notice may follow it.)
        state.items.splice(state.items.indexOf(assistant), 1);
        state.textProtocol = true;
        steps--;
        continue;
      }
      if (err instanceof SwitchModelError && switches < 2 && !deps.cancelled()) {
        switches++;
        state.items.splice(state.items.indexOf(assistant), 1);
        deps.update();
        steps--;
        continue;
      }
      if (
        err instanceof ContextOverflowError &&
        !overflowRecovered &&
        !deps.cancelled() &&
        deps.recoverOverflow
      ) {
        overflowRecovered = true;
        state.items.splice(state.items.indexOf(assistant), 1);
        deps.update();
        if (await deps.recoverOverflow().catch(() => false)) {
          steps--;
          continue;
        }
        state.items.push(assistant);
      }
      assistant.streaming = false;
      deps.update();
      throw err;
    }
    deps.interrupt?.phase(null);
    if (assistant.thinking && !thinkingDone) assistant.thinkingMs = Date.now() - started;
    // A reply that only looked like the start of a title shows as it is.
    if (!state.textProtocol) assistant.text = clean(raw);
    if (state.textProtocol) {
      assistant.raw = raw;
      // Deferred tools count as calls too: the call gets the error that says how to load one.
      const parsed = parseToolCalls(
        raw,
        new Set([...tools.map((t) => t.name), ...(deps.deferredTools?.() ?? [])]),
      );
      assistant.text = clean(parsed.text);
      // A widget drawn while written keeps its id, so its finished card is the same card (D376).
      // By the block it came from (D379: a dropped block before it mustn't shift the ids), once.
      const used = new Set<string>();
      for (const c of parsed.calls) {
        const drafted =
          STREAMED_TEXT_TOOLS.has(c.name) && c.block !== undefined ? textIds[c.block] : undefined;
        const id = drafted && !used.has(drafted) ? drafted : deps.newId();
        used.add(id);
        calls.push({ id, name: c.name, arguments: c.arguments });
      }
    }
    assistant.streaming = false;
    delete assistant.toolDraft;
    // Drop an empty assistant item (pure tool-calling step) from the view; keep it for messages.
    deps.update();
    // Cut off at the output limit with nothing to run (a big file was being written, or long
    // thinking): it isn't done. Ask it to carry on, in smaller pieces (D157).
    if (calls.length === 0 && stopReason === "length" && cutOff < 2) {
      cutOff++;
      state.items.push({ type: "user", id: deps.newId(), text: LIMIT_NOTE, auto: "limit" });
      deps.update();
      continue;
    }
    if (calls.length) cutOff = 0;
    // Send now right as the reply ended: its tools don't run, the next step reads the message.
    if (deps.interrupt?.requested() && deps.hasQueued?.()) continue;
    // Done, unless the user said something meanwhile: then the next step answers it.
    if (calls.length === 0 && !deps.hasQueued?.()) break;
    if (calls.length === 0) forQueue = true;
    // Reads, searches and subagents the model asked for together run together (D253), the
    // way the model meant them; their rows and results stay in the order it asked.
    deps.interrupt?.phase("tools");
    for (const group of callGroups(calls, deps.concurrent?.bind(deps))) {
      if (deps.cancelled() || deps.interrupt?.requested()) break;
      const running = group.map((call) => {
        const item: Extract<Item, { type: "tool" }> = {
          type: "tool",
          id: deps.newId(),
          callId: call.id,
          name: call.name,
          args: call.arguments,
          status: "running",
        };
        state.items.push(item);
        return { call, item };
      });
      deps.update();
      await inParallel(running, MAX_PARALLEL_CALLS, async ({ call, item }) => {
        // Stopped while earlier calls of the group ran: the rest don't start.
        if (deps.cancelled()) {
          item.status = "error";
          item.result = "Stopped by the user.";
          item.summary = "stopped";
          deps.update();
          return;
        }
        if (deps.interrupt?.requested()) {
          item.status = "error";
          item.result = "Not run: the user sent a message first.";
          item.summary = "skipped";
          deps.update();
          return;
        }
        try {
          const outcome = await deps.execute(call, item);
          item.status = outcome.denied ? "denied" : outcome.isError ? "error" : "done";
          item.result = outcome.result;
          item.summary = outcome.summary;
          item.detail = outcome.detail;
          item.changes = outcome.changes;
          if (outcome.images?.length) item.images = outcome.images;
          if (outcome.media?.length) {
            const media: ChatImage[] = [];
            for (const m of outcome.media)
              media.push({ ...m, id: nextImageId([...state.items, { ...item, media }]) });
            item.media = media;
          }
        } catch (err) {
          item.status = "error";
          item.result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          item.summary = err instanceof Error ? err.message : String(err);
        }
        deps.update();
      });
    }
    deps.interrupt?.phase(null);
  }
  return steps;
}

const OPEN_TAG = "<tool_call>";
const CLOSE_TAG = "</tool_call>";

/**
 * The streamed reply with `<tool_call>` blocks (and a half-written one) removed, trimmed — the
 * same as `raw.replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, "").trim()`, but each call only
 * scans what arrived since the last one. `raw` must only grow between calls; call `reset()`
 * after changing it any other way.
 */
export class VisibleText {
  /** Visible text of raw[0, done). */
  private text = "";
  /** Everything before this index of `raw` is accounted for in `text` (or a closed block). */
  private done = 0;
  /** Start of an unclosed `<tool_call>` at `done`, or -1. */
  private openAt = -1;
  /** Length of `raw` at the last call: tags can only newly appear ending past it. */
  private seen = 0;

  reset(): void {
    this.text = "";
    this.done = 0;
    this.openAt = -1;
    this.seen = 0;
  }

  update(raw: string): string {
    if (raw.length < this.seen) this.reset();
    // A tag split across deltas starts at most tag-length - 1 before the old end.
    let from = Math.max(this.done, this.seen - CLOSE_TAG.length + 1);
    for (;;) {
      if (this.openAt >= 0) {
        const close = raw.indexOf(CLOSE_TAG, Math.max(from, this.openAt + OPEN_TAG.length));
        if (close < 0) break;
        this.done = close + CLOSE_TAG.length;
        this.openAt = -1;
      } else {
        const open = raw.indexOf(OPEN_TAG, from);
        if (open < 0) break;
        this.text += raw.slice(this.done, open);
        this.done = open;
        this.openAt = open;
      }
      from = this.done;
    }
    this.seen = raw.length;
    return (this.openAt >= 0 ? this.text : this.text + raw.slice(this.done)).trim();
  }
}

/**
 * A provider error worth retrying automatically: rate limits, overload, gateway and server
 * errors, dropped connections (OpenRouter's "model busy", Anthropic's 529…). Not: bad requests,
 * auth, unknown models, context too long.
 */
export function isTransientError(message: string): boolean {
  if (
    /\b(400|401|403|404|413|422)\b|unauthori[sz]ed|invalid api key|not found|context length|too long|does not support tools/i.test(
      message,
    )
  )
    return false;
  return /\b(408|409|425|429|500|502|503|504|520|522|524|529)\b|rate.?limit|overloaded|busy|temporar|try again|timed? ?out|timeout|connection (reset|refused|closed|error)|connect error|error sending request|unexpected eof|stream (closed|ended)|upstream|capacity|unavailable/i.test(
    message,
  );
}

/**
 * A provider saying the account or model is out of what it may use (D254): a usage or rate
 * limit, a quota, credits, a free tier's daily cap. Another model may still answer.
 */
export function isUsageLimit(message: string): boolean {
  return /\b(402|429)\b|rate.?limit|usage limit|quota|too many requests|insufficient (credits?|balance|funds|quota)|out of credits|credit balance|billing|exceeded|free tier|limit reached|resource.?exhausted/i.test(
    message,
  );
}

/**
 * The output a key can still pay for, when a provider refuses a request for asking too much
 * (OpenRouter's 402: "You requested up to 65536 tokens, but can only afford 40434"): a bit under
 * it, so the step is asked again with that limit (D366). Null for anything else, or too little to
 * be worth a step.
 */
export function affordableOutput(message: string): number | null {
  const m = /can only afford (\d+)/i.exec(message);
  const n = m?.[1] ? Math.floor(Number(m[1]) * 0.9) : 0;
  return n >= 1024 ? n : null;
}

/**
 * A tool call's arguments as an object: none (or an empty string / list) is `{}`, a JSON string
 * is parsed (some providers send it unparsed), and anything else — text that isn't JSON, which is
 * what a call cut off at the output limit leaves — is null.
 */
export function toolArguments(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return {};
  if (Array.isArray(raw)) return raw.length ? null : {};
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * A provider error saying the request is over the model's context window (Anthropic's "prompt is
 * too long", OpenAI's context_length_exceeded, Gemini's token limit, llama.cpp / LM Studio's).
 */
export function isContextOverflow(message: string): boolean {
  return /prompt is too long|context_length_exceeded|maximum context length|context (?:length|window) (?:exceeded|is exceeded)|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|too many (?:input )?tokens|input (?:is )?too long|available context size|exceeds the maximum number of tokens|request too large for model|reduce the length of the messages/i.test(
    message,
  );
}

/** Backoff before retry `attempt` (1-based): 1 s, 3 s, 8 s, with a little jitter. */
export function retryDelayMs(attempt: number): number {
  const base = [1000, 3000, 8000][attempt - 1] ?? 8000;
  return base + Math.round(Math.random() * 400);
}

/** The first line of an error, at most 120 characters, for a compact notice. */
export function shortError(message: string): string {
  const line = message.split("\n")[0]?.trim() ?? message;
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** The tool call a text-protocol reply is in the middle of writing (unterminated <tool_call>). */
/** Tools drawn while a text-protocol model writes them (D376), as STREAMED_TOOLS natively. */
export const STREAMED_TEXT_TOOLS = new Set(["show_widget"]);
/** How often a text-protocol widget's arguments are read again while it's written. */
const TEXT_DRAFT_MS = 150;

/**
 * The <tool_call> being written: its tool, file, size; `block` its place among the reply's
 * calls; for a tool drawn as it's written (show_widget), `args`: its arguments so far, partial
 * JSON (what Rust sends natively, D355).
 */
export function textToolDraft(
  raw: string,
): { name: string; path?: string; chars: number; block?: number; args?: string } | null {
  const open = raw.lastIndexOf("<tool_call>");
  if (open < 0 || raw.indexOf("</tool_call>", open) >= 0) return null;
  const full = raw.slice(open + "<tool_call>".length);
  // Name and path come first; don't run the patterns over a whole file's content.
  const body = full.slice(0, 4096);
  const name = /"name"\s*:\s*"([\w.-]+)"/.exec(body)?.[1];
  if (!name) return null;
  const path = /"(?:path|file_path|filePath|filename)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
  const base = { name, ...(path && { path: path.replace(/\\(.)/g, "$1") }), chars: full.length };
  if (!STREAMED_TEXT_TOOLS.has(name)) return base;
  const at = /"(?:arguments|parameters|input)"\s*:\s*\{/.exec(full);
  if (!at) return base;
  let block = 0;
  for (
    let i = raw.indexOf("<tool_call>");
    i >= 0 && i < open;
    i = raw.indexOf("<tool_call>", i + 1)
  )
    block++;
  return { ...base, block, args: full.slice(at.index + at[0].length - 1) };
}
