// The Python interpreter Pyright resolves imports with (D200; VS Code's "Python: Select
// interpreter"): `python.defaultInterpreterPath` when set, else a virtual environment in the
// folder (.venv, venv, env), else whatever Pyright finds on PATH. Given to Pyright as
// `python.pythonPath` (workspace/configuration), so a venv's packages resolve. DOM-free parts are
// tested.

/** Virtual environment folders looked for in the folder's root, in this order. */
export const VENV_DIRS = [".venv", "venv", "env"];

/** The interpreter inside a virtual environment folder. */
export function venvPython(venv: string, platform: string): string {
  const sep = platform === "windows" ? "\\" : "/";
  return platform === "windows"
    ? `${venv}${sep}Scripts${sep}python.exe`
    : `${venv}${sep}bin${sep}python`;
}

/** Candidate interpreters for a root: one per venv folder name, in order. */
export function venvCandidates(root: string, platform: string): string[] {
  const sep = platform === "windows" ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  return VENV_DIRS.map((d) => venvPython(`${base}${sep}${d}`, platform));
}

/**
 * The interpreter to give Pyright: the setting (with `${workspaceFolder}` expanded), else the
 * first venv that exists.
 */
export function pickInterpreter(
  setting: string | undefined,
  root: string,
  existing: readonly string[],
): string | undefined {
  const own = setting?.trim();
  if (own) return own.replace(/\$\{workspaceFolder\}/g, root.replace(/[\\/]+$/, ""));
  return existing[0];
}

/** Pyright's settings for an interpreter (merged over its own). */
export function pyrightSettings(
  interpreter: string | undefined,
): Record<string, unknown> | undefined {
  return interpreter ? { python: { pythonPath: interpreter } } : undefined;
}
