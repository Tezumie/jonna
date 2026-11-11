// Extensions' file viewers (custom editors, D176): an extension page that shows a file some other
// way than as text, like the built-in image and Markdown previews. Each viewer is a dock view type
// `extviewer:<extension>.<viewer>` with state `{ path }` and an entry in services.viewers, so files
// open in it directly (a default viewer) or from "Open preview" / "Reopen with…". The page gets
// the file's text after it loads (again when the file changes on disk) and saves with a message,
// when the extension has fs.write. Reading the file the user opened in it needs no permission
// (opening it there is the user's choice, like VS Code's custom editors); other files do. Messages to and from the worker use the viewer's id, like a
// webview panel's.
import type { Json } from "../../core/dock/index";
import { Emitter } from "../../core/events/index";
import { hasPermission, type ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { fsIpc } from "../../core/ipc/fs";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { basename, pathKey } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import { showDialog } from "../../ui/Dialog";
import type { DockView } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { contributedTitleActions } from "../../workbench/titleActions";
import { safeIcon } from "./treeView";
import { WebviewFrame } from "./webview";
import { isGitFolderName } from "./workbenchChecks";

/** Code-page viewer tabs' unsaved state, by instance (D258: VS Code's editable custom editors). */
const dirtySetters = new Map<number, (dirty: boolean) => void>();

/** Marks a viewer tab unsaved (the dot on its tab; closing it asks first). */
export function setViewerDirty(instance: number, dirty: boolean): void {
  dirtySetters.get(instance)?.(dirty);
}

export interface ViewerHost {
  origin(): Promise<string>;
  granted(): readonly string[];
  /** A path inside the open folder (throws otherwise). */
  workspacePath(path: string): string;
  /**
   * A page opened: messages to `viewerId` reach it until the returned handle is disposed;
   * `instance` names this tab (a code-page viewer's messages carry it, D257).
   */
  opened(viewerId: string, frame: WebviewFrame): Disposable & { instance: number };
  /** The empty page a code-page viewer's tab starts on (D257). */
  blankPage(): string;
  receive(viewerId: string, message: unknown): void;
}

/** Dock view type of an extension's viewer. */
export function viewerViewType(viewerId: string): string {
  return `extviewer:${viewerId}`;
}

export function registerViewers(
  services: WorkbenchServices,
  manifest: ThirdPartyManifest,
  host: ViewerHost,
): Disposable {
  const store = new DisposableStore();
  for (const viewer of manifest.contributes.viewers) {
    const type = viewerViewType(viewer.id);
    const icon = safeIcon(viewer.icon, "eye");
    const pathOf = (state: Json) => String(stateField(state, "path") ?? "");
    store.add(
      services.dock.views.register({
        type,
        title: (state) => `${basename(pathOf(state)) || viewer.title}`,
        icon: () => icon,
        tooltip: (state) => `${pathOf(state)} (${viewer.title}, ${manifest.displayName})`,
        resource: (state) => pathOf(state) || undefined,
        // Extensions' "editor/title" buttons whose `when` holds for this custom editor (D419:
        // VS Code's `activeCustomEditorId == <view type>`).
        actions: (state) =>
          contributedTitleActions(services, pathOf(state), { activeCustomEditorId: viewer.id }),
        editorLike: true,
        defaultPlacement: "main",
        detachable: true,
        create: (state, ctx): DockView => {
          const path = pathOf(state);
          const views = new DisposableStore();
          const canWrite = hasPermission(host.granted(), "fs.write");
          const full = (() => {
            try {
              return host.workspacePath(path);
            } catch {
              return "";
            }
          })();
          /** The file's time when last sent or saved here: a newer one came from elsewhere. */
          let lastMtime = 0;
          /** Saves of its own in flight (their new time isn't a change from outside). */
          let saving = 0;
          /** This tab, for a code-page viewer's messages (D257). */
          let instance = 0;
          /** Whether the tab shows, and how a code-page viewer's code is told (D419). */
          let shows = true;
          let setShows: ((value: boolean) => void) | undefined;
          const frame = new WebviewFrame(
            services,
            {
              path: viewer.path ?? host.blankPage(),
              origin: () => host.origin(),
              receive: (message) =>
                host.receive(
                  viewer.id,
                  viewer.codePage ? { ide: "viewerMessage", instance, message } : message,
                ),
              file: {
                path: full || path,
                read: async () => {
                  if (!full) throw new Error(`${path} is outside the open folder.`);
                  const open = services.documents.text(full);
                  return open ?? new TextDecoder().decode(await fsIpc.read(full));
                },
                ...(canWrite &&
                  full && {
                    save: async (text: string) => {
                      if (!hasPermission(host.granted(), "fs.write"))
                        throw new Error(`${manifest.displayName} may no longer change files.`);
                      // As every write of an extension (D207): never inside a .git folder (its
                      // config and hooks run programs), even a file opened in its viewer.
                      if (full.split(/[\\/]/).some(isGitFolderName))
                        throw new Error(
                          `${path} is inside a .git folder: extensions can't write there.`,
                        );
                      // Its own save isn't a change from outside (below): the poll waits.
                      saving++;
                      try {
                        await fsIpc.write(full, new TextEncoder().encode(text));
                        lastMtime =
                          (await fsIpc.stat(full).catch(() => null))?.mtimeMs ?? lastMtime;
                      } finally {
                        saving--;
                      }
                      // An edit keeps the tab, as typing in a preview editor does (D183): a
                      // preview tab would be replaced by the next file opened.
                      ctx.pin();
                      services.events.emit("files.didChange", { path: full });
                    },
                  }),
              },
            },
            viewer.title,
          );
          const opened = host.opened(viewer.id, frame);
          instance = opened.instance;
          views.add(opened);
          // Which tabs show which file, from here (D181): a page reloads (moving to another
          // window) without closing, and can't say it's going (its last messages die with it).
          const tab = viewer.codePage ? { instance } : {};
          host.receive(viewer.id, { ide: "viewerOpened", path: full || path, ...tab });
          views.add(
            toDisposable(() =>
              host.receive(viewer.id, { ide: "viewerClosed", path: full || path, ...tab }),
            ),
          );
          // A code-page viewer's code hears whether this is the tab the user is in and whether
          // it shows (D419: VS Code's WebviewPanel.active / visible and onDidChangeViewState).
          if (viewer.codePage) {
            let active: boolean | undefined;
            const send = () =>
              host.receive(viewer.id, {
                ide: "viewerState",
                instance,
                active: active === true,
                visible: shows,
              });
            views.add(
              effect(() => {
                services.dock.root.value;
                services.dock.focusedGroupId.value;
                const now = services.dock.activeTab()?.id === ctx.tabId;
                if (now !== active) {
                  active = now;
                  send();
                }
                return undefined;
              }),
            );
            setShows = (value) => {
              if (shows === value) return;
              shows = value;
              send();
            };
          }
          views.add(frame);
          // Changed on disk (by another tool, git, the text editor's save): send it again.
          for (const event of ["files.didChange", "files.didSave"] as const)
            views.add(
              services.events.on(event, (e) => {
                if (!full || pathKey(e.path) !== pathKey(full)) return;
                void frame.sendFile();
                // Sent already: the poll mustn't send it again for the same change.
                void fsIpc.stat(full).then(
                  (st) => {
                    lastMtime = st.mtimeMs;
                  },
                  () => {},
                );
              }),
            );
          // Changed by anything else (the agent's edit_file, a script, another editor, D190):
          // the file's time is checked while the window is in use.
          if (full) {
            const poll = async () => {
              if (document.hidden || saving) return;
              const t = (await fsIpc.stat(full).catch(() => null))?.mtimeMs;
              if (t === undefined || saving) return;
              if (lastMtime && t !== lastMtime) void frame.sendFile();
              lastMtime = t;
            };
            void poll();
            const timer = setInterval(() => void poll(), 2000);
            views.add(toDisposable(() => clearInterval(timer)));
          }
          views.add(
            services.events.on("files.didDelete", (e) => {
              if (pathKey(e.path) === pathKey(full)) ctx.close();
            }),
          );
          // Unsaved changes its code reports (D258).
          let dirty = false;
          const changed = views.add(new Emitter<void>());
          dirtySetters.set(instance, (value) => {
            if (dirty === value) return;
            dirty = value;
            changed.fire();
          });
          views.add(toDisposable(() => dirtySetters.delete(instance)));
          return {
            element: frame.element,
            onWindowChanged: (win) => frame.onWindowChanged(win),
            onShow: () => setShows?.(true),
            onHide: () => setShows?.(false),
            isDirty: () => dirty,
            onDidChange: changed.event,
            confirmClose: async () =>
              !dirty ||
              (await showDialog<"close" | "cancel">({
                title: "Close without saving?",
                message: `${basename(path)} has changes ${manifest.displayName} hasn't saved.`,
                actions: [
                  { label: "Cancel", value: "cancel", variant: "secondary" },
                  { label: "Close", value: "close", variant: "danger" },
                ],
                cancelValue: "cancel",
                defaultValue: "cancel",
              })) === "close",
            serialize: () => ({ path }),
            // The extension may not have started yet after a restart.
            persist: () => false,
            dispose: () => views.dispose(),
          };
        },
      }),
    );
    // Open tabs close when the extension stops, before the view type goes (reverse order).
    store.add(closeTabsOf(services, type));
    store.add(
      services.viewers.register({
        id: viewer.id,
        label: viewer.title,
        viewType: type,
        extensions: viewer.extensions,
        kind: viewer.default ? "default" : "preview",
        ...(viewer.icon && { icon }),
      }),
    );
  }
  return store;
}

/** Tabs closed when their extension stopped: reopened if it comes back soon (a reload). */
const closedTabs = new Map<string, { at: number; states: Json[] }>();
const REOPEN_WITHIN_MS = 15_000;

/**
 * Closes every tab of a view type when the extension that owns it stops (a page left open could
 * start a stopped extension again), and reopens them when it registers the type again soon
 * after: a development extension reloads on every save.
 */
export function closeTabsOf(services: WorkbenchServices, viewType: string): Disposable {
  const reopen = closedTabs.get(viewType);
  closedTabs.delete(viewType);
  if (reopen && Date.now() - reopen.at < REOPEN_WITHIN_MS)
    queueMicrotask(() => {
      for (const state of reopen.states)
        try {
          services.dock.openView(viewType, state, undefined, false);
        } catch {
          // The type went again meanwhile.
        }
    });
  return toDisposable(() => {
    const tabs = services.dock.tabs(viewType);
    if (tabs.length)
      closedTabs.set(viewType, { at: Date.now(), states: tabs.map((t) => t.viewState ?? null) });
    for (const tab of tabs) void services.dock.closeTab(tab.id, true);
  });
}
