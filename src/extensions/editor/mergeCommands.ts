// The merge editor's dock view type, commands and state (D204; split from mergeView.ts in D248): open it
// on a conflicted file, accept a side per conflict or for all, move between conflicts, resize its
// panes, keep or delete a file one side deleted, toggle the base, reset, and Complete merge
// (save + git add). `ide://git/mergeEditors` lists the open ones.

import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { basename, pathKey, samePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { showDialog } from "../../ui/Dialog";
import { fileIcon } from "../../ui/Icon";
import type { DockViewDescriptor } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { MergeLayoutMemory } from "./mergeLayout";
import { type InputPane, type LayoutStore, MergeView, readPath, VIEW_TYPE } from "./mergeView";
import type { EditorService } from "./service";

export function registerMergeView(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): void {
  const { dock, dispatcher, workspace, state } = services;
  const live = new Map<string, MergeView>();
  // Each file's last merge layout, with the folder's state (D219).
  const layouts: LayoutStore = {
    memory: new MergeLayoutMemory(pathKey),
    changed: () => services.persistence.scheduleSave(),
  };
  sub.add(
    services.persistence.register("editor.mergeLayouts", {
      save: () => layouts.memory.toJSON(),
      restore: (data) => layouts.memory.restore(data),
    }),
  );
  const descriptor: DockViewDescriptor = {
    type: VIEW_TYPE,
    title: (st) => `${basename(readPath(st))} (merge)`,
    icon: (st) => fileIcon(basename(readPath(st))),
    resource: (st) => readPath(st) || undefined,
    tooltip: (st) => `${readPath(st)} · Merge editor`,
    defaultPlacement: "main",
    editorLike: true,
    create: (st, ctx) => new MergeView(st, ctx, services, editors, live, layouts),
  };
  sub.add(dock.views.register(descriptor));

  const resolve = (path: string | undefined): string | undefined => {
    if (path) return workspace.resolve(path);
    const tab =
      dock.activeTab() ??
      dock.recentTab((t) => t.viewType === VIEW_TYPE || t.viewType === "editor");
    const p = (tab?.viewState as { path?: unknown } | null)?.path;
    return typeof p === "string" ? p : undefined;
  };
  /** The open merge editor of `path` (default: the active one). */
  const viewFor = async (path: string | undefined): Promise<MergeView> => {
    const target = resolve(path);
    const view =
      (target && [...live.values()].find((v) => samePath(v.path, target))) ||
      (!path ? [...live.values()][0] : undefined);
    if (!view)
      throw new Error("No merge editor is open for that file: run Resolve in merge editor first.");
    await view.ready;
    return view;
  };
  const pathInput = s
    .string()
    .describe("The conflicted file (default: the active merge editor)")
    .optional();

  sub.add(
    dispatcher.register({
      id: "git.openMergeEditor",
      title: "Resolve in merge editor",
      category: "Git",
      description:
        "Opens the 3-way merge editor for a file with merge conflicts: Incoming (theirs), Current (ours) and the editable Result, per-conflict accept actions, and Complete merge. Default: the active editor's file.",
      input: s.object({ path: pathInput }),
      effects: [],
      when: "workspaceOpen",
      agent: "discoverable",
      run: async ({ path }) => {
        const target = resolve(path);
        if (!target) throw new Error("Open a file with merge conflicts first.");
        const existing = dock.tabs(VIEW_TYPE).find((t) => samePath(readPath(t.viewState), target));
        const tabId =
          existing?.id ??
          dock.openView(
            VIEW_TYPE,
            { path: target },
            (() => {
              const focused = dock.focusedGroup();
              const group = focused?.tabs.some(dock.isEditorLike) ? focused.id : undefined;
              return group ? { groupId: group } : "main";
            })(),
            true,
          );
        if (existing) dock.activateTab(existing.id, true);
        const view = live.get(target) ?? [...live.values()].find((v) => samePath(v.path, target));
        await view?.ready;
        return { tabId, ...(view?.summary() ?? {}) };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "git.mergeEditor.accept",
      title: "Accept in merge editor",
      category: "Git",
      description:
        "In an open merge editor: puts the incoming side, the current side, both (current first; bothIncomingFirst: incoming first) or the base text (`base`: Ignore) of a conflict into the result, or `reset` it to unhandled. `conflict` is 1-based (default: the one at the result's cursor).",
      input: s.object({
        path: pathInput,
        conflict: s.integer({ min: 1 }).describe("Which conflict (1-based)").optional(),
        choice: s.enum([
          "incoming",
          "current",
          "both",
          "bothIncomingFirst",
          "base",
          "reset",
        ] as const),
      }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ path, conflict, choice }) => {
        const view = await viewFor(path);
        const id = conflict !== undefined ? conflict - 1 : view.conflictAtCursor();
        if (id === null) throw new Error("There is no conflict left to accept.");
        view.accept(id, choice);
        return view.summary();
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "git.mergeEditor.acceptAll",
      title: "Accept all incoming or current in merge editor",
      category: "Git",
      description: "Takes one side for every conflict of the open merge editor.",
      input: s.object({ path: pathInput, choice: s.enum(["incoming", "current"] as const) }),
      effects: ["write"],
      run: async ({ path, choice }) => {
        const view = await viewFor(path);
        view.acceptAll(choice);
        return view.summary();
      },
    }),
  );
  for (const [id, title, direction] of [
    ["git.mergeEditor.nextConflict", "Go to next conflict", "next"],
    ["git.mergeEditor.previousConflict", "Go to previous conflict", "previous"],
  ] as const)
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "Git",
        description: `Moves the merge editor's panes to the ${direction} conflict (wrapping around).`,
        input: s.object({ path: pathInput }),
        effects: [],
        run: async ({ path }) => {
          const view = await viewFor(path);
          const at = view.go(direction);
          return { conflict: at === null ? null : at + 1 };
        },
      }),
    );
  sub.add(
    dispatcher.register({
      id: "git.mergeEditor.setLayout",
      title: "Resize merge editor panes",
      category: "Git",
      description:
        "Sizes the open merge editor's panes as its sashes do: `split` is the inputs' share of the height (0.1–0.9, the result has the rest), `weights` the input panes' shares of the width (incoming, base, current; 1 each by default). Kept with the tab.",
      input: s.object({
        path: pathInput,
        split: s.number({ min: 0.1, max: 0.9 }).optional(),
        weights: s
          .object({
            incoming: s.number({ min: 0.05, max: 20 }).optional(),
            base: s.number({ min: 0.05, max: 20 }).optional(),
            current: s.number({ min: 0.05, max: 20 }).optional(),
          })
          .optional(),
      }),
      effects: [],
      palette: false,
      run: async ({ path, split, weights }) => {
        const view = await viewFor(path);
        view.setLayout({
          ...(split !== undefined && { split }),
          ...(weights && {
            weights: Object.fromEntries(
              Object.entries(weights).filter(([, v]) => v !== undefined),
            ) as Partial<Record<InputPane, number>>,
          }),
        });
        return view.summary();
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "git.mergeEditor.resolveDeleted",
      title: "Keep or delete the file in merge editor",
      category: "Git",
      description:
        "For a file one side deleted and the other changed (a delete / modify conflict), open in the merge editor: `keep` keeps the changed version, `delete` deletes the file; either way it's staged (git add) and the merge editor closes.",
      input: s.object({ path: pathInput, choice: s.enum(["keep", "delete"] as const) }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ path, choice }, ctx) => {
        const view = await viewFor(path);
        const deleted = view.deleted;
        if (!deleted)
          throw new Error(
            "That file is in conflict as two edited versions: accept its conflicts instead.",
          );
        // Into the app trash (restorable), as other deletes the IDE makes for you (D233).
        if (choice === "delete") await fsIpc.trash(view.path).catch(() => {});
        else {
          // Git leaves the changed version in place; written back when it's gone.
          const there = await fsIpc.stat(view.path).then(
            () => true,
            () => false,
          );
          if (!there) await fsIpc.write(view.path, new TextEncoder().encode(deleted.kept));
        }
        await ctx.execute("git.stage", { paths: [view.path], deletion: choice });
        services.events.emit(choice === "delete" ? "files.didDelete" : "files.didChange", {
          path: view.path,
        });
        view.close();
        return { path: view.path, kept: choice === "keep", staged: true };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "git.mergeEditor.toggleBase",
      title: "Toggle base in merge editor",
      category: "Git",
      description: "Shows or hides the common ancestor (base) pane of the open merge editor.",
      input: s.object({ path: pathInput, value: s.boolean().optional() }),
      effects: [],
      run: async ({ path, value }) => ({ showBase: (await viewFor(path)).toggleBase(value) }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "git.mergeEditor.reset",
      title: "Reset merge result",
      category: "Git",
      description:
        "Starts the merge editor's result over: every one-sided change taken, every conflict unhandled.",
      input: s.object({ path: pathInput }),
      effects: ["write"],
      run: async ({ path }) => {
        const view = await viewFor(path);
        view.reset();
        return view.summary();
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "git.completeMerge",
      title: "Complete merge",
      category: "Git",
      description:
        "Saves the merge editor's result to the file, stages it (git add) and closes the merge editor. With conflicts still unhandled the user is asked; an agent must pass `force`.",
      input: s.object({
        path: pathInput,
        force: s.boolean().describe("Complete even with unhandled conflicts").optional(),
      }),
      effects: ["write"],
      agent: "discoverable",
      run: async ({ path, force }, ctx) => {
        const view = await viewFor(path);
        const { unhandled } = view.summary();
        if (unhandled > 0 && !force) {
          if (ctx.caller.kind !== "user")
            throw new Error(`${unhandled} conflict(s) are unhandled: accept them, or pass force.`);
          const ok = await showDialog<boolean>({
            title: "Complete merge?",
            message: `${unhandled} conflict${unhandled === 1 ? " is" : "s are"} still unhandled: the result keeps the base text there.`,
            actions: [
              { label: "Cancel", value: false },
              { label: "Complete merge", value: true, variant: "primary" },
            ],
            cancelValue: false,
          });
          if (!ok) return { completed: false };
        }
        await view.saveResult();
        await ctx.execute("git.stage", { paths: [view.path] });
        view.close();
        return { completed: true, path: view.path, staged: true };
      },
    }),
  );
  sub.add(
    state.register("ide://git/mergeEditors", {
      description:
        "Open merge editors: each conflicted file's conflicts, how many are unhandled, and each conflict's choice and lines in the result.",
      get: () => [...live.values()].map((v) => v.summary()),
    }),
  );
}
