// What "New tab" can open in a group (the group menu's New tab, `layout.newTab`): a file, a
// terminal, a browser page, the agent, settings… One list for the menu and the quick pick.
import type { IconName } from "../../ui/Icon";

export const NEW_TAB_KINDS = [
  "file",
  "open",
  "terminal",
  "browser",
  "agent",
  "problems",
  "settings",
  "keybindings",
  "models",
  "docs",
  "debugConsole",
  "welcome",
] as const;
export type NewTabKind = (typeof NEW_TAB_KINDS)[number];

export interface NewTabEntry {
  kind: NewTabKind;
  label: string;
  icon: IconName;
  /** Command whose keybinding is shown next to the entry. */
  shortcutOf?: string;
  /** The dock view it opens when that isn't `kind` (left out when nothing registered it). */
  viewType?: string;
  /** The app's logo instead of `icon`. */
  logo?: boolean;
}

/** A tool New tab can open besides the built-in kinds: an extension's view or page (D181). */
export interface NewTabTool {
  owner: string;
  label: string;
  icon: IconName;
  command: string;
  input?: unknown;
}

export const NEW_TAB_ENTRIES: readonly NewTabEntry[] = [
  { kind: "file", label: "New file…", icon: "file-plus", shortcutOf: "explorer.newFile" },
  { kind: "open", label: "Open file…", icon: "search", shortcutOf: "quickOpen.show" },
  { kind: "terminal", label: "Terminal", icon: "square-terminal", shortcutOf: "terminal.create" },
  { kind: "browser", label: "Browser", icon: "globe", shortcutOf: "browser.open" },
  { kind: "agent", label: "Agent chat", icon: "agent" },
  { kind: "problems", label: "Problems", icon: "circle-alert", shortcutOf: "problems.show" },
  { kind: "settings", label: "Settings", icon: "settings", shortcutOf: "settings.open" },
  { kind: "keybindings", label: "Keyboard shortcuts", icon: "keyboard" },
  // Every other page the IDE opens in a tab (D185); extensions' tools follow these.
  {
    kind: "models",
    label: "Customize (AI)",
    icon: "sliders-horizontal",
    viewType: "agent.customize",
  },
  { kind: "docs", label: "Documentation", icon: "book-open", viewType: "docs" },
  { kind: "debugConsole", label: "Debug console", icon: "bug-play", viewType: "debugConsole" },
  { kind: "welcome", label: "Welcome", icon: "layout-dashboard", logo: true },
];

/** The view a New tab kind opens. */
export const viewTypeOf = (kind: NewTabKind): string =>
  NEW_TAB_ENTRIES.find((e) => e.kind === kind)?.viewType ?? kind;

/** The entries whose page exists in this window (an agent-less build has no AI models page). */
export const availableEntries = (has: (viewType: string) => boolean): NewTabEntry[] =>
  NEW_TAB_ENTRIES.filter((e) => !e.viewType || has(e.viewType));
