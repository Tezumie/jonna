// The VS Code packages of the shared Node extension host (D295): VS Code runs every extension in
// one process, so another extension's API is its live exports object. This registry is what that
// process knows about them: the installed and enabled packages (the IDE sends the list), which
// have activated here and with what exports, and whose folder a file is in — `require("vscode")`
// gets the shim of the extension whose folder the requiring file is in, as VS Code finds it by
// the requiring module's path, and console output is told apart by the files on its stack.
// DOM-free and unit-tested.

/** An installed, enabled VS Code package as the IDE lists it. */
export interface InstalledExtension {
  /** Its id as the IDE has it ("publisher.name", lowercase). */
  id: string;
  /** Its folder (absolute). */
  path: string;
  /** It has code (`main`): activating it runs that. Without, it activates at once. */
  hasCode: boolean;
}

/**
 * A path compared as a folder prefix: forward slashes, `.` and `..` resolved (an extension loaded
 * from "…/sample/../extensions/x" while stack traces name the resolved file), no trailing slash,
 * case-folded on Windows.
 */
export function normalize(path: string, foldCase: boolean): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === ".") continue;
    if (part === ".." && parts.length > 1 && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(part);
  }
  const p = parts.join("/").replace(/\/+$/, "");
  return foldCase ? p.toLowerCase() : p;
}

export class SharedExtensionRegistry {
  private installed = new Map<string, InstalledExtension>();
  /** Extensions active in this process (lowercase id → its exports). */
  private readonly active = new Map<string, unknown>();
  /** Folders of extensions running here even when the IDE's list doesn't have them yet. */
  private readonly running = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly foldCase: boolean;

  constructor(platform: string) {
    this.foldCase = platform === "win32";
  }

  /** The IDE's list changed (installed, uninstalled, enabled, disabled). */
  setInstalled(list: readonly InstalledExtension[]): void {
    const next = new Map<string, InstalledExtension>();
    for (const e of list)
      if (e && typeof e.id === "string" && typeof e.path === "string")
        next.set(e.id.toLowerCase(), { id: e.id, path: e.path, hasCode: e.hasCode === true });
    const same =
      next.size === this.installed.size &&
      [...next].every(([k, v]) => {
        const old = this.installed.get(k);
        return old?.path === v.path && old.hasCode === v.hasCode;
      });
    this.installed = next;
    if (!same) this.fire();
  }

  /** One that starts here: known by its folder from now on, even before the list has it. */
  addRunning(id: string, path: string): void {
    this.running.set(id.toLowerCase(), path);
  }

  get(id: string): InstalledExtension | undefined {
    const key = id.toLowerCase();
    const listed = this.installed.get(key);
    if (listed) return listed;
    const path = this.running.get(key);
    return path ? { id: key, path, hasCode: true } : undefined;
  }

  list(): InstalledExtension[] {
    const out = [...this.installed.values()];
    for (const [id, path] of this.running)
      if (!this.installed.has(id)) out.push({ id, path, hasCode: true });
    return out;
  }

  /** Its `activate` returned (`exports` is what it returned). */
  setActive(id: string, exports: unknown): void {
    this.active.set(id.toLowerCase(), exports);
    this.fire();
  }

  /** It stopped here (disabled, uninstalled, reloaded). */
  remove(id: string): void {
    const key = id.toLowerCase();
    const had = this.active.delete(key);
    this.running.delete(key);
    if (had) this.fire();
  }

  isActive(id: string): boolean {
    return this.active.has(id.toLowerCase());
  }

  exportsOf(id: string): unknown {
    return this.active.get(id.toLowerCase());
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The extension whose folder `file` is in (the deepest folder when they nest). */
  ownerOf(file: string): string | undefined {
    const target = normalize(file, this.foldCase);
    let best: { id: string; length: number } | undefined;
    const consider = (id: string, path: string) => {
      const root = normalize(path, this.foldCase);
      if (!root || (target !== root && !target.startsWith(`${root}/`))) return;
      if (!best || root.length > best.length) best = { id, length: root.length };
    };
    for (const [id, path] of this.running) consider(id, path);
    for (const e of this.installed.values()) consider(e.id.toLowerCase(), e.path);
    return best?.id;
  }

  /** The first extension file on a call stack (`new Error().stack`), or undefined. */
  ownerOfStack(stack: string | undefined): string | undefined {
    for (const file of stackFiles(stack ?? "")) {
      const owner = this.ownerOf(file);
      if (owner) return owner;
    }
    return undefined;
  }

  private fire(): void {
    for (const l of [...this.listeners])
      try {
        l();
      } catch {
        // A listener's failure isn't the registry's.
      }
  }
}

/** The files a V8 stack trace names, top first ("at f (C:\a\b.js:1:2)", "at /a/b.js:1:2"). */
export function stackFiles(stack: string): string[] {
  const files: string[] = [];
  for (const line of stack.split("\n")) {
    const m = /(?:\(|at )((?:[A-Za-z]:[\\/]|\/|\\\\)[^()]*?):\d+:\d+\)?\s*$/.exec(line.trim());
    if (m?.[1]) files.push(m[1]);
  }
  return files;
}
