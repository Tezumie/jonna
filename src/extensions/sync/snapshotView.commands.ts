// Looking inside a snapshot before restoring it: the commands that list its files against the
// open folder, show one of them beside the folder's in a diff tab, and open the Sync tab on the
// list; and the diff's left side, the content source `syncSnapshot:<collection>/<id>`. All of it
// only reads: the snapshot's list and a file's text are fetched and nothing is written to the
// folder or the account. The words and the state are in snapshotView.model.ts, the list's
// drawing in snapshotView.ts.
import { fsIpc } from "../../core/ipc/fs";
import { type SnapshotFileText, syncIpc } from "../../core/ipc/sync";
import type { DisposableStore } from "../../core/lifecycle/index";
import { isWithin, joinPath, relativePath } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { SYNC_VIEW, type SyncCommandParts, syncGates } from "./commands";
import type { SnapshotRow } from "./controller";
import {
  countFiles,
  filterFiles,
  parseSnapshotScheme,
  SNAPSHOT_SCHEME,
  snapshotLabel,
  snapshotScheme,
  sortFiles,
  summaryLine,
  textRefusal,
} from "./snapshotView.model";

const CATEGORY = "Sync";
/** A snapshot's files as text, kept while their diffs are open: this many at most. */
const TEXTS_KEPT = 12;
/** `sync.snapshot.files` returns at most this many files (what differs first). */
const FILES_RETURNED = 2000;
/** After these the folder's files changed: the list being looked at is compared again. */
const RESTORES = ["sync.snapshot.restoreFile", "sync.snapshot.restore", "sync.snapshot.continue"];

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function registerSnapshotViewCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
  parts: SyncCommandParts,
): void {
  const { controller, session } = parts;
  const { dispatcher, dock, events, notifications, quickDiff } = services;
  const { sync, whenOn } = syncGates(parts);
  const look = session.look;

  const snapshot = (id: string): SnapshotRow => {
    const row = sync()
      .snapshots.peek()
      .find((r) => r.id === id);
    if (!row) throw new Error("That snapshot is gone.");
    return row;
  };

  /** The open project as it syncs: its folder and where its snapshots are kept. */
  const project = (): { root: string; collection: string } => {
    const root = sync().project.peek()?.root;
    const collection = sync().collection();
    if (!root || !collection) throw new Error("This project doesn't sync.");
    return { root, collection };
  };

  /**
   * A snapshot's files as text, by snapshot and path. A snapshot never changes, so a text read
   * once is the text; a diff tab asks for it again whenever git's state moves.
   */
  const texts = new Map<string, Promise<SnapshotFileText | null>>();
  sub.add({ dispose: () => texts.clear() });
  const textOf = (
    base: string,
    collection: string,
    id: string,
    path: string,
  ): Promise<SnapshotFileText | null> => {
    const key = `${collection}/${id}\n${path}`;
    const kept = texts.get(key);
    if (kept) return kept;
    const read = syncIpc.snapshotFileText(base, collection, id, path);
    texts.set(key, read);
    // A read that failed (offline) is asked again next time.
    read.catch(() => {
      if (texts.get(key) === read) texts.delete(key);
    });
    for (const oldest of texts.keys()) {
      if (texts.size <= TEXTS_KEPT) break;
      texts.delete(oldest);
    }
    return read;
  };

  /** Reads the files of the snapshot being looked at into the tab's list. */
  const load = async (id: string): Promise<void> => {
    const turn = look.begin(id);
    try {
      const base = await whenOn();
      const { root, collection } = project();
      look.finish(turn, await syncIpc.snapshotCompare(base, collection, id, root));
    } catch (err) {
      look.fail(turn, messageOf(err));
      throw err;
    }
  };

  if (controller) {
    // The left side of a snapshot's diff: the file as the snapshot has it. Null (an empty side)
    // when the snapshot doesn't hold the file, or it can't be read now.
    sub.add(
      quickDiff.registerContent(SNAPSHOT_SCHEME, async (path, scheme) => {
        const at = parseSnapshotScheme(scheme);
        const root = controller.project.peek()?.root ?? services.workspace.root.peek();
        const base = controller.base();
        if (!at || !root || !base || !isWithin(root, path)) return null;
        const read = await textOf(base, at.collection, at.id, relativePath(root, path)).catch(
          () => null,
        );
        return read?.text ?? null;
      }),
    );
    // A restore changed the folder: what the open list says of it is compared again.
    sub.add(
      events.on("command.executed", (event) => {
        if (event.status !== "ok" || !RESTORES.includes(event.id)) return;
        const opened = look.opened.peek();
        if (opened?.phase === "ready") void load(opened.id).catch(() => {});
      }),
    );
  }

  sub.add(
    dispatcher.register({
      id: "sync.snapshot.files",
      title: "List a snapshot's files",
      category: CATEGORY,
      description:
        "Lists what one of the open project's snapshots holds, compared with the open folder, without changing anything. Returns the snapshot (`id`, `time` in ms, `computer`, `branch`), `summary` (a sentence), `counts` (`total`, `differ`, `missing`, `same`, `unknown`), `truncated` (how many files were left uncompared because the snapshot names more than 5,000), and `files`: each with `path` (relative to the folder), `size` in bytes, `deleted` (the snapshot records that the file was deleted) and `state`: `same` (the folder's file has the same content; for a deletion, the file is gone from the folder too), `differs` (the folder's file has other content; for a deletion, the file is still in the folder), `missing` (in the snapshot, not in the folder) or `unknown` (not compared). Files that differ come first; at most 2,000 are returned and `more` counts the rest (`filter` narrows the list to paths holding its words). For a git project a snapshot holds only the files that differed from the commit when it was taken. sync.snapshot.openDiff shows one file beside the folder's.",
      input: s.object({
        id: s.string().describe("The snapshot's id (ide://sync snapshots)"),
        filter: s
          .string()
          .describe("Only files whose path holds every word of this, whatever the case")
          .optional(),
      }),
      effects: ["network"],
      agent: "discoverable",
      run: async ({ id, filter }) => {
        const base = await whenOn();
        const row = snapshot(id);
        const { root, collection } = project();
        const compared = await syncIpc.snapshotCompare(base, collection, id, root);
        const all = sortFiles(compared.files);
        const counts = countFiles(all);
        const matched = filterFiles(all, filter ?? "");
        return {
          id,
          time: row.summary.time,
          computer: row.summary.deviceName,
          branch: row.summary.branch ?? null,
          summary: summaryLine(counts),
          counts,
          truncated: compared.truncated,
          files: matched.slice(0, FILES_RETURNED),
          more: Math.max(0, matched.length - FILES_RETURNED),
        };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.snapshot.openDiff",
      title: "Compare a snapshot's file with the folder",
      category: CATEGORY,
      description:
        "Opens a diff tab of one file: how a snapshot of the open project has it (left, read-only) beside the folder's file now (right). Nothing is restored. A file the folder doesn't have shows against an empty right side; a file the snapshot deleted, or doesn't hold, shows the folder's against an empty left side. A file that isn't text or is larger than 2 MB isn't opened (`opened` false, with `reason`: binary or large). Paths come from sync.snapshot.files.",
      input: s.object({
        id: s.string().describe("The snapshot's id (ide://sync snapshots)"),
        path: s.string().describe("The file, relative to the folder"),
      }),
      effects: ["network"],
      agent: "discoverable",
      needsScreen: true,
      run: async ({ id, path }, ctx) => {
        const base = await whenOn();
        const row = snapshot(id);
        const { root, collection } = project();
        const file = path.replaceAll("\\", "/").replace(/^\.?\/+/, "");
        const full = joinPath(root, file);
        if (!file || !isWithin(root, full)) throw new Error("That file isn't in this folder.");
        const read = await textOf(base, collection, id, file);
        if (read && read.text === null) {
          const reason = read.reason ?? "binary";
          notifications.show("info", textRefusal(file, reason), { title: "Sync" });
          return { opened: false, path: file, reason };
        }
        // In neither: there is nothing to show on either side.
        if (!read && !(await fsIpc.stat(full).then(Boolean, () => false)))
          throw new Error(`${file} is neither in the snapshot nor in this folder.`);
        const label = snapshotLabel(row.summary.time);
        await ctx.execute("editor.openDiff", {
          path: full,
          base: snapshotScheme(collection, id),
          // Said in the tab's title when the left side is empty for want of the file.
          baseLabel: read ? label : `${label}, without this file`,
        });
        return { opened: true, path: file, inSnapshot: read !== null };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "sync.snapshot.view",
      title: "View a snapshot's changes",
      category: CATEGORY,
      description:
        "Opens the Sync tab on one of the open project's snapshots: its files, each with how it stands against the folder (differs, not in this folder, same, deleted), to look at before restoring. A row there opens the file's diff (sync.snapshot.openDiff) and can restore that one file. Nothing is changed. Returns the counts once the files were read; the same is in ide://sync (`viewing`). sync.snapshot.files returns the list itself.",
      input: s.object({ id: s.string().describe("The snapshot's id (ide://sync snapshots)") }),
      effects: ["network"],
      agent: "discoverable",
      needsScreen: true,
      run: async ({ id }) => {
        await whenOn();
        snapshot(id);
        const open = sync().project.peek();
        if (open?.id) session.projectId.value = open.id;
        session.page.value = "projects";
        const tabId = dock.openView(SYNC_VIEW, null, "main", true);
        await load(id);
        const opened = look.opened.peek();
        return {
          tabId,
          id,
          counts: opened?.id === id ? opened.counts : null,
          truncated: opened?.id === id ? opened.truncated : 0,
        };
      },
    }),
  );
}
