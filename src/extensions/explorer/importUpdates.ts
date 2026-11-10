// "Update imports for 'x.ts'?" (D141): after the explorer renames or moves JavaScript/TypeScript
// files (or folders holding some), the relative imports that pointed at them — and the moved
// files' own imports — are found (a workspace search for relative specifiers, ignore files
// respected), rewritten (imports.ts) and, as `editor.updateImportsOnFileMove` says, applied after
// asking (Yes / No / Always / Never), always, or never. The edits belong to the move's undo
// entry: undo puts back the imports of the files that still hold what was written (the others
// are left and named), then moves the files back. Writes are all-or-nothing (a failure puts the
// files already written back). Files open with unsaved changes are edited in their editor (and
// stay unsaved); the others are written (keeping a BOM; files that aren't valid UTF-8 are left
// alone) and their editors reload. A search cut short (a huge repository) updates nothing.
import { fsIpc, searchIpc } from "../../core/ipc/fs";
import { basename, samePath } from "../../core/paths/index";
import { showDialog } from "../../ui/Dialog";
import type { WorkbenchServices } from "../../workbench/services";
import { CODE_EXTENSIONS, isCodeFile, type Move, movedPath, rewriteImports } from "./imports";

export interface ImportEdit {
  path: string;
  before: string;
  after: string;
  /** The file starts with a UTF-8 BOM (kept on write). */
  bom: boolean;
}

const BOM = "\uFEFF";
/** Strict: a file that isn't valid UTF-8 isn't rewritten (it would be damaged). */
const decodeStrict = (b: Uint8Array): { text: string; bom: boolean } | null => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
    return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
  } catch {
    return null;
  }
};
const readFile = (path: string) => fsIpc.read(path).then(decodeStrict, () => null);
const encode = (t: string) => new TextEncoder().encode(t);

/** Paths in `/` form for imports.ts, and back. */
const toSlash = (p: string) => p.replace(/\\/g, "/");

/** Every workspace code file that has a relative import (the files that could need edits). */
async function filesWithRelativeImports(): Promise<string[]> {
  const files: string[] = [];
  let truncated = false;
  await new Promise<void>((resolve, reject) => {
    searchIpc
      .start(
        {
          query: "(from|import|require|mock)\\s*\\(?\\s*[\"']\\.\\.?/",
          isRegex: true,
          matchCase: true,
          wholeWord: false,
          include: CODE_EXTENSIONS.map((e) => `*.${e}`),
          exclude: [],
          maxResults: 100_000,
        },
        (event) => {
          if (event.kind === "file") files.push(event.path);
          else {
            truncated = event.truncated;
            resolve();
          }
        },
        true,
      )
      .catch(reject);
  });
  // Some importers would be missed: better none than half (the user is told).
  if (truncated)
    throw new Error("The project has too many imports to update them reliably; none were changed.");
  return files;
}

/** The import edits `moves` call for (nothing written yet). */
export async function planImportEdits(
  services: WorkbenchServices,
  moves: readonly Move[],
): Promise<ImportEdit[]> {
  const relevant = await Promise.all(
    moves.map(async (m) =>
      isCodeFile(m.to) || isCodeFile(m.from)
        ? true
        : await fsIpc.stat(m.to).then(
            (st) => st.kind === "dir",
            () => false,
          ),
    ),
  );
  if (!relevant.some(Boolean)) return [];
  const native = moves.some((m) => m.from.includes("\\"));
  const toNative = (p: string) => (native ? p.replace(/\//g, "\\") : p);
  const slashMoves = moves.map((m) => ({ from: toSlash(m.from), to: toSlash(m.to) }));
  const same = (a: string, b: string) => samePath(toNative(a), toNative(b));
  const cache = new Map<string, Promise<boolean>>();
  // A path as it was before the moves: nothing was where things moved to; moved things are at
  // their new place now.
  const existedBefore = (p: string): Promise<boolean> => {
    let hit = cache.get(p);
    if (!hit) {
      const inDestination = slashMoves.some(
        (m) =>
          same(p, m.to) ||
          (p.length > m.to.length && same(p.slice(0, m.to.length), m.to) && p[m.to.length] === "/"),
      );
      hit = inDestination
        ? Promise.resolve(false)
        : fsIpc.stat(toNative(movedPath(p, slashMoves, same))).then(
            (st) => st.kind === "file",
            () => false,
          );
      cache.set(p, hit);
    }
    return hit;
  };
  const edits: ImportEdit[] = [];
  for (const file of await filesWithRelativeImports()) {
    const buffer = services.quickDiff.bufferText(file);
    const disk = buffer === null ? await readFile(file) : null;
    const before = buffer ?? disk?.text ?? null;
    if (before === null) continue;
    const r = await rewriteImports(before, toSlash(file), slashMoves, existedBefore, same);
    if (r) edits.push({ path: file, before, after: r.text, bom: disk?.bom ?? false });
  }
  return edits;
}

/** The file's text now: the open editor's, else the disk's. */
async function currentText(services: WorkbenchServices, path: string): Promise<string | null> {
  return services.quickDiff.bufferText(path) ?? (await readFile(path))?.text ?? null;
}

/** Writes `text`: into an editor with unsaved changes, else to disk (the editor reloads). */
async function writeText(
  services: WorkbenchServices,
  path: string,
  text: string,
  bom: boolean,
): Promise<void> {
  const buffer = services.quickDiff.bufferText(path);
  let keepBom = bom;
  if (buffer !== null) {
    const disk = await readFile(path);
    if ((disk?.text ?? null) !== buffer && (await services.quickDiff.writeBuffer(path, text)))
      return;
    // An open file's edit was planned from its editor's text, which has no BOM: the disk's says.
    keepBom ||= disk?.bom ?? false;
  }
  await fsIpc.write(path, encode(keepBom ? BOM + text : text), "refactor");
  services.events.emit("files.didChange", { path });
}

/**
 * Applies `edits` one way. "strict": every file must hold the expected text, else nothing is
 * written. "lenient": files that changed since are left (and returned). Either way a write that
 * fails half way puts the files already written back, then throws.
 */
async function applyEdits(
  services: WorkbenchServices,
  edits: readonly ImportEdit[],
  direction: "forward" | "back",
  mode: "strict" | "lenient",
): Promise<string[]> {
  const from = (e: ImportEdit) => (direction === "forward" ? e.before : e.after);
  const to = (e: ImportEdit) => (direction === "forward" ? e.after : e.before);
  const ready: ImportEdit[] = [];
  const changed: string[] = [];
  for (const e of edits)
    if ((await currentText(services, e.path)) === from(e)) ready.push(e);
    else changed.push(basename(e.path));
  if (changed.length && mode === "strict")
    throw new Error(`${changed.join(", ")} changed meanwhile, so no imports were touched.`);
  const written: ImportEdit[] = [];
  try {
    for (const e of ready) {
      await writeText(services, e.path, to(e), e.bom);
      written.push(e);
    }
  } catch (err) {
    for (const e of written.reverse())
      await writeText(services, e.path, from(e), e.bom).catch(() => {});
    throw err;
  }
  return changed;
}

/** What a move's history entry does with its import edits (warnings instead of failures). */
export interface ImportUpdates {
  count: number;
  paths: string[];
  undo(): Promise<void>;
  redo(): Promise<void>;
}

/**
 * After a move: plans the import edits, asks (per `editor.updateImportsOnFileMove`), applies
 * them. Returns the undo/redo hooks for the move's history entry, or undefined.
 */
export async function updateImportsAfterMove(
  services: WorkbenchServices,
  moves: readonly Move[],
  user: boolean,
  /** The caller decided (an agent's `updateImports`): no question, setting ignored. */
  decided?: boolean,
  /** Asked right before writing: false when the move was undone meanwhile (then nothing). */
  stillCurrent: () => boolean = () => true,
): Promise<ImportUpdates | undefined> {
  const setting =
    services.settings.peek<string | undefined>("editor.updateImportsOnFileMove") ?? "prompt";
  const mode = decided === undefined ? setting : decided ? "always" : "never";
  if (mode === "never" || (!user && mode === "prompt")) return undefined;
  const root = services.workspace.root.peek();
  if (!root || !moves.every((m) => services.workspace.contains(m.to))) return undefined;
  let edits: ImportEdit[];
  try {
    edits = await planImportEdits(services, moves);
  } catch (err) {
    if (user)
      services.notifications.show(
        "warning",
        `Imports weren't updated: ${err instanceof Error ? err.message : String(err)}`,
      );
    return undefined;
  }
  if (!edits.length) return undefined;
  if (mode === "prompt") {
    const first = moves[0];
    const what = moves.length === 1 && first ? `'${basename(first.to)}'` : `${moves.length} items`;
    const list = edits
      .slice(0, 6)
      .map((e) => `• ${basename(e.path)}`)
      .join("\n");
    const answer = await showDialog<"yes" | "no" | "always" | "never">({
      title: `Update imports for ${what}?`,
      message: `${edits.length} file${edits.length === 1 ? "" : "s"} import${edits.length === 1 ? "s" : ""} it:\n${list}${edits.length > 6 ? "\n…" : ""}\n\nUndo reverts the imports with the move.`,
      actions: [
        { label: "Never", value: "never" },
        { label: "No", value: "no" },
        { label: "Always", value: "always" },
        { label: "Yes", value: "yes", variant: "primary" },
      ],
      cancelValue: "no",
      defaultValue: "yes",
    });
    if (answer === "never" || answer === "always")
      await services.settings.update("editor.updateImportsOnFileMove", answer).catch(() => {});
    if (answer === "no" || answer === "never") return undefined;
  }
  if (!stillCurrent()) return undefined;
  await applyEdits(services, edits, "forward", "strict");
  const warn = (how: string) => (skipped: string[]) => {
    if (skipped.length)
      services.notifications.show(
        "warning",
        `${skipped.join(", ")} changed since, so ${skipped.length === 1 ? "its" : "their"} imports weren't ${how}.`,
      );
  };
  return {
    count: edits.length,
    paths: edits.map((e) => e.path),
    undo: () => applyEdits(services, edits, "back", "lenient").then(warn("reverted")),
    redo: () => applyEdits(services, edits, "forward", "lenient").then(warn("updated")),
  };
}
