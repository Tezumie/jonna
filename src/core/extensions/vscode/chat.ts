// The `vscode` shim's `chat` and `lm` (D257) on the IDE's chat participants and language model
// access (opt-in: extensions.languageModelAccess): VS Code's request, response stream and models
// (messages with text parts, responses as text and as parts). Tools aren't offered. DOM-free and
// unit-tested.

import type { WorkerApi } from "../rpc";
import type { ShimCommands } from "./commands";
import type { Command } from "./languageTypes";
import { CancellationTokenSource, Disposable, EventEmitter, type MarkdownString } from "./types";
import {
  ChatResponseMarkdownPart,
  ChatResponseProgressPart,
  LanguageModelChatMessageRole,
  LanguageModelTextPart,
} from "./workbenchTypes";

type IdeModel = Awaited<ReturnType<WorkerApi["lm"]["selectChatModels"]>>[number];
type VsMessage = { role: number; content: string | readonly { value?: unknown }[]; name?: string };

/** A message's text (VS Code's content is text parts; other parts aren't sent). */
function textOf(m: VsMessage | string): string {
  if (typeof m === "string") return m;
  if (typeof m.content === "string") return m.content;
  return m.content.map((p) => (typeof p.value === "string" ? p.value : "")).join("");
}

function vsToken(
  token:
    | {
        isCancellationRequested: boolean;
        onCancellationRequested(l: () => void): { dispose(): void };
      }
    | undefined,
) {
  const source = new CancellationTokenSource();
  if (token?.isCancellationRequested) source.cancel();
  else token?.onCancellationRequested(() => source.cancel());
  return source.token;
}

export function languageModel(m: IdeModel) {
  return {
    id: m.id,
    name: m.name,
    vendor: m.vendor,
    family: m.family,
    version: m.version,
    maxInputTokens: m.maxInputTokens,
    countTokens: (text: string | VsMessage) => m.countTokens(textOf(text)),
    sendRequest: async (messages: readonly VsMessage[], options?: { justification?: string }) => {
      const r = await m.sendRequest(
        messages.map((msg) => ({
          role:
            msg.role === LanguageModelChatMessageRole.Assistant
              ? ("assistant" as const)
              : ("user" as const),
          content: textOf(msg),
        })),
        options?.justification ? { justification: options.justification } : undefined,
      );
      async function* parts() {
        for await (const chunk of r.stream) yield new LanguageModelTextPart(chunk.value);
      }
      return { text: r.text, stream: parts() };
    },
  };
}

/** The participant's "@name" and description from package.json's `chatParticipants`. */
function participantInfo(
  packageJSON: Record<string, unknown>,
  id: string,
): { name?: string; description?: string } {
  const contributes = packageJSON.contributes as { chatParticipants?: unknown } | undefined;
  const list = Array.isArray(contributes?.chatParticipants) ? contributes.chatParticipants : [];
  const p = list.find((x) => (x as { id?: unknown })?.id === id) as
    | { name?: unknown; description?: unknown }
    | undefined;
  return {
    ...(typeof p?.name === "string" && { name: p.name }),
    ...(typeof p?.description === "string" && { description: p.description }),
  };
}

/** A tool's result as text for the agent (text parts; other parts as JSON). */
export function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  const parts = Array.isArray(content) ? content : Array.isArray(result) ? result : [result];
  return parts
    .map((p) => {
      if (typeof p === "string") return p;
      const value = (p as { value?: unknown } | null)?.value;
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value ?? p);
      } catch {
        return String(p);
      }
    })
    .join("\n")
    .slice(0, 100_000);
}

export function createChat(
  ide: WorkerApi,
  commands: ShimCommands,
  packageJSON: Record<string, unknown>,
  unsupported: (name: string) => void,
  tools: readonly {
    id: string;
    tool?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }[] = [],
) {
  type Tool = {
    invoke(options: { input: unknown; toolInvocationToken: unknown }, token: unknown): unknown;
    prepareInvocation?(options: unknown, token: unknown): unknown;
  };
  const registered = new Map<string, Tool>();
  const chat = {
    createChatParticipant: (
      id: string,
      handler: (request: unknown, context: unknown, stream: unknown, token: unknown) => unknown,
    ) => {
      const onDidReceiveFeedback = new EventEmitter<unknown>();
      const participant = ide.chat.createChatParticipant(
        id,
        async (request, context, stream, token) => {
          const markdown = (v: string | MarkdownString | { value: string }) =>
            stream.markdown(typeof v === "string" ? v : { value: v.value });
          const vsStream = {
            markdown,
            progress: (v: string) => stream.progress(v),
            reference: (v: unknown) => stream.reference(v),
            anchor: (v: unknown, title?: string) => stream.anchor(v, title),
            button: (c: Command) => {
              const r = commands.ref(c);
              stream.button({ title: c.title, ...(r && !r.input && { command: r.command }) });
            },
            warning: (v: string | MarkdownString) =>
              markdown(`> ${typeof v === "string" ? v : v.value}`),
            filetree: () => unsupported("ChatResponseStream.filetree"),
            push: (part: unknown) => {
              if (part instanceof ChatResponseMarkdownPart) markdown(part.value);
              else if (part instanceof ChatResponseProgressPart) stream.progress(part.value);
            },
          };
          const vsRequest = {
            prompt: request.prompt,
            command: request.command,
            references: [],
            toolReferences: [],
            toolInvocationToken: undefined,
            model: languageModel(request.model),
          };
          return handler(vsRequest, { history: context.history ?? [] }, vsStream, vsToken(token));
        },
        participantInfo(packageJSON, id),
      );
      return {
        id,
        iconPath: undefined as unknown,
        followupProvider: undefined as unknown,
        onDidReceiveFeedback: onDidReceiveFeedback.event,
        dispose: () => participant.dispose(),
      };
    },
  };

  const lm = {
    selectChatModels: async (selector?: { vendor?: string; family?: string; id?: string }) =>
      (await ide.lm.selectChatModels(selector)).map(languageModel),
    onDidChangeChatModels: new EventEmitter<void>().event,
    /** Its own tools (package.json's languageModelTools); the agent's are the IDE's. */
    get tools() {
      return tools.flatMap((t) =>
        t.tool
          ? [
              {
                name: t.tool,
                description: t.description ?? "",
                inputSchema: t.inputSchema,
                tags: [] as string[],
              },
            ]
          : [],
      );
    },
    /** D258: the agent calls it through its declared command. */
    registerTool: (name: string, tool: Tool) => {
      const declared = tools.find((t) => t.tool === name);
      if (!declared) {
        unsupported(`lm.registerTool("${name}") without contributes.languageModelTools`);
        return new Disposable(() => {});
      }
      registered.set(name, tool);
      const registration = ide.commands.register(declared.id, async (input) => {
        const result = await tool.invoke(
          { input: input ?? {}, toolInvocationToken: undefined },
          vsToken(undefined),
        );
        return { result: toolResultText(result) };
      });
      return new Disposable(() => {
        registered.delete(name);
        registration.dispose();
      });
    },
    invokeTool: async (name: string, options: { input?: unknown }) => {
      const tool = registered.get(name);
      if (!tool) {
        unsupported(`lm.invokeTool("${name}") of another extension`);
        throw new Error(`No tool ${name}.`);
      }
      return tool.invoke(
        { input: options?.input ?? {}, toolInvocationToken: undefined },
        vsToken(undefined),
      );
    },
  };

  return { chat, lm };
}
