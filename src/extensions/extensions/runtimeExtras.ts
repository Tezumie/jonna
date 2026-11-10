// More of an extension's API (D202), beside runtime.ts and runtimeApi.ts: workspace trust, the
// folder's open / close events (and folders added or taken out, D251), context keys for its `when` clauses, modal dialogs and the state
// paths its code fills. Like the rest, every request is checked here and what the extension adds
// goes when it stops (or its worker dies).
import type { ContextValue } from "../../core/context/index";
import {
  hasPermission,
  ownStatePrefix,
  ownsStatePath,
  type ThirdPartyManifest,
} from "../../core/extensions/thirdParty";
import { dialogIpc } from "../../core/ipc/system";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import type { ExtensionWorker } from "./workerHost";

const MAX_CONTEXT_KEYS = 100;
const MAX_STATE_PATHS = 20;
/** How long a state read waits for the extension's getter. */
export const STATE_TIMEOUT_MS = 2000;

/** Folder events an extension can follow (`ide.events.on`); the payload's path needs fs.read. */
export const WORKSPACE_EVENTS = [
  "workspace.didOpen",
  "workspace.willClose",
  "workspace.didClose",
  "workspace.didChangeTrust",
  // Folders added to or taken out of the workspace (D251): { added, removed } with fs.read.
  "workspace.didChangeFolders",
] as const;

export type WorkspaceEventType = (typeof WORKSPACE_EVENTS)[number];

export interface ExtrasHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  granted(): readonly string[];
  /** May claim declared paths outside ide://ext/<id> (an extension that comes with the IDE). */
  bundled: boolean;
  /** The running worker, if any (state reads don't start one). */
  worker(): ExtensionWorker | null;
}

export class ExtensionExtrasHost implements Disposable {
  private readonly store = new DisposableStore();
  private readonly contextKeys = new Set<string>();
  private readonly statePaths = new Map<string, Disposable>();
  /** One dialog at a time per extension; aborted when it stops. */
  private dialogs: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();

  constructor(private readonly deps: ExtrasHostDeps) {
    this.store.add(toDisposable(() => this.abort.abort()));
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    const { services } = this.deps;
    switch (method) {
      case "workspace.isTrusted":
        return Promise.resolve(services.trust.trusted);
      case "workspace.requireTrust":
        return services.trust
          .require(
            `${this.deps.manifest.displayName}: ${String(p.reason ?? "").slice(0, 200) || "this extension"}`,
          )
          .then(
            () => true,
            () => false,
          );
      case "context.set":
        return Promise.resolve(this.setContext(p));
      case "ui.showDialog":
        return this.dialog(p);
      // The system's file dialogs (D257: VS Code's showOpenDialog / showSaveDialog): the user
      // picks, so the paths need no permission.
      case "ui.showOpenDialog": {
        const filters = Array.isArray(p.filters)
          ? (p.filters as unknown[]).flatMap((f) => {
              const x = f as { name?: unknown; extensions?: unknown };
              const extensions = Array.isArray(x.extensions)
                ? x.extensions.filter((e): e is string => typeof e === "string").slice(0, 50)
                : [];
              return typeof x.name === "string" && extensions.length
                ? [{ name: x.name.slice(0, 80), extensions }]
                : [];
            })
          : [];
        return dialogIpc.pickPaths({
          title: this.dialogTitle(p.title),
          ...(typeof p.defaultPath === "string" && { defaultPath: p.defaultPath }),
          directory: p.folders === true,
          multiple: p.many === true,
          ...(filters.length && { filters }),
        });
      }
      case "ui.showSaveDialog":
        return dialogIpc.pickSavePath(
          this.dialogTitle(p.title),
          typeof p.defaultPath === "string" ? p.defaultPath : undefined,
        );
      case "state.register":
        return Promise.resolve(this.registerState(String(p.path ?? "")));
      case "state.unregister": {
        const path = String(p.path ?? "");
        this.statePaths.get(path)?.dispose();
        this.statePaths.delete(path);
        return Promise.resolve(undefined);
      }
      default:
        return UNHANDLED;
    }
  }

  // ---- Folder events -----------------------------------------------------------------------

  /** Follows one of WORKSPACE_EVENTS for the worker (`notify(payload)`). */
  subscribe(type: WorkspaceEventType, notify: (payload: unknown) => void): Disposable {
    const { services } = this.deps;
    // The folder's path is about the user's files: only with fs.read.
    const withPath = (path: string | null) =>
      hasPermission(this.deps.granted(), "fs.read") && path ? { path } : {};
    switch (type) {
      case "workspace.didOpen":
        return services.workspace.onDidOpen((root) => notify(withPath(root)));
      case "workspace.didClose":
        // Fired before the root changes: it's still the closing folder's.
        return services.workspace.onDidClose(() =>
          notify(withPath(services.workspace.root.peek())),
        );
      case "workspace.willClose":
        // No veto: extensions are told, the close goes on (unsaved editors may still cancel it).
        return services.workspace.onWillClose(async (reason) => {
          notify({ ...withPath(services.workspace.root.peek()), reason });
          return true;
        });
      case "workspace.didChangeFolders":
        return services.workspace.onDidChangeFolders(({ added, removed }) =>
          notify(
            hasPermission(this.deps.granted(), "fs.read")
              ? {
                  added: added.map((f) => ({ path: f.path, name: f.name, index: f.index })),
                  removed: removed.map((f) => ({ path: f.path, name: f.name, index: f.index })),
                }
              : {},
          ),
        );
      case "workspace.didChangeTrust": {
        let last = services.trust.trusted;
        return effect(() => {
          const trusted = services.trust.state.value === "trusted";
          if (trusted !== last) {
            last = trusted;
            notify({ trusted });
          }
          return undefined;
        });
      }
    }
  }

  // ---- Context keys ------------------------------------------------------------------------

  private setContext(p: Record<string, unknown>): void {
    const { id, contextNamespaces = [], contextKeys = [] } = this.deps.manifest;
    const key = String(p.key ?? "");
    // A VS Code package's keys use its commands' and settings' names ("gitlens:enabled", D256).
    // Always "<namespace>.<name>" or "<namespace>:<name>" (D261): a bare key ("workspaceTrusted")
    // would be one of the IDE's own.
    // A bare key its own `when` clauses test, while nothing else (the IDE) has set it.
    const bareKey =
      contextKeys.includes(key) &&
      (this.contextKeys.has(key) || this.deps.services.context.get(key) === undefined);
    const vscodeKey =
      bareKey ||
      (contextNamespaces.includes(key.split(/[.:]/)[0] ?? "") && /^[\w-]+[.:][\w.:-]+$/.test(key));
    if (!(key.startsWith(`${id}.`) || vscodeKey) || key.length > 120 || !/^[\w.:-]+$/.test(key))
      throw new Error(`Context keys of an extension start with "${id}." (letters, digits, . - _).`);
    const raw = p.value;
    let value: ContextValue;
    if (raw === null || raw === undefined) value = undefined;
    else if (typeof raw === "string") value = raw.slice(0, 500);
    else if (typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw)))
      value = raw;
    else throw new Error("A context key's value is a string, number, boolean or null.");
    if (
      value !== undefined &&
      !this.contextKeys.has(key) &&
      this.contextKeys.size >= MAX_CONTEXT_KEYS
    )
      throw new Error(`An extension can set at most ${MAX_CONTEXT_KEYS} context keys.`);
    this.deps.services.context.set(key, value);
    if (value === undefined) this.contextKeys.delete(key);
    else this.contextKeys.add(key);
  }

  // ---- Dialogs -----------------------------------------------------------------------------

  /** A file dialog's title, with the extension's name (the user sees who asks). */
  private dialogTitle(title: unknown): string {
    const name = this.deps.manifest.displayName;
    return typeof title === "string" && title.trim() ? `${title.slice(0, 120)} (${name})` : name;
  }

  private dialog(p: Record<string, unknown>): Promise<string | null> {
    const clean = (v: unknown, max: number) => String(v ?? "").slice(0, max);
    const title = clean(p.title, 200).trim();
    if (!title) throw new Error("A dialog needs a title.");
    const actions = (Array.isArray(p.actions) ? p.actions : []).slice(0, 4).flatMap((raw) => {
      const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const label = clean(a.label, 60).trim();
      if (!label) return [];
      const variant: "primary" | "danger" | "secondary" =
        a.variant === "primary" || a.variant === "danger" ? a.variant : "secondary";
      return [{ label, value: label as string | null, variant }];
    });
    if (!actions.length) throw new Error("A dialog needs at least one action with a label.");
    const cancel = typeof p.cancel === "string" ? clean(p.cancel, 60).trim() : "";
    const name = this.deps.manifest.displayName;
    // Said who asks: an extension's dialog mustn't pass for the IDE's own.
    const message = `${clean(p.message, 4000)}\n\nAsked by the “${name}” extension.`;
    const run = async (): Promise<string | null> => {
      if (this.abort.signal.aborted) return null;
      return showDialog<string | null>({
        title,
        message,
        actions: [
          ...(cancel ? [{ label: cancel, value: null, variant: "secondary" as const }] : []),
          ...actions,
        ],
        cancelValue: null,
        size: "md",
        signal: this.abort.signal,
      });
    };
    const next = this.dialogs.then(run, run);
    this.dialogs = next.catch(() => {});
    return next;
  }

  // ---- State paths -------------------------------------------------------------------------

  private registerState(path: string): void {
    const { manifest, services } = this.deps;
    const declared = manifest.contributes.state.find((s) => s.path === path);
    const own = ownsStatePath(manifest.id, path) && /^ide:\/\/ext\/[\w.-]+(\/[\w.-]+)*$/.test(path);
    if (!own && !(declared && this.deps.bundled))
      throw new Error(
        `${path}: an extension's state goes under ${ownStatePrefix(manifest.id)}/ (only extensions that come with the IDE may use other paths they declare).`,
      );
    this.statePaths.get(path)?.dispose();
    this.statePaths.delete(path);
    if (this.statePaths.size >= MAX_STATE_PATHS)
      throw new Error(`An extension can fill at most ${MAX_STATE_PATHS} state paths.`);
    if (services.state.has(path)) throw new Error(`${path} is already provided by something else.`);
    const off = services.state.register(path, {
      description:
        declared?.description ?? `State of the ${manifest.displayName} extension (its own code).`,
      get: async ({ params }) => {
        const worker = this.deps.worker();
        if (!worker) return { error: `${manifest.displayName} isn't running.` };
        let timer = 0;
        try {
          return await Promise.race([
            worker.call("state", path, { params }),
            new Promise<never>((_, reject) => {
              timer = window.setTimeout(
                () => reject(new Error(`${manifest.displayName} didn't answer within 2 s.`)),
                STATE_TIMEOUT_MS,
              );
            }),
          ]);
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        } finally {
          window.clearTimeout(timer);
        }
      },
    });
    this.statePaths.set(path, off);
  }

  /** The worker died: what its code registered goes (a restarted worker registers again). */
  workerGone(): void {
    for (const off of this.statePaths.values()) off.dispose();
    this.statePaths.clear();
    for (const key of this.contextKeys) this.deps.services.context.set(key, undefined);
    this.contextKeys.clear();
  }

  dispose(): void {
    this.workerGone();
    this.store.dispose();
  }
}
