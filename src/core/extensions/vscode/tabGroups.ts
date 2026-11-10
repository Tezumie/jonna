// The `vscode` shim's window.tabGroups: the IDE's editor groups and tabs (snapshots from the host,
// core/extensions/tabModel.ts) as VS Code's TabGroup and Tab objects that keep their identity
// while open, with onDidChangeTabGroups / onDidChangeTabs and close(). It listens once the
// extension first looks at tabGroups. DOM-free and unit-tested.

import type { WorkerApi } from "../rpc";
import {
  diffSnapshots,
  readSnapshot,
  type TabGroupWire,
  type TabsSnapshot,
  type TabWire,
} from "../tabModel";
import { uriOf } from "./convert";
import {
  TabInputCustom,
  TabInputNotebook,
  TabInputTerminal,
  TabInputText,
  TabInputTextDiff,
  TabInputWebview,
} from "./extraTypes";
import { EventEmitter } from "./types";

/** The event type the host sends snapshots on. */
export const TABS_EVENT = "tabs.didChange";

export interface ShimTab {
  readonly label: string;
  readonly group: ShimTabGroup;
  readonly input: unknown;
  readonly isActive: boolean;
  readonly isDirty: boolean;
  readonly isPinned: boolean;
  readonly isPreview: boolean;
}

export interface ShimTabGroup {
  readonly isActive: boolean;
  readonly viewColumn: number;
  readonly activeTab: ShimTab | undefined;
  readonly tabs: readonly ShimTab[];
}

/** VS Code's TabInput for a tab of the snapshot (notebooks: Jupyter's type for .ipynb). */
export function inputOf(tab: TabWire): unknown {
  switch (tab.kind) {
    case "text":
      return tab.uri ? new TabInputText(uriOf(tab.uri)) : undefined;
    case "textDiff":
      return tab.original && tab.modified
        ? new TabInputTextDiff(uriOf(tab.original), uriOf(tab.modified))
        : undefined;
    case "custom":
      return tab.uri ? new TabInputCustom(uriOf(tab.uri), tab.viewType ?? "") : undefined;
    case "notebook":
      return tab.uri
        ? new TabInputNotebook(uriOf(tab.uri), /\.ipynb$/i.test(tab.uri) ? "jupyter-notebook" : "")
        : undefined;
    case "webview":
      // VS Code's webview panels' tabs have the "mainThreadWebview-" prefix.
      return new TabInputWebview(`mainThreadWebview-${tab.viewType ?? ""}`);
    case "terminal":
      return new TabInputTerminal();
    default:
      return undefined;
  }
}

const inputKey = (tab: TabWire) =>
  JSON.stringify([tab.kind, tab.uri, tab.original, tab.modified, tab.viewType]);

export function createTabGroups(ide: WorkerApi) {
  const onDidChangeTabGroups = new EventEmitter<{
    opened: readonly ShimTabGroup[];
    closed: readonly ShimTabGroup[];
    changed: readonly ShimTabGroup[];
  }>();
  const onDidChangeTabs = new EventEmitter<{
    opened: readonly ShimTab[];
    closed: readonly ShimTab[];
    changed: readonly ShimTab[];
  }>();
  let snapshot: TabsSnapshot = { groups: [] };
  const groups = new Map<string, ShimTabGroup & { wire: TabGroupWire; list: ShimTab[] }>();
  const tabs = new Map<
    string,
    ShimTab & { wire: TabWire; groupId: string; key: string; input: unknown }
  >();
  const ids = new WeakMap<object, string>();
  let listening = false;

  const groupObject = (wire: TabGroupWire) => {
    const known = groups.get(wire.id);
    if (known) {
      known.wire = wire;
      return known;
    }
    const group = {
      wire,
      list: [] as ShimTab[],
      get isActive() {
        return group.wire.isActive;
      },
      get viewColumn() {
        return group.wire.viewColumn;
      },
      get activeTab() {
        return group.list.find((t) => t.isActive);
      },
      get tabs() {
        return [...group.list];
      },
    };
    groups.set(wire.id, group);
    ids.set(group, wire.id);
    return group;
  };

  const apply = (next: TabsSnapshot) => {
    const diff = diffSnapshots(snapshot, next);
    const closedGroups = diff.groups.closed.flatMap((id) => groups.get(id) ?? []);
    const closedTabs = diff.tabs.closed.flatMap((id) => tabs.get(id) ?? []);
    for (const id of diff.groups.closed) groups.delete(id);
    for (const id of diff.tabs.closed) tabs.delete(id);
    for (const g of next.groups) {
      const group = groupObject(g);
      group.list = g.tabs.map((wire) => {
        const key = inputKey(wire);
        let tab = tabs.get(wire.id);
        if (!tab) {
          const created = {
            wire,
            groupId: g.id,
            key,
            input: inputOf(wire),
            get label() {
              return created.wire.label;
            },
            get group() {
              return groups.get(created.groupId) ?? group;
            },
            get isActive() {
              return created.wire.isActive;
            },
            get isDirty() {
              return created.wire.isDirty;
            },
            get isPinned() {
              return created.wire.isPinned;
            },
            get isPreview() {
              return created.wire.isPreview;
            },
          };
          tab = created;
          tabs.set(wire.id, tab);
          ids.set(tab, wire.id);
        } else {
          // The same object while open; its input is new only when what it shows changed.
          if (tab.key !== key) tab.input = inputOf(wire);
          tab.wire = wire;
          tab.key = key;
          tab.groupId = g.id;
        }
        return tab;
      });
    }
    snapshot = next;
    const pick = <T>(list: string[], map: Map<string, T>) =>
      list.flatMap((id) => map.get(id) ?? []);
    const groupEvent = {
      opened: pick(diff.groups.opened, groups),
      closed: closedGroups,
      changed: pick(diff.groups.changed, groups),
    };
    const tabEvent = {
      opened: pick(diff.tabs.opened, tabs),
      closed: closedTabs,
      changed: pick(diff.tabs.changed, tabs),
    };
    if (groupEvent.opened.length || groupEvent.closed.length || groupEvent.changed.length)
      onDidChangeTabGroups.fire(groupEvent);
    if (tabEvent.opened.length || tabEvent.closed.length || tabEvent.changed.length)
      onDidChangeTabs.fire(tabEvent);
  };

  /** Starts following the host's tabs (once). */
  const listen = () => {
    if (listening) return;
    listening = true;
    try {
      ide.events.on(TABS_EVENT, (raw) => {
        const next = readSnapshot(raw);
        if (next) apply(next);
      });
    } catch {
      // An IDE without the event: no tabs (as before).
    }
  };

  const ordered = () => snapshot.groups.flatMap((g) => groups.get(g.id) ?? []);
  const tabGroups = {
    get all(): readonly ShimTabGroup[] {
      listen();
      return ordered();
    },
    get activeTabGroup(): ShimTabGroup {
      listen();
      const list = ordered();
      return (
        list.find((g) => g.isActive) ??
        list[0] ?? { isActive: true, viewColumn: 1, activeTab: undefined, tabs: [] }
      );
    },
    onDidChangeTabGroups: (...args: Parameters<typeof onDidChangeTabGroups.event>) => {
      listen();
      return onDidChangeTabGroups.event(...args);
    },
    onDidChangeTabs: (...args: Parameters<typeof onDidChangeTabs.event>) => {
      listen();
      return onDidChangeTabs.event(...args);
    },
    /** Closes tabs, or every tab of groups; true when they all closed (one may ask to save). */
    close: async (target: unknown, preserveFocus?: boolean): Promise<boolean> => {
      const list = Array.isArray(target) ? target : [target];
      const tabIds = list.flatMap((t) => {
        const id = t && typeof t === "object" ? ids.get(t) : undefined;
        if (!id) return [];
        const group = groups.get(id);
        return group ? group.wire.tabs.map((x) => x.id) : [id];
      });
      if (!tabIds.length) return false;
      return ide.ui.closeTabs(tabIds, preserveFocus === true).catch(() => false);
    },
  };
  return { tabGroups, apply };
}
