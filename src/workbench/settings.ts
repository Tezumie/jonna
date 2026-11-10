// SettingsService: the settings registry (contributed schemas), the effective values (defaults <
// user < workspace), the two JSONC files on disk and their live reload (PLAN §12). Writes go
// through `setJsoncProperty`, so comments and formatting in the user's files survive.
//
// A multi-root workspace (D251): the workspace scope is the workspace file's `settings` (written
// back into that file), and each folder's own settings.json files are a folder layer for its
// files (`getAt` / `peekAt` with a file's path). With one folder, nothing changes.
import { Emitter } from "../core/events/index";
import { fsIpc } from "../core/ipc/fs";
import { isTauri } from "../core/ipc/invoke";
import { type SettingsPaths, settingsIpc } from "../core/ipc/system";
import {
  type Disposable,
  DisposableStore,
  MutableDisposable,
  toDisposable,
} from "../core/lifecycle/index";
import { dirname, joinPath, pathKey } from "../core/paths/index";
import { type ReadonlySignal, type Signal, signal } from "../core/reactive/index";
import { parseJsonc } from "../core/settings/jsonc";
import {
  assertEditableJsoncObject,
  setJsoncNestedProperty,
  setJsoncProperty,
} from "../core/settings/jsoncEdit";
import { isLanguageOverrideKey, languageOverrideKey } from "../core/settings/languageOverrides";
import { SettingsModel, type SettingsScope } from "../core/settings/model";
import { type SettingSchema, SettingsRegistry } from "../core/settings/schema";
import { translateVscodeSettings } from "../core/settings/vscode";
import type { WorkspaceService } from "./workspace";
import { ensureWorkspaceFolder, workspaceFolderName, workspaceFolders } from "./workspaceFolder";

/** Values cached in localStorage so the first paint already uses them (theme, density, panels). */
/** A value a setting can take, for settings whose values are only known at runtime (themes). */
/**
 * A string setting chosen in a popup of its own (D288: a model, in the chat's model picker): the
 * settings editor shows a button with its label that opens it.
 */
export interface SettingPicker {
  /** What the button says for `value`, and a line under the row. */
  label(value: string): { text: string; detail?: string };
  /** Opens the popup at `anchor`; `set` writes the value (as the editor writes any setting). */
  open(anchor: HTMLElement, value: string, set: (value: string) => void): void;
}

export interface SettingChoice {
  value: string;
  label: string;
  description?: string;
}

const FIRST_PAINT_KEYS = [
  "workbench.theme",
  "workbench.density",
  "workbench.panels",
  "workbench.sideBarColor",
  "workbench.tabStyle",
] as const;
/**
 * More of the last applied look for the next first paint (D136): the color theme's name, its token
 * overrides and its syntax theme, so a start with a non-built-in theme doesn't flash the default.
 */
type FirstPaintKey =
  | (typeof FIRST_PAINT_KEYS)[number]
  | "theme.colorTheme"
  | "theme.overrides"
  | "theme.syntax";
const FIRST_PAINT_CACHE = "settings-first-paint";

export class SettingsService implements Disposable {
  readonly registry = new SettingsRegistry();
  readonly model = new SettingsModel(this.registry);
  /** Bumped on every effective change; read it in effects to re-run on settings changes. */
  readonly version: Signal<number> = signal(0);
  private readonly store = new DisposableStore();
  private readonly watcher = this.store.add(new MutableDisposable());
  private paths: SettingsPaths | null = null;
  /** Last text read or written per scope (writes edit this, so comments are kept). */
  private texts: Record<SettingsScope, string> = { user: "", workspace: "" };
  private readonly keybindingsChanged = this.store.add(new Emitter<void>());
  /** keybindings.json changed on disk (or its location became known). */
  readonly onDidChangeKeybindingsFile = this.keybindingsChanged.event;

  private readonly choiceProviders = new Map<string, () => readonly SettingChoice[]>();
  private readonly pickers = new Map<string, SettingPicker>();
  private workspace: WorkspaceService | null = null;

  /** The workspace whose file holds a multi-root workspace's settings (D251). */
  attachWorkspace(workspace: WorkspaceService): void {
    this.workspace = workspace;
  }

  /** Whether a multi-root workspace (a workspace file) is open. */
  private multiRoot(): boolean {
    return !!this.workspace?.file.peek();
  }

  /**
   * Values for a string setting known only at runtime (installed color themes, icon themes): the
   * settings editor shows a dropdown of them. The provider may read signals.
   */
  registerChoices(key: string, provider: () => readonly SettingChoice[]): Disposable {
    this.choiceProviders.set(key, provider);
    return toDisposable(() => {
      if (this.choiceProviders.get(key) === provider) this.choiceProviders.delete(key);
    });
  }

  /** A popup of its own for a string setting (D288), shown instead of a text box or dropdown. */
  registerPicker(key: string, picker: SettingPicker): Disposable {
    this.pickers.set(key, picker);
    return toDisposable(() => {
      if (this.pickers.get(key) === picker) this.pickers.delete(key);
    });
  }

  /** The popup for `key`, if it has one. */
  picker(key: string): SettingPicker | undefined {
    return this.pickers.get(key);
  }

  /** The runtime choices for `key`, if it has any. */
  choices(key: string): readonly SettingChoice[] | undefined {
    return this.choiceProviders.get(key)?.();
  }

  constructor() {
    this.store.add(
      this.model.onDidChange(() => {
        this.version.value = this.version.peek() + 1;
        this.cacheFirstPaint();
      }),
    );
  }

  /** Registers contributed settings (manifests). */
  register(settings: Readonly<Record<string, SettingSchema>>): Disposable {
    const before = this.model.snapshot();
    const unregister = this.registry.register(settings);
    this.model.registryChanged(before);
    // A folder's .vscode/settings.json set one of these before it was known (an extension that
    // activated after the folder's settings were read, or was installed now): read it again, or
    // its prettier.* / eslint.* values stay dropped until the file changes (D379).
    const added = Object.keys(settings);
    if (added.some((k) => this.vscodeSkipped.some((s) => s === k || s.endsWith(` ${k}`))))
      void this.reloadVscode();
    // An open settings page shows (or drops) these at once: an extension turned on or off.
    this.version.value = this.version.peek() + 1;
    return toDisposable(() => {
      const prior = this.model.snapshot();
      unregister();
      this.model.registryChanged(prior);
      this.version.value = this.version.peek() + 1;
    });
  }

  /**
   * An extension's default values for settings (VS Code's `contributes.configurationDefaults`,
   * `source` its id): plain keys and `[language]` blocks, above the declared defaults and below
   * the user's and the folder's settings. Dispose to take them back (the extension unloads).
   */
  registerDefaults(source: string, values: Readonly<Record<string, unknown>>): Disposable {
    const blockKeys = Object.entries(values).flatMap(([k, v]) =>
      isLanguageOverrideKey(k) && v && typeof v === "object" ? Object.keys(v) : [],
    );
    const before = this.model.snapshot();
    const unregister = this.registry.registerDefaults(source, values);
    this.model.registryChanged(before, blockKeys);
    this.version.value = this.version.peek() + 1;
    return toDisposable(() => {
      const prior = this.model.snapshot();
      unregister();
      this.model.registryChanged(prior, blockKeys);
      this.version.value = this.version.peek() + 1;
    });
  }

  /** Effective value (reactive inside effects). */
  get<T>(key: string): T {
    this.version.value;
    return this.model.get<T>(key);
  }

  /** Non-reactive read. */
  peek<T>(key: string): T {
    return this.model.get<T>(key);
  }

  /** The value for documents of `language` (its `[language]` blocks first; reactive in effects). */
  getForLanguage<T>(key: string, language: string | null | undefined): T {
    this.version.value;
    return this.model.getForLanguage<T>(key, language);
  }

  /** Non-reactive `getForLanguage`. */
  peekForLanguage<T>(key: string, language: string | null | undefined): T {
    return this.model.getForLanguage<T>(key, language);
  }

  /**
   * The value for the file at `path` (D251): its folder's own setting in a multi-root workspace,
   * else the window's (`get`). Reactive in effects.
   */
  getAt<T>(key: string, path: string | null | undefined): T {
    this.version.value;
    return this.peekAt<T>(key, path);
  }

  /** Non-reactive `getAt`. */
  peekAt<T>(key: string, path: string | null | undefined): T {
    return this.model.getAt<T>(key, this.folderKeyOf(path));
  }

  /** `getForLanguage` for the file at `path` (its folder's blocks and values first). Reactive. */
  getForLanguageAt<T>(
    key: string,
    language: string | null | undefined,
    path: string | null | undefined,
  ): T {
    this.version.value;
    return this.peekForLanguageAt<T>(key, language, path);
  }

  /** Non-reactive `getForLanguageAt`. */
  peekForLanguageAt<T>(
    key: string,
    language: string | null | undefined,
    path: string | null | undefined,
  ): T {
    return this.model.getForLanguageAt<T>(key, language, this.folderKeyOf(path));
  }

  /** The folder layer a file's settings come from (a multi-root workspace's folder), if any. */
  private folderKeyOf(path: string | null | undefined): string | null {
    if (!path || !this.multiRoot()) return null;
    const folder = this.workspace?.folderOf(path);
    return folder ? pathKey(folder.path) : null;
  }

  /** A signal-like view of one key. */
  watch<T>(key: string): ReadonlySignal<T> {
    const self = this;
    return {
      get value() {
        return self.get<T>(key);
      },
      peek: () => self.peek<T>(key),
    } as ReadonlySignal<T>;
  }

  /** Path of a scope's settings.json (null when that scope isn't available). */
  filePath(scope: SettingsScope): string | null {
    if (scope === "user") return this.paths?.userSettings ?? null;
    // A multi-root workspace's settings live in its workspace file (D251).
    if (this.multiRoot()) return this.workspace?.file.peek() ?? null;
    return this.paths?.workspaceSettings ?? null;
  }

  /**
   * The settings.json of the folder's other workspace folders (D189: .vscode, the legacy folder name, those that
   * exist), highest precedence first. Read as one layer under the IDE's own workspace settings.
   */
  get aliasPaths(): { folder: string; path: string }[] {
    const ws = this.paths?.workspaceSettings;
    // A multi-root workspace has no alias layer: each folder's .vscode is in its folder layer.
    if (!ws || this.multiRoot()) return [];
    const root = dirname(dirname(ws));
    return workspaceFolders()
      .filter((f) => f !== workspaceFolderName())
      .map((folder) => ({ folder, path: joinPath(joinPath(root, folder), "settings.json") }));
  }

  /** Keys in the other folders' settings.json the IDE doesn't know (shown in the settings editor). */
  vscodeSkipped: string[] = [];
  /** Which folder set each key of the alias layer (".vscode"…). */
  private aliasSource = new Map<string, string>();
  /** The raw alias values per folder (for conflicts with the IDE's own). */
  private aliasValues = new Map<string, Record<string, unknown>>();

  /** The folder (".vscode", the legacy folder name) whose settings.json sets `key`, if one does. */
  aliasFolderOf(key: string): string | undefined {
    return this.aliasSource.get(key);
  }

  /**
   * Keys a lower workspace folder sets that the IDE's own workspace settings set differently
   * (the higher one wins), per lower folder.
   */
  aliasConflicts(): Map<string, string[]> {
    const own = this.model.layerValues("workspace");
    const out = new Map<string, string[]>();
    for (const [folder, values] of this.aliasValues) {
      const keys = Object.keys(values).filter(
        (k) => k in own && JSON.stringify(own[k]) !== JSON.stringify(values[k]),
      );
      if (keys.length) out.set(folder, keys);
    }
    return out;
  }

  private async reloadVscode(): Promise<void> {
    const { values, skipped, source, raw } = await this.readFolderFiles(this.aliasPaths);
    this.vscodeSkipped = skipped;
    this.aliasSource = source;
    this.aliasValues = raw;
    this.model.setVscode(values);
  }

  /**
   * Reads settings files of workspace folders (`.vscode`, the IDE's own…), lowest precedence
   * last in `files`, merged: VS Code's keys and values translated, unknown keys listed.
   */
  private async readFolderFiles(files: readonly { folder: string; path: string }[]): Promise<{
    values: Record<string, unknown>;
    skipped: string[];
    source: Map<string, string>;
    raw: Map<string, Record<string, unknown>>;
  }> {
    const values: Record<string, unknown> = {};
    const skipped: string[] = [];
    const source = new Map<string, string>();
    const raw = new Map<string, Record<string, unknown>>();
    // Lowest precedence first, so a higher folder's value replaces it.
    for (const { folder, path } of [...files].reverse()) {
      try {
        const parsed = parseJsonc(new TextDecoder().decode(await fsIpc.read(path)));
        if (
          parsed.ok &&
          parsed.value &&
          typeof parsed.value === "object" &&
          !Array.isArray(parsed.value)
        ) {
          const known = (k: string) => !!this.registry.get(k);
          const obj = parsed.value as Record<string, unknown>;
          // VS Code's keys and values are translated; another folder of the IDE's own (the legacy folder name)
          // already has the IDE's.
          const t =
            folder === ".vscode"
              ? translateVscodeSettings(obj, known)
              : {
                  values: Object.fromEntries(
                    Object.entries(obj).filter(([k]) => known(k) || isLanguageOverrideKey(k)),
                  ),
                  skipped: Object.keys(obj).filter((k) => !known(k) && !isLanguageOverrideKey(k)),
                };
          raw.set(folder, t.values);
          for (const [k, v] of Object.entries(t.values)) {
            values[k] = v;
            source.set(k, folder);
          }
          for (const k of t.skipped) if (!skipped.includes(k)) skipped.push(k);
        }
      } catch {
        // No settings.json in this folder.
      }
    }
    return { values, skipped, source, raw };
  }

  /** Each folder's settings files in a multi-root workspace (D251), highest precedence first. */
  private folderSettingsFiles(): { folder: string; files: { folder: string; path: string }[] }[] {
    if (!this.multiRoot() || !this.workspace) return [];
    return this.workspace.folders.peek().map((f) => ({
      folder: f.path,
      files: workspaceFolders(f.path).map((name) => ({
        folder: name,
        path: joinPath(joinPath(f.path, name), "settings.json"),
      })),
    }));
  }

  /** Reads every folder's own settings into its folder layer (D251); drops gone folders' layers. */
  private async reloadFolders(): Promise<void> {
    const wanted = this.folderSettingsFiles();
    const keys = new Set(wanted.map((w) => pathKey(w.folder)));
    for (const key of this.model.folderLayers())
      if (!keys.has(key)) this.model.setFolderLayer(key, null);
    for (const { folder, files } of wanted) {
      const { values } = await this.readFolderFiles(files);
      // The folder left while its files were read.
      if (!this.workspace?.folders.peek().some((f) => pathKey(f.path) === pathKey(folder)))
        continue;
      this.model.setFolderLayer(pathKey(folder), values);
    }
  }

  get keybindingsPath(): string | null {
    return this.paths?.userKeybindings ?? null;
  }

  /** Reads both files and starts watching them. Call again after the workspace changed. */
  /** True once the settings files were read the first time (or couldn't be). */
  readonly loaded: Signal<boolean> = signal(false);

  async load(): Promise<void> {
    try {
      await this.loadFiles();
    } finally {
      this.loaded.value = true;
    }
  }

  private async loadFiles(): Promise<void> {
    if (!isTauri()) return;
    const first = this.paths === null;
    this.paths = await settingsIpc.paths(workspaceFolderName());
    if (first) this.keybindingsChanged.fire();
    await this.reload("user");
    await this.reload("workspace");
    await this.reloadVscode();
    await this.reloadFolders();
    if (!this.watcher.value) {
      this.watcher.value = await settingsIpc.watch((batch) => {
        const changed = new Set(batch.paths.map(pathKey));
        for (const scope of ["user", "workspace"] as const) {
          const file = this.filePath(scope);
          // The workspace file is the workspace service's to read (its folders change too).
          if (file && changed.has(pathKey(file))) {
            if (scope === "workspace" && this.multiRoot()) void this.workspace?.reloadFile();
            else void this.reload(scope);
          }
        }
        const keys = this.keybindingsPath;
        if (keys && changed.has(pathKey(keys))) this.keybindingsChanged.fire();
        if (this.aliasPaths.some((a) => changed.has(pathKey(a.path)))) void this.reloadVscode();
        if (
          this.folderSettingsFiles().some((f) => f.files.some((x) => changed.has(pathKey(x.path))))
        )
          void this.reloadFolders();
      });
    }
    const dirs = [this.paths.configDir];
    const ws = this.paths.workspaceSettings;
    if (ws) dirs.push(dirname(dirname(ws)), dirname(ws));
    for (const a of this.aliasPaths) dirs.push(dirname(a.path));
    // Each folder of a multi-root workspace: its top (to see its settings folders appear) and those.
    for (const f of this.folderSettingsFiles()) {
      dirs.push(f.folder);
      for (const x of f.files) dirs.push(dirname(x.path));
    }
    const existing = [
      dirs[0] ?? "",
      ...(await Promise.all(
        dirs
          .slice(1)
          .map(async (d) => ((await fsIpc.stat(d).catch(() => null))?.kind === "dir" ? d : null)),
      )),
    ].filter((d): d is string => !!d);
    await settingsIpc
      .setDirs(existing)
      // Folders that don't exist (no workspace folder or .vscode yet) can't be watched: the rest still are.
      .catch(() => settingsIpc.setDirs(dirs.slice(0, 2)).catch(() => {}));
  }

  /** Bumped by every write of ours: a reload that started before one is stale (D107). */
  private readonly writes: Record<SettingsScope, number> = { user: 0, workspace: 0 };
  private readonly writing: Record<SettingsScope, Promise<void>> = {
    user: Promise.resolve(),
    workspace: Promise.resolve(),
  };

  /** Bumped by every reload: only the newest reload of a scope may apply what it read. */
  private readonly reloads: Record<SettingsScope, number> = { user: 0, workspace: 0 };

  /** Re-reads one scope's file from disk. */
  async reload(scope: SettingsScope): Promise<void> {
    // Overlapping reloads (watcher events, a folder switch) can finish out of order; without this
    // an older read could win — e.g. the previous folder's workspace settings applied to the new.
    const generation = ++this.reloads[scope];
    // Our own writes (and the watcher events they cause) must not race with this read: wait for
    // them, and drop the result if another write started while reading.
    await this.writing[scope];
    if (generation !== this.reloads[scope]) return;
    const started = this.writes[scope];
    const file = this.filePath(scope);
    let text = "";
    if (scope === "workspace" && this.multiRoot()) {
      // The workspace file as the workspace service last read it: its `settings` object.
      text = JSON.stringify(this.workspace?.fileData.peek()?.settings ?? {}, null, 2);
    } else if (file) {
      try {
        text = new TextDecoder().decode(await fsIpc.read(file));
      } catch {
        text = ""; // missing file = no values
      }
    }
    if (generation !== this.reloads[scope]) return; // a newer reload is (or was) reading
    if (file !== this.filePath(scope)) return; // the folder changed while reading
    if (started !== this.writes[scope] || text === this.texts[scope]) return;
    this.texts[scope] = text;
    this.model.setText(scope, text);
  }

  /** Sets (or with `undefined`, removes) a key in a scope's settings.json. */
  async update(key: string, value: unknown, scope: SettingsScope = "user"): Promise<void> {
    const file = this.filePath(scope);
    if (scope === "workspace" && !file)
      throw new Error("Open a folder to change workspace settings.");
    if (scope === "workspace" && this.multiRoot())
      return this.updateWorkspaceFile({ [key]: value });
    await this.write(scope, file, setJsoncProperty(this.editableText(scope), key, value));
  }

  /**
   * A multi-root workspace's settings change in its workspace file (D251; comments elsewhere in
   * it kept). The model takes the new values at once.
   */
  private async updateWorkspaceFile(values: Record<string, unknown>): Promise<void> {
    const workspace = this.workspace;
    if (!workspace) return;
    const run = this.writing.workspace.then(async () => {
      for (const [key, value] of Object.entries(values)) await workspace.writeSetting(key, value);
    });
    this.writing.workspace = run.catch(() => {});
    this.writes.workspace++;
    await run;
    const text = JSON.stringify(workspace.fileData.peek()?.settings ?? {}, null, 2);
    this.texts.workspace = text;
    this.model.setText("workspace", text);
  }

  /**
   * The scope's current text, after refusing a file with a syntax error: every edit rewrites the
   * whole file, so editing one the user is fixing would lose it (the error names the file and line;
   * user-run commands show it as a toast).
   */
  private editableText(scope: SettingsScope): string {
    const text = this.texts[scope];
    assertEditableJsoncObject(text, `Your ${scope} settings.json`);
    return text;
  }

  /**
   * Sets (or with `undefined`, removes) `key` in a scope's `"[language]": {…}` block (VS Code's
   * language-specific settings); the block is made when needed and removed once empty.
   */
  async updateForLanguage(
    language: string,
    key: string,
    value: unknown,
    scope: SettingsScope = "user",
  ): Promise<void> {
    const file = this.filePath(scope);
    if (scope === "workspace" && !file)
      throw new Error("Open a folder to change workspace settings.");
    const block = languageOverrideKey(language);
    if (scope === "workspace" && this.multiRoot()) {
      const current = this.workspace?.fileData.peek()?.settings[block];
      const inner = {
        ...(current && typeof current === "object" ? (current as Record<string, unknown>) : {}),
      };
      if (value === undefined) delete inner[key];
      else inner[key] = value;
      return this.updateWorkspaceFile({ [block]: Object.keys(inner).length ? inner : undefined });
    }
    const text = this.editableText(scope);
    await this.write(scope, file, setJsoncNestedProperty(text, block, key, value));
  }

  private async write(scope: SettingsScope, file: string | null, next: string): Promise<void> {
    this.texts[scope] = next;
    this.writes[scope]++;
    this.model.setText(scope, next);
    if (!file) return;
    // Writes go out in order (each one is the whole file).
    const write = this.writing[scope].then(() => fsIpc.write(file, new TextEncoder().encode(next)));
    this.writing[scope] = write.catch(() => {});
    await write;
  }

  /** Sets several keys in one write (an import, D193); `undefined` removes a key. */
  async updateMany(values: Record<string, unknown>, scope: SettingsScope = "user"): Promise<void> {
    const file = this.filePath(scope);
    if (scope === "workspace" && !file)
      throw new Error("Open a folder to change workspace settings.");
    if (scope === "workspace" && this.multiRoot()) return this.updateWorkspaceFile(values);
    let next = this.editableText(scope);
    for (const [key, value] of Object.entries(values)) next = setJsoncProperty(next, key, value);
    if (next === this.texts[scope]) return;
    this.texts[scope] = next;
    this.writes[scope]++;
    this.model.setText(scope, next);
    if (!file) return;
    const write = this.writing[scope].then(() => fsIpc.write(file, new TextEncoder().encode(next)));
    this.writing[scope] = write.catch(() => {});
    await write;
  }

  /**
   * Sets (or with `undefined`, removes) `key` in one workspace folder's own settings.json
   * (`<folder>/<IDE folder>/settings.json`, D251): a multi-root workspace's folder layer. With one
   * folder (or the first folder of a single-folder window) that's the workspace scope itself.
   * `language`: in that folder's `"[language]"` block.
   */
  async updateAt(key: string, value: unknown, folder: string, language?: string): Promise<void> {
    const workspace = this.workspace;
    const owner = workspace?.folders.peek().find((f) => pathKey(f.path) === pathKey(folder));
    if (!workspace || !owner) throw new Error(`${folder} isn't a folder of this workspace.`);
    if (!this.multiRoot())
      return language
        ? this.updateForLanguage(language, key, value, "workspace")
        : this.update(key, value, "workspace");
    const dir = await ensureWorkspaceFolder(owner.path);
    const file = joinPath(dir, "settings.json");
    const text = await fsIpc
      .read(file)
      .then((b) => new TextDecoder().decode(b))
      .catch(() => "");
    assertEditableJsoncObject(text, `${owner.name}'s settings.json`);
    const next = language
      ? setJsoncNestedProperty(text, languageOverrideKey(language), key, value)
      : setJsoncProperty(text, key, value);
    if (next === text) return;
    await fsIpc.write(file, new TextEncoder().encode(next));
    await this.reloadFolders();
  }

  /** One folder's own settings as written (its layer in a multi-root workspace), for the editor. */
  folderValues(folder: string): Record<string, unknown> {
    return this.model.folderValues(pathKey(folder));
  }

  /** The path of a folder's own settings.json (where `updateAt` writes). */
  folderSettingsPath(folder: string): string {
    return joinPath(joinPath(folder, workspaceFolderName()), "settings.json");
  }

  /** Values cached for the next start's first paint (before the files are read). */
  static cachedFirstPaint(): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(FIRST_PAINT_CACHE);
      const value: unknown = raw ? JSON.parse(raw) : null;
      return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Values the next start's first paint should use that aren't plain settings (the theme's kind). */
  private readonly firstPaintOverrides: Record<string, unknown> = {};

  setFirstPaint(key: FirstPaintKey, value: unknown): void {
    const before = this.firstPaintOverrides[key];
    if (before === value) return;
    // Token overrides are rebuilt on every apply: unchanged ones don't rewrite the cache (the
    // syntax theme is the same object while it's the same theme).
    if (
      key === "theme.overrides" &&
      typeof before === "object" &&
      JSON.stringify(before) === JSON.stringify(value)
    )
      return;
    this.firstPaintOverrides[key] = value;
    this.cacheFirstPaint();
  }

  private cacheFirstPaint(): void {
    try {
      const values = {
        ...Object.fromEntries(FIRST_PAINT_KEYS.map((k) => [k, this.model.get(k)])),
        ...this.firstPaintOverrides,
      };
      localStorage.setItem(FIRST_PAINT_CACHE, JSON.stringify(values));
    } catch {
      // Storage unavailable: the first paint uses defaults until the files are read.
    }
  }

  dispose(): void {
    this.store.dispose();
    this.model.dispose();
  }
}
