// Effective settings = defaults < the team's defaults < user < the folder's
// `.vscode/settings.json` < workspace (PLAN §12). Holds the parsed contents of the settings files, resolves each key through the layers
// (invalid values fall through to the next layer, with a problem recorded), and reports which keys
// changed. The `.vscode` layer is read-only (translated by vscode.ts); so is the team's (the
// defaults a team publishes, already filtered by core/team/settings.ts: never a lock, the user's
// own value wins). Language blocks
// (`"[python]": {…}`, languageOverrides.ts) win over plain values in every layer, for documents of
// that language (`getForLanguage`). DOM-free and unit-tested.
//
// A multi-root workspace (D251): the workspace layer is the workspace file's `settings`, and each
// folder's own settings (its IDE folder's and `.vscode`'s, merged) are a folder layer that only
// applies to that folder's files (`getAt`, `getForLanguageAt`), above the workspace's.
import { Emitter } from "../events/index";
import { parseJsonc } from "./jsonc";
import {
  changedOverrideKeys,
  isLanguageOverrideKey,
  languageValues,
  overriddenLanguages,
  overrideLanguages,
} from "./languageOverrides";
import { isValid, type SettingSchema, type SettingsRegistry } from "./schema";

export type SettingsScope = "user" | "workspace";

/** The layer a value came from: a scope, or one of the read-only layers. */
export type SettingsSource = "default" | SettingsScope | "vscode" | "team";

export interface SettingsProblem {
  scope: SettingsScope;
  key?: string;
  message: string;
}

export class SettingsModel {
  private layers: Record<SettingsScope, Record<string, unknown>> = { user: {}, workspace: {} };
  private parseProblems: Record<SettingsScope, SettingsProblem[]> = { user: [], workspace: [] };
  /** The folder's VS Code settings, translated (below the IDE's own workspace settings). */
  private vscode: Record<string, unknown> = {};
  /** The team's defaults (its library's settings.json, filtered): under the user's own. */
  private team: Record<string, unknown> = {};
  private readonly changed = new Emitter<readonly string[]>();
  /** Fires with the keys whose effective value changed. */
  readonly onDidChange = this.changed.event;

  /** The open folder is trusted: its settings may set restricted keys (D209). */
  private trusted = false;
  /** Each folder's own settings in a multi-root workspace (D251), by folder key. */
  private folders = new Map<string, Record<string, unknown>>();

  /**
   * Values for this run only, above every file's: what a command line's flags say (the model,
   * the access mode). Never written anywhere, and gone with the process.
   */
  private overrides: Record<string, unknown> = {};

  constructor(private readonly registry: SettingsRegistry) {}

  /**
   * Replaces the values that hold for this run only (above the user's and the folder's settings;
   * an object setting replaces, it doesn't merge). Nothing is written to a settings file.
   */
  setOverrides(values: Readonly<Record<string, unknown>>): void {
    const before = this.snapshot();
    const also = [...Object.keys(this.overrides), ...Object.keys(values)];
    this.overrides = { ...values };
    this.emitDiff(
      before,
      also.filter((k) => !this.registry.get(k)),
    );
  }

  /** The values set for this run only. */
  overrideValues(): Record<string, unknown> {
    return { ...this.overrides };
  }

  /** The folder's trust changed: restricted settings from its files apply, or stop applying. */
  setTrusted(trusted: boolean): void {
    if (this.trusted === trusted) return;
    const before = this.snapshot();
    this.trusted = trusted;
    this.emitDiff(before);
  }

  /** A folder's layers (its settings, its .vscode) may set this key. */
  private folderMaySet(schema: SettingSchema | undefined): boolean {
    return !schema || (schema.scope !== "user" && (!schema.restricted || this.trusted));
  }

  /** Replaces a layer from the file's text (empty/missing file = no values). */
  setText(scope: SettingsScope, text: string | null): void {
    const problems: SettingsProblem[] = [];
    let values: Record<string, unknown> = {};
    if (text?.trim()) {
      const parsed = parseJsonc(text);
      if (!parsed.ok) {
        problems.push({
          scope,
          message: `${parsed.error.message} (line ${parsed.error.line}, column ${parsed.error.column})`,
        });
        // Keep the previous values while the file has a syntax error (typing in progress).
        values = this.layers[scope];
      } else if (
        typeof parsed.value !== "object" ||
        parsed.value === null ||
        Array.isArray(parsed.value)
      ) {
        problems.push({ scope, message: "settings.json must contain an object" });
      } else {
        values = parsed.value as Record<string, unknown>;
      }
    }
    this.parseProblems[scope] = problems;
    this.replace(scope, values);
  }

  /** Replaces a layer's values (already parsed). */
  replace(scope: SettingsScope, values: Record<string, unknown>): void {
    const before = this.snapshot();
    const old = this.layers[scope];
    this.layers = { ...this.layers, [scope]: { ...values } };
    // A key set to its default and then reset changes no value, but it changes what the settings
    // editor shows (the modified bar, the reset button): report those keys too (D128).
    const raw = [...new Set([...Object.keys(old), ...Object.keys(values)])].filter(
      (k) => JSON.stringify(old[k]) !== JSON.stringify(values[k]),
    );
    // A language block's keys are reported by their own names (editor.tabSize), so listeners
    // keyed on them re-read the per-language values.
    this.emitDiff(before, [...raw, ...changedOverrideKeys(old, values)]);
  }

  /** A copy of one scope's values as written in its file. */
  layerValues(scope: SettingsScope): Record<string, unknown> {
    return { ...this.layers[scope] };
  }

  /** Replaces the layer of the other workspace folders' settings.json (.vscode…, already translated). */
  setVscode(values: Record<string, unknown>): void {
    const before = this.snapshot();
    const old = this.vscode;
    this.vscode = { ...values };
    this.emitDiff(before, changedOverrideKeys(old, values));
  }

  /**
   * Replaces the team's defaults (already filtered: only keys a team may set). Above the built-in
   * defaults, below everything the user or a folder set. Read only: nothing writes this layer.
   */
  setTeam(values: Record<string, unknown>): void {
    const before = this.snapshot();
    const old = this.team;
    this.team = { ...values };
    // A key whose team value equals what it resolved to anyway changes no value, but it changes
    // what the settings editor says of it ("Set by your team"): report those too.
    const raw = [...new Set([...Object.keys(old), ...Object.keys(values)])].filter(
      (k) => !isLanguageOverrideKey(k) && JSON.stringify(old[k]) !== JSON.stringify(values[k]),
    );
    this.emitDiff(before, [...raw, ...changedOverrideKeys(old, values)]);
  }

  /** The team's defaults as they are held (for the settings editor and `ide://settings`). */
  teamValues(): Record<string, unknown> {
    return { ...this.team };
  }

  /**
   * The team's value for `key` when it may apply: valid, and not a setting only a folder sets.
   * A team's value is a default: it never passes the user's own or a folder's.
   */
  private teamValue(key: string, schema: SettingSchema): unknown {
    const value = this.team[key];
    return value !== undefined && schema.scope !== "workspace" && isValid(schema, value)
      ? value
      : undefined;
  }

  /**
   * Sets (or with null, drops) the settings of one folder of a multi-root workspace (D251): its
   * files' values for `getAt`. Fires the keys it sets or set, so editors showing its files re-read.
   */
  setFolderLayer(folder: string, values: Record<string, unknown> | null): void {
    const old = this.folders.get(folder) ?? {};
    if (values) this.folders.set(folder, { ...values });
    else this.folders.delete(folder);
    const now = values ?? {};
    const keys = new Set<string>();
    for (const k of new Set([...Object.keys(old), ...Object.keys(now)])) {
      if (JSON.stringify(old[k]) === JSON.stringify(now[k])) continue;
      if (isLanguageOverrideKey(k))
        for (const inner of changedOverrideKeys({ [k]: old[k] }, { [k]: now[k] })) keys.add(inner);
      else keys.add(k);
    }
    if (keys.size) this.changed.fire([...keys]);
  }

  /** The folders that have a layer (their keys). */
  folderLayers(): string[] {
    return [...this.folders.keys()];
  }

  /** One folder layer's values as written (for the settings editor). */
  folderValues(folder: string): Record<string, unknown> {
    return { ...(this.folders.get(folder) ?? {}) };
  }

  /** The value for a file of `folder` (a folder layer's key): its folder's setting first. */
  getAt<T = unknown>(key: string, folder: string | null | undefined): T {
    return this.resolveAt(key, folder).value as T;
  }

  resolveAt(
    key: string,
    folder: string | null | undefined,
  ): { value: unknown; source: SettingsSource | "folder" } {
    if (this.overrides[key] !== undefined) return this.resolve(key);
    const layer = folder ? this.folders.get(folder) : undefined;
    const value = layer?.[key];
    if (value !== undefined) {
      const schema = this.registry.get(key);
      if (!schema) return { value, source: "folder" };
      if (this.folderMaySet(schema) && isValid(schema, value)) {
        // An object setting: the folder's keys over everyone else's (D379).
        if (mergesObjects(schema, key) && isPlainObject(value))
          return {
            value: deepMergeObjects(this.resolve(key).value as Record<string, unknown>, value),
            source: "folder",
          };
        return { value, source: "folder" };
      }
    }
    return this.resolve(key);
  }

  /** `getForLanguage` for a file of `folder`: language blocks first (the folder's first), then plain values. */
  getForLanguageAt<T = unknown>(
    key: string,
    language: string | null | undefined,
    folder: string | null | undefined,
  ): T {
    const layer = folder ? this.folders.get(folder) : undefined;
    if (!layer) return this.getForLanguage<T>(key, language);
    const schema = this.registry.get(key);
    if (language) {
      const block = languageValues(layer, language)[key];
      if (block !== undefined && (!schema || (this.folderMaySet(schema) && isValid(schema, block))))
        return block as T;
      const other = this.resolveForLanguage(key, language);
      // A block the user or a folder wrote; a default's block (an extension's, the team's) waits.
      const isDefault = (source: string) => source === "default" || source === "team";
      if (other.language && !isDefault(other.source)) return other.value as T;
      // A default for the language only where neither the folder nor anyone else set it.
      const at = this.resolveAt(key, folder);
      if (other.language && isDefault(at.source)) return other.value as T;
      return at.value as T;
    }
    return this.getAt<T>(key, folder);
  }

  /**
   * Call after the registry changed (new defaults); `also`: keys whose language defaults changed
   * (the snapshot only compares plain values).
   */
  registryChanged(before: Record<string, unknown>, also: readonly string[] = []): void {
    this.emitDiff(before, also);
  }

  get<T = unknown>(key: string): T {
    return this.resolve(key).value as T;
  }

  /**
   * The value and the layer it came from. A value set for this run only (`setOverrides`) wins
   * and reads as the user's: the person chose it, on the command line.
   */
  resolve(key: string): { value: unknown; source: SettingsSource } {
    const schema = this.registry.get(key);
    const override = this.overrides[key];
    if (override !== undefined && (!schema || isValid(schema, override)))
      return { value: override, source: "user" };
    if (schema && mergesObjects(schema, key)) return this.resolveMerged(key, schema);
    if (schema) {
      const folder = this.folderMaySet(schema);
      const ws = this.layers.workspace[key];
      if (ws !== undefined && folder && isValid(schema, ws))
        return { value: ws, source: "workspace" };
      const vs = this.vscode[key];
      if (vs !== undefined && folder && isValid(schema, vs)) return { value: vs, source: "vscode" };
      const user = this.layers.user[key];
      if (user !== undefined && schema.scope !== "workspace" && isValid(schema, user))
        return { value: user, source: "user" };
      const team = this.teamValue(key, schema);
      if (team !== undefined) return { value: team, source: "team" };
      return { value: schema.default, source: "default" };
    }
    // Unknown keys (an extension that isn't installed) still resolve, unvalidated.
    const ws = this.layers.workspace[key];
    return ws !== undefined
      ? { value: ws, source: "workspace" }
      : { value: this.layers.user[key], source: "user" };
  }

  /**
   * An object setting's layers merged, as VS Code does (D379): a project's `files.exclude` adds to
   * the defaults (`.git` stays hidden) and the user's, instead of replacing them; a key set to
   * `false` still turns one off. The source is the highest layer that set it.
   */
  private resolveMerged(
    key: string,
    schema: SettingSchema,
  ): { value: unknown; source: SettingsSource } {
    const folder = this.folderMaySet(schema);
    let value = schema.default as Record<string, unknown>;
    let source: SettingsSource = "default";
    const over = (v: unknown, from: SettingsScope | "vscode" | "team") => {
      if (v === undefined || !isValid(schema, v) || !isPlainObject(v)) return;
      value = deepMergeObjects(value, v);
      source = from;
    };
    // The team's entries first: the user's and the folder's go over them.
    over(this.teamValue(key, schema), "team");
    if (schema.scope !== "workspace") over(this.layers.user[key], "user");
    if (folder) {
      over(this.vscode[key], "vscode");
      over(this.layers.workspace[key], "workspace");
    }
    return { value, source };
  }

  /** The effective value for documents of `language` (its blocks first, then the plain value). */
  getForLanguage<T = unknown>(key: string, language: string | null | undefined): T {
    return this.resolveForLanguage(key, language).value as T;
  }

  /**
   * The value for `language` and where it came from (`language: true` when a block set it). The
   * order is VS Code's: workspace block > the other folder's block > user block > the plain value.
   */
  resolveForLanguage(
    key: string,
    language: string | null | undefined,
  ): { value: unknown; source: SettingsSource; language: boolean } {
    if (language) {
      const schema = this.registry.get(key);
      const layers: [SettingsScope | "vscode", Record<string, unknown>][] = [
        ["workspace", this.layers.workspace],
        ["vscode", this.vscode],
        ["user", this.layers.user],
      ];
      for (const [source, layer] of layers) {
        const value = languageValues(layer, language)[key];
        if (value === undefined) continue;
        if (schema) {
          if (!isValid(schema, value)) continue;
          if (source !== "user" && !this.folderMaySet(schema)) continue;
          if (source === "user" && schema.scope === "workspace") continue;
        }
        return { value, source, language: true };
      }
    }
    const plain = this.resolve(key);
    // The team's block for the language: a default, so under any plain value the user or a
    // folder set, and above the team's own plain value and the built-in defaults.
    if (language && (plain.source === "default" || plain.source === "team")) {
      const schema = this.registry.get(key);
      const value = languageValues(this.team, language)[key];
      if (value !== undefined && schema && schema.scope !== "workspace" && isValid(schema, value))
        return { value, source: "team", language: true };
    }
    // An extension's default for the language (`configurationDefaults` "[python]"): above the
    // plain default, below anything the user or the folder set (VS Code's default layer).
    if (language && plain.source === "default") {
      const value = this.languageDefault(key, language);
      if (value !== undefined) return { value, source: "default", language: true };
    }
    return { ...plain, language: false };
  }

  /** The extensions' default for `key` in `language`'s files, if one sets it. */
  private languageDefault(key: string, language: string): unknown {
    return languageValues(this.registry.languageDefaults(), language)[key];
  }

  /** The value one scope's blocks set for `language` (undefined = none sets it). */
  inspectForLanguage(key: string, scope: SettingsScope, language: string): unknown {
    return languageValues(this.layers[scope], language)[key];
  }

  /** Languages that have a block in any layer (for `ide://settings`). */
  overriddenLanguages(): string[] {
    return [
      ...new Set([
        ...overriddenLanguages(this.layers.user),
        ...overriddenLanguages(this.layers.workspace),
        ...overriddenLanguages(this.vscode),
        ...overriddenLanguages(this.team),
      ]),
    ].sort();
  }

  /**
   * The raw value written in one scope's file (undefined = not set there); "vscode": the folder's
   * .vscode; "team": the team's default.
   */
  inspect(key: string, scope: SettingsScope | "vscode" | "team"): unknown {
    if (scope === "team") return this.team[key];
    return scope === "vscode" ? this.vscode[key] : this.layers[scope][key];
  }

  /** Effective values of every registered key. */
  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const s of this.registry.all()) out[s.key] = this.get(s.key);
    return out;
  }

  /** Syntax errors and invalid values, for `ide://settings` and the settings editor. */
  problems(): SettingsProblem[] {
    const out = [...this.parseProblems.user, ...this.parseProblems.workspace];
    for (const scope of ["user", "workspace"] as const) {
      for (const [key, value] of Object.entries(this.layers[scope])) {
        if (isLanguageOverrideKey(key)) {
          out.push(...this.blockProblems(scope, key, value));
          continue;
        }
        const schema = this.registry.get(key);
        if (!schema) continue;
        if (!isValid(schema, value))
          out.push({
            scope,
            key,
            message: `invalid value for ${key}; using the ${scope === "workspace" ? "user or default" : "default"} value`,
          });
        else if (schema.scope && schema.scope !== "both" && schema.scope !== scope)
          out.push({ scope, key, message: `${key} can only be set in ${schema.scope} settings` });
        else if (scope === "workspace" && schema.restricted && !this.trusted)
          out.push({
            scope,
            key,
            message: `${key} applies once the folder is trusted; the user value is used until then`,
          });
      }
    }
    return out;
  }

  private blockProblems(scope: SettingsScope, key: string, block: unknown): SettingsProblem[] {
    if (typeof block !== "object" || block === null || Array.isArray(block))
      return [{ scope, key, message: `${key} must be an object of settings` }];
    const out: SettingsProblem[] = [];
    const languages = overrideLanguages(key).join(", ");
    for (const [inner, value] of Object.entries(block as Record<string, unknown>)) {
      const schema = this.registry.get(inner);
      if (schema && !isValid(schema, value))
        out.push({
          scope,
          key: `${key}.${inner}`,
          message: `invalid value for ${inner} in ${key}; ${languages} files use the plain value`,
        });
    }
    return out;
  }

  private emitDiff(before: Record<string, unknown>, also: readonly string[] = []): void {
    const after = this.snapshot();
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changed = new Set(
      [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])),
    );
    for (const k of also) changed.add(k);
    if (changed.size > 0) this.changed.fire([...changed]);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Settings that are one thing, not a set of entries: replaced whole, never merged (a profile's
 * path from one layer with another layer's arguments would run the wrong shell).
 */
const WHOLE_OBJECTS = /^terminal\.automationProfile\./;

/** Object settings merge across layers (D379); every other type is replaced by the top layer. */
function mergesObjects(schema: SettingSchema, key: string): boolean {
  return (
    schema.type === "object" && isPlainObject(schema.default ?? {}) && !WHOLE_OBJECTS.test(key)
  );
}

/** `over` merged into `base`: objects key by key, anything else replaced. */
function deepMergeObjects(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isPlainObject(v) && isPlainObject(b) ? deepMergeObjects(b, v) : v;
  }
  return out;
}
