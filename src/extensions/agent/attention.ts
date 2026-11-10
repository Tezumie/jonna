// A chat that needs the user while the window is in the background (D254): it asks a question or
// an approval, or its turn ended (finished, or stopped by an error). The taskbar button flashes
// (the Dock icon bounces, Linux marks the window urgent) and a notification with Show waits in
// the window. A group round's members taking turns count as one turn (QUIET_MS). Off with
// agent.notifyWhenAway.

import { windowIpc } from "../../core/ipc/system";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { effect, untracked } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { AgentSession } from "./session";

/** A turn that ends and stays ended this long is over (the next member doesn't take over). */
const QUIET_MS = 1500;

export function watchAttention(services: WorkbenchServices, session: AgentSession): Disposable {
  const store = new DisposableStore();
  let previous = session.status.peek();
  let timer: ReturnType<typeof setTimeout> | undefined;
  store.add({ dispose: () => clearTimeout(timer) });

  const away = () => document.visibilityState === "hidden" || !document.hasFocus();
  const tell = (kind: "info" | "success" | "error", text: string) => {
    if (!away() || services.settings.peek<boolean>("agent.notifyWhenAway") === false) return;
    void windowIpc.requestAttention().catch(() => {});
    services.notifications.show(kind, text, {
      title: session.title.peek(),
      actions: [
        {
          label: "Show",
          run: () =>
            void services.dispatcher
              .execute("agent.openSession", { session: session.id })
              .catch(() => {}),
        },
      ],
    });
  };

  store.add(
    effect(() => {
      const status = session.status.value;
      untracked(() => {
        const before = previous;
        previous = status;
        clearTimeout(timer);
        if (status === "waiting" && before !== "waiting") {
          const message = session.questions.peek().length
            ? "The agent has a question for you."
            : "The agent needs your approval to go on.";
          tell("info", message);
          // Notification hooks (D371), away or not, as Claude Code's.
          void session
            .runHook("Notification", { message, notificationType: "permission_prompt" })
            .catch(() => {});
        } else if (status === "idle" && before === "running") {
          timer = setTimeout(() => {
            if (session.status.peek() !== "idle") return;
            const error = session.error.peek();
            tell(
              error ? "error" : "success",
              error ? `The agent stopped: ${error}` : "The agent finished.",
            );
          }, QUIET_MS);
        }
      });
      return undefined;
    }),
  );
  return store;
}
