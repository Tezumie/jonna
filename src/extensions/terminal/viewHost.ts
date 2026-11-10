// What terminal tabs and their panes need from the extension (index.ts builds it), and the tab
// colors and icons a terminal can have. Shared by view.ts (the tab) and pane.ts (one terminal).
import type { ContextKeyService } from "../../core/context/index";
import type { Disposable } from "../../core/lifecycle/index";
import type { IconName } from "../../ui/Icon";
import type { TerminalPane } from "./pane";
import type { TerminalAppearance, TerminalService, TerminalStart } from "./service";
import type { SplitDirection } from "./split";
import type { SuggestHost } from "./suggestWidget";
import type { TerminalView } from "./view";

export interface TerminalViewHost {
  readonly terminals: TerminalService;
  readonly context: ContextKeyService;
  /** Every live pane (one terminal each), by its uid. */
  readonly views: Map<string, TerminalPane>;
  /** Every terminal tab (one or more panes), by tab id. */
  readonly tabs: Map<string, TerminalView>;
  /** Folder new shells start in when the state has no cwd. */
  defaultCwd(): string | null;
  appearance(): TerminalAppearance;
  /** `terminal.bell`: what BEL does. */
  bellMode(): "none" | "visual" | "sound";
  /** `terminal.shellIntegration.enabled`. */
  shellIntegration(): boolean;
  /** `terminal.splitDirection`: how a split tab lays its terminals out. */
  splitDirection(): SplitDirection;
  run(command: string, input?: unknown): void;
  /** Another dock tab dropped on `element`'s middle goes to `drop` (workbench tabDropTarget). */
  tabDropTarget(
    element: HTMLElement,
    accepts: (tab: { tabId: string; viewType: string }) => boolean,
    drop: (tabId: string) => void,
  ): Disposable;
  /** The agent is there to ask (D124: "Fix with agent" on a failed command). */
  canFix(): boolean;
  /** `terminal.rightClickBehavior`: the IDE's menu, or Windows Terminal's copy / paste. */
  rightClickBehavior(): "menu" | "copyPaste";
  keybinding(command: string): string | undefined;
  readonly isMac: boolean;
  /**
   * How a pane's shell starts (D204): the profile (`profile` from the state, else the default
   * profile) and the last session's output saved under `restoreKey` (a restored pane). With
   * `reattach` (the pane's process before a page reload, m7.12) it says to take that back, with
   * the screen saved under the same key.
   */
  startFor(
    restoreKey: string,
    profile: string | undefined,
    reattach?: { id: number; key: string } | null,
  ): Promise<TerminalStart>;
  /** Data for the command suggestions (D204); null turns them off for this terminal. */
  suggestHost(): SuggestHost | null;
}

/** Tab colors and icons a terminal can be given (VS Code's terminal.tabs color / icon). */
export const TERMINAL_COLORS = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const;
export const TERMINAL_ICONS = [
  "square-terminal",
  "terminal",
  "globe",
  "bot",
  "box",
  "git-branch",
  "radio-tower",
  "zap",
  "star",
  "bookmark",
] as const satisfies readonly IconName[];
export type TerminalColor = (typeof TERMINAL_COLORS)[number];
export type TerminalIcon = (typeof TERMINAL_ICONS)[number];
