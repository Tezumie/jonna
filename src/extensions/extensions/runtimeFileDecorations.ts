// File decorations from an extension's code (D258: VS Code's registerFileDecorationProvider): a
// badge, a color and a tooltip on rows of the Explorer (and wherever the IDE's file decorations
// show). The IDE asks for decorations synchronously while it draws; this keeps what the
// extension answered per path and asks for the missing ones in a batch, then redraws. The
// extension says what changed (`fireDidChange`), and those paths are asked again.
import type { Disposable } from "../../core/lifecycle/index";
import { toDisposable } from "../../core/lifecycle/index";
import { themeToken } from "../../workbench/extensionDecorationTypes";
import type { FileDecoration, WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import type { ExtensionWorker } from "./workerHost";

const MAX_CACHED = 5000;
const BATCH = 200;
const BATCH_MS = 50;

interface Provider {
  cache: Map<string, FileDecoration | null>;
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  registration: Disposable;
}

export interface FileDecorationsDeps {
  services: WorkbenchServices;
  /** The running worker (decorations never start one). */
  running(): ExtensionWorker | null;
  need(permission: string, what: string): void;
}

/** One answer as the IDE's decoration: a 1–2 character badge, a theme color, a tooltip. */
export function toFileDecoration(raw: unknown): FileDecoration | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as { badge?: unknown; tooltip?: unknown; color?: unknown };
  const badge = typeof d.badge === "string" ? [...d.badge.trim()].slice(0, 2).join("") : "";
  const tooltip = typeof d.tooltip === "string" ? d.tooltip.slice(0, 500) : "";
  const color = typeof d.color === "string" ? themeToken(d.color) : undefined;
  if (!badge && !tooltip && !color) return null;
  return { ...(badge && { badge }), ...(tooltip && { tooltip }), ...(color && { color }) };
}

export class ExtensionFileDecorations implements Disposable {
  private readonly providers = new Map<string, Provider>();

  constructor(private readonly deps: FileDecorationsDeps) {}

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "decorations.register": {
        this.deps.need("fs.read", "decorate files");
        const id = String(p.id ?? "");
        this.providers.get(id)?.registration.dispose();
        const provider: Provider = {
          cache: new Map(),
          pending: new Set(),
          timer: null,
          registration: toDisposable(() => {}),
        };
        provider.registration = this.deps.services.decorations.register({
          decorate: (path) => this.decorate(id, provider, path),
        });
        this.providers.set(id, provider);
        return Promise.resolve(undefined);
      }
      case "decorations.changed": {
        const provider = this.providers.get(String(p.id ?? ""));
        if (!provider) return Promise.resolve(undefined);
        if (Array.isArray(p.paths)) for (const path of p.paths) provider.cache.delete(String(path));
        else provider.cache.clear();
        this.deps.services.decorations.changed();
        return Promise.resolve(undefined);
      }
      case "decorations.unregister": {
        const id = String(p.id ?? "");
        this.drop(id);
        return Promise.resolve(undefined);
      }
      default:
        return UNHANDLED;
    }
  }

  private decorate(id: string, provider: Provider, path: string): FileDecoration | undefined {
    const known = provider.cache.get(path);
    if (known !== undefined) return known ?? undefined;
    provider.pending.add(path);
    provider.timer ??= setTimeout(() => void this.fetch(id, provider), BATCH_MS);
    return undefined;
  }

  private async fetch(id: string, provider: Provider): Promise<void> {
    provider.timer = null;
    const paths = [...provider.pending].slice(0, BATCH);
    for (const path of paths) provider.pending.delete(path);
    if (provider.pending.size)
      provider.timer = setTimeout(() => void this.fetch(id, provider), BATCH_MS);
    const worker = this.deps.running();
    if (!worker || !paths.length) return;
    const answers = await worker
      .call<{ path: string; decoration: unknown }[]>("provider", `decorations.${id}`, { paths })
      .catch(() => null);
    if (!Array.isArray(answers) || this.providers.get(id) !== provider) return;
    if (provider.cache.size > MAX_CACHED) provider.cache.clear();
    for (const path of paths) provider.cache.set(path, null);
    for (const a of answers)
      if (a && typeof a.path === "string")
        provider.cache.set(a.path, toFileDecoration(a.decoration));
    this.deps.services.decorations.changed();
  }

  private drop(id: string): void {
    const provider = this.providers.get(id);
    if (!provider) return;
    if (provider.timer) clearTimeout(provider.timer);
    provider.registration.dispose();
    this.providers.delete(id);
  }

  /** The worker stopped: its decorations go. */
  workerGone(): void {
    for (const id of [...this.providers.keys()]) this.drop(id);
  }

  dispose(): void {
    this.workerGone();
  }
}
