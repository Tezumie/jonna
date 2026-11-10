// Activation as VS Code does it (D295; microsoft/vscode extHostExtensionActivator.ts and
// abstractExtensionService.ts): the activation events that fired this session (an extension
// enabled or installed later, or let run once the folder is trusted, activates if one of its
// events already fired), `extensionDependencies` (dependencies activate first; a missing or
// failed one refuses with VS Code's own message), and the extension host's restarts after a crash
// (at most 3 in 5 minutes). DOM-free and unit-tested.

/** The activation events that fired in this window. */
export class ActivationMemory {
  private readonly fired = new Set<string>();

  record(event: string): void {
    if (event) this.fired.add(event);
  }

  clear(): void {
    this.fired.clear();
  }

  has(event: string): boolean {
    return this.fired.has(event);
  }

  /** Whether one of `activation` (an extension's events) already fired. */
  matches(activation: readonly string[]): boolean {
    for (const event of activation) {
      if (this.fired.has(event)) return true;
      // "onNotebook:*" / "onLanguage:*" stand for any of their kind.
      const star = /^(onNotebook|onLanguage|onDebugResolve|onFileSystem):\*$/.exec(event);
      if (star && [...this.fired].some((f) => f.startsWith(`${star[1]}:`))) return true;
      // Any debug session's start is "onDebug".
      if (event === "onDebug" && [...this.fired].some((f) => f.startsWith("onDebug"))) return true;
    }
    return false;
  }

  /** What fired, for state (`ide://extensions`). */
  list(): string[] {
    return [...this.fired];
  }
}

/** VS Code's "extension host restarts after a crash": at most `max` in `windowMs`. */
export class RestartBudget {
  private readonly times: number[] = [];

  constructor(
    private readonly max = 3,
    private readonly windowMs = 5 * 60_000,
  ) {}

  /** Whether another restart is allowed now (and counts it when it is). */
  take(now: number): boolean {
    while (this.times.length && now - (this.times[0] ?? 0) >= this.windowMs) this.times.shift();
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}

/** The ids a VS Code package.json lists in `extensionDependencies` (lowercase, as the IDE's ids). */
export function extensionDependencies(packageJson: unknown): string[] {
  const raw = (packageJson as { extensionDependencies?: unknown } | null)?.extensionDependencies;
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .filter((d): d is string => typeof d === "string" && /^[^.\s]+\.[^\s]+$/.test(d))
    .map((d) => d.toLowerCase());
  return [...new Set(ids)].slice(0, 50);
}

/** VS Code's own built-in extensions (`vscode.git`): always there for a dependency. */
export const isBuiltInExtension = (id: string): boolean => id.toLowerCase().startsWith("vscode.");

/** What the IDE knows about a dependency when an extension activates. */
export type DependencyState =
  /** Not installed, disabled or not allowed to run: VS Code's "unknown extension". */
  | { kind: "missing" }
  /** Installed and enabled, without code: nothing to activate. */
  | { kind: "declarative" }
  /** With code: activate it first (rejects when its activation failed). */
  | { kind: "code"; displayName: string; activate(): Promise<void> };

/** VS Code's error when a dependency isn't there. */
export function unknownDependencyMessage(displayName: string, dependency: string): string {
  return `Cannot activate the '${displayName}' extension because it depends on unknown extension '${dependency}'`;
}

/** VS Code's error when a dependency's activation failed. */
export function failedDependencyMessage(displayName: string, dependency: string): string {
  return `Cannot activate the '${displayName}' extension because its dependency '${dependency}' failed to activate`;
}

/**
 * Activates `dependencies` (in order, each before what depends on it) for the extension
 * `displayName`; throws VS Code's message when one is missing or fails. A cycle is the caller's
 * to cut (`state` says "declarative" for one already resolving its own dependencies).
 */
export async function activateDependencies(
  displayName: string,
  dependencies: readonly string[],
  state: (id: string) => DependencyState,
): Promise<void> {
  for (const dep of dependencies) {
    if (isBuiltInExtension(dep)) continue;
    const s = state(dep);
    if (s.kind === "missing") throw new Error(unknownDependencyMessage(displayName, dep));
    if (s.kind === "declarative") continue;
    try {
      await s.activate();
    } catch {
      throw new Error(failedDependencyMessage(displayName, s.displayName));
    }
  }
}

/**
 * Extensions that depend on `id`, directly or through another (VS Code asks about all of them
 * when `id` is disabled or uninstalled).
 */
export function dependentsOf(
  id: string,
  extensions: readonly { id: string; dependencies: readonly string[] }[],
): string[] {
  const out: string[] = [];
  const queue = [id.toLowerCase()];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const e of extensions) {
      const eid = e.id.toLowerCase();
      if (eid === id.toLowerCase() || out.includes(eid)) continue;
      if (e.dependencies.some((d) => d.toLowerCase() === current)) {
        out.push(eid);
        queue.push(eid);
      }
    }
  }
  return out;
}
