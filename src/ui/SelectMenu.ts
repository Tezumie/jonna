// Dropdowns (`<select>`) open the IDE's own menu instead of the system's list (D282): lined up
// under the field and at least as wide, the chosen option checked and in view, option groups as
// headings. Picking sets the value and fires `input` and `change` as the system list would, so
// pages keep listening the usual way. Arrow keys on a closed field still step through the values.
// D378: opened with the mouse, the menu leaves focus where it was until a key is pressed (moving
// it restyled a big page, All settings, twice per open).
// One listener per document: every dropdown, in every window, without changing the pages.
// A field marked `data-native-select` keeps the system list.

import { type Disposable, DisposableStore } from "../core/lifecycle/index";
import { type MenuItem, showMenu } from "./Menu";

/** A dropdown this takes over: a single-choice list shown as a field, enabled. */
function takesOver(el: EventTarget | null): el is HTMLSelectElement {
  return (
    el instanceof HTMLSelectElement &&
    !el.multiple &&
    el.size <= 1 &&
    !el.disabled &&
    !el.hasAttribute("data-native-select")
  );
}

/** The menu's items for a dropdown's options (a group's label heads its first option). */
export function selectMenuItems(
  select: HTMLSelectElement,
  choose: (index: number) => void,
): MenuItem[] {
  const items: MenuItem[] = [];
  let group: HTMLOptGroupElement | null = null;
  Array.from(select.options).forEach((option, index) => {
    if (option.hidden) return;
    const parent =
      option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
    const heading = parent && parent !== group ? parent.label : undefined;
    group = parent;
    items.push({
      label: option.label || option.text,
      checked: index === select.selectedIndex,
      disabled: option.disabled || parent?.disabled === true,
      ...(heading && { heading }),
      run: () => choose(index),
    });
  });
  return items;
}

function open(select: HTMLSelectElement, byMouse: boolean): void {
  const choose = (index: number) => {
    if (index === select.selectedIndex) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  };
  showMenu(select, selectMenuItems(select, choose), {
    label: select.getAttribute("aria-label") || select.title || "Options",
    minWidth: select.getBoundingClientRect().width,
    flush: true,
    // Long lists (themes, fonts) filter as you type, like the quick picks.
    search: select.options.length > 15,
    // Focus comes back to the field when the menu had it (the keyboard was used).
    returnFocus: select,
    deferFocus: byMouse,
  });
}

/** Takes over the dropdowns of `doc` (the main window, each auxiliary window). */
export function installSelectMenus(doc: Document): Disposable {
  const store = new DisposableStore();
  const press = (e: MouseEvent) => {
    if (e.button !== 0 || !takesOver(e.target)) return;
    // No system list. Focus stays where it was (D378): the menu takes it if a key is pressed.
    e.preventDefault();
    open(e.target, true);
  };
  const key = (e: KeyboardEvent) => {
    if (!takesOver(e.target)) return;
    // The keys that open the system list: Alt+↓/↑, F4, Space, Enter.
    const opens =
      ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.altKey) ||
      e.key === "F4" ||
      e.key === " " ||
      e.key === "Enter";
    if (!opens) return;
    e.preventDefault();
    open(e.target, false);
  };
  doc.addEventListener("mousedown", press, { capture: true });
  doc.addEventListener("keydown", key, { capture: true });
  store.add({
    dispose: () => {
      doc.removeEventListener("mousedown", press, { capture: true });
      doc.removeEventListener("keydown", key, { capture: true });
    },
  });
  return store;
}
