// The events an extension's worker follows (`ide.events.on`: `events.subscribe` /
// `events.unsubscribe`), apart from runtime.ts because it's one long list of sources read
// together: the folder's lifecycle and trust, the theme, git, documents as they're edited, the
// active editor, the editor tabs and the IDE's file, notebook and debug events. Each
// subscription lasts until the worker ends it or the extension goes.
import type { Disposable } from "../../core/lifecycle/index";
import type { IdeEvents, WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import {
  EDITOR_EVENTS,
  type EditorEventType,
  type ExtensionEditorEvents,
} from "./runtimeEditorEvents";
import {
  type ExtensionExtrasHost,
  WORKSPACE_EVENTS,
  type WorkspaceEventType,
} from "./runtimeExtras";
import type { ExtensionGitHost } from "./runtimeGit";
import type { ExtensionHooksHost } from "./runtimeHooks";
import type { ExtensionWorker } from "./workerHost";

/** Events an extension may subscribe to (all are about files: they need fs.read). */
const EVENTS: readonly (keyof IdeEvents)[] = [
  "files.didCreate",
  "files.didRename",
  "files.didDelete",
  "files.didSave",
  "files.didChange",
  "documents.didOpen",
  "documents.didClose",
  // Notebooks in the notebook editor (D204).
  "notebook.didOpen",
  "notebook.didChange",
  "notebook.didSave",
  "notebook.didClose",
  "notebook.didRunCell",
  // The debugger's sessions and breakpoints (D255).
  "debug.didStartSession",
  "debug.didTerminateSession",
  "debug.didChangeActiveSession",
  "debug.didChangeBreakpoints",
  "debug.didReceiveCustomEvent",
  "debug.didChangeActiveStackItem",
];

export interface SubscriptionsDeps {
  services: WorkbenchServices;
  need(permission: string, what: string): void;
  /** The running worker (an event never starts one). */
  running(): ExtensionWorker | null;
  extras: ExtensionExtrasHost;
  git: ExtensionGitHost;
  editorEvents: ExtensionEditorEvents;
  /** The editor tabs' snapshots (runtimeTabs.ts). */
  hooks: ExtensionHooksHost;
}

/** The requests answered here. */
const REQUESTS: ReadonlySet<string> = new Set(["events.subscribe", "events.unsubscribe"]);

export class ExtensionSubscriptions implements Disposable {
  private readonly events = new Map<string, Disposable>();

  constructor(private readonly deps: SubscriptionsDeps) {}

  /** One of the requests above, or UNHANDLED. */
  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    return REQUESTS.has(method) ? this.answer(method, p) : UNHANDLED;
  }

  private async answer(method: string, p: Record<string, unknown>): Promise<unknown> {
    const { services } = this.deps;
    switch (method) {
      case "events.subscribe": {
        const sub = String(p.sub);
        // The folder's lifecycle and trust (D202): no permission (the path needs fs.read).
        if ((WORKSPACE_EVENTS as readonly string[]).includes(String(p.type))) {
          this.events.get(sub)?.dispose();
          this.events.set(
            sub,
            this.deps.extras.subscribe(p.type as WorkspaceEventType, (payload) =>
              this.deps.running()?.notify("event", sub, payload),
            ),
          );
          return undefined;
        }
        // The theme changed (VS Code's onDidChangeActiveColorTheme): its kind, no permission.
        if (p.type === "theme.didChange") {
          const theme = services.theme;
          this.events.get(sub)?.dispose();
          this.events.set(
            sub,
            theme.onDidChange(() =>
              this.deps.running()?.notify("event", sub, { kind: theme.theme.peek() }),
            ),
          );
          return undefined;
        }
        // A repository's HEAD, index or refs moved (D208; needs "git").
        if (p.type === "git.didChange") {
          const off = this.deps.git.subscribe((payload) =>
            this.deps.running()?.notify("event", sub, payload),
          );
          this.events.get(sub)?.dispose();
          this.events.set(sub, off);
          return undefined;
        }
        // An open document's text changed as it's edited (D208; unsaved): at most every 250 ms
        // per file.
        if (p.type === "documents.didChange") {
          this.deps.need("fs.read", "follow documents.didChange");
          const timers = new Map<string, number>();
          const off = services.documents.onDidChange((path) => {
            if (timers.has(path)) return;
            timers.set(
              path,
              window.setTimeout(() => {
                timers.delete(path);
                this.deps.running()?.notify("event", sub, { path });
              }, 250),
            );
          });
          this.events.get(sub)?.dispose();
          this.events.set(sub, {
            dispose: () => {
              off.dispose();
              for (const t of timers.values()) window.clearTimeout(t);
              timers.clear();
            },
          });
          return undefined;
        }
        // The active editor, its selections and visible lines (D234; "fs.read").
        if ((EDITOR_EVENTS as readonly string[]).includes(String(p.type))) {
          this.deps.need("fs.read", `follow ${String(p.type)}`);
          this.events.get(sub)?.dispose();
          this.events.set(
            sub,
            this.deps.editorEvents.subscribe(sub, p.type as EditorEventType, (payload) =>
              this.deps.running()?.notify("event", sub, payload),
            ),
          );
          return undefined;
        }
        // The editor tabs (VS Code's window.tabGroups; runtimeTabs.ts): their files, "fs.read".
        if (p.type === "tabs.didChange") {
          this.deps.need("fs.read", "follow the editor tabs");
          this.events.get(sub)?.dispose();
          this.events.set(
            sub,
            this.deps.hooks.tabs.subscribe((snapshot) =>
              this.deps.running()?.notify("event", sub, snapshot),
            ),
          );
          return undefined;
        }
        const type = String(p.type) as keyof IdeEvents;
        if (!EVENTS.includes(type)) throw new Error(`Unknown event ${type}.`);
        this.deps.need("fs.read", `follow ${type}`);
        this.events.get(sub)?.dispose();
        this.events.set(
          sub,
          services.events.on(type, (payload) => this.deps.running()?.notify("event", sub, payload)),
        );
        return undefined;
      }
      case "events.unsubscribe": {
        const sub = String(p.sub);
        this.events.get(sub)?.dispose();
        this.events.delete(sub);
        return undefined;
      }
      default:
        throw new Error(`Unknown request ${method}.`);
    }
  }

  dispose(): void {
    for (const e of this.events.values()) e.dispose();
    this.events.clear();
  }
}
