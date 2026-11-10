// Keeps the messages to one stdio program in order. Every `lsp_send` is its own async Tauri
// command, and the Rust runtime runs those concurrently: two sent in one tick (didOpen then
// didChange) could reach the program's input the other way round. Here each send of an id waits
// for the one before it. `reset` (the program restarted under the id) drops what's still queued,
// so the old program's last messages (`exit`) never reach its replacement. DOM-free, tested.

export interface OrderedSender {
  send(id: string, body: string): Promise<void>;
  /** Drops the messages for `id` not yet handed to the host. */
  reset(id: string): void;
}

export function orderedSender(write: (id: string, body: string) => Promise<void>): OrderedSender {
  const queues = new Map<string, { tail: Promise<void>; epoch: number }>();
  const queueOf = (id: string) => {
    let q = queues.get(id);
    if (!q) {
      q = { tail: Promise.resolve(), epoch: 0 };
      queues.set(id, q);
    }
    return q;
  };
  return {
    send(id, body) {
      const q = queueOf(id);
      const epoch = q.epoch;
      const next = q.tail
        .catch(() => {})
        .then(() => {
          if (q.epoch !== epoch) throw new Error(`${id} restarted before the message was sent`);
          return write(id, body);
        });
      q.tail = next;
      // Forget an idle queue (its last send settled).
      void next
        .catch(() => {})
        .then(() => {
          if (queues.get(id) === q && q.tail === next) queues.delete(id);
        });
      return next;
    },
    reset(id) {
      const q = queues.get(id);
      if (q) q.epoch++;
    },
  };
}
