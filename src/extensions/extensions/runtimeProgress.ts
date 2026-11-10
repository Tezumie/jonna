// `ide.ui.withProgress` (VS Code's `window.withProgress`) on the host: a progress toast
// ("notification", with Cancel when cancellable) or a status bar item ("window") per task, from
// the worker's ui.progressStart / progressReport / progressEnd (core/extensions/rpc.ts). Cancel
// calls the worker ("progress"); everything goes when the extension stops.
import type { Disposable } from "../../core/lifecycle/index";
import { signal } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { ExtensionWorker } from "./workerHost";

const MAX_TASKS = 10;

interface Task {
  update(message: string, percent?: number): void;
  close(): void;
  percent: number | undefined;
}

const clean = (v: unknown, max: number) =>
  String(v ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's removed
    .replace(/[\u0000-\u001f]/g, " ")
    .slice(0, max);

export class ExtensionProgress implements Disposable {
  private readonly tasks = new Map<string, Task>();

  constructor(
    private readonly deps: {
      services: WorkbenchServices;
      owner: string;
      displayName: string;
      worker(): Promise<ExtensionWorker>;
    },
  ) {}

  /** Handles ui.progress*; false for other methods. */
  handle(method: string, p: Record<string, unknown>): boolean {
    const id = String(p.id ?? "");
    switch (method) {
      case "ui.progressStart":
        this.start(id, p);
        return true;
      case "ui.progressReport": {
        const task = this.tasks.get(id);
        if (!task) return true;
        const increment = typeof p.increment === "number" && p.increment > 0 ? p.increment : 0;
        if (increment) task.percent = Math.min(100, (task.percent ?? 0) + increment);
        task.update(typeof p.message === "string" ? clean(p.message, 300) : "", task.percent);
        return true;
      }
      case "ui.progressEnd":
        this.tasks.get(id)?.close();
        this.tasks.delete(id);
        return true;
      default:
        return false;
    }
  }

  private start(id: string, p: Record<string, unknown>): void {
    if (!/^[\w-]{1,40}$/.test(id) || this.tasks.has(id)) return;
    if (this.tasks.size >= MAX_TASKS) return;
    const title = clean(p.title, 120);
    const { services, displayName } = this.deps;
    if (p.location === "window") {
      // The status bar: "$(refresh-cw) Title: message (40%)".
      const text = signal("");
      const show = (message: string, percent?: number) => {
        const what = [title, message].filter(Boolean).join(": ") || displayName;
        text.value = `$(refresh-cw) ${what}${percent !== undefined ? ` (${Math.round(percent)}%)` : ""}`;
      };
      show("");
      const off = services.statusBar.add({
        id: `ext:${this.deps.owner}:progress:${id}`,
        name: `${displayName}: progress`,
        alignment: "left",
        priority: 50,
        text: () => text.value,
        tooltip: () => `${displayName}: ${title || "working"}`,
      });
      this.tasks.set(id, {
        percent: undefined,
        update: (message, percent) => show(message, percent),
        close: () => off.dispose(),
      });
      return;
    }
    let lastMessage = "";
    const toast = services.notifications.progress(title || displayName, {
      title: displayName,
      ...(p.cancellable === true && {
        onCancel: () =>
          void this.deps
            .worker()
            .then((w) => w.notify("progress", id))
            .catch(() => {}),
      }),
    });
    this.tasks.set(id, {
      percent: undefined,
      update: (message, percent) => {
        if (message) lastMessage = message;
        toast.update([title, lastMessage].filter(Boolean).join(": "), percent);
      },
      close: () => toast.close(),
    });
  }

  dispose(): void {
    for (const t of this.tasks.values()) t.close();
    this.tasks.clear();
  }
}
