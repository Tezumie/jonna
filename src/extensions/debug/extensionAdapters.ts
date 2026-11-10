// Extensions' debuggers (D233, `ide.debug.registerDebugAdapterDescriptorFactory` and the
// manifest's `debuggers`): a launch configuration of an extension's type runs through the
// adapter the extension supplies (an executable, a server port or an inline adapter; the
// extensions host makes the connection), and its configuration snippets join "Add
// configuration…". DOM-free.
import type { WorkbenchServices } from "../../workbench/services";
import type { Adapter, LaunchConfig } from "./launch";
import { CONFIG_SNIPPETS, type ConfigSnippet } from "./snippets";

/**
 * The extension's adapter for `config`, or null (the IDE's own, or `debugAdapter`, runs it). Its
 * factory gets the session the debugger made (`parentId`: the session it runs under), so the
 * extension's DebugSession is the one `customRequest` and the session events name.
 */
export function extensionAdapter(
  services: WorkbenchServices,
  config: LaunchConfig,
  parentId?: string | null,
): Adapter | null {
  // A configuration's own `debugAdapter` wins, as it does over the built-in ones.
  if (config.debugAdapter) return null;
  const entry = services.extensionFeatures.debugAdapters.get(config.type);
  if (!entry) return null;
  return {
    kind: "dap",
    command: entry.label,
    args: [],
    adapterId: config.type,
    connect: (exited, sessionId) =>
      entry.connect(config.raw, exited, {
        id: sessionId,
        name: config.name,
        ...(parentId && { parentId }),
      }),
  };
}

/** The built-in snippets, then extensions' (their labels can't hide a built-in one). */
export function allSnippets(services: WorkbenchServices): ConfigSnippet[] {
  const own = new Set(CONFIG_SNIPPETS.map((c) => c.label));
  const more = services.extensionFeatures.debugAdapters.all
    .peek()
    .flatMap((a) => a.snippets)
    .filter((s) => !own.has(s.label))
    .map((s): ConfigSnippet => ({ ...s, into: "configurations" }));
  const seen = new Set<string>();
  return [...CONFIG_SNIPPETS, ...more.filter((s) => !seen.has(s.label) && seen.add(s.label))];
}

/**
 * "Add configuration…" entries extensions' code provides (VS Code's provideDebugConfigurations),
 * asked each time the list opens, for the folder whose launch.json gets them (D251: default the
 * first); a label the list already has is skipped.
 */
export async function providedSnippets(
  services: WorkbenchServices,
  have: readonly ConfigSnippet[],
  forFolder?: string | null,
): Promise<ConfigSnippet[]> {
  const folder = forFolder ?? services.workspace.root.peek();
  const lists = await Promise.all(
    services.extensionFeatures.debugAdapters.all
      .peek()
      .map((a) => a.provideConfigurations?.(folder).catch(() => []) ?? Promise.resolve([])),
  );
  const seen = new Set(have.map((c) => c.label));
  return lists
    .flat()
    .filter((c) => !seen.has(c.label) && !!seen.add(c.label))
    .map((c): ConfigSnippet => ({ ...c, into: "configurations" }));
}
