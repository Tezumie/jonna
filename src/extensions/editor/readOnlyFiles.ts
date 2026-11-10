// Which files the editor keeps read-only beyond those that can't be written (not UTF-8, generated
// text), as VS Code 1.79 does: `files.readonlyInclude` / `files.readonlyExclude` ({ glob: true }
// maps matched against the workspace-relative path, or the absolute path for a file outside the
// folder), `files.readonlyFromPermissions` (a file without write permission on disk), and the
// session overrides of "Set active editor read-only / writeable in session", which win over all
// three until reset or the window closes. DOM-free, tested.

import { isExcluded } from "../../core/paths/glob";

export interface ReadOnlyRules {
  readonly include: Readonly<Record<string, unknown>>;
  readonly exclude: Readonly<Record<string, unknown>>;
  /** files.readonlyFromPermissions is on and the file has no write permission on disk. */
  readonly noWritePermission: boolean;
}

/** Whether the settings make a file read-only (no session override). */
export function readOnlyBySettings(
  relative: string,
  absolute: string,
  rules: ReadOnlyRules,
): boolean {
  if (rules.noWritePermission) return true;
  const matches = (patterns: Readonly<Record<string, unknown>>) =>
    (relative !== "" && isExcluded(relative, patterns)) ||
    isExcluded(absolute.replace(/\\/g, "/"), patterns);
  return matches(rules.include) && !matches(rules.exclude);
}

/** The session's overrides, by path key (see core/paths pathKey: case-insensitive on Windows). */
export class ReadOnlySession {
  private readonly forced = new Map<string, boolean>();

  /** True / false: read-only / writable whatever the settings say; undefined: no override. */
  get(key: string): boolean | undefined {
    return this.forced.get(key);
  }

  set(key: string, readOnly: boolean | null): void {
    if (readOnly === null) this.forced.delete(key);
    else this.forced.set(key, readOnly);
  }

  /** A renamed file keeps its override. */
  rename(from: string, to: string): void {
    const value = this.forced.get(from);
    if (value === undefined) return;
    this.forced.delete(from);
    this.forced.set(to, value);
  }

  /** Paths with an override (the state tree lists them). */
  entries(): [string, boolean][] {
    return [...this.forced.entries()];
  }
}

/** The session override first, then the settings. */
export function isReadOnlyFile(
  override: boolean | undefined,
  relative: string,
  absolute: string,
  rules: ReadOnlyRules,
): boolean {
  return override ?? readOnlyBySettings(relative, absolute, rules);
}
