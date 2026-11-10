// read_file and list_dir on an installed extension's folder (D176, read-only), split from tools.ts:
// the extension store's own reader, which stays inside the folder.

import type { ToolOutcome } from "../../core/agent/loop";
import { extIpc } from "../../core/ipc/extensions";
import { AGENT_READ_MAX_BYTES } from "./changeset";

/** Most lines one read_file returns (the rest with offset). */
export const READ_LIMIT = 400;
/** Longest line read_file shows whole. */
export const LINE_LIMIT = 2000;

export type ExtensionTarget = { id: string; root: string; rel: string };

/** read_file on an installed extension's file (read-only, D176). */
export async function readExtensionFile(
  ext: ExtensionTarget,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const name = `${ext.id}/${ext.rel}`;
  const fail = (result: string, summary: string): ToolOutcome => ({
    result: `Error: ${result}`,
    isError: true,
    summary,
  });
  if (!ext.rel) return fail(`${name} is the extension's folder; use list_dir.`, "folder");
  // Dot files (.env, .git) aren't listed or shared, as in the extension's Files tab.
  if (ext.rel.split(/[\\/]/).some((p) => p.startsWith(".") && p.length > 1 && p !== ".."))
    return fail(`${name} is a hidden file; it isn't shared.`, "hidden");
  const bytes = await extIpc.read(ext.root, ext.rel).catch(() => null);
  if (!bytes) return fail(`${name} can't be read (missing, a folder, or too large).`, "not found");
  if (bytes.length > AGENT_READ_MAX_BYTES)
    return fail(`${name} is too large to read.`, "too large");
  if (bytes.subarray(0, 8000).includes(0)) return fail(`${name} is a binary file.`, "binary");
  const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
  const offset = Math.max(1, Number(args.offset) || 1);
  const limit = Math.min(READ_LIMIT, Math.max(1, Number(args.limit) || READ_LIMIT));
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const body = slice
    .map(
      (l, i) =>
        `${String(offset + i).padStart(5)}| ${l.length > LINE_LIMIT ? `${l.slice(0, LINE_LIMIT)}… [${l.length - LINE_LIMIT} more characters]` : l}`,
    )
    .join("\n");
  const rest = lines.length - (offset - 1 + slice.length);
  return {
    result: `(Extension ${ext.id}, read-only: change a development copy in the open folder instead.)\n${body}${rest > 0 ? `\n… ${rest} more lines (offset ${offset + slice.length})` : ""}`,
    summary: `${slice.length} lines`,
  };
}

/** list_dir in an installed extension's folder (read-only, D176). */
export async function listExtensionFolder(
  ext: ExtensionTarget,
  depth: number,
): Promise<ToolOutcome> {
  const files = await extIpc.files(ext.root).catch(() => null);
  if (!files)
    return {
      result: `Error: ${ext.id}'s folder can't be listed.`,
      isError: true,
      summary: "error",
    };
  const prefix = ext.rel ? `${ext.rel.replaceAll("\\", "/")}/` : "";
  const out = new Set<string>();
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    const parts = f.path.slice(prefix.length).split("/");
    // Folders down to `depth`, files at their own level.
    for (let i = 1; i <= Math.min(depth, parts.length); i++)
      out.add(`${parts.slice(0, i).join("/")}${i < parts.length ? "/" : ""}`);
  }
  const list = [...out].sort().slice(0, 500);
  return {
    result: `(Extension ${ext.id}, read-only; read files with read_file and their full path.)\n${list.join("\n") || "(empty)"}`,
    summary: `${list.length} entries`,
  };
}
