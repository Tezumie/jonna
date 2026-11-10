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
import type { WorkbenchServices } from "../../workbench/services";

const BOM = "﻿";

function stripBom(text: string): { text: string; bom: boolean } {
  return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
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
  return stripBom(new TextDecoder("utf-8").decode(await fsIpc.read(path)));
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
  const index = (await ipc.show("", path)) ?? "";
  const { original, modified, change, bom } = locate(
    index,
    await currentText(services, path),
    line,
  );
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
  const index = stripBom((await ipc.show("", path)) ?? "");
  const original = splitLines(index.text);
  const modified = splitLines(await currentText(services, path));
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
  const head = (await ipc.show("HEAD", path)) ?? "";
  const index = stripBom((await ipc.show("", path)) ?? "");
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
  const index = (await ipc.show("", path)) ?? "";
  const file = await current(services, path);
  const { original, modified, change } = locate(index, file.text, line);
  const next = revertChange(original, modified, change);
  if (await services.quickDiff.writeBuffer(path, next)) return;
  await fsIpc.write(path, new TextEncoder().encode(file.bom ? BOM + next : next), "git");
  services.events.emit("files.didChange", { path });
}
