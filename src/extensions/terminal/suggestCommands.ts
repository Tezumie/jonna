// Commands and data for the terminal's command suggestions (D204, suggestWidget.ts): Ctrl+Space
// opens them, Tab / Enter (after moving) accept, Up / Down move, Escape closes — keys bound while
// `terminalSuggestWidgetVisible` (and `terminalSuggestNavigated` for Enter), like VS Code's.

import { on } from "../../core/dom/index";
import { gitIpc } from "../../core/ipc/git";
import { ptyIpc } from "../../core/ipc/process";
import { appIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { parseShellGlobals, type ShellGlobal } from "./suggest";
import type { SuggestHost, TerminalSuggest } from "./suggestWidget";
import type { TerminalPane, TerminalView } from "./view";

/** PATH is listed by Rust (cached there too); asked again after this long. */
const COMMANDS_TTL = 60_000;
/** A shell's aliases and functions are asked for again after this long (an edited rc file). */
const GLOBALS_TTL = 5 * 60_000;

export function registerTerminalSuggest(
  sub: DisposableStore,
  services: WorkbenchServices,
  views: Map<string, TerminalPane>,
  tabs: Map<string, TerminalView>,
  history: () => readonly string[],
): () => SuggestHost {
  const { dispatcher, settings, context } = services;
  let commands: { at: number; names: Promise<readonly string[]> } | null = null;
  /** Per shell program: starting it to ask takes a moment, so once for every terminal of it. */
  const globals = new Map<string, { at: number; list: Promise<readonly ShellGlobal[]> }>();
  let home: string | null = null;
  void appIpc
    .info()
    .then((i) => (home = i.homeDir))
    .catch(() => {});

  const host: SuggestHost = {
    enabled: () => settings.peek<boolean>("terminal.suggest.enabled") !== false,
    commands: () => {
      if (!commands || Date.now() - commands.at > COMMANDS_TTL)
        commands = {
          at: Date.now(),
          names: ptyIpc.pathCommands().catch((): readonly string[] => []),
        };
      return commands.names;
    },
    globals: (t, family) => {
      const key = t.info.shell;
      const cached = globals.get(key);
      if (cached && Date.now() - cached.at < GLOBALS_TTL) return cached.list;
      const list = ptyIpc
        .shellGlobals(t.id)
        .then((text) => parseShellGlobals(text, family))
        .catch((): readonly ShellGlobal[] => []);
      globals.set(key, { at: Date.now(), list });
      return list;
    },
    history,
    branches: async () =>
      (await gitIpc.branches().catch(() => []))
        .filter((b) => !b.remote || !b.name.endsWith("/HEAD"))
        .map((b) => b.name),
    home: () => home,
    visibilityChanged: (widget, visible, navigated) => {
      if (visible) shown.set(widget, navigated);
      else shown.delete(widget);
      syncKeys();
    },
  };
  /**
   * Each terminal's widget state; the context keys follow the focused terminal's (D207: a widget
   * left open in one terminal doesn't take Up / Down / Tab from another).
   */
  const shown = new Map<TerminalSuggest, boolean>();
  const syncKeys = () => {
    const active = document.activeElement;
    const focused = [...views.values()].find((v) => v.element.contains(active));
    const widget = focused?.suggest;
    const navigated = widget ? shown.get(widget) : undefined;
    context.set("terminalSuggestWidgetVisible", navigated !== undefined);
    context.set("terminalSuggestNavigated", navigated === true);
  };
  sub.add(on(document, "focusin", syncKeys));
  sub.add({
    dispose: () => {
      shown.clear();
      context.set("terminalSuggestWidgetVisible", false);
      context.set("terminalSuggestNavigated", false);
    },
  });

  /** The focused terminal's suggestions, else the most recent terminal's. */
  const target = () => {
    const all = [...views.values()];
    const focused = all.find((v) => v.element.contains(document.activeElement));
    const recent = services.dock.recentTab((t) => t.viewType === "terminal");
    const view = focused ?? (recent ? tabs.get(recent.id)?.active : undefined);
    if (!view?.suggest)
      throw new Error(
        view?.instance && !view.instance.info.integration
          ? "Suggestions need shell integration (bash, zsh, fish, PowerShell)."
          : "No terminal with suggestions is open.",
      );
    return view;
  };
  const simple = (
    id: string,
    title: string,
    description: string,
    run: (v: TerminalPane) => unknown,
  ) =>
    sub.add(
      dispatcher.register({
        id,
        title,
        category: "Terminal",
        description,
        input: s.empty(),
        effects: [],
        agent: "hidden",
        palette: false,
        run: () => run(target()),
      }),
    );
  simple(
    "terminal.triggerSuggest",
    "Show suggestions",
    "Shows command suggestions for what's typed at the terminal's prompt (programs, files and folders, git subcommands and branches, history).",
    async (v) => {
      await v.suggest?.refresh(true);
      return v.suggest?.state();
    },
  );
  simple("terminal.acceptSuggestion", "Accept suggestion", "Types the selected suggestion.", (v) =>
    v.suggest?.accept(),
  );
  simple("terminal.hideSuggestWidget", "Hide suggestions", "Closes the suggestions.", (v) =>
    v.suggest?.hide(),
  );
  simple("terminal.selectNextSuggestion", "Next suggestion", "Selects the next suggestion.", (v) =>
    v.suggest?.move(1),
  );
  simple(
    "terminal.selectPreviousSuggestion",
    "Previous suggestion",
    "Selects the previous suggestion.",
    (v) => v.suggest?.move(-1),
  );
  // Turned off while open: close it everywhere.
  sub.add(
    settings.model.onDidChange((keys) => {
      if (keys.includes("terminal.suggest.enabled") && !host.enabled())
        for (const v of views.values()) v.suggest?.hide();
    }),
  );
  return () => host;
}
