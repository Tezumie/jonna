// The views and file viewers an extension's manifest declares, apart from runtime.ts because
// they're one subject read together: placing a view (side bar, panel, editor area, another
// extension's container), making its tree or webview page when it shows, opening it, and the
// worker's requests about them (`tree.*`, `view.title`, `webview.*`). What VS Code's TreeView and
// WebviewView know of their view's visibility and badge is runtimeViews.ts; the pages code
// writes, runtimeCodePages.ts.
import { matchesWhen } from "../../core/context/index";
import type { Caller } from "../../core/dispatcher/types";
import { Emitter } from "../../core/events/index";
import type { TreeItem } from "../../core/extensions/rpc";
import type {
  ContributedViewContainer,
  ThirdPartyManifest,
} from "../../core/extensions/thirdParty";
import { treeItemMenu, treeMenuInput } from "../../core/extensions/treeMenus";
import { placeInContainer } from "../../core/extensions/vscodePackage";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { imageIcon } from "../../ui/Icon";
import type { DockView } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import { CodePages } from "./runtimeCodePages";
import type { ExtensionHooksHost } from "./runtimeHooks";
import { ExtensionTreeView, safeIcon } from "./treeView";
import { closeTabsOf, registerViewers, setViewerDirty } from "./viewers";
import { WebviewFrame, withPageSetup } from "./webview";
import type { ExtensionWorker, LogLine } from "./workerHost";

export interface ContributedViewsDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  /** The extension's folder. */
  root: string;
  caller: Caller;
  /** The runtime's store: what a view registers goes with the extension. */
  store: DisposableStore;
  /** The runtime's warnings (the extension's page lists them). */
  warnings: string[];
  log(line: LogLine): void;
  granted(): readonly string[];
  workspacePath(path: unknown): string;
  /** The worker, started when a view needs it. */
  worker(): Promise<ExtensionWorker>;
  /** The running worker, or null. */
  running(): ExtensionWorker | null;
  /** The origin its pages are served on. */
  origin(): Promise<string>;
  /** A blob URL for one of the extension's image files. */
  image(path: string): Promise<string | null>;
  /** Views' visibility and tree extras (runtimeHooks.ts). */
  hooks: ExtensionHooksHost;
  /** Another enabled VS Code package's view container with this id. */
  viewContainer(id: string): ContributedViewContainer | undefined;
}

/** The requests answered here. */
const REQUESTS: ReadonlySet<string> = new Set([
  "tree.register",
  "tree.refresh",
  "tree.reveal",
  "tree.message",
  "view.title",
  "webview.post",
  "webview.setDirty",
  "webview.setHtml",
  "webview.reveal",
]);

export class ExtensionContributedViews implements Disposable {
  /** This run of the extension: viewer tabs' saved page state is keyed by it (D263). */
  private readonly pageStamp = Date.now().toString(36);
  private readonly trees = new Map<string, ExtensionTreeView[]>();
  private readonly treeProviders = new Set<string>();
  /** Views whose title or description its code set (cleared when it stops). */
  private readonly viewTitles = new Set<string>();
  /** view id → the message its trees show above the rows (D208). */
  private readonly treeMessages = new Map<string, string>();
  private readonly webviews = new Map<string, WebviewFrame[]>();
  /** Pages its code writes for webview views and viewers (D257). */
  private readonly codePages: CodePages;
  /** A code-page viewer's open tabs: instance → its frame (D257). */
  private readonly viewerTabs = new Map<number, WebviewFrame>();
  private viewerTabSeq = 0;

  constructor(private readonly deps: ContributedViewsDeps) {
    this.codePages = new CodePages(deps.root);
  }

  /** The empty page a code-written view or viewer shows until its code sets one (D257). */
  pagesReady(): Promise<void> {
    return this.codePages.ready();
  }

  /**
   * A view of the extension; one with a `when` (VS Code's views and containers, D260) is there
   * only while it holds, coming and going as context keys change.
   */
  registerView(placed: ThirdPartyManifest["contributes"]["views"][number]): void {
    const view = this.inContainer(placed);
    const { when } = view;
    if (!when) {
      this.tryRegisterViewIn(this.deps.store, view);
      return;
    }
    let shown: DisposableStore | null = null;
    const sync = () => {
      let holds = false;
      try {
        holds = matchesWhen(when, (k) => this.deps.services.context.get(k));
      } catch {
        holds = false;
      }
      if (holds && !shown) {
        shown = new DisposableStore();
        this.tryRegisterViewIn(shown, view);
      } else if (!holds && shown) {
        shown.dispose();
        shown = null;
      }
    };
    sync();
    this.deps.store.add(this.deps.services.context.onDidChange(sync));
    this.deps.store.add(toDisposable(() => shown?.dispose()));
  }

  /**
   * A view in another extension's container (Cell Tags in Jupyter's panel) goes where that
   * container is; one whose container no enabled extension has stays in the Explorer, with
   * VS Code's warning.
   */
  private inContainer(
    view: ThirdPartyManifest["contributes"]["views"][number],
  ): ThirdPartyManifest["contributes"]["views"][number] {
    if (!view.container) return view;
    const container = this.deps.viewContainer(view.container);
    if (container) return placeInContainer(view, container);
    const text = `View container '${view.container}' does not exist and all views registered to it will be added to 'Explorer'.`;
    if (!this.deps.warnings.includes(text)) {
      this.deps.warnings.push(text);
      this.deps.log({ time: Date.now(), level: "warn", text });
    }
    return view;
  }

  /** Where its view `viewId` shows, its container resolved (undefined: not one of its views). */
  private viewLocation(viewId: string): string | undefined {
    const declared = this.deps.manifest.contributes.views.find((v) => v.id === viewId);
    return declared && this.inContainer(declared).location;
  }

  /**
   * A view whose id another extension (or the IDE) has is skipped with a warning, as VS Code
   * does: the rest of the extension still loads.
   */
  private tryRegisterViewIn(
    store: DisposableStore,
    view: ThirdPartyManifest["contributes"]["views"][number],
  ): void {
    const views = new DisposableStore();
    try {
      this.registerViewIn(views, view);
      store.add(views);
    } catch (err) {
      views.dispose();
      this.deps.log({
        time: Date.now(),
        level: "warn",
        text: `View ${view.id} skipped: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private registerViewIn(
    store: DisposableStore,
    view: ThirdPartyManifest["contributes"]["views"][number],
  ): void {
    const title = view.title;
    const viewIcon = safeIcon(view.icon, "box");
    // An image of the extension as its icon (VS Code's container icons, D260), once it's read.
    const iconImage = signal<string | null>(null);
    if (view.iconPath)
      void this.deps.image(view.iconPath).then((url) => {
        if (!store.isDisposed) iconImage.value = url;
      });
    const create = (): {
      element: HTMLElement;
      focus?(): void;
      onWindowChanged?(win: Window): void;
      dispose(): void;
    } => {
      if (this.deps.manifest.main) void this.deps.worker().catch(() => {});
      if (view.type === "webview") {
        const frame = new WebviewFrame(
          this.deps.services,
          {
            path: view.codePage ? this.codePages.path(view.id) : (view.path ?? "index.html"),
            origin: () => this.deps.origin(),
            receive: (message) =>
              void this.deps.worker().then((w) => w.notify("webview", view.id, message)),
          },
          title,
        );
        this.add(this.webviews, view.id, frame);
        // VS Code's WebviewView.visible (runtimeViews.ts).
        const shown = this.deps.hooks.views.track(view.id, frame.element);
        return {
          element: frame.element,
          onWindowChanged: (win) => frame.onWindowChanged(win),
          dispose: () => {
            shown.dispose();
            this.remove(this.webviews, view.id, frame);
            frame.dispose();
          },
        };
      }
      const tree = new ExtensionTreeView(
        {
          ready: () => this.treeProviders.has(view.id),
          children: async (parent?: TreeItem) => {
            if (!this.deps.manifest.main) return [];
            const worker = await this.deps.worker();
            if (!this.treeProviders.has(view.id)) return [];
            const items = await worker.call<TreeItem[]>("tree", view.id, { parent });
            return Array.isArray(items) ? items.slice(0, 5000) : [];
          },
          run: (command) =>
            void this.deps.services.dispatcher
              .execute(command.id, command.input ?? {}, this.deps.caller)
              .catch((err: unknown) =>
                this.deps.services.notifications.show(
                  "error",
                  err instanceof Error ? err.message : String(err),
                ),
              ),
          ...this.deps.hooks.treeSource(view.id),
          // A row's image of the extension (D258), the dark one with a dark theme.
          image: (item) => {
            const dark = this.deps.services.theme.theme.peek() === "dark";
            const path =
              (dark ? item.iconPathDark : item.iconPath) ?? item.iconPath ?? item.iconPathDark;
            return path ? this.deps.image(path) : Promise.resolve(null);
          },
          // `menus["view/item/context"]` (VS Code's): `when` sees `view` and `viewItem`.
          menu: (item) => {
            const menu = treeItemMenu(
              this.deps.manifest.contributes.menus,
              view.id,
              item,
              (k) => this.deps.services.context.get(k),
              (command) =>
                this.deps.manifest.contributes.commands.find((c) => c.id === command)?.title ??
                command,
            );
            const input = treeMenuInput(view.id, item);
            const entry = (e: (typeof menu.inline)[number]) => ({
              title: e.title,
              ...(e.icon && { icon: e.icon }),
              command: { id: e.command, input },
            });
            return { inline: menu.inline.map(entry), groups: menu.groups.map((g) => g.map(entry)) };
          },
        },
        title,
      );
      const message = this.treeMessages.get(view.id);
      if (message) tree.setMessage(message);
      this.add(this.trees, view.id, tree);
      // VS Code's TreeView.visible (runtimeViews.ts).
      const shown = this.deps.hooks.views.track(view.id, tree.element);
      return {
        element: tree.element,
        focus: () => tree.focus(),
        dispose: () => {
          shown.dispose();
          this.remove(this.trees, view.id, tree);
          tree.dispose();
        },
      };
    };

    // Buttons on the view's title (`menus` "view/title", when e.g. "view == acme.todo.list").
    const titleActions = this.deps.manifest.contributes.menus
      .filter((m) => m.location === "view/title")
      .filter((m) => {
        try {
          return matchesWhen(m.when, (k) =>
            k === "view" ? view.id : this.deps.services.context.get(k),
          );
        } catch {
          return false;
        }
      })
      .slice(0, 5)
      .map((m) => ({
        command: m.command,
        icon: safeIcon(m.icon, "circle-dot"),
        title:
          m.title ??
          this.deps.manifest.contributes.commands.find((c) => c.id === m.command)?.title ??
          m.command,
      }));
    if (view.location === "sidebar") {
      store.add(
        this.deps.services.views.register({
          id: view.id,
          title,
          icon: viewIcon,
          ...(view.iconPath && { iconImage: () => iconImage.value }),
          ...(titleActions.length && { actions: titleActions }),
          // A section of Source control or the Explorer while off the activity bar (D208).
          ...(view.sectionOf && { sectionOf: view.sectionOf }),
          ...(view.sectionOf && view.sectionOnly && { sectionOnly: true }),
          ...(view.sectionOrder !== undefined && { sectionOrder: view.sectionOrder }),
          menu: () => {
            const id = this.deps.manifest.id;
            return [
              { label: "Extension details", command: "extensions.showDetails", input: { id } },
              {
                label: `Disable ${this.deps.manifest.displayName}`,
                command: "extensions.disable",
                input: { id },
              },
              {
                label: `Uninstall ${this.deps.manifest.displayName}…`,
                command: "extensions.uninstall",
                input: { id },
                danger: true,
              },
            ];
          },
          create: (host) => {
            const inst = create();
            host.append(inst.element);
            return inst;
          },
        }),
      );
      return;
    }
    const type = `ext:${view.id}`;
    store.add(
      this.deps.services.dock.views.register({
        type,
        title: () => title,
        icon: () => viewIcon,
        // Its own image as the tab's icon too (D260).
        ...(view.iconPath && {
          iconElement: () => (iconImage.value ? imageIcon(iconImage.value) : undefined),
        }),
        singleton: true,
        // VS Code's secondary side bar is the dock's right side, beside the agent (D260).
        defaultPlacement:
          view.location === "editor" ? "main" : view.location === "secondary" ? "right" : "bottom",
        // Its own window too (D176): the page reloads there and messages follow it.
        detachable: true,
        actions: () => titleActions,
        create: (): DockView => {
          const inst = create();
          // A title its code set (VS Code's TreeView.title) on the tab too.
          const titleChanged = new Emitter<void>();
          const watching = effect(() => {
            this.deps.services.views.titles.all.value.get(view.id);
            titleChanged.fire();
            return undefined;
          });
          return {
            element: inst.element,
            title: () => this.deps.services.views.titles.all.peek().get(view.id)?.title ?? title,
            onDidChange: titleChanged.event,
            focus: () => inst.focus?.(),
            onWindowChanged: (win) => inst.onWindowChanged?.(win),
            serialize: () => null,
            // Extensions start after the layout is restored: their tabs don't come back.
            persist: () => false,
            dispose: () => {
              watching.dispose();
              titleChanged.dispose();
              inst.dispose();
            },
          };
        },
      }),
    );
    // Its tabs close with it, before the view type goes (disposal runs in reverse; D176: a page
    // left open could restart a stopped extension).
    store.add(closeTabsOf(this.deps.services, type));
    const show = `${view.id}.show`;
    if (/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(show))
      store.add(
        this.deps.services.dispatcher.register({
          id: show,
          title: `Show ${title}`,
          category: this.deps.manifest.displayName,
          description: `Opens the ${title} panel of the ${this.deps.manifest.displayName} extension.`,
          input: s.empty(),
          effects: [],
          run: async () => {
            await this.revealView(view.id);
          },
        }),
      );
  }

  /** Opens one of its views; resolves with the tab's id for a dock tab (panel, editor). */
  async revealView(viewId: string, background = false): Promise<string | null> {
    const declared = this.deps.manifest.contributes.views.find((v) => v.id === viewId);
    if (!declared) throw new Error(`${viewId} isn't one of the extension's views.`);
    // Where it is: another extension's container moves it (a panel tab, not a side bar view).
    const view = this.inContainer(declared);
    if (view.location === "sidebar") {
      // In the background, a side bar view is its activity bar icon: nothing more to open.
      if (!background) await this.deps.services.dispatcher.execute("view.show", { id: viewId });
      return null;
    }
    this.deps.services.dock.openView(`ext:${viewId}`, null, undefined, !background, { background });
    return this.deps.services.dock.tabs(`ext:${viewId}`)[0]?.id ?? null;
  }

  /** Its file viewers (custom editors): pages that open files, beside the text editor (D176). */
  registerViewers(): Disposable {
    const { manifest } = this.deps;
    return registerViewers(this.deps.services, manifest, {
      origin: () => this.deps.origin(),
      granted: () => this.deps.granted(),
      workspacePath: (path) => this.deps.workspacePath(path),
      blankPage: () => this.codePages.path(""),
      opened: (viewerId, frame) => {
        if (manifest.main) void this.deps.worker().catch(() => {});
        this.add(this.webviews, viewerId, frame);
        const instance = ++this.viewerTabSeq;
        this.viewerTabs.set(instance, frame);
        return {
          instance,
          dispose: () => {
            this.remove(this.webviews, viewerId, frame);
            this.viewerTabs.delete(instance);
            this.codePages.drop(`viewer#${instance}`);
          },
        };
      },
      receive: (viewerId, message) => {
        // A closing tab's notice doesn't start a worker that has stopped (or never ran);
        // an opening one does, like the page's own messages.
        const notice =
          typeof message === "object" && message !== null
            ? (message as { ide?: unknown }).ide
            : undefined;
        if (notice === "viewerClosed") {
          if (!this.deps.store.isDisposed)
            this.deps.running()?.notify("webview", viewerId, message);
          return;
        }
        void this.deps.worker().then((w) => w.notify("webview", viewerId, message));
      },
    });
  }

  /** Pages its code wrote for its views, and what each open frame shows (D260, its live state). */
  codePageReport(): { id: string; page: string; frames: { path: string; loaded: boolean }[] }[] {
    return this.deps.manifest.contributes.views
      .filter((v) => v.codePage)
      .map((v) => ({
        id: v.id,
        page: this.codePages.path(v.id),
        frames: (this.webviews.get(v.id) ?? []).map((f) => f.shown),
      }));
  }

  private add<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key) ?? [];
    list.push(value);
    map.set(key, list);
  }

  private remove<T>(map: Map<string, T[]>, key: string, value: T): void {
    const list = map.get(key)?.filter((v) => v !== value) ?? [];
    if (list.length) map.set(key, list);
    else map.delete(key);
  }

  ownView(viewId: unknown, type?: "tree" | "webview"): string {
    // A file viewer is a webview too (messages both ways).
    if (type === "webview" && this.deps.manifest.contributes.viewers.some((v) => v.id === viewId))
      return String(viewId);
    const view = this.deps.manifest.contributes.views.find((v) => v.id === viewId);
    if (!view || (type && view.type !== type))
      throw new Error(`${String(viewId)} isn't one of the extension's ${type ?? ""} views.`);
    return view.id;
  }

  /** One of the requests above, or UNHANDLED. */
  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    return REQUESTS.has(method) ? this.answer(method, p) : UNHANDLED;
  }

  private async answer(method: string, p: Record<string, unknown>): Promise<unknown> {
    const { services } = this.deps;
    switch (method) {
      case "tree.register":
        this.treeProviders.add(this.ownView(p.viewId, "tree"));
        this.deps.hooks.treeRegistered(String(p.viewId), p);
        for (const t of this.trees.get(String(p.viewId)) ?? []) void t.refresh();
        return undefined;
      case "tree.refresh":
        for (const t of this.trees.get(this.ownView(p.viewId, "tree")) ?? []) void t.refresh();
        return undefined;
      case "tree.reveal": {
        // VS Code's TreeView.reveal (D258): the view shows, then the row.
        const viewId = this.ownView(p.viewId, "tree");
        const path = Array.isArray(p.path) ? p.path.map(String).slice(0, 50) : [];
        await this.revealView(viewId).catch(() => null);
        // A section that was collapsed makes its tree when it opens: wait a moment for it.
        for (let i = 0; i < 20 && !this.trees.get(viewId)?.length; i++)
          await new Promise((r) => setTimeout(r, 50));
        const options = {
          select: p.select !== false,
          focus: p.focus === true,
          expand: p.expand === true,
        };
        for (const t of this.trees.get(viewId) ?? []) await t.reveal(path, options);
        return undefined;
      }
      case "tree.message": {
        // A line above the rows (VS Code's TreeView.message, D208); empty removes it.
        const viewId = this.ownView(p.viewId, "tree");
        const text = typeof p.message === "string" ? p.message.slice(0, 500) : "";
        this.treeMessages.set(viewId, text);
        for (const t of this.trees.get(viewId) ?? []) t.setMessage(text);
        return undefined;
      }
      case "view.title": {
        // A title and description its code set (VS Code's TreeView / WebviewView title and
        // description): shown in the view's header in place of its manifest title.
        const viewId = this.ownView(p.viewId);
        const text = (v: unknown) => (typeof v === "string" ? v : undefined);
        this.deps.services.views.titles.set(viewId, {
          title: text(p.title),
          description: text(p.description),
        });
        if (!this.viewTitles.has(viewId)) {
          this.viewTitles.add(viewId);
          // Back to its own when the extension goes.
          this.deps.store.add(toDisposable(() => this.deps.services.views.titles.set(viewId, {})));
        }
        return undefined;
      }
      case "webview.post": {
        const viewId = this.ownView(p.viewId, "webview");
        // After a page still being served (D261: `html = …; postMessage(…)` reaches the new page).
        await this.codePages.settled(
          typeof p.instance === "number" ? `viewer#${p.instance}` : viewId,
        );
        // One tab of a code-page viewer (D257), or every page of the view.
        const tab = typeof p.instance === "number" ? this.viewerTabs.get(p.instance) : undefined;
        for (const w of tab ? [tab] : (this.webviews.get(viewId) ?? [])) w.post(p.message);
        return undefined;
      }
      case "webview.setDirty":
        // A code-page viewer tab's unsaved state (D258).
        this.ownView(p.viewId, "webview");
        if (typeof p.instance === "number" && this.viewerTabs.has(p.instance))
          setViewerDirty(p.instance, p.dirty === true);
        return undefined;
      case "webview.setHtml": {
        // A webview view's or a viewer tab's page, written by its code (D257).
        const viewId = this.ownView(p.viewId, "webview");
        if (typeof p.html !== "string") throw new Error("setHtml needs the page's HTML.");
        if (typeof p.instance === "number") {
          const tab = this.viewerTabs.get(p.instance);
          if (!tab) return undefined;
          return this.codePages.set(
            `viewer#${p.instance}`,
            withPageSetup(p.html, services, `viewer:${this.pageStamp}#${p.instance}`),
            () => (this.viewerTabs.has(Number(p.instance)) ? [tab] : []),
          );
        }
        return this.codePages.set(
          viewId,
          withPageSetup(
            p.html,
            services,
            `view:${viewId}`,
            this.viewLocation(viewId) === "sidebar",
          ),
          () => this.webviews.get(viewId) ?? [],
        );
      }
      case "webview.reveal":
        return this.revealView(this.ownView(p.viewId), p.background === true).then(() => undefined);
      default:
        throw new Error(`Unknown request ${method}.`);
    }
  }

  /** Its code stopped: titles its code set go with it (the manifest's show again). */
  workerGone(): void {
    for (const viewId of this.viewTitles) this.deps.services.views.titles.set(viewId, {});
  }

  dispose(): void {
    this.codePages.dispose();
  }
}
