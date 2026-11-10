// A notebook's breadcrumbs (D229, VS Code's notebook breadcrumbs): the file's folders and the
// file, then the selected cell's place in the notebook's outline (the headings above it, and the
// code cell). The editor's breadcrumbs (chrome.ts) with the outline as its symbols, a cell as its
// line; `breadcrumbs.enabled` shows them, as for text files.
import { fsIpc } from "../../../core/ipc/fs";
import { type Disposable, DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import type { WorkbenchServices } from "../../../workbench/services";
import { Breadcrumbs } from "../chrome";
import type { OutlineSymbol } from "../engine";

/** What the breadcrumbs need from the notebook view. */
export interface CrumbsHost {
  readonly path: string;
  /** The selected cell (0-based). */
  readonly selected: number;
  outline(): OutlineSymbol[];
  select(i: number): void;
  readonly onDidChange: (listener: () => void) => Disposable;
}

export class NotebookBreadcrumbs implements Disposable {
  private readonly store = new DisposableStore();
  private readonly crumbs: Breadcrumbs;

  constructor(host: CrumbsHost, services: WorkbenchServices) {
    const { settings, dispatcher, workspace } = services;
    this.crumbs = this.store.add(
      new Breadcrumbs(
        {
          root: (path) => workspace.folderOf(path)?.path ?? workspace.root.peek(),
          folderName: (path) =>
            workspace.folders.peek().length > 1 ? (workspace.folderOf(path)?.name ?? null) : null,
          listDir: (path) => fsIpc.listDir(path),
          diagnostics: () => [],
          showBreadcrumbs: () => settings.get<boolean>("breadcrumbs.enabled") !== false,
          showFileStatus: () => false,
          symbols: () => Promise.resolve([]),
          run: (command, input = {}) => void dispatcher.execute(command, input).catch(() => {}),
        },
        {
          path: () => host.path,
          editor: () => undefined,
          model: () => null,
          // An outline entry's line is its cell's position, from 1.
          reveal: (line) => host.select(line - 1),
          relayout: () => {},
          symbols: () => host.outline(),
          line: () => host.selected + 1,
        },
      ),
    );
    this.crumbs.element.classList.add("nb-breadcrumbs");
    this.store.add(
      effect(() => {
        settings.version.value;
        const show = settings.peek<boolean>("breadcrumbs.enabled") !== false;
        this.crumbs.element.hidden = !show;
        if (show) this.crumbs.textChanged();
        return undefined;
      }),
    );
    // Cells edited, added, moved or selected: the outline is read again (debounced).
    this.store.add(
      host.onDidChange(() => {
        this.crumbs.render();
        this.crumbs.textChanged();
      }),
    );
  }

  get element(): HTMLElement {
    return this.crumbs.element;
  }

  dispose(): void {
    this.store.dispose();
  }
}
