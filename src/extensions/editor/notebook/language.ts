// A notebook to the language servers (D204): while notebook.languageServer.enabled (default on),
// the notebook view is a `NotebookLanguageSource` for the editor engine, which joins its code
// cells into one document per server of their language (monaco/notebookLsp.ts). Opening a
// notebook starts its language's servers like opening a file does (documents.didOpen).
import type { Event } from "../../../core/events/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import type { WorkbenchServices } from "../../../workbench/services";
import type { EngineDocument, NotebookLanguageSource } from "../engine";
import type { EditorService } from "../service";
import type { CellView } from "./cell";

/** What the link needs from the notebook view. */
export interface LanguageHost {
  readonly path: string;
  readonly cells: readonly CellView[];
  readonly onDidChange: Event<void>;
  language(): string;
  revealCell(index: number, at: { line: number; column: number }): void;
}

export class NotebookLanguageLink {
  private readonly store = new DisposableStore();
  private readonly attached = this.store.add(new DisposableStore());
  private announced = "";

  constructor(
    private readonly host: LanguageHost,
    private readonly services: WorkbenchServices,
    editors: EditorService,
  ) {
    const source: NotebookLanguageSource = {
      get path() {
        return host.path;
      },
      languageId: () => host.language(),
      // A code cell in another language than the notebook's (its own, D204) isn't the servers'.
      cells: () =>
        host.cells.map((c) => ({
          id: c.cell.id,
          kind: c.cell.kind === "code" && c.language() !== host.language() ? "raw" : c.cell.kind,
          text: c.cell.source,
        })),
      onDidChange: host.onDidChange,
      documentFor: (cellId): EngineDocument | null => {
        const c = host.cells.find((x) => x.cell.id === cellId);
        if (c?.cell.kind !== "code") return null;
        c.ensureEditor();
        return c.doc;
      },
      reveal: (cellId, line, column) => {
        const i = host.cells.findIndex((x) => x.cell.id === cellId);
        if (i >= 0) host.revealCell(i, { line, column });
      },
    };
    let was: boolean | null = null;
    this.store.add(
      effect(() => {
        this.services.settings.version.value;
        const on =
          this.services.settings.peek<boolean>("notebook.languageServer.enabled") !== false;
        // Only a change of this setting attaches or detaches (not every settings write).
        if (on === was) return undefined;
        was = on;
        this.attached.clear();
        if (on)
          editors.whenEngine((engine) => {
            if (this.store.isDisposed || !engine.attachNotebook) return;
            // whenEngine may run later: the setting may have changed meanwhile.
            if (this.services.settings.peek<boolean>("notebook.languageServer.enabled") === false)
              return;
            this.attached.clear();
            this.attached.add(engine.attachNotebook(source));
            this.announce();
          });
        return undefined;
      }),
    );
    // The kernel's language arrived (or changed): its servers start.
    this.store.add(host.onDidChange(() => this.announce()));
  }

  /** Starts the servers of the notebook's language (once per language). */
  private announce(): void {
    if (this.services.settings.peek<boolean>("notebook.languageServer.enabled") === false) return;
    const languageId = this.host.language();
    if (languageId === this.announced || !this.host.cells.some((c) => c.cell.kind === "code"))
      return;
    this.announced = languageId;
    this.services.events.emit("documents.didOpen", { path: this.host.path, languageId });
  }

  dispose(): void {
    this.store.dispose();
  }
}
