// Which Node.js runs extensions' code (D267): `node` on PATH, else the pinned Node the IDE
// downloaded before (src-tauri/src/node_runtime.rs), else — asked first — that download now
// (about 30 MB from nodejs.org, checked against its SHA-256, kept in the app's data folder for
// extensions only). Declined, the extension's start fails saying how to install Node.

import { extIpc } from "../../core/ipc/extensions";
import { execIpc } from "../../core/ipc/process";
import { signal } from "../../core/reactive/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";

/** The download's progress while it runs (the status bar shows it). */
export const nodeDownload = signal<string | null>(null);

let pending: Promise<string> | null = null;
/** Declined this session: not asked again until the IDE restarts. */
let declined = false;

/** Downloads the pinned Node.js (the status bar shows how far it is); its program. */
export async function downloadNode(services: WorkbenchServices): Promise<string> {
  pending ??= (async () => {
    try {
      nodeDownload.value = "Downloading Node.js…";
      const path = await extIpc.nodeInstall((p) => {
        nodeDownload.value =
          p.phase === "download"
            ? `Downloading Node.js… ${p.total ? Math.round((p.received / p.total) * 100) : Math.round(p.received / 1_048_576)}${p.total ? "%" : " MB"}`
            : p.phase === "verify"
              ? "Checking Node.js…"
              : p.phase === "unpack"
                ? "Unpacking Node.js…"
                : "Node.js is ready";
      });
      services.notifications.show("success", "Node.js is ready for extensions.");
      return path;
    } finally {
      nodeDownload.value = null;
      pending = null;
    }
  })();
  return pending;
}

/** The program to start the extension host with. */
export async function nodeProgram(services: WorkbenchServices): Promise<string> {
  const [onPath] = await execIpc.installed(["node"]).catch(() => [true]);
  if (onPath) return "node";
  const status = await extIpc.nodeStatus().catch(() => null);
  if (status?.path) return status.path;
  // Nothing to offer (no build for this platform) or already declined: `node`, whose start
  // fails saying how to install it.
  if (!status?.available || declined) return "node";
  if (pending) return pending;
  const answer = await showDialog<"download" | "cancel">({
    title: "Download Node.js for extensions?",
    message: `Extensions written for VS Code run their code in Node.js, which isn't installed on this computer. The IDE can download Node.js ${status.version} from nodejs.org (about 30 MB, checked against its published SHA-256) and keep it for extensions only. You can also install Node.js 18 or newer yourself.`,
    actions: [
      { label: "Not now", value: "cancel", variant: "secondary" },
      { label: "Download", value: "download", variant: "primary" },
    ],
    cancelValue: "cancel",
    defaultValue: "download",
  });
  if (answer !== "download") {
    declined = true;
    return "node";
  }
  return downloadNode(services);
}
