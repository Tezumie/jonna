// Problem counts per file and folder for the problems decorations (D279). DOM-free.

import { dirname, pathKey } from "../../core/paths/index";
import type { Diagnostic } from "./engine";

/** A file's errors and warnings, and the folders above files that have some. */
export interface ProblemCounts {
  files: Map<string, { errors: number; warnings: number }>;
  /** Folder key → whether something under it has an error (else only warnings). */
  dirs: Map<string, boolean>;
}

/** Counts per file (by `pathKey`) and the folders holding them, up to the drive or `/`. */
export function countProblems(list: readonly Diagnostic[]): ProblemCounts {
  const files = new Map<string, { errors: number; warnings: number }>();
  for (const d of list) {
    if (d.severity !== "error" && d.severity !== "warning") continue;
    const key = pathKey(d.path);
    const c = files.get(key) ?? { errors: 0, warnings: 0 };
    if (d.severity === "error") c.errors++;
    else c.warnings++;
    files.set(key, c);
  }
  const dirs = new Map<string, boolean>();
  for (const [key, c] of files) {
    for (let dir = dirname(key); ; ) {
      const had = dirs.get(dir);
      if (had === true || (had === false && c.errors === 0)) break;
      dirs.set(dir, c.errors > 0);
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return { files, dirs };
}
