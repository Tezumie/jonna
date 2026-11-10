// Modal dialogs (DESIGN.md §12.10): title, body, actions right-aligned with the primary action
// rightmost on every platform. Escape and scrim click resolve with `cancelValue`. Focus is trapped
// and returned to the trigger. Replaces native message boxes so dialogs follow the theme.
import { h, on } from "../core/dom/index";
import { DisposableStore, toDisposable } from "../core/lifecycle/index";

export interface DialogAction<T> {
  label: string;
  value: T;
  variant?: "primary" | "secondary" | "danger";
}

export interface DialogOptions<T> {
  title: string;
  message: string;
  /** Left to right; put the primary action last. */
  actions: DialogAction<T>[];
  /** Returned on Escape / scrim click. */
  cancelValue: T;
  /** Action focused first (default: the last one). */
  defaultValue?: T;
  size?: "sm" | "md" | "lg";
  /**
   * Options under the message (unchecked unless `checked`); read each with `onCheck` (D166;
   * several since D275).
   */
  checkbox?: DialogCheckbox | readonly DialogCheckbox[];
  /** Closes the dialog with `cancelValue` when aborted (the question was answered elsewhere). */
  signal?: AbortSignal;
  /** Richer content under the message (a settings form, D205); its controls join the Tab order. */
  content?: HTMLElement;
  /** An element before the title (an icon or logo). */
  titleIcon?: Element;
  /** Actions on the left of the footer (e.g. Reload), before the right-aligned ones. */
  leftActions?: DialogAction<T>[];
}

export interface DialogCheckbox {
  label: string;
  detail?: string;
  checked?: boolean;
  onCheck(checked: boolean): void;
}

/** Open dialogs' scrims, the topmost last. */
const openDialogs: HTMLElement[] = [];

/** True while a modal dialog is open: workbench keybindings don't run under it (D203). */
export function isModalDialogOpen(): boolean {
  return openDialogs.length > 0;
}

export function showDialog<T>(options: DialogOptions<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    const store = new DisposableStore();
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const titleId = `dialog-title-${Math.random().toString(36).slice(2, 8)}`;
    const finish = (value: T) => {
      store.dispose();
      resolve(value);
    };
    const button = (action: DialogAction<T>) => {
      const button = h(
        "button",
        { class: `button button-${action.variant ?? "secondary"}`, type: "button" },
        action.label,
      );
      store.add(on(button, "click", () => finish(action.value)));
      return button;
    };
    const buttons = options.actions.map(button);
    const leftButtons = (options.leftActions ?? []).map(button);
    const boxes: readonly DialogCheckbox[] = !options.checkbox
      ? []
      : "label" in options.checkbox
        ? [options.checkbox]
        : options.checkbox;
    const checks = boxes.map((box) => {
      const input = h("input", {
        type: "checkbox",
        class: "dialog-check-input",
      }) as HTMLInputElement;
      input.checked = box.checked === true;
      store.add(on(input, "change", () => box.onCheck(input.checked)));
      const row = h(
        "label",
        { class: "dialog-check" },
        input,
        h(
          "span",
          { class: "dialog-check-text" },
          h("span", null, box.label),
          box.detail ? h("span", { class: "dialog-check-detail" }, box.detail) : null,
        ),
      );
      return { input, row };
    });
    const fixedFocusable: HTMLElement[] = [
      ...checks.map((c) => c.input),
      ...leftButtons,
      ...buttons,
    ];
    const dialog = h(
      "div",
      {
        class: `dialog dialog-${options.size ?? "sm"}`,
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": titleId,
        // A click on its text focuses the dialog instead of <body>, so Esc and Tab still work.
        tabindex: "-1",
      },
      h(
        "div",
        { class: `dialog-title${options.titleIcon ? " has-icon" : ""}`, id: titleId },
        options.titleIcon ?? null,
        options.title,
      ),
      h(
        "div",
        { class: "dialog-body" },
        ...(options.message ? options.message.split("\n\n").map((p) => h("p", null, p)) : []),
        ...checks.map((c) => c.row),
        options.content ?? null,
      ),
      h(
        "div",
        { class: "dialog-actions" },
        leftButtons.length ? h("div", { class: "dialog-actions-left" }, leftButtons) : null,
        buttons,
      ),
    );
    const scrim = h("div", { class: "dialog-scrim" }, dialog);
    document.body.appendChild(scrim);
    openDialogs.push(scrim);
    store.add(
      toDisposable(() => {
        openDialogs.splice(openDialogs.indexOf(scrim), 1);
        scrim.remove();
      }),
    );
    // Focus that lands outside (a click that reached <body>, a view focusing itself) comes back;
    // only the topmost dialog does this, so stacked dialogs don't fight over focus.
    store.add(
      on(document, "focusin", (e) => {
        if (openDialogs[openDialogs.length - 1] !== scrim) return;
        if (e.target instanceof Node && scrim.contains(e.target)) return;
        dialog.focus();
      }),
    );
    store.add(toDisposable(() => returnFocus?.isConnected && returnFocus.focus()));
    store.add(
      on(scrim, "pointerdown", (e) => {
        if (e.target === scrim) finish(options.cancelValue);
      }),
    );
    store.add(
      on(
        scrim,
        "keydown",
        (e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            finish(options.cancelValue);
          } else if (e.key === "Tab") {
            // Trap focus inside the dialog.
            // The content's controls too, in document order (they change as it redraws).
            const focusable = options.content
              ? [
                  ...checks.map((c) => c.input),
                  ...[
                    ...options.content.querySelectorAll<HTMLElement>(
                      "button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex='0']",
                    ),
                  ],
                  ...leftButtons,
                  ...buttons,
                ]
              : fixedFocusable;
            const i = focusable.indexOf(document.activeElement as HTMLElement);
            const n = focusable.length;
            // From the dialog itself (after a click on its text): the first or the last control.
            const next =
              i < 0
                ? focusable[e.shiftKey ? n - 1 : 0]
                : focusable[(i + (e.shiftKey ? -1 : 1) + n) % n];
            e.preventDefault();
            next?.focus();
          }
          // Keys never reach the workbench keybindings while a dialog is open.
          e.stopPropagation();
        },
        { capture: true },
      ),
    );
    const signal = options.signal;
    if (signal) {
      const abort = () => finish(options.cancelValue);
      if (signal.aborted) queueMicrotask(abort);
      signal.addEventListener("abort", abort);
      store.add(toDisposable(() => signal.removeEventListener("abort", abort)));
    }
    const index =
      options.defaultValue === undefined
        ? buttons.length - 1
        : options.actions.findIndex((a) => a.value === options.defaultValue);
    (buttons[index] ?? buttons[buttons.length - 1])?.focus();
  });
}

/** Save / Don't save / Cancel. */
export function confirmSaveChanges(
  title: string,
  message: string,
): Promise<"save" | "discard" | "cancel"> {
  return showDialog<"save" | "discard" | "cancel">({
    title,
    message,
    actions: [
      { label: "Don't save", value: "discard" },
      { label: "Cancel", value: "cancel" },
      { label: "Save", value: "save", variant: "primary" },
    ],
    cancelValue: "cancel",
  });
}

/** A yes/no confirmation; destructive confirmations use the danger style. */
export async function confirmAction(
  title: string,
  message: string,
  confirmLabel: string,
  destructive = false,
): Promise<boolean> {
  return showDialog<boolean>({
    title,
    message,
    actions: [
      { label: "Cancel", value: false },
      { label: confirmLabel, value: true, variant: destructive ? "danger" : "primary" },
    ],
    cancelValue: false,
  });
}

/**
 * A yes/no confirmation with an extra option, unchecked by default (D166): "Also forget model
 * providers and their API keys" when resetting settings.
 */
export async function confirmWithOption(
  title: string,
  message: string,
  confirmLabel: string,
  option: { label: string; detail?: string },
  destructive = false,
): Promise<{ ok: boolean; option: boolean }> {
  let checked = false;
  const ok = await showDialog<boolean>({
    title,
    message,
    actions: [
      { label: "Cancel", value: false },
      { label: confirmLabel, value: true, variant: destructive ? "danger" : "primary" },
    ],
    cancelValue: false,
    checkbox: { ...option, onCheck: (value) => (checked = value) },
  });
  return { ok, option: ok && checked };
}

/** `confirmWithOption` with several options; `options` says which were checked (all false on Cancel). */
export async function confirmWithOptions(
  title: string,
  message: string,
  confirmLabel: string,
  choices: readonly { label: string; detail?: string }[],
  destructive = false,
): Promise<{ ok: boolean; options: boolean[] }> {
  const checked = choices.map(() => false);
  const ok = await showDialog<boolean>({
    title,
    message,
    actions: [
      { label: "Cancel", value: false },
      { label: confirmLabel, value: true, variant: destructive ? "danger" : "primary" },
    ],
    cancelValue: false,
    checkbox: choices.map((choice, i) => ({ ...choice, onCheck: (value) => (checked[i] = value) })),
  });
  return { ok, options: checked.map((c) => ok && c) };
}
