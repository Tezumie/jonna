// Terminal profiles (D204, VS Code's `terminal.integrated.profiles.*`): the detected shells
// merged with settings (profiles.ts), the default one, the "+ ▾" menu, and the commands
// `terminal.newWithProfile`, `terminal.selectDefaultProfile`, `terminal.profileMenu`,
// `terminal.configureSettings`.
import { ptyIpc, type TerminalShells } from "../../core/ipc/process";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import { type IconName, knownIcon } from "../../ui/Icon";
import { type MenuItem, showContextMenu } from "../../ui/Menu";
import type { WorkbenchServices } from "../../workbench/services";
import {
  defaultProfile,
  type ProfilePlatform,
  profilePlatform,
  profileSpec,
  type ResolvedProfile,
  resolveProfiles,
} from "./profiles";
import type { TerminalInstance, TerminalStart } from "./service";
import { TERMINAL_ICONS } from "./view";

/**
 * VS Code lists the JavaScript debug terminal with the profiles (the debugger's command opens
 * it; D207). Also a `profile` name for terminal.newWithProfile.
 */
export const JS_DEBUG_PROFILE = "JavaScript debug terminal";
const JS_DEBUG_COMMAND = "debug.createJavaScriptDebugTerminal";

/** Shells are looked for again after this long (one installed meanwhile shows up). */
const DETECT_TTL = 60_000;

export interface TerminalProfiles {
  readonly platform: ProfilePlatform;
  list(): Promise<ResolvedProfile[]>;
  /** The default profile (terminal.defaultProfile.<platform>), null for the IDE's own shell. */
  defaultProfile(): Promise<ResolvedProfile | null>;
  /** The same from the shells found so far, without waiting (tasks quote for it at load). */
  peekDefaultProfile(): ResolvedProfile | null;
  /** How a terminal of profile `name` (default: the default profile) starts. */
  start(name: string | undefined): Promise<TerminalStart>;
  /** For ide://terminals. */
  state(): Promise<{
    defaultProfile: string | null;
    conpty: string | null;
    profiles: { name: string; path: string[]; args?: string[]; detected: boolean }[];
  }>;
}

export interface ProfileCommandHost {
  /** Opens a terminal tab with a profile (null: the default) and waits for its shell. */
  createTerminal(
    cwd: string | undefined,
    focus: boolean,
    profile: string | null,
  ): Promise<{ tabId: string; t: TerminalInstance }>;
  /** The ▾ menu's hidden terminals part (D217, hiddenCommands.ts); empty when none are hidden. */
  hiddenMenu(): MenuItem[];
}

export function registerTerminalProfiles(
  sub: DisposableStore,
  services: WorkbenchServices,
  host: ProfileCommandHost,
): TerminalProfiles {
  const { dispatcher, settings, quickInput } = services;
  const platform = profilePlatform(services.platform);
  const profilesKey = `terminal.profiles.${platform}`;
  const defaultKey = `terminal.defaultProfile.${platform}`;

  // The shells found, looked for again in the background once stale: the last list answers
  // meanwhile, so a slow `wsl.exe` never holds up a menu or a new terminal twice.
  let cache: { at: number; value: TerminalShells } | null = null;
  let pending: Promise<TerminalShells> | null = null;
  const shells = async (): Promise<TerminalShells> => {
    if ((!cache || Date.now() - cache.at > DETECT_TTL) && !pending) {
      pending = ptyIpc
        .profiles()
        .catch((): TerminalShells => cache?.value ?? { profiles: [], conpty: null })
        .then((value) => {
          cache = { at: Date.now(), value };
          pending = null;
          return value;
        });
    }
    if (cache) return cache.value;
    return pending ?? { profiles: [], conpty: null };
  };
  // Looked for early, so the first "+ ▾" opens at once.
  void shells();
  const list = async () =>
    resolveProfiles(settings.peek<unknown>(profilesKey), (await shells()).profiles, [
      ...TERMINAL_ICONS,
    ]);
  const byName = async (name: string) => {
    const all = await list();
    const wanted = name.toLowerCase();
    return all.find((p) => p.name.toLowerCase() === wanted) ?? null;
  };
  const chosenDefault = async () =>
    defaultProfile(settings.peek<unknown>(defaultKey), await list());

  const startOf = (p: ResolvedProfile): TerminalStart => ({
    profile: profileSpec(p),
    profileName: p.name,
    ...(p.color && { color: p.color }),
    ...(p.icon && { icon: p.icon }),
    ...(p.overrideName && { title: p.name }),
  });

  const profiles: TerminalProfiles = {
    platform,
    list,
    defaultProfile: chosenDefault,
    peekDefaultProfile: () => {
      const name = settings.peek<unknown>(defaultKey);
      if (!String(name ?? "").trim()) return null;
      void shells();
      const found = cache?.value.profiles ?? [];
      return defaultProfile(
        name,
        resolveProfiles(settings.peek<unknown>(profilesKey), found, [...TERMINAL_ICONS]),
      );
    },
    start: async (name) => {
      // Nothing configured and no profile asked for: the IDE's own shell, without waiting for
      // the shells to be looked for (wsl.exe can take a while to answer).
      if (!name && !String(settings.peek<unknown>(defaultKey) ?? "").trim()) return {};
      const p = name ? await byName(name) : await chosenDefault();
      if (!p) {
        if (name)
          services.notifications.show(
            "warning",
            `The terminal profile "${name}" isn't there any more; starting the default shell.`,
          );
        return {};
      }
      return startOf(p);
    },
    state: async () => {
      const [all, def, sh] = await Promise.all([list(), chosenDefault(), shells()]);
      return {
        defaultProfile: def?.name ?? null,
        conpty: sh.conpty,
        profiles: all.map((p) => ({
          name: p.name,
          path: p.path,
          ...(p.args && { args: p.args }),
          detected: p.detected,
        })),
      };
    },
  };

  /** Extensions' terminal profiles (D264), by the name the menus show. */
  const extensionProfiles = () => services.extensionFeatures.terminalProfiles.all.peek();
  const extensionProfile = (name: string) => extensionProfiles().find((p) => p.title === name);
  const extensionIcon = (icon: string | undefined) =>
    knownIcon(icon, "square-terminal") as IconName;

  /** The debugger is there and a folder is open (its command's `when`). */
  const jsDebugAvailable = () => dispatcher.info(JS_DEBUG_COMMAND)?.enabled === true;

  /** The profile picker (VS Code's "Create new terminal (with profile)"). */
  const pickProfile = async (
    placeholder: string,
    withDebug = false,
  ): Promise<string | undefined> => {
    const [all, def] = await Promise.all([list(), chosenDefault()]);
    const picked = await quickInput.pick(
      [
        ...all.map((p) => ({
          id: p.name,
          label: p.name,
          description: [p.path[0] ?? "", ...(p.args ?? [])].join(" "),
          icon: "square-terminal" as const,
          ...(def?.name === p.name && { keybinding: "Default" }),
        })),
        ...extensionProfiles()
          .filter((e) => !all.some((p) => p.name === e.title))
          .map((e) => ({
            id: e.title,
            label: e.title,
            description: "From an extension",
            icon: extensionIcon(e.icon),
          })),
        ...(withDebug && jsDebugAvailable() && !all.some((p) => p.name === JS_DEBUG_PROFILE)
          ? [
              {
                id: JS_DEBUG_PROFILE,
                label: JS_DEBUG_PROFILE,
                description: "Debugs the Node programs started in it",
                icon: "bug-play" as const,
              },
            ]
          : []),
      ],
      { placeholder },
    );
    return picked?.id;
  };

  sub.add(
    dispatcher.register({
      id: "terminal.newWithProfile",
      title: "New terminal with profile…",
      category: "Terminal",
      description: `Opens a terminal running a terminal profile (a shell found on this machine — PowerShell, Command Prompt, Git Bash, a WSL distribution, bash, zsh, fish — or one from terminal.profiles.<platform>). "${JS_DEBUG_PROFILE}" opens the JavaScript debug terminal (debug.createJavaScriptDebugTerminal). Without \`profile\`, asks which. The profiles are listed in ide://terminals.`,
      input: s.object({
        profile: s.string().describe('Profile name, e.g. "Git Bash" or "zsh"').optional(),
        cwd: s
          .string()
          .describe(
            "Working directory, absolute or relative to the workspace (multi-root: may start with a folder's name)",
          )
          .optional(),
      }),
      effects: ["exec"],
      run: async ({ profile, cwd }) => {
        const name = profile ?? (await pickProfile("Select a profile for the new terminal", true));
        if (!name) return { id: null };
        const p = await byName(name);
        if (!p && name === JS_DEBUG_PROFILE && dispatcher.has(JS_DEBUG_COMMAND))
          return dispatcher.execute(JS_DEBUG_COMMAND, cwd ? { cwd } : {});
        // An extension's profile: its code makes the terminal (D264).
        const fromExtension = p ? undefined : extensionProfile(name);
        if (fromExtension) {
          await fromExtension.open();
          return { id: null, profile: fromExtension.title, extension: fromExtension.owner };
        }
        if (!p) throw new Error(`No terminal profile named "${name}". See ide://terminals.`);
        const { tabId, t } = await host.createTerminal(cwd, true, p.name);
        return { id: t.id, tabId, profile: p.name, shell: t.info.shell, cwd: t.info.cwd };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "terminal.selectDefaultProfile",
      title: "Select default profile…",
      category: "Terminal",
      description: `Sets the profile new terminals start with (${defaultKey}, user settings). Without \`profile\`, asks which. "" goes back to the IDE's own default shell.`,
      input: s.object({ profile: s.string().describe("Profile name").optional() }),
      effects: ["write"],
      run: async ({ profile }) => {
        const name = profile ?? (await pickProfile("Select the default terminal profile"));
        if (name === undefined) return { defaultProfile: null };
        if (name && !(await byName(name)))
          throw new Error(`No terminal profile named "${name}". See ide://terminals.`);
        await settings.update(defaultKey, name, "user");
        return { defaultProfile: name || null, setting: defaultKey };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "terminal.configureSettings",
      title: "Configure terminal settings",
      category: "Terminal",
      description: "Opens the settings on the terminal's settings.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => dispatcher.execute("settings.open", { query: "@ext:builtin.terminal" }),
    }),
  );
  sub.add(
    dispatcher.register({
      id: "terminal.profileMenu",
      title: "Launch profile…",
      category: "Terminal",
      description:
        "The terminal panel's ▾ menu: the profiles to start (and the JavaScript debug terminal), split, the hidden terminals to show again, the default profile, terminal settings. `x` / `y`: where to open it (default: a picker).",
      input: s.object({ x: s.number().optional(), y: s.number().optional() }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: async ({ x, y }) => {
        if (x === undefined || y === undefined)
          return dispatcher.execute("terminal.newWithProfile", {});
        const [all, def] = await Promise.all([list(), chosenDefault()]);
        const run =
          (command: string, input: unknown = {}) =>
          () =>
            void dispatcher.execute(command, input).catch(() => {});
        showContextMenu(x, y, [
          ...all.map((p) => ({
            label: p.name,
            icon: "square-terminal" as const,
            ...(def?.name === p.name && { keybinding: "Default" }),
            run: run("terminal.newWithProfile", { profile: p.name }),
          })),
          ...(jsDebugAvailable() && !all.some((p) => p.name === JS_DEBUG_PROFILE)
            ? [
                {
                  label: JS_DEBUG_PROFILE,
                  icon: "bug-play" as const,
                  run: run("terminal.newWithProfile", { profile: JS_DEBUG_PROFILE }),
                },
              ]
            : []),
          ...extensionProfiles()
            .filter((e) => !all.some((p) => p.name === e.title))
            .map((e) => ({
              label: e.title,
              icon: extensionIcon(e.icon),
              run: run("terminal.newWithProfile", { profile: e.title }),
            })),
          // A multi-root workspace (D251): which folder the new shell starts in.
          ...(services.workspace.folders.peek().length > 1
            ? [
                {
                  label: "New terminal in folder…",
                  icon: "folder" as const,
                  separatorBefore: true,
                  run: run("terminal.createInFolder"),
                },
              ]
            : []),
          {
            label: "Split terminal",
            icon: "terminal-split",
            separatorBefore: true,
            keybinding: services.keyboard.labelFor("terminal.split"),
            run: run("terminal.split"),
          },
          ...host.hiddenMenu(),
          {
            label: "Select default profile…",
            separatorBefore: true,
            run: run("terminal.selectDefaultProfile"),
          },
          {
            label: "Configure terminal settings",
            icon: "settings",
            run: run("terminal.configureSettings"),
          },
        ]);
        return { profiles: all.length };
      },
    }),
  );
  return profiles;
}
