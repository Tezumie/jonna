// File operations as commands: new file/folder, rename, delete. When a path or name is missing
// (palette, context menu), the explorer selection and an input prompt fill it in.
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, isWithin, samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { updateImportsAfterMove } from "./importUpdates";
import { createdOperation, deletedOperation, movedOperation, type UndoDeps } from "./undo";
import type { ExplorerView } from "./view";

const INVALID_NAME = /[\\/:*?"<>|\0]/;

export function validateName(value: string): string | undefined {
  const name = value.trim();
  if (!name) return "A file or folder name must be provided.";
  if (name === "." || name === "..") return "This name is not valid.";
  if (INVALID_NAME.test(name)) return "Names can't contain \\ / : * ? \" < > |";
  return undefined;
}

export function registerFileCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  getView: () => ExplorerView | undefined,
): void {
  const { dispatcher, workspace, quickInput, events } = services;

  const root = (): string => {
    const r = workspace.root.peek();
    if (!r) throw new Error("No folder is open.");
    return r;
  };
  const selectedPath = (): string | undefined => getView()?.tree?.selection?.path;
  /** Target path from input, else the explorer selection. */
  const targetPath = (path: string | undefined): string | undefined => {
    if (!path) return selectedPath();
    root();
    return workspace.resolve(path);
  };
  /** A workspace folder itself (any of a multi-root workspace's, D251). */
  const isWorkspaceFolder = (p: string) =>
    workspace.folders.peek().some((f) => samePath(f.path, p)) || samePath(p, root());
  /** Folder to create in: given folder, folder of a given file, selection, or the root. */
  const targetFolder = async (path: string | undefined): Promise<string> => {
    const candidate = targetPath(path) ?? root();
    const stat = await fsIpc.stat(candidate).catch(() => null);
    return stat?.kind === "dir" ? candidate : dirname(candidate);
  };
  /**
   * Given path, else every selected item (a folder's selected children go with it); a collapsed
   * nest parent of the explorer takes its nested files along (D203) for the selection, or for a
   * given path with `withNested`.
   */
  const deleteTargets = (path: string | undefined, withNested?: boolean): string[] => {
    const view = getView();
    if (path) {
      const one = [workspace.resolve(path)];
      return withNested && view ? view.withNestedFiles(one) : one;
    }
    const selected = view?.tree?.selectedItems().map((e) => e.path) ?? [];
    const all = withNested === false || !view ? selected : view.withNestedFiles(selected);
    return all.filter((p) => !all.some((q) => q !== p && isWithin(q, p)));
  };
  const refreshDir = async (dir: string) => {
    await getView()?.refresh([dir]);
  };
  const undoHint = () => {
    const key = services.keyboard.labelFor("workspace.undo");
    return key ? `You can undo this with ${key} in the explorer.` : "You can undo this.";
  };
  const undo: UndoDeps = {
    services,
    refresh: async (dirs) => {
      await getView()?.refresh([...new Set(dirs)]);
    },
    expanded: (paths) =>
      getView()
        ?.tree?.expandedIds()
        .filter((id) => paths.some((p) => samePath(p, id) || isWithin(p, id))) ?? [],
    expand: async (ids) => {
      const tree = getView()?.tree;
      for (const id of ids) await tree?.expand(id).catch(() => {});
    },
  };

  const createCommand = (kind: "file" | "dir") =>
    dispatcher.register({
      id: kind === "file" ? "explorer.newFile" : "explorer.newFolder",
      title: kind === "file" ? "New file…" : "New folder…",
      category: "File",
      description:
        kind === "file"
          ? "Creates an empty file named `name` in folder `parent` (default: the explorer selection or workspace root) and opens it."
          : "Creates a folder named `name` in folder `parent` (default: the explorer selection or workspace root).",
      input: s.object({
        parent: s
          .string()
          .describe("Folder, absolute or relative to the workspace root")
          .optional(),
        name: s.string().describe("New file or folder name (no path separators)").optional(),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      run: async ({ parent, name }, ctx) => {
        const folder = await targetFolder(parent);
        const view = getView();
        const chosen =
          name ??
          (view?.canEditInline()
            ? await view.inline.start({ kind, path: folder, initial: "", validate: validateName })
            : await quickInput.prompt({
                prompt:
                  kind === "file"
                    ? `New file in ${workspace.relative(folder) || basename(folder)}`
                    : "New folder name",
                placeholder: kind === "file" ? "File name" : "Folder name",
                validate: validateName,
              }));
        if (chosen === undefined) return { created: null };
        const error = validateName(chosen);
        if (error) throw new Error(error);
        const created =
          kind === "file"
            ? await fsIpc.createFile(folder, chosen.trim())
            : await fsIpc.createDir(folder, chosen.trim());
        events.emit("files.didCreate", { path: created, kind });
        services.history.push(
          createdOperation(
            undo,
            [created],
            `New ${kind === "file" ? "file" : "folder"} ${basename(created)}`,
          ),
        );
        await refreshDir(folder);
        await ctx.execute("explorer.reveal", { path: created });
        if (kind === "file") await ctx.execute("editor.openFile", { path: created });
        return { created };
      },
    });
  sub.add(createCommand("file"));
  sub.add(createCommand("dir"));

  sub.add(
    dispatcher.register({
      id: "explorer.rename",
      title: "Rename…",
      category: "File",
      description:
        "Renames a file or folder (in place; same parent folder). Open editors follow the rename.",
      input: s.object({
        path: s
          .string()
          .describe("File or folder to rename (default: explorer selection)")
          .optional(),
        newName: s.string().describe("New name (no path separators)").optional(),
        updateImports: s
          .boolean()
          .describe(
            "Update relative imports of a JS/TS file (true), or not (false); default: editor.updateImportsOnFileMove",
          )
          .optional(),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      run: async ({ path, newName, updateImports }, ctx) => {
        const target = targetPath(path);
        if (!target || isWorkspaceFolder(target))
          throw new Error("Select a file or folder to rename.");
        const current = basename(target);
        const dot = current.lastIndexOf(".");
        const selection: [number, number] = [0, dot > 0 ? dot : current.length];
        const view = getView();
        const chosen =
          newName ??
          (view?.canEditInline()
            ? await view.inline.start({
                kind: "rename",
                path: target,
                initial: current,
                selection,
                validate: validateName,
              })
            : await quickInput.prompt({
                prompt: `Rename ${current}`,
                value: current,
                selection,
                validate: validateName,
              }));
        if (chosen === undefined || chosen.trim() === current) return { renamed: null };
        const error = validateName(chosen);
        if (error) throw new Error(error);
        const renamed = await fsIpc.rename(target, chosen.trim());
        events.emit("files.didRename", { from: target, to: renamed });
        const moves = [{ from: target, to: renamed }];
        // On the undo stack at once (the import question can take a while); "Update imports
        // for 'x.ts'?" (D141) then joins the same entry, unless it was undone meanwhile.
        const op = movedOperation(undo, moves, `Rename ${current} to ${basename(renamed)}`);
        const entry = services.history.push(op);
        const imports = await updateImportsAfterMove(
          services,
          moves,
          ctx.caller.kind === "user",
          updateImports,
          () => services.history.peek("undo")?.id === entry,
        ).catch((err: unknown) => {
          services.notifications.show(
            "warning",
            `Imports weren't updated: ${err instanceof Error ? err.message : String(err)}`,
          );
          return undefined;
        });
        if (imports) op.attach(imports);
        await refreshDir(dirname(target));
        getView()?.tree?.reveal(renamed);
        return { renamed, importsUpdated: imports?.count ?? 0 };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "explorer.restoreDeleted",
      title: "Restore deleted files…",
      category: "File",
      description:
        'Lists what was deleted from this folder in the last 30 days (the app\'s trash) and restores the chosen item where it was — beside it, as "name (restored)", when something has that name now. Works after the undo step is gone (restart, skipped). With `id`, restores that item.',
      input: s.object({ id: s.string().describe("A trash id from the list").optional() }),
      effects: ["write"],
      when: "workspaceOpen",
      agent: "discoverable",
      run: async ({ id }, ctx) => {
        root();
        // From every folder of the workspace (D251).
        const items = (await fsIpc.trashList()).filter((t) => workspace.contains(t.path));
        const list = items.map((t) => ({
          id: t.id,
          path: workspace.relative(t.path),
          deleted: new Date(t.deleted).toISOString(),
          folder: t.isDir,
        }));
        let pick = id ? items.find((t) => t.id === id) : undefined;
        if (!id && ctx.caller.kind !== "user") return { deleted: list };
        if (!pick) {
          if (id) throw new Error(`Nothing with id ${id} is in the trash.`);
          if (!items.length) {
            services.notifications.show(
              "info",
              "Nothing deleted from this folder in the last 30 days.",
            );
            return { restored: null };
          }
          const chosen = await quickInput.pick(
            items.map((t) => ({
              id: t.id,
              label: workspace.relative(t.path),
              description: `${t.isDir ? "folder · " : ""}deleted ${new Date(t.deleted).toLocaleString()}`,
              icon: t.isDir ? ("folder" as const) : ("file" as const),
            })),
            { placeholder: "Restore a deleted file or folder", matchOn: (i) => i.label },
          );
          if (!chosen) return { restored: null };
          pick = items.find((t) => t.id === chosen.id);
        }
        if (!pick) return { restored: null };
        // Never over something: beside it under a free name instead.
        let dest = pick.path;
        const taken = (p: string) =>
          fsIpc.stat(p).then(
            () => true,
            () => false,
          );
        for (let n = 1; await taken(dest); n++) {
          const name = basename(pick.path);
          const dot = name.lastIndexOf(".");
          const stem = dot > 0 && !pick.isDir ? name.slice(0, dot) : name;
          const ext = dot > 0 && !pick.isDir ? name.slice(dot) : "";
          dest = `${dirname(pick.path)}${pick.path.includes("\\") ? "\\" : "/"}${stem} (restored${n > 1 ? ` ${n}` : ""})${ext}`;
        }
        await fsIpc.untrash(pick.id, dest);
        events.emit("files.didCreate", { path: dest, kind: pick.isDir ? "dir" : "file" });
        services.history.push(createdOperation(undo, [dest], `Restore ${basename(dest)}`));
        await getView()?.refresh([dirname(dest), dest]);
        getView()?.tree?.reveal(dest);
        return { restored: workspace.relative(dest) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "explorer.delete",
      title: "Delete",
      category: "File",
      description:
        "Deletes a file or folder (recursively), or every selected item in the explorer when `path` is omitted (a collapsed nest parent's nested files go with it, as in VS Code). Deleted items go to the app's trash, so workspace.undo restores them; the user is asked to confirm.",
      input: s.object({
        path: s
          .string()
          .describe("File or folder to delete (default: explorer selection)")
          .optional(),
        withNested: s
          .boolean()
          .describe(
            "Also delete the files nested under a collapsed nest parent in the explorer (explorer.fileNesting); default: true for the selection, false for `path`",
          )
          .optional(),
      }),
      effects: ["write", "destructive"],
      when: "workspaceOpen",
      confirm: ({ path, withNested }) => {
        const targets = deleteTargets(path, withNested);
        const first = targets[0];
        if (!first) return "Nothing is selected.";
        return targets.length === 1
          ? `Are you sure you want to delete '${basename(first)}'?\n\n${undoHint()}`
          : `Are you sure you want to delete these ${targets.length} items?\n\n${targets.map((t) => basename(t)).join("\n")}\n\n${undoHint()}`;
      },
      run: async ({ path, withNested }) => {
        const targets = deleteTargets(path, withNested);
        if (targets.length === 0 || targets.some(isWorkspaceFolder))
          throw new Error("Select a file or folder to delete.");
        // A folder and something inside it both selected: deleting the folder covers it.
        const outer = targets.filter(
          (t) => !targets.some((o) => o !== t && isWithin(o, t) && !samePath(o, t)),
        );
        const expandedBefore = undo.expanded?.(outer) ?? [];
        const trashed: { path: string; id: string }[] = [];
        let failure: unknown = null;
        for (const target of outer) {
          try {
            trashed.push({ path: target, id: await fsIpc.trash(target) });
            events.emit("files.didDelete", { path: target });
          } catch (err) {
            // Nothing of this item changed (D141); the ones already deleted stay undoable.
            failure = await withTerminalsInside(services, target, err);
            break;
          }
        }
        if (trashed.length)
          services.history.push(
            deletedOperation(
              undo,
              trashed,
              trashed.length === 1
                ? `Delete ${basename(trashed[0]?.path ?? "")}`
                : `Delete ${trashed.length} items`,
              expandedBefore,
            ),
          );
        if (failure) {
          await getView()?.refresh([...new Set(trashed.map((t) => dirname(t.path)))]);
          throw failure;
        }
        await getView()?.refresh([...new Set(targets.map(dirname))]);
        return { deleted: targets.length === 1 ? targets[0] : targets };
      },
    }),
  );
}

/**
 * A folder "in use" is usually a terminal (or a server the agent started) running inside it:
 * the message names them, so the user knows what to close.
 */
async function withTerminalsInside(
  services: WorkbenchServices,
  target: string,
  err: unknown,
): Promise<unknown> {
  const message = err instanceof Error ? err.message : String(err);
  if (!/in use/.test(message)) return err;
  const state = (await services.state.get("ide://terminals").catch(() => null))?.value as {
    terminals?: { title?: string; cwd?: string | null; exited?: boolean }[];
  } | null;
  const inside = (state?.terminals ?? []).filter(
    (t) => !t.exited && t.cwd && isWithin(target, t.cwd),
  );
  if (!inside.length) return err;
  const names = inside.map((t) => `"${t.title ?? "terminal"}"`).join(", ");
  return new Error(`${message}\n\nRunning inside it: ${names}.`);
}
