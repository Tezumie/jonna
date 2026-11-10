// The `vscode` shim's quick input (VS Code's createQuickPick / createInputBox, and showQuickPick /
// showInputBox on top of them) over the IDE's live sessions (rpcQuickInput.ts): properties set
// while it's shown reach the open picker, the user's typing, active row, selection, Enter and
// buttons come back as VS Code's events, and onDidHide fires once per show. DOM-free and
// unit-tested.

import type { WorkerApi } from "../rpc";
import type {
  QuickInputButtonWire,
  QuickInputEvent,
  QuickInputHandle,
  QuickInputItemWire,
  QuickInputProps,
  QuickInputSeverity,
} from "../rpcQuickInput";
import {
  type CancellationToken,
  EventEmitter,
  QuickInputButtons,
  QuickPickItemKind,
  ThemeIcon,
} from "./types";

export type QuickPickItem = {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  kind?: QuickPickItemKind;
  iconPath?: unknown;
  alwaysShow?: boolean;
  buttons?: readonly unknown[];
};

/** "$(gear) Settings" → icon "gear", label "Settings" (VS Code's label icons). */
export function splitIcon(label: string): { label: string; icon?: string } {
  const m = /^\$\(([a-z0-9-]+)(?:~[a-z]+)?\)\s*(.*)$/.exec(label);
  return m?.[1] ? { icon: m[1], label: m[2] ?? "" } : { label };
}

const themeIconId = (v: unknown): string | undefined =>
  v instanceof ThemeIcon
    ? v.id
    : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string"
      ? (v as { id: string }).id
      : undefined;

/** A QuickInputButton as the host draws it (Back is VS Code's arrow at the left). */
export function toWireButton(raw: unknown): QuickInputButtonWire {
  if (raw === QuickInputButtons.Back) return { icon: "arrow-left", tooltip: "Back", back: true };
  const b = (raw ?? {}) as { iconPath?: unknown; tooltip?: unknown };
  const icon = themeIconId(b.iconPath);
  return {
    ...(icon && { icon }),
    ...(typeof b.tooltip === "string" && b.tooltip && { tooltip: b.tooltip }),
  };
}

/**
 * Items as the host lists them: separators become the next item's group line, and `map` gives
 * each listed item's index in the extension's array.
 */
export function toWireItems(items: readonly (string | QuickPickItem)[]): {
  wire: QuickInputItemWire[];
  map: number[];
} {
  const wire: QuickInputItemWire[] = [];
  const map: number[] = [];
  let separator: string | undefined;
  items.forEach((raw, index) => {
    const item = typeof raw === "string" ? { label: raw } : (raw ?? { label: "" });
    if (item.kind === QuickPickItemKind.Separator) {
      separator = String(item.label ?? "");
      return;
    }
    const { label, icon } = splitIcon(String(item.label ?? ""));
    const themeIcon = themeIconId(item.iconPath);
    const buttons = Array.isArray(item.buttons) ? item.buttons.map(toWireButton) : [];
    wire.push({
      label,
      ...((icon ?? themeIcon) && { icon: icon ?? themeIcon }),
      ...(typeof item.description === "string" &&
        item.description && {
          description: item.description,
        }),
      ...(typeof item.detail === "string" && item.detail && { detail: item.detail }),
      ...(item.alwaysShow === true && { alwaysShow: true }),
      ...(separator !== undefined && { separator }),
      ...(buttons.length && { buttons }),
    });
    map.push(index);
    separator = undefined;
  });
  return { wire, map };
}

/** VS Code's validation message (a string is an error) as the host shows it. */
export function toValidation(
  raw: unknown,
): { message: string; severity: QuickInputSeverity } | null {
  if (typeof raw === "string") return raw ? { message: raw, severity: "error" } : null;
  if (!raw || typeof raw !== "object") return null;
  const v = raw as { message?: unknown; severity?: unknown };
  if (typeof v.message !== "string" || !v.message) return null;
  // InputBoxValidationSeverity: Info 1, Warning 2, Error 3.
  const severity = v.severity === 1 ? "info" : v.severity === 2 ? "warning" : "error";
  return { message: v.message, severity };
}

const blocking = (raw: unknown) => toValidation(raw)?.severity === "error";

/** Shared by both kinds: emitters, show / hide / dispose, and properties pushed while shown. */
function createSession<S extends Record<string, unknown>>(
  ide: WorkerApi,
  kind: "pick" | "input",
  state: S,
  /** The host's properties for the whole state, or for the keys that changed. */
  wire: (keys?: readonly (keyof S)[]) => QuickInputProps,
  onEvent: (event: QuickInputEvent) => void,
) {
  const onDidHide = new EventEmitter<void>();
  const onDidTriggerButton = new EventEmitter<unknown>();
  const onDidAccept = new EventEmitter<void>();
  let handle: QuickInputHandle | null = null;
  let disposed = false;
  const set = <K extends keyof S>(key: K, value: S[K]) => {
    state[key] = value;
    handle?.update(wire([key]));
  };
  const show = () => {
    if (disposed || (handle && !handle.hidden)) return;
    const current: QuickInputHandle = ide.ui.quickInput.open(kind, wire(), (event) => {
      if (handle !== current) return;
      if (event.kind === "hide") {
        handle = null;
        onDidHide.fire();
        return;
      }
      if (event.kind === "accept") onDidAccept.fire();
      else if (event.kind === "button") {
        const button = (state.buttons as readonly unknown[] | undefined)?.[event.index];
        if (button !== undefined) onDidTriggerButton.fire(button);
      } else onEvent(event);
    });
    handle = current;
  };
  return {
    set,
    show,
    hide: () => handle?.hide(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (handle) {
        // onDidHide still fires (VS Code's dispose hides first); then the emitters go.
        const sub = onDidHide.event(() => {
          sub.dispose();
          onDidAccept.dispose();
          onDidTriggerButton.dispose();
        });
        handle.hide();
      }
    },
    onDidHide: onDidHide.event,
    onDidAccept: onDidAccept.event,
    onDidTriggerButton: onDidTriggerButton.event,
  };
}

/** Defines `keys` on `target` as properties whose setter pushes the change to the session. */
function bind<S extends Record<string, unknown>>(
  target: object,
  state: S,
  set: <K extends keyof S>(key: K, value: S[K]) => void,
  keys: readonly (keyof S)[],
): void {
  for (const key of keys)
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get: () => state[key],
      set: (v: S[typeof key]) => set(key, v),
    });
}

export function createQuickPick(ide: WorkerApi) {
  const onDidChangeValue = new EventEmitter<string>();
  const onDidChangeActive = new EventEmitter<readonly QuickPickItem[]>();
  const onDidChangeSelection = new EventEmitter<readonly QuickPickItem[]>();
  const onDidTriggerItemButton = new EventEmitter<{ item: QuickPickItem; button: unknown }>();
  const state = {
    items: [] as readonly QuickPickItem[],
    value: "",
    placeholder: undefined as string | undefined,
    title: undefined as string | undefined,
    step: undefined as number | undefined,
    totalSteps: undefined as number | undefined,
    buttons: [] as readonly unknown[],
    canSelectMany: false,
    matchOnDescription: false,
    matchOnDetail: false,
    sortByLabel: true,
    keepScrollPosition: false,
    busy: false,
    enabled: true,
    ignoreFocusOut: false,
    activeItems: [] as readonly QuickPickItem[],
    selectedItems: [] as readonly QuickPickItem[],
  };
  type State = typeof state;
  let listed = toWireItems([]);
  const itemsAt = (indexes: readonly number[]) =>
    indexes.flatMap((n) => {
      const at = listed.map[n];
      const item = at === undefined ? undefined : state.items[at];
      return item === undefined ? [] : [item];
    });
  const indexesOf = (items: readonly QuickPickItem[]) =>
    items.flatMap((item) => {
      const at = listed.map.indexOf(state.items.indexOf(item));
      return at >= 0 ? [at] : [];
    });
  const wire = (keys?: readonly (keyof State)[]): QuickInputProps => {
    const all = !keys;
    const has = (k: keyof State) => all || keys.includes(k);
    const props: QuickInputProps = {};
    if (has("items")) {
      listed = toWireItems(state.items);
      props.items = listed.wire;
      // Items no longer listed aren't selected or active any more (VS Code's).
      state.selectedItems = state.selectedItems.filter((i) => state.items.includes(i));
      state.activeItems = state.activeItems.filter((i) => state.items.includes(i));
      props.selectedIndexes = indexesOf(state.selectedItems);
      if (state.activeItems.length) props.activeIndexes = indexesOf(state.activeItems);
    }
    if (has("activeItems")) props.activeIndexes = indexesOf(state.activeItems);
    if (has("selectedItems")) props.selectedIndexes = indexesOf(state.selectedItems);
    if (has("value")) props.value = state.value;
    if (has("placeholder")) props.placeholder = state.placeholder ?? "";
    if (has("title")) props.title = state.title ?? "";
    if (has("step")) props.step = state.step ?? 0;
    if (has("totalSteps")) props.totalSteps = state.totalSteps ?? 0;
    if (has("buttons")) props.buttons = [...(state.buttons ?? [])].map(toWireButton);
    for (const k of [
      "canSelectMany",
      "matchOnDescription",
      "matchOnDetail",
      "sortByLabel",
      "keepScrollPosition",
      "busy",
      "enabled",
      "ignoreFocusOut",
    ] as const)
      if (has(k)) props[k] = state[k] === true;
    return props;
  };
  const session = createSession(ide, "pick", state, wire, (event) => {
    if (event.kind === "value") {
      state.value = event.value;
      onDidChangeValue.fire(event.value);
    } else if (event.kind === "active") {
      state.activeItems = itemsAt(event.indexes);
      onDidChangeActive.fire(state.activeItems);
    } else if (event.kind === "selection") {
      state.selectedItems = itemsAt(event.indexes);
      onDidChangeSelection.fire(state.selectedItems);
    } else if (event.kind === "itemButton") {
      const item = itemsAt([event.item])[0];
      const button = item?.buttons?.[event.button];
      if (item && button !== undefined) onDidTriggerItemButton.fire({ item, button });
    }
  });
  const pick = {
    onDidChangeValue: onDidChangeValue.event,
    onDidChangeActive: onDidChangeActive.event,
    onDidChangeSelection: onDidChangeSelection.event,
    onDidAccept: session.onDidAccept,
    onDidHide: session.onDidHide,
    onDidTriggerButton: session.onDidTriggerButton,
    onDidTriggerItemButton: onDidTriggerItemButton.event,
    show: session.show,
    hide: session.hide,
    dispose: session.dispose,
  };
  bind(pick, state, session.set, Object.keys(state) as (keyof State)[]);
  // Setting the value also reports it (VS Code's onDidChangeValue follows the change).
  Object.defineProperty(pick, "value", {
    enumerable: true,
    get: () => state.value,
    set: (v: string) => {
      const value = String(v ?? "");
      if (value === state.value) return;
      session.set("value", value);
      onDidChangeValue.fire(value);
    },
  });
  return pick as typeof pick & State;
}

export function createInputBox(ide: WorkerApi) {
  const onDidChangeValue = new EventEmitter<string>();
  const state = {
    value: "",
    valueSelection: undefined as readonly [number, number] | undefined,
    placeholder: undefined as string | undefined,
    prompt: undefined as string | undefined,
    title: undefined as string | undefined,
    step: undefined as number | undefined,
    totalSteps: undefined as number | undefined,
    password: false,
    validationMessage: undefined as unknown,
    buttons: [] as readonly unknown[],
    busy: false,
    enabled: true,
    ignoreFocusOut: false,
  };
  type State = typeof state;
  const wire = (keys?: readonly (keyof State)[]): QuickInputProps => {
    const all = !keys;
    const has = (k: keyof State) => all || keys.includes(k);
    const props: QuickInputProps = {};
    if (has("value")) props.value = state.value;
    if (has("valueSelection") && state.valueSelection)
      props.valueSelection = [state.valueSelection[0], state.valueSelection[1]];
    if (has("placeholder")) props.placeholder = state.placeholder ?? "";
    if (has("prompt")) props.prompt = state.prompt ?? "";
    if (has("title")) props.title = state.title ?? "";
    if (has("step")) props.step = state.step ?? 0;
    if (has("totalSteps")) props.totalSteps = state.totalSteps ?? 0;
    if (has("password")) props.password = state.password === true;
    if (has("validationMessage")) props.validation = toValidation(state.validationMessage);
    if (has("buttons")) props.buttons = [...(state.buttons ?? [])].map(toWireButton);
    for (const k of ["busy", "enabled", "ignoreFocusOut"] as const)
      if (has(k)) props[k] = state[k] === true;
    return props;
  };
  const session = createSession(ide, "input", state, wire, (event) => {
    if (event.kind !== "value") return;
    state.value = event.value;
    onDidChangeValue.fire(event.value);
  });
  const box = {
    onDidChangeValue: onDidChangeValue.event,
    onDidAccept: session.onDidAccept,
    onDidHide: session.onDidHide,
    onDidTriggerButton: session.onDidTriggerButton,
    show: session.show,
    hide: session.hide,
    dispose: session.dispose,
  };
  bind(box, state, session.set, Object.keys(state) as (keyof State)[]);
  Object.defineProperty(box, "value", {
    enumerable: true,
    get: () => state.value,
    set: (v: string) => {
      const value = String(v ?? "");
      if (value === state.value) return;
      session.set("value", value);
      onDidChangeValue.fire(value);
    },
  });
  return box as typeof box & State;
}

export interface ShowQuickPickOptions {
  placeHolder?: string;
  title?: string;
  canPickMany?: boolean;
  matchOnDescription?: boolean;
  matchOnDetail?: boolean;
  ignoreFocusOut?: boolean;
  /** The item active at first, by index (the shim's own; VS Code has none). */
  activeIndex?: number;
  onDidSelectItem?(item: string | QuickPickItem): unknown;
}

/** VS Code's showQuickPick on a QuickPick session: busy while the items load. */
export function showQuickPick(
  ide: WorkerApi,
  itemsOrPromise:
    | readonly (string | QuickPickItem)[]
    | PromiseLike<readonly (string | QuickPickItem)[]>,
  options: ShowQuickPickOptions = {},
  token?: CancellationToken,
): Promise<unknown> {
  return new Promise((resolve) => {
    const qp = createQuickPick(ide);
    // Strings become items, and the answer is the string again.
    const objects = new Map<QuickPickItem, string | QuickPickItem>();
    let done = false;
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      resolve(value);
      qp.dispose();
    };
    const back = (items: readonly QuickPickItem[]) => items.map((i) => objects.get(i) ?? i);
    if (options.placeHolder) qp.placeholder = options.placeHolder;
    if (options.title) qp.title = options.title;
    qp.canSelectMany = options.canPickMany === true;
    qp.matchOnDescription = options.matchOnDescription === true;
    qp.matchOnDetail = options.matchOnDetail === true;
    qp.ignoreFocusOut = options.ignoreFocusOut === true;
    qp.onDidHide(() => finish(undefined));
    qp.onDidChangeActive((items) => {
      const first = back(items)[0];
      if (first !== undefined) void options.onDidSelectItem?.(first);
    });
    // One item: Enter or a click picks it. Several: Enter takes the checked ones.
    qp.onDidChangeSelection((items) => {
      if (!qp.canSelectMany && items[0]) finish(back(items)[0]);
    });
    qp.onDidAccept(() => {
      if (qp.canSelectMany) finish(back(qp.selectedItems));
    });
    token?.onCancellationRequested(() => finish(undefined));
    const fill = (raw: readonly (string | QuickPickItem)[]) => {
      if (done) return;
      const items = (Array.isArray(raw) ? raw : []).map((r) => {
        if (typeof r !== "string") return r;
        const item = { label: r };
        objects.set(item, r);
        return item;
      });
      qp.items = items;
      if (qp.canSelectMany)
        qp.selectedItems = items.filter((i) => i.picked && i.kind !== QuickPickItemKind.Separator);
      const active = options.activeIndex === undefined ? undefined : items[options.activeIndex];
      if (active) qp.activeItems = [active];
      qp.busy = false;
    };
    if (Array.isArray(itemsOrPromise)) {
      fill(itemsOrPromise as readonly (string | QuickPickItem)[]);
      qp.show();
    } else {
      qp.busy = true;
      qp.show();
      Promise.resolve(itemsOrPromise).then(fill, () => finish(undefined));
    }
  });
}

export interface ShowInputBoxOptions {
  prompt?: string;
  value?: string;
  valueSelection?: [number, number];
  placeHolder?: string;
  password?: boolean;
  title?: string;
  ignoreFocusOut?: boolean;
  validateInput?(value: string): unknown;
}

/**
 * VS Code's showInputBox on an InputBox session: validateInput runs as the value changes (the
 * latest answer wins), and Enter checks the value once more; only an Error-severity problem keeps
 * the box open.
 */
export function showInputBox(
  ide: WorkerApi,
  options: ShowInputBoxOptions = {},
  token?: CancellationToken,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const box = createInputBox(ide);
    let done = false;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      resolve(value);
      box.dispose();
    };
    if (options.value !== undefined) box.value = String(options.value);
    if (options.valueSelection) box.valueSelection = options.valueSelection;
    if (options.placeHolder) box.placeholder = options.placeHolder;
    if (options.prompt) box.prompt = options.prompt;
    if (options.title) box.title = options.title;
    box.password = options.password === true;
    box.ignoreFocusOut = options.ignoreFocusOut === true;
    let latest = 0;
    const validate = async (value: string): Promise<unknown> => {
      if (!options.validateInput) return undefined;
      const seq = ++latest;
      // A validator that throws (even before returning a promise) is no problem: the box would
      // otherwise stay disabled and busy after Enter.
      let problem: unknown;
      try {
        problem = await options.validateInput(value);
      } catch {
        problem = undefined;
      }
      if (seq === latest && !done) box.validationMessage = problem ?? undefined;
      return problem;
    };
    box.onDidChangeValue((value) => void validate(value));
    box.onDidAccept(async () => {
      if (!box.enabled) return;
      box.enabled = false;
      box.busy = true;
      const value = box.value;
      const problem = await validate(value);
      if (done) return;
      box.enabled = true;
      box.busy = false;
      if (!blocking(problem)) finish(value);
    });
    box.onDidHide(() => finish(undefined));
    token?.onCancellationRequested(() => finish(undefined));
    box.show();
    void validate(box.value);
  });
}
