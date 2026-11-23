// Hunk staging (D66): the change under a line is computed in TS with a line diff of working-tree-
// form texts (index from `cat-file --filters`, the buffer or file), applied to the index text and
// written back with `git_write_index`; reverting edits the open document (undoable) or the file.
import {
  applyChange,
  applySelectedLines,
  changeAtLine,
  diffLines,
  type LineChange,
  revertChange,
  splitLines,
} from "../../core/diff/index";
import { fsIpc } from "../../core/ipc/fs";
import { type GitIpc, gitIpc } from "../../core/ipc/git";
import { basename } from "../../core/paths/index";
import type { WorkbenchServices } from "../../workbench/services";

const BOM = "﻿";

function stripBom(text: string): { text: string; bom: boolean } {
  return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
}

/** U+FFFD: what a decoder leaves where the bytes weren't the text it expected. */
const REPLACEMENT = String.fromCharCode(0xfffd);

/** The bytes as UTF-8 text, or null when they aren't UTF-8 (nothing is replaced, nothing lost). */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * True when git's text of a file lost characters the working text has: the backend hands a
 * version over as UTF-8 with U+FFFD for every byte that isn't (a Windows-1252 "é"), so writing
 * lines of it to the index or the file would put U+FFFD where the letters were. A file that
 * holds U+FFFD itself has it on both sides.
 */
export function lostCharacters(gitText: string, workingText: string | null): boolean {
  return gitText.includes(REPLACEMENT) && !(workingText ?? "").includes(REPLACEMENT);
}

function notUtf8(path: string): Error {
  return new Error(
    `${basename(path)} isn't UTF-8 text, so one change of it can't be staged, unstaged or reverted here without damaging its other lines. Stage or discard the whole file instead.`,
  );
}

/** The file as the user sees it: the open buffer (unsaved edits included) or the file on disk. */
export async function currentText(services: WorkbenchServices, path: string): Promise<string> {
  return (await current(services, path)).text;
}

async function current(
  services: WorkbenchServices,
  path: string,
): Promise<{ text: string; bom: boolean }> {
  const buffer = services.quickDiff.bufferText(path);
  if (buffer !== null) return { text: buffer, bom: false };
  // Strictly: a file in another encoding decoded with replacements would be written back (to
  // the index, or to disk on a revert) with U+FFFD for every character past ASCII.
  const text = decodeUtf8Strict(await fsIpc.read(path));
  if (text === null) throw notUtf8(path);
  return stripBom(text);
}

interface Located {
  original: string[];
  modified: string[];
  change: LineChange;
  bom: boolean;
}

function locate(originalText: string, modifiedText: string, line: number): Located {
  const { text, bom } = stripBom(originalText);
  const original = splitLines(text);
  const modified = splitLines(modifiedText);
  const change = changeAtLine(diffLines(original, modified), line);
  if (!change) throw new Error(`No change at line ${line}.`);
  return { original, modified, change, bom };
}

/** Stages the change touching `line` of the working file. */
export async function stageChange(
  services: WorkbenchServices,
  path: string,
  line: number,
  ipc: GitIpc = gitIpc,
): Promise<void> {
  const index = (await ipc.show("", path, true)) ?? "";
  const working = await currentText(services, path);
  if (lostCharacters(index, working)) throw notUtf8(path);
  const { original, modified, change, bom } = locate(index, working, line);
  const next = applyChange(original, modified, change);
  await ipc.writeIndex(path, bom ? BOM + next : next);
}

/**
 * Stages only lines `from`..`to` of the working file (D200, VS Code's "Stage selected ranges"):
 * the changes on those lines, a partly selected one with just its selected new lines.
 */
export async function stageLines(
  services: WorkbenchServices,
  path: string,
  from: number,
  to: number,
  ipc: GitIpc = gitIpc,
): Promise<void> {
  const index = stripBom((await ipc.show("", path, true)) ?? "");
  const working = await currentText(services, path);
  if (lostCharacters(index.text, working)) throw notUtf8(path);
  const original = splitLines(index.text);
  const modified = splitLines(working);
  const next = applySelectedLines(original, modified, from, to);
  if (next === original.join("")) throw new Error(`No unstaged change on lines ${from}–${to}.`);
  await ipc.writeIndex(path, index.bom ? BOM + next : next);
}

/** Unstages the staged change touching `line` of the index version (HEAD vs index). */
export async function unstageChange(
  path: string,
  line: number,
  ipc: GitIpc = gitIpc,
): Promise<void> {
  const head = (await ipc.show("HEAD", path, true)) ?? "";
  const index = stripBom((await ipc.show("", path, true)) ?? "");
  if (head.includes(REPLACEMENT) || index.text.includes(REPLACEMENT)) {
    // Both texts come from git, already decoded: only the working file can tell whether the
    // U+FFFD is the file's own. Unreadable or not UTF-8, it can't.
    const working = await fsIpc.read(path).then(decodeUtf8Strict, () => null);
    if (lostCharacters(head, working) || lostCharacters(index.text, working)) throw notUtf8(path);
  }
  const { original, modified, change, bom } = locate(head, index.text, line);
  const next = revertChange(original, modified, change);
  await ipc.writeIndex(path, bom || index.bom ? BOM + next : next);
}

/** Reverts the working-file change touching `line` back to the index text. */
export async function revertWorkingChange(
  services: WorkbenchServices,
  path: string,
  line: number,
  ipc: GitIpc = gitIpc,
): Promise<void> {
  const index = (await ipc.show("", path, true)) ?? "";
  const file = await current(services, path);
  if (lostCharacters(index, file.text)) throw notUtf8(path);
  const { original, modified, change } = locate(index, file.text, line);
  const next = revertChange(original, modified, change);
  if (await services.quickDiff.writeBuffer(path, next)) return;
  await fsIpc.write(path, new TextEncoder().encode(file.bom ? BOM + next : next), "git");
  services.events.emit("files.didChange", { path });
}
