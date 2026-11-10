// An agent conversation as a list of items (what the panel shows) and its translation into model
// messages (what the provider gets), within a size budget: old tool outputs are shortened first,
// then the oldest turns dropped. Text-protocol sessions (models without native tool calling)
// send calls as <tool_call> text and results as user messages. DOM-free.

import type { ChatMessage, ToolCall } from "../ipc/agent";
import { type ChatImage, imageNote } from "./chatImages";
import { MAIN_MEMBER } from "./groupChat";
import { toolCallText } from "./textProtocol";
import { TITLE_REQUEST } from "./title";

/**
 * The reply without an echo of the `<ide_state>` block the IDE puts on each user message (small
 * models sometimes repeat it): whole blocks, and a block still being written at the end.
 */
export function stripEchoedState(text: string): string {
  if (!text.includes("<ide_state")) return text;
  // Only an echo at the start of the reply (where models put it): one mentioned in prose or a
  // code sample further on is part of the answer (D160).
  let out = text.trimStart();
  for (;;) {
    if (!out.startsWith("<ide_state")) break;
    const end = out.indexOf("</ide_state>");
    // Still being written: nothing to show yet.
    if (end < 0) return "";
    out = out.slice(end + "</ide_state>".length).trimStart();
  }
  return out === text.trimStart() ? text : out;
}

/**
 * A group chat's reply without a leading `[Name]` tag: models copy the labels other members'
 * replies come with (`withSpeakerLabel`) into their own. Only at the start, and not a Markdown
 * link (`[text](url)`).
 */
export function stripSpeakerTag(text: string): string {
  const m = /^\s*\[[^\]\n]{1,40}\](?!\()[ \t]*\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** Sent when a reply was cut off at the model's output limit (D157). */
export const LIMIT_NOTE =
  "(Your last reply was cut off at the output limit before you finished. Carry on from where you stopped. Keep each reply smaller: write a large file in parts, with write_file for the first part and edit_file to add the rest, and keep thinking short.)";

/** Sent on Continue when the conversation ends with the agent's own reply (D159). */
export const CONTINUE_NOTE =
  "(Continue from where you stopped. If you had finished, say so in a sentence.)";

/** Opens a message the user sent while the agent worked (D151). */
export const STEER_NOTE =
  "(The user sent this while you were working. Take it into account, briefly acknowledge it if it changes anything, and carry on with the task.)";

export type ToolStatus = "pending" | "running" | "done" | "error" | "denied";

import type { SentAttachment } from "./attachments";
import { missingImagesNote } from "./chatAttachments";

export type Item =
  | {
      type: "user";
      id: string;
      text: string;
      context?: string[];
      /**
       * The IDE's state when the message was sent (active editor, problems, git…), kept with the
       * message so the conversation the model sees never changes after the fact (prompt caching,
       * D112).
       */
      state?: string;
      /** Pasted images (base64 PNG); not saved with the session. */
      images?: string[];
      /**
       * Small compressed copies of `images` (data: URLs) saved with the chat so it still shows
       * them later (D156). For the person only: never sent to the model.
       */
      previews?: string[];
      /** What was attached (cards above the message, D131); images in `images`, in order. */
      attachments?: SentAttachment[];
      /** The chat's first message: asks the model for a title (D124, `title.ts`). */
      askTitle?: boolean;
      /**
       * Written by the harness, not the user: a failed project check sent back (D127), or a
       * reply cut off at the model's output limit, asked to go on (D157).
       */
      /**
       * Sent by the IDE, not typed: a failed check, a report, a group handoff; a scheduled
       * message or a background command that ended (D253); a monitor's events (D322), a watched
       * pull request's news (D323), another chat's message or idle note (D325); a workflow's end (D338).
       */
      auto?:
        | "verify"
        | "limit"
        | "continue"
        | "subagent"
        | "group"
        | "schedule"
        | "process"
        | "monitor"
        | "pr"
        | "chat"
        | "workflow";
      /**
       * In a group chat, the member an automatic message is for (D253): a handoff note's member,
       * or the one that started the subagent whose report this is. A turn resumed after it (its
       * own, or Continue after a failure) is that member's.
       */
      to?: string;
      /** Sent in Ask or Plan mode (D180): the chat shows it. */
      /** "ask", "plan", or a custom mode's `custom:<name>` (D227). */
      mode?: string;
      /** Sent while the agent was working (D151): it joined the turn at the next step. */
      steer?: boolean;
      /** The session turn it started (checkpoints and changes cards are per turn, D160). */
      turn?: number;
      /** A one-off task shown as a turn (tidying up memory): no Retry or Edit (D160). */
      sideTask?: boolean;
    }
  | {
      type: "assistant";
      id: string;
      text: string;
      thinking: string;
      thinkingMs?: number;
      streaming: boolean;
      /** Raw text including <tool_call> blocks (text protocol). */
      raw?: string;
      /** Which model (or external agent) wrote it, shown under the answer. */
      model?: string;
      /** That model's key ("<provider>/<model>", "acp/<agent>"): the chat list's logo (D364). */
      modelKey?: string;
      /**
       * Which agent wrote it (D231): an agent's name, or `agent` for the main agent. A group chat
       * shows its face and name above it; a handoff changes it mid-chat.
       */
      speaker?: string;
      /** What the turn that wrote it cost, in dollars, when the model's price is known (D199). */
      cost?: number;
      /** Provider reasoning blocks (Anthropic thinking + signature), sent back unchanged. */
      reasoning?: unknown[];
      /** Images in the reply (a model that draws, an external agent's, D381). */
      media?: ChatImage[];
      /** While streaming: a tool call being written (D119), for "Writing index.html…". */
      toolDraft?: {
        name: string;
        path?: string;
        chars: number;
        /** The call's id, when the provider gave it (D355). */
        id?: string;
        /** A tool drawn as it's written (show_widget, D355): its arguments so far, partial JSON. */
        args?: string;
      };
    }
  | {
      type: "tool";
      id: string;
      callId: string;
      name: string;
      args: unknown;
      status: ToolStatus;
      /** What the model sees. */
      result?: string;
      /** One line for the row ("120 lines", "exit 1 · 4.2s"). */
      summary?: string;
      /** Expanded body (command output, excerpt). */
      detail?: string;
      /** Files this call proposed changes to. */
      changes?: string[];
      /** Base64 PNGs the call produced (screenshots); not saved with the session. */
      images?: string[];
      /** Saved compressed copies of `images`, for the person only (D156). */
      previews?: string[];
      /** Images the call made (generate_image, an MCP tool's), with ids to save them by (D381). */
      media?: ChatImage[];
      /** The harness's verify step ran it, not the model (D127). */
      check?: boolean;
      /**
       * An external agent's own approval review of this step (D208: Codex's Guardian), shown as
       * one line on the row ("Guardian: approved · low risk"), its rationale in the details.
       */
      review?: {
        by: string;
        status: string;
        risk?: string;
        authorization?: string;
        action?: string;
        rationale?: string;
      };
    }
  | {
      /** Earlier items, summarized by the model to save context (D109). */
      type: "summary";
      id: string;
      text: string;
      /** How many items it replaces (for the panel). */
      count: number;
      /** Made automatically (near the context limit) or with /compact. */
      auto: boolean;
    }
  | {
      type: "notice";
      id: string;
      text: string;
      tone: "info" | "error";
      /** Full error text (tooltip), when `text` is the short form. */
      detail?: string;
      /** Buttons under an error: retry the turn, or continue from where it stopped. */
      /** Buttons under it; keepHere / reloadChat end a two-window conflict (D221). */
      actions?: ("retry" | "continue" | "build" | "keepHere" | "reloadChat")[];
      /**
       * A side question (/btw, D389) and its answer: shown in the chat, never sent to the model
       * (notices aren't part of the conversation).
       */
      aside?: { question: string; answer: string; pending?: boolean };
    };

/**
 * Items from the newest summary on, the summary becoming (the start of) a user message: what came
 * before it isn't sent any more (D109).
 */
export function fromLastSummary(items: readonly Item[]): readonly Item[] {
  let at = -1;
  for (let i = items.length - 1; i >= 0; i--)
    if (items[i]?.type === "summary") {
      at = i;
      break;
    }
  const summary = items[at];
  if (summary?.type !== "summary") return items;
  const intro = `Summary of the conversation so far (older messages were compacted to save space):\n${summary.text}`;
  const rest = items.slice(at + 1);
  const next = rest[0];
  if (next?.type === "user")
    return [{ ...next, text: `${intro}\n\n${next.text}` }, ...rest.slice(1)];
  return [
    { type: "user", id: summary.id, text: `${intro}\n\nContinue from where you left off.` },
    ...rest,
  ];
}

/** Roughly 4 characters per token. */
export const charsFor = (tokens: number) => tokens * 4;

const OLD_TOOL_LIMIT = 600;
/**
 * Observation masking (D127): the newest tool results stay whole; older ones are shortened before
 * anything is summarized — as good as LLM summaries for agents at about half the cost (JetBrains
 * Research, "The Complexity Trap", 2025). The boundary moves in steps of MASK_CHUNK so earlier
 * messages stay the same between requests (prompt caching) until it has to move again.
 */
const KEEP_RECENT_TOOLS = 10;
const MASK_CHUNK = 8;

/** Tool results before this index are shortened (0: none), keeping the newest `keep` whole. */
export function maskBoundary(tools: number, keep = KEEP_RECENT_TOOLS, chunk = MASK_CHUNK): number {
  return Math.max(0, Math.floor((tools - keep) / chunk) * chunk);
}
/** Only the newest screenshots go to the model (each costs about a thousand tokens or more). */
const MAX_IMAGES = 2;

/** Tools that are safe to call again to see shortened output (no side effects). */
const REREADABLE = new Set([
  "read_file",
  "list_dir",
  "find_files",
  "search",
  "get_state",
  "recall",
]);

function shorten(text: string, limit: number, tool?: string): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, Math.floor(limit * 0.7));
  const tail = text.slice(-Math.floor(limit * 0.2));
  // Only read-only tools are worth calling again (re-running a command or an edit isn't).
  const hint = tool && REREADABLE.has(tool) ? "; call the tool again to see them" : "";
  return `${head}\n… [${text.length - head.length - tail.length} characters omitted${hint}] …\n${tail}`;
}

/**
 * Who wrote each assistant message, for a group chat (D231). Without it the member answering
 * reads the other members' replies as plain assistant messages, i.e. as its own words.
 */
export interface SpeakerLabels {
  /** The member answering this turn (its name): its new replies are recorded as its. */
  current: string | null;
  /** The text shown in the label for a member's name ("scout" → "Scout"). */
  label(name: string): string;
}

/** An assistant item without `speaker` came from the main agent (as the chat treats it). */
const UNNAMED_SPEAKER = MAIN_MEMBER;

/**
 * An assistant message's content, prefixed with `[Label] ` for the member that wrote it. Every
 * member's messages are labelled, the one answering now too (D253): the prefix depends only on the
 * item, never on who speaks, so a handoff doesn't change the history's bytes and the provider's
 * prompt cache still covers it.
 */
export function withSpeakerLabel(
  content: string,
  speaker: string | undefined,
  labels: SpeakerLabels,
): string {
  const name = speaker ?? UNNAMED_SPEAKER;
  // A step that only called tools has nothing to attribute: a lone `[Name]` message is what
  // models then imitate.
  if (!content) return content;
  return `[${labels.label(name)}] ${content}`;
}

/** Model messages for `items` (after the system prompt), fitting `budgetChars` if possible. */
export function toMessages(
  all: readonly Item[],
  options: {
    textProtocol: boolean;
    budgetChars: number;
    vision?: boolean;
    /**
     * Keep earlier messages exactly as sent while they fit (prompt caching, D112): old tool
     * results are shortened only when the budget needs it (compaction usually comes first).
     */
    stable?: boolean;
    /** In a group chat: label other members' replies (see `SpeakerLabels`). Absent: no labels. */
    speakerLabels?: SpeakerLabels;
  },
): ChatMessage[] {
  const items = fromLastSummary(all);
  // The newest tool items with images, newest first, up to MAX_IMAGES.
  const withImages = new Set(
    options.vision
      ? items
          .filter((it) => it.type === "tool" && it.images?.length)
          .slice(-MAX_IMAGES)
          .map((it) => it.id)
      : [],
  );
  // Turn boundaries: each user item starts a turn. Old tool results are shortened (the newest
  // stay whole, then those of earlier turns go too); if still too big, whole early turns go (the
  // first user message stays).
  const turnOf: number[] = [];
  const toolIndex: number[] = [];
  let turn = 0;
  let tools = 0;
  for (const it of items) {
    // The harness's feedback (D127) belongs to the message it answers: not a new turn.
    if (it.type === "user" && !it.auto) turn++;
    turnOf.push(turn);
    toolIndex.push(it.type === "tool" ? tools++ : -1);
  }
  const build = (maskBefore: number, shortenBefore: number, dropBefore: number): ChatMessage[] => {
    const out: ChatMessage[] = [];
    let pendingCalls: ToolCall[] = [];
    let assistant: ChatMessage | null = null;
    /** The assistant message's text already holds its calls (a text-protocol reply's `raw`). */
    let callsInText = false;
    const results: ChatMessage[] = [];
    let images: string[] = [];
    const flush = () => {
      if (assistant) {
        if (pendingCalls.length && !options.textProtocol) assistant.toolCalls = pendingCalls;
        // Calls made natively (no raw text), sent to a text-protocol model after a mid-turn
        // switch (D233): written as the <tool_call> blocks it's asked to use.
        else if (pendingCalls.length && !callsInText) {
          const written = pendingCalls.map((c) => toolCallText(c.name, c.arguments)).join("\n");
          assistant.content = assistant.content ? `${assistant.content}\n\n${written}` : written;
        }
        out.push(assistant);
      }
      out.push(...results);
      // Tool messages can't carry images in every API: they follow as a user message.
      if (images.length)
        out.push({ role: "user", content: "(Screenshot from the tool call above.)", images });
      assistant = null;
      callsInText = false;
      pendingCalls = [];
      results.length = 0;
      images = [];
    };
    items.forEach((it, i) => {
      const t = turnOf[i] ?? 0;
      // Dropping early turns keeps the very first user message (the task).
      if (dropBefore > 0 && t < dropBefore && !(t === 1 && it.type === "user")) return;
      if (it.type === "user") {
        flush();
        const parts = [
          ...(it.state ? [`<ide_state>\n${it.state}\n</ide_state>`] : []),
          ...(it.steer ? [STEER_NOTE] : []),
          ...(it.context ?? []),
          it.text,
          ...(it.askTitle ? [TITLE_REQUEST] : []),
        ];
        if (it.images?.length && !options.vision)
          parts.push(`(${it.images.length} image(s) attached; this model can't see images.)`);
        // Images from before a restart (only their previews were saved, D211).
        const missing = missingImagesNote(it);
        if (missing) parts.push(missing);
        out.push({
          role: "user",
          content: parts.join("\n\n"),
          ...(it.images?.length && options.vision && { images: it.images }),
        });
      } else if (it.type === "assistant") {
        flush();
        const text = options.textProtocol ? (it.raw ?? it.text) : it.text;
        // The images it drew, by id (the model doesn't get them back, D381).
        const content = it.media?.length
          ? `${text}

${imageNote(it.media)}`.trim()
          : text;
        callsInText = options.textProtocol && it.raw !== undefined;
        assistant = {
          role: "assistant",
          content: options.speakerLabels
            ? withSpeakerLabel(content, it.speaker, options.speakerLabels)
            : content,
          ...(!options.textProtocol && it.reasoning?.length && { thinkingBlocks: it.reasoning }),
        };
      } else if (it.type === "tool") {
        if (it.status === "pending" || it.status === "running") return;
        // An external agent's step (Codex ran a command, Claude Code edited a file): not a call
        // this model made, and its name ("acp:execute") isn't one providers accept (D244). Said
        // as a line of the reply instead.
        if (it.name.startsWith("acp:")) {
          const line = `[${it.summary || it.name.slice(4)}: ${it.status}]`;
          if (!assistant) assistant = { role: "assistant", content: line };
          else assistant.content = assistant.content ? `${assistant.content}\n${line}` : line;
          return;
        }
        const result = it.result ?? (it.status === "denied" ? "The user denied this." : "");
        // Its images' ids, so the model can save or show them (D381).
        const body = it.media?.length
          ? `${result}
${imageNote(it.media)}`
          : result;
        const masked = t < shortenBefore || (toolIndex[i] ?? -1) < maskBefore;
        const content = masked ? shorten(body, OLD_TOOL_LIMIT, it.name) : body;
        if (!assistant) assistant = { role: "assistant", content: "" };
        if (withImages.has(it.id) && it.images) images.push(...it.images);
        pendingCalls.push({ id: it.callId, name: it.name, arguments: it.args ?? {} });
        if (options.textProtocol) {
          results.push({
            role: "user",
            content: `<tool_result name="${it.name}">\n${content}\n</tool_result>`,
          });
        } else {
          results.push({ role: "tool", content, toolCallId: it.callId, toolName: it.name });
        }
      }
    });
    flush();
    // Text protocol: merge consecutive user messages (results) into one.
    if (options.textProtocol) {
      const merged: ChatMessage[] = [];
      for (const m of out) {
        const last = merged[merged.length - 1];
        if (
          last &&
          last.role === "user" &&
          m.role === "user" &&
          (m.content.startsWith("<tool_result") || m.images?.length)
        ) {
          last.content += `\n\n${m.content}`;
          if (m.images?.length) last.images = [...(last.images ?? []), ...m.images];
        } else merged.push({ ...m });
      }
      return merged;
    }
    return out;
  };
  const size = (ms: ChatMessage[]) =>
    ms.reduce((n, m) => n + m.content.length + JSON.stringify(m.toolCalls ?? "").length, 0);
  const window = maskBoundary(tools);
  const attempts: [number, number][] = options.stable
    ? [
        [0, 0],
        [window, 0],
        [window, turn - 1],
      ]
    : [[window, turn - 1]];
  attempts.push([Math.max(window, tools - 3), turn - 1]);
  let messages: ChatMessage[] = [];
  for (const [mask, before] of attempts) {
    messages = build(mask, before, 0);
    if (size(messages) <= options.budgetChars) return messages;
  }
  const last = Math.max(window, tools - 3);
  for (let drop = 2; drop <= turn; drop++) {
    messages = build(last, turn - 1, drop);
    if (size(messages) <= options.budgetChars) return messages;
  }
  return messages;
}
