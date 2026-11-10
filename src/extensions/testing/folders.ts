// Tests in a multi-root workspace (D251): a test's file (and its id, and its project) is relative
// to the workspace as `workspace.relative` writes it — with several folders, the folder's name
// first ("api/src/sum.test.ts"), so ids stay apart per folder and read back with
// `workspace.resolve`. With one folder that's the root-relative path, as before. A framework's
// report is read relative to the folder it ran in, then given the folder's name (`prefixRun`).
// DOM-free.
import { isWithin, joinPath, relativePath } from "../../core/paths/index";
import type { ParsedRun, TestResult } from "./model";

/** `rel` (relative to a folder) with the folder's name in front; unchanged without a name. */
export function prefixRel(prefix: string, rel: string): string {
  if (!prefix) return rel;
  return rel ? `${prefix}/${rel}` : prefix;
}

/**
 * A framework's results with ids and files relative to a folder (or a project folder) moved
 * under `prefix`: `framework:file::…` ids get `framework:prefix/file::…`. Ids in `known` (the
 * discovered tests, already right) are kept.
 */
export function prefixRun(
  run: ParsedRun,
  framework: string,
  prefix: string,
  known: ReadonlySet<string>,
): ParsedRun {
  if (!prefix) return run;
  const head = `${framework}:`;
  const fix = (id: string) =>
    known.has(id) || !id.startsWith(head) ? id : `${head}${prefix}/${id.slice(head.length)}`;
  const results = new Map<string, TestResult>();
  for (const [id, r] of run.results) results.set(fix(id), r);
  return {
    ...run,
    results,
    extra: run.extra.map((t) =>
      known.has(t.id) ? t : { ...t, id: fix(t.id), file: prefixRel(prefix, t.file) },
    ),
  };
}

/**
 * The project folders a rel path's tests may run from, innermost first: its folders up to the
 * workspace's top — with several workspace folders, up to the folder's own top (`floor` 1: the
 * name segment), never across folders.
 */
export function projectCandidates(rel: string, floor: number): string[] {
  const parts = rel.split("/").slice(0, -1);
  const out: string[] = [];
  for (let n = parts.length; n >= floor; n--) out.push(parts.slice(0, n).join("/"));
  return out;
}

/**
 * How the workspace names test files: by folder name when there are several (`multi`), else
 * relative to the first folder. It flips when a workspace goes from one folder to two and back
 * (VS Code also names by folder only with several), and a rename changes the names.
 */
export interface TestNaming {
  multi: boolean;
  folders: readonly { path: string; name: string }[];
}

export function sameNaming(a: TestNaming, b: TestNaming): boolean {
  return (
    a.multi === b.multi &&
    a.folders.length === b.folders.length &&
    a.folders.every((f, i) => f.path === b.folders[i]?.path && f.name === b.folders[i]?.name)
  );
}

/** A test file (a project; "" for the top) named as `to` names it; null when its folder left. */
export function renameTestFile(file: string, from: TestNaming, to: TestNaming): string | null {
  const abs = absoluteOf(file, from);
  if (abs === null) return null;
  if (!to.multi) {
    const first = to.folders[0];
    return first && isWithin(first.path, abs) ? relativePath(first.path, abs) : null;
  }
  // The innermost folder holding it, as `workspace.relative` picks.
  let owner: { path: string; name: string } | undefined;
  for (const f of to.folders)
    if (isWithin(f.path, abs) && (!owner || f.path.length > owner.path.length)) owner = f;
  return owner ? prefixRel(owner.name, relativePath(owner.path, abs)) : null;
}

/** A test id (`framework:file::path`) with its file named as `to` names it; null when gone. */
export function renameTestId(id: string, from: TestNaming, to: TestNaming): string | null {
  const colon = id.indexOf(":");
  const sep = id.indexOf("::", colon + 1);
  if (colon < 0 || sep < 0) return id;
  const file = renameTestFile(id.slice(colon + 1, sep), from, to);
  return file === null ? null : `${id.slice(0, colon + 1)}${file}${id.slice(sep)}`;
}

function absoluteOf(file: string, naming: TestNaming): string | null {
  if (!naming.multi) {
    const first = naming.folders[0];
    if (!first) return null;
    return file ? joinPath(first.path, file) : first.path;
  }
  const [head, ...rest] = file.split("/");
  const folder = naming.folders.find((f) => f.name === head);
  if (!folder) return null;
  return rest.length ? joinPath(folder.path, rest.join("/")) : folder.path;
}
