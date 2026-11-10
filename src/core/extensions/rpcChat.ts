// VS Code's language model and chat APIs on the worker side (D248): `lm.selectChatModels` and a model's
// `sendRequest` (the user's own model, through the host: off unless the user turned on
// `extensions.languageModelAccess` and allowed this extension), and `chat.createChatParticipant`
// (an "@name" the IDE can ask; its stream's Markdown is the answer). A request's text streams in
// as "provider" calls (`lm.chunk`). DOM-free, unit-tested.
import type { CancellationToken, Disposable } from "./rpc";
import type { OnCall, Request } from "./rpcTerminals";

export interface LanguageModelChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** VS Code's LanguageModelChatMessage.User / .Assistant (and its role numbers, User 1, Assistant 2). */
export const LanguageModelChatMessageFactory = {
  User: (content: string | { value: string }): LanguageModelChatMessage => ({
    role: "user",
    content: textOf(content),
  }),
  Assistant: (content: string | { value: string }): LanguageModelChatMessage => ({
    role: "assistant",
    content: textOf(content),
  }),
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).join("");
  const c = content as { value?: unknown } | null;
  return typeof c?.value === "string" ? c.value : "";
}

export interface LanguageModelChatResponse {
  /** The answer's text as it streams in. */
  text: AsyncIterable<string>;
  /** The same, as VS Code's LanguageModelTextPart objects. */
  stream: AsyncIterable<{ value: string }>;
}

export interface LanguageModelChat {
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly family: string;
  readonly version: string;
  readonly maxInputTokens: number;
  sendRequest(
    messages: readonly (LanguageModelChatMessage | { role: unknown; content: unknown })[],
    options?: { justification?: string },
    token?: CancellationToken,
  ): Promise<LanguageModelChatResponse>;
  /** An estimate (about four characters a token). */
  countTokens(text: string | LanguageModelChatMessage): Promise<number>;
}

export interface LanguageModelApi {
  /** The user's model (one, when language model access is on), or none. */
  selectChatModels(selector?: {
    vendor?: string;
    family?: string;
    id?: string;
    version?: string;
  }): Promise<LanguageModelChat[]>;
  LanguageModelChatMessage: typeof LanguageModelChatMessageFactory;
}

export interface ChatRequest {
  prompt: string;
  /** A slash command ("/explain" → "explain"), when there was one. */
  command?: string;
  /** The user's model (sendRequest needs language model access). */
  model: LanguageModelChat;
}

export interface ChatResponseStream {
  markdown(value: string | { value: string }): void;
  /** Shown as Markdown in italics here. */
  progress(value: string): void;
  /** A link to a file or page, written as Markdown. */
  reference(value: unknown): void;
  anchor(value: unknown, title?: string): void;
  button(command: { title?: string; command?: string }): void;
}

export type ChatRequestHandler = (
  request: ChatRequest,
  context: { history: unknown[] },
  stream: ChatResponseStream,
  token: CancellationToken,
) => unknown;

export interface ChatParticipant extends Disposable {
  readonly id: string;
  /** What the user types after "@". */
  readonly name: string;
  iconPath?: unknown;
  followupProvider?: unknown;
}

export interface ChatApi {
  /** `options.name`: the "@name" (default: the id's last part); VS Code takes it from package.json. */
  createChatParticipant(
    id: string,
    handler: ChatRequestHandler,
    options?: { name?: string; description?: string },
  ): ChatParticipant;
}

/** One streamed answer: chunks wait here until the extension reads them. */
class ChunkQueue {
  private readonly chunks: string[] = [];
  private done = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;

  push(text: string): void {
    this.chunks.push(text);
    this.wake?.();
  }

  private ended: (() => void) | null = null;

  finish(error?: Error): void {
    if (this.done) return;
    this.done = true;
    if (error) this.error = error;
    this.wake?.();
    this.ended?.();
  }

  onDone(listener: () => void): void {
    this.ended = listener;
  }

  async *read(): AsyncGenerator<string> {
    for (;;) {
      const next = this.chunks.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = null;
          resolve();
        };
      });
    }
  }
}

const uriLike = (v: unknown): string => {
  const r = v as { text?: unknown; path?: unknown; uri?: { path?: unknown } } | null;
  if (typeof v === "string") return v;
  return String(r?.text ?? r?.path ?? r?.uri?.path ?? "");
};

export function createChatApis(
  request: Request,
  on: OnCall,
): { lm: LanguageModelApi; chat: ChatApi } {
  let requestSeq = 0;
  const queues = new Map<string, ChunkQueue>();
  on("lm.chunk", (args: { requestId?: unknown; text?: unknown }) => {
    queues.get(String(args?.requestId ?? ""))?.push(String(args?.text ?? ""));
    return null;
  });
  on("lm.end", (args: { requestId?: unknown; error?: unknown }) => {
    const error = typeof args?.error === "string" ? new Error(args.error) : undefined;
    queues.get(String(args?.requestId ?? ""))?.finish(error);
    return null;
  });

  const model = (info: { id: string; name: string; family: string }): LanguageModelChat => ({
    id: info.id,
    name: info.name,
    vendor: "ide",
    family: info.family,
    version: info.family,
    maxInputTokens: 128_000,
    async sendRequest(messages, options = {}, token) {
      const requestId = `lm${++requestSeq}`;
      const queue = new ChunkQueue();
      queues.set(requestId, queue);
      const cancel = token?.onCancellationRequested(
        () => void request("lm.cancel", { requestId }).catch(() => {}),
      );
      const list = (Array.isArray(messages) ? messages : []).map((m) => ({
        // VS Code's roles: User = 1, Assistant = 2.
        role: m.role === "assistant" || m.role === 2 ? "assistant" : "user",
        content: textOf(m.content),
      }));
      const forget = () => {
        queues.delete(requestId);
        cancel?.dispose();
      };
      queue.onDone(forget);
      try {
        // Resolves once the user's model is allowed and started (rejects when refused, as VS
        // Code's does); the text then comes as lm.chunk calls and ends with lm.end.
        await request("lm.sendRequest", {
          requestId,
          model: info.id,
          messages: list,
          ...(typeof options.justification === "string" && {
            justification: options.justification,
          }),
        });
      } catch (err) {
        queue.finish();
        throw err;
      }
      const text = queue.read();
      return {
        text,
        stream: (async function* () {
          for await (const value of text) yield { value };
        })(),
      };
    },
    countTokens: async (text) =>
      Math.ceil((typeof text === "string" ? text : textOf(text?.content)).length / 4),
  });

  const lm: LanguageModelApi = {
    async selectChatModels(selector = {}) {
      const found = await request<{ id: string; name: string; family: string } | null>("lm.model");
      if (!found) return [];
      const m = model(found);
      if (selector.vendor && selector.vendor !== m.vendor) return [];
      if (selector.id && selector.id !== m.id) return [];
      if (selector.family && selector.family !== m.family) return [];
      return [m];
    },
    LanguageModelChatMessage: LanguageModelChatMessageFactory,
  };

  const chat: ChatApi = {
    createChatParticipant(id, handler, options = {}) {
      const participantId = String(id);
      const name = String(options.name ?? participantId.split(".").pop() ?? participantId);
      const off = on(
        `chat.${participantId}.request`,
        async (args: { prompt?: unknown; command?: unknown }) => {
          let markdown = "";
          const write = (s: string) => {
            markdown += s;
          };
          const stream: ChatResponseStream = {
            markdown: (v) => write(textOf(v)),
            progress: (v) => write(`\n_${String(v)}_\n`),
            reference: (v) => write(`\n- ${uriLike(v)}\n`),
            anchor: (v, title) => write(title ? `[${title}](${uriLike(v)})` : uriLike(v)),
            button: (c) => write(`\n**${String(c?.title ?? c?.command ?? "")}**\n`),
          };
          const found = await request<{ id: string; name: string; family: string } | null>(
            "lm.model",
          ).catch(() => null);
          const token: CancellationToken = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => {} }),
          };
          await handler(
            {
              prompt: String(args?.prompt ?? ""),
              ...(typeof args?.command === "string" && args.command && { command: args.command }),
              model: model(found ?? { id: "none", name: "No model", family: "none" }),
            },
            { history: [] },
            stream,
            token,
          );
          return { markdown };
        },
      );
      void request("chat.register", {
        id: participantId,
        name,
        ...(typeof options.description === "string" && { description: options.description }),
      }).catch((err: unknown) => console.error(err instanceof Error ? err.message : String(err)));
      return {
        id: participantId,
        name,
        dispose: () => {
          off();
          void request("chat.unregister", { id: participantId }).catch(() => {});
        },
      };
    },
  };
  return { lm, chat };
}
