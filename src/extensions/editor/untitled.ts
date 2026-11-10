// Untitled documents (D126, VS Code's Ctrl+N): text editors with no file yet, named
// "Untitled-1", "Untitled-2"… Their path is `untitled:Untitled-N`; saving asks where to put them.
// A file named on the command line that doesn't exist yet is one too (VS Code's behavior):
// `untitled:<its absolute path>`, named after the file, saved there without asking. DOM-free.
import { basename, isAbsolute } from "../../core/paths/index";

export const UNTITLED_PREFIX = "untitled:";

export function isUntitled(path: string): boolean {
  return path.startsWith(UNTITLED_PREFIX);
}

/** The untitled document for a file that doesn't exist yet (absolute `target`). */
export function untitledFor(target: string): string {
  return `${UNTITLED_PREFIX}${target}`;
}

/** Where an untitled document saves to without asking (`untitledFor`'s target), or null. */
export function untitledTarget(path: string): string | null {
  if (!isUntitled(path)) return null;
  const rest = path.slice(UNTITLED_PREFIX.length);
  return isAbsolute(rest) ? rest : null;
}

/** "untitled:Untitled-2" → "Untitled-2"; "untitled:/w/notes.md" → "notes.md". */
export function untitledName(path: string): string {
  const target = untitledTarget(path);
  return target ? basename(target) : path.slice(UNTITLED_PREFIX.length);
}

/** The lowest free `untitled:Untitled-N`. */
export function nextUntitled(open: readonly string[]): string {
  const used = new Set(open.filter(isUntitled));
  for (let n = 1; ; n++) {
    const path = `${UNTITLED_PREFIX}Untitled-${n}`;
    if (!used.has(path)) return path;
  }
}

/** A file name to suggest when saving: from the first line of text (VS Code does the same). */
export function suggestedName(text: string, fallback = "Untitled-1"): string {
  const first =
    text
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim() ?? "";
  const words = first
    .replace(/^[#/*\-<!>\s]+/, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .slice(0, 40)
    .trim();
  return words || fallback;
}
