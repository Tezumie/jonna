// The worker side of live quick input sessions (`ide.ui.quickInput`, VS Code's createQuickPick /
// createInputBox): a session opens with its properties (`quickInput.open`), changes made in one
// turn reach the host as one `quickInput.update`, and `quickInput.hide` closes it. The host
// reports what the user does through "provider" calls on `quickInput.<id>`: the typed value
// (debounced), the active and selected items (by index in the items sent), Enter, title and item
// buttons, and the end of the session (exactly once). DOM-free, unit-tested.
import type { OnCall, Request } from "./rpcTerminals";

/** A title bar or item button: an icon of the IDE's set (VS Code's ThemeIcon id). */
export interface QuickInputButtonWire {
  icon?: string;
  tooltip?: string;
  /** VS Code's QuickInputButtons.Back (drawn at the title's left). */
  back?: boolean;
}

export interface QuickInputItemWire {
  label: string;
  description?: string;
  detail?: string;
  icon?: string;
  /** Starts a group: a line above the item with this name (VS Code's separator items). */
  separator?: string;
  alwaysShow?: boolean;
  buttons?: QuickInputButtonWire[];
}

export type QuickInputSeverity = "info" | "warning" | "error";

export interface QuickInputProps {
  title?: string;
  step?: number;
  totalSteps?: number;
  buttons?: QuickInputButtonWire[];
  placeholder?: string;
  prompt?: string;
  value?: string;
  valueSelection?: [number, number];
  password?: boolean;
  items?: QuickInputItemWire[];
  activeIndexes?: number[];
  selectedIndexes?: number[];
  canSelectMany?: boolean;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  sortByLabel?: boolean;
  keepScrollPosition?: boolean;
  busy?: boolean;
  enabled?: boolean;
  ignoreFocusOut?: boolean;
  /** Shown under the box; only "error" holds Enter back. null clears it. */
  validation?: { message: string; severity: QuickInputSeverity } | null;
}

/** What the host reports (indexes are positions in the last `items` sent). */
export type QuickInputEvent =
  | { kind: "value"; value: string }
  | { kind: "active"; indexes: number[] }
  | { kind: "selection"; indexes: number[] }
  | { kind: "accept" }
  | { kind: "button"; index: number }
  | { kind: "itemButton"; item: number; button: number }
  | { kind: "hide" };

export interface QuickInputHandle {
  readonly id: string;
  /** Sends changed properties (merged and sent once per turn). */
  update(props: QuickInputProps): void;
  /** Closes the session; the "hide" event follows. */
  hide(): void;
  /** True once "hide" was reported. */
  readonly hidden: boolean;
}

export interface QuickInputApi {
  open(
    kind: "pick" | "input",
    props: QuickInputProps,
    listener: (event: QuickInputEvent) => void,
  ): QuickInputHandle;
}

const indexes = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n >= 0) : [];

/** A host event as a typed one (null: not one). */
export function toQuickInputEvent(raw: unknown): QuickInputEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  switch (e.kind) {
    case "value":
      return { kind: "value", value: typeof e.value === "string" ? e.value : "" };
    case "active":
    case "selection":
      return { kind: e.kind, indexes: indexes(e.indexes) };
    case "accept":
    case "hide":
      return { kind: e.kind };
    case "button":
      return Number.isInteger(e.index) ? { kind: "button", index: e.index as number } : null;
    case "itemButton":
      return Number.isInteger(e.item) && Number.isInteger(e.button)
        ? { kind: "itemButton", item: e.item as number, button: e.button as number }
        : null;
    default:
      return null;
  }
}

export function createQuickInputApi(request: Request, onCall: OnCall): QuickInputApi {
  let seq = 0;
  return {
    open(kind, props, listener) {
      const id = `qi${++seq}`;
      let hidden = false;
      let pending: QuickInputProps | null = null;
      const end = () => {
        if (hidden) return;
        hidden = true;
        pending = null;
        off();
        listener({ kind: "hide" });
      };
      const off = onCall(`quickInput.${id}`, (raw: unknown) => {
        if (hidden) return null;
        const event = toQuickInputEvent(raw);
        if (!event) return null;
        if (event.kind === "hide") end();
        else listener(event);
        return null;
      });
      // A host that refused or lost it: the session is over all the same (onDidHide fires).
      void request("quickInput.open", { id, kind, props }).catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : String(err));
        end();
      });
      const flush = () => {
        const changes = pending;
        pending = null;
        if (!changes || hidden) return;
        void request("quickInput.update", { id, props: changes }).catch(() => {});
      };
      return {
        id,
        get hidden() {
          return hidden;
        },
        update(changes) {
          if (hidden) return;
          const first = pending === null;
          pending = { ...pending, ...changes };
          if (first) queueMicrotask(flush);
        },
        hide() {
          if (hidden) return;
          // What changed in this turn first (an extension sets a value, then hides).
          flush();
          void request("quickInput.hide", { id }).catch(() => end());
        },
      };
    },
  };
}
