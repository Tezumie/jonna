// Hot exit (D120, VS Code's `files.hotExit: onExit`): unsaved edits are kept with the folder's
// state (a backup per dirty file, refreshed a moment after typing stops, so a crash loses little
// too) and put back when the folder opens again — the file opens with the edits, unsaved. Closing
// the window then doesn't ask about unsaved files that have a backup; closing or switching the
// folder still asks about all of them.
// Limits: files over 2 MB and more than 10 MB in all aren't backed up (they ask on close).
// Backups not applied yet stay in the saved state until the restore finishes; one that can't be
// applied (the file is gone) opens as an untitled editor instead of being dropped (D203).
// An empty window (no folder) keeps its unsaved text in a backup of its own (the window
// registry's, `instancesIpc.emptyBackups*`): closing the last window keeps it and the next start
// reopens that window with it (VS Code restores empty windows with their untitled editors);
// closing an empty window while others run asks, as VS Code does.
import { instancesIpc } from "../../core/ipc/instances";
import { isTauri } from "../../core/ipc/invoke";
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { whenStartupRestored } from "../../workbench/restoreWindows";
import type { WorkbenchServices } from "../../workbench/services";
import type { EditorDocument, EditorService } from "./service";

const MAX_FILE_CHARS = 2 * 1024 * 1024;
const MAX_TOTAL_CHARS = 10 * 1024 * 1024;

export interface Backup {
  path: string;
  text: string;
}

interface BackupCandidate {
  path: string;
  dirty: boolean;
  /** Null when there's no text to back up (no model yet, or not a text editor). */
  text: string | null;
}

export function hotExitEnabled(services: WorkbenchServices): boolean {
  return services.settings.peek<string>("files.hotExit") !== "off";
}

/** Dirty text documents that fit the limits, largest last so the cap drops the biggest. */
export function backupsOf(docs: readonly BackupCandidate[]): Backup[] {
  const out: Backup[] = [];
  let total = 0;
  for (const d of [...docs].sort((a, b) => (a.text?.length ?? 0) - (b.text?.length ?? 0))) {
    if (!d.dirty || d.text === null || d.text.length > MAX_FILE_CHARS) continue;
    if (total + d.text.length > MAX_TOTAL_CHARS) break;
    total += d.text.length;
    out.push({ path: d.path, text: d.text });
  }
  return out;
}

/** The dirty documents a window close would lose: those `backupsOf` leaves out. */
export function withoutBackup<T extends BackupCandidate>(docs: readonly T[]): T[] {
  const covered = new Set(backupsOf(docs).map((b) => b.path));
  return docs.filter((d) => d.dirty && !covered.has(d.path));
}

/** What to save: the current backups, plus restored ones not applied yet (current wins). */
export function withPending(current: readonly Backup[], pending: readonly Backup[]): Backup[] {
  const have = new Set(current.map((b) => b.path));
  return [...current, ...pending.filter((b) => !have.has(b.path))];
}

/** Backups as an empty window keeps them (JSON), or null when there's nothing to keep. */
export function emptyWindowJson(backups: readonly Backup[]): string | null {
  return backups.length ? JSON.stringify({ version: 1, backups }) : null;
}

/** An empty window's kept backups (`emptyWindowJson`'s text); anything unreadable is skipped. */
export function emptyWindowBackups(text: string | null): Backup[] {
  if (!text) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const list = data && typeof data === "object" ? (data as { backups?: unknown }).backups : null;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (b): b is Backup =>
      !!b &&
      typeof b === "object" &&
      typeof (b as Backup).path === "string" &&
      typeof (b as Backup).text === "string",
  );
}

interface RestoreState {
  /** Restored backups not applied yet. */
  pending: Backup[];
  /** Bumped when the folder closes: an unfinished restore stops. */
  generation: number;
}

export function registerHotExit(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): void {
  const candidates = () =>
    editors.documents.peek().map((doc) => ({
      doc,
      path: doc.path.peek(),
      dirty: doc.dirty.peek(),
      text: doc.kind === "text" ? (doc.model.peek()?.getText() ?? null) : null,
    }));
  // A save while backups are still being applied (an edit's scheduled save, a folder switch)
  // must keep the ones not applied yet.
  const restore: RestoreState = { pending: [], generation: 0 };
  sub.add(
    services.workspace.onDidClose(() => {
      restore.pending = [];
      restore.generation++;
    }),
  );
  sub.add(
    services.persistence.register("editor.hotExit", {
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
        void restoreBackups(services, editors, restore);
      },
    }),
  );
  const empty = registerEmptyWindowBackups(sub, services, editors, candidates, restore);
  // Folder switch: ask about all unsaved work. Window close with hot exit: ask only about what
  // has no backup (too big, past the total cap, not a text editor); with no folder open, the
  // empty window's own backup keeps it when this is the last window, else ask about all of it.
  sub.add(
    services.workspace.onWillClose(async (reason) => {
      if (reason === "window" && empty && services.workspace.root.peek() === null) {
        if (await empty.keepOnClose()) {
          const lost = withoutBackup(candidates()).map((c) => c.doc);
          return lost.length ? editors.confirmCloseAll(lost) : true;
        }
        const ok = await editors.confirmCloseAll();
        if (ok) await empty.discard();
        return ok;
      }
      const keeps =
        reason === "window" && hotExitEnabled(services) && services.workspace.root.peek() !== null;
      if (!keeps) return editors.confirmCloseAll();
      const lost = withoutBackup(candidates()).map((c) => c.doc);
      return lost.length ? editors.confirmCloseAll(lost) : Promise.resolve(true);
    }),
  );
  // Keep the backups current: the folder's state is saved (debounced) after edits.
  sub.add(
    services.documents.onDidChange(() => {
      if (hotExitEnabled(services)) services.persistence.scheduleSave();
    }),
  );
  // Saving or reverting clears a backup: dirty state changes also schedule a save.
  sub.add(
    effect(() => {
      for (const d of editors.documents.value) d.dirty.value;
      services.persistence.scheduleSave();
      return undefined;
    }),
  );
}

interface EmptyWindowBackups {
  /** Window close with no folder: keeps the unsaved text when this is the last window. */
  keepOnClose(): Promise<boolean>;
  /** The window closes without keeping it (the user answered): the backup goes. */
  discard(): Promise<void>;
}

/**
 * An empty window's own backup of its unsaved text (untitled editors, files from outside a
 * folder): written a moment after edits while no folder is open, removed once one is (the
 * folder's state takes over) or nothing is unsaved. Put back after startup when this window is
 * the last session's empty window (main.ts: `instancesIpc.adoptEmpty`, or a window the restore
 * started with `--restore-empty`). Desktop only.
 */
function registerEmptyWindowBackups(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
  candidates: () => (BackupCandidate & { doc: EditorDocument })[],
  restore: RestoreState,
): EmptyWindowBackups | null {
  if (!isTauri()) return null;
  // Nothing is written before this window's kept text was read: an early empty save would
  // remove it.
  let ready = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The JSON last written (null: none kept), undefined before the first write. */
  let written: string | null | undefined;
  const current = (): string | null =>
    services.workspace.root.peek() !== null || !hotExitEnabled(services)
      ? null
      : emptyWindowJson(withPending(backupsOf(candidates()), restore.pending));
  const write = async () => {
    clearTimeout(timer);
    if (!ready || closed) return;
    const json = current();
    if (json === written) return;
    written = json;
    await instancesIpc.emptyBackupsSave(json).catch(() => {
      written = undefined;
    });
  };
  const schedule = () => {
    if (!ready || closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void write(), 400);
  };
  sub.add({ dispose: () => clearTimeout(timer) });
  sub.add(services.documents.onDidChange(schedule));
  sub.add(
    effect(() => {
      for (const d of editors.documents.value) d.dirty.value;
      services.workspace.root.value;
      schedule();
      return undefined;
    }),
  );
  void whenStartupRestored().then(async () => {
    if (services.workspace.root.peek() === null && hotExitEnabled(services)) {
      const kept = emptyWindowBackups(await instancesIpc.emptyBackupsLoad().catch(() => null));
      if (kept.length) {
        // Saves from here on include what isn't put back yet.
        restore.pending = [...kept];
        ready = true;
        await restoreBackups(services, editors, restore);
      }
    }
    ready = true;
    schedule();
  });
  return {
    async keepOnClose() {
      if (!ready || !hotExitEnabled(services)) return false;
      if (await instancesIpc.othersRunning().catch(() => true)) return false;
      await write();
      return true;
    },
    async discard() {
      closed = true;
      clearTimeout(timer);
      await instancesIpc.emptyBackupsSave(null).catch(() => {});
    },
  };
}

/** Applies each pending backup, removing it from `state.pending` once applied (or reopened). */
async function restoreBackups(
  services: WorkbenchServices,
  editors: EditorService,
  state: RestoreState,
): Promise<void> {
  const generation = state.generation;
  const stale = () => generation !== state.generation;
  let restored = 0;
  const reopened: string[] = [];
  for (const b of [...state.pending]) {
    let applied = false;
    try {
      // Opens it (or finds the tab restored with the layout) without taking focus.
      await services.dispatcher.execute("editor.openFile", { path: b.path, preserveFocus: true });
      if (stale()) return;
      const doc = editors.find(b.path);
      const model = doc?.kind === "text" ? (doc.model.peek() ?? (await modelOf(doc))) : null;
      if (stale()) return;
      if (model) {
        if (model.getText() !== b.text) {
          model.replaceText(b.text);
          restored++;
        }
        applied = true;
      }
    } catch {
      // A file that's gone or unreadable: its text opens as an untitled editor below.
    }
    if (stale()) return;
    if (!applied) {
      try {
        await services.dispatcher.execute("workspace.newUntitledFile", { text: b.text });
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
        ? "Restored unsaved changes in 1 file."
        : `Restored unsaved changes in ${restored} files.`,
    );
  if (reopened.length)
    services.notifications.show(
      "warning",
      `Couldn't reopen ${reopened.join(", ")}: the unsaved changes are in ${
        reopened.length === 1 ? "an untitled editor" : "untitled editors"
      } instead.`,
    );
}

/** The document's engine model once the editor engine has created it (or null after 15 s). */
function modelOf(doc: EditorDocument): Promise<ReturnType<EditorDocument["model"]["peek"]>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop.dispose();
      resolve(null);
    }, 15_000);
    const stop = effect(() => {
      const model = doc.model.value;
      if (model) {
        clearTimeout(timer);
        queueMicrotask(() => stop.dispose());
        resolve(model);
      }
      return undefined;
    });
  });
}
