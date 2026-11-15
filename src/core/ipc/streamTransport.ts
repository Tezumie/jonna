// Backend calls over a byte stream to a windowless host: the wire contract (v1) on any reliable
// ordered duplex (a child process's pipes, a socket, later a WebSocket). DOM-free and free of any
// runtime's own modules: the duplex is handed in (`node/hostProcess.ts` makes one in Node).
//
// A frame, both ways: [u32 LE header length][u32 LE body length][header: UTF-8 JSON][body: bytes].
// Client to host: requests `{id, method, params}` (a raw one: `{id, method, raw: true, headers}`
// with the bytes as the body) and the notification `{method: "$/channelClose", params}`.
// Host to client: `{id, result}`, `{id, raw: true}` + body, `{id, error}`, and channel messages
// `{channel, data}` or `{channel, raw: true}` + body.
import type { RawBody, Transport, TransportChannel, TransportState } from "./transport";

/** The contract's version: the handshake refuses a host that speaks another. */
export const STREAM_PROTOCOL = 1;
/** A frame's largest header (64 MiB) and body (1 GiB); a larger one ends the connection. */
export const MAX_FRAME_HEADER = 64 * 1024 * 1024;
export const MAX_FRAME_BODY = 1024 * 1024 * 1024;

const PREFIX_BYTES = 8;
const NO_BODY = new Uint8Array(0);

/** A reliable, ordered byte stream in both directions. */
export interface ByteDuplex {
  /** Queues bytes for the other side, in call order. May throw when the stream is gone. */
  write(bytes: Uint8Array): void;
  /** Hears the bytes that arrive, in order, in chunks of any size. One listener. */
  onData(listener: (chunk: Uint8Array) => void): void;
  /** Hears the stream ending (`error` when it broke). One listener. */
  onClose(listener: (error?: Error) => void): void;
  /** Ends the stream from this side (for a child's pipes: the end of its stdin). */
  close(): void;
}

export type FrameHeader = Record<string, unknown>;

/**
 * Values JSON has no form for, written the way the desktop framework writes them inside a
 * call's args, so a command gets the same shapes on either transport: a Map as an object, bytes
 * as an array of numbers. (A channel is handled before this, by its own `toJSON`.)
 */
function asDesktopJson(_key: string, value: unknown): unknown {
  if (value instanceof Map) return Object.fromEntries(value.entries());
  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  return value;
}

/** One frame as bytes: the prefix, the header's JSON, and the body if there is one. */
export function encodeFrame(header: FrameHeader, body: Uint8Array = NO_BODY): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header, asDesktopJson));
  if (json.length > MAX_FRAME_HEADER) throw new Error("The frame's header is too large.");
  if (body.length > MAX_FRAME_BODY) throw new Error("The frame's body is too large.");
  const frame = new Uint8Array(PREFIX_BYTES + json.length + body.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, json.length, true);
  view.setUint32(4, body.length, true);
  frame.set(json, PREFIX_BYTES);
  frame.set(body, PREFIX_BYTES + json.length);
  return frame;
}

/**
 * Cuts a byte stream back into frames, however the bytes were chunked. `push` throws on a frame
 * past the limits or a header that isn't a JSON object: the stream can't be trusted after that.
 * Each frame's body is a buffer of its own (handed on without a copy).
 */
export class FrameParser {
  private readonly prefix = new Uint8Array(PREFIX_BYTES);
  private prefixFilled = 0;
  /** The frame being filled, once its prefix is known. */
  private header: Uint8Array | null = null;
  private body: Uint8Array = NO_BODY;
  private filled = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly onFrame: (header: FrameHeader, body: Uint8Array) => void) {}

  push(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length) {
      if (!this.header) {
        const take = Math.min(PREFIX_BYTES - this.prefixFilled, chunk.length - at);
        this.prefix.set(chunk.subarray(at, at + take), this.prefixFilled);
        this.prefixFilled += take;
        at += take;
        if (this.prefixFilled < PREFIX_BYTES) return;
        this.prefixFilled = 0;
        const view = new DataView(this.prefix.buffer);
        const headerLength = view.getUint32(0, true);
        const bodyLength = view.getUint32(4, true);
        if (headerLength === 0 || headerLength > MAX_FRAME_HEADER || bodyLength > MAX_FRAME_BODY)
          throw new Error(`A frame of ${headerLength} + ${bodyLength} bytes isn't allowed.`);
        this.header = new Uint8Array(headerLength);
        this.body = bodyLength ? new Uint8Array(bodyLength) : NO_BODY;
        this.filled = 0;
        // A frame with no body can be complete with the header's last byte (below).
      }
      const header: Uint8Array = this.header;
      const total = header.length + this.body.length;
      // Fill the header, then the body, from what's left of the chunk.
      while (this.filled < total && at < chunk.length) {
        const inHeader = this.filled < header.length;
        const target = inHeader ? header : this.body;
        const offset = inHeader ? this.filled : this.filled - header.length;
        const take = Math.min(target.length - offset, chunk.length - at);
        target.set(chunk.subarray(at, at + take), offset);
        this.filled += take;
        at += take;
      }
      if (this.filled < total) return;
      const body = this.body;
      this.header = null;
      this.body = NO_BODY;
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.decoder.decode(header));
      } catch {
        throw new Error("A frame's header isn't JSON.");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new Error("A frame's header isn't a JSON object.");
      this.onFrame(parsed as FrameHeader, body);
    }
  }
}

/** What the host says about itself in the handshake. */
export interface HostInfo {
  protocol: number;
  /** The app's version. */
  version: string;
  os: string;
  pid: number;
  /** Every command the host answers (the desktop-only ones are absent). */
  commands: string[];
}

export interface StreamTransportOptions {
  /** What kind of client this is, for the host's log ("brain" when left out). */
  client?: string;
  /** The connection's secret, when the host listens on a socket. */
  token?: string;
  /**
   * Hears an exception thrown by a channel's handler (the message is dropped, the channel goes
   * on). Left out: written to the console.
   */
  onHandlerError?: (error: unknown) => void;
}

/** A call's failure as the backend serializes it: `call` makes the `IpcError`. */
interface WireError {
  code: string;
  message: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface OpenChannel {
  onMessage: (message: unknown) => void;
  onEnd: (() => void) | undefined;
}

export class StreamTransport implements Transport {
  readonly kind = "stream";
  /** Resolves with the host's handshake answer; rejects when the connection never opened. */
  readonly ready: Promise<HostInfo>;

  private current: TransportState = "connecting";
  private hostInfo: HostInfo | null = null;
  /** Why calls fail once closed. */
  private closedWith: WireError = { code: "Io", message: "The host connection is closed." };
  /** Request ids: 1 is the handshake's. */
  private nextRequest = 2;
  private nextChannel = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly channels = new Map<number, OpenChannel>();
  /** Frames made before the handshake was answered, sent in order once it is. */
  private outbox: Uint8Array[] = [];
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private closeError: Error | undefined;
  private rejectReady: (error: Error) => void = () => {};
  private readonly parser = new FrameParser((header, body) => this.received(header, body));

  constructor(
    private readonly duplex: ByteDuplex,
    private readonly options: StreamTransportOptions = {},
  ) {
    let opened: (info: HostInfo) => void = () => {};
    this.ready = new Promise<HostInfo>((resolve, reject) => {
      opened = resolve;
      this.rejectReady = reject;
    });
    // A program that never awaits `ready` still hears the failure from its first call.
    this.ready.catch(() => {});
    // The handshake's answer. However the connection ends before it, `end` rejects `ready`.
    this.pending.set(1, {
      resolve: (value) => {
        const info = value as Partial<HostInfo> | null;
        if (info?.protocol !== STREAM_PROTOCOL) {
          const message = `The host speaks protocol ${String(info?.protocol)}, not ${STREAM_PROTOCOL}.`;
          this.end({ code: "Invalid", message }, new Error(message));
          return;
        }
        this.hostInfo = {
          protocol: info.protocol,
          version: String(info.version ?? ""),
          os: String(info.os ?? ""),
          pid: Number(info.pid ?? 0),
          commands: Array.isArray(info.commands) ? info.commands.map(String) : [],
        };
        this.current = "open";
        const queued = this.outbox;
        this.outbox = [];
        for (const frame of queued) this.write(frame);
        opened(this.hostInfo);
      },
      reject: (error) => {
        const message = `The host refused the connection: ${messageOf(error)}`;
        this.end({ code: "Invalid", message }, new Error(message));
      },
    });
    duplex.onData((chunk) => {
      if (this.current === "closed") return;
      try {
        this.parser.push(chunk);
      } catch (err) {
        const message = `The host sent something that isn't the protocol: ${messageOf(err)}`;
        this.end({ code: "Io", message }, new Error(message));
      }
    });
    duplex.onClose((error) => {
      const message = error
        ? `The host connection broke: ${error.message}`
        : "The host connection closed.";
      this.end({ code: "Io", message }, error ?? new Error(message));
    });
    this.write(
      encodeFrame({
        id: 1,
        method: "$/hello",
        params: {
          protocol: STREAM_PROTOCOL,
          client: options.client ?? "brain",
          ...(options.token !== undefined && { token: options.token }),
        },
      }),
    );
  }

  get state(): TransportState {
    return this.current;
  }

  /** The host's handshake answer, once open. */
  get host(): HostInfo | null {
    return this.hostInfo;
  }

  request(command: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.send((id) =>
      encodeFrame({ id, method: command, ...(args !== undefined && { params: args }) }),
    );
  }

  requestRaw(command: string, body: RawBody, headers: Record<string, string>): Promise<unknown> {
    const bytes =
      body instanceof Uint8Array
        ? body
        : body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : Uint8Array.from(body);
    return this.send((id) => encodeFrame({ id, method: command, raw: true, headers }, bytes));
  }

  /** One request: `frame` builds it for the id it's given. */
  private send(frame: (id: number) => Uint8Array): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.current === "closed") {
        reject({ ...this.closedWith });
        return;
      }
      const id = this.nextRequest++;
      let bytes: Uint8Array;
      try {
        bytes = frame(id);
      } catch (err) {
        // Args that can't be JSON (a cycle, a BigInt): this call's failure, not the connection's.
        reject({ code: "Invalid", message: messageOf(err) });
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.post(bytes);
    });
  }

  openChannel(onMessage: (message: unknown) => void, onEnd?: () => void): TransportChannel {
    if (this.current === "closed") return { id: 0, wire: () => null, close: () => {} };
    const id = this.nextChannel++;
    this.channels.set(id, { onMessage, onEnd });
    return {
      id,
      wire: () => ({ __channel: id }),
      close: () => {
        // Only the first close of an open channel tells the host.
        if (!this.channels.delete(id) || this.current === "closed") return;
        this.post(encodeFrame({ method: "$/channelClose", params: { channel: id } }));
      },
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.current === "closed") {
      listener(this.closeError);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** True when the host's handshake listed `command` (false before it has answered). */
  hasCommand(command: string): boolean {
    return this.hostInfo?.commands.includes(command) ?? false;
  }

  /**
   * Asks the host to shut down (it kills its children, flushes its stores and exits), then
   * closes the connection. Resolves when the host has answered or `timeoutMs` passed; never
   * rejects.
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    if (this.current === "closed") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = this.send((id) => encodeFrame({ id, method: "$/shutdown" })).catch(() => {});
    const gaveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([answered, gaveUp]);
    clearTimeout(timer);
    this.close();
  }

  /** Calls sent and not answered yet (a program ending in order waits for none). */
  get pendingCalls(): number {
    return this.pending.size;
  }

  /** The id the next call gets: every call sent from now on has this id or a later one. */
  get nextCallId(): number {
    return this.nextRequest;
  }

  /**
   * Calls with the id `from` or a later one that aren't answered yet: what was sent since a
   * moment (`nextCallId` then), without the older ones still out (a slow probe from the start).
   */
  pendingCallsFrom(from: number): number {
    let count = 0;
    for (const id of this.pending.keys()) if (id >= from) count++;
    return count;
  }

  /** Closes the connection from this side: pending calls fail, channels end. */
  close(): void {
    this.end({ code: "Io", message: "The host connection was closed." }, undefined);
  }

  /** Sends now, or after the handshake when it hasn't been answered yet. */
  private post(frame: Uint8Array): void {
    if (this.current === "connecting") this.outbox.push(frame);
    else if (this.current === "open") this.write(frame);
  }

  private write(frame: Uint8Array): void {
    try {
      this.duplex.write(frame);
    } catch (err) {
      const message = `The host connection broke: ${messageOf(err)}`;
      this.end({ code: "Io", message }, new Error(message));
    }
  }

  private received(header: FrameHeader, body: Uint8Array): void {
    if (typeof header.channel === "number") {
      const channel = this.channels.get(header.channel);
      if (!channel) return; // closed here: the host hasn't heard yet
      // The host dropped its end (not in v1 of the contract; harmless to understand).
      if (header.end === true) {
        this.channels.delete(header.channel);
        return;
      }
      try {
        channel.onMessage(header.raw === true ? ownBuffer(body) : header.data);
      } catch (err) {
        // A throwing handler must not stall the stream, nor the frames behind this one.
        (this.options.onHandlerError ?? logHandlerError)(err);
      }
      return;
    }
    if (typeof header.id !== "number") return;
    const waiting = this.pending.get(header.id);
    if (!waiting) return;
    this.pending.delete(header.id);
    if ("error" in header) waiting.reject(header.error);
    else waiting.resolve(header.raw === true ? ownBuffer(body) : header.result);
  }

  /** The one way the connection ends; later calls are no-ops. */
  private end(reason: WireError, error: Error | undefined): void {
    if (this.current === "closed") return;
    if (this.current === "connecting") {
      // The handshake never completed: `ready` says why (its own pending entry says nothing).
      this.pending.delete(1);
      this.rejectReady(error ?? new Error(reason.message));
    }
    this.current = "closed";
    this.closedWith = reason;
    this.closeError = error;
    this.outbox = [];
    const pending = [...this.pending.values()];
    this.pending.clear();
    const channels = [...this.channels.values()];
    this.channels.clear();
    try {
      this.duplex.close();
    } catch {
      // Already gone.
    }
    for (const call of pending) call.reject({ ...reason });
    for (const channel of channels) {
      try {
        channel.onEnd?.();
      } catch (err) {
        (this.options.onHandlerError ?? logHandlerError)(err);
      }
    }
    const listeners = [...this.closeListeners];
    this.closeListeners.clear();
    for (const listener of listeners) {
      try {
        listener(error);
      } catch (err) {
        (this.options.onHandlerError ?? logHandlerError)(err);
      }
    }
  }
}

/** A transport on `duplex`, once the host has answered the handshake. */
export async function connectStream(
  duplex: ByteDuplex,
  options?: StreamTransportOptions,
): Promise<StreamTransport> {
  const transport = new StreamTransport(duplex, options);
  await transport.ready;
  return transport;
}

/** A frame's body as an ArrayBuffer of its own (what the desktop hands a raw result as). */
function ownBuffer(body: Uint8Array): ArrayBuffer {
  const buffer = body.buffer;
  if (
    buffer instanceof ArrayBuffer &&
    body.byteOffset === 0 &&
    body.byteLength === buffer.byteLength
  )
    return buffer;
  return body.slice().buffer as ArrayBuffer;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error)
    return String((error as { message: unknown }).message);
  return String(error);
}

function logHandlerError(error: unknown): void {
  console.error(error);
}
