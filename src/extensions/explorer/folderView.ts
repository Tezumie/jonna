// A folder dragged from the explorer onto the dock opens as a small folder browser (D190): an
// "up a level" row, then the folder's entries. Clicking a folder goes into it, clicking a file
// opens the file in this group and closes the browser. `editor.openPaths` is what the drop runs.
import { h, on, replaceChildren } from "../../core/dom/index";
import { fsIpc } from "../../core/ipc/fs";
import { DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, isWithin, pathKey } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { fileIcon, folderIcon, icon } from "../../ui/Icon";
import type { DockView, DockViewContext, DockViewDescriptor } from "../../workbench/dock/views";
import { stateField } from "../../workbench/dock/views";
import type { WorkbenchServices } from "../../workbench/services";

const pathOf = (state: unknown): string => {
  const p = stateField(state as never, "path");
  return typeof p === "string" ? p : "";
};

export function registerFolderView(sub: DisposableStore, services: WorkbenchServices): void {
  const { dock, dispatcher } = services;
  const descriptor: DockViewDescriptor = {
    type: "folder",
    title: (state) => basename(pathOf(state)) || "Folder",
    icon: (state) => folderIcon(basename(pathOf(state)), true),
    tooltip: (state) => pathOf(state),
    resource: (state) => pathOf(state) || undefined,
    defaultPlacement: "main",
    editorLike: true,
    detachable: true,
    create: (state, ctx) => new FolderView(services, pathOf(state), ctx),
  };
  sub.add(dock.views.register(descriptor));

  sub.add(
    dispatcher.register({
      id: "editor.openPaths",
      title: "Open files and folders",
      category: "File",
      description:
        "Opens several files at once in one group (what dropping explorer rows on the dock does); a folder opens as a folder browser tab. `placement` is where the first one goes; the rest join its group.",
      input: s.object({
        paths: s.array(s.string()).describe("Absolute paths, or relative to the workspace root"),
        placement: s
          .unknown()
          .describe('A region ("main") or a tab target, as for layout.openView')
          .optional(),
      }),
      effects: ["read"],
      agent: "hidden",
      palette: false,
      when: "workspaceOpen",
      run: async ({ paths, placement }, ctx) => {
        const abs = paths.map((p) => services.workspace.resolve(p));
        let groupId: string | null = null;
        const opened: string[] = [];
        for (const [i, path] of abs.entries()) {
          const stat = await fsIpc.stat(path).catch(() => null);
          if (!stat) continue;
          const where = groupId ? { groupId } : (placement ?? "main");
          const res = (await ctx.execute("layout.openView", {
            viewType: stat.kind === "dir" ? "folder" : "editor",
            state: { path },
            placement: where,
            // The first one gets the focus; the others open behind it.
            focus: i === 0,
          })) as { tabId: string; groupId: string | null };
          groupId ??= res.groupId;
          opened.push(res.tabId);
        }
        if (opened[0]) dock.activateTab(opened[0], true);
        return { opened: opened.length, groupId };
      },
    }),
  );
}

class FolderView implements DockView {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly list: HTMLElement;
  private readonly crumb: HTMLElement;
  private rows: HTMLElement[] = [];
  private active = 0;
  private loading = 0;

  constructor(
    private readonly services: WorkbenchServices,
    private path: string,
    private readonly ctx: DockViewContext,
  ) {
    this.crumb = h("div", { class: "folder-view-path" });
    this.list = h("div", { class: "folder-view-list", role: "listbox", tabindex: "0" });
    this.element = h(
      "div",
      { class: "folder-view", tabindex: "-1" },
      h("div", { class: "folder-view-header" }, this.crumb),
      this.list,
    );
    this.store.add(on(this.list, "click", (e) => this.activate(e)));
    this.store.add(on(this.list, "keydown", (e) => this.onKey(e)));
    const { events } = services;
    const mine = (p: string) => pathKey(dirname(p)) === pathKey(this.path);
    for (const name of ["files.didCreate", "files.didDelete"] as const)
      this.store.add(events.on(name, (e) => mine(e.path) && void this.load()));
    this.store.add(
      events.on("files.didRename", (e) => {
        if (pathKey(e.from) === pathKey(this.path)) this.go(e.to);
        else if (mine(e.from) || mine(e.to)) void this.load();
      }),
    );
    void this.load();
  }

  /** The workspace folder this folder is in (D251: any of a multi-root workspace's). */
  private get root(): string | null {
    return this.services.workspace.folderOf(this.path)?.path ?? this.services.workspace.root.peek();
  }

  /** Up a level is offered inside the open folder only (the file scope, D189). */
  private get parent(): string | null {
    const root = this.root;
    const up = dirname(this.path);
    if (!root || pathKey(this.path) === pathKey(root) || !isWithin(root, up)) return null;
    return up;
  }

  private go(path: string): void {
    this.path = path;
    this.ctx.updateState({ path });
    this.active = 0;
    void this.load();
  }

  private async load(): Promise<void> {
    const token = ++this.loading;
    const root = this.root;
    const rel =
      root && isWithin(root, this.path) ? this.services.workspace.relative(this.path) : this.path;
    this.crumb.textContent = rel ? rel.replaceAll("\\", "/") : basename(this.path);
    let entries: Awaited<ReturnType<typeof fsIpc.listDir>>;
    try {
      entries = await fsIpc.listDir(this.path);
    } catch (err) {
      if (token !== this.loading) return;
      replaceChildren(
        this.list,
        h(
          "div",
          { class: "folder-view-empty" },
          `Can't read this folder: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      this.rows = [];
      return;
    }
    if (token !== this.loading) return;
    entries.sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
        : a.kind === "dir"
          ? -1
          : 1,
    );
    const row = (path: string, kind: "file" | "dir" | "up", label: string, dim = false) =>
      h(
        "div",
        {
          class: `folder-view-row${dim ? " is-ignored" : ""}`,
          role: "option",
          "data-path": path,
          "data-kind": kind,
        },
        icon(
          kind === "up" ? "arrow-up" : kind === "dir" ? folderIcon(label, false) : fileIcon(label),
        ),
        h("span", { class: "folder-view-name" }, label),
      );
    const up = this.parent;
    this.rows = [
      ...(up ? [row(up, "up", "..")] : []),
      ...entries.map((e) => row(e.path, e.kind, e.name, e.ignored)),
    ];
    if (up) this.rows[0]?.setAttribute("title", "Up a level");
    replaceChildren(
      this.list,
      ...(this.rows.length
        ? this.rows
        : [h("div", { class: "folder-view-empty" }, "This folder is empty.")]),
    );
    this.highlight(Math.min(this.active, Math.max(0, this.rows.length - 1)));
  }

  private highlight(i: number): void {
    this.rows[this.active]?.classList.remove("is-active");
    this.active = i;
    const r = this.rows[i];
    r?.classList.add("is-active");
    r?.scrollIntoView({ block: "nearest" });
  }

  private activate(e: MouseEvent): void {
    const r = (e.target as Element).closest<HTMLElement>(".folder-view-row");
    if (r) this.open(r);
  }

  private open(r: HTMLElement): void {
    const path = r.dataset.path ?? "";
    if (r.dataset.kind !== "file") {
      this.go(path);
      return;
    }
    // The file takes this tab's place: opened in this group, then the browser closes.
    void this.services.dispatcher
      .execute("editor.openFile", { path })
      .then(() => this.ctx.close())
      .catch((err: unknown) =>
        this.services.notifications.show("error", err instanceof Error ? err.message : String(err)),
      );
  }

  private onKey(e: KeyboardEvent): void {
    const last = this.rows.length - 1;
    if (e.key === "ArrowDown") this.highlight(Math.min(last, this.active + 1));
    else if (e.key === "ArrowUp") this.highlight(Math.max(0, this.active - 1));
    else if (e.key === "Home") this.highlight(0);
    else if (e.key === "End") this.highlight(Math.max(0, last));
    else if (e.key === "Enter" && this.rows[this.active])
      this.open(this.rows[this.active] as HTMLElement);
    else if (e.key === "Backspace" && this.parent) this.go(this.parent);
    else return;
    e.preventDefault();
  }

  focus(): void {
    this.list.focus();
  }

  onShow(): void {
    void this.load();
  }

  serialize() {
    return { path: this.path };
  }

  title(): string {
    return basename(this.path) || "Folder";
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}
