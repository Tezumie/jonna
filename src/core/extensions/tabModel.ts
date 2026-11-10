// The editor tabs as extensions see them (VS Code's window.tabGroups): the dock's editor groups
// (not the bottom and right panels), each tab's kind and files, label and state, sent to an
// extension's worker as one snapshot whenever something changes ("tabs.didChange"). The shim
// (vscode/tabGroups.ts) turns snapshots into VS Code's Tab / TabGroup objects and change events.
// DOM-free, unit-tested.
import { allGroups, type DockNode, type Json, type TabRef } from "../dock/index";

/** What a tab shows: VS Code's TabInput kinds. */
export type TabKind =
  | "text"
  | "textDiff"
  | "custom"
  | "webview"
  | "notebook"
  | "terminal"
  | "other";

export interface TabWire {
  id: string;
  label: string;
  kind: TabKind;
  /** A path or a URI ("scheme:…"): the file of text, custom and notebook tabs. */
  uri?: string;
  /** A diff's sides. */
  original?: string;
  modified?: string;
  /** A custom editor's or a webview panel's type (VS Code's viewType). */
  viewType?: string;
  isActive: boolean;
  isDirty: boolean;
  isPreview: boolean;
  isPinned: boolean;
}

export interface TabGroupWire {
  id: string;
  /** 1-based, in the order the groups are laid out (VS Code's ViewColumn). */
  viewColumn: number;
  isActive: boolean;
  tabs: TabWire[];
}

export interface TabsSnapshot {
  groups: TabGroupWire[];
}

export interface TabInfo {
  title(tab: TabRef): string;
  isDirty(tab: TabRef): boolean;
  /** A run-time webview panel's VS Code viewType (`extpanel:` tabs), if known. */
  panelViewType?(tab: TabRef): string | undefined;
}

const field = (state: Json, key: string): string | undefined => {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return undefined;
  const v = state[key];
  return typeof v === "string" && v ? v : undefined;
};

/** A tab's kind and files from its view type and state. */
export function tabInput(
  tab: TabRef,
  info: Pick<TabInfo, "panelViewType"> = {},
): Pick<TabWire, "kind" | "uri" | "original" | "modified" | "viewType"> {
  const state = tab.viewState;
  const path = field(state, "path");
  switch (tab.viewType) {
    case "editor":
      return path ? { kind: "text", uri: path } : { kind: "other" };
    case "diff": {
      if (!path) return { kind: "other" };
      // The left side: another file, a content provider's URI, or the file's git / saved /
      // history version (VS Code's git diffs show a `git:` URI on the left).
      const original =
        field(state, "against") ??
        field(state, "base") ??
        (state && typeof state === "object" && !Array.isArray(state) && state.saved === true
          ? `saved:${path}`
          : `git:${path}`);
      return { kind: "textDiff", original, modified: field(state, "head") ?? path };
    }
    case "notebook":
      return path ? { kind: "notebook", uri: path } : { kind: "other" };
    case "terminal":
      return { kind: "terminal" };
    default:
      if (tab.viewType.startsWith("extviewer:"))
        return path
          ? { kind: "custom", uri: path, viewType: tab.viewType.slice("extviewer:".length) }
          : { kind: "other" };
      if (tab.viewType.startsWith("extpanel:"))
        return { kind: "webview", viewType: info.panelViewType?.(tab) ?? "" };
      return { kind: "other" };
  }
}

/**
 * The snapshot of the editor groups: every group but `panelGroupIds` (the bottom and right
 * regions), in layout order; `activeGroupId` is the editor group in use (the focused one, or the
 * one used last when the focus is in a panel).
 */
export function tabsSnapshot(
  root: DockNode,
  activeGroupId: string | null,
  panelGroupIds: ReadonlySet<string>,
  info: TabInfo,
): TabsSnapshot {
  const groups = allGroups(root).filter((g) => !panelGroupIds.has(g.id));
  const active = groups.some((g) => g.id === activeGroupId)
    ? activeGroupId
    : (groups[0]?.id ?? null);
  return {
    groups: groups.map((group, i) => ({
      id: group.id,
      viewColumn: i + 1,
      isActive: group.id === active,
      tabs: group.tabs.map((tab) => ({
        id: tab.id,
        label: info.title(tab),
        ...tabInput(tab, info),
        isActive: group.activeTabId === tab.id,
        isDirty: info.isDirty(tab),
        isPreview: tab.preview === true,
        isPinned: tab.pinned === true,
      })),
    })),
  };
}

/** What changed between two snapshots, by id (VS Code's TabChangeEvent / TabGroupChangeEvent). */
export interface SnapshotDiff {
  groups: { opened: string[]; closed: string[]; changed: string[] };
  tabs: { opened: string[]; closed: string[]; changed: string[] };
}

export function diffSnapshots(before: TabsSnapshot, after: TabsSnapshot): SnapshotDiff {
  const groupKey = (g: TabGroupWire) =>
    JSON.stringify([g.viewColumn, g.isActive, g.tabs.find((t) => t.isActive)?.id ?? null]);
  const tabEntries = (s: TabsSnapshot) =>
    new Map(s.groups.flatMap((g) => g.tabs.map((t) => [t.id, JSON.stringify([g.id, t])] as const)));
  const beforeGroups = new Map(before.groups.map((g) => [g.id, groupKey(g)]));
  const afterGroups = new Map(after.groups.map((g) => [g.id, groupKey(g)]));
  const beforeTabs = tabEntries(before);
  const afterTabs = tabEntries(after);
  const compare = (a: Map<string, string>, b: Map<string, string>) => ({
    opened: [...b.keys()].filter((id) => !a.has(id)),
    closed: [...a.keys()].filter((id) => !b.has(id)),
    changed: [...b.entries()]
      .filter(([id, key]) => a.has(id) && a.get(id) !== key)
      .map(([id]) => id),
  });
  return { groups: compare(beforeGroups, afterGroups), tabs: compare(beforeTabs, afterTabs) };
}

/** A snapshot from the host, checked (null: not one). */
export function readSnapshot(raw: unknown): TabsSnapshot | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as TabsSnapshot).groups)) return null;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const kinds: readonly TabKind[] = [
    "text",
    "textDiff",
    "custom",
    "webview",
    "notebook",
    "terminal",
    "other",
  ];
  return {
    groups: (raw as { groups: unknown[] }).groups.flatMap((g, i) => {
      if (!g || typeof g !== "object") return [];
      const group = g as Record<string, unknown>;
      const id = str(group.id);
      if (!id) return [];
      const tabs = Array.isArray(group.tabs) ? group.tabs : [];
      return [
        {
          id,
          viewColumn: typeof group.viewColumn === "number" ? group.viewColumn : i + 1,
          isActive: group.isActive === true,
          tabs: tabs.flatMap((t) => {
            if (!t || typeof t !== "object") return [];
            const tab = t as Record<string, unknown>;
            const tabId = str(tab.id);
            if (!tabId) return [];
            const kind = kinds.includes(tab.kind as TabKind) ? (tab.kind as TabKind) : "other";
            const uri = str(tab.uri);
            const original = str(tab.original);
            const modified = str(tab.modified);
            const viewType = str(tab.viewType);
            return [
              {
                id: tabId,
                label: str(tab.label) ?? "",
                kind,
                ...(uri !== undefined && { uri }),
                ...(original !== undefined && { original }),
                ...(modified !== undefined && { modified }),
                ...(viewType !== undefined && { viewType }),
                isActive: tab.isActive === true,
                isDirty: tab.isDirty === true,
                isPreview: tab.isPreview === true,
                isPinned: tab.isPinned === true,
              },
            ];
          }),
        },
      ];
    }),
  };
}
