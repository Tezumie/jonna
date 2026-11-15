// What each external agent reported last time (its models and reasoning levels), so the model
// menu can show them before the agent has started. Kept in the app's global state through the
// persistence service, which exists with or without a window.
//
// It used to live in the web view's own storage. Values found there are taken over once, the
// first time the cache is used in a window: the saved state's own values win, the rest are
// written to it, and only once that write has succeeded are they removed from the web view's
// storage.
//
// DOM-free: the web view's storage is only looked at where there is one.

import type { AcpSetting } from "../../core/acp/client";
import type { WorkbenchServices } from "../../workbench/services";

/** The prefix of the keys the web view's storage held (one per agent). */
const OLD_PREFIX = "ide.acpSettings.";

/**
 * This window's view of the cache, ahead of the saved state: what was just reported, and what
 * was taken over from the old place, are there at once (saving is asynchronous).
 */
const fresh = new WeakMap<WorkbenchServices, Map<string, AcpSetting[]>>();

/** The web view's storage, where there is one; null otherwise. */
function oldStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A web view may refuse access to its storage.
    return null;
  }
}

/** Every agent's settings in the old place, with the keys they are under. */
function readOld(storage: Storage): { keys: string[]; settings: Record<string, AcpSetting[]> } {
  const keys: string[] = [];
  const settings: Record<string, AcpSetting[]> = {};
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(OLD_PREFIX)) continue;
    keys.push(key);
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null") as unknown;
      if (Array.isArray(value)) settings[key.slice(OLD_PREFIX.length)] = value as AcpSetting[];
    } catch {
      // A damaged entry is dropped with the rest.
    }
  }
  return { keys, settings };
}

/** This window's cache; the first call takes over what the old place holds. */
function cacheOf(services: WorkbenchServices): Map<string, AcpSetting[]> {
  const existing = fresh.get(services);
  if (existing) return existing;
  const cache = new Map<string, AcpSetting[]>();
  fresh.set(services, cache);
  const storage = oldStorage();
  if (!storage) return cache;
  let old: ReturnType<typeof readOld>;
  try {
    old = readOld(storage);
  } catch {
    return cache;
  }
  if (!old.keys.length) return cache;
  const saved = services.persistence.globalState().acpSettings ?? {};
  for (const [agent, settings] of Object.entries(old.settings))
    if (!(agent in saved)) cache.set(agent, settings);
  void services.persistence
    .saveGlobalChecked((current) => ({
      acpSettings: { ...old.settings, ...(current.acpSettings ?? {}) },
    }))
    .then((written) => {
      // Not written (the file locked, the disk full): the old copies are the only ones on disk,
      // so they stay, and the next window takes them over again.
      if (!written) return;
      // Written (or already there): the old copies go, so this runs once.
      for (const key of old.keys) {
        try {
          storage.removeItem(key);
        } catch {
          // Left there: taken over again next time, to the same result.
        }
      }
    })
    .catch(() => {});
  return cache;
}

/** The settings `agent` reported last time (for the model menu before it starts). */
export function cachedSettings(services: WorkbenchServices, agent: string): AcpSetting[] | null {
  const now = cacheOf(services).get(agent);
  if (now) return now;
  const saved = services.persistence.globalState().acpSettings?.[agent];
  return Array.isArray(saved) ? (saved as AcpSetting[]) : null;
}

/** Keeps what `agent` reported now, for next time. */
export function rememberSettings(
  services: WorkbenchServices,
  agent: string,
  settings: AcpSetting[],
): void {
  // Reported again as it was (every start reports): nothing to write.
  if (JSON.stringify(cachedSettings(services, agent)) === JSON.stringify(settings)) return;
  cacheOf(services).set(agent, settings);
  void services.persistence
    .saveGlobal((current) => ({
      acpSettings: { ...(current.acpSettings ?? {}), [agent]: settings },
    }))
    .catch(() => {});
}
