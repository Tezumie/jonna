// Shiki's bundled color themes (D132) as color themes: picked like an extension's theme (Color
// theme…), each a lazy chunk loaded only when chosen. They're VS Code theme JSON, so they color
// the whole IDE (UI colors mapped by the theme importer) and the editor's syntax. Dark+ / Light+
// are the built-in Dark and Light themes; Claude Dark (D268) is ours, in the same format.
import type { DisposableStore } from "../../core/lifecycle/index";
import type { WorkbenchServices } from "../../workbench/services";

type ThemeModule = { default: unknown };

// biome-ignore format: one theme per line is easier to scan
const SHIKI_THEMES: [label: string, kind: "dark" | "light", load: () => Promise<ThemeModule>][] = [
  ["Andromeeda", "dark", () => import("shiki/themes/andromeeda.mjs")],
  ["Aurora X", "dark", () => import("shiki/themes/aurora-x.mjs")],
  ["Ayu Dark", "dark", () => import("shiki/themes/ayu-dark.mjs")],
  ["Ayu Light", "light", () => import("shiki/themes/ayu-light.mjs")],
  ["Ayu Mirage", "dark", () => import("shiki/themes/ayu-mirage.mjs")],
  ["Catppuccin Frappé", "dark", () => import("shiki/themes/catppuccin-frappe.mjs")],
  ["Catppuccin Latte", "light", () => import("shiki/themes/catppuccin-latte.mjs")],
  ["Catppuccin Macchiato", "dark", () => import("shiki/themes/catppuccin-macchiato.mjs")],
  ["Catppuccin Mocha", "dark", () => import("shiki/themes/catppuccin-mocha.mjs")],
  ["Dracula Theme Soft", "dark", () => import("shiki/themes/dracula-soft.mjs")],
  ["Dracula Theme", "dark", () => import("shiki/themes/dracula.mjs")],
  ["Everforest Dark", "dark", () => import("shiki/themes/everforest-dark.mjs")],
  ["Everforest Light", "light", () => import("shiki/themes/everforest-light.mjs")],
  ["GitHub Dark Default", "dark", () => import("shiki/themes/github-dark-default.mjs")],
  ["GitHub Dark Dimmed", "dark", () => import("shiki/themes/github-dark-dimmed.mjs")],
  ["GitHub Dark High Contrast", "dark", () => import("shiki/themes/github-dark-high-contrast.mjs")],
  ["GitHub Dark", "dark", () => import("shiki/themes/github-dark.mjs")],
  ["GitHub Light Default", "light", () => import("shiki/themes/github-light-default.mjs")],
  ["GitHub Light High Contrast", "light", () => import("shiki/themes/github-light-high-contrast.mjs")],
  ["GitHub Light", "light", () => import("shiki/themes/github-light.mjs")],
  ["Gruvbox Dark Hard", "dark", () => import("shiki/themes/gruvbox-dark-hard.mjs")],
  ["Gruvbox Dark Medium", "dark", () => import("shiki/themes/gruvbox-dark-medium.mjs")],
  ["Gruvbox Dark Soft", "dark", () => import("shiki/themes/gruvbox-dark-soft.mjs")],
  ["Gruvbox Light Hard", "light", () => import("shiki/themes/gruvbox-light-hard.mjs")],
  ["Gruvbox Light Medium", "light", () => import("shiki/themes/gruvbox-light-medium.mjs")],
  ["Gruvbox Light Soft", "light", () => import("shiki/themes/gruvbox-light-soft.mjs")],
  ["Horizon Bright", "light", () => import("shiki/themes/horizon-bright.mjs")],
  ["Horizon", "dark", () => import("shiki/themes/horizon.mjs")],
  ["Houston", "dark", () => import("shiki/themes/houston.mjs")],
  ["Kanagawa Dragon", "dark", () => import("shiki/themes/kanagawa-dragon.mjs")],
  ["Kanagawa Lotus", "light", () => import("shiki/themes/kanagawa-lotus.mjs")],
  ["Kanagawa Wave", "dark", () => import("shiki/themes/kanagawa-wave.mjs")],
  ["LaserWave", "dark", () => import("shiki/themes/laserwave.mjs")],
  ["Material Theme Darker", "dark", () => import("shiki/themes/material-theme-darker.mjs")],
  ["Material Theme Lighter", "light", () => import("shiki/themes/material-theme-lighter.mjs")],
  ["Material Theme Ocean", "dark", () => import("shiki/themes/material-theme-ocean.mjs")],
  ["Material Theme Palenight", "dark", () => import("shiki/themes/material-theme-palenight.mjs")],
  ["Material Theme", "dark", () => import("shiki/themes/material-theme.mjs")],
  ["Min Dark", "dark", () => import("shiki/themes/min-dark.mjs")],
  ["Min Light", "light", () => import("shiki/themes/min-light.mjs")],
  ["Monokai", "dark", () => import("shiki/themes/monokai.mjs")],
  ["Night Owl Light", "light", () => import("shiki/themes/night-owl-light.mjs")],
  ["Night Owl", "dark", () => import("shiki/themes/night-owl.mjs")],
  ["Nord", "dark", () => import("shiki/themes/nord.mjs")],
  ["One Dark Pro", "dark", () => import("shiki/themes/one-dark-pro.mjs")],
  ["One Light", "light", () => import("shiki/themes/one-light.mjs")],
  ["Plastic", "dark", () => import("shiki/themes/plastic.mjs")],
  ["Poimandres", "dark", () => import("shiki/themes/poimandres.mjs")],
  ["Red", "dark", () => import("shiki/themes/red.mjs")],
  ["Rosé Pine Dawn", "light", () => import("shiki/themes/rose-pine-dawn.mjs")],
  ["Rosé Pine Moon", "dark", () => import("shiki/themes/rose-pine-moon.mjs")],
  ["Rosé Pine", "dark", () => import("shiki/themes/rose-pine.mjs")],
  ["Slack Dark", "dark", () => import("shiki/themes/slack-dark.mjs")],
  ["Slack Ochin", "light", () => import("shiki/themes/slack-ochin.mjs")],
  ["Snazzy Light", "light", () => import("shiki/themes/snazzy-light.mjs")],
  ["Solarized Dark", "dark", () => import("shiki/themes/solarized-dark.mjs")],
  ["Solarized Light", "light", () => import("shiki/themes/solarized-light.mjs")],
  ["Synthwave '84", "dark", () => import("shiki/themes/synthwave-84.mjs")],
  ["Tokyo Night", "dark", () => import("shiki/themes/tokyo-night.mjs")],
  ["Vesper", "dark", () => import("shiki/themes/vesper.mjs")],
  ["Vitesse Black", "dark", () => import("shiki/themes/vitesse-black.mjs")],
  ["Vitesse Dark", "dark", () => import("shiki/themes/vitesse-dark.mjs")],
  ["Vitesse Light", "light", () => import("shiki/themes/vitesse-light.mjs")],
];

export function registerShikiThemes(sub: DisposableStore, services: WorkbenchServices): void {
  sub.add(
    services.contributions.addThemes([
      {
        label: "Claude Dark",
        kind: "dark",
        source: "built-in",
        load: async () => (await import("../../core/themes/claudeDark")).CLAUDE_DARK,
      },
      ...SHIKI_THEMES.map(([label, kind, load]) => ({
        label,
        kind,
        source: "Shiki",
        load: async () => (await load()).default,
      })),
    ]),
  );
}
