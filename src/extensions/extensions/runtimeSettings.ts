// What an extension keeps, apart from runtime.ts because declaring, reading and following
// settings are read together, and its storage is the other half of what outlives a run: the
// settings its manifest declares (and its defaults for others), `settings.get` /
// `settings.subscribe` within what it may read, and `storage.*` (globalState and
// workspaceState, one JSON file per extension, saved a moment after a change).
import { toSettingSchemas } from "../../core/extensions/index";
import {
  canReadSetting,
  isBlockedSetting,
  matchesReadsSettings,
} from "../../core/extensions/settingsAccess";
import { inClaimedNamespace, type ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { extIpc } from "../../core/ipc/extensions";
import { type Disposable, type DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import { acceptsDefaultOverride } from "../../core/settings/schema";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import type { ExtensionWorker, LogLine } from "./workerHost";

export interface SettingsDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  /** The runtime's store: its settings go with the extension. */
  store: DisposableStore;
  /** It ships with the IDE (installed as shipped): may use the namespaces its manifest claims. */
  shipped: boolean;
  /** The running worker (a changed setting never starts one). */
  running(): ExtensionWorker | null;
  log(line: LogLine): void;
  /** A storage key: its own, or (workspaceState) under the workspace's location (D234, D251). */
  storageKey(p: Record<string, unknown>): string;
}

/** The requests answered here. */
const REQUESTS: ReadonlySet<string> = new Set([
  "settings.get",
  "settings.subscribe",
  "storage.get",
  "storage.set",
]);

export class ExtensionSettingsHost {
  private storage: Record<string, unknown> | null = null;
  private storageTimer = 0;
  private settingsWatch: Disposable | null = null;

  constructor(private readonly deps: SettingsDeps) {}

  /**
   * Its settings and its defaults for others (VS Code's `configurationDefaults`). A setting the
   * IDE or another extension declared already is shared, as in VS Code: the first declaration
   * (and its default) stays, and both extensions may change it (python.defaultInterpreterPath,
   * the IDE's and ms-python's).
   */
  registerSettings(warn: (text: string) => void): void {
    const { manifest } = this.deps;
    const c = manifest.contributes;
    const registry = this.deps.services.settings.registry;
    const settings = Object.fromEntries(
      Object.entries(c.settings).filter(([key, setting]) => {
        if (!this.deps.shipped && inClaimedNamespace(manifest, key)) {
          warn(`Setting ${key} skipped: only extensions that come with the IDE may use that name.`);
          return false;
        }
        const existing = registry.get(key);
        if (!existing) return true;
        if (existing.extension === manifest.id) return false;
        const differs = JSON.stringify(existing.default) !== JSON.stringify(setting.default);
        warn(
          `Setting ${key} is declared already (by ${existing.extension ?? "the IDE"}): it's shared${
            differs ? `, with that declaration's default (${JSON.stringify(existing.default)})` : ""
          }.`,
        );
        // Only a VS Code package shares another's setting (an extension of the IDE's own format
        // can't declare one outside its names).
        if (manifest.format === "vscode")
          this.deps.store.add(toDisposable(registry.addOwner(key, manifest.id)));
        return false;
      }),
    );
    if (Object.keys(settings).length)
      this.deps.store.add(
        this.deps.services.settings.register(toSettingSchemas(manifest.id, settings)),
      );
    const defaults = c.configurationDefaults;
    if (!defaults) return;
    // VS Code's rule: no defaults for machine-wide settings (here: user-only and restricted ones,
    // which start programs), nor for the areas that hold credentials.
    const takes = (key: string, where = "") => {
      const schema = registry.get(key);
      const refused =
        isBlockedSetting(key) || (schema !== undefined && !acceptsDefaultOverride(schema));
      if (refused)
        warn(
          `Default for ${key}${where} skipped: only defaults for window, resource and language settings are taken (not ones that start programs or hold credentials).`,
        );
      return !refused;
    };
    const accepted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(defaults)) {
      if (!/^\s*\[/.test(key)) {
        if (takes(key)) accepted[key] = value;
        continue;
      }
      // A language block: the same rule for each of its settings.
      const block = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(([inner]) =>
          takes(inner, ` in ${key}`),
        ),
      );
      if (Object.keys(block).length) accepted[key] = block;
    }
    if (Object.keys(accepted).length)
      this.deps.store.add(this.deps.services.settings.registerDefaults(manifest.id, accepted));
  }

  /** One of the requests above, or UNHANDLED. */
  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    return REQUESTS.has(method) ? this.answer(method, p) : UNHANDLED;
  }

  private async answer(method: string, p: Record<string, unknown>): Promise<unknown> {
    const { services } = this.deps;
    switch (method) {
      case "settings.get": {
        const key = String(p.key);
        if (!this.readableSetting(key))
          throw new Error(
            `${key}: extensions can read their own settings, editor/workbench/files ones and those their manifest lists in "readsSettings" (never credentials).`,
          );
        return services.settings.peek(key) ?? null;
      }
      case "settings.subscribe":
        this.watchSettings();
        return undefined;
      case "storage.get":
        return (await this.loadStorage())[this.deps.storageKey(p)];
      case "storage.set": {
        const data = await this.loadStorage();
        const key = this.deps.storageKey(p);
        if (p.value === undefined || p.value === null) delete data[key];
        else data[key] = p.value;
        this.saveStorageSoon();
        return undefined;
      }
      default:
        throw new Error(`Unknown request ${method}.`);
    }
  }

  private readableSetting(key: string): boolean {
    return canReadSetting(
      Object.keys(this.deps.manifest.contributes.settings),
      this.deps.manifest.readsSettings,
      key,
    );
  }

  /** The keys `settings.onChange` reports: its own, and what `readsSettings` names (D202). */
  private watchedSettingKeys(): string[] {
    const own = Object.keys(this.deps.manifest.contributes.settings);
    const reads = this.deps.manifest.readsSettings;
    if (!reads.length) return own;
    const known = this.deps.services.settings.registry.all().map((s) => s.key);
    const exact = reads.filter((r) => !r.endsWith(".*"));
    const listed = [...new Set([...exact, ...known])].filter(
      (k) => matchesReadsSettings(reads, k) && this.readableSetting(k),
    );
    return [...new Set([...own, ...listed])];
  }

  private watchSettings(): void {
    if (this.settingsWatch) return;
    const snapshot = () =>
      new Map(
        this.watchedSettingKeys().map(
          (k) => [k, JSON.stringify(this.deps.services.settings.peek(k)) ?? ""] as const,
        ),
      );
    let seen = snapshot();
    this.settingsWatch = this.deps.store.add(
      effect(() => {
        this.deps.services.settings.version.value;
        // A setting registered later (another extension's) counts from then on.
        const now = snapshot();
        const changed = [...now]
          .filter(([k, v]) => seen.has(k) && seen.get(k) !== v)
          .map(([k]) => k);
        seen = now;
        if (changed.length) this.deps.running()?.notify("settings", "", changed);
        return undefined;
      }),
    );
  }

  private async loadStorage(): Promise<Record<string, unknown>> {
    if (!this.storage) {
      const text = await extIpc.storageLoad(this.deps.manifest.id).catch(() => "{}");
      try {
        const parsed = JSON.parse(text || "{}") as unknown;
        this.storage =
          parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
      } catch {
        this.storage = {};
      }
    }
    return this.storage;
  }

  private saveStorageSoon(): void {
    window.clearTimeout(this.storageTimer);
    this.storageTimer = window.setTimeout(() => void this.saveStorage(), 300);
  }

  private async saveStorage(): Promise<void> {
    if (!this.storage) return;
    await extIpc
      .storageSave(this.deps.manifest.id, JSON.stringify(this.storage))
      .catch((err: unknown) =>
        this.deps.log({ time: Date.now(), level: "error", text: `storage: ${String(err)}` }),
      );
  }

  /** Saves storage still waiting to be saved (the extension is stopping); null when none is. */
  flushStorage(): Promise<void> | null {
    if (!this.storageTimer) return null;
    window.clearTimeout(this.storageTimer);
    return this.saveStorage();
  }
}
