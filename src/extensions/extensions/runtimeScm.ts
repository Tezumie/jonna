// An extension's source controls (D233, rpcScmDebug.ts on the worker side; VS Code's
// `scm.createSourceControl`). Each is checked here (paths in the folder or the extension's own
// file system, its own commands, limits), kept in the registry the Source control view's badge
// and quick diff read (extensionRegistries.ts), and shown as a section of that view
// (scmSection.ts). Needs no permission to show; its resources are paths the user opens.
import type { Caller } from "../../core/dispatcher/types";
import type { ScmWire } from "../../core/extensions/rpcScmDebug";
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { type Disposable, DisposableStore } from "../../core/lifecycle/index";
import { signal } from "../../core/reactive/index";
import {
  EMPTY_SCM_STATE,
  type ScmProviderEntry,
  type ScmState,
} from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import { ScmSection } from "./scmSection";
import { checkScmState } from "./workbenchChecks";
import type { ExtensionWorker } from "./workerHost";

const MAX_SOURCE_CONTROLS = 5;

export interface ScmHostDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  caller: Caller;
  workspacePath(path: unknown): string;
  worker(): Promise<ExtensionWorker>;
  warn(message: string): void;
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

interface Control {
  entry: ScmProviderEntry;
  off: Disposable;
  quickDiff: boolean;
}

export class ExtensionScmHost implements Disposable {
  private readonly controls = new Map<string, Control>();
  private seq = 0;

  constructor(private readonly deps: ScmHostDeps) {}

  private get owner(): string {
    return this.deps.manifest.id;
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "scm.update":
        return Promise.resolve(this.update(p as Partial<ScmWire>));
      case "scm.dispose":
        this.remove(String(p.id));
        return Promise.resolve(undefined);
      default:
        return UNHANDLED;
    }
  }

  private ownSchemes(): string[] {
    return this.deps.services.extensionFeatures.fileSystems.of(this.owner).map((f) => f.scheme);
  }

  private update(wire: Partial<ScmWire>): void {
    const id = String(wire.id ?? "");
    if (!/^scm\d{1,9}$/.test(id)) throw new Error("Bad source control id.");
    const commands = this.deps.manifest.contributes.commands;
    const state = checkScmState(wire, {
      path: (path) => this.deps.workspacePath(path),
      ownSchemes: this.ownSchemes(),
      ownCommand: (command) => commands.some((c) => c.id === command),
    });
    const known = this.controls.get(id);
    if (known) {
      known.entry.state.value = state;
      if (wire.quickDiff !== known.quickDiff || known.quickDiff) {
        known.quickDiff = wire.quickDiff === true;
        this.deps.services.quickDiff.changed();
      }
      return;
    }
    if (this.controls.size >= MAX_SOURCE_CONTROLS)
      throw new Error(`An extension can have at most ${MAX_SOURCE_CONTROLS} source controls.`);
    this.add(id, wire, state);
  }

  private add(id: string, wire: Partial<ScmWire>, state: ScmState): void {
    const { services, manifest } = this.deps;
    const store = new DisposableStore();
    let rootPath: string | null = null;
    if (typeof wire.rootPath === "string")
      try {
        rootPath = this.deps.workspacePath(wire.rootPath);
      } catch (err) {
        this.deps.warn(
          `Source control ${String(wire.label)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    const key = `${this.owner}/${id}`;
    const control: Control = {
      quickDiff: wire.quickDiff === true,
      off: store,
      entry: {
        owner: this.owner,
        key,
        label: str(wire.label, 60) || manifest.displayName,
        rootPath,
        state: signal<ScmState>(state ?? EMPTY_SCM_STATE),
        setInput: (value) => {
          control.entry.state.value = {
            ...control.entry.state.peek(),
            input: { ...control.entry.state.peek().input, value },
          };
          void this.deps
            .worker()
            .then((w) => w.call("provider", `${id}.input`, { value }))
            .catch(() => {});
        },
        accept: async () => {
          const state = control.entry.state.peek();
          if (!state.accept) throw new Error(`${control.entry.label} has no accept command.`);
          // The worker's inputBox.value is the box's text before its command runs.
          await (await this.deps.worker()).call("provider", `${id}.input`, {
            value: state.input.value,
          });
          await services.dispatcher.execute(
            state.accept.id,
            state.accept.input ?? { value: state.input.value },
            this.deps.caller,
          );
        },
        open: async (resource) => {
          if (resource.command)
            await services.dispatcher.execute(
              resource.command.id,
              resource.command.input ?? { path: resource.path },
              this.deps.caller,
            );
          else
            await services.dispatcher.execute(
              "editor.openFile",
              { path: resource.path },
              this.deps.caller,
            );
        },
        original: async (path) => {
          if (!control.quickDiff) return null;
          const text = await (await this.deps.worker()).call<unknown>(
            "provider",
            `${id}.original`,
            {
              path,
            },
          );
          return typeof text === "string" ? text : null;
        },
      },
    };
    store.add(services.extensionFeatures.sourceControls.add(control.entry));
    // A section of the Source control view, below git's changes.
    store.add(
      services.views.register({
        id: `scm.ext.${this.owner}.${++this.seq}`,
        title: control.entry.label,
        icon: "git-branch",
        sectionOf: "scm.view",
        sectionOnly: true,
        sectionOrder: 50,
        sectionDefault: { collapsed: false },
        create: (host) =>
          new ScmSection(host, control.entry, (command, input) => {
            void services.dispatcher
              .execute(command, input, { kind: "user" })
              .catch((err: unknown) =>
                services.notifications.show(
                  "error",
                  err instanceof Error ? err.message : String(err),
                ),
              );
          }),
      }),
    );
    this.controls.set(id, control);
    if (control.quickDiff) services.quickDiff.changed();
  }

  private remove(id: string): void {
    const control = this.controls.get(id);
    if (!control) return;
    this.controls.delete(id);
    control.off.dispose();
    if (control.quickDiff) this.deps.services.quickDiff.changed();
  }

  dispose(): void {
    for (const id of [...this.controls.keys()]) this.remove(id);
  }
}
