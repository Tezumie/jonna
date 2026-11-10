// What an extension plugs into the workbench's own features (D233): terminals and task
// providers (runtimeTerminals.ts), source controls (runtimeScm.ts), debug adapters
// (runtimeDebugAdapters.ts), authentication and secrets (runtimeAuth.ts) and file systems
// (runtimeFileSystems.ts); also test controllers (runtimeTesting.ts) and webview panels opened at
// run time (runtimeWebviewPanels.ts). runtime.ts holds one of these per extension and passes it
// the requests the others don't handle.
import type { Caller } from "../../core/dispatcher/types";
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import type { TaskProviderEntry } from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import { ExtensionAuthHost } from "./runtimeAuth";
import { ExtensionDebugHost } from "./runtimeDebugAdapters";
import { ExtensionFileSystemsHost } from "./runtimeFileSystems";
import { ExtensionScmHost } from "./runtimeScm";
import { ExtensionTerminalsHost } from "./runtimeTerminals";
import { ExtensionTestingHost } from "./runtimeTesting";
import { ExtensionWebviewPanels } from "./runtimeWebviewPanels";
import type { ExtensionWorker } from "./workerHost";

/** How long a task list waits for a just-started extension to register its provider. */
const PROVIDER_WAIT_MS = 3000;

export interface WorkbenchHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  caller: Caller;
  need(permission: string, what: string): void;
  granted(permission: string): boolean;
  workspacePath(path: unknown): string;
  worker(): Promise<ExtensionWorker>;
  running(): ExtensionWorker | null;
  warn(message: string): void;
  /** The extension's folder and its webview origin (run-time webview panels). */
  root: string;
  origin(): Promise<string>;
  /** A file of the extension as an image URL (a panel's own icon, D263). */
  image(path: string): Promise<string | null>;
  /** Folders its webview pages may read files from (declared localResourceRoots). */
  allowRoots?(roots: readonly string[]): void;
}

export class ExtensionWorkbenchHost implements Disposable {
  private readonly store = new DisposableStore();
  private readonly terminals: ExtensionTerminalsHost;
  private readonly scm: ExtensionScmHost;
  private readonly debug: ExtensionDebugHost;
  private readonly auth: ExtensionAuthHost;
  private readonly fileSystems: ExtensionFileSystemsHost;
  private readonly testing: ExtensionTestingHost;
  private readonly panels: ExtensionWebviewPanels;

  constructor(private readonly deps: WorkbenchHostDeps) {
    this.terminals = this.store.add(new ExtensionTerminalsHost(deps));
    this.scm = this.store.add(new ExtensionScmHost(deps));
    this.debug = this.store.add(new ExtensionDebugHost(deps));
    this.auth = this.store.add(new ExtensionAuthHost(deps));
    this.fileSystems = this.store.add(new ExtensionFileSystemsHost(deps));
    this.testing = this.store.add(new ExtensionTestingHost(deps));
    this.panels = this.store.add(new ExtensionWebviewPanels(deps));
  }

  /** The manifest's debug types and task types, there before its code runs (it starts on use). */
  contribute(): void {
    this.debug.contribute();
    this.terminals.contributeProfiles();
    // Its webview panels of the last session come back (VS Code's serializers).
    this.panels.contribute();
    const { manifest, services } = this.deps;
    if (!manifest.main) return;
    const registry = services.extensionFeatures.tasks;
    for (const { type } of manifest.contributes.taskDefinitions) {
      const real = () =>
        registry.all
          .peek()
          .find((e) => e.type === type && e.owner === manifest.id && e !== placeholder);
      const placeholder: TaskProviderEntry = {
        owner: manifest.id,
        type,
        // Until its code has registered the provider: start it, wait a little, then ask it.
        provide: async () => {
          if (real()) return [];
          await this.deps.worker().catch(() => null);
          const deadline = Date.now() + PROVIDER_WAIT_MS;
          while (!real() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
          return (await real()?.provide()) ?? [];
        },
      };
      this.store.add(registry.add(placeholder));
    }
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    for (const host of [
      this.terminals,
      this.scm,
      this.debug,
      this.auth,
      this.fileSystems,
      this.testing,
      this.panels,
    ]) {
      const handled = host.handle(method, p);
      if (handled !== UNHANDLED) return handled;
    }
    return UNHANDLED;
  }

  /** The worker died: what it served ends. */
  workerGone(): void {
    this.terminals.workerGone();
    this.debug.workerGone();
    this.testing.workerGone();
    this.panels.workerGone();
  }

  dispose(): void {
    this.store.dispose();
  }
}
