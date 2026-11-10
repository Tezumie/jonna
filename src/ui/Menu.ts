// Menus and context menus (DESIGN.md §12.5): a positioned list of actions with a 16px icon slot,
// optional check state, right-aligned keybinding, and submenus that open on hover (or →/Enter) to
// the side, like native menus. Closes on Escape, outside click, blur or focus moving elsewhere.
// Menu bars pass `onNavigate` so ←/→ on a top-level menu switch to the neighbouring menu.
import { h, on } from "../core/dom/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { type IconName, icon } from "./Icon";
import { logo } from "./Logo";
import { setTooltip } from "./Tooltip";

export interface MenuItem {
  label: string;
  /** Keybinding label shown on the right. */
  keybinding?: string;
  icon?: IconName;
  /** The app's logo in the icon slot (Help → Welcome, D185). */
  logo?: boolean;
  /** Its own element in the icon slot: an agent's face (the New chat ▾ menu, D236). */
  iconElement?: () => HTMLElement;
  /** Shows a check in the icon slot (radio/toggle items). */
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /** Runs on click/Enter (items with a submenu don't need it). */
  run?(): void;
  /** Opens to the side on hover. */
  submenu?: readonly MenuItem[];
  /** The submenu gets a search box (long lists: models, recent folders…). */
  searchable?: boolean;
  separatorBefore?: boolean;
  /** A small heading above this item, starting a group (the composer's Agent / Mode, D249). */
  heading?: string;
  /** A line shown on hover (a chat chapter's summary, D302). */
  tooltip?: string;
}

export type MenuAnchor = { x: number; y: number } | HTMLElement;

export interface MenuOptions {
  label?: string;
  /** ←/→ on the top-level menu (no submenu to enter/leave): the menu bar switches menus. */
  onNavigate?(direction: -1 | 1): void;
  /** Called once when the menu closes (any reason). */
  onClose?(): void;
  /** Focus the first item (keyboard opening); otherwise the menu waits for the pointer. */
  focusFirst?: boolean;
  /** A search box above the items (typing filters them). */
  search?: boolean;
  /** At least this wide (a dropdown's menu: as wide as its field, D282). */
  minWidth?: number;
  /** Below an anchor element: lined up with its left edge, without the usual 4 px gap. */
  flush?: boolean;
  /**
   * Leave focus where it is until a key is pressed (a dropdown opened with the mouse, D378):
   * moving focus out of a big page restyled all of it (100 ms and more on All settings), so the
   * menu takes focus only for the keyboard, and hovering doesn't move it.
   */
  deferFocus?: boolean;
  /** Where focus goes back to when the menu had it (a dropdown: its field). */
  returnFocus?: HTMLElement;
}

const OPEN_DELAY_MS = 120;
/**
 * The button whose press just closed its own menu: the click that follows mustn't open it
 * again, so a second click on a menu button closes the menu (D180).
 */
let pressedAnchor: { element: HTMLElement; until: number } | null = null;
const CLOSE_DELAY_MS = 250;

interface Panel {
  element: HTMLElement;
  search?: HTMLInputElement;
  buttons: HTMLButtonElement[];
  items: readonly MenuItem[];
  child?: { panel: Panel; index: number };
  parent?: Panel;
  /** This panel opened to the left of its parent: its own submenus keep going left (D195). */
  leftward?: boolean;
}

/** Opens a menu at a point or below an element. Returns a Disposable that closes it. */
/** Open menus (one at a time): opening another, or the window regaining focus, closes them. */
const openMenus = new Set<() => void>();
/** A menu that just opened moves focus into the document itself; that isn't "coming back". */
let openedAt = 0;
/** Documents menus can open in (the main window and auxiliary windows, D101). */
const documents = new Set<Document>();
/** Where the last press happened: point-anchored menus open in that window. */
let pointerDocument: Document | null = null;

/**
 * Makes menus work in `doc` and arms the safety net against a menu left on screen (e.g. focus
 * went to another window between opening and its handlers being armed): a press outside every
 * menu removes `.menu` elements no open menu owns, and coming back to the window closes menus.
 */
export function registerMenuDocument(doc: Document): Disposable {
  if (documents.has(doc)) return toDisposable(() => {});
  documents.add(doc);
  const win = doc.defaultView;
  const press = (e: Event) => {
    pointerDocument = doc;
    const target = e.target as Element | null;
    if (target?.closest?.(".menu")) return;
    if (openMenus.size === 0)
      for (const el of Array.from(doc.querySelectorAll(".menu"))) el.remove();
  };
  const refocus = () => {
    if (performance.now() - openedAt < 400) return;
    for (const close of Array.from(openMenus)) close();
    for (const d of documents)
      for (const el of Array.from(d.querySelectorAll(".menu"))) el.remove();
  };
  doc.addEventListener("pointerdown", press, { capture: true });
  doc.addEventListener("contextmenu", press, { capture: true });
  win?.addEventListener("focus", refocus);
  return toDisposable(() => {
    documents.delete(doc);
    if (pointerDocument === doc) pointerDocument = null;
    doc.removeEventListener("pointerdown", press, { capture: true });
    doc.removeEventListener("contextmenu", press, { capture: true });
    win?.removeEventListener("focus", refocus);
  });
}

const isElement = (anchor: MenuAnchor): anchor is HTMLElement =>
  typeof (anchor as HTMLElement).getBoundingClientRect === "function";

export function showMenu(
  anchor: MenuAnchor,
  items: readonly MenuItem[],
  labelOrOptions: string | MenuOptions = "Menu",
): Disposable {
  registerMenuDocument(document);
  if (
    isElement(anchor) &&
    pressedAnchor &&
    performance.now() < pressedAnchor.until &&
    (pressedAnchor.element === anchor || pressedAnchor.element.contains(anchor))
  ) {
    pressedAnchor = null;
    return toDisposable(() => {});
  }
  pressedAnchor = null;
  // Replacing an open menu (the menu bar's hover switch, ←/→): no fade, so it doesn't blink.
  const replacing = openMenus.size > 0;
  for (const close of Array.from(openMenus)) close();
  openedAt = performance.now();
  const doc =
    (isElement(anchor)
      ? anchor.ownerDocument
      : pointerDocument?.defaultView
        ? pointerDocument
        : null) ?? document;
  const win = doc.defaultView ?? window;
  const options: MenuOptions =
    typeof labelOrOptions === "string" ? { label: labelOrOptions } : labelOrOptions;
  const store = new DisposableStore();
  const active = doc.activeElement as HTMLElement | null;
  const returnFocus =
    options.returnFocus ?? (active && typeof active.focus === "function" ? active : null);
  /** Focus is (or was) in the menu: it goes back on close. Deferred menus take it on a key. */
  let tookFocus = options.deferFocus !== true;
  const panels: Panel[] = [];
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  store.add(
    toDisposable(() => {
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
      for (const p of panels) p.element.remove();
      options.onClose?.();
      if (tookFocus && returnFocus?.isConnected && !doc.querySelector(".menu")) returnFocus.focus();
    }),
  );
  const close = () => store.dispose();
  openMenus.add(close);
  store.add(toDisposable(() => openMenus.delete(close)));

  const closeChild = (panel: Panel) => {
    const child = panel.child;
    if (!child) return;
    closeChild(child.panel);
    child.panel.element.remove();
    panels.splice(panels.indexOf(child.panel), 1);
    panel.buttons[child.index]?.classList.remove("is-open");
    panel.buttons[child.index]?.setAttribute("aria-expanded", "false");
    panel.child = undefined;
  };

  const openChild = (panel: Panel, index: number, focus: boolean) => {
    const item = panel.items[index];
    const button = panel.buttons[index];
    if (!item?.submenu || !button || item.disabled) return;
    if (panel.child?.index === index) {
      if (focus) {
        const open = panel.child.panel;
        tookFocus = true;
        (open.buttons.find((_, i) => item.submenu?.[i]?.checked) ?? open.buttons[0])?.focus();
      }
      return;
    }
    closeChild(panel);
    const child = build(item.submenu, item.label, panel, item.searchable === true);
    panel.child = { panel: child, index };
    button.classList.add("is-open");
    button.setAttribute("aria-expanded", "true");
    // Beside the item, on the side its parent opened toward (a menu that went left keeps going
    // left while there's room, like the OS menus); flips when that side has no room.
    const b = button.getBoundingClientRect();
    const r = child.element.getBoundingClientRect();
    const right = b.right + 2;
    const left = b.left - r.width - 2;
    const fitsRight = right + r.width <= win.innerWidth - 4;
    const fitsLeft = left >= 4;
    const goLeft = panel.leftward ? fitsLeft || !fitsRight : !fitsRight;
    child.leftward = goLeft;
    place(child.element, goLeft ? left : right, b.top - 4, r, win);
    // The checked item (the model in use…) is scrolled into view and gets the focus (D180).
    const checked = child.buttons.find((_, i) => item.submenu?.[i]?.checked);
    checked?.scrollIntoView({ block: "center" });
    // Focus moving into a submenu is the menu's (D379: it goes back on close).
    if (child.search || focus) tookFocus = true;
    if (child.search) child.search.focus();
    else if (focus) (checked ?? child.buttons[0])?.focus();
  };

  const activate = (panel: Panel, index: number) => {
    const item = panel.items[index];
    if (!item || item.disabled) return;
    if (item.submenu) {
      openChild(panel, index, true);
      return;
    }
    close();
    item.run?.();
  };

  function build(
    list: readonly MenuItem[],
    label: string,
    parent?: Panel,
    searchable = false,
  ): Panel {
    const nodes: HTMLElement[] = [];
    const buttons = list.map((item) => {
      // A face stays a face when checked: the check goes on the right.
      const faceChecked = !!item.checked && !!item.iconElement;
      const slot =
        item.checked && !faceChecked
          ? icon("check")
          : item.iconElement
            ? item.iconElement()
            : item.logo
              ? logo(16, "icon menu-logo")
              : item.icon
                ? icon(item.icon)
                : h("span", { class: "menu-icon-placeholder" });
      const button = h(
        "button",
        {
          class: {
            "menu-item": true,
            "is-destructive": !!item.destructive,
            "has-submenu": !!item.submenu,
          },
          type: "button",
          role: item.checked === undefined ? "menuitem" : "menuitemradio",
          ...(item.checked !== undefined && { "aria-checked": String(item.checked) }),
          ...(item.submenu && { "aria-haspopup": "menu", "aria-expanded": "false" }),
          ...(item.disabled && { "aria-disabled": "true" }),
        },
        h("span", { class: "menu-icon" }, slot),
        h("span", { class: "menu-label" }, item.label),
        item.keybinding ? h("kbd", { class: "menu-keybinding" }, item.keybinding) : null,
        faceChecked ? h("span", { class: "menu-check" }, icon("check")) : null,
        item.submenu ? h("span", { class: "menu-chevron" }, icon("chevron-right")) : null,
      );
      if (item.tooltip) setTooltip(button, item.tooltip, undefined, { placement: "right" });
      if (item.separatorBefore && nodes.length > 0)
        nodes.push(h("div", { class: "menu-separator", role: "separator" }));
      if (item.heading)
        nodes.push(h("div", { class: "menu-heading", role: "presentation" }, item.heading));
      nodes.push(button);
      return button;
    });
    // Long menus scroll inside a capped height; searchable ones filter as you type.
    const search = searchable
      ? (h("input", {
          class: "input menu-search",
          type: "text",
          placeholder: "Search",
          "aria-label": `Search ${label}`,
          spellcheck: "false",
        }) as HTMLInputElement)
      : undefined;
    const scroller = h("div", { class: "menu-items" }, nodes);
    const element = h(
      "div",
      { class: { menu: true, "has-search": !!search }, role: "menu", "aria-label": label },
      search ?? null,
      scroller,
    );
    doc.body.appendChild(element);
    const panel: Panel = {
      element,
      buttons,
      items: list,
      ...(parent && { parent }),
      ...(search && { search }),
    };
    if (search) {
      const empty = h("div", { class: "menu-empty", hidden: true }, "No matches");
      scroller.append(empty);
      const filter = () => {
        const q = search.value.trim().toLowerCase();
        let shown = 0;
        buttons.forEach((b, i) => {
          const item = list[i];
          const hay = `${item?.label ?? ""} ${item?.keybinding ?? ""}`.toLowerCase();
          const hit = !q || q.split(/\s+/).every((w) => hay.includes(w));
          b.hidden = !hit;
          if (hit) shown++;
        });
        for (const sep of Array.from(scroller.querySelectorAll<HTMLElement>(".menu-separator")))
          sep.hidden = q !== "";
        empty.hidden = shown > 0;
      };
      store.add(on(search, "input", filter));
      store.add(
        on(search, "keydown", (e) => {
          if (e.key === "ArrowDown" || e.key === "Enter") {
            const first = buttons.find((b) => !b.hidden);
            if (e.key === "Enter" && first) activate(panel, buttons.indexOf(first));
            else first?.focus();
            e.preventDefault();
            e.stopPropagation();
          }
        }),
      );
    }
    panels.push(panel);
    buttons.forEach((button, i) => {
      store.add(on(button, "click", () => activate(panel, i)));
      store.add(
        on(button, "pointerenter", () => {
          // Hover shows by :hover; focus follows only once the menu has it (D378).
          if (tookFocus) button.focus({ preventScroll: true });
          clearTimeout(openTimer);
          clearTimeout(closeTimer);
          const item = list[i];
          if (item?.submenu) {
            openTimer = setTimeout(() => openChild(panel, i, false), OPEN_DELAY_MS);
          } else if (panel.child) {
            // Give the pointer time to travel diagonally into an open submenu.
            closeTimer = setTimeout(() => closeChild(panel), CLOSE_DELAY_MS);
          }
        }),
      );
    });
    // Entering a submenu cancels a pending close of it.
    store.add(
      on(element, "pointerenter", () => {
        if (parent?.child?.panel === panel) clearTimeout(closeTimer);
      }),
    );
    store.add(
      on(element, "keydown", (e) => {
        if (e.target === search && e.key !== "Escape") return;
        const visible = buttons.filter((b) => !b.hidden);
        const current = doc.activeElement as HTMLButtonElement;
        const index = buttons.indexOf(current);
        const at = visible.indexOf(current);
        const move = (to: number) => {
          // Above the first item of a searchable menu: back to the search box.
          if (search && to < 0) return search.focus();
          visible[(to + visible.length) % visible.length]?.focus();
        };
        if (e.key === "ArrowDown") move(at + 1);
        else if (e.key === "ArrowUp") move(at - 1);
        else if (e.key === "Home") move(0);
        else if (e.key === "End") move(visible.length - 1);
        else if (search && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Typing on an item goes to the search box.
          search.focus();
          return;
        } else if (
          !search &&
          e.key.length === 1 &&
          e.key !== " " &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey
        ) {
          // A letter: the next item starting with it, round the list (a native list's type-ahead).
          const letter = e.key.toLowerCase();
          const starts = (b: HTMLButtonElement) =>
            !list[buttons.indexOf(b)]?.disabled &&
            (list[buttons.indexOf(b)]?.label ?? "").toLowerCase().startsWith(letter);
          const after = [...visible.slice(at + 1), ...visible.slice(0, at + 1)];
          const next = after.find(starts);
          if (!next) return;
          next.focus();
        } else if (e.key === "Enter" || e.key === " ") activate(panel, Math.max(0, index));
        else if (e.key === "ArrowRight") {
          if (list[index]?.submenu) openChild(panel, index, true);
          else options.onNavigate?.(1);
        } else if (e.key === "ArrowLeft") {
          if (parent) {
            const at = parent.child?.index ?? 0;
            closeChild(parent);
            parent.buttons[at]?.focus();
          } else options.onNavigate?.(-1);
        } else if (e.key === "Escape") {
          if (parent) {
            const at = parent.child?.index ?? 0;
            closeChild(parent);
            parent.buttons[at]?.focus();
          } else close();
        } else if (e.key === "Tab") close();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }),
    );
    return panel;
  }

  const root = build(items, options.label ?? "Menu", undefined, options.search === true);
  if (replacing) root.element.classList.add("is-instant");
  if (options.minWidth) root.element.style.minWidth = `${Math.round(options.minWidth)}px`;
  // Position: below the anchor element (or at the point), kept inside the viewport.
  let rect = root.element.getBoundingClientRect();
  if (isElement(anchor)) {
    const a = anchor.getBoundingClientRect();
    const gap = options.flush ? 2 : 4;
    let y = a.bottom + gap;
    if (options.flush) {
      // A dropdown's list, as the system's: below the field when it fits, else on the side with
      // more room, shortened to fit there, never over the field (D282).
      const below = win.innerHeight - a.bottom - gap - 4;
      const above = a.top - gap - 4;
      const downward = rect.height <= below || below >= above;
      const room = downward ? below : above;
      const scroller = root.element.querySelector<HTMLElement>(".menu-items");
      if (rect.height > room && scroller) {
        scroller.style.maxHeight = `${Math.max(80, scroller.clientHeight - (rect.height - room))}px`;
        rect = root.element.getBoundingClientRect();
      }
      y = downward ? a.bottom + gap : a.top - rect.height - gap;
    } else if (y + rect.height > win.innerHeight - 4) y = Math.max(4, a.top - rect.height - gap);
    root.element.style.transformOrigin = y < a.top ? "bottom left" : "top left";
    place(root.element, a.left, y, rect, win);
  } else {
    place(root.element, anchor.x, anchor.y, rect, win);
  }

  // Defer so the opening click/contextmenu doesn't immediately close it.
  const timer = setTimeout(() => {
    const inside = (target: EventTarget | null) =>
      panels.some((p) => p.element.contains(target as Node));
    store.add(
      on(
        doc,
        "pointerdown",
        (e) => {
          if (inside(e.target)) return;
          // A press on the menu's own button closes it; its click then mustn't reopen it.
          if (isElement(anchor) && anchor.contains(e.target as Node))
            pressedAnchor = { element: anchor, until: performance.now() + 600 };
          close();
        },
        { capture: true },
      ),
    );
    store.add(on(win, "blur", close));
    // Focus moving elsewhere (e.g. a keyboard shortcut focused an editor) closes the menu too.
    store.add(
      on(doc, "focusin", (e) => {
        if (!inside(e.target)) close();
      }),
    );
  }, 0);
  store.add(toDisposable(() => clearTimeout(timer)));
  const first =
    root.buttons.find((_, i) => items[i]?.checked) ??
    root.buttons.find((_, i) => !items[i]?.disabled) ??
    root.buttons[0];
  if (!tookFocus) {
    // Focus that comes in another way (a click in the search box) counts too: the menu's own
    // keys then work as usual.
    store.add(
      on(root.element, "focusin", () => {
        tookFocus = true;
      }),
    );
    // Deferred (D378): the first key brings focus in. Typing goes to the search box (the key
    // lands there: focus moves before its default action), the arrows and Enter to the item.
    store.add(
      on(
        doc,
        "keydown",
        (e) => {
          if (tookFocus) return;
          const key = e.key;
          if (key === "Escape" || key === "Tab") {
            close();
            if (key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
            }
            return;
          }
          const typing = key.length === 1 && key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;
          if (typing && root.search) {
            tookFocus = true;
            root.search.focus();
            return;
          }
          // No search box: a letter goes to the first item starting with it, as a native list
          // does (it mustn't reach the field that kept focus, e.g. the settings search).
          const typed = typing
            ? root.buttons.find(
                (b, i) =>
                  !b.hidden &&
                  !items[i]?.disabled &&
                  (items[i]?.label ?? "").toLowerCase().startsWith(key.toLowerCase()),
              )
            : undefined;
          if (!typing && !["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(key)) {
            // Any other key (Backspace, Delete, a shortcut) is for the field that kept focus: the
            // menu closes first, so it doesn't stay open over a page that changes under it.
            if (!["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(key)) close();
            return;
          }
          tookFocus = true;
          (typed ?? first)?.focus();
          e.preventDefault();
          e.stopPropagation();
        },
        { capture: true },
      ),
    );
  } else if (root.search) root.search.focus();
  else if (options.focusFirst !== false) first?.focus();
  else root.element.tabIndex = -1;
  if (tookFocus && options.focusFirst === false) root.element.focus();
  return store;
}

function place(el: HTMLElement, x: number, y: number, rect: DOMRect, win: Window): void {
  el.style.left = `${Math.max(4, Math.min(x, win.innerWidth - rect.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, win.innerHeight - rect.height - 4))}px`;
}

/** Context menu at a point. */
export function showContextMenu(x: number, y: number, items: readonly MenuItem[]): Disposable {
  return showMenu({ x, y }, items, "Context menu");
}
