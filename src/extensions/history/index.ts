// History (DESIGN "history"): two layers, like VS Code.
//  - Workspace undo/redo (services.history, core/history): file operations from the explorer,
//    replace all, accepted agent edits. Ctrl/Cmd+Z in the explorer; Edit → Undo when no editor
//    has focus. Text edits keep using each editor's own undo stack (which survives closing and
//    reopening the file, editor/service.ts).
//  - Local history (Rust `history`): a snapshot whenever the app writes a workspace file, and of
//    what was there before. "Open timeline" lists a file's versions; picking one opens a diff
//    (version ↔ file) with "Restore this version".
// `ide://history` shows both for agents; a history viewer can build on the same commands.
import type { BuiltinExtension } from "../../core/extensions/index";
import { ChangedSinceError } from "../../core/history/index";
import { type HistoryEntry, historyIpc } from "../../core/ipc/fs";
import { basename } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { confirmAction, showDialog } from "../../ui/Dialog";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import manifest from "./extension.json";
import { ago, sourceLabel } from "./labels";
import { registerTimeline } from "./timeline";

export const historyExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, history, workspace, dock, context, quickInput, notifications, state } =
      services;
    const register: typeof dispatcher.register = (c) =>
      sub.add(dispatcher.register({ category: "Edit", ...c }));
    const resolve = (path: string) => workspace.resolve(path);
    registerTimeline(sub, services);
    const activePath = (): string | undefined => {
      const tab = dock.activeTab();
      const p = tab ? stateField(tab.viewState, "path") : undefined;
      return typeof p === "string" && !p.startsWith("virtual:") ? p : undefined;
    };
    // A different folder is a different history.
    sub.add(workspace.onDidOpen(() => history.clear()));
    sub.add(workspace.onDidClose(() => history.clear()));

    /**
     * One workspace undo / redo. For the user, a step that deletes files asks first
     * (explorer.confirmUndo: "default" asks for those, "verbose" for every step, "light" never),
     * and a step that can't run — its files changed — says why and offers to skip it, so the
     * ones before it can still be undone (D141).
     */
    const step = async (how: "undo" | "redo", user = false, skipChanged = false) => {
      const next = history.peek(how);
      if (!next) return { done: null };
      if (user) {
        const mode =
          services.settings.peek<string | undefined>("explorer.confirmUndo") ?? "default";
        const question =
          mode === "light"
            ? undefined
            : (next.confirm ??
              (mode === "verbose"
                ? `${how === "undo" ? "Undo" : "Redo"} "${next.label}"?`
                : undefined));
        if (
          question &&
          !(await confirmAction(
            question,
            next.confirm
              ? `They go to the app's trash; ${how === "undo" ? "Redo" : "Undo"} brings them back.`
              : "",
            how === "undo" ? "Undo" : "Redo",
            !!next.confirm,
          ))
        )
          return { done: null, cancelled: true };
      }
      try {
        const label = await (how === "undo" ? history.undo(next.id) : history.redo(next.id));
        return { done: label };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Asked to leave changed files alone (an agent): step the others, say which were left.
        if (err instanceof ChangedSinceError && skipChanged && err.changed.length < err.total) {
          const label = await (how === "undo"
            ? history.undo(next.id, { skipChanged: true })
            : history.redo(next.id, { skipChanged: true }));
          return { done: label, skipped: err.changed };
        }
        // Some files changed since (nothing was touched): VS Code would refuse; here the user
        // may step the others and leave those as they are (D143).
        if (err instanceof ChangedSinceError && user && err.changed.length < err.total) {
          const others = err.total - err.changed.length;
          const verb = how === "undo" ? "Undo" : "Redo";
          const answer = await showDialog<"others" | "cancel">({
            title: `${err.changed.slice(0, 3).join(", ")}${err.changed.length > 3 ? ` and ${err.changed.length - 3} more` : ""} changed since "${next.label}"`,
            message: `${verb} it in the other ${others} file${others === 1 ? "" : "s"}? The changed file${err.changed.length === 1 ? " keeps its" : "s keep their"} current content and ${err.changed.length === 1 ? "is" : "are"} left out of this step from now on.`,
            actions: [
              { label: "Cancel", value: "cancel" },
              {
                label: `${verb} in ${others} file${others === 1 ? "" : "s"}`,
                value: "others",
                variant: "primary",
              },
            ],
            cancelValue: "cancel",
            defaultValue: "others",
          });
          if (answer !== "others") return { done: null, cancelled: true };
          try {
            const label = await (how === "undo"
              ? history.undo(next.id, { skipChanged: true })
              : history.redo(next.id, { skipChanged: true }));
            return { done: label, skipped: err.changed };
          } catch (again) {
            const m = again instanceof Error ? again.message : String(again);
            notifications.show("warning", `Couldn't ${how} "${next.label}": ${m}`);
            return { done: null, error: m };
          }
        }
        notifications.show("warning", `Couldn't ${how} "${next.label}": ${message}`, {
          actions: [
            {
              label: `Skip it`,
              run: () => {
                if (history.peek(how)?.id !== next.id) return;
                history.discard(how);
                if (next.kind === "file" && /^Delete /.test(next.label))
                  notifications.show(
                    "info",
                    `"${next.label}" is skipped. The deleted items stay in the app's trash for 30 days: File → Restore deleted files…`,
                  );
              },
            },
          ],
        });
        return { done: null, error: message };
      }
    };
    register({
      id: "workspace.undo",
      title: "Undo file operation",
      description:
        "Undoes the latest workspace operation: a create, rename, move, copy or delete in the explorer, a replace all, or accepted agent edits. Refuses to overwrite files changed since.",
      input: s.object({
        skipChanged: s
          .boolean()
          .describe("Leave files changed since alone and undo the others (multi-file steps)")
          .optional(),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      agent: "discoverable",
      run: ({ skipChanged }, ctx) => step("undo", ctx.caller.kind === "user", skipChanged),
    });
    register({
      id: "workspace.redo",
      title: "Redo file operation",
      description: "Redoes the latest undone workspace operation.",
      input: s.object({
        skipChanged: s
          .boolean()
          .describe("Leave files changed since alone and redo the others (multi-file steps)")
          .optional(),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      agent: "discoverable",
      run: ({ skipChanged }, ctx) => step("redo", ctx.caller.kind === "user", skipChanged),
    });
    // Edit → Undo / Redo: the editor's text undo when an editor is the focused tab, else the
    // workspace's (VS Code's explorer undo).
    for (const how of ["undo", "redo"] as const)
      register({
        id: `edit.${how}`,
        title: how === "undo" ? "Undo" : "Redo",
        description: `${how === "undo" ? "Undo" : "Redo"}: the active text editor's, else the workspace's (file operations).`,
        input: s.empty(),
        effects: ["write"],
        agent: "hidden",
        palette: false,
        run: async (_input, ctx) => {
          // A notebook in command mode: its cell operations (VS Code's undo there; Jupyter
          // Keymap's Z).
          if (
            context.get("notebookCellListFocused") &&
            !context.get("notebookCellEditorFocused") &&
            dispatcher.has(`notebook.${how}`)
          )
            return dispatcher.execute(`notebook.${how}`, {});
          if (context.get("editorFocus") && dispatcher.has("editor.runAction"))
            return dispatcher.execute("editor.runAction", { action: how });
          return step(how, ctx.caller.kind === "user");
        },
      });

    const list = async (path: string): Promise<HistoryEntry[]> => historyIpc.list(path);
    register({
      id: "history.list",
      title: "List local history",
      category: "File",
      description:
        "A file's local history: versions the app saved or wrote (save, agent, replace all, restore…) and what was there before, newest first. Use history.restore to go back to one.",
      input: s.object({
        path: s.string().describe("File, absolute or workspace-relative").optional(),
      }),
      effects: ["read"],
      when: "workspaceOpen",
      agent: "discoverable",
      run: async ({ path }) => {
        const target = path ? resolve(path) : activePath();
        if (!target) throw new Error("No file.");
        const entries = await list(target);
        return {
          path: workspace.relative(target),
          versions: entries.map((e) => ({
            id: e.id,
            when: new Date(e.timestamp).toISOString(),
            source: e.source,
            size: e.size,
          })),
        };
      },
    });
    register({
      id: "history.show",
      title: "Open timeline",
      category: "File",
      description:
        "Lists a file's local history (default: the active file); picking a version opens it beside the current file as a diff, with Restore.",
      input: s.object({ path: s.string().optional() }),
      effects: ["read"],
      when: "workspaceOpen",
      agent: "hidden",
      run: async ({ path }, ctx) => {
        const target = path ? resolve(path) : activePath();
        if (!target) throw new Error("Open a file to see its timeline.");
        const entries = await list(target);
        if (!entries.length) {
          notifications.show(
            "info",
            `${basename(target)} has no local history yet (it's recorded when the app writes the file).`,
          );
          return { picked: null };
        }
        const now = Date.now();
        const picked = await quickInput.pick(
          entries.map((e) => ({
            id: e.id,
            label: sourceLabel(e.source),
            description: ago(e.timestamp, now),
            icon: "history" as const,
          })),
          { placeholder: `Timeline of ${basename(target)}: pick a version to compare` },
        );
        if (!picked) return { picked: null };
        await ctx.execute("editor.openDiff", {
          path: target,
          version: picked.id,
          versionLabel: `${picked.label}, ${picked.description}`,
        });
        return { picked: picked.id };
      },
    });
    register({
      id: "history.restore",
      title: "Restore version from local history",
      category: "File",
      description:
        "Writes a version from the file's local history (history.list) back to the file. The current content is kept in the history too, so this can be undone.",
      input: s.object({
        path: s.string().describe("File, absolute or workspace-relative"),
        id: s.string().describe("Version id from history.list"),
      }),
      effects: ["write"],
      when: "workspaceOpen",
      agent: "discoverable",
      run: async ({ path, id }) => {
        const target = resolve(path);
        const open = services.quickDiff.bufferText(target);
        // The version's bytes are read as UTF-8 here: a file open in another encoding (UTF-16, a
        // code page, D199) is restored byte for byte on disk instead, and its editor reloads.
        const enc = services.quickDiff.bufferEncoding(target);
        const utf8 = enc === null || enc === "utf8" || enc === "utf8bom";
        const text = new TextDecoder().decode(await historyIpc.read(target, id));
        // An open file is restored through its editor (one undoable edit, then saved).
        if (open !== null && utf8 && (await services.quickDiff.writeBuffer(target, text))) {
          await dispatcher.execute("editor.save", { path: target }).catch(() => {});
        } else {
          await historyIpc.restore(target, id);
          services.events.emit("files.didChange", { path: target });
        }
        return { restored: id };
      },
    });

    sub.add(
      state.register("ide://history", {
        description:
          "Workspace undo/redo stacks (file operations, replace all, accepted agent edits), newest first. A file's saved versions: history.list.",
        get: () => {
          const { done, undone } = history.entries();
          const view = (e: (typeof done)[number]) => ({
            label: e.label,
            kind: e.kind,
            when: new Date(e.timestamp).toISOString(),
            paths: e.paths.slice(0, 10).map((p) => workspace.relative(p)),
          });
          return { undo: done.slice(0, 30).map(view), redo: undone.slice(0, 30).map(view) };
        },
      }),
    );
  },
};
