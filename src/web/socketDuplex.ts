// A WebSocket as the byte stream the host's wire runs on (`core/ipc/streamTransport.ts`): each
// chunk written is one binary message, and the messages that arrive are the stream's chunks.
// The host's `--listen-ws` carrier is the other end.
import type { ByteDuplex } from "../core/ipc/streamTransport";

/** How long a socket has to open before the attempt is given up. */
const OPEN_WITHIN_MS = 10_000;

/** A duplex on a new socket to `url`. Bytes written before it opens are sent once it has. */
export function socketDuplex(url: string): ByteDuplex {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let onData: (chunk: Uint8Array) => void = () => {};
  let onClose: (error?: Error) => void = () => {};
  let queued: Uint8Array[] | null = [];
  let opened = false;
  let done = false;
  const end = (error?: Error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    queued = null;
    onClose(error);
  };
  const timer = setTimeout(() => {
    if (opened) return;
    socket.close();
    end(new Error("The host didn't answer."));
  }, OPEN_WITHIN_MS);
  socket.addEventListener("open", () => {
    opened = true;
    clearTimeout(timer);
    for (const bytes of queued ?? []) socket.send(bytes as BufferSource);
    queued = null;
  });
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) onData(new Uint8Array(event.data));
    // Text has no place on this wire.
    else socket.close();
  });
  socket.addEventListener("close", (event) => {
    // A browser gives a page no reason for a refused connection: only that it never opened.
    if (!opened)
      end(new Error("Couldn't reach the host. Is it running, and is this page allowed?"));
    else end(event.wasClean ? undefined : new Error("The connection was lost."));
  });
  return {
    write(bytes) {
      if (done) throw new Error("The host connection is closed.");
      if (queued) queued.push(bytes);
      else socket.send(bytes as BufferSource);
    },
    onData(listener) {
      onData = listener;
    },
    onClose(listener) {
      onClose = listener;
    },
    close() {
      socket.close();
    },
  };
}
