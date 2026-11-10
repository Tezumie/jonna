// An extension's file system providers (D233, rpcAuthFs.ts on the worker side; VS Code's
// `workspace.registerFileSystemProvider`). A scheme ("memfs") is served by the extension: its
// URIs ("memfs:/notes/a.txt") open in the editor, which reads and saves through the registry
// (extensionRegistries.ts `fileSystems`), and its files show in a section of the Explorer
// (an ExtensionTreeView of its directories; not a VS Code package's, D260). Built-in schemes and
// another extension's are refused. The extension serves only its own scheme: it never reaches
// the user's other files.

import { Emitter } from "../../core/events/index";
import { fromBase64, toBase64 } from "../../core/extensions/rpcAuthFs";
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import {
  childUri,
  type FileSystemChange,
  type FileSystemEntry,
  type FileSystemStat,
  uriScheme,
} from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import { ExtensionTreeView, type HostTreeItem } from "./treeView";
import { schemeProblem } from "./workbenchChecks";
import type { ExtensionWorker } from "./workerHost";

const MAX_FILE_SYSTEMS = 5;
const MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface FileSystemsHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  worker(): Promise<ExtensionWorker>;
}

export class ExtensionFileSystemsHost implements Disposable {
  private readonly systems = new Map<
    string,
    { entry: FileSystemEntry; changed: Emitter<readonly FileSystemChange[]>; off: Disposable }
  >();
  private seq = 0;

  constructor(private readonly deps: FileSystemsHostDeps) {}

  private get owner(): string {
    return this.deps.manifest.id;
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "fs.registerProvider":
        return Promise.resolve(this.register(p));
      case "fs.unregisterProvider": {
        const id = String(p.id);
        this.systems.get(id)?.off.dispose();
        this.systems.delete(id);
        return Promise.resolve(undefined);
      }
      case "fs.changed": {
        const system = this.systems.get(String(p.id));
        if (!system) return Promise.resolve(undefined);
        const changes = (Array.isArray(p.changes) ? p.changes : []).flatMap(
          (raw): FileSystemChange[] => {
            const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
            const path = typeof c.path === "string" ? c.path : "";
            if (uriScheme(path) !== system.entry.scheme) return [];
            const kind = c.kind === "created" || c.kind === "deleted" ? c.kind : "changed";
            return [{ path, kind }];
          },
        );
        if (changes.length) {
          system.changed.fire(changes);
          // Open editors of these files reload (or show "changed on disk", D234).
          this.deps.services.extensionFeatures.fileSystems.fireChanges(changes);
        }
        return Promise.resolve(undefined);
      }
      default:
        return UNHANDLED;
    }
  }

  private register(p: Record<string, unknown>): void {
    const { services } = this.deps;
    const registry = services.extensionFeatures.fileSystems;
    const id = String(p.id ?? "");
    const scheme = String(p.scheme ?? "");
    const problem = schemeProblem(scheme);
    if (problem) throw new Error(`File system "${scheme}": ${problem}.`);
    const taken = registry.all.peek().find((f) => f.scheme === scheme);
    if (taken && taken.owner !== this.owner)
      throw new Error(`Another extension serves "${scheme}:" already.`);
    this.systems.get(id)?.off.dispose();
    // Replaced: it no longer counts (nor stays listed, disposed, if the new one fails).
    this.systems.delete(id);
    if (this.systems.size >= MAX_FILE_SYSTEMS)
      throw new Error(`An extension can serve at most ${MAX_FILE_SYSTEMS} file systems.`);
    const readonly = p.readonly === true;
    const label = String(p.label ?? scheme).slice(0, 60) || scheme;
    const call = async <T>(part: string, args: Record<string, unknown>): Promise<T> => {
      const path = typeof args.path === "string" ? args.path : undefined;
      if (path !== undefined && uriScheme(path) !== scheme)
        throw new Error(`${path} isn't a ${scheme}: path.`);
      return (await this.deps.worker()).call<T>("provider", `${id}.${part}`, args);
    };
    const writable = () => {
      if (readonly) throw new Error(`${label} is read-only.`);
    };
    const changed = new Emitter<readonly FileSystemChange[]>();
    const entry: FileSystemEntry = {
      owner: this.owner,
      scheme,
      label,
      readonly,
      stat: async (path) => {
        const s = (await call<Record<string, unknown>>("stat", { path })) ?? {};
        const stat: FileSystemStat = {
          kind: s.type === "directory" ? "dir" : "file",
          size: typeof s.size === "number" ? s.size : 0,
          mtimeMs: typeof s.mtime === "number" ? s.mtime : 0,
          readonly: readonly || s.readonly === true,
        };
        return stat;
      },
      readDirectory: async (path) => {
        const list = await call<unknown>("readDirectory", { path });
        return (Array.isArray(list) ? list : []).slice(0, MAX_ENTRIES).flatMap((e) => {
          const pair = Array.isArray(e) ? e : [];
          const name = typeof pair[0] === "string" ? pair[0] : "";
          // A name, never a path: "a/b" or ".." would reach outside the folder asked about.
          if (!name || name === "." || name === ".." || /[\\/]/.test(name)) return [];
          return [{ name, kind: pair[1] === "directory" ? ("dir" as const) : ("file" as const) }];
        });
      },
      readFile: async (path) => {
        const data = await call<unknown>("readFile", { path });
        if (typeof data !== "string") throw new Error(`${path}: no content.`);
        if (data.length > (MAX_FILE_BYTES * 4) / 3 + 4) throw new Error(`${path} is too large.`);
        return fromBase64(data);
      },
      writeFile: async (path, bytes) => {
        writable();
        await call("writeFile", { path, data: toBase64(bytes), create: true, overwrite: true });
      },
      createDirectory: async (path) => {
        writable();
        await call("createDirectory", { path });
      },
      delete: async (path, recursive) => {
        writable();
        await call("delete", { path, recursive });
      },
      rename: async (from, to, overwrite) => {
        writable();
        if (uriScheme(to) !== scheme) throw new Error(`${to} isn't a ${scheme}: path.`);
        await call("rename", { path: from, from, to, overwrite });
      },
      onDidChange: changed.event,
    };
    const store = new DisposableStore();
    store.add(changed);
    store.add(registry.add(entry));
    // A VS Code extension's file systems back its own editors: VS Code
    // shows none in the Explorer, so neither does the IDE (D260).
    if (this.deps.manifest.format !== "vscode") store.add(this.explorerSection(entry));
    this.systems.set(id, { entry, changed, off: store });
  }

  /** Its files in a section of the Explorer, refreshed when it reports changes. */
  private explorerSection(entry: FileSystemEntry): Disposable {
    const { services } = this.deps;
    return services.views.register({
      id: `explorer.ext.${this.owner}.${++this.seq}`,
      title: entry.label,
      icon: "folder",
      sectionOf: "explorer.view",
      sectionOnly: true,
      sectionOrder: 50,
      sectionDefault: { collapsed: false },
      // New file / folder at its root (D234); rows have Rename and Delete in their menu.
      ...(!entry.readonly && {
        actions: [
          {
            command: "extensions.fsNewFile",
            icon: "file-plus",
            title: "New file…",
            input: { folder: `${entry.scheme}:/` },
          },
          {
            command: "extensions.fsNewFolder",
            icon: "folder-plus",
            title: "New folder…",
            input: { folder: `${entry.scheme}:/` },
          },
        ],
      }),
      create: (host) => {
        const store = new DisposableStore();
        const tree = store.add(
          new ExtensionTreeView(
            {
              children: async (parent) => {
                const dir = parent?.id ?? `${entry.scheme}:/`;
                const list = await entry.readDirectory(dir);
                return list
                  .sort((a, b) =>
                    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
                  )
                  .map((e): HostTreeItem => {
                    const uri = childUri(dir, e.name);
                    return e.kind === "dir"
                      ? { id: uri, label: e.name, icon: "folder", collapsible: true }
                      : {
                          id: uri,
                          label: e.name,
                          icon: "file",
                          tooltip: uri,
                          command: { id: "editor.openFile", input: { path: uri } },
                        };
                  });
              },
              run: (command) =>
                void services.dispatcher
                  .execute(command.id, command.input, { kind: "user" })
                  .catch((err: unknown) =>
                    services.notifications.show(
                      "error",
                      err instanceof Error ? err.message : String(err),
                    ),
                  ),
              ready: () => true,
              menu: (item) => (entry.readonly ? { inline: [], groups: [] } : rowMenu(item)),
            },
            entry.label,
          ),
        );
        tree.element.dataset.fileSystem = entry.scheme;
        host.append(tree.element);
        store.add({ dispose: () => tree.element.remove() });
        let timer = 0;
        // What the extension reports and what the IDE's own commands did (fileSystemCommands.ts).
        store.add(
          services.extensionFeatures.fileSystems.onDidChangeFiles((changes) => {
            if (!changes.some((c) => uriScheme(c.path) === entry.scheme)) return;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => void tree.refresh(), 100);
          }),
        );
        store.add({ dispose: () => window.clearTimeout(timer) });
        return { focus: () => tree.focus(), dispose: () => store.dispose() };
      },
    });
  }

  dispose(): void {
    for (const s of this.systems.values()) s.off.dispose();
    this.systems.clear();
  }
}

/** A row's menu in a file system section: new file / folder in a folder, rename, delete. */
function rowMenu(item: { id: string; collapsible?: boolean }): {
  inline: { title: string; icon?: string; command: { id: string; input?: unknown } }[];
  groups: { title: string; icon?: string; command: { id: string; input?: unknown } }[][];
} {
  const folder = item.collapsible === true;
  return {
    inline: [],
    groups: [
      ...(folder
        ? [
            [
              {
                title: "New file…",
                command: { id: "extensions.fsNewFile", input: { folder: item.id } },
              },
              {
                title: "New folder…",
                command: { id: "extensions.fsNewFolder", input: { folder: item.id } },
              },
            ],
          ]
        : []),
      [
        { title: "Rename…", command: { id: "extensions.fsRename", input: { path: item.id } } },
        { title: "Delete", command: { id: "extensions.fsDelete", input: { path: item.id } } },
      ],
    ],
  };
}
