// Searching a multi-root workspace (D251, VS Code's): include / exclude globs may start with a
// workspace folder's name ("api/**", "./api/src") and then mean "in that folder"; other globs apply
// in every folder. Each folder can have its own search.exclude / files.exclude, so a search can
// become several runs (folders with the same options share one), run one after the other and
// reported as one result set. DOM-free, tested.
import type { SearchEvent, SearchOptions } from "../../core/ipc/fs";

export interface SearchFolder {
  path: string;
  name: string;
}

/** One search call: these folders (undefined: every workspace folder) with these options. */
export interface SearchRun {
  roots?: string[];
  options: SearchOptions;
}

/**
 * `glob` split into a workspace folder and the rest of the glob, when it starts with a folder's
 * name ("./api/src/**" → api, "src/**"; "api" → api, ""); null for a glob that applies in every
 * folder (or with one folder, where nothing changes).
 */
export function splitFolderGlob(
  glob: string,
  folders: readonly SearchFolder[],
): { folder: SearchFolder; rest: string } | null {
  if (folders.length < 2) return null;
  const clean = glob
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
  const cut = clean.indexOf("/");
  const head = cut < 0 ? clean : clean.slice(0, cut);
  const folder = folders.find((f) => f.name === head);
  if (!folder) return null;
  return { folder, rest: cut < 0 ? "" : clean.slice(cut + 1).replace(/^\/+/, "") };
}

/** A folder's share of `globs`: the rests of the ones naming it, and the ones naming none. */
function globsFor(
  globs: readonly string[],
  folder: SearchFolder,
  folders: readonly SearchFolder[],
): { own: string[]; general: string[]; named: boolean } {
  const own: string[] = [];
  const general: string[] = [];
  let named = false;
  for (const g of globs) {
    if (!g.trim()) continue;
    const split = splitFolderGlob(g, folders);
    if (!split) general.push(g);
    else if (split.folder === folder) own.push(split.rest);
    else named = true;
  }
  return { own, general, named: named || own.length > 0 };
}

/**
 * `options` for one folder: include globs naming it lose the folder's name ("api/**" → "**"; the
 * bare name: all of it), ones naming another folder are dropped, the rest stay (they're OR-ed, as
 * in one folder). Null when the folder isn't searched: the include globs all name other folders,
 * or an exclude glob is the whole folder.
 */
export function folderOptions(
  options: SearchOptions,
  folder: SearchFolder,
  folders: readonly SearchFolder[],
): SearchOptions | null {
  const inc = globsFor(options.include, folder, folders);
  const exc = globsFor(options.exclude, folder, folders);
  if (exc.own.some((g) => !g || g === "**")) return null;
  let include: string[];
  if (inc.own.length) include = inc.own.some((g) => !g) ? [] : [...inc.own, ...inc.general];
  else if (inc.named && !inc.general.length) return null;
  else include = inc.general;
  return { ...options, include, exclude: [...exc.own, ...exc.general] };
}

/**
 * The runs of a search over `folders`, each given its own options (`optionsOf`: the folder's
 * settings applied): folders with the same options share a run, in folder order. When every
 * folder ends up with the options as given, one run over the whole workspace (no `roots`).
 */
export function planSearch(
  folders: readonly SearchFolder[],
  optionsOf: (folder: SearchFolder) => SearchOptions,
): SearchRun[] {
  const runs: SearchRun[] = [];
  const byKey = new Map<string, SearchRun>();
  let searched = 0;
  for (const folder of folders) {
    const options = folderOptions(optionsOf(folder), folder, folders);
    if (!options) continue;
    searched++;
    const key = JSON.stringify(options);
    const run = byKey.get(key);
    if (run) run.roots?.push(folder.path);
    else {
      const next: SearchRun = { roots: [folder.path], options };
      byKey.set(key, next);
      runs.push(next);
    }
  }
  const only = runs[0];
  if (runs.length === 1 && only && searched === folders.length) delete only.roots;
  return runs;
}

/**
 * Runs `runs` one after the other into `sink` as one search: the files as they come, then one
 * `done` with the totals. Each run gets what's left of the result limit; a cancelled run (a newer
 * search, search.cancel) or `isCurrent()` turning false ends the chain. Resolves once the first
 * run has started (its error rejects); a later run's error goes to `onError`.
 */
export async function chainSearches(
  runs: readonly SearchRun[],
  sink: (event: SearchEvent) => void,
  start: (
    options: SearchOptions,
    onEvent: (event: SearchEvent) => void,
    roots: string[] | undefined,
  ) => Promise<void>,
  opts: { isCurrent: () => boolean; onError: (err: unknown) => void },
): Promise<void> {
  const total = { files: 0, matches: 0, truncated: false, cancelled: false, durationMs: 0 };
  const finish = () => sink({ kind: "done", ...total });
  const limit = runs[0]?.options.maxResults;
  const begin = (i: number): Promise<void> => {
    const run = runs[i];
    if (!run) {
      finish();
      return Promise.resolve();
    }
    const left = limit === undefined ? undefined : limit - total.matches;
    if (left !== undefined && left <= 0) {
      total.truncated = true;
      finish();
      return Promise.resolve();
    }
    const options = left === undefined ? run.options : { ...run.options, maxResults: left };
    return start(
      options,
      (event) => {
        if (event.kind === "file") {
          sink(event);
          return;
        }
        total.files += event.files;
        total.matches += event.matches;
        total.truncated ||= event.truncated;
        total.cancelled ||= event.cancelled;
        total.durationMs += event.durationMs;
        if (event.cancelled || !opts.isCurrent()) {
          finish();
          return;
        }
        begin(i + 1).catch((err: unknown) => {
          opts.onError(err);
          finish();
        });
      },
      run.roots,
    );
  };
  await begin(0);
}
