// Editor chrome around one editor tab, like VS Code's breadcrumbs and a per-file status bar:
//  - Breadcrumbs (setting `breadcrumbs.enabled`): the file's folders, the file, then the symbols
//    around the cursor (class › method…). Each segment opens a searchable menu of its siblings —
//    a folder's entries (folders navigate in place), the file's neighbours, sibling symbols.
//  - File status bar (setting `editor.fileStatusBar.enabled`): this file's errors and warnings
//    (click: the file's problems list above the bar), Diff (open changes), Ln/Col, language.
// Both are owned by the EditorView (view.ts) and read everything through ChromeHost.

import { h } from "../../core/dom/index";
import type { DirEntry } from "../../core/ipc/fs";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { basename, dirname, relativePath, samePath } from "../../core/paths/index";
import { effect, signal } from "../../core/reactive/index";
import { fileIcon, type IconName, icon } from "../../ui/Icon";
import { type MenuItem, showContextMenu, showMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import { uriScheme } from "../../workbench/extensionRegistries";
import { encodingInfo } from "./encodings";
import type { Diagnostic, EngineDocument, EngineEditor, OutlineSymbol } from "./engine";
import { problemMenu, targetOf } from "./problemActions";
import { languageLabel } from "./state";
import { isUntitled, untitledName } from "./untitled";

export interface ChromeHost {
  /**
   * The workspace folder holding `path` (breadcrumbs start below it): its own folder in a
   * multi-root workspace (D251), else the root; null with nothing open.
   */
  root(path: string): string | null;
  /** The folder's name shown first in a multi-root workspace (VS Code does); null with one folder. */
  folderName?(path: string): string | null;
  listDir(path: string): Promise<DirEntry[]>;
  /** Every diagnostic (reactive read). */
  diagnostics(): readonly Diagnostic[];
  /** Settings (reactive reads). */
  showBreadcrumbs(): boolean;
  showFileStatus(): boolean;
  symbols(doc: EngineDocument): Promise<OutlineSymbol[]>;
  run(command: string, input?: unknown): void;
}

/** What the chrome needs from its view. */
export interface ChromeSubject {
  path(): string;
  /** The document's encoding id (encodings.ts; D199). */
  encoding?(): string;
  editor(): EngineEditor | undefined;
  model(): EngineDocument | null;
  reveal(line: number, column: number): void;
  /** Relayout after the chrome's height changed. */
  relayout(): void;
  /** Its own symbols instead of the document's (a notebook's outline, D229). */
  symbols?(): OutlineSymbol[];
  /** The line the symbol chain follows (default: the editor's cursor; a notebook's cell). */
  line?(): number;
}

const SYMBOL_ICONS = new Map<string, IconName>([
  ["class", "box"],
  ["struct", "box"],
  ["interface", "box"],
  ["enum", "box"],
  ["module", "braces"],
  ["namespace", "braces"],
  ["package", "braces"],
  ["object", "braces"],
  ["key", "braces"],
  ["function", "square-function"],
  ["method", "square-function"],
  ["constructor", "square-function"],
  ["event", "square-function"],
  ["operator", "square-function"],
  ["string", "hash"],
  // A notebook's code cell in its outline (D204).
  ["cell", "code"],
]);
export const symbolIcon = (kind: string): IconName => SYMBOL_ICONS.get(kind) ?? "variable";

/** The chain of symbols containing `line` (outermost first). */
export function symbolPath(symbols: readonly OutlineSymbol[], line: number): OutlineSymbol[] {
  const path: OutlineSymbol[] = [];
  let level = symbols;
  for (;;) {
    const hit = level.find((s) => s.line <= line && line <= s.endLine);
    if (!hit) return path;
    path.push(hit);
    level = hit.children;
  }
}

const SYMBOL_DEBOUNCE_MS = 350;

export class Breadcrumbs implements Disposable {
  readonly element = h("nav", { class: "breadcrumbs", "aria-label": "Breadcrumbs" });
  private readonly store = new DisposableStore();
  private symbols: OutlineSymbol[] = [];
  private symbolTimer = 0;
  private menu: Disposable | undefined;
  private key = "";

  constructor(
    private readonly host: ChromeHost,
    private readonly subject: ChromeSubject,
  ) {
    this.store.add({
      dispose: () => {
        clearTimeout(this.symbolTimer);
        this.menu?.dispose();
      },
    });
  }

  /** The text changed (or the model appeared): re-reads symbols after a pause. */
  textChanged(): void {
    clearTimeout(this.symbolTimer);
    this.symbolTimer = window.setTimeout(() => void this.loadSymbols(), SYMBOL_DEBOUNCE_MS);
  }

  private async loadSymbols(attempt = 0): Promise<void> {
    if (this.subject.symbols) {
      if (this.element.hidden) return;
      this.symbols = this.subject.symbols();
      this.render();
      return;
    }
    const model = this.subject.model();
    if (!model || this.element.hidden) return;
    const symbols = await this.host.symbols(model).catch(() => []);
    if (this.store.isDisposed || this.subject.model() !== model) return;
    this.symbols = symbols;
    this.render();
    // A language service still starting (TypeScript's worker, a language server) answers with
    // nothing at first: try again a few times before settling on "no symbols" (D116).
    if (!symbols.length && attempt < 5)
      this.symbolTimer = window.setTimeout(
        () => void this.loadSymbols(attempt + 1),
        800 * (attempt + 1),
      );
  }

  /** Re-renders when the path or the symbol chain at the cursor changed. */
  render(): void {
    if (this.element.hidden) return;
    const path = this.subject.path();
    const line = this.subject.line?.() ?? this.subject.editor()?.activeState()?.cursor.line ?? 1;
    const chain = symbolPath(this.symbols, line);
    const root = this.host.root(path);
    const folderName = root ? (this.host.folderName?.(path) ?? null) : null;
    const key = `${folderName ?? ""}\n${path}\n${chain.map((s) => `${s.name}:${s.line}`).join("/")}`;
    if (key === this.key) return;
    this.key = key;
    const rel = isUntitled(path)
      ? untitledName(path)
      : root && !path.startsWith("virtual:") && !uriScheme(path)
        ? relativePath(root, path)
        : basename(path);
    const parts = rel.replaceAll("\\", "/").split("/").filter(Boolean);
    const segments: HTMLElement[] = [];
    let dir = root ?? dirname(path);
    // Several folders: the file's folder first, its menu that folder's top (VS Code does).
    if (folderName && root && parts.length && !parts[0]?.startsWith("..")) {
      const top = root;
      segments.push(
        this.segment(folderName, undefined, (el) => this.folderMenu(el, top, undefined, top)),
      );
    }
    parts.slice(0, -1).forEach((name) => {
      dir = `${dir}${dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"}${name}`;
      const folder = dir;
      segments.push(this.segment(name, undefined, (el) => this.folderMenu(el, folder)));
    });
    const file = parts[parts.length - 1] ?? basename(path);
    segments.push(
      this.segment(file, fileIcon(file), (el) => this.folderMenu(el, dirname(path), path)),
    );
    chain.forEach((sym, i) => {
      const siblings = i === 0 ? this.symbols : (chain[i - 1]?.children ?? []);
      segments.push(
        this.segment(sym.name, symbolIcon(sym.kind), (el) => this.symbolMenu(el, siblings, sym)),
      );
    });
    this.element.replaceChildren(
      ...segments.flatMap((s, i) =>
        i === 0 ? [s] : [h("span", { class: "breadcrumbs-sep" }, icon("chevron-right")), s],
      ),
    );
    // Keep the innermost segment in view on narrow editors.
    this.element.scrollLeft = this.element.scrollWidth;
  }

  private segment(
    label: string,
    glyph: IconName | undefined,
    open: (el: HTMLElement) => void,
  ): HTMLElement {
    const b = h(
      "button",
      { class: "breadcrumbs-item", type: "button" },
      glyph ? icon(glyph) : null,
      h("span", null, label),
    );
    b.addEventListener("click", () => open(b));
    return b;
  }

  private showMenuAt(anchor: HTMLElement, items: MenuItem[], label: string): void {
    this.menu?.dispose();
    anchor.classList.add("is-open");
    this.menu = showMenu(anchor, items, {
      label,
      search: items.length > 8,
      onClose: () => anchor.classList.remove("is-open"),
    });
  }

  private async folderMenu(
    anchor: HTMLElement,
    folder: string,
    current?: string,
    top: string | null = this.host.root(current ?? folder),
  ): Promise<void> {
    const entries = await this.host.listDir(folder).catch(() => [] as DirEntry[]);
    const sorted = [...entries]
      .filter((e) => e.name !== ".git")
      .sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
      );
    const items: MenuItem[] = sorted.map((e) =>
      e.kind === "dir"
        ? {
            label: e.name,
            icon: "folder",
            // Folders navigate in place (the menu shows that folder next).
            run: () => queueMicrotask(() => void this.folderMenu(anchor, e.path, undefined, top)),
          }
        : {
            label: e.name,
            icon: fileIcon(e.name),
            checked: current === e.path,
            run: () => this.host.run("editor.openFile", { path: e.path }),
          },
    );
    if (top && folder !== top && folder.length > top.length)
      items.unshift({
        label: "..",
        icon: "folder-open",
        run: () =>
          queueMicrotask(() => void this.folderMenu(anchor, dirname(folder), undefined, top)),
      });
    if (!items.length) items.push({ label: "Empty folder", disabled: true });
    this.showMenuAt(anchor, items, basename(folder));
  }

  private symbolMenu(
    anchor: HTMLElement,
    siblings: readonly OutlineSymbol[],
    current: OutlineSymbol,
  ): void {
    const items: MenuItem[] = siblings.map((s) => ({
      label: s.name,
      icon: symbolIcon(s.kind),
      checked: s === current,
      keybinding: `Ln ${s.line}`,
      run: () => this.subject.reveal(s.line, s.column),
    }));
    this.showMenuAt(anchor, items, "Symbols");
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** The per-file status bar and its problems list. */
export class FileStatusBar implements Disposable {
  readonly element = h("div", { class: "file-status", role: "status" });
  readonly problems = h("div", { class: "file-problems", hidden: true });
  private readonly store = new DisposableStore();
  private readonly cursor = h("button", { class: "file-status-item", type: "button" });
  private readonly language = h("button", { class: "file-status-item", type: "button" });
  private readonly indent = h("button", { class: "file-status-item", type: "button" });
  private readonly encoding = h("button", { class: "file-status-item", type: "button" }, "UTF-8");
  private readonly eol = h("button", { class: "file-status-item", type: "button" });
  private readonly counts = h("button", { class: "file-status-item", type: "button" });
  private readonly open = signal(false);

  constructor(
    private readonly host: ChromeHost,
    private readonly subject: ChromeSubject,
  ) {
    const diff = h(
      "button",
      { class: "file-status-item", type: "button" },
      icon("git-compare"),
      h("span", null, "Diff"),
    );
    setTooltip(diff, "Open changes");
    diff.addEventListener("click", () =>
      host.run("editor.openDiff", { path: this.subject.path() }),
    );
    setTooltip(this.cursor, "Go to line/column");
    this.cursor.addEventListener("click", () => host.run("editor.gotoLine"));
    setTooltip(this.indent, "Select indentation");
    this.indent.addEventListener("click", () => this.indentMenu());
    setTooltip(this.encoding, "Select encoding (reopen or save with another)");
    setTooltip(this.eol, "Select end of line sequence");
    this.encoding.addEventListener("click", () =>
      host.run("editor.selectEncoding", { path: this.subject.path() }),
    );
    this.eol.addEventListener("click", () =>
      host.run("editor.changeEol", { path: this.subject.path() }),
    );
    setTooltip(this.counts, "Problems in this file");
    setTooltip(this.language, "Change language mode");
    this.language.addEventListener("click", () => host.run("editor.setLanguage"));
    this.counts.addEventListener("click", () => (this.open.value = !this.open.peek()));
    this.element.append(
      this.counts,
      h("span", { class: "file-status-spacer" }),
      diff,
      this.cursor,
      this.indent,
      this.encoding,
      this.eol,
      this.language,
    );
    this.store.add(effect(() => this.renderProblems()));
  }

  /** Cursor moved or the model changed. */
  update(): void {
    const state = this.subject.editor()?.activeState();
    this.cursor.textContent = state ? `Ln ${state.cursor.line}, Col ${state.cursor.column}` : "";
    this.cursor.hidden = !state;
    const model = this.subject.model();
    this.language.textContent = model ? languageLabel(model.languageId) : "";
    const indent = model?.indentation();
    this.indent.hidden = !indent;
    this.encoding.hidden = !model;
    this.eol.hidden = !model;
    if (indent)
      this.indent.textContent = indent.insertSpaces
        ? `Spaces: ${indent.tabSize}`
        : `Tab size: ${indent.tabSize}`;
    if (model) this.eol.textContent = model.eol === "\r\n" ? "CRLF" : "LF";
    const enc = this.subject.encoding?.() ?? "utf8";
    this.encoding.textContent = encodingInfo(enc)?.label ?? enc;
  }

  /** VS Code's "Select indentation": spaces or tabs, the size, convert the file. */
  private indentMenu(): void {
    const model = this.subject.model();
    if (!model) return;
    const { insertSpaces, tabSize } = model.indentation();
    const set = (o: { insertSpaces?: boolean; tabSize?: number }) => () => {
      model.setIndentation(o);
      this.update();
    };
    const items: MenuItem[] = [
      { label: "Indent using spaces", checked: insertSpaces, run: set({ insertSpaces: true }) },
      { label: "Indent using tabs", checked: !insertSpaces, run: set({ insertSpaces: false }) },
      ...[2, 4, 8].map((n, i) => ({
        label: `${insertSpaces ? "Indent size" : "Tab size"} ${n}`,
        checked: tabSize === n,
        separatorBefore: i === 0,
        run: set({ tabSize: n }),
      })),
      {
        label: "Convert indentation to spaces",
        separatorBefore: true,
        run: () =>
          this.host.run("editor.runAction", { action: "editor.action.indentationToSpaces" }),
      },
      {
        label: "Convert indentation to tabs",
        run: () => this.host.run("editor.runAction", { action: "editor.action.indentationToTabs" }),
      },
    ];
    this.store.add(showMenu(this.indent, items, "Indentation"));
  }

  private renderProblems(): undefined {
    const open = this.open.value;
    const path = this.subject.path();
    const mine = this.host
      .diagnostics()
      .filter(
        (d) => samePath(d.path, path) && (d.severity === "error" || d.severity === "warning"),
      );
    const errors = mine.filter((d) => d.severity === "error").length;
    const warnings = mine.length - errors;
    this.counts.replaceChildren(
      icon("circle-x"),
      h("span", null, String(errors)),
      icon("triangle-alert"),
      h("span", null, String(warnings)),
    );
    this.counts.classList.toggle("is-active", open);
    this.counts.classList.toggle("has-errors", errors > 0);
    const wasHidden = this.problems.hidden;
    this.problems.hidden = !open;
    if (open) {
      const close = h("button", { class: "icon-button", type: "button" }, icon("x"));
      setTooltip(close, "Close");
      close.addEventListener("click", () => (this.open.value = false));
      const rows = mine.map((d) => {
        const copy = h(
          "button",
          { class: "icon-button file-problem-copy", type: "button" },
          icon("copy"),
        );
        setTooltip(copy, "Copy problem");
        copy.addEventListener("click", (e) => {
          e.stopPropagation();
          this.host.run("problems.copy", targetOf(d));
        });
        const message = h("span", { class: "file-problem-message" }, d.message);
        setTooltip(message, d.message);
        // A div (it holds the copy button): click or Enter goes to the problem.
        const row = h(
          "div",
          { class: `file-problem is-${d.severity}`, role: "button", tabindex: "0" },
          icon(d.severity === "error" ? "circle-x" : "triangle-alert"),
          message,
          h(
            "span",
            { class: "file-problem-where" },
            `${d.source ? `${d.source} · ` : ""}Ln ${d.line}, Col ${d.column}`,
          ),
          copy,
        );
        const goTo = () => this.subject.reveal(d.line, d.column);
        row.addEventListener("click", goTo);
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            goTo();
          } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
            e.preventDefault();
            this.host.run("problems.copy", targetOf(d));
          }
        });
        row.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.store.add(
            showContextMenu(
              e.clientX,
              e.clientY,
              problemMenu(d, (command, input) => this.host.run(command, input), {
                goTo,
                inFileList: true,
              }),
            ),
          );
        });
        return row;
      });
      this.problems.replaceChildren(
        h(
          "div",
          { class: "file-problems-header" },
          h("span", null, "Problems in this file"),
          close,
        ),
        rows.length
          ? h("div", { class: "file-problems-list" }, ...rows)
          : h("div", { class: "file-problems-empty" }, "No problems in this file."),
      );
    }
    if (wasHidden !== this.problems.hidden) queueMicrotask(() => this.subject.relayout());
    return undefined;
  }

  dispose(): void {
    this.store.dispose();
  }
}
