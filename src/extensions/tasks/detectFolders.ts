// Reads what task detection needs (detect.ts) from the folder: the names of the root and of its
// subfolders down to task.autoDetectDepth (D203), their build files' text, the project's own tsc /
// gulp / grunt in node_modules/.bin, and whether a Cargo package has src/main.rs. In a trusted
// folder with make on PATH, a Makefile's targets come from `make -p` (its database: generated and
// included targets too), else from the text.
import { type DirEntry, fsIpc } from "../../core/ipc/fs";
import { execIpc } from "../../core/ipc/process";
import { joinPath } from "../../core/paths/index";
import {
  type DetectFolder,
  detectTasks,
  foldersToScan,
  MAKE_DATABASE_ARGS,
  MAKEFILES,
  makeDatabaseTargets,
  makefileTargets,
  type Platform,
  tsconfigNames,
  wantedFiles,
} from "./detect";
import type { TaskDefinition } from "./tasks";

/** A build file is small: anything bigger isn't read. */
const MAX_BUILD_FILE = 512_000;
const LOCAL_BINS = ["tsc", "gulp", "grunt"];

/** How detection may run make: whether it may at all (a trusted folder) and how many more times. */
interface MakeRuns {
  allowed: boolean;
  left: number;
}

/** Most `make -p` runs per detection (a monorepo with a Makefile per package stays cheap). */
const MAX_MAKE_RUNS = 8;
/** A Makefile that takes longer to read than this is read as text. */
const MAKE_TIMEOUT_MS = 5000;
/** The database of a huge build: more than this and the text is read instead. */
const MAX_MAKE_OUTPUT = 8_000_000;

/** Whether make is on PATH, asked again after a minute (an installer may add it). */
let makeOnPath: { at: number; found: Promise<boolean> } | null = null;
const hasMake = () => {
  if (!makeOnPath || Date.now() - makeOnPath.at > 60_000)
    makeOnPath = {
      at: Date.now(),
      found: execIpc
        .installed(["make"])
        .then((r) => r[0] === true)
        .catch(() => false),
    };
  return makeOnPath.found;
};

/**
 * Each folder's targets from make, kept while its Makefile's text is the same (null: make failed
 * or printed no database there, so the text is read).
 */
const makeResults = new Map<string, { text: string; targets: string[] | null }>();
let makeRunId = 0;

/** A folder's Makefile targets as `make -p` lists them; undefined to read the text instead. */
async function makeTargetsIn(
  abs: string,
  text: string,
  runs: MakeRuns,
): Promise<string[] | undefined> {
  if (!runs.allowed) return undefined;
  const known = makeResults.get(abs);
  if (known && known.text === text) return known.targets ?? undefined;
  if (runs.left <= 0 || !(await hasMake())) return undefined;
  runs.left--;
  const id = `tasks-make-${++makeRunId}`;
  let output = "";
  let tooBig = false;
  // `-p -n -q -r .DEFAULT`: print the database and run no recipe; stderr would land inside it.
  const result = await execIpc
    .run(
      id,
      `make ${MAKE_DATABASE_ARGS.join(" ")} 2>/dev/null`,
      { cwd: abs, timeoutMs: MAKE_TIMEOUT_MS },
      (chunk) => {
        if (tooBig) return;
        output += chunk;
        if (output.length > MAX_MAKE_OUTPUT) {
          tooBig = true;
          output = "";
          void execIpc.cancel(id).catch(() => {});
        }
      },
    )
    .catch(() => null);
  const targets =
    result && !result.timedOut && !result.cancelled && !tooBig
      ? makeDatabaseTargets(output, makefileTargets(text))
      : null;
  if (makeResults.size > 200) makeResults.clear();
  makeResults.set(abs, { text, targets });
  return targets ?? undefined;
}

async function describeFolder(
  abs: string,
  rel: string,
  names: string[],
  runs: MakeRuns,
): Promise<DetectFolder> {
  const files: Record<string, string> = {};
  for (const name of wantedFiles(names)) {
    const path = joinPath(abs, name);
    const stat = await fsIpc.stat(path).catch(() => null);
    if (stat?.kind !== "file" || stat.size > MAX_BUILD_FILE) continue;
    try {
      files[name] = new TextDecoder().decode(await fsIpc.read(path));
    } catch {}
  }
  const localBins: string[] = [];
  const usesBins =
    tsconfigNames(names).length > 0 || names.some((n) => /^(gulp|grunt)file\./i.test(n));
  if (usesBins && names.includes("node_modules")) {
    const bin = joinPath(joinPath(abs, "node_modules"), ".bin");
    for (const e of await fsIpc.listDir(bin).catch(() => [])) {
      const base = e.name.replace(/\.(cmd|ps1)$/i, "");
      if (LOCAL_BINS.includes(base) && !localBins.includes(base)) localBins.push(base);
    }
  }
  const cargoMain =
    files["Cargo.toml"] !== undefined &&
    (await fsIpc.stat(joinPath(joinPath(abs, "src"), "main.rs")).catch(() => null))?.kind ===
      "file";
  const makefile = MAKEFILES.find((n) => files[n] !== undefined);
  const makeTargets =
    makefile !== undefined ? await makeTargetsIn(abs, files[makefile] ?? "", runs) : undefined;
  return { rel, abs, names, files, localBins, cargoMain, ...(makeTargets && { makeTargets }) };
}

const looksLikeProject = (names: readonly string[]) =>
  wantedFiles(names).length > 0 || tsconfigNames(names).length > 0 || names.includes("pom.xml");

/** A workspace-relative folder ("/" separated) as an absolute path. */
const absOf = (root: string, rel: string) =>
  rel.split("/").reduce((at, part) => joinPath(at, part), root);

/**
 * How long a detection is reused: every task command loads the task list (run, list, rerun, the
 * build key), and detection lists up to 81 folders; a few seconds covers a burst of them while a
 * build file someone just edited still shows up soon (D201).
 */
const REUSE_MS = 4000;
/** Per detection key (one per workspace folder in a multi-root workspace, D251). */
const cached = new Map<string, { at: number; tasks: Promise<TaskDefinition[]> }>();

/**
 * The tasks build files define in `root` and its subfolders, `depth` levels down (0: the root
 * only; `rootEntries`: its listing). `runMake`: the folder is trusted, so make may read its
 * Makefiles (reading one can run commands: `$(shell …)`).
 */
export function detectedTasks(
  root: string,
  rootEntries: readonly DirEntry[],
  platform: Platform,
  depth = 2,
  runMake = false,
): Promise<TaskDefinition[]> {
  const key = `${platform}\n${depth}\n${runMake}\n${root}\n${rootEntries.map((e) => `${e.name}:${e.kind}`).join("/")}`;
  const now = Date.now();
  const hit = cached.get(key);
  if (hit && now - hit.at < REUSE_MS) return hit.tasks;
  // Old entries go (a folder's listing changed, a folder left the workspace).
  for (const [k, e] of cached) if (now - e.at >= REUSE_MS) cached.delete(k);
  const runs: MakeRuns = { allowed: runMake, left: MAX_MAKE_RUNS };
  const tasks = detect(root, rootEntries, platform, depth, runs);
  cached.set(key, { at: now, tasks });
  tasks.catch(() => {
    if (cached.get(key)?.tasks === tasks) cached.delete(key);
  });
  return tasks;
}

async function detect(
  root: string,
  rootEntries: readonly DirEntry[],
  platform: Platform,
  depth: number,
  runs: MakeRuns,
): Promise<TaskDefinition[]> {
  const rootNames = rootEntries.map((e) => e.name);
  const out = looksLikeProject(rootNames)
    ? detectTasks(await describeFolder(root, "", rootNames, runs), platform)
    : [];
  // A Cargo / Gradle / Maven folder builds its members: theirs aren't listed again (`skip`).
  const folders = await foldersToScan(rootEntries, depth, (rel) => fsIpc.listDir(absOf(root, rel)));
  const found = await Promise.all(
    folders.map(async (f) => {
      if (!looksLikeProject(f.names)) return [];
      const abs = absOf(root, f.rel);
      return detectTasks(await describeFolder(abs, f.rel, f.names, runs), platform, f.skip);
    }),
  );
  for (const list of found) out.push(...list);
  return out;
}
