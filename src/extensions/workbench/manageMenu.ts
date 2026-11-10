// The gear at the bottom of the activity bar (D134): VS Code's Manage menu as far as the IDE has
// the features — command palette, profiles, settings, extensions, keyboard shortcuts, snippets,
// tasks, then Themes (color theme, file icon theme, dark/light) and Layout density. Each entry
// runs a command; entries whose command doesn't exist are left out.
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { IconName } from "../../ui/Icon";
import { type MenuItem, showMenu } from "../../ui/Menu";
import type { WorkbenchServices } from "../../workbench/services";
import { DENSITIES, THEMES } from "../../workbench/theme";
import { DEFAULT_COLOR_THEME } from "./appearance";

const label = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

export function registerManageMenu(sub: DisposableStore, services: WorkbenchServices): void {
  const { dispatcher, keyboard, theme } = services;
  const run =
    (id: string, input: unknown = {}) =>
    () =>
      void dispatcher.execute(id, input).catch(() => {});
  /** A command entry (left out when the command isn't registered). */
  const entry = (
    text: string,
    command: string,
    extra: { icon?: IconName; separatorBefore?: boolean; input?: unknown } = {},
  ): MenuItem[] =>
    dispatcher.has(command)
      ? [
          {
            label: text,
            ...(extra.icon && { icon: extra.icon }),
            ...(extra.separatorBefore && { separatorBefore: true }),
            ...(keyboard.labelFor(command) && { keybinding: keyboard.labelFor(command) }),
            run: run(command, extra.input),
          },
        ]
      : [];

  sub.add(
    dispatcher.register({
      id: "workbench.showManageMenu",
      title: "Manage…",
      category: "Preferences",
      description:
        "Opens the gear menu: command palette, profiles, settings, extensions, keyboard shortcuts, snippets, tasks, themes and layout density.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: () => {
        const p = theme.preferences;
        const profiles: MenuItem[] = [
          ...entry("Export profile…", "settings.exportProfile", { icon: "file-output" }),
          ...entry("Import profile…", "settings.importProfile", { icon: "file-input" }),
        ];
        const tasks: MenuItem[] = [
          ...entry("Run task…", "tasks.run", { icon: "play" }),
          ...entry("Show running tasks…", "tasks.showRunning"),
          ...entry("Configure tasks", "tasks.configure", {
            icon: "settings",
            separatorBefore: true,
          }),
          ...entry("Open user tasks", "tasks.openUserTasks", { icon: "file-json" }),
        ];
        const items: MenuItem[] = [
          ...entry("Command palette…", "palette.show", { icon: "search" }),
          ...(profiles.length
            ? [
                {
                  label: "Profiles",
                  icon: "users" as const,
                  submenu: profiles,
                  separatorBefore: true,
                },
              ]
            : []),
          ...entry("Settings", "settings.open", {
            icon: "settings",
            separatorBefore: !profiles.length,
          }),
          // The AI models page (D165): providers, keys, Ollama and agent CLIs.
          ...entry("AI models and providers", "agent.showSetup", { icon: "agent" }),
          ...entry("Extensions", "extensions.show", { icon: "blocks" }),
          ...entry("Keyboard shortcuts", "keybindings.show", { icon: "keyboard" }),
          ...entry("Snippets", "editor.configureSnippets", { icon: "braces" }),
          ...(tasks.length
            ? [{ label: "Tasks", icon: "list-checks" as const, submenu: tasks }]
            : []),
          {
            label: "Themes",
            icon: "palette",
            separatorBefore: true,
            submenu: [
              ...entry("Color theme…", "ui.selectColorTheme", { icon: "palette" }),
              ...entry("File icon theme…", "ui.selectFileIconTheme", { icon: "file" }),
              ...THEMES.map((t, i) => ({
                label: t === "light" ? "Light+" : "Dark+",
                checked:
                  (services.settings.get<string>("workbench.colorTheme") ?? DEFAULT_COLOR_THEME) ===
                  (t === "light" ? "Light+" : "Dark+"),
                separatorBefore: i === 0,
                run: run("ui.setTheme", { theme: t }),
              })),
            ],
          },
          {
            label: "Layout density",
            icon: "rows-3",
            submenu: DENSITIES.map((d) => ({
              label: label(d),
              checked: p.density === d,
              run: run("ui.setDensity", { density: d }),
            })),
          },
        ];
        // Beside the gear, bottom-aligned (menus are kept inside the window).
        const gear = document.querySelector<HTMLElement>(".activitybar-settings");
        const r = gear?.getBoundingClientRect();
        showMenu(r ? { x: r.right + 4, y: r.bottom } : { x: 56, y: window.innerHeight }, items, {
          label: "Manage",
          focusFirst: false,
        });
      },
    }),
  );
}
