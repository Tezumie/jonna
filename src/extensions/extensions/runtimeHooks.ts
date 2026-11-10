// The host side of rpcHooks.ts, rpcComments.ts and rpcChat.ts, beside runtime.ts (D248): the `type`
// command override and the cursor style (runtime.ts hands it `commands.register "type"` and
// `default:type`), URI handlers, `workspace.applyEdit` across files, will-save participants and
// multi-select quick picks; comments (runtimeComments.ts) and the language model and chat
// participants (runtimeLm.ts). What an extension adds goes into
// `services.extensionFeatures.hooks` (workbench/extensionHooks.ts), owned by it, and goes when it
// stops.
import type { Caller } from "../../core/dispatcher/types";
import { hasPermission, type ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { fsIpc } from "../../core/ipc/fs";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, joinPath, samePath } from "../../core/paths/index";
import { toCursorStyle } from "../../workbench/extensionHooks";
import { uriScheme } from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import {
  applyTextEdits,
  type EditStep,
  lineCount,
  planWorkspaceEdit,
} from "../../workbench/textEdits";
import { UNHANDLED } from "./runtimeApi";
import { ExtensionCommentsHost } from "./runtimeComments";
import { ExtensionLmHost } from "./runtimeLm";
import { ExtensionQuickInputHost } from "./runtimeQuickInput";
import { ExtensionTabsHost } from "./runtimeTabs";
import { ExtensionViewStates } from "./runtimeViews";
import { safeIcon, type TreeSource } from "./treeView";
import type { ExtensionWorker } from "./workerHost";

/** The user said they'd seen that an extension handles typing (the notice isn't shown again). */
export const TYPE_ACKNOWLEDGED = "extensions.typeOverride.acknowledged";
/** Extensions the user turned typing off for. */
export const TYPE_BLOCKED = "extensions.typeOverride.blocked";

export interface HooksHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  caller: Caller;
  need(permission: string, what: string): void;
  granted(): readonly string[];
  workspacePath(path: unknown): string;
  writablePath(path: unknown): string;
  worker(): Promise<ExtensionWorker>;
  running(): ExtensionWorker | null;
}

const settingList = (services: WorkbenchServices, key: string): string[] => {
  const v = services.settings.peek<unknown>(key);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
};

/** Adds `id` to a user setting's list (once). */
export async function addToSettingList(
  services: WorkbenchServices,
  key: string,
  id: string,
): Promise<void> {
  const list = settingList(services, key);
  if (!list.includes(id)) await services.settings.update(key, [...list, id], "user");
}

export class ExtensionHooksHost implements Disposable {
  private readonly store = new DisposableStore();
  private typing: Disposable | null = null;
  private uriHandler: Disposable | null = null;
  private readonly willSave = new Map<"text" | "notebook", Disposable>();
  private readonly comments: ExtensionCommentsHost;
  private readonly lm: ExtensionLmHost;
  private readonly quickInput: ExtensionQuickInputHost;
  /** window.tabGroups' snapshots and closing (runtime.ts subscribes "tabs.didChange" here). */
  readonly tabs: ExtensionTabsHost;
  /** Its views' visibility and badges (runtime.ts tracks each view instance here). */
  readonly views: ExtensionViewStates;

  constructor(private readonly deps: HooksHostDeps) {
    this.comments = this.store.add(new ExtensionCommentsHost(deps));
    this.lm = this.store.add(new ExtensionLmHost(deps));
    this.quickInput = this.store.add(new ExtensionQuickInputHost(deps));
    this.tabs = this.store.add(new ExtensionTabsHost(deps.services));
    this.views = this.store.add(new ExtensionViewStates(deps));
  }

  private get hooks() {
    return this.deps.services.extensionFeatures.hooks;
  }

  /** Activation on a link for it (VS Code's "onUri"). */
  contribute(): void {
    const { manifest } = this.deps;
    if (manifest.main && manifest.activation.includes("onUri"))
      this.store.add(
        this.hooks.onWillNeedUriHandler((id) => {
          if (id === manifest.id) void this.deps.worker().catch(() => {});
        }),
      );
  }

  // ---- The `type` override ---------------------------------------------------------------------

  /** `commands.register("type")`: what the user types in the editor goes to the extension. */
  claimTyping(): void {
    const { manifest, services } = this.deps;
    this.deps.need("fs.write", "handle what's typed in the editor");
    if (settingList(services, TYPE_BLOCKED).includes(manifest.id))
      throw new Error(
        `Typing in the editor was turned off for ${manifest.displayName} (the ${TYPE_BLOCKED} setting).`,
      );
    this.typing?.dispose();
    this.typing = this.hooks.claimTyping({
      owner: manifest.id,
      name: manifest.displayName,
      type: async (text) => {
        const worker = this.deps.running() ?? (await this.deps.worker());
        await worker.call("command", "type", { text }, { caller: "user" }, 10_000);
      },
    });
    if (!settingList(services, TYPE_ACKNOWLEDGED).includes(manifest.id))
      services.notifications.show(
        "info",
        `${manifest.displayName} now handles what you type in the editor.`,
        {
          title: manifest.displayName,
          actions: [
            {
              label: "Keep",
              run: () => void addToSettingList(services, TYPE_ACKNOWLEDGED, manifest.id),
            },
            {
              label: "Turn off",
              run: () =>
                void services.dispatcher
                  .execute("extensions.turnOffTypeOverride", { id: manifest.id })
                  .catch(() => {}),
            },
          ],
        },
      );
  }

  releaseTyping(): void {
    this.typing?.dispose();
    this.typing = null;
    this.hooks.setCursorStyle(this.deps.manifest.id, null);
  }

  /** `default:type`: the editor types `text` as it would without the override. */
  defaultType(input: unknown): Promise<unknown> {
    this.deps.need("fs.write", "type into the editor");
    const text = (input as { text?: unknown } | null)?.text;
    if (typeof text !== "string") throw new Error("default:type needs { text }.");
    // Only the extension that owns typing passes keystrokes on (others use ide.editor.insert).
    if (this.hooks.typeOwner.peek()?.owner !== this.deps.manifest.id)
      throw new Error("Only the extension that handles typing can use default:type.");
    const type = this.hooks.typeDefault;
    if (!type) throw new Error("No editor is open.");
    return type(text).then((typed) => ({ typed }));
  }

  // ---- Tree views: drag and drop, checkboxes ---------------------------------------------------

  private readonly treeDrops = new Set<string>();

  /** `tree.register`: whether its rows can be dragged onto each other (a drop handler). */
  treeRegistered(viewId: string, p: Record<string, unknown>): void {
    if (p.dragAndDrop === true) this.treeDrops.add(viewId);
    else this.treeDrops.delete(viewId);
  }

  /** What a tree view of `viewId` sends the extension: drops and checkbox clicks. */
  treeSource(
    viewId: string,
  ): Pick<TreeSource, "canDrop" | "drop" | "check" | "selected" | "expanded"> {
    const failed = (err: unknown) =>
      this.deps.services.notifications.show(
        "error",
        err instanceof Error ? err.message : String(err),
      );
    return {
      canDrop: () => this.treeDrops.has(viewId),
      drop: (target, sources) =>
        void this.deps
          .worker()
          .then((w) =>
            w.call("provider", `tree.${viewId}.drop`, { target: target ?? null, sources }),
          )
          .catch(failed),
      check: (item, checked) =>
        void this.deps
          .worker()
          .then((w) =>
            w.call("provider", `tree.${viewId}.checkbox`, { changes: [{ item, checked }] }),
          )
          .catch(failed),
      // D258: only to a running worker (selecting rows doesn't start an extension).
      selected: (items) => {
        const w = this.deps.running();
        if (w) void w.call("provider", `tree.${viewId}.selection`, { items }).catch(() => {});
      },
      // VS Code's onDidExpandElement / onDidCollapseElement (only to a running worker).
      expanded: (item, expanded) =>
        this.deps.running()?.notify("provider", `tree.${viewId}.expanded`, { item, expanded }),
    };
  }

  // ---- Requests --------------------------------------------------------------------------------

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "editor.setOptions": {
        const style = toCursorStyle(p.cursorStyle);
        if (p.cursorStyle !== null && p.cursorStyle !== undefined && !style)
          throw new Error(`Unknown cursor style ${String(p.cursorStyle)}.`);
        this.hooks.setCursorStyle(this.deps.manifest.id, style);
        return Promise.resolve(undefined);
      }
      case "uri.register": {
        this.uriHandler?.dispose();
        this.uriHandler = this.hooks.registerUriHandler({
          owner: this.deps.manifest.id,
          handle: async (uri) => {
            const worker = await this.deps.worker();
            await worker.call("provider", "uri.handle", uri);
          },
        });
        return Promise.resolve(undefined);
      }
      case "uri.unregister":
        this.uriHandler?.dispose();
        this.uriHandler = null;
        return Promise.resolve(undefined);
      case "workspace.applyEdit":
        return this.applyEdit(p.entries);
      case "workspace.willSave":
        return Promise.resolve(this.setWillSave(p.kind === "notebook" ? "notebook" : "text", p.on));
      case "ui.showQuickPick":
        // Only the multi-select kind is ours; runtime.ts shows the others.
        if (p.canPickMany !== true) return UNHANDLED;
        return pickMany(this.deps.services, p);
      default: {
        for (const host of [this.comments, this.quickInput, this.tabs, this.views]) {
          const handled = host.handle(method, p);
          if (handled !== UNHANDLED) return handled;
        }
        return this.lm.handle(method, p);
      }
    }
  }

  private setWillSave(kind: "text" | "notebook", on: unknown): void {
    this.willSave.get(kind)?.dispose();
    this.willSave.delete(kind);
    if (on === false) return;
    // Listening is reading the files' paths; the edits it returns change them.
    this.deps.need("fs.read", "follow saves");
    const { manifest } = this.deps;
    this.willSave.set(
      kind,
      this.hooks.addWillSave({
        owner: manifest.id,
        kind,
        run: async (context) => {
          const worker = this.deps.running();
          // A stopped worker isn't started for a save (it holds the save up).
          if (!worker) return [];
          const edits = await worker.call<unknown>("provider", `willSave.${kind}`, context);
          if (kind !== "text" || !Array.isArray(edits) || !edits.length) return [];
          if (!hasPermission(this.deps.granted(), "fs.write")) return [];
          // The file saved may be one it can't write (outside the folders, inside .git): its
          // edits are dropped, as applyEdit would refuse them. Extension file systems' URIs pass.
          if (!uriScheme(context.path)) {
            try {
              this.deps.writablePath(context.path);
            } catch {
              return [];
            }
          }
          return planWorkspaceEdit(
            edits.map((e) => ({ ...(e as object), kind: "text", path: context.path })),
            () => context.path,
          ).flatMap((s) => (s.kind === "text" ? s.edits : []));
        },
      }),
    );
  }

  /** VS Code's workspace.applyEdit: every step in order; the first that fails stops the rest. */
  private async applyEdit(raw: unknown): Promise<void> {
    this.deps.need("fs.write", "change files");
    const steps = planWorkspaceEdit(raw, (path) => this.deps.writablePath(path));
    for (const step of steps) await this.applyStep(step);
  }

  private async applyStep(step: EditStep): Promise<void> {
    const { services, caller } = this.deps;
    const { dispatcher, events } = services;
    const exists = (path: string) =>
      fsIpc.stat(path).then(
        () => true,
        () => false,
      );
    switch (step.kind) {
      case "text": {
        // An open file changes in its editor (one undoable edit, unsaved); a closed one on disk.
        const { text } = (await dispatcher.execute(
          "editor.getText",
          { path: step.path },
          caller,
        )) as {
          text: string;
        };
        const next = applyTextEdits(text, step.edits);
        if (next !== text)
          await dispatcher.execute(
            "editor.replaceRange",
            { path: step.path, startLine: 1, endLine: lineCount(text), text: next },
            caller,
          );
        return;
      }
      case "create": {
        if (await exists(step.path)) {
          if (step.ignoreIfExists) return;
          if (!step.overwrite) throw new Error(`${step.path} already exists.`);
        }
        await fsIpc.write(step.path, new TextEncoder().encode(step.contents), "extension");
        events.emit("files.didCreate", { path: step.path, kind: "file" });
        return;
      }
      case "rename": {
        if (await exists(step.to)) {
          if (step.ignoreIfExists) return;
          if (!step.overwrite) throw new Error(`${step.to} already exists.`);
          await fsIpc.trash(step.to);
          events.emit("files.didDelete", { path: step.to });
        }
        // The explorer's own commands: open editors follow, and it's on the undo stack.
        let at = step.from;
        if (!samePath(dirname(step.from), dirname(step.to))) {
          const moved = (await dispatcher.execute(
            "explorer.move",
            { paths: [step.from], dest: dirname(step.to) },
            caller,
          )) as { moved?: string[] } | null;
          at = moved?.moved?.[0] ?? joinPath(dirname(step.to), basename(step.from));
        }
        const name = basename(step.to);
        if (basename(at) !== name)
          await dispatcher.execute(
            "explorer.rename",
            { path: at, newName: name, updateImports: false },
            caller,
          );
        return;
      }
      case "delete": {
        if (!(await exists(step.path))) {
          if (step.ignoreIfNotExists) return;
          throw new Error(`${step.path} doesn't exist.`);
        }
        // To the app's trash, after the user confirms (explorer.delete is destructive).
        await dispatcher.execute("explorer.delete", { path: step.path }, caller);
        return;
      }
    }
  }

  /** The worker died: what it served ends (the override first: typing must never get stuck). */
  workerGone(): void {
    this.releaseTyping();
    this.uriHandler?.dispose();
    this.uriHandler = null;
    for (const d of this.willSave.values()) d.dispose();
    this.willSave.clear();
    this.comments.workerGone();
    this.lm.workerGone();
    this.quickInput.workerGone();
    this.views.workerGone();
  }

  dispose(): void {
    this.workerGone();
    this.store.dispose();
  }
}

/**
 * A quick pick where several items are checked (VS Code's canPickMany): a session with a
 * checkbox per row (a click or Space checks it), Enter accepts. Resolves with the checked
 * indexes, or null (cancelled).
 */
function pickMany(
  services: WorkbenchServices,
  p: Record<string, unknown>,
): Promise<number[] | null> {
  const items = (Array.isArray(p.items) ? p.items : []).slice(0, 5000).map((raw) => {
    const item = (raw ?? {}) as Record<string, unknown>;
    return {
      label: String(item.label ?? ""),
      ...(typeof item.description === "string" && { description: item.description }),
      ...(typeof item.detail === "string" && { detail: item.detail.slice(0, 1000) }),
      ...(typeof item.separator === "string" && { separator: item.separator.slice(0, 80) }),
      ...(typeof item.icon === "string" && { icon: safeIcon(item.icon, "circle-dot") }),
      picked: item.picked === true,
    };
  });
  let checked = items.flatMap((item, i) => (item.picked ? [i] : []));
  const placeholder = typeof p.placeholder === "string" ? p.placeholder : "";
  return new Promise((resolve) => {
    let done = false;
    const session = services.quickInput.openSession(
      "pick",
      {
        items: items.map(({ picked: _picked, ...item }) => item),
        canSelectMany: true,
        selectedIndexes: checked,
        placeholder: placeholder || "Choose items, then press Enter",
        ...(p.matchOnDescription === true && { matchOnDescription: true }),
      },
      {
        value: () => {},
        active: () => {},
        selection: (indexes) => {
          checked = indexes;
        },
        accept: () => {
          if (done) return;
          done = true;
          resolve([...checked].sort((a, b) => a - b));
          session.hide();
        },
        button: () => {},
        itemButton: () => {},
        hide: () => {
          if (done) return;
          done = true;
          resolve(null);
        },
      },
    );
  });
}
