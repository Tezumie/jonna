// A tree row's context menu from an extension's `menus["view/item/context"]` (VS Code's): the
// items whose `when` holds with `view` (the tree view's id) and `viewItem` (the row's
// `contextValue`) set, grouped and ordered as VS Code does ("navigation" first, then the other
// groups by name, ungrouped last; `group@order` orders within one). Group "inline" items are the
// row's buttons instead. What a menu item runs with: `{ item }` (treeMenuInput). DOM-free and
// unit-tested; extensions/extensions/treeView.ts shows it.
import { matchesWhen } from "../context/index";
import type { TreeItem } from "./rpc";
import type { ContributedMenuItem } from "./thirdParty";

export interface TreeMenuEntry {
  command: string;
  title: string;
  icon?: string;
}

export interface TreeItemMenu {
  /** Buttons on the row (group "inline"), in order. */
  inline: TreeMenuEntry[];
  /** The context menu, one list per group (a separator between them). */
  groups: TreeMenuEntry[][];
}

/** At most this many inline buttons on a row (with the item's own `actions`). */
export const MAX_INLINE = 4;

function splitGroup(group: string | undefined): { name: string; order: number } {
  if (!group) return { name: "", order: 0 };
  const at = group.lastIndexOf("@");
  if (at < 0) return { name: group, order: 0 };
  const order = Number(group.slice(at + 1));
  return { name: group.slice(0, at), order: Number.isFinite(order) ? order : 0 };
}

/** "navigation" first, named groups by name, ungrouped ("") last. */
function compareGroups(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "navigation") return -1;
  if (b === "navigation") return 1;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : 1;
}

/** A string from the extension, or "" (its rows aren't checked field by field). */
const textOf = (v: unknown, max = 200): string => (typeof v === "string" ? v.slice(0, max) : "");

export function treeItemMenu(
  menus: readonly ContributedMenuItem[],
  viewId: string,
  item: Pick<TreeItem, "contextValue">,
  context: (key: string) => unknown,
  titleOf: (command: string) => string,
): TreeItemMenu {
  const contextValue = textOf(item.contextValue);
  const lookup = (key: string) =>
    key === "view" ? viewId : key === "viewItem" ? contextValue : context(key);
  const shown = menus.filter((m) => {
    if (m.location !== "view/item/context") return false;
    try {
      return matchesWhen(m.when, lookup);
    } catch {
      // A badly written `when` hides its item instead of breaking the menu.
      return false;
    }
  });
  const entry = (m: ContributedMenuItem): TreeMenuEntry => ({
    command: m.command,
    title: m.title ?? titleOf(m.command),
    ...(m.icon && { icon: m.icon }),
  });
  const sorted = shown
    .map((m, index) => ({ m, index, ...splitGroup(m.group) }))
    .sort((a, b) => compareGroups(a.name, b.name) || a.order - b.order || a.index - b.index);
  const inline = sorted.filter((x) => x.name === "inline").map((x) => entry(x.m));
  const groups: TreeMenuEntry[][] = [];
  let last: string | null = null;
  for (const x of sorted) {
    if (x.name === "inline") continue;
    if (x.name !== last || !groups.length) groups.push([]);
    last = x.name;
    groups[groups.length - 1]?.push(entry(x.m));
  }
  return { inline: inline.slice(0, MAX_INLINE), groups };
}

/** The input a tree row's menu item (or inline button) runs its command with. */
export function treeMenuInput(viewId: string, item: TreeItem): { item: Record<string, string> } {
  const contextValue = textOf(item.contextValue);
  const description = textOf(item.description, 500);
  return {
    item: {
      id: textOf(item.id, 500),
      label: textOf(item.label, 500),
      view: viewId,
      ...(contextValue && { contextValue }),
      ...(description && { description }),
    },
  };
}
