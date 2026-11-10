// The keyboard shortcuts reference (Help → Keyboard shortcuts reference): VS Code links a PDF per
// platform; the IDE builds the same page from its own keybinding table, so the keys are this
// platform's and include the user's changes. The sections follow VS Code's sheet. The editor's
// own keys (Monaco's: move line, multi-cursor, comment…) aren't in the keybinding table, so they
// come from a fixed list of Monaco's defaults. DOM-free and tested.
import type { EffectiveBinding } from "../../core/keybindings/effective";
import { keybindingLabel, type Platform, parseKeybinding } from "../../core/keybindings/keys";

/** A row: a command from the keybinding table, or one of the editor's own keys. */
type ReferenceEntry =
  | { command: string; label?: string }
  | { key: string; mac?: string; label: string };

export interface ReferenceRow {
  label: string;
  /** Key labels for this platform ("Ctrl+Shift+P", "⇧⌘P"), one per binding. */
  keys: string[];
}

export interface ReferenceSection {
  title: string;
  rows: ReferenceRow[];
}

const SECTIONS: readonly { title: string; entries: readonly ReferenceEntry[] }[] = [
  {
    title: "General",
    entries: [
      { command: "palette.show", label: "Show all commands" },
      { command: "quickOpen.show", label: "Quick open, go to file" },
      { command: "workbench.newWindow", label: "New window" },
      { command: "settings.open", label: "Settings" },
      { command: "keybindings.show", label: "Keyboard shortcuts" },
      { command: "layout.focusAgent", label: "Agent" },
    ],
  },
  {
    title: "Basic editing",
    entries: [
      { key: "ctrl+x", mac: "cmd+x", label: "Cut line (empty selection)" },
      { key: "ctrl+c", mac: "cmd+c", label: "Copy line (empty selection)" },
      { key: "alt+up", label: "Move line up" },
      { key: "alt+down", label: "Move line down" },
      { key: "shift+alt+down", label: "Copy line down" },
      { key: "shift+alt+up", label: "Copy line up" },
      { key: "ctrl+shift+k", mac: "shift+cmd+k", label: "Delete line" },
      { key: "ctrl+enter", mac: "cmd+enter", label: "Insert line below" },
      { key: "ctrl+shift+enter", mac: "shift+cmd+enter", label: "Insert line above" },
      { key: "ctrl+shift+\\", mac: "shift+cmd+\\", label: "Jump to matching bracket" },
      { key: "ctrl+]", mac: "cmd+]", label: "Indent line" },
      { key: "ctrl+[", mac: "cmd+[", label: "Outdent line" },
      { key: "ctrl+home", mac: "cmd+up", label: "Go to beginning of file" },
      { key: "ctrl+end", mac: "cmd+down", label: "Go to end of file" },
      { key: "ctrl+shift+[", mac: "alt+cmd+[", label: "Fold region" },
      { key: "ctrl+shift+]", mac: "alt+cmd+]", label: "Unfold region" },
      { key: "ctrl+k ctrl+0", mac: "cmd+k cmd+0", label: "Fold all regions" },
      { key: "ctrl+k ctrl+j", mac: "cmd+k cmd+j", label: "Unfold all regions" },
      { key: "ctrl+/", mac: "cmd+/", label: "Toggle line comment" },
      { key: "shift+alt+a", label: "Toggle block comment" },
      { command: "editor.save", label: "Save" },
      { command: "editor.saveAll", label: "Save all" },
    ],
  },
  {
    title: "Navigation",
    entries: [
      { command: "quickOpen.goToWorkspaceSymbol", label: "Go to symbol in workspace" },
      { command: "quickOpen.goToSymbol", label: "Go to symbol in file" },
      { command: "editor.gotoLine", label: "Go to line" },
      { command: "quickOpen.switchEditor", label: "Switch editor" },
      { command: "problems.show", label: "Show problems" },
      { key: "f8", label: "Go to next problem" },
      { key: "shift+f8", label: "Go to previous problem" },
    ],
  },
  {
    title: "Search and replace",
    entries: [
      { key: "ctrl+f", mac: "cmd+f", label: "Find" },
      { key: "ctrl+h", mac: "alt+cmd+f", label: "Replace" },
      { key: "f3", mac: "cmd+g", label: "Find next" },
      { key: "shift+f3", mac: "shift+cmd+g", label: "Find previous" },
      { key: "alt+enter", label: "Select all matches of Find" },
      { key: "ctrl+d", mac: "cmd+d", label: "Add selection to next match" },
      { command: "search.show", label: "Search in files" },
    ],
  },
  {
    title: "Multi-cursor and selection",
    entries: [
      { key: "ctrl+alt+up", mac: "alt+cmd+up", label: "Insert cursor above" },
      { key: "ctrl+alt+down", mac: "alt+cmd+down", label: "Insert cursor below" },
      { key: "ctrl+u", mac: "cmd+u", label: "Undo last cursor operation" },
      { key: "shift+alt+i", label: "Insert cursor at end of each selected line" },
      { key: "ctrl+shift+l", mac: "shift+cmd+l", label: "Select all occurrences of selection" },
      { key: "ctrl+f2", mac: "cmd+f2", label: "Select all occurrences of word" },
      { key: "shift+alt+right", mac: "ctrl+shift+cmd+right", label: "Expand selection" },
      { key: "shift+alt+left", mac: "ctrl+shift+cmd+left", label: "Shrink selection" },
    ],
  },
  {
    title: "Rich languages editing",
    entries: [
      { key: "ctrl+space", label: "Trigger suggestion" },
      { key: "ctrl+shift+space", mac: "shift+cmd+space", label: "Trigger parameter hints" },
      { key: "shift+alt+f", label: "Format document" },
      { key: "ctrl+k ctrl+f", mac: "cmd+k cmd+f", label: "Format selection" },
      { key: "f12", label: "Go to definition" },
      { key: "alt+f12", label: "Peek definition" },
      { key: "ctrl+.", mac: "cmd+.", label: "Quick fix" },
      { key: "shift+f12", label: "Show references" },
      { key: "f2", label: "Rename symbol" },
    ],
  },
  {
    title: "Editor management",
    entries: [
      { command: "layout.closeTab", label: "Close editor" },
      { command: "layout.reopenClosedTab", label: "Reopen closed editor" },
      { command: "layout.splitActive", label: "Split editor" },
      { command: "layout.focusGroup.left", label: "Focus the group on the left" },
      { command: "layout.focusGroup.right", label: "Focus the group on the right" },
      { command: "layout.moveTabToGroup.right", label: "Move editor into the next group" },
      { command: "layout.nextTab", label: "Next editor" },
      { command: "layout.previousTab", label: "Previous editor" },
    ],
  },
  {
    title: "File management",
    entries: [
      { command: "workspace.newUntitledFile", label: "New file" },
      { command: "workspace.openFolder", label: "Open folder" },
      { command: "viewer.togglePreview", label: "Toggle Markdown preview" },
      { command: "viewer.openPreviewToSide", label: "Open preview to the side" },
    ],
  },
  {
    title: "Display",
    entries: [
      { command: "layout.toggleSidebar", label: "Toggle side bar" },
      { command: "layout.togglePanel", label: "Toggle panel" },
      { command: "layout.toggleZenMode", label: "Zen mode" },
      { command: "window.zoomIn", label: "Zoom in" },
      { command: "window.zoomOut", label: "Zoom out" },
      { command: "explorer.focus", label: "Show explorer" },
      { command: "search.show", label: "Show search" },
      { command: "git.showView", label: "Show source control" },
      { command: "debug.showView", label: "Show run and debug" },
      { command: "extensions.show", label: "Show extensions" },
    ],
  },
  {
    title: "Debug",
    entries: [
      { command: "debug.toggleBreakpoint", label: "Toggle breakpoint" },
      { command: "debug.start", label: "Start or continue" },
      { command: "debug.runWithoutDebugging", label: "Run without debugging" },
      { command: "debug.stop", label: "Stop" },
      { command: "debug.stepInto", label: "Step into" },
      { command: "debug.stepOut", label: "Step out" },
      { command: "debug.stepOver", label: "Step over" },
      { command: "debug.showConsole", label: "Show debug console" },
    ],
  },
  {
    title: "Terminal and tasks",
    entries: [
      { command: "terminal.toggle", label: "Show terminal" },
      { command: "terminal.create", label: "New terminal" },
      { command: "terminal.split", label: "Split terminal" },
      { command: "terminal.scrollToPreviousCommand", label: "Scroll to the previous command" },
      { command: "terminal.scrollToNextCommand", label: "Scroll to the next command" },
      { command: "tasks.runBuild", label: "Run build task" },
    ],
  },
];

/**
 * The reference's sections with this platform's keys. `bindings` is the effective table (so the
 * user's own keys show); rows whose command has no key, or isn't registered, are left out.
 */
export function buildReference(
  bindings: readonly EffectiveBinding[],
  platform: Platform,
  options: {
    title?: (command: string) => string | undefined;
    has?: (command: string) => boolean;
  } = {},
): ReferenceSection[] {
  const keysOf = new Map<string, string[]>();
  for (const b of bindings) {
    const list = keysOf.get(b.command) ?? [];
    if (!list.includes(b.label)) list.push(b.label);
    keysOf.set(b.command, list);
  }
  return SECTIONS.map((section) => ({
    title: section.title,
    rows: section.entries.flatMap((entry): ReferenceRow[] => {
      if ("command" in entry) {
        if (options.has && !options.has(entry.command)) return [];
        const keys = keysOf.get(entry.command);
        if (!keys?.length) return [];
        const label = entry.label ?? options.title?.(entry.command) ?? entry.command;
        return [{ label, keys }];
      }
      const key = platform === "mac" && entry.mac ? entry.mac : entry.key;
      return [{ label: entry.label, keys: [keybindingLabel(parseKeybinding(key), platform)] }];
    }),
  })).filter((s) => s.rows.length > 0);
}

/** The reference as plain text (for agents, and copying). */
export function referenceText(sections: readonly ReferenceSection[]): string {
  return sections
    .map((s) => [s.title, ...s.rows.map((r) => `  ${r.keys.join(" or ")}  ${r.label}`)].join("\n"))
    .join("\n\n");
}
