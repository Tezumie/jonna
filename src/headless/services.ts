// The services a screen draws, for a session that has none: notifications are kept and told as
// events instead of shown, questions are answered by a policy or refused, the status bar and the
// theme only hold what they are given, and what exists only in a window (auxiliary windows,
// iframes, dragging) is inert. `screenlessImplementations` puts them together for
// createServices; the logic services (dispatcher, state, settings, workspace, trust…) are the
// same ones the window uses. DOM-free: this file and what it imports run in Node.
import type { AuditEntry } from "../core/dispatcher/index";
import { NeedsScreenError } from "../core/dispatcher/screen";
import { Emitter, type Event } from "../core/events/index";
import { storeIpc } from "../core/ipc/system";
import type { Platform } from "../core/keybindings/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import type { AuthorizeRequest } from "../core/permissions/index";
import { type ReadonlySignal, type Signal, signal } from "../core/reactive/index";
import type { Rgba } from "../core/themes/color";
import type {
  NotificationKind,
  NotificationOptions,
  NotificationRecord,
} from "../ui/Notifications";
import type {
  DynamicPickOptions,
  InputOptions,
  PickOptions,
  QuickInputSession,
  QuickPickItem,
  SessionHandlers,
  SessionProps,
} from "../ui/QuickInput";
import { askAgentPermission } from "../workbench/agentPermission";
import type { ServiceImplementations } from "../workbench/createServices";
import type {
  AuxWindows,
  IframeHost,
  NotificationService,
  QuickInputService,
  StatusBarService,
  ThemeApi,
} from "../workbench/services";
import { SettingsService } from "../workbench/settings";
import type { StatusItem } from "../workbench/statusbar";
import {
  DENSITIES,
  type Density,
  PANEL_STYLES,
  type PanelStyle,
  SIDE_BAR_COLORS,
  type SideBarColor,
  TAB_STYLES,
  type TabStyle,
  THEMES,
  type ThemeKind,
  type UiPreferences,
} from "../workbench/theme";
import type { TrustFolderRequest, TrustPrompts } from "../workbench/trust";

// ---- Notifications ---------------------------------------------------------------------------

const MAX_HISTORY = 200;

/** A notice as a screenless session keeps it: what the window's list holds, plus its buttons' labels. */
export interface HeadlessNotification extends NotificationRecord {
  /** The labels of its buttons (the choices it offered). */
  choices: readonly string[];
  /** The button a policy chose for it, if any. */
  chosen?: string;
}

/** Work under way that the window would show as a progress toast. */
export interface HeadlessProgress {
  id: number;
  message: string;
  title?: string;
  /** 0 to 100 once the work says how far it is. */
  percent?: number;
  /** Stops the work, when it can be stopped. */
  cancel?(): void;
}

export interface NotificationPolicy {
  /**
   * Chooses one of a notice's buttons by its label (an extension's "Install" / "Not now"), or
   * nothing. Without this, a notice with buttons is closed unanswered, as when its × is clicked.
   */
  choose?(notice: HeadlessNotification): string | undefined;
}

/**
 * Notices kept instead of shown: `history` (newest first) and `unread` are the same signals the
 * window's bell reads, `onDidShow` tells each one as it comes, and `progress` lists work under
 * way. A notice with buttons is answered by the policy or closed at once, so whoever awaits the
 * answer never waits on a click that can't come.
 */
export class HeadlessNotifications implements NotificationService {
  readonly history: Signal<readonly HeadlessNotification[]> = signal<
    readonly HeadlessNotification[]
  >([]);
  readonly unread: Signal<number> = signal(0);
  /** Kept for the commands that toggle it; nothing is shown either way. */
  readonly doNotDisturb: Signal<boolean> = signal(false);
  private readonly work = signal<readonly HeadlessProgress[]>([]);
  /** Work under way (the window's progress toasts). */
  readonly activeProgress: ReadonlySignal<readonly HeadlessProgress[]> = this.work;
  private readonly shown = new Emitter<HeadlessNotification>();
  /** Every notice as it is recorded (a repeat of the newest comes again, with its count). */
  readonly onDidShow: Event<HeadlessNotification> = this.shown.event;
  private nextId = 1;

  constructor(private readonly policy: NotificationPolicy = {}) {}

  markRead(): void {
    this.unread.value = 0;
  }

  clearHistory(): void {
    this.history.value = [];
    this.unread.value = 0;
  }

  /** Nothing is showing, so there is nothing to dismiss. */
  dismissAll(): void {}

  show(kind: NotificationKind, message: string, options: NotificationOptions = {}): Disposable {
    const last = this.history.peek()[0];
    const actions = options.actions ?? [];
    const same =
      last && last.kind === kind && last.message === message && last.title === options.title;
    const record: HeadlessNotification = same
      ? { ...last, time: Date.now(), count: (last.count ?? 1) + 1 }
      : {
          id: this.nextId++,
          kind,
          message,
          ...(options.title && { title: options.title }),
          time: Date.now(),
          actions,
          choices: actions.map((a) => a.label),
        };
    const label = actions.length ? this.policy.choose?.(record) : undefined;
    const chosen = actions.find((a) => a.label === label);
    if (chosen) record.chosen = chosen.label;
    this.history.value = [record, ...this.history.peek().slice(same ? 1 : 0)].slice(0, MAX_HISTORY);
    this.unread.value = this.unread.peek() + 1;
    this.shown.fire(record);
    // After the caller has its disposable, as a click would come.
    queueMicrotask(() => {
      if (chosen) chosen.run();
      else options.onClose?.();
    });
    return toDisposable(() => {});
  }

  progress(
    message: string,
    options: { title?: string; onCancel?: () => void } = {},
  ): { update(message: string, percent?: number): void; close(): void } {
    const id = this.nextId++;
    const entry: HeadlessProgress = {
      id,
      message,
      ...(options.title && { title: options.title }),
      ...(options.onCancel && { cancel: options.onCancel }),
    };
    this.work.value = [...this.work.peek(), entry];
    return {
      update: (next, percent) => {
        this.work.value = this.work.peek().map((p) =>
          p.id === id
            ? {
                ...p,
                ...(next && { message: next }),
                ...(percent !== undefined && { percent: Math.max(0, Math.min(100, percent)) }),
              }
            : p,
        );
      },
      close: () => {
        this.work.value = this.work.peek().filter((p) => p.id !== id);
      },
    };
  }

  dispose(): void {
    this.shown.dispose();
  }
}

// ---- Quick input -----------------------------------------------------------------------------

/** A question the window would ask with its picker. */
export type QuickInputQuestion =
  | { kind: "pick"; placeholder: string; items: readonly QuickPickItem[] }
  | { kind: "prompt"; options: InputOptions };

export interface QuickInputPolicy {
  /**
   * The id of the item to choose, or undefined to close the list without choosing (Escape).
   * Without this, a list rejects: nobody can choose.
   */
  pick?(question: {
    placeholder: string;
    items: readonly QuickPickItem[];
  }): string | undefined | Promise<string | undefined>;
  /**
   * The text to enter, or undefined to close the box without entering anything. Without this, a
   * text box rejects.
   */
  prompt?(options: InputOptions): string | undefined | Promise<string | undefined>;
}

/**
 * Quick input with no picker. Each question goes to the policy; one the policy has no answer
 * for rejects with a NeedsScreenError that names the question, so a command that needs a choice
 * fails clearly instead of waiting forever. `asked` lists what was asked.
 */
export class HeadlessQuickInput implements QuickInputService {
  /** Never visible. */
  readonly visible: Signal<boolean> = signal(false);
  /** Every question so far, oldest first (what a caller would have had to answer). */
  readonly asked: QuickInputQuestion[] = [];

  constructor(private readonly policy: QuickInputPolicy = {}) {}

  async pick<T extends QuickPickItem>(
    items: readonly T[],
    options: PickOptions,
  ): Promise<T | undefined> {
    this.asked.push({ kind: "pick", placeholder: options.placeholder, items });
    if (!this.policy.pick)
      throw new NeedsScreenError(`Choosing from a list (“${options.placeholder}”)`);
    const id = await this.policy.pick({ placeholder: options.placeholder, items });
    if (id === undefined) return undefined;
    const item = items.find((i) => i.id === id);
    if (!item) throw new Error(`The answer “${id}” is not in the list “${options.placeholder}”.`);
    if (item.disabled) throw new Error(`“${id}” can't be chosen in “${options.placeholder}”.`);
    return item;
  }

  /** The list for the starting text (`value`, else empty), then as `pick`. */
  async pickDynamic<T extends QuickPickItem>(
    options: DynamicPickOptions<T>,
  ): Promise<T | undefined> {
    if (!this.policy.pick) {
      this.asked.push({ kind: "pick", placeholder: options.placeholder, items: [] });
      throw new NeedsScreenError(`Choosing from a list (“${options.placeholder}”)`);
    }
    const { items } = await options.load(options.value ?? "");
    return this.pick(items, { placeholder: options.placeholder });
  }

  async prompt(options: InputOptions): Promise<string | undefined> {
    this.asked.push({ kind: "prompt", options });
    if (!this.policy.prompt) throw new NeedsScreenError(`Entering text (“${options.prompt}”)`);
    const value = await this.policy.prompt(options);
    if (value === undefined) return undefined;
    const problem = options.validate?.(value);
    if (problem) throw new Error(`The answer to “${options.prompt}” was refused: ${problem}`);
    return value;
  }

  /**
   * A session an extension drives (its own quick pick or input box): it closes at once, as when
   * another one takes its place, which its owner sees as dismissed without an answer.
   */
  openSession(
    _kind: "pick" | "input",
    _initial: SessionProps,
    handlers: SessionHandlers,
  ): QuickInputSession {
    let hidden = false;
    const hide = (): void => {
      if (hidden) return;
      hidden = true;
      handlers.hide();
    };
    queueMicrotask(hide);
    return { update: () => {}, hide };
  }

  moveActive(): boolean {
    return false;
  }

  cancel(): void {}

  dispose(): void {}
}

// ---- Status bar ------------------------------------------------------------------------------

/** The status bar's items, held but not drawn (`ide://statusbar` and the hide commands read them). */
export class HeadlessStatusBar implements StatusBarService {
  readonly visible: Signal<boolean> = signal(true);
  readonly hidden: Signal<ReadonlySet<string>> = signal<ReadonlySet<string>>(new Set());
  private readonly itemList = signal<readonly StatusItem[]>([]);
  readonly items: ReadonlySignal<readonly StatusItem[]> = this.itemList;

  add(item: StatusItem): Disposable {
    this.itemList.value = [...this.itemList.peek(), item];
    return toDisposable(() => {
      this.itemList.value = this.itemList.peek().filter((i) => i !== item);
    });
  }

  dispose(): void {
    this.itemList.value = [];
  }
}

// ---- Theme -----------------------------------------------------------------------------------

/**
 * The look as settings give it (theme kind, density…), with no page to apply it to. Colors are a
 * page's to resolve: `token` gives the override set for a token or "", `color` gives null, and
 * readers already treat those as "not known yet".
 */
export class HeadlessTheme implements ThemeApi {
  readonly theme: Signal<ThemeKind> = signal<ThemeKind>("dark");
  readonly density: Signal<Density> = signal<Density>("default");
  readonly panels: Signal<PanelStyle> = signal<PanelStyle>("flush");
  readonly sideBar: Signal<SideBarColor> = signal<SideBarColor>("matching");
  readonly tabs: Signal<TabStyle> = signal<TabStyle>("rounded");
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private overrides: Record<string, string> = {};
  syntaxTheme: { name: string; json: unknown } | null = null;

  get preferences(): UiPreferences {
    return {
      theme: this.theme.peek(),
      density: this.density.peek(),
      panels: this.panels.peek(),
      sideBar: this.sideBar.peek(),
      tabs: this.tabs.peek(),
    };
  }

  apply(prefs: Partial<UiPreferences>): void {
    const before = JSON.stringify(this.preferences);
    if (prefs.theme && THEMES.includes(prefs.theme)) this.theme.value = prefs.theme;
    if (prefs.density && DENSITIES.includes(prefs.density)) this.density.value = prefs.density;
    if (prefs.panels && PANEL_STYLES.includes(prefs.panels)) this.panels.value = prefs.panels;
    if (prefs.sideBar && SIDE_BAR_COLORS.includes(prefs.sideBar))
      this.sideBar.value = prefs.sideBar;
    if (prefs.tabs && TAB_STYLES.includes(prefs.tabs)) this.tabs.value = prefs.tabs;
    if (JSON.stringify(this.preferences) !== before) this.changed.fire();
  }

  token(name: string): string {
    return this.overrides[name] ?? "";
  }

  color(): Rgba | null {
    return null;
  }

  setSyntaxTheme(theme: { name: string; json: unknown } | null): void {
    if (this.syntaxTheme?.name === theme?.name) return;
    this.syntaxTheme = theme;
    this.changed.fire();
  }

  setOverrides(tokens: Record<string, string>): void {
    if (JSON.stringify(tokens) === JSON.stringify(this.overrides)) return;
    this.overrides = { ...tokens };
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

// ---- What only a window has ------------------------------------------------------------------

/** No auxiliary windows: none to find, and making one is refused. */
export const noAuxWindows: AuxWindows = {
  labelOf: () => null,
  create: () => Promise.reject(new NeedsScreenError("Opening a window")),
  dispose: () => {},
};

/** No iframe layer: only a view calls this, and no view is ever made. */
export const noIframes: IframeHost = {
  attach: () => {
    throw new NeedsScreenError("Showing a page in a frame");
  },
  wake: () => {},
};

// ---- Trust -----------------------------------------------------------------------------------

type TrustAnswer = "trust" | "restrict" | "cancel";

/** How trust's questions are answered with nobody to ask. */
export interface TrustPolicy {
  /**
   * The open folder, when something from its files wants to run and nobody has decided about
   * it. Default "cancel": the thing doesn't run and no decision is remembered. "trust" and
   * "restrict" are remembered as if the user had answered.
   */
  folder?: TrustAnswer | ((request: TrustFolderRequest) => TrustAnswer);
  /** Folders joining a trusted workspace whose authors aren't decided about. Default "cancel". */
  addFolders?: TrustAnswer;
  /** Folders nobody picked (a changed workspace file, network folders). Default: not added. */
  confirmAdd?: boolean;
}

/** Trust's questions answered from a policy; with none, everything is declined. */
export function policyTrustPrompts(policy: TrustPolicy = {}): TrustPrompts {
  return {
    addFolders: async () => policy.addFolders ?? "cancel",
    confirmAdd: async () => policy.confirmAdd === true,
    folder: async (request) => {
      const answer = typeof policy.folder === "function" ? policy.folder(request) : policy.folder;
      return { answer: answer ?? "cancel", trustParent: false };
    },
  };
}

// ---- Saved state -----------------------------------------------------------------------------

/**
 * The keys of the global state that are the window's own: which folder the next start reopens,
 * the recent and pinned folders of its welcome page, the palette's recent commands, notices it
 * hid, its saved look. A session without a screen never changes them: opening a folder to work
 * in it is not the person opening it in the app. Every other key (trust decisions, the external
 * agents' remembered settings, hand-offs between agents…) is saved as the window saves it.
 */
export const WINDOW_GLOBAL_KEYS: readonly string[] = [
  "lastFolder",
  "recentFolders",
  "pinnedFolders",
  "recentCommands",
  "hiddenNotices",
  "hideImportLink",
  "ui",
];

/**
 * `json` (the global state about to be written) with the window's own keys as the stored file
 * has them (`stored`: its text, or null when there is none): kept when there, left out when not.
 */
export function keepWindowKeys(json: string, stored: string | null): string {
  let next: Record<string, unknown>;
  let before: Record<string, unknown> = {};
  try {
    next = JSON.parse(json) as Record<string, unknown>;
    if (stored) before = (JSON.parse(stored) as Record<string, unknown> | null) ?? {};
  } catch {
    return json;
  }
  if (!next || typeof next !== "object") return json;
  for (const key of WINDOW_GLOBAL_KEYS) {
    if (key in before) next[key] = before[key];
    else delete next[key];
  }
  return JSON.stringify(next);
}

// ---- The set ---------------------------------------------------------------------------------

type PermissionAnswer = "once" | "session" | "deny";

/** Who answers when nobody is at a screen. Everything left out is declined. */
export interface HeadlessPolicy {
  /** The confirmation before a destructive command a user-level caller runs. Default: declined. */
  confirm?(message: string, title: string): boolean | Promise<boolean>;
  /** An MCP client's request to run a command that changes something. Default: denied. */
  askMcp?(request: AuthorizeRequest & { client: string }): Promise<PermissionAnswer>;
  /**
   * An agent's request to run a command that changes something. Default: the handler the agent
   * extension sets (it asks in the session's conversation); denied while there is none.
   */
  askAgent?(request: AuthorizeRequest & { session: string }): Promise<PermissionAnswer>;
  /** Whether `caller: test` may run anything (a test script is running). Default: no. */
  testMode?(): boolean;
  quickInput?: QuickInputPolicy;
  notifications?: NotificationPolicy;
  trust?: TrustPolicy;
}

export interface ScreenlessOptions {
  /** The machine the backend is on (the only machine there is). */
  backendPlatform: Platform;
  policy?: HeadlessPolicy;
  /** Keeps one audit entry; default: dropped. */
  audit?(entry: AuditEntry): Promise<void> | void;
}

/** The screenless services by name, for the entry that wants to read them (they are also in the set). */
export interface ScreenlessParts {
  notifications: HeadlessNotifications;
  quickInput: HeadlessQuickInput;
  statusBar: HeadlessStatusBar;
  theme: HeadlessTheme;
  settings: SettingsService;
}

/**
 * The implementations createServices needs, for a session without a screen, and the screenless
 * services themselves. Nothing is cached for a first paint, no frame is waited for, and the
 * keyboard service is never attached to a window: it only holds the rules.
 */
export function screenlessImplementations(options: ScreenlessOptions): {
  implementations: ServiceImplementations;
  parts: ScreenlessParts;
  dispose(): void;
} {
  const policy = options.policy ?? {};
  const store = new DisposableStore();
  const notifications = store.add(new HeadlessNotifications(policy.notifications));
  const quickInput = store.add(new HeadlessQuickInput(policy.quickInput));
  const statusBar = store.add(new HeadlessStatusBar());
  const theme = store.add(new HeadlessTheme());
  const settings = store.add(new SettingsService());
  const noScreen = (what: string) => (): never => {
    throw new NeedsScreenError(what);
  };
  const implementations: ServiceImplementations = {
    // No screen: its platform is the backend's, so key labels read as on that machine.
    screenPlatform: options.backendPlatform,
    backendPlatform: options.backendPlatform,
    hasScreen: false,
    settings,
    theme,
    permissions: {
      confirm: async (message, title) => (await policy.confirm?.(message, title)) === true,
      askMcp: (request) => policy.askMcp?.(request) ?? Promise.resolve("deny"),
      askAgent: (request) => policy.askAgent?.(request) ?? askAgentPermission(request),
      testMode: () => policy.testMode?.() === true,
    },
    // The open workspace's saved state is read and never written: it holds the window's layout
    // (the dock's tabs, scroll positions), and this session's would replace it. What is shared
    // between sessions (trust, recent folders) is saved as the window saves it.
    stateBackend: {
      load: (scope) => storeIpc.load(scope),
      save: async (scope, json) => {
        if (scope === "workspace") return;
        await storeIpc.save(
          scope,
          scope === "global"
            ? keepWindowKeys(json, await storeIpc.load(scope).catch(() => null))
            : json,
        );
      },
    },
    audit: (entry) => options.audit?.(entry),
    validateOutput: __DEV__,
    notifications: () => notifications,
    modalDialogOpen: () => false,
    trustPrompts: policyTrustPrompts(policy.trust),
    nextFrame: null,
    screen: () => ({
      statusBar,
      quickInput,
      iframes: noIframes,
      auxWindows: noAuxWindows,
      dragFile: noScreen("Dragging a file"),
      dragViews: noScreen("Dragging a tab"),
      fileDropTarget: noScreen("A drop target"),
      tabDropTarget: noScreen("A drop target"),
    }),
  };
  return {
    implementations,
    parts: { notifications, quickInput, statusBar, theme, settings },
    dispose: () => store.dispose(),
  };
}
