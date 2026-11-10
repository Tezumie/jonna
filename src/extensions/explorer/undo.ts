// Explorer operations as workspace history entries (core/history): each knows how to undo and
// redo itself with the same file IPC, and tells editors and the tree what moved. Deletes go to
// the app trash, so undoing a delete (or a create) is a move back, never a copy.
//
// Safeguards (D141): every undo / redo first checks that it can run completely — the items to
// move are there, nothing sits where they go, trashed items still exist — and changes nothing
// otherwise. If a step still fails half way (a file locked meanwhile), the steps already done
// are reversed, so an operation is applied entirely or not at all. The tree reloads the
// restored folders themselves (not only their parents), so a folder comes back with everything
// in it.
import type { Operation } from "../../core/history/index";
import { fsIpc } from "../../core/ipc/fs";
import { basename, dirname } from "../../core/paths/index";
import type { WorkbenchServices } from "../../workbench/services";

export interface UndoDeps {
  services: WorkbenchServices;
  refresh(dirs: string[]): Promise<void>;
  /** The tree's expanded folders inside `paths` (to open them again when they come back). */
  expanded?(paths: readonly string[]): string[];
  /** Expands these folders (parents first). */
  expand?(ids: readonly string[]): Promise<void>;
}

const name = (p: string) => basename(p);

const exists = (path: string): Promise<boolean> =>
  fsIpc.stat(path).then(
    () => true,
    () => false,
  );

/** Throws (before anything changes) unless every path is there / every path is free. */
async function requireExisting(paths: readonly string[], what: string): Promise<void> {
  for (const p of paths)
    if (!(await exists(p)))
      throw new Error(`${name(p)} isn't there any more, so ${what} can't run.`);
}

async function requireFree(paths: readonly string[], what: string): Promise<void> {
  for (const p of paths)
    if (await exists(p))
      throw new Error(`Something named ${name(p)} is there now; ${what} won't overwrite it.`);
}

async function requireTrashed(ids: readonly string[], what: string): Promise<void> {
  for (const id of ids)
    if (!(await fsIpc.trashExists(id)))
      throw new Error(`The deleted items are no longer in the app's trash, so ${what} can't run.`);
}

/** Trashes `paths` (all or none): returns the trash ids, in the same order. */
async function trashAll(d: UndoDeps, paths: readonly string[]): Promise<string[]> {
  const done: { id: string; path: string }[] = [];
  try {
    for (const path of paths) {
      done.push({ id: await fsIpc.trash(path), path });
      d.services.events.emit("files.didDelete", { path });
    }
  } catch (err) {
    for (const { id, path } of done.reverse()) {
      await fsIpc.untrash(id, path).catch(() => {});
      d.services.events.emit("files.didCreate", { path, kind: "file" });
    }
    throw err;
  }
  return done.map((x) => x.id);
}

/** Puts trashed items back (all or none). */
async function untrashAll(d: UndoDeps, items: { id: string; path: string }[]): Promise<void> {
  const done: string[] = [];
  try {
    for (const { id, path } of items) {
      await fsIpc.untrash(id, path);
      done.push(path);
      d.services.events.emit("files.didCreate", { path, kind: "file" });
    }
  } catch (err) {
    // Back into the trash with what was restored, so the entry can be tried again as a whole.
    for (const path of done.reverse()) {
      const item = items.find((i) => i.path === path);
      const id = await fsIpc.trash(path).catch(() => null);
      if (item && id) item.id = id;
      d.services.events.emit("files.didDelete", { path });
    }
    throw err;
  }
}

/** The folders to reload after items appeared or disappeared: their parents and themselves. */
const affected = (paths: readonly string[]) => [...paths.map(dirname), ...paths];

/** Created files or folders: undo trashes them, redo puts them back. */
const listNames = (paths: readonly string[]) =>
  paths.length === 1 ? `'${name(paths[0] ?? "")}'` : `these ${paths.length} items`;

export function createdOperation(d: UndoDeps, paths: string[], label: string): Operation {
  let trashed: { id: string; path: string }[] = [];
  return {
    label,
    kind: "file",
    paths,
    // Undoing a create deletes (to the app trash; redo brings it back): VS Code asks first.
    confirm: { undo: `Undo "${label}"? This deletes ${listNames(paths)}.` },
    undo: async () => {
      await requireExisting(paths, "undo");
      const order = [...paths].reverse();
      const ids = await trashAll(d, order);
      trashed = order.map((path, i) => ({ path, id: ids[i] ?? "" }));
      await d.refresh(affected(paths));
    },
    redo: async () => {
      if (trashed.length < paths.length) throw new Error("It can't be restored.");
      await requireTrashed(
        trashed.map((t) => t.id),
        "redo",
      );
      await requireFree(paths, "redo");
      await untrashAll(d, [...trashed].reverse());
      await d.refresh(affected(paths));
    },
  };
}

/** Trashed items: undo restores them where they were. */
export function deletedOperation(
  d: UndoDeps,
  items: { path: string; id: string }[],
  label: string,
  /** Folders that were expanded in the tree before the delete. */
  expandedBefore: string[] = [],
): Operation {
  let expanded = expandedBefore;
  let current = items.map((i) => ({ ...i }));
  const paths = items.map((i) => i.path);
  return {
    label,
    kind: "file",
    paths,
    confirm: { redo: `Redo "${label}"? This deletes ${listNames(paths)} again.` },
    undo: async () => {
      await requireTrashed(
        current.map((i) => i.id),
        "undo",
      );
      await requireFree(paths, "undo");
      await untrashAll(d, current);
      await d.refresh(affected(paths));
      // The tree as it was: the folders that were open are open again, listing everything.
      await d.expand?.(expanded);
    },
    redo: async () => {
      await requireExisting(paths, "redo");
      expanded = d.expanded?.(paths) ?? [];
      const ids = await trashAll(d, paths);
      current = paths.map((path, i) => ({ path, id: ids[i] ?? "" }));
      await d.refresh(affected(paths));
    },
  };
}

/** Renames or moves (from → to): undo moves each back. */
export function movedOperation(
  d: UndoDeps,
  moves: { from: string; to: string }[],
  label: string,
): Operation & { attach(extra: MoveExtra): void } {
  /** Work done with the move (import updates, D141), attached once it's done. */
  let extra: MoveExtra | undefined;
  const moveOne = async ({ from, to }: { from: string; to: string }) => {
    const sameDir = dirname(from) === dirname(to);
    const done = sameDir
      ? await fsIpc.rename(from, name(to))
      : name(from) === name(to)
        ? await fsIpc.move(from, dirname(to))
        : await fsIpc.rename(await fsIpc.move(from, dirname(to)), name(to));
    d.services.events.emit("files.didRename", { from, to: done });
  };
  const apply = async (pairs: { from: string; to: string }[], what: string) => {
    await requireExisting(
      pairs.map((p) => p.from),
      what,
    );
    // A case-only rename (a.ts → A.ts) is the same file on Windows and macOS: not "in the way".
    await requireFree(
      pairs.filter((p) => p.from.toLowerCase() !== p.to.toLowerCase()).map((p) => p.to),
      what,
    );
    const done: { from: string; to: string }[] = [];
    try {
      for (const pair of pairs) {
        await moveOne(pair);
        done.push(pair);
      }
    } catch (err) {
      for (const { from, to } of done.reverse())
        await moveOne({ from: to, to: from }).catch(() => {});
      throw err;
    }
    await d.refresh(pairs.flatMap((p) => [dirname(p.from), dirname(p.to), p.to]));
  };
  const paths = moves.flatMap((m) => [m.from, m.to]);
  return {
    label,
    kind: "file",
    paths,
    attach: (more) => {
      extra = more;
      paths.push(...(more.paths ?? []));
    },
    undo: async () => {
      // Imports first (they name the new paths), then the files move back.
      await extra?.undo();
      try {
        await apply(
          [...moves].reverse().map(({ from, to }) => ({ from: to, to: from })),
          "undo",
        );
      } catch (err) {
        await extra?.redo().catch(() => {});
        throw err;
      }
    },
    redo: async () => {
      await apply(moves, "redo");
      // The files moved: that's the step. Imports that can't follow are a warning, not a
      // half-done redo (the step stays done either way).
      await extra
        ?.redo()
        .catch((err: unknown) =>
          d.services.notifications.show(
            "warning",
            `Imports weren't updated: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    },
  };
}

export interface MoveExtra {
  undo(): Promise<void>;
  redo(): Promise<void>;
  paths?: readonly string[];
}
