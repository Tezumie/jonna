// The project's workspace folders in the explorer (D189): when the IDE's own and a lower
// one (.vscode, the legacy folder name) both exist, the lower one is marked where the higher one overrides it
// (the same file, or a setting set differently), and "Merge into <the IDE's folder>…" combines them.
import { Emitter } from "../../core/events/index";
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, joinPath, pathKey, relativePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { parseJsonc } from "../../core/settings/jsonc";
import { isLanguageOverrideKey } from "../../core/settings/languageOverrides";
import { translateVscodeSettings } from "../../core/settings/vscode";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import {
  ensureWorkspaceFolder,
  presentWorkspaceFolders,
  resolveWorkspaceFolder,
  resolveWorkspaceFolderOf,
  workspaceFolderCandidates,
  workspaceFolderName,
} from "../../workbench/workspaceFolder";
import {
  mergeLinesText,
  mergeNamedListText,
  mergeSettingsText,
} from "../../workbench/workspaceMerge";

/** The explorer saw folders change on disk (a .vscode made in a terminal, say). */
export const treeChanged = new Emitter<readonly string[]>();

/** Files walked per folder (a workspace folder is small; this keeps a huge one cheap). */
const MAX_FILES = 2000;

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const encode = (t: string) => new TextEncoder().encode(t);

/** Relative paths ("/"-separated) of the files under `dir`. */
async function walk(dir: string): Promise<{ files: string[]; truncated: boolean }> {
  const out: string[] = [];
  const queue: [string, string][] = [[dir, ""]];
  while (queue.length && out.length < MAX_FILES) {
    const [abs, rel] = queue.shift() as [string, string];
    const entries = await fsIpc.listDir(abs).catch(() => []);
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.kind === "dir") queue.push([e.path, r]);
      else out.push(r);
    }
  }
  return { files: out.slice(0, MAX_FILES), truncated: queue.length > 0 || out.length > MAX_FILES };
}

const exists = (path: string) =>
  fsIpc.stat(path).then(
    () => true,
    () => false,
  );

/** A lower folder's overridden files (relative), and conflicting settings. */
interface Overrides {
  files: string[];
  settings: string[];
}

export function registerWorkspaceFolders(sub: DisposableStore, services: WorkbenchServices): void {
  const { workspace, dispatcher, decorations, settings, events } = services;
  /** pathKey of a lower folder → what the higher ones override in it. */
  let overrides = new Map<string, Overrides>();
  let generation = 0;

  const compute = async (): Promise<void> => {
    const token = ++generation;
    const next = new Map<string, Overrides>();
    // Every folder of the workspace has its own .vscode and IDE folder (D251).
    const roots = workspace.folderPaths();
    let appeared = false;
    for (const [n, root] of roots.entries()) {
      const before = presentWorkspaceFolders(root).join("|");
      if (n === 0) await resolveWorkspaceFolder(root);
      else await resolveWorkspaceFolderOf(root);
      const present = presentWorkspaceFolders(root);
      if (present.join("|") !== before) appeared = true;
      // The settings conflicts are the first folder's alias layer (a single folder's); a
      // multi-root workspace's folders each have their own layer, marked by their files.
      const conflicts = n === 0 && !workspace.isMultiRoot() ? settings.aliasConflicts() : new Map();
      const seen = new Set<string>();
      for (const [i, folder] of present.entries()) {
        const { files } = await walk(joinPath(root, folder));
        if (i > 0) {
          const over = files.filter((f) => seen.has(f.toLowerCase()) && f !== "settings.json");
          const keys: string[] = conflicts.get(folder) ?? [];
          if (keys.length) over.push("settings.json");
          if (over.length || keys.length)
            next.set(pathKey(joinPath(root, folder)), { files: over, settings: keys });
        }
        for (const f of files) seen.add(f.toLowerCase());
      }
    }
    // A folder appeared or went: its settings are read (or dropped) and watched.
    if (appeared && token === generation) void settings.load();
    if (token !== generation) return;
    overrides = next;
    decorations.changed();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void compute(), 300);
  };
  sub.add({ dispose: () => clearTimeout(timer) });

  const inFolders = (path: string): boolean => {
    const root = workspace.folderOf(path)?.path;
    if (!root) return false;
    const top = relativePath(root, path).split("/")[0] ?? "";
    return workspaceFolderCandidates().includes(top) || pathKey(path) === pathKey(root);
  };
  sub.add(workspace.onDidOpen(() => schedule()));
  sub.add(workspace.onDidChangeFolders(() => schedule()));
  for (const name of [
    "files.didCreate",
    "files.didDelete",
    "files.didSave",
    "files.didChange",
  ] as const)
    sub.add(events.on(name, (e) => inFolders(e.path) && schedule()));
  sub.add(
    events.on("files.didRename", (e) => (inFolders(e.from) || inFolders(e.to)) && schedule()),
  );
  sub.add(settings.model.onDidChange(() => schedule()));
  sub.add(
    treeChanged.event((dirs) => {
      if (dirs.some((d) => inFolders(d))) schedule();
    }),
  );
  schedule();

  sub.add(
    decorations.register({
      decorate(path, kind) {
        if (!workspace.root.peek() || !overrides.size) return undefined;
        const own = workspaceFolderName();
        if (kind === "dir") {
          const o = overrides.get(pathKey(path));
          if (!o) return undefined;
          const what = [
            ...o.files.filter((f) => f !== "settings.json"),
            ...(o.settings.length
              ? [
                  `settings.json (${o.settings.length} setting${o.settings.length === 1 ? "" : "s"})`,
                ]
              : []),
          ];
          return {
            badge: "!",
            color: "--status-warning-fg",
            tooltip: `${own} overrides ${what.length} item${what.length === 1 ? "" : "s"} here: ${what.slice(0, 6).join(", ")}${what.length > 6 ? "…" : ""}. Right-click → Merge into ${own}.`,
          };
        }
        for (const [folder, o] of overrides) {
          const rel = relativePath(folder, path);
          if (rel === path || !o.files.includes(rel)) continue;
          return {
            faded: true,
            tooltip:
              rel === "settings.json"
                ? `${own}/settings.json sets ${o.settings.join(", ")} differently and wins`
                : `Overridden by ${own}/${rel}`,
          };
        }
        return undefined;
      },
    }),
  );

  /**
   * Copies or merges every file of `from` into the IDE's own folder. What can't be combined
   * (both have the file, differently) is reported, and then the lower folder isn't trashed.
   */
  const merge = async (root: string, folder: string) => {
    const from = joinPath(root, folder);
    const to = await ensureWorkspaceFolder(root);
    const report = {
      copied: [] as string[],
      merged: [] as string[],
      /** Both folders have it, differently: the IDE's folder's kept, the lower one's not merged. */
      kept: [] as string[],
      /** Settings the lower folder has that the IDE doesn't know (not copied). */
      skipped: [] as string[],
      truncated: false,
    };
    const walked = await walk(from);
    report.truncated = walked.truncated;
    for (const rel of walked.files) {
      const parts = rel.split("/");
      const src = parts.reduce(joinPath, from);
      // VS Code keeps snippet files directly in .vscode; the IDE's are in <folder>/snippets.
      const target =
        folder === ".vscode" && /^[^/]+\.code-snippets$/.test(rel) ? `snippets/${rel}` : rel;
      const dst = target.split("/").reduce(joinPath, to);
      const bytes = await fsIpc.read(src);
      const lower = decode(bytes);
      let values: Record<string, unknown> | null = null;
      if (rel === "settings.json") {
        const parsed = parseJsonc(lower);
        const raw =
          parsed.ok &&
          parsed.value &&
          typeof parsed.value === "object" &&
          !Array.isArray(parsed.value)
            ? (parsed.value as Record<string, unknown>)
            : {};
        // VS Code's keys are translated; the legacy folder's are the IDE's own already.
        const t =
          folder === ".vscode"
            ? translateVscodeSettings(raw, (k) => !!settings.registry.get(k))
            : {
                values: Object.fromEntries(
                  Object.entries(raw).filter(
                    ([k]) => !!settings.registry.get(k) || isLanguageOverrideKey(k),
                  ),
                ),
                skipped: Object.keys(raw).filter(
                  (k) => !settings.registry.get(k) && !isLanguageOverrideKey(k),
                ),
              };
        values = t.values;
        report.skipped.push(...t.skipped);
      }
      if (!(await exists(dst))) {
        const text = values ? (mergeSettingsText("", values)?.text ?? null) : null;
        await fsIpc.write(dst, text !== null ? encode(text) : bytes, "user");
        events.emit("files.didCreate", { path: dst, kind: "file" });
        report.copied.push(rel);
        continue;
      }
      const own = decode(await fsIpc.read(dst));
      if (own === lower) continue;
      let text: string | null = null;
      let combined = false;
      if (values) {
        // Null: the IDE's own settings.json has a syntax error, so it's kept as it is.
        const r = mergeSettingsText(own, values);
        combined = r !== null;
        if (r?.added.length) text = r.text;
      } else if (rel === "tasks.json" || rel === "launch.json") {
        const lists: [string, string][] =
          rel === "tasks.json"
            ? [
                ["tasks", "label"],
                ["inputs", "id"],
              ]
            : [
                ["configurations", "name"],
                ["compounds", "name"],
              ];
        let next = own;
        let ok = true;
        for (const [list, key] of lists) {
          const r = mergeNamedListText(next, lower, list, key);
          if (!r) ok = false;
          else next = r.text;
        }
        combined = ok;
        if (ok && next !== own) text = next;
      } else if (rel.startsWith("memory/") && rel.endsWith(".md")) {
        const r = mergeLinesText(own, lower);
        combined = true;
        if (r.added) text = r.text;
      }
      if (text !== null) {
        await fsIpc.write(dst, encode(text), "user");
        events.emit("files.didChange", { path: dst });
        report.merged.push(rel);
      } else if (!combined) report.kept.push(rel);
    }
    return report;
  };

  sub.add(
    dispatcher.register({
      id: "workspace.mergeFolder",
      title: "Merge workspace folder",
      category: "Workspace",
      description: `Merges another workspace folder (${workspaceFolderCandidates().slice(1).join(" or ")}) into the IDE's own (${workspaceFolderName()}): files only it has are copied, settings/tasks/launch configurations/memory notes only it has are added; the IDE's own always wins. With removeAfter, the merged folder then goes to the trash (restorable). Asks the user first unless confirm is false.`,
      input: s.object({
        folder: s
          .string()
          .describe(
            `The folder to merge: ${workspaceFolderCandidates().slice(1).join(", ")} (or its path)`,
          ),
        removeAfter: s.boolean().optional(),
        confirm: s.boolean().optional(),
        root: s
          .string()
          .describe("A multi-root workspace's folder (path or name) it's in; default: the first")
          .optional(),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      run: async ({ folder, removeAfter, confirm, root: inFolder }, ctx) => {
        // Which workspace folder (D251): given, else the one an absolute `folder` is in.
        const folders = workspace.folders.peek();
        const named = inFolder
          ? folders.find((f) => pathKey(f.path) === pathKey(inFolder) || f.name === inFolder)
          : workspace.folderOf(resolvePath(workspace.root.peek() ?? "", folder));
        if (inFolder && !named) throw new Error(`${inFolder} isn't a folder of this workspace.`);
        const root = named?.path ?? workspace.root.peek();
        if (!root) throw new Error("Open a folder first.");
        const name = basename(folder);
        if (name === workspaceFolderName() || !workspaceFolderCandidates().includes(name))
          throw new Error(
            `Only ${workspaceFolderCandidates()
              .filter((n) => n !== workspaceFolderName())
              .join(" or ")} can be merged into ${workspaceFolderName()}.`,
          );
        if (pathKey(dirname(resolvePath(root, folder))) !== pathKey(root))
          throw new Error(`${folder} isn't at the top of the open folder.`);
        if (!(await exists(joinPath(root, name)))) throw new Error(`There's no ${name} folder.`);
        let remove = removeAfter ?? name !== ".vscode";
        // Only you can skip the question (an agent or extension asking for no question is asked
        // anyway, D233).
        if ((confirm !== false || ctx.caller.kind !== "user") && ctx.caller.kind !== "test") {
          const ok = await showDialog({
            title: `Merge ${name} into ${workspaceFolderName()}?`,
            message: `Files only ${name} has are copied into ${workspaceFolderName()}. Settings, tasks, launch configurations and memory notes only it has are added. Where both have something, ${workspaceFolderName()}'s is kept.`,
            actions: [
              { label: "Cancel", value: false },
              { label: "Merge", value: true, variant: "primary" },
            ],
            cancelValue: false,
            checkbox: {
              label: `Then move ${name} to the trash`,
              detail:
                name === ".vscode"
                  ? "VS Code still reads .vscode: keep it if you also use VS Code."
                  : "Restorable from File → Restore deleted files.",
              checked: remove,
              onCheck: (v) => {
                remove = v;
              },
            },
          });
          if (!ok) return { merged: false };
        }
        const report = await merge(root, name);
        let trashed = false;
        // Anything not carried over keeps the folder: nothing is lost to the trash.
        const unsafe = report.truncated || report.kept.length > 0 || report.skipped.length > 0;
        if (remove && unsafe)
          services.notifications.show(
            "warning",
            `${name} was kept: ${[
              report.truncated ? "it has too many files to merge at once" : "",
              report.kept.length
                ? `${report.kept.length} file(s) differ from ${workspaceFolderName()}'s (${report.kept.slice(0, 3).join(", ")})`
                : "",
              report.skipped.length
                ? `settings the IDE doesn't know (${report.skipped.slice(0, 3).join(", ")})`
                : "",
            ]
              .filter(Boolean)
              .join("; ")}.`,
          );
        if (remove && !unsafe) {
          await fsIpc.trash(joinPath(root, name));
          events.emit("files.didDelete", { path: joinPath(root, name) });
          trashed = true;
        }
        if (pathKey(root) === pathKey(workspace.root.peek() ?? ""))
          await resolveWorkspaceFolder(root);
        else await resolveWorkspaceFolderOf(root);
        await settings.load();
        schedule();
        services.notifications.show(
          "info",
          `Merged ${name} into ${workspaceFolderName()}: ${report.copied.length} copied, ${report.merged.length} combined, ${report.kept.length} kept as ${workspaceFolderName()} had them.${trashed ? ` ${name} is in the trash.` : ""}`,
        );
        return {
          merged: true,
          copied: report.copied,
          combined: report.merged,
          kept: report.kept,
          skipped: report.skipped,
          truncated: report.truncated,
          trashed,
        };
      },
    }),
  );
}

const resolvePath = (root: string, p: string) =>
  /^([a-zA-Z]:[\\/]|[\\/])/.test(p) ? p : joinPath(root, p);
