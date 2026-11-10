// The agent's search and find_files tools (D306, D307), after Claude Code's Grep and Glob: search
// has three output modes, context lines, -i / -o / multiline, path / glob / type filters and
// paging (core/agent/grep.ts); find_files takes glob patterns (newest first) besides fuzzy names.
// tools.ts builds them with its path helpers (`SearchToolHelpers`), so nothing here imports it.
import { readApproveRules } from "../../core/agent/autoApprove";
import {
  byNewest,
  FIND_DEFAULT_LIMIT,
  FIND_MAX_LIMIT,
  globMatcher,
  isGlob,
} from "../../core/agent/fileGlob";
import {
  type GrepArgs,
  type GrepFile,
  grepArgs,
  grepIgnoresCase,
  grepPage,
  grepResult,
  includeGlobs,
  matchesType,
  sortFiles,
} from "../../core/agent/grep";
import type { ToolOutcome } from "../../core/agent/loop";
import { fsIpc, indexIpc, type SearchEvent, searchIpc } from "../../core/ipc/fs";
import { resolveInRoot } from "../../core/paths/index";
import { readDiskForAgent } from "./changeset";
import { agentFolders, agentIgnoredRel } from "./ignore";
import { hiddenInDownloads } from "./riskyGuard";
import { helperRootOf } from "./toolRoots";
import type { AgentTool, ToolHost } from "./tools";

/** What the tools need from tools.ts: its workspace-confined path helpers. */
export interface SearchToolHelpers {
  /** A path from the model, resolved inside the workspace (throws outside it). */
  resolve(host: ToolHost, path: unknown): string;
  /** How a path is named to the model. */
  rel(host: ToolHost, abs: string): string;
  /** Whether agent.autoApprove asks before reading this workspace-relative path. */
  readProtected(host: ToolHost, rules: ReturnType<typeof readApproveRules>, rel: string): boolean;
}

/** Matches the engine stops at (search.maxResults' default). */
const ENGINE_MAX = 20_000;

interface Found {
  files: GrepFile[];
  matches: number;
  truncated: boolean;
}

/** A search through the search extension (the open folder or every folder of the workspace). */
async function findInWorkspace(host: ToolHost, options: Record<string, unknown>): Promise<Found> {
  return host.services.dispatcher.execute<Found>("search.find", options, {
    kind: "agent",
    session: host.session,
  });
}

/** The same search in a headless helper's worktree (not a workspace folder), straight to Rust. */
async function findInFolder(
  folder: string,
  o: { query: string; isRegex: boolean; matchCase: boolean; include: string[]; multiLine: boolean },
): Promise<Found> {
  const files: GrepFile[] = [];
  let matches = 0;
  let truncated = false;
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const onEvent = (e: SearchEvent) => {
    if (e.kind === "done") {
      matches = e.matches;
      truncated = e.truncated;
      finish();
      return;
    }
    files.push({ path: e.rel, matches: e.matches });
  };
  await searchIpc.start(
    { ...o, wholeWord: false, exclude: [], maxResults: ENGINE_MAX },
    onEvent,
    true,
    folder,
  );
  // A search that never says done (its folder went away) doesn't hold the turn.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([done, new Promise<void>((r) => (timer = setTimeout(r, 60_000)))]);
  clearTimeout(timer);
  return { files, matches, truncated };
}

/** The path argument as a workspace path and whether it's a file; null for the whole workspace. */
async function searchPath(
  host: ToolHost,
  h: SearchToolHelpers,
  path: string | null,
): Promise<{ rel: string; isFile: boolean } | null> {
  if (!path) return null;
  const abs = h.resolve(host, path);
  const rel = h.rel(host, abs);
  if (rel === ".") return null;
  const stat = await fsIpc.stat(abs).catch(() => null);
  if (!stat) throw new Error(`${rel} doesn't exist.`);
  return { rel, isFile: stat.kind === "file" };
}

export function searchTool(h: SearchToolHelpers): AgentTool {
  return {
    spec: {
      name: "search",
      description:
        'Search file contents with ripgrep (respects .gitignore). `pattern` is a regular expression (literal text: regex false). output_mode "content" (default) shows matching lines as path:line: text, with before / after / context lines around them; "files_with_matches" lists the files; "count" gives matches per file. Narrow it with path (a folder or file), glob ("*.ts", "src/**/*.tsx") or type ("js", "py", "rust"). Smart case unless ignore_case is set. head_limit (default 250, 0 for all) and offset page through long results: a cut result says the next offset.',
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to find" },
          regex: {
            type: "boolean",
            description: "false: pattern is literal text (default true)",
          },
          path: { type: "string", description: "Folder or file to search in (default: all)" },
          glob: { type: "string", description: 'Files to search, e.g. "*.ts", "src/**/*.tsx"' },
          type: { type: "string", description: 'File type, e.g. "js", "ts", "py", "rust", "go"' },
          output_mode: {
            type: "string",
            enum: ["content", "files_with_matches", "count"],
            description: "Default content",
          },
          context: { type: "integer", description: "Lines before and after each match (content)" },
          before: { type: "integer", description: "Lines before each match" },
          after: { type: "integer", description: "Lines after each match" },
          ignore_case: { type: "boolean", description: "Case-insensitive (default: smart case)" },
          only_matching: { type: "boolean", description: "Only the matched parts of lines" },
          line_numbers: { type: "boolean", description: "Line numbers in content (default true)" },
          multiline: {
            type: "boolean",
            description: "Patterns may span lines and . matches line breaks",
          },
          head_limit: {
            type: "integer",
            description: "First N lines / files / counts (default 250; 0: all, use sparingly)",
          },
          offset: { type: "integer", description: "Skip the first N (the next page)" },
        },
        required: ["pattern"],
      },
    },
    readOnly: true,
    verb: "Searched",
    target: (a) => String(a.pattern ?? a.query ?? ""),
    async run(args, host) {
      const parsed = grepArgs(args);
      if ("error" in parsed) return { result: `Error: ${parsed.error}`, isError: true };
      return runSearch(host, h, parsed);
    },
  };
}

async function runSearch(host: ToolHost, h: SearchToolHelpers, a: GrepArgs): Promise<ToolOutcome> {
  const where = await searchPath(host, h, a.path);
  const include = includeGlobs(a, where);
  const worktree = helperRootOf(host.session);
  const search = (regex: boolean) => {
    const o = {
      query: a.pattern,
      isRegex: regex,
      matchCase: !grepIgnoresCase(a),
      include,
      multiLine: a.multiline && regex,
    };
    return worktree
      ? findInFolder(worktree, o)
      : findInWorkspace(host, { ...o, maxResults: ENGINE_MAX });
  };
  const notes: string[] = [];
  let found: Found;
  try {
    found = await search(a.regex);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A pattern that isn't a valid regular expression ("foo(" from a model): searched as text.
    if (!a.regex || !/invalid search pattern|regex/i.test(message)) throw err;
    found = await search(false);
    notes.push(`(pattern isn't a valid regular expression, so it was searched as plain text)`);
  }
  // Excluded files' lines never reach the model (D199), nor those of files agent.autoApprove
  // protects from reading (read_file would ask first, D204), nor a Downloads folder's (D213).
  const approve = readApproveRules(host.services.settings.peek<unknown>("agent.autoApprove"));
  const kept = found.files.filter(
    (f) =>
      matchesType(f.path, a.type) &&
      !agentIgnoredRel(host.services, f.path) &&
      !h.readProtected(host, approve, f.path) &&
      !hiddenInDownloads(host.services, host.session, f.path),
  );
  const left = found.files.filter((f) => matchesType(f.path, a.type)).length - kept.length;
  if (left) notes.push(`(${left} file${left === 1 ? "" : "s"} excluded from the agent left out)`);
  if (found.truncated)
    notes.push(
      `(The search stopped at ${found.matches} matches: there are more. Narrow it with path, glob or type.)`,
    );
  const files = sortFiles(kept);
  const page = grepPage(files, a);
  // Context lines come from the files themselves (the engine sends matching lines only).
  const texts = new Map<string, readonly string[] | null>();
  if (a.mode === "content" && (a.before > 0 || a.after > 0) && !a.onlyMatching)
    await Promise.all(
      page.files.map(async (f) => {
        texts.set(f.path, await fileLines(host, h, f.path));
      }),
    );
  const total = files.reduce((n, f) => n + f.matches.length, 0);
  if (a.mode === "count" && page.shown < page.total)
    notes.push(`${total} matching lines in ${files.length} files in all.`);
  return {
    result: grepResult(page, a, (p) => texts.get(p) ?? null, notes),
    summary:
      a.mode === "content"
        ? `${total} matches`
        : `${files.length} file${files.length === 1 ? "" : "s"}`,
  };
}

/** A matching file's lines (its open buffer if it has one), for context; null if unreadable. */
async function fileLines(
  host: ToolHost,
  h: SearchToolHelpers,
  rel: string,
): Promise<readonly string[] | null> {
  try {
    const abs = h.resolve(host, rel);
    const open = host.services.quickDiff.bufferText(abs);
    if (open !== null) return open.split(/\r?\n/);
    const disk = await readDiskForAgent(abs);
    return disk.kind === "text" ? disk.text.split(/\r?\n/) : null;
  } catch {
    return null;
  }
}

export function findFilesTool(h: SearchToolHelpers): AgentTool {
  return {
    spec: {
      name: "find_files",
      description:
        'Find files (respects .gitignore). A glob pattern ("**/*.ts", "src/*.{js,ts}"; "*.md" matches at any depth) returns matching paths, newest first; plain words find files by fuzzy name. Returns workspace-relative paths.',
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "A glob pattern, or part of a file name or path" },
          path: { type: "string", description: "Folder to look in (default: the workspace)" },
          limit: {
            type: "integer",
            description: `Most paths to return (default ${FIND_DEFAULT_LIMIT}, at most ${FIND_MAX_LIMIT})`,
          },
          offset: { type: "integer", description: "Skip the first N (the next page)" },
        },
        required: ["query"],
      },
    },
    readOnly: true,
    verb: "Found",
    target: (a) => String(a.query ?? a.pattern ?? ""),
    async run(args, host) {
      const query = args.query ?? args.pattern ?? args.glob;
      if (typeof query !== "string" || !query.trim())
        return { result: 'Error: "query" is required (a glob or a file name).', isError: true };
      const num = (v: unknown, fallback: number) => {
        const n = typeof v === "string" ? Number(v) : v;
        return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
      };
      const limit = Math.min(FIND_MAX_LIMIT, Math.max(1, num(args.limit, FIND_DEFAULT_LIMIT)));
      const offset = num(args.offset, 0);
      const where = await searchPath(host, h, typeof args.path === "string" ? args.path : null);
      if (where?.isFile)
        return { result: `Error: ${where.rel} is a file, not a folder.`, isError: true };
      const base = where?.rel ?? "";
      const listed = isGlob(query)
        ? await globFiles(host, h, query.trim(), base)
        : await fuzzyFiles(host, query.trim(), base, offset + limit);
      // Excluded files aren't named (D199), nor those agent.autoApprove asks before reading
      // (D207: the same per-path gate as search's matches).
      const approve = readApproveRules(host.services.settings.peek<unknown>("agent.autoApprove"));
      const visible = listed.files.filter(
        (f) =>
          !agentIgnoredRel(host.services, f) && !hiddenInDownloads(host.services, host.session, f),
      );
      const files = visible.filter((f) => !h.readProtected(host, approve, f));
      const protectedCount = visible.length - files.length;
      const page = files.slice(offset, offset + limit);
      const rest = files.length - offset - page.length;
      const notes = [
        ...(rest > 0
          ? [`… ${rest} more (pass offset: ${offset + page.length}, or narrow the pattern)`]
          : listed.more && page.length
            ? [`(more may match: pass offset: ${offset + page.length}, or use a longer name)`]
            : []),
        ...(protectedCount
          ? [
              `(${protectedCount} file${protectedCount === 1 ? "" : "s"} that agent.autoApprove protects left out; read_file asks the user for one.)`,
            ]
          : []),
        ...listed.notes,
      ];
      return {
        result: [
          page.join("\n") ||
            (offset && files.length
              ? `offset ${offset} is past the end (${files.length} files).`
              : "No files found."),
          ...notes,
        ].join("\n"),
        summary: `${files.length}${listed.more ? "+" : ""} files`,
      };
    },
  };
}

/** Files to sort by time at most (each one is a stat); past that they're by path. */
const SORT_BY_TIME_MAX = 2000;

async function globFiles(
  host: ToolHost,
  h: SearchToolHelpers,
  pattern: string,
  base: string,
): Promise<{ files: string[]; more: boolean; notes: string[] }> {
  const worktree = helperRootOf(host.session);
  const r = await indexIpc.query("", 50_000, worktree);
  const folders = agentFolders(host.services);
  const first = worktree ?? folders[0]?.path;
  if (!first) throw new Error("No folder is open.");
  const match = globMatcher(pattern, base);
  const found: { rel: string; abs: string }[] = [];
  for (const item of r.items) {
    const abs = resolveInRoot(worktree ?? item.root ?? first, item.path);
    const rel = h.rel(host, abs);
    if (match(rel)) found.push({ rel, abs });
  }
  const notes: string[] = [];
  if (r.indexing) notes.push("(The file index is still being built: some files may be missing.)");
  if (r.truncated) notes.push("(Only the first 50000 files of the workspace were looked at.)");
  if (found.length > SORT_BY_TIME_MAX) {
    notes.push(`(${found.length} files match: sorted by path, not by time.)`);
    return { files: found.map((f) => f.rel).sort(), more: false, notes };
  }
  const timed = await Promise.all(
    found.map(async (f) => ({
      rel: f.rel,
      mtime: (await fsIpc.stat(f.abs).catch(() => null))?.mtimeMs ?? null,
    })),
  );
  return { files: byNewest(timed), more: false, notes };
}

async function fuzzyFiles(
  host: ToolHost,
  query: string,
  base: string,
  want: number,
): Promise<{ files: string[]; more: boolean; notes: string[] }> {
  const worktree = helperRootOf(host.session);
  // quickOpen.search returns 200 at most; a folder filter asks for that many.
  const ask = Math.min(200, base ? 200 : Math.max(50, want));
  // A headless helper's worktree isn't indexed: Rust walks it for the query.
  const files = worktree
    ? (await indexIpc.query(query, ask, worktree)).items.map((i) => i.path)
    : (
        await host.services.dispatcher.execute<{ files: string[] }>(
          "quickOpen.search",
          { query, limit: ask },
          { kind: "agent", session: host.session },
        )
      ).files;
  const inBase = base ? files.filter((f) => f.startsWith(`${base}/`)) : files;
  return { files: inBase, more: files.length >= ask, notes: [] };
}
