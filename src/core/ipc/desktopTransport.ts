// The desktop framework's transport: its `invoke` and its channel, unchanged. The only file that
// imports the framework's call API (importing it is safe anywhere; using it needs the window's
// globals, so `invoke.ts` only builds this one when they exist).
import { Channel as FrameworkChannel, type InvokeArgs, invoke } from "@tauri-apps/api/core";
import type { RawBody, Transport, TransportChannel } from "./transport";

export function createDesktopTransport(): Transport {
  return {
    kind: "desktop",
    // The framework is connected for as long as the page lives.
    state: "open",
    request: (command, args) => invoke<unknown>(command, args as InvokeArgs | undefined),
    requestRaw: (command: string, body: RawBody, headers: Record<string, string>) =>
      invoke<unknown>(command, body, { headers }),
    openChannel(onMessage): TransportChannel {
      // The framework's channel orders the messages, takes raw ones as an ArrayBuffer, reports a
      // handler's exception as uncaught without stalling, and frees itself when the Rust side
      // drops its end. `deliver` can be silenced; the framework has no way to tell Rust.
      let deliver: (message: unknown) => void = onMessage;
      const channel = new FrameworkChannel<unknown>((message) => deliver(message));
      return {
        id: channel.id,
        // The framework's own marker ("__CHANNEL__:<id>"): what its `toJSON` would have put in
        // the args, at any depth.
        wire: () => channel.toJSON(),
        close: () => {
          deliver = () => {};
        },
      };
    },
    // Never ends before the page does.
    onClose: () => () => {},
  };
}
