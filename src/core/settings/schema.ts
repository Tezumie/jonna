// Contributed settings (PLAN §9.2 `contributes.settings`): a schema per key, the registry that
// collects them, and value validation (a bad value in settings.json falls back to the default
// instead of breaking the feature). DOM-free and unit-tested.

export type SettingType = "boolean" | "string" | "number" | "integer" | "array" | "object";

export interface SettingSchema {
  type: SettingType;
  default: unknown;
  description: string;
  /** Allowed values (strings or numbers) for a select control. */
  enum?: readonly (string | number)[];
  enumDescriptions?: readonly string[];
  minimum?: number;
  maximum?: number;
  /** Where it may be set; default both. Machine-specific things (e.g. bell) can be user-only. */
  scope?: "user" | "workspace" | "both";
  /**
   * VS Code's restricted settings (D209: terminal profiles, the automation profile): a folder's
   * settings set it only once the folder is trusted; until then the user's value applies.
   */
  restricted?: boolean;
  /** Sort order within its category (lower first). */
  order?: number;
  /** Shown under this category instead of the key's first word (e.g. AI features of the editor under "Agent"). */
  category?: string;
  /**
   * A group within its page, shown as a labelled card ("Execution and approvals"); settings
   * without one go in a card named after their category (D179).
   */
  section?: string;
  /** The row's title, when the one derived from the key reads badly ("Cache TTL"). */
  title?: string;
  /** Still read, but not shown in the settings editor (replaced by another setting). */
  deprecated?: boolean;
  /** Words the settings search finds with `@tag:` ("experimental", "accessibility"…). */
  tags?: readonly string[];
  /** The extension that contributes it (set when registered; `@ext:` in the settings search). */
  extension?: string;
}

export interface SettingInfo extends SettingSchema {
  key: string;
  /** "Editor", "Terminal"… derived from the key's first segment. */
  category: string;
  /** "Editor: Sticky scroll" style title derived from the key. */
  title: string;
}

/** Category names that are acronyms rather than words. */
const ACRONYMS: Record<string, string> = {
  mcp: "MCP",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  lsp: "Language servers",
  todoTree: "TODO tree",
};

/** Words written in capitals inside titles ("Ollama url" → "Ollama URL"). */
const UPPER = new Set([
  "url",
  "urls",
  "api",
  "ui",
  "html",
  "css",
  "json",
  "mcp",
  "ssh",
  "id",
  "ids",
  "ai",
]);

/** "editor.stickyScroll.enabled" → { category: "Editor", title: "Sticky scroll enabled" }. */
export function describeKey(key: string): { category: string; title: string } {
  const [first = key, ...rest] = key.split(".");
  const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  const named = words(first);
  const category = ACRONYMS[first] ?? named.charAt(0).toUpperCase() + named.slice(1);
  const tail = rest
    .map(words)
    .join(" ")
    .split(" ")
    .map((w) => (UPPER.has(w) ? w.toUpperCase() : w))
    .join(" ");
  const title = tail ? tail.charAt(0).toUpperCase() + tail.slice(1) : category;
  return { category, title };
}

/** True if `value` fits the schema. */
export function isValid(schema: SettingSchema, value: unknown): boolean {
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string" && (!schema.enum || schema.enum.includes(value));
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (schema.type === "integer" && !Number.isInteger(value)) return false;
      if (schema.enum && !schema.enum.includes(value)) return false;
      if (schema.minimum !== undefined && value < schema.minimum) return false;
      return schema.maximum === undefined || value <= schema.maximum;
    }
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** True for a language block's key (`[python]`, `[javascript][typescript]`). */
const LANGUAGE_BLOCK = /^\s*(\[[^[\]]+\]\s*)+$/;

/**
 * Whether an extension's default may replace this setting's (VS Code's configurationDefaults
 * take window, resource and language settings, not machine-wide ones): never one only the user
 * may set (programs, shells, servers) nor a restricted one (it would apply without asking).
 */
export function acceptsDefaultOverride(schema: SettingSchema): boolean {
  return schema.scope !== "user" && !schema.restricted;
}

export class SettingsRegistry {
  private readonly schemas = new Map<string, SettingInfo>();
  /**
   * Extensions' default values (VS Code's `contributes.configurationDefaults`), in the order they
   * were registered: a later one wins, objects merge. Kept for keys not registered yet, as VS
   * Code does, so an extension that loads later gets them.
   */
  private readonly defaultOverrides: { source: string; values: Record<string, unknown> }[] = [];
  /** Settings with their defaults overridden, computed once per change. */
  private readonly effective = new Map<string, SettingInfo>();
  /** The merged language blocks of the extensions' defaults (`"[python]": { … }`). */
  private languageDefaultsCache: Record<string, Record<string, unknown>> | null = null;
  private version = 0;

  /** Extensions that declared a setting another had declared first (VS Code's shared settings). */
  private readonly sharedOwners = new Map<string, string[]>();

  /**
   * `extension` declared `key` too (the first declaration stays): it may change it as its owner
   * does. The returned function takes that back (the extension unloads).
   */
  addOwner(key: string, extension: string): () => void {
    const list = this.sharedOwners.get(key) ?? [];
    list.push(extension);
    this.sharedOwners.set(key, list);
    return () => {
      const now = this.sharedOwners.get(key);
      const i = now?.indexOf(extension) ?? -1;
      if (!now || i < 0) return;
      now.splice(i, 1);
      if (!now.length) this.sharedOwners.delete(key);
    };
  }

  /** The extensions that declared `key`: the registering one first, then those sharing it. */
  owners(key: string): string[] {
    const first = this.schemas.get(key)?.extension;
    return [...(first ? [first] : []), ...(this.sharedOwners.get(key) ?? [])];
  }

  private changed(): void {
    this.version++;
    this.effective.clear();
    this.languageDefaultsCache = null;
  }

  /**
   * Registers an extension's default values (`source`: its id) for any setting — the IDE's,
   * another extension's or its own — and `[language]` blocks. They sit between the declared
   * default and the user's settings. The returned function takes them back.
   */
  registerDefaults(source: string, values: Readonly<Record<string, unknown>>): () => void {
    const entry = { source, values: { ...values } };
    this.defaultOverrides.push(entry);
    this.changed();
    return () => {
      const i = this.defaultOverrides.indexOf(entry);
      if (i < 0) return;
      this.defaultOverrides.splice(i, 1);
      this.changed();
    };
  }

  /** Which extension's default `key` has now (undefined: the declared one). */
  defaultSource(key: string): string | undefined {
    const schema = this.schemas.get(key);
    if (!schema || !acceptsDefaultOverride(schema)) return undefined;
    let source: string | undefined;
    for (const o of this.defaultOverrides)
      if (o.values[key] !== undefined && isValid(schema, o.values[key])) source = o.source;
    return source;
  }

  /** The default of `schema` after the extensions' overrides (VS Code's merge). */
  private overriddenDefault(key: string, schema: SettingInfo): unknown {
    if (!acceptsDefaultOverride(schema)) return schema.default;
    let value = schema.default;
    for (const o of this.defaultOverrides) {
      const next = o.values[key];
      // A value the setting can't take is ignored (the declared default stays).
      if (next === undefined || !isValid(schema, next)) continue;
      // An object setting's defaults merge, key by key (editor.semanticTokenColorCustomizations).
      value =
        schema.type === "object" && isPlainObject(next)
          ? { ...(isPlainObject(value) ? value : {}), ...next }
          : next;
    }
    return value;
  }

  /**
   * The extensions' default `[language]` blocks, merged (a later block's keys win; object values
   * merge), for the settings model's language lookups. Values a setting can't take, and settings
   * that refuse extension defaults, are left out.
   */
  languageDefaults(): Readonly<Record<string, Record<string, unknown>>> {
    if (this.languageDefaultsCache) return this.languageDefaultsCache;
    const out: Record<string, Record<string, unknown>> = {};
    for (const o of this.defaultOverrides)
      for (const [block, raw] of Object.entries(o.values)) {
        if (!LANGUAGE_BLOCK.test(block) || !isPlainObject(raw)) continue;
        const merged = out[block] ?? {};
        for (const [key, value] of Object.entries(raw)) {
          const schema = this.schemas.get(key);
          if (schema && (!acceptsDefaultOverride(schema) || !isValid(schema, value))) continue;
          const before = merged[key];
          merged[key] =
            isPlainObject(value) && (before === undefined || isPlainObject(before))
              ? { ...(before ?? {}), ...value }
              : value;
        }
        out[block] = merged;
      }
    this.languageDefaultsCache = out;
    return out;
  }

  /** Registers a manifest's settings. Duplicate keys throw (two owners would fight). */
  register(settings: Readonly<Record<string, SettingSchema>>): () => void {
    const keys = Object.keys(settings);
    for (const key of keys) {
      if (this.schemas.has(key)) throw new Error(`Setting already registered: ${key}`);
    }
    for (const [key, schema] of Object.entries(settings)) {
      const described = describeKey(key);
      this.schemas.set(key, {
        ...schema,
        key,
        ...described,
        category: schema.category ?? described.category,
        title: schema.title ?? described.title,
      });
    }
    this.changed();
    return () => {
      for (const key of keys) this.schemas.delete(key);
      this.changed();
    };
  }

  /** The setting, its `default` as the extensions' defaults have made it. */
  get(key: string): SettingInfo | undefined {
    const schema = this.schemas.get(key);
    if (!schema || !this.defaultOverrides.length) return schema;
    const cached = this.effective.get(key);
    if (cached) return cached;
    const value = this.overriddenDefault(key, schema);
    const info = value === schema.default ? schema : { ...schema, default: value };
    this.effective.set(key, info);
    return info;
  }

  /** All settings, by category then order then key. */
  all(): SettingInfo[] {
    return [...this.schemas.keys()]
      .flatMap((k) => this.get(k) ?? [])
      .sort(
        (a, b) =>
          a.category.localeCompare(b.category) ||
          (a.order ?? 100) - (b.order ?? 100) ||
          a.key.localeCompare(b.key),
      );
  }

  get changeCount(): number {
    return this.version;
  }

  /** JSON Schema for settings.json (Monaco's JSON service; Part B). */
  jsonSchema(scope: "user" | "workspace"): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    for (const s of this.all()) {
      if (scope === "workspace" && s.scope === "user") continue;
      properties[s.key] = {
        type: s.type,
        default: s.default,
        description: s.description,
        ...(s.enum && { enum: s.enum }),
        ...(s.enumDescriptions && { enumDescriptions: s.enumDescriptions }),
        ...(s.minimum !== undefined && { minimum: s.minimum }),
        ...(s.maximum !== undefined && { maximum: s.maximum }),
        ...(s.deprecated && { deprecationMessage: s.description }),
      };
    }
    return {
      type: "object",
      properties,
      // Language blocks (`"[python]": { … }`, D201) take the same settings.
      patternProperties: {
        "^\\s*(\\[[^\\[\\]]+\\]\\s*)+$": { type: "object", properties, additionalProperties: true },
      },
      additionalProperties: true,
    };
  }
}
