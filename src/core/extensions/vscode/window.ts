// The `vscode` shim's `window` messages, pickers, status bar, output and progress (D256), on the
// IDE's `ide.ui`. Editors are editors.ts; tree views, webviews and terminals views.ts.
// DOM-free and unit-tested.

import type { StatusBarItemOptions, WorkerApi } from "../rpc";
import { extensionChannelId } from "../rpcOutput";
import type { ShimCommands } from "./commands";
import { markdownOf, pathOf } from "./convert";
import type { Command } from "./languageTypes";
import {
  createInputBox as createSessionInput,
  createQuickPick as createSessionPick,
  type QuickPickItem,
  type ShowInputBoxOptions,
  type ShowQuickPickOptions,
  showInputBox as showSessionInput,
  showQuickPick as showSessionPick,
} from "./quickInput";
import { createTabGroups } from "./tabGroups";
import {
  type CancellationToken,
  CancellationTokenSource,
  ColorThemeKind,
  Disposable,
  EventEmitter,
  LogLevel,
  NONE_TOKEN,
  ProgressLocation,
  StatusBarAlignment,
  Uri,
} from "./types";

type MessageItem = string | { title: string; isCloseAffordance?: boolean };

/**
 * A status bar item's colors as the IDE shows them: VS Code lets extensions use only the warning
 * and error backgrounds; a foreground ThemeColor that means a warning or an error tints the text.
 */
export function statusTone(color: unknown, background: unknown): StatusBarItemOptions["tone"] {
  const id = (v: unknown) =>
    v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string"
      ? (v as { id: string }).id
      : "";
  const bg = id(background);
  if (bg === "statusBarItem.errorBackground") return "error";
  if (bg === "statusBarItem.warningBackground") return "warning";
  const fg = id(color).toLowerCase();
  if (/error/.test(fg)) return "error-text";
  if (/warning/.test(fg)) return "warning-text";
  return undefined;
}

export function createWindow(
  ide: WorkerApi,
  commands: ShimCommands,
  appName: string,
  unsupported: (name: string) => void,
  /**
   * The extension is being stopped (D386): its messages go to its log, not the window. VS Code
   * drops them, since its host is going away; Live Server's dispose() says "Server is not
   * already running" each time it's stopped.
   */
  stopping: { active(): boolean; log(text: string): void } = {
    active: () => false,
    log: () => {},
  },
) {
  // The theme's kind (VS Code's ColorTheme), kept as the IDE reports changes.
  const themeOf = (kind: unknown) => ({
    kind: kind === "light" ? ColorThemeKind.Light : ColorThemeKind.Dark,
  });
  let colorTheme = themeOf(ide.env.themeKind);
  const colorThemeChanged = new EventEmitter<{ readonly kind: ColorThemeKind }>();
  ide.events.on("theme.didChange", (p) => {
    const next = themeOf((p as { kind?: unknown } | null)?.kind);
    if (next.kind === colorTheme.kind) return;
    colorTheme = next;
    colorThemeChanged.fire(colorTheme);
  });
  const message =
    (kind: "info" | "warning" | "error") =>
    async (text: string, ...rest: unknown[]): Promise<MessageItem | undefined> => {
      if (stopping.active()) {
        stopping.log(`(while stopping, not shown) ${kind}: ${text}`);
        return undefined;
      }
      const options =
        rest[0] && typeof rest[0] === "object" && !("title" in (rest[0] as object))
          ? (rest.shift() as { modal?: boolean; detail?: string })
          : {};
      const items = rest.filter(
        (i): i is MessageItem => typeof i === "string" || (!!i && typeof i === "object"),
      );
      const titleOf = (i: MessageItem) => (typeof i === "string" ? i : i.title);
      if (options.modal) {
        const cancel = items.find((i) => typeof i === "object" && i.isCloseAffordance);
        const actions = items.filter((i) => i !== cancel).slice(0, 4);
        const chosen = await ide.ui.showDialog({
          title: appName,
          message: options.detail ? `${text}\n\n${options.detail}` : text,
          // The first action is the default (primary) one, as in VS Code's modal dialogs.
          actions: actions.map((i, n) => ({
            label: titleOf(i),
            ...(n === 0 && { variant: "primary" as const }),
          })),
          ...(cancel && { cancel: titleOf(cancel) }),
        });
        return chosen === undefined ? cancel : items.find((i) => titleOf(i) === chosen);
      }
      const chosen = await ide.ui.notify(text, {
        kind,
        ...(items.length && { actions: items.map(titleOf) }),
      });
      return chosen === undefined ? undefined : items.find((i) => titleOf(i) === chosen);
    };

  // Live sessions (quickInput.ts): VS Code's QuickPick and InputBox, and the show* functions on
  // top of them.
  const showQuickPick = (
    itemsOrPromise:
      | readonly (string | QuickPickItem)[]
      | PromiseLike<readonly (string | QuickPickItem)[]>,
    options?: ShowQuickPickOptions,
    token?: CancellationToken,
  ): Promise<unknown> => showSessionPick(ide, itemsOrPromise, options ?? {}, token);
  const showInputBox = (
    options?: ShowInputBoxOptions,
    token?: CancellationToken,
  ): Promise<string | undefined> => showSessionInput(ide, options ?? {}, token);
  const createQuickPick = () => createSessionPick(ide);
  const createInputBox = () => createSessionInput(ide);

  let statusItems = 0;
  const createStatusBarItem = (
    idOrAlignment?: string | StatusBarAlignment,
    alignmentOrPriority?: StatusBarAlignment | number,
    priorityArg?: number,
  ) => {
    const id = typeof idOrAlignment === "string" ? idOrAlignment : `item${++statusItems}`;
    const alignment = typeof idOrAlignment === "string" ? alignmentOrPriority : idOrAlignment;
    const priority = typeof idOrAlignment === "string" ? priorityArg : alignmentOrPriority;
    let shown: ReturnType<WorkerApi["ui"]["createStatusBarItem"]> | undefined;
    const state = {
      text: "",
      tooltip: undefined as unknown,
      command: undefined as string | Command | undefined,
      name: undefined as string | undefined,
      color: undefined as unknown,
      backgroundColor: undefined as unknown,
      accessibilityInformation: undefined as unknown,
    };
    const options = () => {
      const tooltip = markdownOf(state.tooltip);
      const command = commands.ref(state.command);
      const tone = statusTone(state.color, state.backgroundColor);
      return {
        text: state.text,
        ...(tooltip && { tooltip }),
        ...(command && {
          command: command.command,
          ...(command.input !== undefined && { input: command.input }),
        }),
        alignment: alignment === StatusBarAlignment.Right ? ("right" as const) : ("left" as const),
        ...(typeof priority === "number" && { priority }),
        ...(typeof state.name === "string" && state.name && { name: state.name }),
        ...(tone && { tone }),
      };
    };
    const update = () => {
      if (shown) void shown.update(options()).catch(() => {});
    };
    const item = {
      id,
      alignment: alignment ?? StatusBarAlignment.Left,
      priority,
      show: () => {
        if (shown) return update();
        try {
          shown = ide.ui.createStatusBarItem({ id, ...options() });
        } catch (err) {
          unsupported(`StatusBarItem (${err instanceof Error ? err.message : String(err)})`);
        }
      },
      hide: () => {
        shown?.dispose();
        shown = undefined;
      },
      dispose: () => item.hide(),
    };
    for (const key of Object.keys(state) as (keyof typeof state)[])
      Object.defineProperty(item, key, {
        enumerable: true,
        get: () => state[key],
        set: (v: never) => {
          state[key] = v;
          update();
        },
      });
    return item as typeof item & typeof state;
  };

  /**
   * Log levels the user picked ("Set log level…", VS Code's Developer: Set Log Level): the default
   * (env.logLevel) and log channels' own, by channel id. Lines below a channel's level aren't
   * written; a change fires its onDidChangeLogLevel (and env.onDidChangeLogLevel for the default).
   */
  const levels = {
    default: LogLevel.Info as LogLevel,
    channels: {} as Record<string, number>,
  };
  const onDidChangeDefaultLogLevel = new EventEmitter<LogLevel>();
  /** Each log channel's level now, and how to tell it about a change. */
  const logChannels = new Set<{ id: string; level: LogLevel; changed: EventEmitter<LogLevel> }>();
  const levelOfChannel = (id: string): LogLevel => {
    const own = levels.channels[id];
    return (typeof own === "number" && own >= 0 && own <= 5 ? own : levels.default) as LogLevel;
  };
  let watchingLevels = false;
  const watchLevels = () => {
    if (watchingLevels) return;
    watchingLevels = true;
    ide.ui.logLevels((next) => {
      const previous = levels.default;
      levels.default = (
        typeof next.default === "number" && next.default >= 0 && next.default <= 5
          ? next.default
          : LogLevel.Info
      ) as LogLevel;
      levels.channels = next.channels && typeof next.channels === "object" ? next.channels : {};
      if (levels.default !== previous) onDidChangeDefaultLogLevel.fire(levels.default);
      for (const c of logChannels) {
        const now = levelOfChannel(c.id);
        if (now === c.level) continue;
        c.level = now;
        c.changed.fire(now);
      }
    });
  };
  const createOutputChannel = (name: string, options?: string | { log: true }) => {
    const isLog = typeof options === "object" && options?.log === true;
    const channel = ide.ui.createOutputChannel(name, isLog ? { log: true } : undefined);
    if (isLog) watchLevels();
    // The Output tab's id for it (the levels' key).
    const state = {
      id: extensionChannelId(ide.extension.id, String(name ?? "").trim()),
      level: LogLevel.Info as LogLevel,
      changed: new EventEmitter<LogLevel>(),
    };
    state.level = levelOfChannel(state.id);
    const above = (level: LogLevel) => state.level !== LogLevel.Off && level >= state.level;
    const base = {
      name,
      append: (v: string) => channel.append(v),
      appendLine: (v: string) => channel.appendLine(v),
      replace: (v: string) => channel.replace(v),
      clear: () => channel.clear(),
      show: (a?: unknown, b?: boolean) => channel.show(typeof a === "boolean" ? a : b),
      hide: () => channel.hide(),
      dispose: () => {
        logChannels.delete(state);
        channel.dispose();
      },
    };
    if (!isLog) return base;
    logChannels.add(state);
    return Object.defineProperties(
      {
        ...base,
        onDidChangeLogLevel: state.changed.event,
        trace: (m: string, ...a: unknown[]) => {
          if (above(LogLevel.Trace)) channel.trace(m, ...a);
        },
        debug: (m: string, ...a: unknown[]) => {
          if (above(LogLevel.Debug)) channel.debug(m, ...a);
        },
        info: (m: string, ...a: unknown[]) => {
          if (above(LogLevel.Info)) channel.info(m, ...a);
        },
        warn: (m: string, ...a: unknown[]) => {
          if (above(LogLevel.Warning)) channel.warn(m, ...a);
        },
        error: (m: string | Error, ...a: unknown[]) => {
          if (above(LogLevel.Error)) channel.error(m, ...a);
        },
      },
      { logLevel: { enumerable: true, get: () => state.level } },
    ) as unknown as typeof base & { readonly logLevel: LogLevel };
  };

  const withProgress = <R>(
    options: {
      location: ProgressLocation | { viewId: string };
      title?: string;
      cancellable?: boolean;
    },
    task: (
      progress: { report(value: { message?: string; increment?: number }): void },
      token: CancellationToken,
    ) => Promise<R> | R,
  ): Promise<R> =>
    ide.ui.withProgress(
      {
        location: options.location === ProgressLocation.Notification ? "notification" : "window",
        ...(options.title && { title: options.title }),
        ...(options.cancellable && { cancellable: true }),
      },
      (progress, ideToken) => {
        const source = new CancellationTokenSource();
        if (ideToken.isCancellationRequested) source.cancel();
        ideToken.onCancellationRequested(() => source.cancel());
        return task(progress, source.token);
      },
    );

  return {
    showInformationMessage: message("info"),
    showWarningMessage: message("warning"),
    showErrorMessage: message("error"),
    showQuickPick,
    showInputBox,
    createQuickPick,
    createInputBox,
    createStatusBarItem,
    createOutputChannel,
    /** env.logLevel and env.onDidChangeLogLevel: the default log level the user picked. */
    logLevel: {
      get value(): LogLevel {
        watchLevels();
        return levels.default;
      },
      onDidChange: (
        listener: (level: LogLevel) => unknown,
        thisArg?: unknown,
        disposables?: { dispose(): unknown }[],
      ) => {
        watchLevels();
        return onDidChangeDefaultLogLevel.event(listener, thisArg, disposables);
      },
    },
    withProgress,
    /** VS Code's setStatusBarMessage: a status bar item for a while (or until disposed). */
    setStatusBarMessage: (text: string, hideAfter?: number | Promise<unknown>) => {
      const item = createStatusBarItem(StatusBarAlignment.Left, -1000);
      item.text = text;
      item.show();
      if (typeof hideAfter === "number") setTimeout(() => item.dispose(), hideAfter);
      else void hideAfter?.finally(() => item.dispose());
      return new Disposable(() => item.dispose());
    },
    showWorkspaceFolderPick: async () => {
      const folders = await ide.workspace.folders();
      const picked = await ide.ui.showQuickPick(
        folders.map((f) => ({ label: f.name, description: f.path })),
        { placeholder: "Pick a workspace folder" },
      );
      const f = picked ? folders.find((x) => x.path === picked.description) : undefined;
      // VS Code's WorkspaceFolder (D261: `folder.uri.fsPath` threw on the IDE's shape).
      return f ? { uri: Uri.file(f.path), name: f.name, index: f.index } : undefined;
    },
    showOpenDialog: async (
      options: {
        canSelectFiles?: boolean;
        canSelectFolders?: boolean;
        canSelectMany?: boolean;
        defaultUri?: Uri;
        filters?: Record<string, string[]>;
        title?: string;
        openLabel?: string;
      } = {},
    ) => {
      const paths = await ide.ui.showOpenDialog({
        ...((options.title ?? options.openLabel) && { title: options.title ?? options.openLabel }),
        ...(options.defaultUri && { defaultPath: pathOf(options.defaultUri) }),
        folders: !!options.canSelectFolders && !options.canSelectFiles,
        many: !!options.canSelectMany,
        ...(options.filters && {
          filters: Object.entries(options.filters).map(([name, extensions]) => ({
            name,
            extensions,
          })),
        }),
      });
      return paths?.map((p) => Uri.file(p));
    },
    showSaveDialog: async (
      options: { defaultUri?: Uri; title?: string; saveLabel?: string } = {},
    ) => {
      const path = await ide.ui.showSaveDialog({
        ...((options.title ?? options.saveLabel) && { title: options.title ?? options.saveLabel }),
        ...(options.defaultUri && { defaultPath: pathOf(options.defaultUri) }),
      });
      return path ? Uri.file(path) : undefined;
    },
    registerUriHandler: (handler: { handleUri(uri: unknown): unknown }) => {
      const d = ide.ui.registerUriHandler(
        handler as Parameters<WorkerApi["ui"]["registerUriHandler"]>[0],
      );
      return new Disposable(() => d.dispose());
    },
    /** Explorer badges (D258): VS Code's FileDecoration as the IDE's. */
    registerFileDecorationProvider: (provider: {
      provideFileDecoration(uri: Uri, token: unknown): unknown;
      onDidChangeFileDecorations?: (listener: (e: Uri | Uri[] | undefined) => void) => {
        dispose(): unknown;
      };
    }) => {
      const handle = ide.ui.registerFileDecorationProvider({
        provideFileDecoration: async (path) => {
          const d = (await provider.provideFileDecoration(Uri.file(path), NONE_TOKEN)) as
            | { badge?: string; tooltip?: string; color?: { id?: string } }
            | undefined;
          if (!d) return null;
          return {
            ...(d.badge && { badge: d.badge }),
            ...(d.tooltip && { tooltip: d.tooltip }),
            ...(d.color?.id && { color: d.color.id }),
          };
        },
      });
      const sub = provider.onDidChangeFileDecorations?.((e) =>
        handle.fireDidChange(
          e === undefined ? undefined : (Array.isArray(e) ? e : [e]).map((u) => pathOf(u)),
        ),
      );
      return new Disposable(() => {
        sub?.dispose();
        handle.dispose();
      });
    },
    // Links in terminal lines (D264): the extension's own link objects come back on a click.
    registerTerminalLinkProvider: (provider: {
      provideTerminalLinks(
        context: { line: string; terminal: { name: string } },
        token: unknown,
      ): unknown;
      handleTerminalLink(link: unknown): unknown;
    }) => {
      const handle = ide.terminals.registerLinkProvider({
        provideTerminalLinks: async (context) => {
          const links = await provider.provideTerminalLinks(context, NONE_TOKEN);
          return Array.isArray(links) ? links : [];
        },
        handleTerminalLink: (link) => provider.handleTerminalLink(link),
      });
      return new Disposable(() => handle.dispose());
    },
    state: { focused: true, active: true },
    onDidChangeWindowState: new EventEmitter<unknown>().event,
    // The IDE's theme is light or dark (an imported high-contrast theme is one of them).
    get activeColorTheme(): { readonly kind: ColorThemeKind } {
      return colorTheme;
    },
    onDidChangeActiveColorTheme: colorThemeChanged.event,
    tabGroups: createTabGroups(ide).tabGroups,
  };
}
