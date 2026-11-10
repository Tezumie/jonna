// The parts of an extension's API added in D176, beside runtime.ts: status bar items, the editor
// (open, read and change text, select, decorate), languages (diagnostics; hover, completion and
// the other providers of runtimeProviders.ts), moving its tabs into windows, and its declarative
// menus, agents, MCP servers and model providers. Every request is checked against the permissions the user granted, as in
// runtime.ts; what it adds is owned by the extension and goes when it stops.
import type { Caller } from "../../core/dispatcher/types";
import { Emitter } from "../../core/events/index";
import { checkProviderQuery } from "../../core/extensions/providerQuery";
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { parseCellPath } from "../../core/notebook/cellUri";
import { isAbsolute, resolveInRoot } from "../../core/paths/index";
import { type Signal, signal } from "../../core/reactive/index";
import {
  cleanContent,
  type DecorationTypeStyle,
  normalizeDecorationType,
} from "../../workbench/extensionDecorationTypes";
import { normalizeDiagnostics } from "../../workbench/extensionDiagnostics";
import {
  type CompletionEntry,
  DECORATION_STYLES,
  type DecorationRange,
  type DecorationStyle,
  type FeatureContext,
  type LanguageFeature,
  toHoverAnswer,
} from "../../workbench/extensionFeatures";
import {
  cellOfPath,
  EDITING_FEATURES,
  normalizeCompletionItem,
  normalizeCompletions,
  PROVIDER_FEATURES,
  type ProviderFeature,
} from "../../workbench/extensionProviders";
import { makeUri, uriScheme } from "../../workbench/extensionRegistries";
import type { ExternalProblem, WorkbenchServices } from "../../workbench/services";
import type { StatusTone } from "../../workbench/statusbar";
import { allLanguageIds } from "../editor/languages";
import { ExtensionProgress } from "./runtimeProgress";
import { providerFeature } from "./runtimeProviders";
import { safeIcon } from "./treeView";
import type { ExtensionWorker } from "./workerHost";

/** Returned for requests this module doesn't handle (runtime.ts goes on). */
export const UNHANDLED = Symbol("unhandled");

/** Where a view opens, for telling apart views with one name. */
const WHERE_LABEL = {
  sidebar: "side bar",
  secondary: "secondary side bar",
  panel: "panel",
  editor: "editor area",
} as const;
const MAX_STATUS_ITEMS = 10;
const MAX_DIAGNOSTICS_PER_FILE = 1000;
/** A language client registers ~30 providers per server (VS Code has no limit). */
const MAX_PROVIDERS = 500;
/**
 * Files with problems (a language server checks the whole workspace, VS Code has no limit: this
 * only bounds a runaway extension), and decoration sets (key × file), per extension.
 */
const MAX_DIAGNOSTIC_FILES = 50_000;
const MAX_DECORATION_SETS = 200;
const MAX_RANGES = 5000;
const MAX_DECORATION_TYPES = 50;
/** Decoration types' class numbers, unique in the window (D234). */
let decorationTypeSeq = 0;

export interface ApiHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  caller: Caller;
  need(permission: string, what: string): void;
  /** A workspace path from the extension (relative or absolute inside the folder). */
  workspacePath(path: unknown): string;
  /** workspacePath, refusing a .git folder (extensions' writes). */
  writablePath(path: unknown): string;
  worker(): Promise<ExtensionWorker>;
  /** Opens one of its dock views (sidebar or tab) and resolves with the tab id, if a tab. */
  revealView(viewId: string): Promise<string | null>;
}

interface StatusData {
  text: string;
  tooltip: string;
  command?: string;
  input?: unknown;
  tone?: StatusTone;
}

const isTone = (v: unknown): v is StatusTone =>
  v === "warning" || v === "error" || v === "warning-text" || v === "error-text";

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined;

export class ExtensionApiHost implements Disposable {
  private readonly store = new DisposableStore();
  private readonly status = new Map<
    string,
    { data: Signal<StatusData>; off: Disposable; placement: string }
  >();
  private readonly diagnostics = new Map<string, ExternalProblem[]>();
  /** Registered providers by id; `refresh` asks the editor again (semantic tokens). */
  private readonly providers = new Map<string, Disposable & { refresh?(): void }>();

  private readonly progress: ExtensionProgress;

  constructor(private readonly deps: ApiHostDeps) {
    this.progress = new ExtensionProgress({
      services: deps.services,
      owner: deps.manifest.id,
      displayName: deps.manifest.displayName,
      worker: () => deps.worker(),
    });
  }

  private get owner(): string {
    return this.deps.manifest.id;
  }

  /** The declarative parts: context menu items, agents, MCP servers, model providers. */
  /** `images`: its menu items' icon files as blob URLs, read before (D262). */
  contribute(images: ReadonlyMap<string, string> = new Map()): void {
    const { manifest, services } = this.deps;
    const f = services.extensionFeatures;
    const c = manifest.contributes;
    const owner = this.owner;
    const titleOf = (command: string) => c.commands.find((x) => x.id === command)?.title ?? command;
    // A tree row's menu belongs to the extension's own tree view (runtime.ts, treeMenus.ts).
    const shared = c.menus.flatMap((m) =>
      m.location === "view/item/context" ? [] : [{ ...m, location: m.location }],
    );
    this.store.add(
      f.addMenus(
        shared.map((m) => ({
          owner,
          location: m.location,
          command: m.command,
          title: m.title ?? titleOf(m.command),
          ...(m.icon && { icon: safeIcon(m.icon, "box") }),
          ...(m.iconPath && images.get(m.iconPath) && { iconImage: images.get(m.iconPath) }),
          ...(m.iconPathDark &&
            images.get(m.iconPathDark) && { iconImageDark: images.get(m.iconPathDark) }),
          ...(m.when && { when: m.when }),
        })),
      ),
    );
    // View → Extensions: its views, then the commands it put in "menubar/view".
    this.store.add(
      f.contribute(
        f.openers,
        c.views.map((v) => ({
          owner,
          extension: manifest.displayName,
          title: v.title,
          // Told apart by where they open when two offered at once share a name (D262).
          where: WHERE_LABEL[v.location],
          icon: safeIcon(v.icon, "box"),
          ...(v.when && { when: v.when }),
          ...(v.location === "sidebar"
            ? { command: "view.show", input: { id: v.id } }
            : { command: `${v.id}.show` }),
        })),
      ),
    );
    this.store.add(
      f.contribute(
        f.agents,
        c.agents.map((a) => ({ owner, ...a })),
      ),
    );
    this.store.add(
      f.contribute(
        f.mcpServers,
        c.mcpServers.map((m) => ({ owner, ...m })),
      ),
    );
    this.store.add(
      f.contribute(
        f.providers,
        c.modelProviders.map((p) => ({ owner, ...p })),
      ),
    );
  }

  /** One of the requests below, or UNHANDLED. */
  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    if (this.progress.handle(method, p)) return Promise.resolve(undefined);
    switch (method) {
      case "statusBar.set":
        return Promise.resolve(this.setStatus(p));
      case "statusBar.remove":
        this.status.get(String(p.id))?.off.dispose();
        this.status.delete(String(p.id));
        return Promise.resolve(undefined);
      case "editor.open":
        return this.editorOpen(p);
      case "editor.text":
        return this.editorText(p);
      case "editor.replace":
        return this.editorReplace(p);
      case "editor.select":
        return this.editorSelect(p);
      case "editor.decorate":
        return this.decorate(p);
      case "editor.createDecorationType":
        return Promise.resolve(this.createDecorationType(p));
      case "editor.setDecorationType":
        return this.setDecorationType(p);
      case "editor.clearDecorationType":
      case "editor.disposeDecorationType": {
        const key = String(p.key ?? "");
        if (method === "editor.disposeDecorationType") this.decorationTypes.delete(key);
        this.deps.services.extensionFeatures.clearDecorations(this.owner, `type:${key}`);
        return Promise.resolve(undefined);
      }
      case "editor.clearDecorations":
        this.deps.services.extensionFeatures.clearDecorations(
          this.owner,
          typeof p.key === "string" ? p.key : undefined,
        );
        return Promise.resolve(undefined);
      case "languages.setDiagnostics":
        return Promise.resolve(this.setDiagnostics(p));
      case "languages.clearDiagnostics":
        if (typeof p.path === "string") this.diagnostics.delete(this.diagnosticTarget(p.path).key);
        else this.diagnostics.clear();
        this.publishDiagnostics();
        return Promise.resolve(undefined);
      case "languages.register":
        return Promise.resolve(this.registerProvider(p));
      case "languages.list":
        // VS Code's languages.getLanguages(): every language the editor knows.
        return Promise.resolve(allLanguageIds());
      case "languages.execute":
        return this.executeProviders(p);
      case "languages.unregister":
        this.providers.get(String(p.id))?.dispose();
        this.providers.delete(String(p.id));
        return Promise.resolve(undefined);
      case "languages.refresh":
        // VS Code's onDidChangeSemanticTokens: the editor asks for the tokens again.
        this.providers.get(String(p.id))?.refresh?.();
        return Promise.resolve(undefined);
      case "webview.openInWindow":
        return this.openInWindow(p);
      default:
        return UNHANDLED;
    }
  }

  // ---- Status bar ----------------------------------------------------------------------------

  private setStatus(p: Record<string, unknown>): void {
    const id = String(p.id ?? "");
    if (!/^[\w.-]{1,40}$/.test(id))
      throw new Error("A status bar item needs an id (letters, digits, . - _).");
    const command = typeof p.command === "string" ? p.command : undefined;
    // A click runs it as the user: only the extension's own commands.
    if (command && !this.deps.manifest.contributes.commands.some((c) => c.id === command))
      throw new Error(`${command} isn't one of the extension's commands.`);
    // Text only (and $(icon) names): no markup; short.
    const clean = (v: unknown, max: number) =>
      String(v ?? "")
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what's removed
        .replace(/[\u0000-\u001f]/g, " ")
        .slice(0, max);
    const data: StatusData = {
      text: clean(p.text, 80),
      tooltip: clean(p.tooltip ?? this.deps.manifest.displayName, 300),
      ...(command && { command }),
      ...(p.input !== undefined && { input: p.input }),
      ...(isTone(p.tone) && { tone: p.tone }),
    };
    const alignment = p.alignment === "left" ? "left" : "right";
    const priority = Math.max(-1000, Math.min(1000, num(p.priority) ?? 0));
    // Text and tooltip change in place; a new command, side or order means a new item.
    const placement = JSON.stringify([command, p.input, alignment, priority, p.name]);
    const existing = this.status.get(id);
    if (existing && existing.placement === placement) {
      existing.data.value = data;
      return;
    }
    if (existing) {
      existing.off.dispose();
      this.status.delete(id);
    }
    if (this.status.size >= MAX_STATUS_ITEMS)
      throw new Error(`An extension can have at most ${MAX_STATUS_ITEMS} status bar items.`);
    const sig = signal(data);
    const off = this.deps.services.statusBar.add({
      id: `ext:${this.owner}:${id}`,
      alignment,
      priority,
      text: () => sig.value.text,
      tooltip: () => sig.value.tooltip,
      tone: () => sig.value.tone,
      // VS Code labels a nameless item by its extension (the status bar's menu, D383).
      name:
        typeof p.name === "string" && p.name ? clean(p.name, 80) : this.deps.manifest.displayName,
      ...(command && { command }),
      ...(p.input !== undefined && { input: p.input }),
    });
    this.status.set(id, { data: sig, off, placement });
  }

  // ---- Editor ------------------------------------------------------------------------------

  private exec(command: string, input: unknown): Promise<unknown> {
    return this.deps.services.dispatcher.execute(command, input, this.deps.caller);
  }

  /**
   * A path the editor calls may take: in the open folder, or a URI of a registered extension's
   * file system (D234; read and written through that extension, with the same permissions).
   */
  private documentPath(path: unknown, writable = false): string {
    const scheme = typeof path === "string" ? uriScheme(path) : null;
    if (scheme && typeof path === "string") {
      if (!this.deps.services.extensionFeatures.fileSystems.owns(path))
        throw new Error(`No extension serves ${scheme}: files.`);
      return makeUri(scheme, path);
    }
    return writable ? this.deps.writablePath(path) : this.deps.workspacePath(path);
  }

  private async editorOpen(p: Record<string, unknown>): Promise<void> {
    this.deps.need("fs.read", "open files");
    const selection =
      p.selection && typeof p.selection === "object"
        ? this.range(p.selection as Record<string, unknown>)
        : null;
    await this.exec("editor.openFile", {
      path: this.documentPath(p.path),
      ...(selection
        ? {
            line: selection.startLine,
            ...(selection.startColumn && { column: selection.startColumn }),
          }
        : {
            ...(num(p.line) && { line: num(p.line) }),
            ...(num(p.column) && { column: num(p.column) }),
          }),
      ...(p.preview === false && { preview: false }),
      ...(p.preserveFocus === true && { preserveFocus: true }),
      ...(p.toSide === true && { toSide: true }),
    });
    // VS Code's `selection` (D255): the range selected once it's open.
    if (selection)
      await this.exec("editor.select", {
        ...selection,
        endLine: selection.endLine ?? selection.startLine,
      });
  }

  private async editorText(p: Record<string, unknown>): Promise<string> {
    this.deps.need("fs.read", "read files");
    // A document open in the editor outside the folder (site-packages, an untitled one): a VS
    // Code package's language providers are asked about it, as in VS Code.
    if (
      this.vscodePackage &&
      typeof p.path === "string" &&
      (p.path.startsWith("untitled:") || !uriScheme(p.path))
    ) {
      const open = this.openDocumentText(p.path);
      if (open !== null) return open;
    }
    const result = (await this.exec("editor.getText", {
      path: p.path !== undefined ? this.documentPath(p.path) : await this.activePath(),
    })) as { text: string };
    return result.text;
  }

  private range(p: Record<string, unknown>): Record<string, number> {
    const r = (p.range && typeof p.range === "object" ? p.range : p) as Record<string, unknown>;
    const startLine = num(r.startLine);
    if (!startLine || startLine < 1) throw new Error("A range needs startLine (1-based).");
    const out: Record<string, number> = { startLine };
    for (const k of ["startColumn", "endLine", "endColumn"]) {
      const v = num(r[k]);
      if (v !== undefined && v >= 1) out[k] = v;
    }
    return out;
  }

  private async editorReplace(p: Record<string, unknown>): Promise<void> {
    this.deps.need("fs.write", "change files");
    await this.exec("editor.replaceRange", {
      path: p.path !== undefined ? this.documentPath(p.path, true) : await this.activePath(),
      ...this.range(p),
      text: String(p.text ?? ""),
    });
  }

  private async editorSelect(p: Record<string, unknown>): Promise<void> {
    this.deps.need("fs.read", "select text");
    await this.activePath();
    const r = this.range(p);
    await this.exec("editor.select", { ...r, endLine: r.endLine ?? r.startLine });
  }

  /** The active editor's file, only when it's in the open folder (extensions see nothing else). */
  private async activePath(): Promise<string> {
    const active = (await this.deps.services.state.get("ide://editors/active").catch(() => null))
      ?.value as { absolutePath?: string | null } | null;
    if (!active?.absolutePath) throw new Error("No text editor is active (give a path).");
    return this.documentPath(active.absolutePath);
  }

  /**
   * Every provider the editor has, asked about a document (VS Code's vscode.execute…Provider):
   * its language servers', its own services' and every extension's, this one's too.
   */
  private executeProviders(p: Record<string, unknown>): Promise<unknown> {
    this.deps.need("fs.read", "ask language providers about files");
    const query = checkProviderQuery(p);
    // A document open outside the folder (an untitled one, site-packages), as editor.text reads.
    const openOutside =
      this.vscodePackage &&
      (query.path.startsWith("untitled:") || !uriScheme(query.path)) &&
      this.openDocumentText(query.path) !== null;
    const path = openOutside ? query.path : this.documentPath(query.path);
    const run = this.deps.services.extensionFeatures.hooks.executeProvider;
    if (!run) return Promise.reject(new Error("The editor can't answer provider queries."));
    return run({ ...query, path });
  }

  /** Whether `path` is in one of the workspace's folders. */
  private inFolder(path: string): boolean {
    return this.deps.services.workspace.contains(path);
  }

  /** An open document's text (unsaved changes included), or null when it isn't open. */
  private openDocumentText(path: string): string | null {
    return this.deps.services.documents.text(path);
  }

  /**
   * A VS Code package (it has Node's full access anyway, VSCODE_PERMISSIONS); the IDE's own
   * format keeps its providers to the folder, as its "fs.read" grants.
   */
  private get vscodePackage(): boolean {
    return this.deps.manifest.format === "vscode";
  }

  /**
   * Whether its providers may be asked about `path`: the folder's files; for a VS Code package
   * (VS Code asks about every open document a selector matches) also documents open in the
   * editor outside the folder, untitled ones, and notebook cells (their text comes with it).
   */
  private canAsk(path: string): boolean {
    if (this.inFolder(path)) return true;
    if (!this.vscodePackage) return false;
    return (
      path.startsWith("untitled:") ||
      cellOfPath(path) !== null ||
      this.openDocumentText(path) !== null
    );
  }

  /**
   * A place an answer points to (a definition, a reference, a link): anywhere on disk, as in
   * VS Code (site-packages, typeshed, ~/.cargo); only edits are kept to the folder.
   */
  private readablePath(path: unknown): string {
    try {
      return this.documentPath(path);
    } catch (err) {
      if (typeof path === "string" && isAbsolute(path)) return resolveInRoot("/", path);
      if (typeof path === "string" && path.startsWith("untitled:")) return path;
      throw err;
    }
  }

  /** Its decoration types (D234), by the worker's key. */
  private readonly decorationTypes = new Map<string, { id: number; style: DecorationTypeStyle }>();

  private createDecorationType(p: Record<string, unknown>): void {
    this.deps.need("fs.read", "decorate files");
    const key = String(p.key ?? "");
    if (!/^[\w.-]{1,60}$/.test(key)) throw new Error("A decoration type needs a key.");
    if (!this.decorationTypes.has(key) && this.decorationTypes.size >= MAX_DECORATION_TYPES)
      throw new Error(`An extension can have at most ${MAX_DECORATION_TYPES} decoration types.`);
    this.decorationTypes.set(key, {
      id: ++decorationTypeSeq,
      style: normalizeDecorationType(p.options),
    });
  }

  private async setDecorationType(p: Record<string, unknown>): Promise<void> {
    this.deps.need("fs.read", "decorate files");
    const key = String(p.key ?? "");
    const type = this.decorationTypes.get(key);
    if (!type) throw new Error(`No decoration type ${key} (it was disposed).`);
    const path = p.path !== undefined ? this.deps.workspacePath(p.path) : await this.activePath();
    const setKey = `type:${key}`;
    const sets = this.deps.services.extensionFeatures.decorations
      .peek()
      .filter((d) => d.owner === this.owner && !(d.key === setKey && d.path === path));
    if (sets.length >= MAX_DECORATION_SETS)
      throw new Error(`An extension can have at most ${MAX_DECORATION_SETS} decoration sets.`);
    const ranges = (Array.isArray(p.ranges) ? p.ranges : []).slice(0, MAX_RANGES).flatMap((raw) => {
      const range = this.decorationRange(raw);
      if (!range) return [];
      const r = raw as Record<string, unknown>;
      const before = cleanContent(r.before);
      const after = cleanContent(r.after);
      return [{ ...range, ...(before && { before }), ...(after && { after }) }];
    });
    if (this.disposed || !this.decorationTypes.has(key)) return;
    this.deps.services.extensionFeatures.setDecorations({
      owner: this.owner,
      key: setKey,
      path,
      style: "custom",
      custom: type,
      ranges,
    });
  }

  /** A range of a decoration set (1-based; `hover` Markdown), or null. */
  private decorationRange(raw: unknown): DecorationRange | null {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const startLine = num(r.startLine);
    if (!startLine || startLine < 1) return null;
    const out: DecorationRange = { startLine };
    for (const k of ["startColumn", "endLine", "endColumn"] as const) {
      const v = num(r[k]);
      if (v !== undefined && v >= 1) out[k] = v;
    }
    if (typeof r.hover === "string") out.hover = r.hover.slice(0, 4000);
    return out;
  }

  private async decorate(p: Record<string, unknown>): Promise<void> {
    this.deps.need("fs.read", "decorate files");
    const key = String(p.key ?? "").slice(0, 60);
    if (!key) throw new Error("Decorations need a key (to replace or clear them later).");
    const style = p.style as DecorationStyle;
    if (!DECORATION_STYLES.includes(style))
      throw new Error(`style must be one of ${DECORATION_STYLES.join(", ")}.`);
    const path = p.path !== undefined ? this.deps.workspacePath(p.path) : await this.activePath();
    const sets = this.deps.services.extensionFeatures.decorations
      .peek()
      .filter((d) => d.owner === this.owner && !(d.key === key && d.path === path));
    if (sets.length >= MAX_DECORATION_SETS)
      throw new Error(`An extension can have at most ${MAX_DECORATION_SETS} decoration sets.`);
    const list = (Array.isArray(p.ranges) ? p.ranges : []).slice(0, MAX_RANGES);
    const ranges = list.flatMap((raw): DecorationRange[] => {
      const range = this.decorationRange(raw);
      return range ? [range] : [];
    });
    // Stopped while it waited for the active editor: nothing would clear these.
    if (this.disposed) return;
    this.deps.services.extensionFeatures.setDecorations({
      owner: this.owner,
      key,
      path,
      style,
      ranges,
      ...(typeof p.after === "string" && p.after && { after: p.after }),
    });
  }

  // ---- Languages ---------------------------------------------------------------------------

  private setDiagnostics(p: Record<string, unknown>): void {
    this.deps.need("fs.read", "report problems in files");
    // Problems in any file the extension checks (a language server reports open files outside
    // the folder too, as VS Code shows them).
    // A notebook cell's document (`vscode-notebook-cell:`): the problems are the open
    // notebook's, in that cell (none while it isn't open, as VS Code has no such document then).
    const { path, key, cell } = this.diagnosticTarget(p.path);
    const items: ExternalProblem[] = normalizeDiagnostics(
      Array.isArray(p.items) && (!cell || cell.index >= 0)
        ? p.items.slice(0, MAX_DIAGNOSTICS_PER_FILE)
        : [],
      path,
      this.deps.manifest.displayName,
      (related) => this.readablePath(related),
    ).map((d) => (cell && cell.index >= 0 ? { ...d, cell } : d));
    if (items.length && !this.diagnostics.has(key) && this.diagnostics.size >= MAX_DIAGNOSTIC_FILES)
      throw new Error(`An extension can report problems in at most ${MAX_DIAGNOSTIC_FILES} files.`);
    if (items.length) this.diagnostics.set(key, items);
    else this.diagnostics.delete(key);
    this.publishDiagnostics();
  }

  /** Where problems for `raw` go: a file, or an open notebook's cell (keyed apart per cell). */
  private diagnosticTarget(raw: unknown): {
    path: string;
    key: string;
    cell?: { id: string; index: number };
  } {
    const cell = typeof raw === "string" ? parseCellPath(raw) : null;
    if (!cell) {
      const path = this.readablePath(raw);
      return { path, key: path };
    }
    const path = this.readablePath(cell.notebook);
    const index = this.deps.services.notebooks.cellIndex(path, cell.cellId) ?? -1;
    return { path, key: `${path}#${cell.cellId}`, cell: { id: cell.cellId, index } };
  }

  private publishDiagnostics(): void {
    this.deps.services.problems.set(`ext:${this.owner}`, [...this.diagnostics.values()].flat());
  }

  private registerProvider(p: Record<string, unknown>): void {
    const id = String(p.id ?? "");
    if (!id) throw new Error("A provider needs an id.");
    const languages = (Array.isArray(p.languages) ? p.languages : [])
      .filter((l): l is string => typeof l === "string" && /^[\w*+#.-]{1,40}$/.test(l))
      .slice(0, 20);
    if (!languages.length) throw new Error('Name the languages ("typescript", or "*" for all).');
    this.providers.get(id)?.dispose();
    if (this.providers.size >= MAX_PROVIDERS)
      throw new Error(`An extension can have at most ${MAX_PROVIDERS} providers.`);
    // Hovers and completions are about file contents.
    this.deps.need("fs.read", "read the text it's asked about");
    if (typeof p.feature === "string") {
      // definition, references, formatting… (runtimeProviders.ts).
      const feature = p.feature as ProviderFeature;
      if (!PROVIDER_FEATURES.includes(feature))
        throw new Error(`Unknown provider "${p.feature}" (${PROVIDER_FEATURES.join(", ")}).`);
      if (EDITING_FEATURES.includes(feature)) this.deps.need("fs.write", "change files");
      const commands = this.deps.manifest.contributes.commands;
      const changed = new Emitter<void>();
      let part: Partial<LanguageFeature>;
      try {
        part = providerFeature(feature, p, {
          ask: async (context, sub, signal) =>
            (await this.deps.worker()).call(
              "provider",
              sub ? `${id}.${sub}` : id,
              context,
              undefined,
              undefined,
              signal,
            ),
          changed: changed.event,
          canAsk: (path) => this.canAsk(path),
          resolve: (path) => this.readablePath(path),
          resolveWritable: (path) => this.deps.writablePath(path),
          ownCommand: (command) => commands.some((c) => c.id === command),
        });
      } catch (err) {
        changed.dispose();
        throw err;
      }
      const off = this.deps.services.extensionFeatures.addLanguageFeature({
        owner: this.owner,
        languages,
        schemes: this.schemes(),
        ownerName: this.deps.manifest.displayName,
        ...part,
      });
      this.providers.set(id, {
        refresh: () => changed.fire(),
        dispose: () => {
          off.dispose();
          changed.dispose();
        },
      });
      return;
    }
    const ask = async <T>(
      kind: "hover" | "completion" | "provider",
      target: string,
      context: unknown,
      signal?: AbortSignal,
    ) => (await this.deps.worker()).call<T>(kind, target, context, undefined, undefined, signal);
    const triggers = (Array.isArray(p.triggerCharacters) ? p.triggerCharacters : [])
      .filter((t): t is string => typeof t === "string" && t.length === 1)
      // VS Code keeps every trigger character a provider names.
      .slice(0, 40);
    const own = (command: string) =>
      this.deps.manifest.contributes.commands.some((c) => c.id === command);
    const off = this.deps.services.extensionFeatures.addLanguageFeature({
      owner: this.owner,
      languages,
      schemes: this.schemes(),
      ...(p.hover === true && {
        hover: async (context: FeatureContext, signal?: AbortSignal) => {
          if (!this.canAsk(context.path)) return null;
          // Markdown, or `{ contents, range }` (VS Code's Hover.range).
          return toHoverAnswer(await ask<unknown>("hover", id, context, signal));
        },
      }),
      ...(p.completion === true && {
        completion: {
          triggerCharacters: triggers,
          provide: async (context: FeatureContext, signal?: AbortSignal) => {
            if (!this.canAsk(context.path)) return [];
            return normalizeCompletions(await ask<unknown>("completion", id, context, signal), own);
          },
          // VS Code's resolveCompletionItem: a "provider" call `<id>.resolve`.
          ...(p.resolve === true && {
            resolve: async (context: { resolveId: string }, signal?: AbortSignal) => {
              const raw = await ask<unknown>("provider", `${id}.resolve`, context, signal);
              return raw
                ? (normalizeCompletionItem(raw, own, true) as Partial<CompletionEntry>)
                : null;
            },
          }),
        },
      }),
    });
    this.providers.set(id, off);
  }

  /**
   * The editor documents its providers are asked about: files (in the folder or open, untitled
   * ones too), and for a VS Code package notebook cells (its selectors say which).
   */
  private schemes(): string[] {
    return this.deps.manifest.format === "vscode" ? ["file", "notebook-cell"] : ["file"];
  }

  // ---- Windows -----------------------------------------------------------------------------

  private async openInWindow(p: Record<string, unknown>): Promise<void> {
    const tabId = await this.deps.revealView(String(p.viewId));
    if (!tabId) throw new Error("Only tabs (panel or editor views) can open in a window.");
    await this.exec("layout.moveToNewWindow", {
      tabId,
      ...(num(p.width) && { width: num(p.width) }),
      ...(num(p.height) && { height: num(p.height) }),
    });
  }

  private disposed = false;

  dispose(): void {
    this.disposed = true;
    this.progress.dispose();
    for (const s of this.status.values()) s.off.dispose();
    this.status.clear();
    for (const off of this.providers.values()) off.dispose();
    this.providers.clear();
    this.diagnostics.clear();
    this.decorationTypes.clear();
    this.deps.services.problems.clear(`ext:${this.owner}`);
    this.deps.services.extensionFeatures.clearDecorations(this.owner);
    this.store.dispose();
  }
}
