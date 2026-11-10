// Appearance (DESIGN.md §2, §19): theme, density and panel style are settings
// (`workbench.theme`, `workbench.density`, `workbench.panels`, `workbench.colorCustomizations`);
// this applies them to ThemeService live. `ui.set*` are thin commands that write the user setting.
import type { DisposableStore } from "../../core/lifecycle/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { mapColorCustomizations } from "../../core/themes/customizations";
import { mapVsCodeTheme, type VsCodeTheme } from "../../core/themes/importer";
import "./colorCustomizations.css";
import { type MenuAnchor, type MenuItem, showMenu } from "../../ui/Menu";
import type { ColorThemeEntry } from "../../workbench/contributions";
import type { WorkbenchServices } from "../../workbench/services";
import { SettingsService } from "../../workbench/settings";
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
} from "../../workbench/theme";

const label = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);

/** The built-in color themes (VS Code's default Dark+ / Light+), by workbench.colorTheme value. */
export const BUILT_IN_THEMES: Record<string, ThemeKind> = { "Dark+": "dark", "Light+": "light" };
export const builtInThemeFor = (kind: ThemeKind) => (kind === "light" ? "Light+" : "Dark+");

/** The color theme a new install starts with (D270): Claude Dark, bundled (shikiThemes.ts). */
export const DEFAULT_COLOR_THEME = "Claude Dark";

/**
 * The built-in kind workbench.colorTheme asks for, or null for another theme: "Dark+" / "Light+";
 * empty (settings from before D135) follows the old workbench.theme.
 */
export function builtInKind(colorTheme: string, legacy: ThemeKind | undefined): ThemeKind | null {
  if (colorTheme === "") return legacy === "light" ? "light" : "dark";
  return BUILT_IN_THEMES[colorTheme] ?? null;
}

/** Themes the IDE brings itself (Claude Dark, Shiki's), not an extension's. */
const isBundled = (t: { source: string }) => t.source === "built-in" || t.source === "Shiki";

export function registerAppearance(sub: DisposableStore, services: WorkbenchServices): void {
  /**
   * Every color theme once by name, an installed extension's before a bundled one of the same
   * name (D282).
   */
  const themeEntries = () => {
    const byLabel = new Map<string, ColorThemeEntry>();
    for (const t of services.contributions.themes.peek()) {
      const had = byLabel.get(t.label);
      if (!had || (isBundled(had) && !isBundled(t))) byLabel.set(t.label, t);
    }
    return [...byLabel.values()];
  };
  const themeNamed = (label: string) => themeEntries().find((t) => t.label === label);
  const { dispatcher, theme, settings, contributions } = services;
  // Settings → Color theme: a dropdown of the installed themes (D134). One entry per name: an
  // installed extension's theme wins over a bundled one of the same name (D282: the official
  // Night Owl beside the bundled copy, two entries that couldn't be told apart, and the bundled
  // one always applied); the bundled ones say "(built in)", which a dropdown can only show in its
  // text.
  const themeChoices = (kind?: ThemeKind) =>
    [
      {
        kind: "dark",
        value: "Dark+",
        label: "Dark+ (built in)",
        description: "Dark · built-in (VS Code's default dark)",
      },
      {
        kind: "light",
        value: "Light+",
        label: "Light+ (built in)",
        description: "Light · built-in (VS Code's default light)",
      },
      ...themeEntries()
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((t) => ({
          kind: t.kind,
          value: t.label,
          label: isBundled(t) ? `${t.label} (built in)` : t.label,
          description: `${t.kind === "light" ? "Light" : "Dark"} · ${t.source}`,
        })),
    ]
      .filter((c) => !kind || c.kind === kind)
      .map(({ kind: _kind, ...choice }) => choice);
  sub.add(settings.registerChoices("workbench.colorTheme", () => themeChoices()));
  // window.autoDetectColorScheme (VS Code's, D279): the theme follows the OS's light or dark
  // mode, from these two.
  sub.add(
    settings.registerChoices("workbench.preferredDarkColorTheme", () => themeChoices("dark")),
  );
  sub.add(
    settings.registerChoices("workbench.preferredLightColorTheme", () => themeChoices("light")),
  );
  const osScheme = window.matchMedia("(prefers-color-scheme: dark)");
  const osDark = signal(osScheme.matches);
  const onScheme = (e: MediaQueryListEvent) => (osDark.value = e.matches);
  osScheme.addEventListener("change", onScheme);
  sub.add({ dispose: () => osScheme.removeEventListener("change", onScheme) });
  /** The color theme to show: workbench.colorTheme, or the OS's preferred one (autoDetect). */
  const chosenTheme = () => {
    if (settings.get<boolean>("window.autoDetectColorScheme") === true)
      return osDark.value
        ? (settings.get<string>("workbench.preferredDarkColorTheme") ?? DEFAULT_COLOR_THEME)
        : (settings.get<string>("workbench.preferredLightColorTheme") ?? "Light+");
    return settings.get<string>("workbench.colorTheme") ?? DEFAULT_COLOR_THEME;
  };
  const write = (key: string, value: unknown) => settings.update(key, value, "user");
  const register: typeof dispatcher.register = (command) =>
    sub.add(dispatcher.register({ category: "Preferences", ...command }));

  register({
    id: "ui.setTheme",
    title: "Set color theme",
    description:
      "Switches the UI theme (dark or light). Editors and terminals re-theme live; no reload.",
    input: s.object({ theme: s.enum(THEMES) }),
    effects: [],
    // One theme picker in the palette (D189): "Color theme…" lists every theme.
    palette: false,
    run: ({ theme: kind }) => write("workbench.colorTheme", builtInThemeFor(kind as ThemeKind)),
  });
  register({
    id: "ui.toggleTheme",
    title: "Toggle light/dark theme",
    description:
      "Switches between the built-in Dark+ and Light+ themes (from any theme: the built-in one of the other kind).",
    input: s.empty(),
    effects: [],
    run: () =>
      write(
        "workbench.colorTheme",
        builtInThemeFor(theme.theme.peek() === "dark" ? "light" : "dark"),
      ),
  });
  register({
    id: "ui.setDensity",
    title: "Set density",
    description: "Sets UI density: compact, default or comfortable (row, tab and control heights).",
    input: s.object({ density: s.enum(DENSITIES) }),
    effects: [],
    run: ({ density }) => write("workbench.density", density as Density),
  });
  register({
    id: "ui.setPanelStyle",
    title: "Set panel style",
    description:
      "Flush panels (one shell color, 1px dividers; the default) or floating panels (cards with gaps).",
    input: s.object({ panels: s.enum(PANEL_STYLES) }),
    effects: [],
    run: ({ panels }) => write("workbench.panels", panels as PanelStyle),
  });
  register({
    id: "ui.setSideBarColor",
    title: "Set side bar color",
    description:
      "The side bar's color in flush and floating panels: matching (the panels' color, the default) or distinct (the color theme's side bar color, set apart from the editors).",
    input: s.object({ color: s.enum(SIDE_BAR_COLORS) }),
    effects: [],
    run: ({ color }) => write("workbench.sideBarColor", color as SideBarColor),
  });
  register({
    id: "ui.setTabStyle",
    title: "Set tab style",
    description:
      "The look of the dock's tabs: rounded (the default), classic (square tabs with the accent along the active tab's top) or connected (the active tab joins the editor under a lighter tab strip).",
    input: s.object({ style: s.enum(TAB_STYLES) }),
    effects: [],
    run: ({ style }) => write("workbench.tabStyle", style as TabStyle),
  });

  const anchorFor = (anchor: string | undefined): MenuAnchor => {
    const el = anchor ? document.querySelector<HTMLElement>(anchor) : null;
    return el ?? { x: window.innerWidth / 2 - 100, y: 80 };
  };
  const run =
    (id: string, input: unknown = {}) =>
    () =>
      void dispatcher.execute(id, input).catch(() => {});
  register({
    id: "ui.showAppearanceMenu",
    title: "Appearance…",
    description: "Opens the appearance menu (theme, density, panel style).",
    input: s.object({
      anchor: s.string().describe("CSS selector of the element to open below").optional(),
    }),
    effects: [],
    agent: "hidden",
    run: ({ anchor }) => {
      const p = theme.preferences;
      const items: MenuItem[] = [
        ...THEMES.map((t, i) => ({
          label: `${label(t)} theme`,
          checked:
            (settings.get<string>("workbench.colorTheme") ?? DEFAULT_COLOR_THEME) ===
            builtInThemeFor(t),
          separatorBefore: i === 0,
          run: run("ui.setTheme", { theme: t }),
        })),
        ...DENSITIES.map((d, i) => ({
          label: `${label(d)} density`,
          checked: p.density === d,
          separatorBefore: i === 0,
          run: run("ui.setDensity", { density: d }),
        })),
        ...PANEL_STYLES.map((v, i) => ({
          label: `${label(v)} panels`,
          checked: p.panels === v,
          separatorBefore: i === 0,
          run: run("ui.setPanelStyle", { panels: v }),
        })),
        ...SIDE_BAR_COLORS.map((v, i) => ({
          label: v === "matching" ? "Side bar matches the panels" : "Distinct side bar color",
          checked: p.sideBar === v,
          separatorBefore: i === 0,
          run: run("ui.setSideBarColor", { color: v }),
        })),
        ...TAB_STYLES.map((v, i) => ({
          label: `${label(v)} tabs`,
          checked: p.tabs === v,
          separatorBefore: i === 0,
          run: run("ui.setTabStyle", { style: v }),
        })),
        {
          label: "Show startup timings",
          icon: "info",
          separatorBefore: true,
          run: run("workbench.startupTimings"),
        },
      ];
      showMenu(anchorFor(anchor ?? ".activitybar-settings"), items, "Appearance");
    },
  });
  register({
    id: "ui.selectColorTheme",
    // VS Code's name: "Preferences: Color Theme".
    title: "Color theme…",
    description:
      "Picks the color theme: Dark+ or Light+ (built in), a bundled Shiki theme, or one from an installed extension (VS Code themes work). Without `label`, shows a picker. Sets workbench.colorTheme.",
    input: s.object({
      label: s.string().describe("Theme label, e.g. 'Dark+', 'Light+', 'Dracula Theme'").optional(),
    }),
    effects: [],
    run: async ({ label: chosen }) => {
      let pick = chosen;
      const current = settings.get<string>("workbench.colorTheme") ?? DEFAULT_COLOR_THEME;
      if (pick === undefined) {
        const installed = contributions.themes.peek().some((t) => t.label === current);
        const active =
          current in BUILT_IN_THEMES || installed ? current : builtInThemeFor(theme.theme.peek());
        const items = [
          { id: "Dark+", label: "Dark+", description: "dark · built-in" },
          { id: "Light+", label: "Light+", description: "light · built-in" },
          ...themeEntries().map((t) => ({
            id: t.label,
            label: t.label,
            description: `${t.kind} · ${t.source}`,
          })),
        ];
        const picked = await services.quickInput.pick(
          [...items.filter((i) => i.id === active), ...items.filter((i) => i.id !== active)],
          { placeholder: "Color theme" },
        );
        if (!picked) return { label: current };
        pick = picked.id;
      }
      // Old values: "" and the built-in kinds.
      if (pick === "" || pick === "dark" || pick === "light")
        pick = builtInThemeFor(pick === "light" ? "light" : "dark");
      if (!(pick in BUILT_IN_THEMES) && !contributions.themes.peek().some((t) => t.label === pick))
        throw new Error(`No installed theme "${pick}".`);
      await write("workbench.colorTheme", pick);
      return { label: pick };
    },
  });

  // An extension's color theme (VS Code JSON): its kind, its UI colors as token overrides and its
  // syntax colors for editors. Loaded once per theme.
  const loaded = new Map<
    string,
    Promise<{ kind: ThemeKind; tokens: Record<string, string>; json: unknown } | null>
  >();
  const loadTheme = (label: string) => {
    const entry = themeNamed(label);
    // By where it comes from too: an extension's theme installed later replaces a bundled one.
    const key = `${entry?.source ?? ""}|${label}`;
    let p = loaded.get(key);
    if (!p) {
      p = entry
        ? entry
            .load()
            .then((json) => {
              const mapped = mapVsCodeTheme(json as VsCodeTheme);
              return { kind: entry.kind, tokens: mapped.tokens, json };
            })
            .catch((err: unknown) => {
              services.notifications.show(
                "error",
                `Couldn't load the color theme "${label}": ${err instanceof Error ? err.message : String(err)}`,
              );
              return null;
            })
        : Promise.resolve(null);
      loaded.set(key, p);
    }
    return p;
  };
  // workbench.scrollbarSize (D128): the width of every scrollbar outside the editor and terminal.
  sub.add(
    effect(() => {
      const px = settings.get<number>("workbench.scrollbarSize") ?? 10;
      document.documentElement.style.setProperty("--size-scrollbar", `${px}px`);
      return undefined;
    }),
  );
  let applied = 0;
  let migrating = false;
  // What the first paint used (the last start's theme): kept while the settings load and while
  // an extension's theme isn't registered yet, so nothing flashes the default (D136).
  const cached = SettingsService.cachedFirstPaint();
  const grace = signal(false);
  const graceTimer = setTimeout(() => (grace.value = true), 5000);
  sub.add({ dispose: () => clearTimeout(graceTimer) });
  /** Applies a look and remembers it for the next start's first paint. */
  const show = (
    kind: ThemeKind,
    base: Partial<UiPreferences>,
    name: string,
    syntax: { name: string; json: unknown } | null,
    overrides: Record<string, string>,
  ) => {
    settings.setFirstPaint("workbench.theme", kind);
    settings.setFirstPaint("theme.colorTheme", name);
    settings.setFirstPaint("theme.overrides", overrides);
    settings.setFirstPaint("theme.syntax", syntax);
    theme.apply({ ...base, theme: kind });
    theme.setSyntaxTheme(syntax);
    theme.setOverrides(overrides);
  };
  // Settings → ThemeService (live; no reload).
  sub.add(
    effect(() => {
      // Until the files are read, the defaults would replace the cached look for a moment.
      if (!settings.loaded.value) return undefined;
      const colorTheme = chosenTheme();
      const available = contributions.themes.value.some((t) => t.label === colorTheme);
      // A theme that isn't installed (yet): the built-in one of the kind its name suggests.
      const kind =
        builtInKind(colorTheme, settings.get<ThemeKind>("workbench.theme")) ??
        (/light/i.test(colorTheme) ? "light" : "dark");
      const base = {
        theme: kind,
        density: settings.get<Density>("workbench.density"),
        panels: settings.get<PanelStyle>("workbench.panels"),
        sideBar: settings.get<SideBarColor>("workbench.sideBarColor"),
        tabs: settings.get<TabStyle>("workbench.tabStyle"),
      };
      // Tokens or VS Code color ids (Peacock's bars), the folder's over the user's.
      settings.get("workbench.colorCustomizations");
      const custom = mapColorCustomizations(
        (["user", "vscode", "workspace"] as const).map((scope) =>
          settings.model.inspect("workbench.colorCustomizations", scope),
        ),
        colorTheme,
      );
      const version = ++applied;
      // Settings from before D135: workbench.colorTheme "" + workbench.theme → "Dark+" / "Light+".
      if (settings.model.inspect("workbench.colorTheme", "user") === "" && !migrating) {
        migrating = true;
        queueMicrotask(async () => {
          await write("workbench.colorTheme", builtInThemeFor(kind)).catch(() => {});
          await settings.update("workbench.theme", undefined, "user").catch(() => {});
          migrating = false;
        });
      }
      if (!available) {
        // An extension's theme the last start used: wait a little for extensions to register it.
        const builtIn =
          builtInKind(colorTheme, settings.get<ThemeKind>("workbench.theme")) !== null;
        if (!builtIn && cached["theme.colorTheme"] === colorTheme && !grace.value) return undefined;
        show(kind, base, colorTheme, null, custom);
        return undefined;
      }
      void loadTheme(colorTheme).then((t) => {
        if (version !== applied) return;
        if (!t) {
          show(kind, base, colorTheme, null, custom);
          return;
        }
        show(
          t.kind,
          base,
          colorTheme,
          { name: themeSlug(colorTheme), json: t.json },
          { ...t.tokens, ...custom },
        );
      });
      return undefined;
    }),
  );
}

/** A Shiki-safe theme name for a label ("Night Owl" → "ext-night-owl"). */
function themeSlug(label: string): string {
  return `ext-${label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}
