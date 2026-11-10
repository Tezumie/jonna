// Keyboard and screen reader basics, checked in the real app (D254): `dev.checkAccessibility`
// lists the controls a screen reader can't name (an icon button with no label or title) and the
// ones that show nothing when the keyboard focuses them (a rule's `outline: none` without a ring
// of its own). UI scripts run it on the main screens; the fixes follow DESIGN.md §11.

import { windowIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

const CONTROLS =
  'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="option"], [role="treeitem"], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

/** The name a screen reader reads for `el` (the parts of the accessible-name rules we use). */
function accessibleName(el: Element): string {
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled)
    return labelled
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
  const aria = el.getAttribute("aria-label")?.trim();
  if (aria) return aria;
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    const label = el.labels?.[0]?.textContent?.trim();
    if (label) return label;
    if ("placeholder" in el && el.placeholder) return el.placeholder;
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type))
      return el.value;
  }
  // innerText is empty in a row the page doesn't render offscreen (content-visibility).
  const text = (el as HTMLElement).innerText?.trim() || el.textContent?.trim() || "";
  if (text) return text;
  // An icon's own label (an <svg aria-label>, an <img alt>).
  const inner = el.querySelector("[aria-label], img[alt]");
  const innerName = inner?.getAttribute("aria-label") ?? inner?.getAttribute("alt");
  if (innerName?.trim()) return innerName.trim();
  return el.getAttribute("title")?.trim() ?? "";
}

function shown(el: HTMLElement): boolean {
  if (el.closest("[hidden], [aria-hidden='true'], [inert]")) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && st.display !== "none";
}

/** A short path for a finding: its tag, classes and a bit of its parent's. */
function describe(el: Element): string {
  const part = (e: Element) =>
    `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ""}${[...e.classList]
      .slice(0, 3)
      .map((c) => `.${c}`)
      .join("")}`;
  return el.parentElement ? `${part(el.parentElement)} > ${part(el)}` : part(el);
}

/** Whether the focused element looks focused: a ring, a shadow, or a changed background/border. */
function looksFocused(el: HTMLElement, before: CSSStyleDeclaration): boolean {
  const now = getComputedStyle(el);
  if (now.outlineStyle !== "none" && Number.parseFloat(now.outlineWidth) > 0) return true;
  if (now.boxShadow !== "none" && now.boxShadow !== before.boxShadow) return true;
  return (
    now.backgroundColor !== before.backgroundColor ||
    now.borderColor !== before.borderColor ||
    now.color !== before.color ||
    now.textDecorationLine !== before.textDecorationLine
  );
}

export function registerA11yCheck(sub: DisposableStore, services: WorkbenchServices): void {
  sub.add(
    services.dispatcher.register({
      id: "dev.checkAccessibility",
      title: "Check accessibility basics",
      category: "Developer",
      description:
        "Lists the visible controls a screen reader can't name (no text, aria-label or title) and, with `focus`, the ones that show nothing when focused by keyboard. `within`: a CSS selector to limit the check to. Returns { unnamed, noFocusRing, checked }, and `windowFocused: false` when the window couldn't be brought forward (focus rings then aren't checked).",
      input: s.object({
        within: s.string().optional(),
        focus: s.boolean().describe("Also focus each control (default true)").optional(),
      }),
      effects: [],
      run: async ({ within, focus }) => {
        const root = within ? document.querySelector(within) : document.body;
        if (!root) throw new Error(`Nothing matches ${within}.`);
        const controls = [...root.querySelectorAll<HTMLElement>(CONTROLS)].filter(
          (el) => shown(el) && !el.closest(".xterm, .monaco-editor, iframe"),
        );
        const unnamed = controls.filter((el) => !accessibleName(el)).map(describe);
        const noFocusRing: string[] = [];
        // A window in the background shows no focus styles at all (Chromium matches :focus only
        // in the focused window): every control would read as having no ring. Bring it forward;
        // when the OS won't (another app has the foreground), say so instead (D280).
        if (focus !== false && !document.hasFocus()) {
          await windowIpc.focus().catch(() => {});
          await new Promise((r) => setTimeout(r, 200));
        }
        const windowFocused = document.hasFocus();
        if (focus !== false && windowFocused) {
          const active = document.activeElement as HTMLElement | null;
          // A focus style that fades in (a border's transition) is read where it ends.
          const still = document.head.appendChild(
            Object.assign(document.createElement("style"), {
              textContent: "* { transition: none !important; }",
            }),
          );
          for (const el of controls) {
            if (el.matches(":disabled")) continue;
            const before = getComputedStyle(el);
            const snapshot = {
              boxShadow: before.boxShadow,
              backgroundColor: before.backgroundColor,
              borderColor: before.borderColor,
              color: before.color,
              textDecorationLine: before.textDecorationLine,
            } as CSSStyleDeclaration;
            el.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
            if (document.activeElement !== el) continue;
            // Text fields mark focus with their border (DESIGN.md §11): not a ring.
            // A list shows focus on its active row (DESIGN.md §12.4).
            const row = el.matches(".vlist")
              ? el.querySelector<HTMLElement>(".vlist-row.is-active")
              : null;
            const rowRing = row && getComputedStyle(row).outlineStyle !== "none";
            if (
              !rowRing &&
              !looksFocused(el, snapshot) &&
              !el.matches("input, textarea, [contenteditable]")
            )
              noFocusRing.push(describe(el));
          }
          still.remove();
          active?.focus({ preventScroll: true });
        }
        return {
          checked: controls.length,
          unnamed: [...new Set(unnamed)].slice(0, 100),
          noFocusRing: [...new Set(noFocusRing)].slice(0, 100),
          ...(focus !== false && !windowFocused && { windowFocused: false }),
        };
      },
    }),
  );
}
