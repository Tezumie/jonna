// The code action list (lightbulb, Ctrl+., "Quick fix…" in hovers, refactor / source actions)
// shown as the IDE's own menu (D129). Monaco's action widget renders into a context view with an
// invisible full-window block behind it; in the IDE it could show up empty and that block then
// swallowed every click until Escape ("the UI froze"). Replacing the service keeps one menu look
// and focus behaviour everywhere, and nothing is left on screen when it closes.
import type { Disposable } from "../../../core/lifecycle/index";
import type { EngineHost, EngineMenuItem } from "../engine";

/** What Monaco passes for each row (platform/actionWidget/browser/actionList.js). */
interface ActionListItem {
  kind: "action" | "header" | "separator";
  item?: unknown;
  label?: string;
  disabled?: boolean;
  keybinding?: { getLabel(): string | null } | undefined;
}

interface ActionListDelegate {
  onSelect(item: unknown, preview?: boolean): void;
  onHide(didCancel?: boolean): void;
}

type Anchor = { x: number; y: number; height?: number } | HTMLElement;

/** Rows → menu items: a separator between groups (the "Quick fix" / "Extract" headers). */
export function actionMenuItems(
  items: readonly ActionListItem[],
  select: (item: unknown) => void,
): EngineMenuItem[] {
  const out: EngineMenuItem[] = [];
  let groupStart = false;
  for (const row of items) {
    if (row.kind !== "action") {
      groupStart = out.length > 0;
      continue;
    }
    const keybinding = row.keybinding?.getLabel() ?? undefined;
    out.push({
      label: row.label ?? "",
      ...(keybinding && { keybinding }),
      ...(row.disabled && { disabled: true }),
      ...(groupStart && { separatorBefore: true }),
      run: () => select(row.item),
    });
    groupStart = false;
  }
  return out;
}

/** Implements Monaco's IActionWidgetService (only what the editor contributions call). */
export class MenuActionWidgetService {
  declare readonly _serviceBrand: undefined;
  private open: { menu: Disposable; delegate: ActionListDelegate; selected: boolean } | null = null;

  constructor(private readonly host: Pick<EngineHost, "showMenu">) {}

  get isVisible(): boolean {
    return this.open !== null;
  }

  show(
    _user: string,
    _supportsPreview: boolean,
    items: readonly ActionListItem[],
    delegate: ActionListDelegate,
    anchor: Anchor,
  ): void {
    this.hide(true);
    const entry = { menu: { dispose() {} } as Disposable, delegate, selected: false };
    const menuItems = actionMenuItems(items, (item) => {
      entry.selected = true;
      delegate.onSelect(item, false);
    });
    if (!menuItems.length) return;
    this.open = entry;
    entry.menu = this.host.showMenu(anchorPoint(anchor), menuItems, () => {
      if (this.open === entry) this.open = null;
      // The menu closes before it runs the picked item: wait for that, then report a dismissal
      // only if nothing was picked (a pick already told the controller).
      queueMicrotask(() => {
        if (!entry.selected) delegate.onHide(true);
      });
    });
  }

  hide(didCancel?: boolean): void {
    const entry = this.open;
    if (!entry) return;
    this.open = null;
    if (didCancel === false) entry.selected = true;
    entry.menu.dispose();
  }

  acceptSelected(): void {}
  focusPrevious(): void {}
  focusNext(): void {}
  collapseSection(): void {}
  expandSection(): void {}
  toggleSection(): boolean {
    return false;
  }
  clearFilter(): boolean {
    return false;
  }
}

function anchorPoint(anchor: Anchor): { x: number; y: number } {
  if ("getBoundingClientRect" in anchor) {
    const r = anchor.getBoundingClientRect();
    return { x: r.left, y: r.bottom };
  }
  return { x: anchor.x, y: anchor.y + (anchor.height ?? 0) };
}
