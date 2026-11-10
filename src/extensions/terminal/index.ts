// Built-in Terminal: the "terminal" dock view (one shell per tab), `terminal.*` commands and
// `ide://terminals`. Shell integration (OSC 133) arrives in Milestone 2.
import type { BuiltinExtension } from "../../core/extensions/index";
import { dragDropIpc, fsIpc } from "../../core/ipc/fs";
import { ptyIpc } from "../../core/ipc/process";
import { appIpc, clipboardIpc, wslIpc } from "../../core/ipc/system";
import { isAbsolute, resolveInRoot, samePath } from "../../core/paths/index";
import { parseWslPath } from "../../core/paths/wsl";
import { s } from "../../core/schema/index";
import { confirmAction } from "../../ui/Dialog";
import type { OpenPlacement } from "../../workbench/dock/service";
import { terminalEnvVars } from "../../workbench/extensionFeatures";
import type { WorkbenchServices } from "../../workbench/services";
import { chooseFolder, editorFolder } from "../tasks/chooseFolder";
import { typedText } from "./commandLine";
import { registerTerminalCommands } from "./commands";
import manifest from "./extension.json";
import { expandHomePath, wslPathToWindows } from "./features";
import { registerHiddenTerminals } from "./hiddenCommands";
import { registerSessionOutputs } from "./outputs";
import { TerminalPane } from "./pane";
import { registerTerminalProfiles } from "./profileCommands";
import { quotePathForShell } from "./profiles";
import type { GpuAcceleration } from "./renderer";
import { stripAnsi } from "./servers";
import { TerminalService, terminalThemeFromTokens } from "./service";
import { splitDirectionOf } from "./split";
import { registerSplitCommands } from "./splitCommands";
import { registerTerminalSuggest } from "./suggestCommands";
import { registerTaskTerminals } from "./taskTerminals";
import { type TerminalView, type TerminalViewHost, terminalViewDescriptor } from "./view";

export const terminalExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, workspace, state, context, dock, theme, settings } = services;
    // Revival off: the last page's terminals (a reload) end now rather than after the grace
    // period, so a dev server among them frees its port at once (D203, D233 audit).
    if (settings.peek<boolean>("terminal.enablePersistentSessions") === false)
      void ptyIpc.killDetached().catch(() => {});
    const terminals = sub.add(new TerminalService());
    // Keys for the program in the focused terminal (D192): while something runs there (Claude
    // Code, nano, tmux, vim), Ctrl+<letter> and Ctrl+\ [ ] reach it instead of the IDE's bindings
    // (Ctrl+K chords, Ctrl+B, Ctrl+J, Ctrl+P…); at the prompt the IDE's keys work as usual.
    // terminal.sendKeybindingsToShell (VS Code's name) gives them to the shell at the prompt too.
    // Ctrl+P (quick open) stays with the IDE, as in VS Code's commandsToSkipShell.
    const SHELL_KEY = /^ctrl\+([a-oq-z]|\\|\[|\]|;|\/)$/;
    sub.add(
      services.keyboard.setShellKeys((chord) => {
        if (context.get("terminalFocus") !== true || !SHELL_KEY.test(chord)) return false;
        const focused = terminals.instances
          .peek()
          .find((t) => t.element.contains(document.activeElement));
        if (!focused) return false;
        return focused.busy() || settings.peek<boolean>("terminal.sendKeybindingsToShell") === true;
      }),
    );
    // Links: local dev servers open in the IDE's browser (beside the terminal), other addresses
    // outside; file paths open in the editor at their line.
    const isLocalUrl = (url: string) =>
      /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|[\w-]+\.localhost)(:\d+)?(\/|$)/i.test(
        url,
      );
    // Commands run in any terminal, oldest first, without repeats (Run recent command); kept
    // per workspace like the rest of its state.
    const HISTORY_LIMIT = 200;
    let history: string[] = [];
    const remember = (command: string) => {
      const line = command.trim();
      if (!line || line.length > 2000 || line.includes("\n")) return;
      history = [...history.filter((c) => c !== line), line].slice(-HISTORY_LIMIT);
      services.persistence.scheduleSave();
    };
    sub.add(
      services.persistence.register("terminal.history", {
        save: () => history,
        restore: (data) => {
          history = Array.isArray(data)
            ? data.filter((c): c is string => typeof c === "string").slice(-HISTORY_LIMIT)
            : [];
        },
      }),
    );
    /** The user's home folder (`~/` links), asked for once. */
    let homeDir: Promise<string | null> | null = null;
    const userHome = () =>
      (homeDir ??= appIpc
        .info()
        .then((i) => i.homeDir)
        .catch(() => null));
    /** A WSL distribution's home folder as a Windows path, asked for once per distribution. */
    const wslHomes = new Map<string, Promise<string | null>>();
    const wslHome = (distro: string) => {
      let home = wslHomes.get(distro);
      if (!home) {
        home = wslIpc.home(distro).catch(() => null);
        wslHomes.set(distro, home);
      }
      return home;
    };
    const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|[\w-]+\.localhost)$/i;
    /** Same server: same port, and the same host (any loopback name counts as one). */
    const sameServer = (a: string, b: string): boolean => {
      try {
        const x = new URL(a);
        const y = new URL(b);
        const port = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");
        if (port(x) !== port(y)) return false;
        return (
          x.hostname === y.hostname || (LOOPBACK.test(x.hostname) && LOOPBACK.test(y.hostname))
        );
      } catch {
        return false;
      }
    };
    /** Browser tabs showing a page of the server at `url` (ide://browser). */
    const browserTabsOn = async (url: string): Promise<{ tab: string; connected: boolean }[]> => {
      const snap = await state.get("ide://browser").catch(() => null);
      const tabs = Array.isArray(snap?.value) ? (snap.value as Record<string, unknown>[]) : [];
      return tabs
        .filter((t) => typeof t.url === "string" && sameServer(t.url, url))
        .map((t) => ({ tab: String(t.tab ?? ""), connected: t.connected === true }));
    };
    terminals.hooks = {
      extensionEnv: () => terminalEnvVars(services.extensionFeatures.terminalEnv.peek()),
      // Extensions' terminal link providers, together (D264).
      extensionLinks: async (line, name) => {
        const providers = services.extensionFeatures.terminalLinks.all.peek();
        if (!providers.length || !line.trim()) return [];
        const all = await Promise.all(
          providers.map((p) => p.provide(line, { name }).catch(() => [])),
        );
        return all.flat();
      },
      // A long command finishing while you're in another window: say so (VS Code and iTerm do).
      commandFinished: (terminal, command, exitCode, ms) => {
        if (command) remember(command);
        const after = settings.peek<number>("terminal.notifyAfterSeconds") ?? 30;
        if (!after || ms < after * 1000) return;
        if (document.visibilityState !== "hidden" && document.hasFocus()) return;
        const took =
          ms < 60_000
            ? `${Math.round(ms / 1000)} s`
            : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
        const failed = exitCode !== undefined && exitCode !== 0;
        services.notifications.show(
          failed ? "error" : "success",
          `${command ? `\`${command.length > 60 ? `${command.slice(0, 57)}…` : command}\`` : "A command"} ${failed ? `failed (exit ${exitCode})` : "finished"} after ${took}.`,
          {
            title: "Terminal",
            actions: [
              {
                label: "Show",
                run: () =>
                  void dispatcher.execute("terminal.focus", { id: terminal }).catch(() => {}),
              },
            ],
          },
        );
      },
      isMac: services.platform === "mac",
      isLocalUrl,
      openUrl: (url) => {
        const local = isLocalUrl(url) && dispatcher.has("browser.open");
        void dispatcher
          .execute(local ? "browser.open" : "ui.openLink", local ? { url, largest: true } : { url })
          .catch(() => {});
      },
      resolveFile: async (path, cwd) => {
        const root = workspace.root.peek() ?? "";
        // `~/…` (and `~\…` on Windows) is the user's home folder, as the shell read it; in a
        // WSL terminal it's the distribution's, and `/…` is a Linux path there (D229).
        const wsl = services.platform === "windows" ? parseWslPath(cwd || root) : null;
        const home = !path.startsWith("~")
          ? null
          : wsl
            ? await wslHome(wsl.distro)
            : await userHome();
        const expanded = wsl
          ? wslPathToWindows(path, wsl.distro, home)
          : expandHomePath(path, home, services.platform === "windows");
        if (expanded.startsWith("~")) return null;
        const abs = isAbsolute(expanded) ? expanded : resolveInRoot(cwd || root, expanded);
        // Home is usually outside the folder, where the file scope can't look before a click:
        // a `~/` path is a link as it is, and the click lets that one file in (openFile).
        if (home && !workspace.contains(abs)) return abs;
        const isFile = async (p: string) =>
          (await fsIpc.stat(p).catch(() => null))?.kind === "file";
        if (await isFile(abs)) return abs;
        // Not under the terminal's cwd: a path relative to the workspace ("api/src/x.ts" names a
        // folder of a multi-root workspace, D251).
        if (isAbsolute(expanded) || home || !cwd) return null;
        const inWorkspace = workspace.resolve(expanded);
        return !samePath(inWorkspace, abs) && (await isFile(inWorkspace)) ? inWorkspace : null;
      },
      openFile: (path, line, col) =>
        void (async () => {
          // The user's click on a file outside the workspace (a `~/` link): that file only. A
          // file in any of the workspace's folders is in scope already (D251).
          if (!workspace.contains(path)) await fsIpc.allowFile(path);
          await dispatcher.execute("editor.openFile", {
            path,
            ...(line && { line }),
            ...(col && { column: col }),
          });
        })().catch((err: unknown) =>
          services.notifications.show(
            "warning",
            `Couldn't open ${path}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        ),
      clipboard: {
        isMac: services.platform === "mac",
        isWindows: services.platform === "windows",
        read: () => clipboardIpc.readText().catch(() => ""),
        write: (text) => clipboardIpc.writeText(text).catch(() => {}),
        copyOnSelection: () => settings.peek<boolean>("terminal.copyOnSelection") === true,
        // Several lines into a program that didn't ask for bracketed paste would run each one.
        confirmPaste: (text) =>
          settings.peek<boolean>("terminal.multiLinePasteWarning") === false
            ? Promise.resolve(true)
            : confirmAction(
                "Paste several lines?",
                `The text has ${text.split(/\r\n|\r|\n/).length} lines; each one may run as a command.`,
                "Paste",
              ),
      },
      syntaxColors: () =>
        settings.peek<boolean>("terminal.highlightCommands") === false
          ? null
          : {
              program: theme.token("--syntax-function") || "",
              flag: theme.token("--syntax-keyword") || "",
              string: theme.token("--syntax-string") || "",
              variable: theme.token("--syntax-variable") || "",
              path: theme.token("--syntax-path") || "",
              operator: theme.token("--syntax-operator") || "",
              number: theme.token("--syntax-number") || "",
            },
    };
    const look = () => ({
      fontFamily:
        settings.peek<string>("terminal.fontFamily")?.trim() ||
        theme.token("--font-mono") ||
        "monospace",
      cursorStyle: settings.peek<"block" | "bar" | "underline">("terminal.cursorStyle") ?? "block",
      cursorBlink: settings.peek<boolean>("terminal.cursorBlinking") !== false,
      scrollback: settings.peek<number>("terminal.scrollback") ?? 10000,
      lineHeight: settings.peek<number>("terminal.lineHeight") ?? 1.25,
      minimumContrastRatio: settings.peek<number>("terminal.minimumContrastRatio") ?? 4.5, // VS Code's default
    });
    /** Every terminal (a pane of a tab, D209) by its uid, and every terminal tab by tab id. */
    const views = new Map<string, TerminalPane>();
    const tabs = new Map<string, TerminalView>();
    const gpuAcceleration = (): GpuAcceleration => {
      const v = settings.peek<string>("terminal.gpuAcceleration");
      return v === "on" || v === "off" ? v : "auto";
    };
    // Hidden terminals' screens are saved too (they come back hidden, m7.12); `hiddenTerminals`
    // is set below, before anything saves.
    const outputs = registerSessionOutputs(sub, services, terminals, tabs, () =>
      hiddenTerminals.panesForSave(),
    );
    const suggestHost = registerTerminalSuggest(sub, services, views, tabs, () => history);
    /**
     * Where a new terminal starts without a cwd (D251): the editor's folder in a multi-root
     * workspace (VS Code asks; agents shouldn't be blocked: terminal.createInFolder asks), else
     * the first folder.
     */
    const newTerminalCwd = () =>
      (workspace.folders.peek().length > 1 ? editorFolder(services) : undefined) ??
      workspace.root.peek();
    // Opens a terminal tab (next to the most recent terminal, else at the bottom) and waits for
    // its shell; `profile` names a terminal profile (null: the default one). A relative `cwd` is
    // the workspace's (`workspace.resolve`: "api/src" names a folder of a multi-root one).
    const createTerminal = async (
      cwd: string | undefined,
      focus: boolean,
      profile: string | null = null,
    ) => {
      const root = workspace.root.peek();
      const dir = cwd && root ? workspace.resolve(cwd) : cwd || newTerminalCwd();
      const near = recentTerminalTab();
      const group = near ? dock.findTab(near.id)?.group : undefined;
      const placement: OpenPlacement = group && !group.hidden ? { groupId: group.id } : "bottom";
      const state = { ...(dir && { cwd: dir }), ...(profile && { profile }) };
      const tabId = dock.openView(
        "terminal",
        Object.keys(state).length ? state : null,
        placement,
        focus,
      );
      const ref = dock.findTab(tabId);
      const tab = ref?.group.tabs[ref.index];
      const view = tab ? (dock.view(tab) as TerminalView | undefined) : undefined;
      if (!view) throw new Error("Terminal view unavailable");
      const t = await view.ready;
      if (focus) requestAnimationFrame(() => t.renderer.focus());
      return { tabId, t };
    };
    // Hidden terminals (D217): tabs out of the dock with their shells still running.
    const hiddenTerminals = registerHiddenTerminals(sub, services, {
      tabs,
      paneOf: (id) => tabOf(id),
      defaultPane: () =>
        [...views.values()].find((v) => v.element.contains(document.activeElement)) ?? recentPane(),
      createPane: (state, owner, restoreKey) => new TerminalPane(state, owner, host, restoreKey),
    });
    const profiles = registerTerminalProfiles(sub, services, {
      createTerminal,
      hiddenMenu: () => hiddenTerminals.menu(),
    });
    const host: TerminalViewHost = {
      tabDropTarget: (element, accepts, drop) => services.tabDropTarget(element, accepts, drop),
      startFor: async (restoreKey, profile, reattach) => {
        const [start, saved] = await Promise.all([
          profiles.start(profile).catch(() => ({})),
          outputs.take(restoreKey).catch(() => undefined),
        ]);
        return {
          ...start,
          ...(saved && { restored: saved.banner, restoredFrom: saved.saved }),
          // After a page reload: the same process, its screen drawn as it was (m7.12). Off with
          // terminal.enablePersistentSessions, as VS Code's revival is (Rust ends it in a minute).
          ...(reattach &&
            settings.peek<boolean>("terminal.enablePersistentSessions") !== false && {
              reattach: {
                ...reattach,
                ...(saved?.offset !== undefined && { since: saved.offset, snapshot: saved.text }),
              },
            }),
        };
      },
      suggestHost,
      terminals,
      context,
      views,
      tabs,
      defaultCwd: newTerminalCwd,
      bellMode: () => settings.peek<"none" | "visual" | "sound">("terminal.bell") ?? "none",
      shellIntegration: () => settings.peek<boolean>("terminal.shellIntegration.enabled") !== false,
      splitDirection: () => splitDirectionOf(settings.peek<unknown>("terminal.splitDirection")),
      run: (command, input = {}) => void dispatcher.execute(command, input).catch(() => {}),
      keybinding: (command) => services.keyboard.labelFor(command),
      canFix: () =>
        dispatcher.has("agent.send") && settings.peek<boolean>("terminal.fixWithAgent") !== false,
      isMac: services.platform === "mac",
      rightClickBehavior: () =>
        settings.peek<string>("terminal.rightClickBehavior") === "copyPaste" ? "copyPaste" : "menu",
      appearance: () => ({
        theme: terminalThemeFromTokens(theme),
        fontSize: settings.peek<number>("terminal.fontSize") ?? 13,
        scrollbarSize: settings.peek<number>("terminal.scrollbarSize") ?? 12,
        gpuAcceleration: gpuAcceleration(),
        ...look(),
      }),
    };
    sub.add(dock.views.register(terminalViewDescriptor(host)));
    sub.add(theme.onDidChange(() => terminals.setTheme(terminalThemeFromTokens(theme))));
    sub.add(
      settings.model.onDidChange((keys) => {
        if (keys.includes("terminal.fontSize"))
          terminals.setFontSize(settings.peek<number>("terminal.fontSize") ?? 13);
        if (keys.includes("terminal.scrollbarSize"))
          terminals.setScrollbarSize(settings.peek<number>("terminal.scrollbarSize") ?? 12);
        if (keys.includes("terminal.gpuAcceleration"))
          terminals.setGpuAcceleration(gpuAcceleration());
        // Split tabs lay their terminals out again (a hidden one does when it shows).
        if (keys.includes("terminal.splitDirection")) for (const t of tabs.values()) t.onResize();
        if (
          keys.some((k) =>
            [
              "terminal.fontFamily",
              "terminal.cursorStyle",
              "terminal.cursorBlinking",
              "terminal.scrollback",
              "terminal.lineHeight",
              "terminal.minimumContrastRatio",
            ].includes(k),
          )
        )
          terminals.setLook(look());
      }),
    );

    registerTaskTerminals(sub, services, terminals, views, tabs, profiles);

    // Files dropped from the OS onto a terminal: their paths typed at the prompt, quoted for the
    // shell (VS Code and every terminal app do this). The view is marked `data-os-drop`, so the
    // explorer leaves the drop alone.
    void dragDropIpc
      .listen((e) => {
        if (e.kind !== "drop" || !e.paths.length) return;
        const el = document.elementFromPoint(e.x, e.y)?.closest<HTMLElement>(".terminal-pane");
        const view = [...views.values()].find(
          (v) => v.element === el || v.element.contains(el ?? null),
        );
        const t = view?.instance;
        if (!t || t.exitCode.peek() !== null) return;
        void ptyIpc
          .write(
            t.id,
            `${e.paths.map((p) => quotePathForShell(p, t.info.shell, t.info.msys)).join(" ")} `,
          )
          .catch(() => {});
        t.renderer.focus();
      })
      .then((d) => {
        if (sub.isDisposed) d.dispose();
        else sub.add(d);
      });

    const tabOf = (id: number) => [...views.values()].find((v) => v.instance?.id === id);
    const recentTerminalTab = () => dock.recentTab((t) => t.viewType === "terminal");
    /** The most recent terminal tab's active pane. */
    const recentPane = () => tabs.get(recentTerminalTab()?.id ?? "")?.active;
    const terminalInput = s.integer().describe("Terminal id from ide://terminals").optional();

    sub.add(
      dispatcher.register({
        id: "terminal.create",
        title: "New terminal",
        category: "Terminal",
        description:
          "Starts a new interactive shell (the user's default shell) in a terminal tab, next to the most recent terminal or at the bottom. `cwd` defaults to the workspace folder (in a multi-root workspace, the active editor's folder, else the first). Returns the terminal id and tab id.",
        input: s.object({
          cwd: s
            .string()
            .describe(
              "Working directory, absolute or relative to the workspace (multi-root: may start with a folder's name)",
            )
            .optional(),
        }),
        effects: ["exec"],
        run: async ({ cwd }) => {
          const { tabId, t } = await createTerminal(cwd, true);
          return { id: t.id, tabId, shell: t.info.shell, cwd: t.info.cwd, pid: t.info.pid };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "terminal.createInFolder",
        title: "New terminal in folder…",
        category: "Terminal",
        description:
          "Starts a new shell in a workspace folder (VS Code's multi-root new terminal): `folder` names it (a folder's name or path); without it, asks which when the workspace has several folders. Returns the terminal id and tab id.",
        input: s.object({
          folder: s.string().describe("Workspace folder (name or path)").optional(),
        }),
        effects: ["exec"],
        when: "workspaceOpen",
        run: async ({ folder }) => {
          const dir = await chooseFolder(services, folder, {
            placeholder: "Select the folder to open the terminal in",
            ask: "always",
          });
          if (!dir) return { id: null };
          const { tabId, t } = await createTerminal(dir, true);
          return { id: t.id, tabId, shell: t.info.shell, cwd: t.info.cwd, pid: t.info.pid };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "terminal.toggle",
        title: "Toggle terminal",
        category: "View",
        description:
          "VS Code's Ctrl+`: shows and focuses the most recent terminal (revealing its group) when it isn't visible or focused; when a terminal is focused, hides its region (the shells keep running; a terminal among the editors returns focus to the last editor instead). With no terminal tab open, shows the most recently hidden terminal again (VS Code's Ctrl+`), and only opens a new terminal at the bottom when none is running.",
        input: s.empty(),
        effects: ["exec"],
        run: async () => {
          const recent = recentTerminalTab();
          if (!recent) {
            // A hidden terminal is still the user's terminal: Ctrl+` brings it back (D229).
            if (hiddenTerminals.showLatest(true)) return;
            await createTerminal(undefined, true);
            return;
          }
          if (context.get("terminalFocus") === true) {
            // VS Code: visible and focused, Ctrl+` hides the panel (the shells keep running).
            // A terminal moved in among the editors can't hide them: focus goes back instead.
            const group = dock.findTab(recent.id)?.group;
            const editorLike = (t: { viewType: string }) =>
              t.viewType === "editor" || t.viewType === "welcome";
            if (group && !group.tabs.some(editorLike)) {
              dock.setGroupsHidden([group.id], true);
              return;
            }
            const editor = dock.recentTab(editorLike);
            if (editor) dock.activateTab(editor.id, true);
            return;
          }
          const group = dock.findTab(recent.id)?.group;
          if (group?.hidden) dock.setGroupsHidden([group.id], false);
          dock.activateTab(recent.id, true);
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "terminal.focus",
        title: "Focus terminal",
        category: "Terminal",
        description: "Reveals and focuses a terminal tab (default: the most recent one).",
        input: s.object({ id: terminalInput }),
        effects: [],
        run: ({ id }) => {
          // A hidden terminal (D217) comes back into a tab first.
          const pane = id !== undefined ? tabOf(id) : undefined;
          if (pane && hiddenTerminals.info(pane)) {
            hiddenTerminals.show(pane, true);
            return;
          }
          const tabId = id !== undefined ? pane?.tabId : recentTerminalTab()?.id;
          if (!tabId && id === undefined && hiddenTerminals.showLatest(true)) return;
          if (!tabId)
            throw new Error(
              id !== undefined ? `No terminal with id ${id}` : "No terminal is open.",
            );
          const group = dock.findTab(tabId)?.group;
          if (group?.hidden) dock.setGroupsHidden([group.id], false);
          dock.activateTab(tabId, true);
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "terminal.sendText",
        title: "Send text to terminal",
        category: "Terminal",
        description:
          "Types text into a terminal as if the user typed it (default: the most recent terminal, creating one if needed). Adds Enter unless addNewLine is false.",
        input: s.object({
          text: s.string().describe("Text to send, e.g. a command line"),
          id: terminalInput,
          addNewLine: s.boolean().describe("Press Enter after the text (default true)").optional(),
        }),
        effects: ["exec"],
        run: async ({ text, id, addNewLine }) => {
          let target = id !== undefined ? terminals.get(id) : undefined;
          if (id !== undefined && !target) throw new Error(`No terminal with id ${id}`);
          if (!target) {
            const view = recentPane();
            target = view ? await view.ready : (await createTerminal(undefined, false)).t;
          }
          await ptyIpc.write(target.id, typedText(text, addNewLine !== false));
          return { id: target.id };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "terminal.kill",
        title: "Kill terminal",
        category: "Terminal",
        description:
          "Kills a terminal's process (default: the most recent terminal) and closes it: its tab, or only its pane when the tab has terminals split beside it (a hidden terminal is ended where it is).",
        input: s.object({ id: terminalInput }),
        effects: ["exec"],
        run: async ({ id }) => {
          const view = id !== undefined ? tabOf(id) : recentPane();
          if (!view)
            throw new Error(
              id !== undefined ? `No terminal with id ${id}` : "No terminal to kill.",
            );
          const killed = view.instance?.id ?? null;
          if (hiddenTerminals.kill(view)) return { killed, hidden: true };
          const group = tabs.get(view.tabId);
          if (group && group.panes.length > 1) group.removePane(view);
          else await dock.closeTab(view.tabId, true);
          return { killed };
        },
      }),
    );

    // Long-running commands (dev servers, watchers) in their own terminal tab.
    /** command (with folder) → terminal it was started in; terminals whose start has ended. */
    const startedCommands = new Map<string, number>();
    const finishedStarts = new Set<number>();
    const pendingStarts = new Map<string, Promise<unknown>>();
    sub.add(
      dispatcher.register({
        id: "terminal.start",
        title: "Start in terminal",
        category: "Terminal",
        description:
          "Starts a long-running command (dev server, watcher: `npm run dev`, `node server.js`) in a new terminal tab that keeps running, and returns once its output settles: the output so far, local server URLs it printed, and whether it's still running. Stop it with terminal.kill { id }.",
        input: s.object({
          command: s.string().describe("Command line"),
          cwd: s.string().describe("Working directory (default: workspace root)").optional(),
          name: s.string().describe("Tab name (default: the command)").optional(),
          waitMs: s
            .integer({ min: 500, max: 60000 })
            .describe("Return after at most this long (default 10000)")
            .optional(),
          focus: s.boolean().optional(),
        }),
        effects: ["exec"],
        agent: "discoverable",
        run: async ({ command, cwd, name, waitMs, focus }) => {
          // The same command already running from an earlier start (an agent asking twice):
          // report that one instead of starting a second server on another port.
          const key = `${cwd ?? ""}\n${command.trim()}`;
          // A second start while the first is still creating its terminal waits for it.
          const starting = pendingStarts.get(key);
          if (starting) await starting.catch(() => {});
          const previous = startedCommands.get(key);
          const alive = previous !== undefined ? terminals.get(previous) : undefined;
          if (alive && alive.exitCode.peek() === null && !finishedStarts.has(alive.id)) {
            const urls = terminals.servers
              .peek()
              .filter((srv) => srv.terminalId === alive.id)
              .map((srv) => srv.url);
            return {
              id: alive.id,
              tabId: tabOf(alive.id)?.tabId,
              running: true,
              alreadyRunning: true,
              urls,
              output: "",
              note: `Already running in terminal ${alive.id} (started earlier); not started again.${urls.length ? ` Open ${urls[0]} with browser.open.` : ""} Stop it with terminal.kill.`,
            };
          }
          // The same command already serving from a terminal the user (or a task) started:
          // reuse it rather than start a second copy on the next port (Vite's 5174).
          const root = workspace.root.peek();
          const dir = cwd && root ? workspace.resolve(cwd) : (cwd ?? root ?? "");
          for (const srv of terminals.servers.peek()) {
            const t = terminals.get(srv.terminalId);
            if (!t || t.exitCode.peek() !== null) continue;
            const running = (await ptyIpc.commands(t.id, 1).catch(() => null))?.running;
            if (running?.command.trim() !== command.trim()) continue;
            if (dir && !samePath(t.cwd.peek() || dir, dir)) continue;
            const urls = terminals.servers
              .peek()
              .filter((x) => x.terminalId === t.id)
              .map((x) => x.url);
            return {
              id: t.id,
              tabId: tabOf(t.id)?.tabId,
              running: true,
              alreadyRunning: true,
              urls,
              output: "",
              note: `Already running in terminal ${t.id}; not started again.${urls.length ? ` Open ${urls[0]} with browser.open.` : ""}`,
            };
          }
          // Where the check above looked (the first folder by default, not the editor's).
          const creating = createTerminal(dir || cwd, focus ?? false);
          pendingStarts.set(key, creating);
          const { tabId, t } = await creating.finally(() => pendingStarts.delete(key));
          startedCommands.set(key, t.id);
          // Forget it once its terminal is gone (the maps don't grow with closed terminals).
          t.store.add({
            dispose: () => {
              if (startedCommands.get(key) === t.id) startedCommands.delete(key);
              finishedStarts.delete(t.id);
            },
          });
          terminals.rename(
            t.id,
            name ?? (command.length > 40 ? `${command.slice(0, 39)}…` : command),
          );
          let output = "";
          let last = Date.now();
          const tap = terminals.onDidWrite(({ id, text }) => {
            if (id !== t.id) return;
            output += text;
            last = Date.now();
          });
          let finished: number | undefined | null = null;
          // Only the end of *our* command counts: shells report "finished" at every prompt,
          // including the first one, which on a slow start (Windows PowerShell) came after the
          // command was typed and made a dev server look as if it had exited (D117).
          let ran = false;
          const begun = t.onDidStartCommand(() => (ran = true));
          const done = t.onDidFinishCommand((code) => {
            if (ran) finished = code ?? -1;
          });
          // Remembered after we return too: once it ends, a new start runs it again.
          const ended = t.onDidFinishCommand(() => {
            if (ran) finishedStarts.add(t.id);
          });
          t.store.add(ended);
          try {
            // Type the command once the shell's first prompt is up (shell integration), or after
            // a few seconds without integration; then only the command's own output counts.
            const ready = Date.now() + 8000;
            while (!t.promptReady.peek() && Date.now() < ready && t.exitCode.peek() === null)
              await new Promise((r) => setTimeout(r, 100));
            if (!t.promptReady.peek()) ran = true; // no integration: fall back to any finish
            await new Promise((r) => setTimeout(r, 150));
            output = "";
            await t.typeCommand(command);
            const start = Date.now();
            const limit = start + (waitMs ?? 10000);
            while (Date.now() < limit) {
              await new Promise((r) => setTimeout(r, 200));
              if (finished !== null || t.exitCode.peek() !== null) break;
              const urls = terminals.servers.peek().filter((srv) => srv.terminalId === t.id);
              const quiet = Date.now() - last > 1500;
              if (urls.length && quiet) break;
              if (quiet && Date.now() - start > 4000 && output.length > 0) break;
            }
          } finally {
            tap.dispose();
            done.dispose();
            begun.dispose();
          }
          const plain = stripAnsi(output).replace(/\r/g, "");
          const urls = terminals.servers
            .peek()
            .filter((srv) => srv.terminalId === t.id)
            .map((srv) => srv.url);
          const running = finished === null && t.exitCode.peek() === null;
          return {
            id: t.id,
            tabId,
            running,
            ...(!running && { exitCode: finished ?? t.exitCode.peek() }),
            urls,
            output: plain.length > 8000 ? `…${plain.slice(-8000)}` : plain,
            note: running
              ? urls.length
                ? "Still running. Open a URL with browser.open; stop it with terminal.kill."
                : "Still running (no server address seen yet). Read more with get_state ide://terminals/<id>/commands; stop it with terminal.kill."
              : "The command ended.",
          };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "terminal.servers",
        title: "Running servers",
        category: "Terminal",
        description:
          "Local servers terminals printed (a dev server's address, 'listening on port …'): url, port, terminal. With `open`, picks one to open in the browser.",
        input: s.object({ open: s.boolean().optional() }),
        effects: [],
        agent: "discoverable",
        run: async ({ open }) => {
          const list = terminals.servers.peek();
          if (open) {
            if (!list.length) throw new Error("No server address seen in a terminal yet.");
            const picked =
              list.length === 1
                ? list[0]
                : await services.quickInput
                    .pick(
                      list.map((srv) => ({
                        id: srv.url,
                        label: srv.url,
                        description: views.size ? `terminal ${srv.terminalId}` : "",
                        icon: "globe" as const,
                      })),
                      { placeholder: "Open in the browser" },
                    )
                    .then((p) => list.find((srv) => srv.url === p?.id));
            if (picked)
              await dispatcher.execute("browser.open", { url: picked.url, largest: true });
          }
          return { servers: list.map(({ url, port, terminalId }) => ({ url, port, terminalId })) };
        },
      }),
    );
    // A server appeared: the status bar offers it, once per port a toast too (like VS Code).
    sub.add(
      services.statusBar.add({
        id: "terminal.servers",
        name: "Dev servers",
        // Beside Go Live on the right (D121), where VS Code puts its port / Live Server items.
        alignment: "right",
        priority: 29,
        text: () => {
          const list = terminals.servers.value;
          if (!list.length) return "";
          const first = list[list.length - 1];
          const label = first ? first.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
          return list.length === 1 ? `$(globe) ${label}` : `$(globe) ${list.length} servers`;
        },
        tooltip: () => "Running servers: open in the browser (or show the tab already open)",
        command: "terminal.servers",
        input: { open: true },
      }),
    );
    const announced = new Set<number>();
    sub.add(
      terminals.onDidDetectServer((srv) => {
        void (async () => {
          // A browser tab already on this server (a restarted `npm run dev`, a task run on folder
          // open with last session's tab still there): no toast; a tab that lost the server
          // while it was down loads it again.
          const tabs = await browserTabsOn(srv.url);
          if (tabs.length) {
            announced.add(srv.port);
            for (const tab of tabs)
              if (!tab.connected)
                void dispatcher.execute("browser.reload", { tab: tab.tab }).catch(() => {});
            return;
          }
          announce(srv);
        })();
      }),
    );
    const announce = (srv: { url: string; port: number }) => {
      if (announced.has(srv.port) || !dispatcher.has("browser.open")) return;
      if (settings.peek<boolean>("browser.notifyOnServer") === false) return;
      announced.add(srv.port);
      services.notifications.show("info", `A server is running at ${srv.url}`, {
        actions: [
          {
            label: "Open in browser",
            run: () =>
              void dispatcher
                .execute("browser.open", { url: srv.url, largest: true })
                .catch(() => {}),
          },
        ],
      });
    };

    registerTerminalCommands(sub, services, {
      terminals,
      views,
      tabs,
      history: () => history,
      target: async (id, create) => {
        if (id !== undefined) {
          const view = tabOf(id);
          if (!view) throw new Error(`No terminal with id ${id}`);
          return view;
        }
        // To type a command (`create`): the most recent live shell — not a task's (or the
        // debugger's program's) terminal, nor one whose process has ended, where it would go
        // nowhere. To read one: the most recent terminal, whatever it runs.
        const recent = create
          ? dock.recentTab((t) => {
              const v = t.viewType === "terminal" ? tabs.get(t.id)?.active : undefined;
              return !!v && !v.task && (v.instance?.exitCode.peek() ?? null) === null;
            })
          : recentTerminalTab();
        const view = recent ? tabs.get(recent.id)?.active : undefined;
        if (view) return view;
        if (!create) throw new Error("No terminal is open.");
        const { tabId } = await createTerminal(undefined, false);
        const created = tabs.get(tabId)?.active;
        if (!created) throw new Error("Terminal view unavailable");
        return created;
      },
    });

    registerSplitCommands(sub, services, {
      tabs,
      target: async (id, create) => {
        if (id !== undefined) {
          const pane = tabOf(id);
          if (!pane) throw new Error(`No terminal with id ${id}`);
          return pane;
        }
        const recent = recentPane();
        if (recent) return recent;
        if (!create) throw new Error("No terminal is open.");
        const { tabId } = await createTerminal(undefined, false);
        const created = tabs.get(tabId)?.active;
        if (!created) throw new Error("Terminal view unavailable");
        return created;
      },
    });

    sub.add(
      state.register("ide://terminals", {
        description:
          "Open terminals: id, tab id, group id, whether it's hidden (no tab, still running; `hidden` lists the hidden tabs, terminal.showHidden shows one), its place in a split tab (pane, panes, active pane, splitLayout: side by side or stacked, from the terminal.splitDirection setting), title, the tab's title, shell, profile, cwd, pid, whether it exited (and its code), grid size, renderer, restored output, reattached (its process came back after a window reload), suggestions; the terminal profiles (terminal.newWithProfile), the default one and the automation profile (tasks, debugging). What a terminal shows: ide://terminals/<id>/output (or terminal.readOutput).",
        get: async () => ({
          ...(await profiles.state().catch(() => ({}))),
          terminals: [...views.values()].flatMap((v) => {
            const t = v.instance;
            if (!t) return [];
            const tab = tabs.get(v.tabId);
            const pane = tab ? tab.panes.indexOf(v) : 0;
            // A hidden terminal (D217): no tab; its place in the hidden tab's group.
            const hid = hiddenTerminals.info(v);
            return [
              {
                id: t.id,
                tabId: hid ? null : v.tabId,
                groupId: dock.findTab(v.tabId)?.group.id ?? null,
                hidden: !!hid,
                pane: hid?.index ?? pane,
                panes: hid?.panes ?? tab?.panes.length ?? 1,
                activePane: hid ? hid.active : tab ? tab.activePaneIndex === pane : true,
                ...(tab &&
                  tab.panes.length > 1 && {
                    splitLayout: tab.splitOrientation === "row" ? "side by side" : "stacked",
                  }),
                tabTitle: hid?.title ?? tab?.title() ?? t.title.peek(),
                title: t.title.peek(),
                shell: t.info.shell,
                profile: t.profile,
                cwd: t.cwd.peek(),
                shellIntegration: t.info.integration,
                pid: t.info.pid,
                exited: t.exitCode.peek() !== null,
                exitCode: t.exitCode.peek(),
                size: t.renderer.size,
                renderer: t.renderer.rendererType,
                restored: t.restored,
                // Its process came back after a page reload (m7.12), not a new shell.
                reattached: t.reattached,
                ...(v.suggest && { suggest: v.suggest.state() }),
              },
            ];
          }),
          hidden: hiddenTerminals.state(),
          splitDirection: splitDirectionOf(settings.peek<unknown>("terminal.splitDirection")),
          servers: terminals.servers.peek().map((srv) => ({
            url: srv.url,
            port: srv.port,
            terminalId: srv.terminalId,
          })),
          note: "Commands and their output per terminal: ide://terminals/<id>/commands (bash, zsh, fish, PowerShell). What a terminal shows now, for any program: ide://terminals/<id>/output or terminal.readOutput. `servers`: local servers the terminals printed (open one with browser.open). `profiles`: shells to start with terminal.newWithProfile { profile }; `defaultProfile` (null: the IDE's own default shell) is set with terminal.selectDefaultProfile. `hidden`: terminal tabs hidden with terminal.hide, still running (every terminal tool works on them by id; terminal.showHidden { id } shows one).",
        }),
      }),
    );
  },
};
