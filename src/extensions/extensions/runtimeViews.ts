// What VS Code's TreeView and WebviewView know about their view, from the host (beside
// runtime.ts): whether it shows (any of its instances on screen: a side bar view, a section, or a
// dock tab in front; `view.watch` answers now and "provider" calls on `view.<id>.visible` follow),
// and its badge (`tree.update`).
import type { ThirdPartyManifest } from "../../core/extensions/thirdParty";
import { type Disposable, toDisposable } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import type { ExtensionWorker } from "./workerHost";

export interface ViewStatesDeps {
  manifest: ThirdPartyManifest;
  services: WorkbenchServices;
  running(): ExtensionWorker | null;
}

export class ExtensionViewStates implements Disposable {
  /** Instances of each view on screen now. */
  private readonly shown = new Map<string, Set<HTMLElement>>();
  /** Views whose visibility the worker follows. */
  private readonly watched = new Set<string>();
  private readonly badges = new Set<string>();

  constructor(private readonly deps: ViewStatesDeps) {}

  visible(viewId: string): boolean {
    return (this.shown.get(viewId)?.size ?? 0) > 0;
  }

  /** Follows one instance of a view (its element) while it exists. */
  track(viewId: string, element: HTMLElement): Disposable {
    const set = (on: boolean) => {
      const before = this.visible(viewId);
      let list = this.shown.get(viewId);
      if (!list) {
        list = new Set();
        this.shown.set(viewId, list);
      }
      if (on) list.add(element);
      else list.delete(element);
      const now = this.visible(viewId);
      if (now !== before && this.watched.has(viewId))
        this.deps.running()?.notify("provider", `view.${viewId}.visible`, { visible: now });
    };
    // On screen: laid out and in the viewport (a hidden tab or a folded section isn't).
    const observer = new IntersectionObserver((entries) => {
      const last = entries.at(-1);
      if (last) set(last.isIntersecting);
    });
    observer.observe(element);
    return toDisposable(() => {
      observer.disconnect();
      set(false);
    });
  }

  private ownView(viewId: unknown): string {
    const view = this.deps.manifest.contributes.views.find((v) => v.id === viewId);
    if (!view) throw new Error(`${String(viewId)} isn't one of the extension's views.`);
    return view.id;
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "view.watch": {
        const viewId = this.ownView(p.viewId);
        if (p.watch === false) this.watched.delete(viewId);
        else this.watched.add(viewId);
        return Promise.resolve(this.visible(viewId));
      }
      case "tree.update": {
        // VS Code's TreeView.badge: a number on the view's activity bar icon.
        const viewId = this.ownView(p.viewId);
        const badge = (p.badge ?? null) as { value?: unknown; tooltip?: unknown } | null;
        const count = typeof badge?.value === "number" ? Math.max(0, Math.floor(badge.value)) : 0;
        const tooltip = typeof badge?.tooltip === "string" ? badge.tooltip.slice(0, 200) : "";
        this.deps.services.views.setBadge(viewId, count, tooltip);
        if (count) this.badges.add(viewId);
        else this.badges.delete(viewId);
        return Promise.resolve(undefined);
      }
      default:
        return UNHANDLED;
    }
  }

  /** The worker went away: nothing follows, its badges go. */
  workerGone(): void {
    this.watched.clear();
    for (const viewId of this.badges) this.deps.services.views.setBadge(viewId, 0);
    this.badges.clear();
  }

  dispose(): void {
    this.workerGone();
  }
}
