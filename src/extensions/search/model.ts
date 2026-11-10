// Search results as they stream in, and the replace preview. DOM-free and unit-tested; the view
// renders it and the commands read it (`ide://search/last`).
import { Emitter } from "../../core/events/index";
import type { LineMatch, SearchEvent, SearchOptions } from "../../core/ipc/fs";

export interface FileResult {
  path: string;
  rel: string;
  matches: LineMatch[];
}

export interface SearchSummary {
  files: number;
  matches: number;
  truncated: boolean;
  durationMs: number;
}

export type SearchViewMode = "list" | "tree";
export type HistoryField = "query" | "replace" | "include" | "exclude";

export class SearchModel {
  /** Results as a flat list of files, or grouped by folder (search.toggleViewMode). */
  viewMode: SearchViewMode = "list";
  /** What was typed in each field before (Up / Down), saved with the workspace. */
  readonly history: Record<HistoryField, InputHistory> = {
    query: new InputHistory(),
    replace: new InputHistory(),
    include: new InputHistory(),
    exclude: new InputHistory(),
  };
  options: SearchOptions | null = null;
  files: FileResult[] = [];
  running = false;
  summary: SearchSummary | null = null;
  error: string | null = null;
  /** Bumped per search; events from an older search are ignored. */
  private generation = 0;
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private waiters: (() => void)[] = [];

  /** Starts a new result set; returns a sink for its events. */
  begin(options: SearchOptions): (event: SearchEvent) => void {
    const generation = ++this.generation;
    this.options = options;
    this.files = [];
    this.running = true;
    this.summary = null;
    this.error = null;
    this.changed.fire();
    return (event) => {
      if (generation !== this.generation) return;
      if (event.kind === "file") {
        this.files.push({ path: event.path, rel: event.rel, matches: event.matches });
      } else {
        this.running = false;
        this.summary = {
          files: event.files,
          matches: event.matches,
          truncated: event.truncated,
          durationMs: event.durationMs,
        };
        for (const resolve of this.waiters.splice(0)) resolve();
      }
      this.changed.fire();
    };
  }

  fail(message: string): void {
    this.running = false;
    this.error = message;
    for (const resolve of this.waiters.splice(0)) resolve();
    this.changed.fire();
  }

  clear(): void {
    this.generation++;
    this.options = null;
    this.files = [];
    this.running = false;
    this.summary = null;
    this.error = null;
    for (const resolve of this.waiters.splice(0)) resolve();
    this.changed.fire();
  }

  /** Resolves when the current search finishes. */
  whenDone(): Promise<void> {
    return this.running ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve();
  }

  /**
   * Hides a file's results, or one match (by line) — VS Code's "Dismiss". They come back with the
   * next search. Returns false if nothing matched.
   */
  dismiss(path: string, line?: number): boolean {
    const file = this.files.find((f) => f.path === path);
    if (!file) return false;
    if (line === undefined) this.files = this.files.filter((f) => f !== file);
    else {
      const before = file.matches.length;
      file.matches = file.matches.filter((m) => m.line !== line);
      if (file.matches.length === before) return false;
      if (file.matches.length === 0) this.files = this.files.filter((f) => f !== file);
    }
    this.changed.fire();
    return true;
  }

  /**
   * Keeps only the files `keep` accepts (D251: a folder taken out of the workspace takes its
   * results with it). Returns how many went.
   */
  keepFiles(keep: (file: FileResult) => boolean): number {
    const before = this.files.length;
    this.files = this.files.filter(keep);
    const gone = before - this.files.length;
    if (gone) this.changed.fire();
    return gone;
  }

  get matchCount(): number {
    let n = 0;
    for (const f of this.files) n += f.matches.length;
    return n;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** The JS regex equivalent of the Rust search pattern (for the replace preview). */
export function searchRegExp(options: SearchOptions): RegExp | null {
  const core = options.isRegex
    ? options.query
    : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = options.wholeWord ? `\\b(?:${core})\\b` : core;
  try {
    return new RegExp(source, options.matchCase ? "u" : "iu");
  } catch {
    return null;
  }
}

/** What one match becomes with `replacement` ($1… expanded for regex searches). */
export function previewReplacement(
  matched: string,
  options: SearchOptions,
  replacement: string,
): string {
  let out = replacement;
  if (options.isRegex) {
    const re = searchRegExp(options);
    if (re) out = matched.replace(re, replacement);
  }
  return options.preserveCase ? preserveCase(matched, out) : out;
}

/** The replacement in the match's case pattern: UPPER, lower or Capitalized (as Rust does). */
export function preserveCase(matched: string, replacement: string): string {
  const letters = [...matched].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return replacement;
  const upper = (c: string) => c !== c.toLowerCase();
  const lower = (c: string) => c !== c.toUpperCase();
  if (letters.length > 1 && letters.every(upper)) return replacement.toUpperCase();
  if (letters.every(lower)) return replacement.toLowerCase();
  const [first = "", ...rest] = [...matched];
  if (upper(first) && !rest.some(upper))
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

/** What the search form holds: the options plus the two scope toggles that settings resolve. */
export interface SearchQuery extends SearchOptions {
  /** files.exclude, search.exclude and ignore files apply (VS Code's book toggle; default on). */
  useExcludeSettings?: boolean;
  /** Search only the files open in editors. */
  onlyOpenEditors?: boolean;
}

/** The `search.*` settings that shape a search. */
export interface SearchSettings {
  filesExclude: Record<string, unknown>;
  searchExclude: Record<string, unknown>;
  useIgnoreFiles: boolean;
  followSymlinks: boolean;
  smartCase: boolean;
  maxResults: number;
}

/**
 * The options sent to Rust: the form's query with the settings applied — exclude globs from
 * files.exclude and search.exclude (when the toggle is on), ignore files, symlinks, smart case
 * (an uppercase letter in the query turns on Match case) and the result limit. `openEditors`
 * (workspace-relative) replaces the include globs when searching only open editors.
 */
export function effectiveOptions(
  q: SearchQuery,
  cfg: SearchSettings,
  openEditors: readonly string[],
): SearchOptions {
  const { useExcludeSettings, onlyOpenEditors, ...base } = q;
  const useExclude = useExcludeSettings !== false;
  const enabled = (map: Record<string, unknown>) =>
    Object.entries(map)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  const exclude = useExclude
    ? [...new Set([...q.exclude, ...enabled(cfg.filesExclude), ...enabled(cfg.searchExclude)])]
    : q.exclude;
  return {
    ...base,
    matchCase: q.matchCase || (cfg.smartCase && /\p{Lu}/u.test(q.query)),
    include: onlyOpenEditors ? [...openEditors] : q.include,
    exclude,
    useIgnoreFiles: useExclude && cfg.useIgnoreFiles,
    followSymlinks: cfg.followSymlinks,
    maxResults: q.maxResults ?? cfg.maxResults,
  };
}

/** Options compared to decide whether a replace needs a fresh search (replace-only keys dropped). */
export function sameSearch(a: SearchOptions | null, b: SearchOptions): boolean {
  if (!a) return false;
  const key = ({ preserveCase: _p, lines: _l, ...rest }: SearchOptions) =>
    JSON.stringify(rest, Object.keys(rest).sort());
  return key(a) === key(b);
}

/** Text for "Copy" in the results: `path` then indented `line: text` rows (VS Code's format). */
export function formatResults(files: readonly FileResult[], lineNumbers = true): string {
  return files
    .map((f) =>
      [
        f.rel,
        ...f.matches.map((m) => `  ${lineNumbers ? `${m.line}: ` : ""}${m.text.trim()}`),
      ].join("\n"),
    )
    .join("\n\n");
}

// ---- Results as a folder tree (D172; VS Code's "View as tree") ---------------------------------

export interface FolderNode {
  /** Path relative to the workspace ("src/core"), forward slashes. */
  rel: string;
  /** What the row shows: one folder's name, or a compacted chain ("src/core"). */
  name: string;
  folders: FolderNode[];
  files: FileResult[];
  /** Matches inside it, at any depth. */
  count: number;
}

/**
 * The results grouped by folder: folders before files, each sorted by name; a folder whose only
 * content is one folder is shown as one row ("src/core", like VS Code's compact folders).
 */
export function folderTree(files: readonly FileResult[]): FolderNode {
  const root: FolderNode = { rel: "", name: "", folders: [], files: [], count: 0 };
  const byRel = new Map<string, FolderNode>([["", root]]);
  const folderFor = (rel: string): FolderNode => {
    const known = byRel.get(rel);
    if (known) return known;
    const cut = rel.lastIndexOf("/");
    const parent = folderFor(cut < 0 ? "" : rel.slice(0, cut));
    const node: FolderNode = { rel, name: rel.slice(cut + 1), folders: [], files: [], count: 0 };
    parent.folders.push(node);
    byRel.set(rel, node);
    return node;
  };
  for (const file of files) {
    const rel = file.rel.replace(/\\/g, "/");
    const cut = rel.lastIndexOf("/");
    folderFor(cut < 0 ? "" : rel.slice(0, cut)).files.push(file);
  }
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const fileName = (f: FileResult) => f.rel.slice(f.rel.replace(/\\/g, "/").lastIndexOf("/") + 1);
  const finish = (node: FolderNode): number => {
    node.folders = node.folders.map((f) => {
      // Compact: a folder holding only one folder becomes "a/b".
      let folder = f;
      while (folder.files.length === 0 && folder.folders.length === 1) {
        const only = folder.folders[0] as FolderNode;
        folder = { ...only, name: `${folder.name}/${only.name}` };
      }
      return folder;
    });
    node.folders.sort(byName);
    node.files.sort((a, b) => byName({ name: fileName(a) }, { name: fileName(b) }));
    node.count =
      node.files.reduce((n, f) => n + f.matches.length, 0) +
      node.folders.reduce((n, f) => n + finish(f), 0);
    return node.count;
  };
  finish(root);
  return root;
}

// ---- Input history (D172; Up / Down in the search fields, like VS Code) ------------------------

const HISTORY_SIZE = 50;

/**
 * What was searched before, newest last. Up walks back from what's typed (kept as a draft), Down
 * walks forward and, past the newest, brings the draft back.
 */
export class InputHistory {
  private items: string[] = [];
  /** Index while navigating; -1 when not. */
  private at = -1;
  private draft = "";

  constructor(items: readonly string[] = []) {
    this.items = items.filter((v) => typeof v === "string" && v.trim()).slice(-HISTORY_SIZE);
  }

  get entries(): readonly string[] {
    return this.items;
  }

  /** Replaces what's remembered (another folder's history), in place. */
  replace(items: readonly string[]): void {
    this.items = items.filter((v) => typeof v === "string" && v.trim()).slice(-HISTORY_SIZE);
    this.at = -1;
    this.draft = "";
  }

  /** Remembers `value` as the newest (moved to the end if it was there). */
  add(value: string): void {
    this.at = -1;
    if (!value.trim()) return;
    this.items = [...this.items.filter((v) => v !== value), value].slice(-HISTORY_SIZE);
  }

  /** The entry before (Up), or undefined at the oldest / with no history. */
  previous(current: string): string | undefined {
    if (!this.items.length) return undefined;
    if (this.at === -1) {
      this.draft = current;
      this.at = this.items.length;
      // What's typed is the newest entry (just searched): the first Up goes one further.
      if (this.items[this.items.length - 1] === current) this.at--;
    }
    if (this.at <= 0) return undefined;
    this.at--;
    return this.items[this.at];
  }

  /** The entry after (Down); past the newest, what was typed before navigating. */
  next(): string | undefined {
    if (this.at === -1) return undefined;
    this.at++;
    if (this.at >= this.items.length) {
      this.at = -1;
      return this.draft;
    }
    return this.items[this.at];
  }

  /** Typing ends navigating. */
  reset(): void {
    this.at = -1;
  }
}
