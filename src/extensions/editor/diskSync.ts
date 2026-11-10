// Keeps open documents in step with the disk (PLAN M2 "watcher-driven reload"): the folders of
// open text documents are watched; when a file changes and has no unsaved edits it is reloaded
// in place (one undoable edit); with unsaved edits the tab shows the "changed on disk" banner
// (DESIGN.md §12.12) with Reload / Keep my changes. Deleted files get a banner too.
import { docsWatchIpc, fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { dirname, pathKey } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { fileSystems, uriScheme } from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { diskChange, utf8Again } from "./diskText";
import { applyDiskText, decodeFile, type EditorDocument, type EditorService } from "./service";

/** A file's bytes: from disk, or through the extension serving its URI (D233, D234). */
function readBytes(path: string): Promise<Uint8Array> {
  return fileSystems.get(path)?.readFile(path) ?? fsIpc.read(path);
}

/** Per document, the newest check: an older read that finishes later is dropped. */
const checks = new WeakMap<EditorDocument, number>();

/** Re-reads `doc` from disk and reloads it, or flags a conflict / deletion. */
export async function checkDisk(doc: EditorDocument, editors: EditorService): Promise<void> {
  if (doc.kind !== "text") return;
  // Watcher batches and command events can start overlapping reads; they may finish out of
  // order, and an older one (the file before a delete, or before the latest write) must not win.
  const generation = (checks.get(doc) ?? 0) + 1;
  checks.set(doc, generation);
  const path = doc.path.peek();
  let bytes: Uint8Array | null;
  try {
    bytes = await readBytes(path);
  } catch {
    bytes = null;
  }
  if (checks.get(doc) !== generation || doc.path.peek() !== path) return;
  if (!bytes) {
    doc.diskState.value = "deleted";
    return;
  }
  // Read-only because it wasn't UTF-8, and rewritten as UTF-8 elsewhere: writable again (D218).
  const utf8 = doc.notUtf8 && !doc.dirty.peek() ? utf8Again(bytes) : null;
  if (utf8) {
    editors.becameUtf8(doc, utf8);
    return;
  }
  const { text, binary, notUtf8 } = decodeFile(bytes, doc.encoding);
  if (binary) return;
  const current = doc.model.peek()?.getText() ?? doc.initialText;
  // The watcher reports the IDE's own saves too, often after the user has typed on: disk text
  // equal to what we last wrote (or loaded) is no external change, so no banner (which would also
  // stop autosave). A file back to that text (restored after a delete) has no conflict either.
  const change = diskChange(text, current, doc.diskText);
  if (change !== "external") {
    if (change === "same") doc.diskText = text;
    doc.diskState.value = "ok";
    return;
  }
  if (doc.dirty.peek()) doc.diskState.value = "changed";
  else {
    // Rewritten in another encoding: from now on saving it would damage it.
    if (notUtf8) doc.notUtf8 = true;
    applyDiskText(doc, text);
  }
}

export function registerDiskSync(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): void {
  const { dispatcher, workspace, events } = services;
  void docsWatchIpc
    .start((batch) => {
      for (const path of batch.paths) {
        const doc = editors.find(path);
        if (doc) void checkDisk(doc, editors);
      }
    })
    .then((d) => sub.add(d))
    .catch(() => {});
  // Watch the folders of open text documents.
  let last = "";
  sub.add(
    effect(() => {
      const dirs = [
        ...new Set(
          editors.documents.value
            // An extension's file system reports its own changes (below).
            .filter((d) => d.kind === "text" && !uriScheme(d.path.value))
            .map((d) => dirname(d.path.value)),
        ),
      ].sort();
      const key = dirs.map(pathKey).join("\n");
      if (key !== last) {
        last = key;
        void docsWatchIpc.setDirs(dirs).catch(() => {});
      }
      return undefined;
    }),
  );
  // An extension's file system said its files changed (VS Code: an unmodified editor reloads, a
  // modified one shows "changed on disk").
  sub.add(
    fileSystems.onDidChangeFiles((changes) => {
      for (const { path } of changes) {
        const doc = editors.find(path);
        if (doc) void checkDisk(doc, editors);
      }
    }),
  );
  // Changes made through commands (replace in files) don't wait for the watcher.
  sub.add(
    events.on("files.didChange", ({ path }) => {
      const doc = editors.find(path);
      if (doc) void checkDisk(doc, editors);
    }),
  );

  const target = (path: string | undefined): EditorDocument => {
    const doc = path
      ? editors.find(uriScheme(path) ? path : workspace.resolve(path))
      : editors.documents.peek().find((d) => d.diskState.peek() !== "ok");
    if (!doc) throw new Error("No such open document.");
    return doc;
  };
  sub.add(
    dispatcher.register({
      id: "editor.reloadFromDisk",
      title: "Reload from disk",
      category: "File",
      description:
        "Replaces an open document's text with the file on disk, discarding unsaved edits (they stay in undo history).",
      input: s.object({
        path: s.string().describe("Open file (default: one with a disk conflict)").optional(),
      }),
      effects: ["write"],
      run: async ({ path }) => {
        const doc = target(path);
        const bytes = await readBytes(doc.path.peek());
        // A read-only document whose file is UTF-8 now: writable again (D218).
        const utf8 = doc.notUtf8 ? utf8Again(bytes) : null;
        if (utf8) {
          editors.becameUtf8(doc, utf8);
          return { path: doc.path.peek() };
        }
        const { text, binary, notUtf8 } = decodeFile(bytes, doc.encoding);
        if (binary) throw new Error("The file on disk is binary now; close and reopen it.");
        if (notUtf8) doc.notUtf8 = true;
        applyDiskText(doc, text);
        return { path: doc.path.peek() };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "editor.keepLocalChanges",
      title: "Keep my changes",
      category: "File",
      description: "Dismisses the 'changed on disk' banner; saving will overwrite the file.",
      input: s.object({ path: s.string().describe("Open file").optional() }),
      effects: [],
      run: async ({ path }) => {
        const doc = target(path);
        // The disk's text becomes the known one, so the next save overwrites it (it refuses to
        // overwrite a change it hasn't been told about).
        const bytes = await readBytes(doc.path.peek()).catch(() => null);
        if (bytes) {
          const disk = decodeFile(bytes, doc.encoding);
          if (!disk.binary) doc.diskText = disk.text;
        }
        doc.diskState.value = "ok";
      },
    }),
  );
}
