// The host side of window.tabGroups (core/extensions/tabModel.ts, vscode/tabGroups.ts): a
// snapshot of the dock's editor groups sent to the worker on "tabs.didChange" when it subscribes
// and whenever tabs open, close, move, activate or change their title or dirty state (at most
// every 50 ms, and only when something differs); `tabs.close` closes tabs by id as the tab's ×
// does (a tab with unsaved changes asks first).
import { type TabsSnapshot, tabsSnapshot } from "../../core/extensions/tabModel";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";

const THROTTLE_MS = 50;

export class ExtensionTabsHost implements Disposable {
  private readonly store = new DisposableStore();

  constructor(private readonly services: WorkbenchServices) {}

  /** The editor groups now, as extensions see them. */
  snapshot(): TabsSnapshot {
    const { dock, extensionFeatures } = this.services;
    const root = dock.root.peek();
    const panels = new Set(
      [...dock.regionGroups("bottom"), ...dock.regionGroups("right")].map((g) => g.id),
    );
    // The focused group, or (focus in a panel) the group of the editor used last.
    const focused = dock.focusedGroupId.peek();
    const recent = dock.recentTab(dock.isEditorLike);
    const active =
      focused && !panels.has(focused)
        ? focused
        : recent
          ? (dock.findTab(recent.id)?.group.id ?? null)
          : null;
    return tabsSnapshot(root, active, panels, {
      title: (tab) => dock.title(tab),
      isDirty: (tab) => dock.isDirty(tab),
      panelViewType: (tab) =>
        extensionFeatures.webviewPanels.all.peek().find((p) => p.tabId() === tab.id)?.viewType,
    });
  }

  /** Sends `send` the snapshot now and after every change, until disposed. */
  subscribe(send: (snapshot: TabsSnapshot) => void): Disposable {
    const { dock } = this.services;
    const sub = new DisposableStore();
    let last = "";
    let timer = 0;
    const push = () => {
      timer = 0;
      const snapshot = this.snapshot();
      const text = JSON.stringify(snapshot);
      if (text === last) return;
      last = text;
      send(snapshot);
    };
    sub.add(
      effect(() => {
        dock.root.value;
        dock.focusedGroupId.value;
        dock.decorations.value;
        if (!timer) timer = window.setTimeout(push, last ? THROTTLE_MS : 0);
        return undefined;
      }),
    );
    sub.add(toDisposable(() => window.clearTimeout(timer)));
    this.store.add(sub);
    return toDisposable(() => this.store.delete(sub));
  }

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    if (method !== "tabs.close") return UNHANDLED;
    return this.close(p);
  }

  private async close(p: Record<string, unknown>): Promise<boolean> {
    const { dock } = this.services;
    const ids = Array.isArray(p.ids) ? p.ids.map(String).slice(0, 500) : [];
    // Editor tabs only: what the snapshots list.
    const known = new Set(this.snapshot().groups.flatMap((g) => g.tabs.map((t) => t.id)));
    let all = true;
    for (const id of ids) {
      if (!known.has(id) || !dock.findTab(id)) {
        all = false;
        continue;
      }
      if (!(await dock.closeTab(id))) all = false;
    }
    return all;
  }

  dispose(): void {
    this.store.dispose();
  }
}
