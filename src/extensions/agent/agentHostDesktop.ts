// The agent's host in the window (agentHost.ts has the seams): presence read from the document,
// host prompts as the quick inputs and the dialog they always were, a web worker for workflow
// scripts. Set once when the extension starts; view code, so nothing a chat's logic reaches
// imports it.

import { extensionCodeBlocked } from "../../core/extensions/codePolicy";
import { windowIpc } from "../../core/ipc/system";
import { toDisposable } from "../../core/lifecycle/index";
import { confirmAction, showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import type { AgentHost, HostPrompts, Presence, ScriptWorker, WorkerFactory } from "./agentHost";
import { textArea } from "./view/pageKit";

/** The window hidden or without focus; a chat's view laid out on screen. */
const documentPresence: Presence = {
  away: () => document.visibilityState === "hidden" || !document.hasFocus(),
  showing: (session) =>
    !!document.querySelector<HTMLElement>(`.agent-view[data-session="${CSS.escape(session)}"]`)
      ?.offsetParent,
  requestAttention: () => void windowIpc.requestAttention().catch(() => {}),
  onDidChange: (listener) => {
    const tell = () => listener();
    document.addEventListener("visibilitychange", tell);
    window.addEventListener("focus", tell);
    window.addEventListener("blur", tell);
    return toDisposable(() => {
      document.removeEventListener("visibilitychange", tell);
      window.removeEventListener("focus", tell);
      window.removeEventListener("blur", tell);
    });
  },
};

/**
 * `asked`, closed when `asker` aborts while it is still the quick input open (there is one at a
 * time, and a newer one has already ended this one's wait).
 */
async function untilGone<T>(
  services: WorkbenchServices,
  asker: AbortSignal | undefined,
  asked: () => Promise<T | undefined>,
): Promise<T | undefined> {
  if (!asker) return asked();
  if (asker.aborted) return undefined;
  const close = () => services.quickInput.cancel();
  asker.addEventListener("abort", close, { once: true });
  try {
    return await asked();
  } finally {
    asker.removeEventListener("abort", close);
  }
}

function windowPrompts(services: WorkbenchServices): HostPrompts {
  return {
    text: ({ reason: _reason, server: _server, signal, ...options }) =>
      untilGone(services, signal, () => services.quickInput.prompt(options)),
    choose: async ({ choices, placeholder, signal }) =>
      (
        await untilGone(services, signal, () =>
          services.quickInput.pick([...choices], { placeholder }),
        )
      )?.id,
    review: async ({ title, message, label, text, signal }) => {
      const box = textArea(label, text, 10);
      const choice = await showDialog<"send" | "reject" | "closed">({
        title,
        message,
        content: box,
        size: "md",
        actions: [
          { label: "Reject", value: "reject", variant: "danger" },
          { label: "Send", value: "send", variant: "primary" },
        ],
        cancelValue: "closed",
        signal,
      });
      return { choice, text: box.value };
    },
    confirm: ({ title, message, confirmLabel, destructive }) =>
      confirmAction(title, message, confirmLabel, destructive),
    cancel: () => services.quickInput.cancel(),
  };
}

/** The bundled worker scripts, as web workers. */
const webWorkers: WorkerFactory = (script, name): ScriptWorker => {
  // A page that runs no extension code (the web build on the accounts' address, D456) runs no
  // script a model wrote either: a worker has the page's origin.
  const blocked = extensionCodeBlocked();
  if (blocked) throw new Error(blocked);
  const worker = new Worker(`./workers/${script}.worker.js`, { name });
  return {
    postMessage: (message) => worker.postMessage(message),
    onMessage: (listener) =>
      worker.addEventListener("message", (e: MessageEvent) => listener(e.data)),
    onError: (listener) =>
      worker.addEventListener("error", (e: ErrorEvent) => {
        e.preventDefault();
        listener(e.message);
      }),
    terminate: () => worker.terminate(),
  };
};

export function desktopAgentHost(services: WorkbenchServices): AgentHost {
  return {
    screen: true,
    presence: documentPresence,
    prompts: windowPrompts(services),
    workers: webWorkers,
  };
}
