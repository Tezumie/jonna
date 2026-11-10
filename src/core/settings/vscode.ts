// VS Code settings → the IDE's. Most keys are the same (editor.*, files.*, workbench.*); a few
// have other names (terminal.integrated.*) or other values (editor.wordWrap "bounded",
// workbench.colorTheme names). Used for a folder's `.vscode/settings.json` (read as a layer under
// the IDE's own workspace settings) and for importing VS Code's user settings. DOM-free, tested.
import { isLanguageOverrideKey } from "./languageOverrides";

/** VS Code key → IDE key, where they differ. */
const ALIASES: Record<string, string> = {
  "terminal.integrated.fontSize": "terminal.fontSize",
  "terminal.integrated.shellIntegration.enabled": "terminal.shellIntegration.enabled",
  "terminal.integrated.enableBell": "terminal.bell",
  "terminal.integrated.enableVisualBell": "terminal.bell",
  // Terminal profiles, sessions, suggestions and rendering (D204).
  "terminal.integrated.profiles.windows": "terminal.profiles.windows",
  "terminal.integrated.profiles.osx": "terminal.profiles.osx",
  "terminal.integrated.profiles.linux": "terminal.profiles.linux",
  "terminal.integrated.defaultProfile.windows": "terminal.defaultProfile.windows",
  "terminal.integrated.defaultProfile.osx": "terminal.defaultProfile.osx",
  "terminal.integrated.defaultProfile.linux": "terminal.defaultProfile.linux",
  "terminal.integrated.enablePersistentSessions": "terminal.enablePersistentSessions",
  "terminal.integrated.persistentSessionScrollback": "terminal.persistentSessionScrollback",
  "terminal.integrated.suggest.enabled": "terminal.suggest.enabled",
  "terminal.integrated.gpuAcceleration": "terminal.gpuAcceleration",
  // The shell of tasks and debug launches (D209).
  "terminal.integrated.automationProfile.windows": "terminal.automationProfile.windows",
  "terminal.integrated.automationProfile.osx": "terminal.automationProfile.osx",
  "terminal.integrated.automationProfile.linux": "terminal.automationProfile.linux",
  // The terminal's look and behavior (D379: these were dropped, though the IDE has them).
  "terminal.integrated.fontFamily": "terminal.fontFamily",
  "terminal.integrated.lineHeight": "terminal.lineHeight",
  "terminal.integrated.cursorStyle": "terminal.cursorStyle",
  "terminal.integrated.cursorBlinking": "terminal.cursorBlinking",
  "terminal.integrated.scrollback": "terminal.scrollback",
  "terminal.integrated.copyOnSelection": "terminal.copyOnSelection",
  "terminal.integrated.rightClickBehavior": "terminal.rightClickBehavior",
  "terminal.integrated.minimumContrastRatio": "terminal.minimumContrastRatio",
  "terminal.integrated.sendKeybindingsToShell": "terminal.sendKeybindingsToShell",
  "workbench.colorTheme": "workbench.colorTheme",
  "editor.minimap.enabled": "editor.minimap.enabled",
  "breadcrumbs.enabled": "breadcrumbs.enabled",
  "explorer.autoReveal": "explorer.autoReveal",
};

/** Value conversions for keys whose VS Code values differ from the IDE's. */
const VALUES: Record<string, (v: unknown, key: string) => unknown> = {
  "editor.wordWrap": (v) => (v === "off" ? "off" : typeof v === "string" ? "on" : undefined),
  // VS Code's default themes are the built-in Dark+ / Light+; other names stay (an installed
  // theme with that label applies, else the built-in one of the kind the name suggests).
  "workbench.colorTheme": (v) => {
    if (typeof v !== "string") return undefined;
    if (
      /^(default |visual studio )?(dark|light)( ?\+| modern| \(visual studio\))?$/i.test(
        v.trim(),
      ) ||
      /^default (dark|light)/i.test(v)
    )
      return /light/i.test(v) ? "Light+" : "Dark+";
    return v;
  },
  "terminal.bell": (v, key) =>
    v === true
      ? key.endsWith("VisualBell")
        ? "visual"
        : "sound"
      : v === false
        ? "none"
        : undefined,
  // VS Code's null default profile is the IDE's empty one; its old "canvas" renderer is "auto".
  "terminal.defaultProfile.windows": (v) => (v === null ? "" : v),
  "terminal.defaultProfile.osx": (v) => (v === null ? "" : v),
  "terminal.defaultProfile.linux": (v) => (v === null ? "" : v),
  "terminal.gpuAcceleration": (v) => (v === "canvas" ? "auto" : v),
  // VS Code's null automation profile is the IDE's empty one (the default shell).
  "terminal.automationProfile.windows": (v) => (v === null ? {} : v),
  "terminal.automationProfile.osx": (v) => (v === null ? {} : v),
  "terminal.automationProfile.linux": (v) => (v === null ? {} : v),
  "files.eol": (v) => (v === "\n" || v === "\r\n" || v === "auto" ? v : undefined),
  // VS Code's "line" cursor is the IDE's "bar"; its "default" right-click is the menu.
  "terminal.cursorStyle": (v) => (v === "line" ? "bar" : v),
  "terminal.rightClickBehavior": (v) =>
    v === "default" ? "menu" : v === "copyPaste" ? "copyPaste" : undefined,
  "editor.lineNumbers": (v) => (v === "interval" ? "on" : v),
};

export interface Translated {
  values: Record<string, unknown>;
  /** VS Code keys the IDE doesn't know (left out). */
  skipped: string[];
}

/**
 * Translates a VS Code settings object. Language-specific blocks (`"[python]": {…}`) are kept with
 * their inner keys translated the same way (a block left with none is skipped; skipped inner keys
 * are reported as `[python] key`). `known(key)` says whether the IDE has a setting by that name.
 */
export function translateVscodeSettings(
  input: Record<string, unknown>,
  known: (key: string) => boolean,
): Translated {
  const values: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, raw] of Object.entries(input)) {
    if (isLanguageOverrideKey(key)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        skipped.push(key);
        continue;
      }
      const inner = translateVscodeSettings(raw as Record<string, unknown>, known);
      for (const k of inner.skipped) skipped.push(`${key} ${k}`);
      if (Object.keys(inner.values).length) values[key] = inner.values;
      else if (!inner.skipped.length) skipped.push(key);
      continue;
    }
    if (key.startsWith("[")) {
      skipped.push(key);
      continue;
    }
    const target = ALIASES[key] ?? key;
    if (!known(target)) {
      skipped.push(key);
      continue;
    }
    const convert = VALUES[target];
    const value = convert ? convert(raw, key) : raw;
    if (value === undefined) {
      skipped.push(key);
      continue;
    }
    values[target] = value;
  }
  return { values, skipped };
}
