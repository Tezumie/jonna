// Which commands change the IDE itself (D176): its layout, views and windows, theme, settings,
// keybindings and extensions. When an agent runs one, the user is asked even in full-access mode
// (the agent rearranging panels or loading an extension is surprising however much it may do to
// files), and "Allow for this chat" covers every one of them for that chat. Reading never asks;
// opening files, the browser, terminals and the debugger follow the usual rules. DOM-free.

/** Command id prefixes that change the IDE itself. */
const PREFIXES = [
  "layout.",
  "view.",
  "views.",
  "workbench.",
  "window.",
  "ui.",
  "theme.",
  "settings.",
  "keybindings.",
  "extensions.",
  "statusBar.",
  "activityBar.",
  "panel.",
  "sidebar.",
  "zenMode.",
  "notifications.",
];

/** Elsewhere: commands that change a setting or how the IDE looks. */
const ALSO = new Set(["explorer.toggleExcludedFiles", "git.toggleInlineBlame"]);

/** Within those prefixes: commands that only show something, or only read. */
const EXEMPT = new Set([
  "ui.openLink",
  "settings.get",
  "view.show",
  "extensions.list",
  "extensions.guide",
  "extensions.listFiles",
  "extensions.readFile",
  "extensions.folderStatus",
  "extensions.listIcons",
  "extensions.showLog",
  "workbench.screenshot",
]);

export function isIdeControl(commandId: string, effects: readonly string[]): boolean {
  if (EXEMPT.has(commandId)) return false;
  if (effects.length && effects.every((e) => e === "read")) return false;
  return ALSO.has(commandId) || PREFIXES.some((p) => commandId.startsWith(p));
}

/** The session grant's key: one "allow for this chat" covers all IDE control. */
export const IDE_CONTROL_GRANT = "\0ide-control";
