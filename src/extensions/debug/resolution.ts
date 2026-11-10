// How a launch configuration is resolved before its session starts, in VS Code's order
// (debugService.createSession, debugConfigurationManager): every extension's configuration
// providers for its type, then those for "*", each resolveDebugConfiguration in turn — again for
// the new type while a resolver changes it, activating `onDebugResolve:<type>` first — then
// variables are filled in, the preLaunchTask runs, and resolveDebugConfigurationWithSubstitutedVariables
// runs the same way (the type's providers, then "*"). A resolver answering null or undefined
// cancels the launch. Which debugger runs it is chosen after all that, by the resolved type.
// DOM-free and tested.

/** A resolver's answer: the configuration to go on with, or null / undefined (cancelled). */
export type ResolveStep = (
  folder: string | null,
  configuration: Record<string, unknown>,
) => Promise<unknown>;

export interface ResolverSource {
  /** VS Code's activateDebuggers("onDebugResolve", type). */
  activate(type: string): Promise<void>;
  resolvers(step: "resolve" | "substituted", type: string): ResolveStep[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/** Runs `steps` one after another; null when one cancels (or answers something else). */
async function pipe(
  steps: readonly ResolveStep[],
  folder: string | null,
  configuration: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  let current: Record<string, unknown> = configuration;
  for (const step of steps) {
    const next = await step(folder, current);
    if (!isRecord(next)) return null;
    current = next;
  }
  return current;
}

/**
 * VS Code's resolveConfigurationByProviders: for the configuration's type, then "*", each
 * provider's resolveDebugConfiguration; repeated for a type a resolver changed it to (each type
 * once). Null: a resolver cancelled.
 */
export async function resolveByProviders(
  configuration: Record<string, unknown>,
  folder: string | null,
  source: ResolverSource,
): Promise<Record<string, unknown> | null> {
  const typeOf = (c: Record<string, unknown>, fallback: string) =>
    typeof c.type === "string" && c.type ? c.type : fallback;
  let type = typeOf(configuration, "");
  let result: Record<string, unknown> | null = configuration;
  const seen = new Set<string>();
  while (result && !seen.has(type)) {
    seen.add(type);
    if (type) await source.activate(type);
    result = await pipe(source.resolvers("resolve", type), folder, result);
    if (!result) return null;
    result = await pipe(source.resolvers("resolve", "*"), folder, result);
    if (!result) return null;
    type = typeOf(result, type);
  }
  return result;
}

/**
 * VS Code's resolveDebugConfigurationWithSubstitutedVariables: the type's providers, then the
 * "*" ones. Null: a resolver cancelled.
 */
export async function resolveWithSubstitutedVariables(
  configuration: Record<string, unknown>,
  folder: string | null,
  source: ResolverSource,
): Promise<Record<string, unknown> | null> {
  const type = typeof configuration.type === "string" ? configuration.type : "";
  return pipe(
    [...source.resolvers("substituted", type), ...source.resolvers("substituted", "*")],
    folder,
    configuration,
  );
}

/** Whether any extension resolves configurations of `type` (or every type) at `step`. */
export function hasResolvers(
  source: ResolverSource,
  step: "resolve" | "substituted",
  type: string,
): boolean {
  return source.resolvers(step, type).length > 0 || source.resolvers(step, "*").length > 0;
}
