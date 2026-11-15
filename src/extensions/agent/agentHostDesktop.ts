// The agent's host in the window (agentHost.ts has the seams): presence read from the document,
// host prompts as the quick inputs and the dialog they always were, a web worker for workflow
// scripts. Set once when the extension starts; view code, so nothing a chat's logic reaches
// imports it.

import { windowIpc } from "../../core/ipc/system";
import { toDisposable } from "../../core/lifecycle/index";
import { showDialog } from "../../ui/Dialog";
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

function windowPrompts(services: WorkbenchServices): HostPrompts {
  return {
    text: ({ reason: _reason, server: _server, ...options }) => services.quickInput.prompt(options),
    choose: async ({ choices, placeholder }) =>
      (await services.quickInput.pick([...choices], { placeholder }))?.id,
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
    cancel: () => services.quickInput.cancel(),
  };
}

/** The bundled worker scripts, as web workers. */
const webWorkers: WorkerFactory = (script, name): ScriptWorker => {
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
