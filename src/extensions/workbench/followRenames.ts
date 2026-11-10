// Tabs that show a file follow it when it's renamed or moved (D187), whatever shows it: a file
// viewer (image, preview, an extension's viewer such as the canvas), not only the text editor
// (which follows its own documents). The tab is reopened on the new path in the same place, so
// there's never a second tab for the moved file.
// And they close when it's deleted (D189) — through the IDE or by anything else (a terminal, the
// OS, the agent's shell): every view that names its file (`resource`) is covered, built-in or an
// extension's, including views added later. The text editor keeps its tab with a "deleted"
// banner (as VS Code does); a diff stays (it can show a deletion); a view with unsaved changes
// stays too (saving it recreates the file).
import { fsIpc } from "../../core/ipc/fs";
import { IpcError } from "../../core/ipc/invoke";
import type { DisposableStore } from "../../core/lifecycle/index";
import { isAbsolute, isWithin, joinPath, relativePath } from "../../core/paths/index";
import type { WorkbenchServices } from "../../workbench/services";

export function registerFollowRenames(sub: DisposableStore, services: WorkbenchServices): void {
  const { dock, events } = services;
  sub.add(
    events.on("files.didRename", ({ from, to }) => {
      for (const tab of dock.tabs()) {
        if (tab.viewType === "editor") continue;
        const descriptor = dock.descriptor(tab);
        const state = dock.liveView(tab.id)?.serialize() ?? tab.viewState;
        const path = descriptor?.resource?.(state);
        if (!path || !state || typeof state !== "object" || Array.isArray(state)) continue;
        const stored = (state as Record<string, unknown>).path;
        if (typeof stored !== "string" || !(path === from || isWithin(from, path))) continue;
        const moved = path === from ? to : joinPath(to, relativePath(from, path));
        const where = dock.findTab(tab.id);
        if (!where) continue;
        // A view that follows a rename itself keeps its state (a notebook: unsaved cells and its
        // kernel); one with unsaved changes isn't reopened from disk (they'd be lost).
        const live = dock.liveView(tab.id) as
          | (ReturnType<typeof dock.liveView> & { renamed?(path: string): void })
          | undefined;
        if (live && typeof live.renamed === "function") {
          live.renamed(moved);
          continue;
        }
        if (live?.isDirty?.()) continue;
        const active = where.group.activeTabId === tab.id;
        dock.openView(
          tab.viewType,
          { ...(state as Record<string, unknown>), path: moved },
          { groupId: where.group.id, index: where.index },
          active,
        );
        void dock.closeTab(tab.id, true);
      }
    }),
  );
}

/** View types that handle a deleted file themselves or should stay open (see above). */
const KEEP_ON_DELETE = new Set(["editor", "diff", "browser"]);
/** How often open file views are checked against the disk (deletions made outside the IDE). */
const POLL_MS = 2500;

export function registerCloseDeleted(sub: DisposableStore, services: WorkbenchServices): void {
  const { dock, events, workspace } = services;
  /** Open tabs that show a file (absolute paths). */
  const fileTabs = () =>
    dock.tabs().flatMap((tab) => {
      if (KEEP_ON_DELETE.has(tab.viewType)) return [];
      const state = dock.liveView(tab.id)?.serialize() ?? tab.viewState;
      const resource = dock.descriptor(tab)?.resource?.(state);
      if (!resource || resource.startsWith("virtual:") || /^[a-z][\w+.-]*:\/\//i.test(resource))
        return [];
      const path =
        isAbsolute(resource) || !workspace.root.peek() ? resource : workspace.resolve(resource);
      return [{ tab, path }];
    });
  const close = (tabId: string) => {
    if (dock.liveView(tabId)?.isDirty?.()) return;
    void dock.closeTab(tabId, true);
  };
  sub.add(
    events.on("files.didDelete", ({ path }) => {
      for (const { tab, path: p } of fileTabs()) if (p === path || isWithin(path, p)) close(tab.id);
    }),
  );
  // Deleted by something else: checked while the window is used. Only "not found" counts (a
  // share that's briefly away, or a denied read, isn't a deletion), seen twice at least a poll
  // apart, so a file replaced by an atomic save — briefly missing — isn't taken for deleted.
  const missingSince = new Map<string, number>();
  let busy = false;
  const check = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const live = new Set<string>();
      for (const { tab, path } of fileTabs()) {
        const key = `${tab.id}\n${path}`;
        live.add(key);
        const gone = await fsIpc.stat(path).then(
          () => false,
          (err: unknown) => err instanceof IpcError && err.code === "NotFound",
        );
        if (!gone) missingSince.delete(key);
        else {
          const since = missingSince.get(key);
          if (since === undefined) missingSince.set(key, Date.now());
          else if (Date.now() - since >= POLL_MS) {
            missingSince.delete(key);
            close(tab.id);
          }
        }
      }
      // Tabs closed some other way are forgotten.
      for (const key of [...missingSince.keys()]) if (!live.has(key)) missingSince.delete(key);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void check(), POLL_MS);
  const onFocus = () => void check();
  window.addEventListener("focus", onFocus);
  sub.add({
    dispose: () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    },
  });
}

/**
 * Tabs showing files of folders taken out of a multi-root workspace close (D251): every view
 * that names its file, editors included; one with unsaved changes asks first, as closing its tab
 * does (Cancel keeps it). Files still inside another folder (nested folders) stay. Closing the
 * whole workspace is the dock's `closeAllLive` instead.
 */
export function registerCloseRemovedFolders(
  sub: DisposableStore,
  services: WorkbenchServices,
): void {
  const { dock, workspace } = services;
  let queue: Promise<unknown> = Promise.resolve();
  sub.add(
    workspace.onDidChangeFolders(({ removed }) => {
      if (!removed.length) return;
      const gone = removed.map((f) => f.path);
      const tabs = dock.tabs().flatMap((tab) => {
        const state = dock.liveView(tab.id)?.serialize() ?? tab.viewState;
        const resource = dock.descriptor(tab)?.resource?.(state);
        if (!resource || !isAbsolute(resource)) return [];
        if (!gone.some((folder) => isWithin(folder, resource)) || workspace.contains(resource))
          return [];
        return [tab.id];
      });
      // One question at a time (each dirty tab asks); a second removal waits its turn.
      queue = queue.then(async () => {
        for (const id of tabs) if (dock.findTab(id)) await dock.closeTab(id).catch(() => false);
      });
    }),
  );
}
