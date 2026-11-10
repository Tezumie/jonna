// The host side of live quick input sessions (core/extensions/rpcQuickInput.ts, VS Code's
// createQuickPick / createInputBox): `quickInput.open / update / hide` from the worker drive a
// QuickInput session (ui/QuickInput.ts); what the user does goes back as "provider" calls on
// `quickInput.<id>`: the value (debounced, and always before any other event), the active and
// selected items, Enter, buttons, and the end of the session exactly once.
import type { QuickInputProps } from "../../core/extensions/rpcQuickInput";
import { type Disposable, DisposableStore, toDisposable } from "../../core/lifecycle/index";
import type {
  QuickInputSession,
  SessionButton,
  SessionItem,
  SessionProps,
} from "../../ui/QuickInput";
import type { WorkbenchServices } from "../../workbench/services";
import { UNHANDLED } from "./runtimeApi";
import { safeIcon } from "./treeView";
import type { ExtensionWorker } from "./workerHost";

/** Typing reaches the worker at most this often (VS Code's own is per keystroke over IPC). */
const VALUE_DEBOUNCE_MS = 50;
const MAX_ITEMS = 5000;
const MAX_BUTTONS = 10;

export interface QuickInputHostDeps {
  services: WorkbenchServices;
  /** The worker if it runs (a session never starts it). */
  running(): ExtensionWorker | null;
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" ? v.slice(0, max) : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const ints = (v: unknown, below: number): number[] | undefined =>
  Array.isArray(v)
    ? v.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < below).slice(0, MAX_ITEMS)
    : undefined;

function buttons(raw: unknown): SessionButton[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, MAX_BUTTONS).map((b) => {
    const x = (b && typeof b === "object" ? b : {}) as Record<string, unknown>;
    const tooltip = str(x.tooltip, 200);
    return {
      icon: safeIcon(str(x.icon, 60), x.back === true ? "arrow-left" : "circle-dot"),
      ...(tooltip && { tooltip }),
      ...(x.back === true && { back: true }),
    };
  });
}

function items(raw: unknown): SessionItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.slice(0, MAX_ITEMS).map((i) => {
    const x = (i && typeof i === "object" ? i : {}) as Record<string, unknown>;
    const description = str(x.description, 500);
    const detail = str(x.detail, 1000);
    const separator = str(x.separator, 80);
    const icon = str(x.icon, 60);
    const itemButtons = buttons(x.buttons);
    return {
      label: str(x.label, 500) ?? "",
      ...(description && { description }),
      ...(detail && { detail }),
      ...(separator !== undefined && { separator }),
      ...(icon && { icon: safeIcon(icon, "circle-dot") }),
      ...(x.alwaysShow === true && { alwaysShow: true }),
      ...(itemButtons?.length && { buttons: itemButtons }),
    };
  });
}

/** The worker's properties as the session's, checked and bounded (absent keys stay absent). */
export function sessionProps(raw: unknown, itemCount: number): Partial<SessionProps> {
  const p = (raw && typeof raw === "object" ? raw : {}) as QuickInputProps &
    Record<string, unknown>;
  const out: Partial<SessionProps> = {};
  const list = items(p.items);
  if (list) out.items = list;
  const count = list?.length ?? itemCount;
  for (const key of ["title", "placeholder", "prompt"] as const) {
    const v = str(p[key], 1000);
    if (v !== undefined) out[key] = v;
  }
  const value = str(p.value, 100_000);
  if (value !== undefined) out.value = value;
  for (const key of ["step", "totalSteps"] as const)
    if (typeof p[key] === "number") out[key] = Math.max(0, Math.floor(p[key]));
  const titleButtons = buttons(p.buttons);
  if (titleButtons) out.buttons = titleButtons;
  if (
    Array.isArray(p.valueSelection) &&
    Number.isInteger(p.valueSelection[0]) &&
    Number.isInteger(p.valueSelection[1])
  )
    out.valueSelection = [p.valueSelection[0], p.valueSelection[1]];
  for (const key of [
    "password",
    "canSelectMany",
    "matchOnDescription",
    "matchOnDetail",
    "sortByLabel",
    "keepScrollPosition",
    "busy",
    "enabled",
    "ignoreFocusOut",
  ] as const) {
    const v = bool(p[key]);
    if (v !== undefined) out[key] = v;
  }
  const active = ints(p.activeIndexes, count);
  if (active) out.activeIndexes = active;
  const selected = ints(p.selectedIndexes, count);
  if (selected) out.selectedIndexes = selected;
  if (p.validation === null) out.validation = null;
  else if (p.validation && typeof p.validation === "object") {
    const message = str(p.validation.message, 1000);
    const severity = p.validation.severity;
    out.validation = message
      ? {
          message,
          severity: severity === "info" || severity === "warning" ? severity : "error",
        }
      : null;
  }
  return out;
}

interface Open {
  session: QuickInputSession;
  itemCount: number;
  store: DisposableStore;
}

export class ExtensionQuickInputHost implements Disposable {
  private readonly sessions = new Map<string, Open>();

  constructor(private readonly deps: QuickInputHostDeps) {}

  handle(method: string, p: Record<string, unknown>): Promise<unknown> | typeof UNHANDLED {
    switch (method) {
      case "quickInput.open":
        this.open(p);
        return Promise.resolve(undefined);
      case "quickInput.update": {
        const open = this.sessions.get(String(p.id));
        if (open) {
          const props = sessionProps(p.props, open.itemCount);
          if (props.items) open.itemCount = props.items.length;
          open.session.update(props);
        }
        return Promise.resolve(undefined);
      }
      case "quickInput.hide":
        this.sessions.get(String(p.id))?.session.hide();
        return Promise.resolve(undefined);
      default:
        return UNHANDLED;
    }
  }

  private open(p: Record<string, unknown>): void {
    const id = String(p.id ?? "");
    if (!/^qi\d{1,9}$/.test(id) || this.sessions.has(id)) throw new Error("Bad quick input id.");
    const kind = p.kind === "input" ? "input" : "pick";
    const store = new DisposableStore();
    const send = (event: Record<string, unknown>) =>
      this.deps.running()?.notify("provider", `quickInput.${id}`, event);
    // Typing: the latest value, sent a moment later or before anything else that follows.
    let pendingValue: string | null = null;
    let timer = 0;
    const flushValue = () => {
      window.clearTimeout(timer);
      timer = 0;
      if (pendingValue === null) return;
      const value = pendingValue;
      pendingValue = null;
      send({ kind: "value", value });
    };
    store.add(toDisposable(() => window.clearTimeout(timer)));
    const props = sessionProps(p.props, 0);
    const open: Open = {
      itemCount: props.items?.length ?? 0,
      store,
      session: this.deps.services.quickInput.openSession(kind, props, {
        value: (value) => {
          pendingValue = value;
          window.clearTimeout(timer);
          timer = window.setTimeout(flushValue, VALUE_DEBOUNCE_MS);
        },
        active: (indexes) => {
          flushValue();
          send({ kind: "active", indexes });
        },
        selection: (indexes) => {
          flushValue();
          send({ kind: "selection", indexes });
        },
        accept: () => {
          flushValue();
          send({ kind: "accept" });
        },
        button: (index) => {
          flushValue();
          send({ kind: "button", index });
        },
        itemButton: (item, button) => {
          flushValue();
          send({ kind: "itemButton", item, button });
        },
        hide: () => {
          flushValue();
          this.sessions.delete(id);
          store.dispose();
          send({ kind: "hide" });
        },
      }),
    };
    this.sessions.set(id, open);
  }

  /** The worker went away: its sessions close. */
  workerGone(): void {
    for (const open of [...this.sessions.values()]) open.session.hide();
    this.sessions.clear();
  }

  dispose(): void {
    this.workerGone();
  }
}
