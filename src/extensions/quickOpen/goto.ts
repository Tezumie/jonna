// Parses quick-open input: "main.ts:12", "main.ts:12:5", or just ":12" (go to line in the active
// editor). DOM-free and tested.
import { resolveInRoot, samePath } from "../../core/paths/index";

export interface QuickOpenQuery {
  /** File query (may be empty). */
  file: string;
  line?: number;
  column?: number;
}

export function parseQuickOpen(input: string): QuickOpenQuery {
  const m = /^(.*?):(\d+)(?::(\d+))?\s*$/.exec(input.trim());
  if (!m) return { file: input.trim() };
  const line = Number(m[2]);
  const column = m[3] ? Number(m[3]) : undefined;
  return {
    file: (m[1] ?? "").trim(),
    ...(line > 0 && { line }),
    ...(column !== undefined && column > 0 && { column }),
  };
}

/** Most recent first, without duplicates, at most `max`. */
export function pushRecent(list: readonly string[], path: string, max = 50): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, max);
}

/**
 * A file index item (D251: `path` relative to its own folder, `root` set only for a folder other
 * than the first) as quick open shows it: its absolute path, and its workspace path — the folder's
 * name first when there are several, with the match positions moved past it.
 */
export function indexItemFile(
  item: { path: string; positions: readonly number[]; root?: string },
  folders: readonly { path: string; name: string }[],
  primary: string,
): { path: string; rel: string; positions: number[] } {
  const base = item.root ?? primary;
  const path = resolveInRoot(base, item.path);
  const folder = folders.length > 1 ? folders.find((f) => samePath(f.path, base)) : undefined;
  if (!folder) return { path, rel: item.path, positions: [...item.positions] };
  const shift = folder.name.length + 1;
  return {
    path,
    rel: `${folder.name}/${item.path}`,
    positions: item.positions.map((p) => p + shift),
  };
}
