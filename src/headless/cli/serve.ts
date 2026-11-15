// Node only. `serve`: the brain kept running, and what a front end needs from it (contract B)
// on a loopback socket: run a command as the front end, read a state path, follow a chat's
// events, send a prompt, answer what waits. One client at a time; a token says who may attach.
//
// The protocol is newline-delimited JSON (src/headless/README.md has it in full):
//   client -> { "id": 1, "method": "hello", "params": { "token": "…" } }
//   server -> { "id": 1, "result": { "protocol": 1, … } }      or { "id": 1, "error": { "code", "message" } }
//   server -> { "event": { …a SessionEvent… } }                  for chats the client subscribed to
//   server -> { "notify": "hostPrompts", "params": [ … ] }       when the waiting host prompts change
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { product } from "../../core/product";
import { effect } from "../../core/reactive/index";
import type { BrainChat, HostedBrain } from "../run";
import type { CliArgs } from "./args";
import { policyOf, reviewOf } from "./config";
import type { Io } from "./io";
import { start } from "./launch";
import { EXIT } from "./output";

export const SERVE_PROTOCOL = 1;

/** The longest line a client may send (a prompt with pasted files fits; a flood doesn't). */
const MAX_LINE = 32 * 1024 * 1024;

interface Request {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

class ServeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function runServe(args: CliArgs, io: Io): Promise<number> {
  const token = args.token ?? io.env.IDE_SERVE_TOKEN ?? randomBytes(24).toString("base64url");
  // A front end answers what waits, unless told nobody will.
  const { brain, folder, notes } = await start(args, {
    frontend: "serve",
    policy: policyOf(args, !args.nonInteractive),
    ...(args.verbose && { log: (line: string) => io.err(line) }),
  });
  for (const note of notes) io.err(`${note}\n`);
  const review = reviewOf(args, false);

  let client: Socket | null = null;
  let subscriptions = new Map<string, { dispose(): void }>();
  let finish: (code: number) => void = () => {};
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const sendTo = (socket: Socket, message: unknown): void => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
  };

  const chatOf = async (session: unknown): Promise<BrainChat> => {
    const id = text(session);
    if (!id) throw new ServeError("Invalid", "`session` (a chat's id) is needed: open one first.");
    return brain.open({ session: id });
  };

  const handle = async (socket: Socket, method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "execute": {
        const command = text(params.command);
        if (!command) throw new ServeError("Invalid", "`command` (a command's id) is needed.");
        return (await brain.execute(command, params.input ?? {})) ?? null;
      }
      case "state": {
        const path = text(params.path);
        if (!path) throw new ServeError("Invalid", "`path` (ide://…) is needed.");
        return (await brain.state(path, number(params.budget))) ?? null;
      }
      case "chats":
        return brain.chats();
      case "open": {
        const model = text(params.model);
        const chat = await brain.open({
          ...(text(params.session) && { session: text(params.session) }),
          ...(params.continue === true && { continue: true }),
          ...(params.create === true && { create: true }),
          ...(model && { model }),
          ...(text(params.agentModel) !== undefined && { agentModel: text(params.agentModel) }),
          ...(text(params.agentLevel) !== undefined && { agentLevel: text(params.agentLevel) }),
          ...(text(params.chatMode) && { chatMode: text(params.chatMode) }),
          ...(typeof params.review === "boolean"
            ? { review: params.review }
            : review !== undefined && { review }),
        });
        return {
          session: chat.id,
          title: chat.session.title.peek(),
          model: chat.session.model.peek(),
          items: chat.session.items.length,
        };
      }
      case "subscribe": {
        const chat = await chatOf(params.session);
        if (!subscriptions.has(chat.id))
          subscriptions.set(
            chat.id,
            chat.onEvent((event) => sendTo(socket, { event })),
          );
        return { subscribed: chat.id };
      }
      case "unsubscribe": {
        const id = text(params.session) ?? "";
        subscriptions.get(id)?.dispose();
        return { unsubscribed: subscriptions.delete(id) };
      }
      case "send": {
        const chat = await chatOf(params.session);
        const prompt = text(params.prompt);
        if (prompt === undefined) throw new ServeError("Invalid", "`prompt` is needed.");
        return chat.send(prompt, {
          ...(number(params.maxSteps) !== undefined && { maxSteps: number(params.maxSteps) }),
          ...(number(params.maxCost) !== undefined && { maxCost: number(params.maxCost) }),
          ...(number(params.timeoutMs) !== undefined && { timeoutMs: number(params.timeoutMs) }),
        });
      }
      case "stop": {
        (await chatOf(params.session)).stop(text(params.reason));
        return null;
      }
      case "shutdown":
        setTimeout(() => finish(EXIT.ok), 20);
        return null;
      default:
        throw new ServeError("Invalid", `unknown method: ${method}`);
    }
  };

  const attach = (socket: Socket): void => {
    socket.setNoDelay(true);
    socket.setEncoding("utf8");
    let greeted = false;
    let buffer = "";
    const hostPrompts = { stop: (): void => {} };
    const drop = (): void => {
      hostPrompts.stop();
      if (client !== socket) return;
      client = null;
      for (const s of subscriptions.values()) s.dispose();
      subscriptions = new Map();
    };
    socket.on("close", drop);
    socket.on("error", drop);
    const onLine = async (line: string): Promise<void> => {
      let request: Request;
      try {
        request = JSON.parse(line) as Request;
      } catch {
        sendTo(socket, { error: { code: "Invalid", message: "not JSON" } });
        socket.destroy();
        return;
      }
      const { id } = request;
      const method = text(request.method) ?? "";
      const params = record(request.params);
      if (!greeted) {
        if (method !== "hello" || !sameToken(text(params.token) ?? "", token)) {
          sendTo(socket, {
            id,
            error: { code: "Unauthorized", message: "hello with the token first" },
          });
          socket.end();
          return;
        }
        if (client && client !== socket) {
          sendTo(socket, { id, error: { code: "Busy", message: "another client is attached" } });
          socket.end();
          return;
        }
        greeted = true;
        client = socket;
        sendTo(socket, {
          id,
          result: {
            protocol: SERVE_PROTOCOL,
            version: product.version,
            folder,
            host: brain.host,
            caller: brain.caller,
          },
        });
        // The host's own questions (an MCP server's input…), as they come and go.
        let told = "";
        const watching = effect(() => {
          const pending = brain.prompts.pending.value;
          const key = pending.map((p) => p.id).join(",");
          if (key !== told) {
            told = key;
            void brain
              .state("ide://agent/hostPrompts")
              .then((list) => sendTo(socket, { notify: "hostPrompts", params: list }))
              .catch(() => {});
          }
          return undefined;
        });
        hostPrompts.stop = () => watching.dispose();
        return;
      }
      if (method === "hello") {
        sendTo(socket, { id, result: { protocol: SERVE_PROTOCOL } });
        return;
      }
      try {
        const result = await handle(socket, method, params);
        if (id !== undefined) sendTo(socket, { id, result });
      } catch (err) {
        if (id !== undefined)
          sendTo(socket, {
            id,
            error: {
              code: err instanceof ServeError ? err.code : "Failed",
              message: messageOf(err),
            },
          });
      }
    };
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) void onLine(line);
        at = buffer.indexOf("\n");
      }
    });
  };

  const server: Server = createServer(attach);
  const onSignal = () => finish(EXIT.interrupted);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  brain.onHostExit((code, signal) => {
    io.err(`The host program ended unexpectedly (${signal ?? `exit code ${code}`}).\n`);
    finish(EXIT.failed);
    setTimeout(() => process.exit(EXIT.failed), 500);
  });
  let code: number;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(args.port ?? 0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : (args.port ?? 0);
    io.out(`${JSON.stringify({ type: "listening", host: "127.0.0.1", port, token, folder })}\n`);
    code = await finished;
  } catch (err) {
    io.err(`Couldn't listen: ${messageOf(err)}\n`);
    code = EXIT.usage;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    (client as Socket | null)?.destroy();
    server.close();
    await disposeSoon(brain);
  }
  return code;
}

/** Ends the brain in order, without waiting for ever. */
export async function disposeSoon(brain: HostedBrain): Promise<void> {
  const closing = brain.dispose().catch(() => {});
  await Promise.race([closing, new Promise((done) => setTimeout(done, 8000).unref())]);
}
