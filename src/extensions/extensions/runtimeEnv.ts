// The host side of `ide.env` and of the folder's files (D234; worker side rpcExtras.ts): opening
// a web page in the system's browser (https, http and mailto only), the clipboard ("clipboard"),
// the workspace folders' files by glob (`findFiles`, "fs.read", from the file index: .gitignored
// files aren't in it), `findText`, and the `workspaceContains:` activation check (every folder).

import { patternBase } from "../../core/extensions/rpcWorkspace";
import { globSearchTerms } from "../../core/extensions/workspaceContains";
import {
  fsIpc,
  type IndexQueryResult,
  indexIpc,
  type LineMatch,
  searchIpc,
} from "../../core/ipc/fs";
import { clipboardIpc, openerIpc } from "../../core/ipc/system";
import type { Disposable } from "../../core/lifecycle/index";
import { globToRegExp } from "../../core/paths/glob";
import { resolveInRoot, samePath } from "../../core/paths/index";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import { matchWorkspaceFiles, openableUrl, type WorkspaceIndexItem } from "./workbenchChecks";

const MAX_FIND = 10_000;

export interface EnvHostDeps {
  services: WorkbenchServices;
  need(permission: string, what: string): void;
}

export class ExtensionEnvHost implements Disposable {
  constructor(private readonly deps: EnvHostDeps) {}

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "env.openExternal": {
        const url = String(p.url ?? "");
        if (!openableUrl(url))
          throw new Error(`Only https, http and mailto links open (${url.slice(0, 80)}).`);
        return openerIpc.openUrl(url).then(() => true);
      }
      case "env.clipboardRead":
        this.deps.need("clipboard", "read the clipboard");
        return clipboardIpc.readText();
      case "env.clipboardWrite":
        this.deps.need("clipboard", "write the clipboard");
        return clipboardIpc.writeText(String(p.text ?? "").slice(0, 10_000_000));
      case "fs.findFiles":
        return this.findFiles(p);
      default:
        return UNHANDLED;
    }
  }

  private async findFiles(p: Record<string, unknown>): Promise<string[]> {
    this.deps.need("fs.read", "list files");
    const root = this.deps.services.workspace.root.peek();
    if (!root) throw new Error("No folder is open.");
    const max = Math.min(MAX_FIND, Math.max(1, Number(p.maxResults) || MAX_FIND));
    // Every folder's files (D251): the index lists the others' with their `root`.
    const listed = await indexIpc.query("", 50_000);
    const base = patternBase(p.include);
    const include =
      base !== null
        ? { base, pattern: String((p.include as { pattern: unknown }).pattern) }
        : typeof p.include === "string"
          ? p.include
          : "**";
    return matchWorkspaceFiles(
      listed.items,
      root,
      include,
      typeof p.exclude === "string" ? p.exclude : undefined,
      max,
    );
  }

  dispose(): void {}
}

// Moved from runtime.ts (D234): the folder's files for activation and ide.workspace.findText.

/**
 * Whether one of the workspace's folders (or of `only`: folders just added) has a file matching
 * one of `patterns` (activation, D176; every folder, D251).
 */
export async function workspaceContains(
  services: WorkbenchServices,
  patterns: readonly string[],
  only?: readonly string[],
): Promise<boolean> {
  const root = services.workspace.root.peek();
  if (!root) return false;
  const folders = only ?? services.workspace.folderPaths();
  const roots = folders.length ? folders : [root];
  // VS Code checks them all (ms-python.python lists 11).
  const globs: string[] = [];
  for (const pattern of patterns.slice(0, 40)) {
    if (/[*?[{]/.test(pattern)) {
      globs.push(pattern);
      continue;
    }
    for (const folder of roots) {
      const found = await fsIpc.stat(resolveInRoot(folder, pattern)).catch(() => null);
      if (found) return true;
    }
  }
  if (!globs.length) return false;
  // Index paths are relative to their folder (the primary's, or the item's `root`), with "/".
  const res = globs.map((g) => globToRegExp(g));
  const inRoots = (i: WorkspaceIndexItem) =>
    !only || roots.some((r) => samePath(r, i.root ?? root));
  const hit = (items: readonly WorkspaceIndexItem[] | undefined) =>
    !!items?.some((i) => inRoots(i) && res.some((re) => re.test(i.path)));
  // First the index's quick search for each pattern's literal text (".ipynb", "manage.py"): a
  // match there settles it at once.
  const terms = [...new Set(globs.flatMap(globSearchTerms))].slice(0, 40);
  for (const term of terms) {
    const listed = await indexIpc.query(term, 1000).catch(() => null);
    if (hit(listed?.items)) return true;
  }
  // Then the folders' whole file list (the project's own files first, then dependencies): the
  // quick search ranks and caps its answers, so a big folder could hide the match there.
  const all = await fileList([root, ...roots].join("\n"));
  return hit(all?.items);
}

/**
 * How long one file list serves every extension's check (they all ask as the IDE starts):
 * shorter than the re-checks of a folder just added (3 s), which wait for the index.
 */
const FILE_LIST_TTL_MS = 2000;
let fileListCache: { key: string; at: number; list: Promise<IndexQueryResult | null> } | null =
  null;

/** The workspace's files from the index (at most the 50,000 it lists), shared for a moment. */
function fileList(key: string): Promise<IndexQueryResult | null> {
  const now = Date.now();
  if (fileListCache && fileListCache.key === key && now - fileListCache.at < FILE_LIST_TTL_MS)
    return fileListCache.list;
  const list = indexIpc.query("", 50_000).catch(() => null);
  fileListCache = { key, at: now, list };
  return list;
}

/** An extension's text search (`ide.workspace.findText`): detached from the search view's. */
export async function findText(
  services: WorkbenchServices,
  p: Record<string, unknown>,
): Promise<{
  matches: { path: string; rel: string; line: number; text: string }[];
  truncated: boolean;
}> {
  const query = typeof p.query === "string" ? p.query : "";
  if (!query) throw new Error("findText needs a query.");
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const max = Math.min(20000, Math.max(1, Number(p.maxResults) || 2000));
  const matches: { path: string; rel: string; line: number; text: string }[] = [];
  let truncated = false;
  await new Promise<void>((resolve, reject) => {
    searchIpc
      .start(
        {
          query,
          isRegex: p.isRegex === true,
          matchCase: p.matchCase === true,
          wholeWord: p.wholeWord === true,
          include: strings(p.include),
          exclude: strings(p.exclude),
          maxResults: max,
        },
        (e) => {
          if (e.kind === "file") {
            // The search's `rel` is relative to the file's own folder: as the workspace writes it
            // instead ("api/src/x.ts" with several folders; the same with one).
            const rel =
              services.workspace.folders.peek().length > 1
                ? services.workspace.relative(e.path)
                : e.rel;
            for (const m of e.matches as LineMatch[])
              matches.push({ path: e.path, rel, line: m.line, text: m.text });
          } else {
            truncated = e.truncated;
            resolve();
          }
        },
        true,
      )
      .catch(reject);
  });
  return { matches, truncated };
}
