// Hot exit for notebooks: an unsaved notebook is kept with the folder's state, as text files are
// (editor/hotExit.ts, D120: the same setting, limits and pending bookkeeping), and put back,
// unsaved, when the folder opens again. A backup is the editor's own notebook model as JSON
// (model.ts `notebookBackupText`), so taking one needs no serializer. Closing the window then
// doesn't ask about notebooks that have a backup; closing or switching the folder still asks.
// One that can't be put back (the file is gone or can't be read) opens, written with its format,
// as an untitled editor instead of being dropped.
import type { DisposableStore } from "../../../core/lifecycle/index";
import { pathKey } from "../../../core/paths/index";
import type { WorkbenchServices } from "../../../workbench/services";
import { type Backup, backupsOf, hotExitEnabled, withoutBackup, withPending } from "../hotExit";
import { notebookBackupText, notebookFromBackup } from "./model";
import type { NotebookView } from "./view";

interface RestoreState {
  pending: Backup[];
  /** Bumped when the folder closes: an unfinished restore stops. */
  generation: number;
}

export function registerNotebookHotExit(
  sub: DisposableStore,
  services: WorkbenchServices,
  views: () => Iterable<NotebookView>,
): void {
  // The backup text per notebook and edit version: state saves come every second or so while
  // typing, and a big notebook (images in its outputs) is serialized once per change, not each time.
  const texts = new WeakMap<NotebookView, { version: number; text: string }>();
  const backupText = (view: NotebookView) => {
    const kept = texts.get(view);
    if (kept?.version === view.editVersion) return kept.text;
    const text = notebookBackupText(view.toNotebook());
    texts.set(view, { version: view.editVersion, text });
    return text;
  };
  const candidates = () =>
    [...views()].map((view) => {
      const dirty = view.isDirty();
      return {
        view,
        path: view.path,
        dirty,
        // A notebook that didn't load has nothing to keep (and isn't dirty).
        text: dirty && !view.error ? backupText(view) : null,
      };
    });
  const restore: RestoreState = { pending: [], generation: 0 };
  sub.add(
    services.workspace.onDidClose(() => {
      restore.pending = [];
      restore.generation++;
    }),
  );
  sub.add(
    services.persistence.register("notebook.hotExit", {
      save: () =>
        hotExitEnabled(services) ? withPending(backupsOf(candidates()), restore.pending) : [],
      restore: (data) => {
        if (!Array.isArray(data) || !hotExitEnabled(services)) return;
        const backups = data.filter(
          (b): b is Backup =>
            !!b &&
            typeof b === "object" &&
            typeof b.path === "string" &&
            typeof b.text === "string",
        );
        if (!backups.length) return;
        restore.pending = [...backups];
        void restoreBackups(services, restore, views);
      },
    }),
  );
  // Folder switch: ask about every unsaved notebook. Window close with hot exit (and a folder,
  // whose state keeps the backups): only about those without one (past the size limits).
  sub.add(
    services.workspace.onWillClose(async (reason) => {
      const keeps =
        reason === "window" && hotExitEnabled(services) && services.workspace.root.peek() !== null;
      const ask = keeps ? withoutBackup(candidates()).map((c) => c.view) : [...views()];
      for (const view of ask) if (!(await view.confirmClose())) return false;
      return true;
    }),
  );
}

/** Puts each pending backup back, removing it from `state.pending` once applied (or reopened). */
async function restoreBackups(
  services: WorkbenchServices,
  state: RestoreState,
  views: () => Iterable<NotebookView>,
): Promise<void> {
  const generation = state.generation;
  const stale = () => generation !== state.generation;
  const find = (path: string) => [...views()].find((v) => pathKey(v.path) === pathKey(path));
  let restored = 0;
  const reopened: string[] = [];
  for (const b of [...state.pending]) {
    const nb = notebookFromBackup(b.text);
    if (!nb) {
      state.pending = state.pending.filter((p) => p !== b);
      continue;
    }
    let applied = false;
    try {
      // Opens it (or finds the tab restored with the layout) without taking focus.
      await services.dispatcher.execute("editor.openFile", { path: b.path, preserveFocus: true });
      if (stale()) return;
      const view = find(b.path);
      if (view) {
        await view.whenLoaded();
        if (stale()) return;
        if (!view.error) {
          // The file saved elsewhere since with the same cells: nothing to put back.
          if (notebookBackupText(view.toNotebook()) !== b.text) {
            view.applyBackup(nb);
            restored++;
          }
          applied = true;
        }
      }
    } catch {
      // A file that's gone or unreadable: its notebook opens as an untitled editor below.
    }
    if (stale()) return;
    if (!applied) {
      try {
        const type = services.notebooks.typeFor(b.path);
        const text = type ? await type.serializer.serialize(nb) : b.text;
        await services.dispatcher.execute("workspace.newUntitledFile", { text });
        reopened.push(b.path);
      } catch {
        continue; // stays in the saved state for the next start
      }
      if (stale()) return;
    }
    state.pending = state.pending.filter((p) => p !== b);
  }
  if (restored)
    services.notifications.show(
      "info",
      restored === 1
        ? "Restored unsaved changes in 1 notebook."
        : `Restored unsaved changes in ${restored} notebooks.`,
    );
  if (reopened.length)
    services.notifications.show(
      "warning",
      `Couldn't reopen ${reopened.join(", ")}: the unsaved notebook is in ${
        reopened.length === 1 ? "an untitled editor" : "untitled editors"
      } instead.`,
    );
}
