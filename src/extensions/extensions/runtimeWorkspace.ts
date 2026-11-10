// The workspace's folders for one extension (D251, VS Code's multi-root workspaces; worker side
// rpcWorkspace.ts): the gate every path from the extension goes through (inside one of the
// folders, never anywhere else), the folders mirror the worker keeps (sent at start and on every
// change, "fs.read" only), `workspace.root` / `folders` / `folderOf`, updateWorkspaceFolders
// (the workspace service's addFolders / removeFolder, after asking the user before folders are
// added), and the workspaceState key.
import {
  gateWorkspacePath,
  planFolderUpdate,
  type WorkspaceSnapshot,
} from "../../core/extensions/rpcWorkspace";
import { hasPermission } from "../../core/extensions/thirdParty";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import { isGitFolderName } from "./workbenchChecks";
import type { ExtensionWorker } from "./workerHost";

export interface WorkspaceHostDeps {
  services: WorkbenchServices;
  /** The extension's name, for the question before it adds folders. */
  displayName: string;
  granted(): readonly string[];
  need(permission: string, what: string): void;
}

export class ExtensionWorkspaceHost implements Disposable {
  /** What follows the folders for the running worker (gone with it). */
  private following = new DisposableStore();

  constructor(private readonly deps: WorkspaceHostDeps) {}

  /** A workspace path from the extension (relative to the folders, or absolute inside one). */
  workspacePath(path: unknown): string {
    const ws = this.deps.services.workspace;
    return gateWorkspacePath(
      {
        root: ws.root.peek(),
        multiRoot: ws.folders.peek().length > 1,
        resolve: (p) => ws.resolve(p),
        contains: (p) => ws.contains(p),
      },
      path,
    );
  }

  /**
   * A path the extension may write: in the folders, and not inside a `.git` folder (its config
   * and hooks would run programs: core.fsmonitor, pre-commit; D207 audit).
   */
  writablePath(path: unknown): string {
    const full = this.workspacePath(path);
    if (full.split(/[\\/]/).some(isGitFolderName))
      throw new Error(`${String(path)} is inside a .git folder: extensions can't write there.`);
    return full;
  }

  /** The folders as the worker mirrors them; undefined without "fs.read" (paths are the user's). */
  snapshot(): WorkspaceSnapshot | undefined {
    if (!hasPermission(this.deps.granted(), "fs.read")) return undefined;
    const ws = this.deps.services.workspace;
    return {
      folders: ws.folders.peek().map((f) => ({ path: f.path, name: f.name, index: f.index })),
      name: ws.name.peek(),
      file: ws.file.peek(),
    };
  }

  /**
   * Keeps the started worker's mirror current: `sent` is what its start message had. Folders
   * added or taken out go as "changed" (its onDidChangeWorkspaceFolders), anything else (a
   * rename, another workspace opened or closed, saved under a name) as "snapshot".
   */
  attach(worker: ExtensionWorker, sent: WorkspaceSnapshot | undefined): void {
    this.detach();
    const store = this.following;
    const { services } = this.deps;
    let last = JSON.stringify(sent ?? null);
    store.add(
      effect(() => {
        services.workspace.folders.value;
        services.workspace.file.value;
        services.workspace.name.value;
        const now = this.snapshot();
        const text = JSON.stringify(now ?? null);
        if (now && text !== last) worker.notify("workspace", "snapshot", now);
        last = text;
        return undefined;
      }),
    );
    store.add(
      services.workspace.onDidChangeFolders(({ added, removed }) => {
        const now = this.snapshot();
        if (!now) return;
        last = JSON.stringify(now);
        worker.notify("workspace", "changed", { snapshot: now, added, removed });
      }),
    );
  }

  /** The worker stopped or died. */
  detach(): void {
    this.following.dispose();
    this.following = new DisposableStore();
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    const { services } = this.deps;
    switch (method) {
      case "workspace.root":
        this.deps.need("fs.read", "see the open folder");
        return Promise.resolve(services.workspace.root.peek());
      case "workspace.folders":
        this.deps.need("fs.read", "see the workspace's folders");
        return Promise.resolve(this.snapshot()?.folders ?? []);
      case "workspace.folderOf": {
        this.deps.need("fs.read", "see the workspace's folders");
        if (typeof p.path !== "string") throw new Error("path must be a string");
        if (!services.workspace.root.peek()) return Promise.resolve(null);
        const f = services.workspace.folderOf(services.workspace.resolve(p.path));
        return Promise.resolve(f ? { path: f.path, name: f.name, index: f.index } : null);
      }
      case "workspace.updateFolders":
        return this.updateFolders(p);
      default:
        return UNHANDLED;
    }
  }

  /**
   * updateWorkspaceFolders, checked again on the real list: the folders added (at the end) first,
   * then those taken out, so taking out every folder for new ones never empties the workspace.
   * The workspace service is called directly: the workbench's `workspace.addFolder` /
   * `removeFolder` commands are hidden from agents, and the permission policy refuses hidden
   * commands to extensions too — the user's consent below is what lets folders in. Resolves
   * false when the user declines or the change fails.
   */
  private async updateFolders(p: Record<string, unknown>): Promise<boolean> {
    this.deps.need("fs.read", "see the workspace's folders");
    this.deps.need("fs.write", "change the workspace's folders");
    const { services } = this.deps;
    const workspace = services.workspace;
    const plan = planFolderUpdate(
      workspace.folders.peek(),
      p.start,
      p.deleteCount,
      Array.isArray(p.folders) ? p.folders : [],
    );
    if (!plan) return false;
    try {
      if (plan.added.length) {
        const paths = plan.added.map((f) => f.path);
        if (!(await this.confirmAddFolders(paths))) return false;
        // Nothing added: the risky-folder caution was declined, or the folders couldn't open.
        if (!(await workspace.addFolders(paths)).length) return false;
      }
      for (const f of plan.removed) if (!(await workspace.removeFolder(f.path))) return false;
    } catch (err) {
      // The user consented to this change: say why it didn't happen.
      services.notifications.show(
        "error",
        `${this.deps.displayName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Asks the user before the extension adds folders (D251): folders joining the workspace widen
   * what everything working on it can reach. Folders already inside it change nothing.
   */
  private async confirmAddFolders(requested: readonly string[]): Promise<boolean> {
    const paths = requested.filter((p) => !this.deps.services.workspace.contains(p));
    if (!paths.length) return true;
    const shown = paths.slice(0, 10).join("\n") + (paths.length > 10 ? "\n…" : "");
    const one = paths.length === 1;
    return showDialog<boolean>({
      title: one ? "Add a folder to the workspace?" : "Add folders to the workspace?",
      message: `${this.deps.displayName} wants to add ${one ? "this folder" : "these folders"} to the workspace:\n\n${shown}\n\nThe agent, tasks and extensions can then work on ${one ? "its" : "their"} files.`,
      actions: [
        { label: "Cancel", value: false, variant: "secondary" },
        { label: "Add", value: true, variant: "primary" },
      ],
      cancelValue: false,
      defaultValue: false,
    });
  }

  /**
   * A storage key: its own, or (workspaceState, D234) under the workspace's location: the
   * folder's path for one folder (as it always was), the workspace file for a multi-root one.
   */
  storageKey(p: Record<string, unknown>): string {
    if (p.scope !== "workspace") return String(p.key);
    const location = this.deps.services.workspace.location.peek();
    if (!location) throw new Error("No folder is open (workspaceState is per folder).");
    return `workspace:${location.replace(/\\/g, "/").toLowerCase()}:${String(p.key)}`;
  }

  dispose(): void {
    this.following.dispose();
  }
}
