// The extension store (D254): Open VSX search, install and updates for VS Code extensions (their
// declarative parts: color and icon themes, grammars, snippets, settings, as with a .vsix). The
// Extensions view's filter box searches it too ("Open VSX" under the installed ones). An install
// downloads the .vsix checked against Open VSX's SHA-256 (Rust, extensions/store.rs) and installs
// it through extensions.installFromVsix, so it asks for the same permissions; an update installs
// the newer version over it. A result opens a page of its own (extensions.showStoreDetails,
// storePage.ts). Nothing is fetched until the user searches, installs, checks or opens a page —
// except the Recommended section's details (icon, downloads), fetched only while the Extensions
// view is shown and both the store and extensions.recommendations.enabled are on.

import { engineSatisfied } from "../../core/extensions/engine";
import {
  installedOnly,
  isEmptyQuery,
  matchesPublisher,
  parseExtensionQuery,
  publisherNamespaces,
  storeSortBy,
} from "../../core/extensions/extensionQuery";
import {
  extensionRefs,
  isNewerVersion,
  offeredUpdate,
  parseStoreDetails,
  parseStoreSearch,
  STORE_CATEGORIES,
  type StoreDetails,
  type StoreItem,
  storeVersions,
} from "../../core/extensions/openVsx";
import {
  parseExtensionsJson,
  type Recommendation,
  recommendationsFor,
  type WorkspaceRecommendations,
} from "../../core/extensions/recommendations";
import { VSCODE_VERSION } from "../../core/extensions/vscode/version";
import { extIpc } from "../../core/ipc/extensions";
import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { product } from "../../core/product";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { ExtensionManager } from "./manager";

type Register = WorkbenchServices["dispatcher"]["register"];

/** Extensions being downloaded and installed from the store now (their buttons say so). */
export const storeInstalling = signal<ReadonlySet<string>>(new Set());

/** What the Recommended section shows: each with Open VSX's details once fetched. */
export const storeRecommendations = signal<{
  items: (Recommendation & { details?: StoreItem })[];
  busy: boolean;
}>({ items: [], busy: false });

/**
 * Namespaces Open VSX marks as verified (lowercase), learned from searches, pages and update
 * checks: installed extensions' rows show the mark too, as VS Code's (D284).
 */
export const storeVerified = signal<ReadonlySet<string>>(new Set());

function noteVerified(items: readonly (StoreItem | null)[]): void {
  const known = storeVerified.peek();
  const add = items.filter(
    (i): i is StoreItem => !!i?.verified && !known.has(i.namespace.toLowerCase()),
  );
  if (add.length)
    storeVerified.value = new Set([...known, ...add.map((i) => i.namespace.toLowerCase())]);
}

/** Whether an extension's publisher is verified on Open VSX, as far as the window knows. */
export const isVerified = (id: string): boolean =>
  storeVerified.value.has((id.split(".")[0] ?? "").toLowerCase());

/** Open VSX's details per id for the window's life (null: not on Open VSX). */
const detailsCache = new Map<string, Promise<StoreDetails | null>>();

/** An extension's details on Open VSX (cached; a failed fetch is tried again next time). */
export function storeDetailsOf(id: string): Promise<StoreDetails | null> {
  const key = id.toLowerCase();
  const known = detailsCache.get(key);
  if (known) return known;
  const { namespace, name } = split(id);
  const parse = (text: string) => {
    const d = parseStoreDetails(text);
    noteVerified([d]);
    return d;
  };
  const load = extIpc.storeDetails(namespace, name).then(parse, (err: unknown) => {
    // Open VSX answers "not found" with a 404.
    if (/\b404\b/.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  });
  detailsCache.set(key, load);
  load.catch(() => detailsCache.delete(key));
  if (detailsCache.size > 300) detailsCache.delete(detailsCache.keys().next().value as string);
  return load;
}

export const storeEnabled = (services: WorkbenchServices) =>
  services.settings.peek<boolean>("extensions.store.enabled") !== false;

export const recommendationsEnabled = (services: WorkbenchServices) =>
  storeEnabled(services) &&
  services.settings.peek<boolean>("extensions.recommendations.enabled") !== false;

/** Source folders whose files (one level down) say what a workspace is, besides its top. */
const SOURCE_DIRS = ["src", "lib", "app", "cmd", "pkg", "source", "scripts"];
const MAX_PATHS = 600;

/** Files that say what kind of workspace it is: open editors, each folder's top and source folders. */
async function workspacePaths(services: WorkbenchServices): Promise<string[]> {
  const out: string[] = [];
  for (const t of services.dock.tabs("editor")) {
    const path = (t.viewState as { path?: unknown } | null)?.path;
    if (typeof path === "string") out.push(path);
  }
  for (const folder of services.workspace.folders.peek()) {
    const top = await fsIpc.listDir(folder.path).catch(() => []);
    for (const e of top) if (e.kind === "file" && !e.ignored) out.push(e.path);
    for (const dir of top.filter(
      (e) => e.kind === "dir" && !e.ignored && SOURCE_DIRS.includes(e.name.toLowerCase()),
    )) {
      const inner = await fsIpc.listDir(dir.path).catch(() => []);
      for (const e of inner) if (e.kind === "file" && !e.ignored) out.push(e.path);
      if (out.length > MAX_PATHS) break;
    }
    if (out.length > MAX_PATHS) break;
  }
  return out.slice(0, MAX_PATHS);
}

/** Each folder's `.vscode/extensions.json` (and the IDE's own folder's), when there is one. */
async function workspaceRecommendations(
  services: WorkbenchServices,
): Promise<WorkspaceRecommendations[]> {
  const out: WorkspaceRecommendations[] = [];
  const dirs = [".vscode", product.workspaceFolderName];
  for (const folder of services.workspace.folders.peek())
    for (const dir of dirs) {
      const bytes = await fsIpc
        .read(joinPath(joinPath(folder.path, dir), "extensions.json"))
        .catch(() => null);
      if (bytes) out.push(parseExtensionsJson(new TextDecoder().decode(bytes)));
    }
  return out;
}

let recommendationRun = 0;
/** Recommended ids Open VSX doesn't have (left out). */
const notOnStore = new Set<string>();

/** The workspace's own recommendations and its files', without installed or ignored ones (no network). */
async function recommendedHere(
  services: WorkbenchServices,
  manager: ExtensionManager,
): Promise<Recommendation[]> {
  const [workspace, paths] = await Promise.all([
    workspaceRecommendations(services),
    workspacePaths(services),
  ]);
  return recommendationsFor({
    workspace,
    paths,
    installed: new Set(manager.records.peek().map((r) => r.id)),
    ignored: services.settings.peek<string[]>("extensions.recommendations.ignored") ?? [],
  }).slice(0, 30);
}

/**
 * Works out the Recommended section again (`recommendedHere`), then Open VSX's details for each
 * (a few at a time); the ones Open VSX doesn't have are dropped. Only while recommendations are on.
 */
export async function refreshRecommendations(
  services: WorkbenchServices,
  manager: ExtensionManager,
): Promise<void> {
  const run = ++recommendationRun;
  if (!recommendationsEnabled(services)) {
    storeRecommendations.value = { items: [], busy: false };
    return;
  }
  const list = await recommendedHere(services, manager);
  if (run !== recommendationRun) return;
  // What's known already shows at once; the rest fills in.
  const before = new Map(storeRecommendations.peek().items.map((i) => [i.id.toLowerCase(), i]));
  const items: (Recommendation & { details?: StoreItem })[] = list.map((r) => {
    const known = before.get(r.id.toLowerCase())?.details;
    return known ? { ...r, details: known } : r;
  });
  storeRecommendations.value = { items, busy: items.some((i) => !i.details) };
  const missing = new Set<string>();
  for (let i = 0; i < items.length; i += 4) {
    const batch = items.slice(i, i + 4).filter((x) => !x.details);
    const got = await Promise.all(batch.map((x) => storeDetailsOf(x.id).catch(() => undefined)));
    if (run !== recommendationRun) return;
    batch.forEach((x, k) => {
      const d = got[k];
      if (d) x.details = d;
      // Not on Open VSX (null); a failed fetch (undefined) keeps it, without details.
      else if (d === null) {
        missing.add(x.id);
        notOnStore.add(x.id.toLowerCase());
      }
    });
    storeRecommendations.value = {
      items: items.filter((x) => !missing.has(x.id)),
      busy: i + 4 < items.length,
    };
  }
  storeRecommendations.value = { items: items.filter((x) => !missing.has(x.id)), busy: false };
}

/** What the view shows under "Open VSX": the last search, while one runs, or why it failed. */
export const storeResults = signal<{
  query: string;
  items: StoreItem[];
  total: number;
  busy: boolean;
  error?: string;
}>({ query: "", items: [], total: 0, busy: false });

/** Extensions whose newer version is on Open VSX (extensions.checkStoreUpdates). */
export const storeUpdates = signal<{ id: string; installed: string; latest: string }[]>([]);

/**
 * The update waiting for an installed extension, if any, and whether it's being installed: what
 * its row, page and menu show (Update / Update to x.y.z / Updating…, D284). Reads the signals.
 */
export function pendingUpdate(
  id: string,
): { installed: string; latest: string; installing: boolean } | undefined {
  const key = id.toLowerCase();
  const update = storeUpdates.value.find((u) => u.id.toLowerCase() === key);
  return update && { ...update, installing: storeInstalling.value.has(key) };
}

const enabled = storeEnabled;

/** `namespace.name` → its two parts (Open VSX resolves names without regard to case). */
function split(id: string): { namespace: string; name: string } {
  const at = id.indexOf(".");
  if (at <= 0 || at === id.length - 1) throw new Error(`"${id}" isn't namespace.name.`);
  return { namespace: id.slice(0, at), name: id.slice(at + 1) };
}

export async function searchStore(
  services: WorkbenchServices,
  query: string,
  opts: { category?: string; offset?: number; size?: number } = {},
): Promise<{ items: StoreItem[]; total: number }> {
  if (!enabled(services)) throw new Error("The extension store is off (extensions.store.enabled).");
  const q = query.trim();
  storeResults.value = { ...storeResults.peek(), query: q, busy: true };
  try {
    const r = parseStoreSearch(
      await extIpc.storeSearch(q, {
        ...(opts.category && { category: opts.category }),
        offset: opts.offset ?? 0,
        size: opts.size ?? 20,
        // Nothing typed (a category): the most used first.
        ...(!q && { sortBy: "downloadCount" }),
      }),
    );
    noteVerified(r.items);
    // A newer search may have started meanwhile: only the latest one shows.
    if (storeResults.peek().query === q) storeResults.value = { query: q, ...r, busy: false };
    return r;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (storeResults.peek().query === q)
      storeResults.value = { query: q, items: [], total: 0, busy: false, error };
    throw err;
  }
}

/**
 * What the Extensions view's search box asks Open VSX (D284), in VS Code's syntax
 * (`core/extensions/extensionQuery.ts`): the text with `@category:`, `@sort:`, `@popular` and
 * `@recentlyPublished`; `@id:` as that one extension; `publisher:` as the extensions of its
 * namespaces (Open VSX has no publisher filter: each namespace is searched and the results kept
 * by namespace). Filters of installed extensions only (`@installed`, `@disabled`…) ask nothing.
 * The results are keyed by the whole query, as typed.
 */
export async function searchStoreQuery(services: WorkbenchServices, raw: string): Promise<void> {
  const key = raw.trim();
  const q = parseExtensionQuery(key);
  if (!enabled(services) || isEmptyQuery(q) || installedOnly(q)) return;
  storeResults.value = { ...storeResults.peek(), query: key, busy: true };
  const sortBy = storeSortBy(q);
  const opts = { ...(q.category && { category: q.category }), ...(sortBy && { sortBy }) };
  try {
    let items: StoreItem[];
    let total: number;
    if (q.id) {
      const d = await storeDetailsOf(q.id);
      items = d ? [d] : [];
      total = items.length;
    } else if (q.publisher) {
      const publisher = q.publisher;
      const namespaces = publisherNamespaces(publisher).slice(0, 12);
      const found = new Map<string, StoreItem>();
      // A few at a time: Open VSX is a shared service.
      for (let i = 0; i < namespaces.length; i += 4) {
        const answers = await Promise.all(
          namespaces
            .slice(i, i + 4)
            .map((ns) =>
              extIpc
                .storeSearch(`${ns} ${q.text}`.trim(), { ...opts, size: 100 })
                .then(parseStoreSearch, () => ({ items: [] as StoreItem[], total: 0 })),
            ),
        );
        for (const r of answers)
          for (const item of r.items)
            if (matchesPublisher(publisher, item.namespace)) found.set(item.id, item);
      }
      items = [...found.values()];
      if (!sortBy) items.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
      total = items.length;
    } else {
      const text = [q.text, q.tag].filter(Boolean).join(" ");
      const r = parseStoreSearch(
        await extIpc.storeSearch(text, {
          ...opts,
          size: 30,
          // Nothing typed (a category, @popular): the most used first.
          ...(!text && !sortBy && { sortBy: "downloadCount" }),
        }),
      );
      items = r.items;
      total = r.total;
    }
    if (q.sort === "name")
      items = [...items].sort((a, b) => a.displayName.localeCompare(b.displayName));
    noteVerified(items);
    if (storeResults.peek().query === key)
      storeResults.value = { query: key, items, total, busy: false };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (storeResults.peek().query === key)
      storeResults.value = { query: key, items: [], total: 0, busy: false, error };
  }
}

export function registerStore(
  sub: DisposableStore,
  services: WorkbenchServices,
  manager: ExtensionManager,
  register: Register,
): void {
  const { dispatcher } = services;

  register({
    id: "extensions.searchStore",
    title: "Search the extension store",
    category: "Extensions",
    description:
      "Searches Open VSX (the open registry of VS Code extensions) for extensions: color and icon themes, grammars, snippets and settings work at once, and their code runs in Node.js once the user allows it (most of VS Code's API, D256). `category` narrows it (Themes, Snippets, Programming Languages…). Returns { items: [{ id, displayName, description, version, downloads, rating }], total }; install one with extensions.installFromStore { id }.",
    input: s.object({
      query: s.string().describe("Words to search for; empty with a category lists its most used"),
      category: s
        .string()
        .describe(`One of: ${STORE_CATEGORIES.join(", ")}`)
        .optional(),
      offset: s.integer({ min: 0 }).optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ query, category, offset }) => {
      const r = await searchStore(services, query, {
        ...(category && { category }),
        ...(offset !== undefined && { offset }),
      });
      return {
        total: r.total,
        items: r.items.map((i) => ({
          id: i.id,
          displayName: i.displayName,
          description: i.description,
          version: i.version,
          ...(i.downloads !== undefined && { downloads: i.downloads }),
          ...(i.rating !== undefined && { rating: i.rating }),
          installed: manager.get(i.id)?.manifest?.version ?? null,
        })),
      };
    },
  });

  /** Whether the user granted every permission an installed extension asks for. */
  const allGranted = async (id: string): Promise<boolean> => {
    const r = (await dispatcher.execute("extensions.list", {}).catch(() => null)) as {
      extensions?: { id: string; permissions: { asked: string[]; granted: string[] } }[];
    } | null;
    const e = r?.extensions?.find((x) => x.id === id);
    return !!e && e.permissions.asked.every((p) => e.permissions.granted.includes(p));
  };

  /** The extensions installed now (ids, lower-case). */
  const installedIds = async (): Promise<Set<string>> => {
    const r = (await dispatcher.execute("extensions.list", {}).catch(() => null)) as {
      extensions?: { id: string }[];
    } | null;
    return new Set((r?.extensions ?? []).map((e) => e.id.toLowerCase()));
  };

  /** Ids an Open VSX extension brings along: its dependencies, then its pack's members. */
  const companions = async (namespace: string, name: string, version: string) => {
    const text = await extIpc.storeDetails(namespace, name, version).catch(() => "{}");
    let details: { dependencies?: unknown; bundledExtensions?: unknown } = {};
    try {
      details = JSON.parse(text);
    } catch {}
    // Dependencies first (installed before it, as VS Code does), then its pack's members.
    return {
      dependencies: extensionRefs(details.dependencies).slice(0, 20),
      pack: extensionRefs(details.bundledExtensions).slice(0, 20),
    };
  };

  /**
   * The newest version whose `engines.vscode` accepts the VS Code version the shim follows (as
   * VS Code installs): the latest when it does, else an older release; undefined when Open VSX
   * can't say (the latest is tried).
   */
  const compatibleVersion = async (namespace: string, name: string) => {
    const read = async (v?: string) => {
      try {
        return JSON.parse(await extIpc.storeDetails(namespace, name, v)) as {
          version?: string;
          engines?: { vscode?: string };
          allVersions?: Record<string, string>;
        };
      } catch {
        return null;
      }
    };
    const latest = await read();
    if (!latest?.version || engineSatisfied(latest.engines?.vscode, VSCODE_VERSION))
      return undefined;
    const older = Object.keys(latest.allVersions ?? {})
      .filter((v) => v !== "latest" && v !== latest.version && /^\d+\.\d+\.\d+$/.test(v))
      .slice(0, 15);
    for (const v of older) {
      const d = await read(v);
      if (d?.version && engineSatisfied(d.engines?.vscode, VSCODE_VERSION)) return d.version;
    }
    throw new Error(
      `${namespace}.${name} ${latest.version} needs VS Code ${latest.engines?.vscode}, newer than the ${VSCODE_VERSION} the IDE supports, and no older release fits.`,
    );
  };

  register({
    id: "extensions.installFromStore",
    title: "Install from the extension store",
    category: "Extensions",
    description:
      "Installs an extension from Open VSX by id (namespace.name, from extensions.searchStore), the latest version unless `version` is given: downloads its .vsix, checks it against Open VSX's SHA-256, and installs it like Install from VSIX (the user grants what it asks for). Installing over an installed copy updates it. As in VS Code, the extensions it depends on and its extension pack's members are installed too (those not installed yet).",
    input: s.object({
      id: s.string().describe("namespace.name, e.g. dracula-theme.theme-dracula"),
      version: s.string().optional(),
      with: s
        .string()
        .describe("Comes with this extension the user allowed (its pack or a dependency)")
        .optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ id, version, with: given }, ctx) => {
      // Only the IDE (the user) says an install comes with another one: an extension asking for an
      // install still gets the permission question for what it installs.
      const along = ctx.caller.kind === "user" || ctx.caller.kind === "test" ? given : undefined;
      if (!enabled(services))
        throw new Error("The extension store is off (extensions.store.enabled).");
      const { namespace, name } = split(id);
      const key = id.toLowerCase();
      if (storeInstalling.peek().has(key)) throw new Error(`${id} is being installed already.`);
      storeInstalling.value = new Set([...storeInstalling.peek(), key]);
      const line = services.statusBar.add({
        id: "extensions.download",
        name: "Extension downloads",
        alignment: "left",
        priority: 95,
        text: () => `$(cloud-download) Downloading ${id}…`,
        tooltip: () => "From Open VSX",
      });
      let file: string | null = null;
      try {
        // As VS Code does: a release made for a newer VS Code isn't installed, an older one is.
        const fits = version ?? (await compatibleVersion(namespace, name));
        const got = await extIpc.storeDownload(namespace, name, fits);
        file = got.file;
        line.dispose();
        // What comes with it: VS Code's extensionDependencies (installed first, so it starts
        // with them there), then its extensionPack's members.
        const { dependencies, pack } = await companions(namespace, name, got.version);
        const added: string[] = [];
        const skipped: string[] = [];
        // The extension first: the user's one question (its permissions).
        const r = (await dispatcher.execute("extensions.installFromVsix", {
          file,
          ...(along && { with: along }),
        })) as { id: string | null; cancelled?: boolean };
        storeUpdates.value = storeUpdates.peek().filter((u) => u.id !== r.id);
        if (!r.id) return { id: null, cancelled: true };
        // What comes with it, under that answer (VS Code installs a pack's members and the
        // dependencies along, without asking again): allowed only if the user allowed its code.
        const allowed = await allGranted(r.id);
        const bring = async (list: readonly string[]) => {
          const installed = await installedIds();
          for (const other of list) {
            const k = other.toLowerCase();
            if (installed.has(k) || storeInstalling.peek().has(k)) continue;
            const dot = other.indexOf(".");
            // Not on Open VSX (Pylance: Microsoft's marketplace only): left out, quietly.
            const there = await extIpc.storeDetails(other.slice(0, dot), other.slice(dot + 1)).then(
              (t) => !(JSON.parse(t) as { error?: unknown }).error,
              () => false,
            );
            if (!there) {
              skipped.push(other);
              continue;
            }
            try {
              await dispatcher.execute("extensions.installFromStore", {
                id: other,
                ...(allowed && { with: r.id }),
              });
              added.push(other);
            } catch (err) {
              services.notifications.show(
                "warning",
                `${other} (which comes with ${id}) wasn't installed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        };
        await bring(dependencies);
        await bring(pack);
        if (added.length && !along)
          services.notifications.show(
            "success",
            `Also installed with ${id}: ${added.join(", ")}${skipped.length ? ` (${skipped.join(", ")} isn't on Open VSX)` : ""}.`,
          );
        return {
          id: r.id,
          version: got.version,
          ...(added.length && { alsoInstalled: added }),
          ...(skipped.length && { notOnOpenVsx: skipped }),
        };
      } finally {
        line.dispose();
        storeInstalling.value = new Set([...storeInstalling.peek()].filter((x) => x !== key));
        if (file) void extIpc.discardDownload(file).catch(() => {});
      }
    },
  });

  register({
    id: "extensions.checkStoreUpdates",
    title: "Check for extension updates",
    category: "Extensions",
    description:
      "Asks Open VSX for the latest version of each installed VS Code extension and lists the ones with a newer version. A version out for less than extensions.updateDelayHours (default 24) isn't offered yet: the newest one that is (if any) is. Update one with extensions.installFromStore { id }, or all with extensions.updateFromStore.",
    input: s.object({}),
    effects: ["read"],
    agent: "discoverable",
    run: async () => {
      if (!enabled(services))
        throw new Error("The extension store is off (extensions.store.enabled).");
      const candidates = manager.records
        .peek()
        .filter((r) => !r.dev && r.manifest && r.manifestFile?.endsWith("package.json"));
      const found: { id: string; installed: string; latest: string }[] = [];
      const delayHours = services.settings.peek<number>("extensions.updateDelayHours") ?? 24;
      // A few at a time: Open VSX is a shared service.
      for (let i = 0; i < candidates.length; i += 4) {
        const batch = candidates.slice(i, i + 4);
        const answers = await Promise.all(
          batch.map(async (r) => {
            const { namespace, name } = split(r.id);
            const text = await extIpc.storeDetails(namespace, name).catch(() => "");
            const latest = parseStoreDetails(text);
            noteVerified([latest]);
            const installed = r.manifest?.version ?? "";
            if (!latest || !isNewerVersion(latest.version, installed)) return null;
            // A brand-new version waits a day (D267): published by mistake or by someone who
            // took over the account, it's usually pulled by then.
            const offered = await offeredUpdate(
              installed,
              latest,
              storeVersions(text),
              async (v) =>
                parseStoreDetails(await extIpc.storeDetails(namespace, name, v)) ?? undefined,
              Date.now(),
              delayHours,
              // What installing would refuse (a release for a newer VS Code) isn't an update.
              (engine) => engineSatisfied(engine, VSCODE_VERSION),
            );
            return offered ? { id: r.id, installed, latest: offered } : null;
          }),
        );
        for (const a of answers) if (a) found.push(a);
      }
      storeUpdates.value = found;
      return { checked: candidates.length, updates: found };
    },
  });

  register({
    id: "extensions.updateFromStore",
    title: "Update extensions from the store",
    category: "Extensions",
    description:
      "Installs the newer version of every extension extensions.checkStoreUpdates found (or of `id` alone). Returns what was updated and what failed.",
    input: s.object({ id: s.string().optional() }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ id }) => {
      if (!storeUpdates.peek().length) await dispatcher.execute("extensions.checkStoreUpdates", {});
      const todo = storeUpdates.peek().filter((u) => !id || u.id === id);
      const updated: string[] = [];
      const failed: { id: string; error: string }[] = [];
      for (const u of todo) {
        try {
          await dispatcher.execute("extensions.installFromStore", { id: u.id, version: u.latest });
          updated.push(`${u.id} ${u.installed} → ${u.latest}`);
        } catch (err) {
          failed.push({ id: u.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { updated, failed };
    },
  });

  register({
    id: "extensions.browseThemes",
    title: "Browse color and icon themes",
    category: "Extensions",
    description:
      "Shows the Extensions view with Open VSX's most used themes (color and file icon themes) to install.",
    input: s.object({}),
    effects: [],
    run: async () => {
      await dispatcher.execute("extensions.show", { query: "@category:Themes" });
      return {};
    },
  });

  register({
    id: "extensions.showStoreDetails",
    title: "Show extension in the store",
    category: "Extensions",
    description:
      "Opens an Open VSX extension's page (like VS Code's extension editor), installed or not: its icon, publisher, downloads, rating and Install / Update button, then Details (README and facts: version, release date, size, categories, links), Features (what its package.json adds: commands, settings, themes, languages…) and Changelog. `id` is namespace.name from extensions.searchStore or ide://extensions/store.",
    input: s.object({
      id: s.string().describe("namespace.name, e.g. esbenp.prettier-vscode"),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: ({ id }) => {
      if (!enabled(services))
        throw new Error("The extension store is off (extensions.store.enabled).");
      split(id);
      const key = id.toLowerCase();
      // One tab per extension; opened from the list it's a preview the next one replaces.
      const open = services.dock
        .tabs("extension-store")
        .find((t) => String((t.viewState as { id?: unknown } | null)?.id).toLowerCase() === key);
      if (open) services.dock.activateTab(open.id, true);
      else services.dock.openView("extension-store", { id }, "main", true, { preview: true });
      return {};
    },
  });

  register({
    id: "extensions.ignoreRecommendation",
    title: "Ignore extension recommendation",
    category: "Extensions",
    description:
      "Stops recommending an extension in the Extensions view's Recommended section (adds it to the extensions.recommendations.ignored setting).",
    input: s.object({ id: s.string().describe("namespace.name") }),
    effects: ["write"],
    run: async ({ id }) => {
      const key = id.trim().toLowerCase();
      const list = services.settings.peek<string[]>("extensions.recommendations.ignored") ?? [];
      if (!list.some((x) => x.toLowerCase() === key))
        await services.settings.update(
          "extensions.recommendations.ignored",
          [...list, key],
          "user",
        );
      storeRecommendations.value = {
        ...storeRecommendations.peek(),
        items: storeRecommendations.peek().items.filter((i) => i.id.toLowerCase() !== key),
      };
      return {};
    },
  });

  sub.add(
    services.state.register("ide://extensions/store", {
      description:
        "The extension store (Open VSX): the last search's results, the installed extensions with a newer version there, and the extensions recommended for this workspace (its .vscode/extensions.json, and its kinds of files; details filled while the Extensions view is shown). Open one's page with extensions.showStoreDetails { id }, install with extensions.installFromStore { id }.",
      get: async () => {
        // Worked out here (no network) when the view hasn't yet; details come from the view's.
        const on = recommendationsEnabled(services);
        const known = new Map(storeRecommendations.value.items.map((r) => [r.id.toLowerCase(), r]));
        const list = on
          ? (await recommendedHere(services, manager)).filter(
              (r) => !notOnStore.has(r.id.toLowerCase()),
            )
          : [];
        return {
          enabled: enabled(services),
          search: storeResults.value,
          updates: storeUpdates.value,
          installing: [...storeInstalling.value],
          recommendations: {
            enabled: on,
            busy: storeRecommendations.value.busy,
            items: list.map((r) => {
              const d = known.get(r.id.toLowerCase())?.details;
              return {
                id: r.id,
                reason: r.reason,
                source: r.source,
                ...(d && {
                  displayName: d.displayName,
                  description: d.description,
                  version: d.version,
                  ...(d.downloads !== undefined && { downloads: d.downloads }),
                }),
              };
            }),
          },
        };
      },
    }),
  );
}
