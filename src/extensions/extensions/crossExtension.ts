// What VS Code packages share across extensions (D295), as the manager answers it: one command
// registry (a declared command by its VS Code id, one registered only in code through its owner),
// view containers another package declares, and the list `vscode.extensions` shows in the shared
// host. Split from manager.ts by responsibility; DOM-free and unit-tested.

import type {
  ContributedViewContainer,
  ThirdPartyManifest,
} from "../../core/extensions/thirdParty";
import type { InstalledExtension } from "../../core/extensions/vscode/extensionRegistry";

/** A loaded extension, as these lookups see it. */
export interface LoadedExtension {
  manifest: ThirdPartyManifest;
  root: string;
  /** Runs a command it registered in code only (in its worker). */
  runCodeCommand(id: string, args: unknown[]): Promise<unknown>;
}

/** An extension record, as these lookups see it (manager.ts ExtensionRecord). */
export interface ListedExtension {
  id: string;
  root: string;
  status: string;
  manifest?: ThirdPartyManifest | null;
}

/**
 * Commands extensions registered in code only (not in their manifest): VS Code id → owner. The
 * first owner keeps an id while it's loaded (VS Code refuses a second registration).
 */
export class CodeCommandOwners {
  private readonly owners = new Map<string, string>();

  /** `owner` registered `id` in code; `isLoaded` tells whether a previous owner still runs. */
  announce(owner: string, id: string, isLoaded: (id: string) => boolean): void {
    if (id.length > 200 || id.startsWith("_")) return;
    const current = this.owners.get(id);
    if (current && current !== owner && isLoaded(current)) return;
    this.owners.set(id, owner);
  }

  ownerOf(id: string): string | undefined {
    return this.owners.get(id);
  }

  /** `owner` stopped: its commands go. */
  forget(owner: string): void {
    for (const [command, o] of this.owners) if (o === owner) this.owners.delete(command);
  }
}

/**
 * Another extension's VS Code command `id` (VS Code has one registry for every extension's
 * commands): a declared one by its dispatcher id (it activates its extension), one registered in
 * code through its owner's worker. Undefined: no other extension has it.
 */
export function routeVscodeCommand(
  loaded: ReadonlyMap<string, LoadedExtension>,
  owners: CodeCommandOwners,
  caller: string,
  id: string,
  args: unknown[],
): { command: string; input: unknown } | { run(): Promise<unknown> } | undefined {
  for (const [ext, runtime] of loaded) {
    if (ext === caller || runtime.manifest.format !== "vscode") continue;
    const c = runtime.manifest.contributes.commands.find(
      (x) => (x.vscodeId ?? x.id) === id && !x.vscodeTool,
    );
    if (c) return { command: c.id, input: { arguments: args } };
  }
  const owner = owners.ownerOf(id);
  const runtime = owner && owner !== caller ? loaded.get(owner) : undefined;
  return runtime ? { run: () => runtime.runCodeCommand(id, args) } : undefined;
}

/**
 * A view container another enabled VS Code package declares (VS Code's containers are shared:
 * Cell Tags puts its view in Jupyter's panel). Loaded ones first, then the records being read
 * (an extension that starts later in this refresh), unless disabled or invalid.
 */
export function findViewContainer(
  loaded: Iterable<LoadedExtension>,
  reading: readonly ListedExtension[],
  disabled: readonly string[],
  caller: string,
  id: string,
): ContributedViewContainer | undefined {
  const manifests = [
    ...[...loaded].map((l) => l.manifest),
    ...reading.flatMap((r) =>
      r.manifest && r.status !== "invalid" && r.status !== "disabled" && !disabled.includes(r.id)
        ? [r.manifest]
        : [],
    ),
  ];
  for (const m of manifests) {
    if (m.id === caller || m.format !== "vscode") continue;
    const found = m.contributes.viewContainers?.find((c) => c.id === id);
    if (found) return found;
  }
  return undefined;
}

/**
 * Every installed and enabled VS Code package, with code or not (D295): what `vscode.extensions`
 * lists in the shared host — those starting while the list is made included.
 */
export function vscodePackageList(
  records: readonly ListedExtension[],
  loaded: Iterable<LoadedExtension>,
): InstalledExtension[] {
  const found = new Map<string, InstalledExtension>();
  for (const r of records)
    if (
      r.manifest?.format === "vscode" &&
      r.status !== "disabled" &&
      r.status !== "invalid" &&
      r.status !== "needsPermission"
    )
      found.set(r.id, { id: r.id, path: r.root, hasCode: !!r.manifest.main });
  for (const l of loaded)
    if (l.manifest.format === "vscode")
      found.set(l.manifest.id, { id: l.manifest.id, path: l.root, hasCode: !!l.manifest.main });
  return [...found.values()];
}
