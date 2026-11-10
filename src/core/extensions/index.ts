// Extension host for built-in extensions (tier 3, in-process; PLAN §9.1). Each built-in is a
// manifest (`extension.json`, same shape third-party extensions will use) plus a module with
// `activate(ctx)`. The host validates manifests, activates in order, collects contributed
// keybindings, and checks (in dev) that every contributed command was actually registered.
// The sandboxed worker tier for third-party extensions is Milestone 6.
import type { KeybindingRule } from "../keybindings/index";
import { type Disposable, DisposableStore } from "../lifecycle/index";
import type { SettingSchema, SettingType } from "../settings/schema";

/** A setting as written in extension.json (strings are checked when collected). */
export type ManifestSetting = Omit<SettingSchema, "type" | "scope" | "enum"> & {
  type: string;
  scope?: string;
  enum?: (string | number)[];
};

const SETTING_TYPES: readonly SettingType[] = [
  "boolean",
  "string",
  "number",
  "integer",
  "array",
  "object",
];

export interface ManifestCommand {
  id: string;
  title: string;
  category?: string;
}

export interface ManifestView {
  id: string;
  title: string;
  /** "sidebar" | "panel" | "auxiliary" (checked by validateManifest). */
  location: string;
}

export interface ExtensionManifest {
  id: string;
  version: string;
  displayName?: string;
  description?: string;
  engines?: Record<string, string>;
  /** M1 built-ins all use ["*"] (activate at startup). */
  activation: string[];
  permissions?: string[];
  contributes?: {
    commands?: ManifestCommand[];
    keybindings?: KeybindingRule[];
    views?: ManifestView[];
    /** Setting key → schema (shown in the settings editor, validated, defaults). */
    settings?: Record<string, ManifestSetting>;
    /** Server name → how to start a language server and which languages it serves. */
    languageServers?: Record<string, LanguageServerContribution>;
  };
}

export interface LanguageServerContribution {
  command: string;
  args?: string[];
  /** Language ids (the editor's, e.g. "rust", "python", "tsx"). */
  languages: string[];
  initializationOptions?: unknown;
  /** Answers for workspace/configuration requests, by section (e.g. { "rust-analyzer": {…} }). */
  settings?: Record<string, unknown>;
  description?: string;
  /** Its name as people know it ("Pyright"); default: the server's key. */
  title?: string;
  /** Ways to install it, first that works on this machine wins (D199, lsp/install.ts). */
  install?: InstallMethod[];
  /**
   * Extensions that serve its languages themselves (Pyrefly, ms-python for Python): while one is
   * enabled, this server doesn't start (one set of diagnostics, hovers and completions, as in
   * VS Code, which has no built-in server for them). An entry may name a setting of that
   * extension's that turns its server off. `lsp.servers.<name>.yieldTo: []` keeps it running.
   */
  yieldTo?: (string | { extension: string; unlessSetting?: Record<string, unknown> })[];
}

/** One way to install a language server: a package manager and the package. */
export interface InstallMethod {
  tool: "npm" | "pip" | "go" | "rustup" | "dotnet" | "gem" | "brew" | "winget";
  package: string;
  /** Only on these platforms ("windows", "mac", "linux"); default all. */
  platforms?: string[];
}

export interface ExtensionContext<S> {
  readonly manifest: ExtensionManifest;
  /** Everything registered here is disposed when the extension deactivates. */
  readonly subscriptions: DisposableStore;
  readonly services: S;
}

export interface BuiltinExtension<S> {
  manifest: ExtensionManifest;
  activate(ctx: ExtensionContext<S>): void | Promise<void>;
}

export interface ActivatedExtension {
  id: string;
  activationMs: number;
  error?: string;
}

/** Throws a readable error if the manifest is malformed. */
export function validateManifest(value: unknown): ExtensionManifest {
  const errors: string[] = [];
  const m = value as Partial<ExtensionManifest> | null;
  if (!m || typeof m !== "object") throw new Error("Extension manifest must be an object");
  if (typeof m.id !== "string" || !/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(m.id)) {
    errors.push(`invalid id ${JSON.stringify(m.id)} (expected "publisher.name")`);
  }
  if (typeof m.version !== "string") errors.push("missing version");
  if (!Array.isArray(m.activation)) errors.push("missing activation array");
  for (const cmd of m.contributes?.commands ?? []) {
    if (typeof cmd.id !== "string" || typeof cmd.title !== "string")
      errors.push("command needs id and title");
  }
  for (const view of m.contributes?.views ?? []) {
    if (!["sidebar", "panel", "auxiliary"].includes(view.location)) {
      errors.push(`view ${view.id}: location must be sidebar, panel or auxiliary`);
    }
  }
  for (const kb of m.contributes?.keybindings ?? []) {
    if (typeof kb.key !== "string" || typeof kb.command !== "string")
      errors.push("keybinding needs key and command");
  }
  if (errors.length > 0) throw new Error(`Invalid manifest ${String(m.id)}: ${errors.join("; ")}`);
  return m as ExtensionManifest;
}

/** Settings as written in a manifest → registry schemas (unknown types are skipped with a warning). */
export function toSettingSchemas(
  extensionId: string,
  contributed: Readonly<Record<string, ManifestSetting>>,
): Record<string, SettingSchema> {
  const out: Record<string, SettingSchema> = {};
  for (const [key, s] of Object.entries(contributed)) {
    if (!SETTING_TYPES.includes(s.type as SettingType)) {
      console.warn(`${extensionId}: setting ${key} has unknown type ${s.type}`);
      continue;
    }
    const scope = s.scope === "user" || s.scope === "workspace" ? s.scope : "both";
    out[key] = { ...s, type: s.type as SettingType, scope, extension: extensionId };
  }
  return out;
}

export class ExtensionHost<S> implements Disposable {
  private readonly store = new DisposableStore();
  private readonly activated: ActivatedExtension[] = [];
  private readonly ids = new Set<string>();

  constructor(
    private readonly services: S,
    private readonly hasCommand: (id: string) => boolean,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** All contributed settings schemas. */
  settings(extensions: readonly BuiltinExtension<S>[]): Record<string, SettingSchema>[] {
    return extensions.flatMap((e) => {
      const contributed = e.manifest.contributes?.settings;
      return contributed ? [toSettingSchemas(e.manifest.id, contributed)] : [];
    });
  }

  /** All contributed keybindings, in activation order (later extensions win ties). */
  /** Contributed language servers by name (later extensions override earlier ones). */
  languageServers(
    extensions: readonly BuiltinExtension<S>[],
  ): Record<string, LanguageServerContribution & { extension: string }> {
    const out: Record<string, LanguageServerContribution & { extension: string }> = {};
    for (const e of extensions)
      for (const [name, server] of Object.entries(e.manifest.contributes?.languageServers ?? {}))
        if (typeof server.command === "string" && Array.isArray(server.languages))
          out[name] = { ...server, extension: e.manifest.id };
    return out;
  }

  keybindings(extensions: readonly BuiltinExtension<S>[]): KeybindingRule[] {
    return extensions.flatMap((e) => e.manifest.contributes?.keybindings ?? []);
  }

  /**
   * Activates extensions in order. A failing extension is reported and skipped so one bug
   * doesn't take down the whole IDE.
   */
  async activateAll(extensions: readonly BuiltinExtension<S>[]): Promise<ActivatedExtension[]> {
    for (const ext of extensions) {
      const manifest = validateManifest(ext.manifest);
      if (this.ids.has(manifest.id)) throw new Error(`Duplicate extension id ${manifest.id}`);
      this.ids.add(manifest.id);
      const start = this.now();
      const subscriptions = this.store.add(new DisposableStore());
      try {
        await ext.activate({ manifest, subscriptions, services: this.services });
        const missing = (manifest.contributes?.commands ?? []).filter(
          (c) => !this.hasCommand(c.id),
        );
        if (missing.length > 0) {
          throw new Error(
            `contributes commands it did not register: ${missing.map((c) => c.id).join(", ")}`,
          );
        }
        this.activated.push({ id: manifest.id, activationMs: this.now() - start });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Extension ${manifest.id} failed to activate: ${message}`);
        this.activated.push({ id: manifest.id, activationMs: this.now() - start, error: message });
      }
    }
    return [...this.activated];
  }

  get status(): readonly ActivatedExtension[] {
    return this.activated;
  }

  dispose(): void {
    this.store.dispose();
  }
}
