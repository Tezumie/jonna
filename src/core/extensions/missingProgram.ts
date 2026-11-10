// A program an extension expects in its own folder that isn't there. Open VSX only has the
// all-platform build of some extensions (ms-python.python), and Microsoft ships their per-platform
// programs (python-env-tools' pet.exe) only in the marketplace's platform builds. Starting one
// fails with "spawn <path> ENOENT", which the extension shows as an error on every start (D362).

export interface MissingProgram {
  /** The program's file name ("pet.exe"). */
  program: string;
  /** The folder of the extension that should hold it ("ms-python.python"). */
  extensionFolder: string;
}

/**
 * The program behind an extension's "spawn … ENOENT" message when it lies in an installed
 * extension's folder (under `extensionsDir`); null for any other message, or a program elsewhere
 * (one the user installs, such as python or git, whose error must still show).
 */
export function missingBundledProgram(
  message: string,
  extensionsDir: string,
): MissingProgram | null {
  const match = /\bspawn (.+?) ENOENT\b/.exec(message);
  if (!match?.[1] || !extensionsDir) return null;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = norm(match[1].trim().replace(/^"(.*)"$/, "$1"));
  const dir = `${norm(extensionsDir)}/`;
  // Windows paths compare without case.
  if (!path.toLowerCase().startsWith(dir.toLowerCase())) return null;
  const parts = path.slice(dir.length).split("/");
  const extensionFolder = parts[0];
  const program = parts[parts.length - 1];
  if (parts.length < 2 || !extensionFolder || !program || parts.includes("..")) return null;
  return { program, extensionFolder };
}
