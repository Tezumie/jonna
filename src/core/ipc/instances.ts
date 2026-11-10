// Windows across processes and the command line (D209; Rust: src-tauri/src/instances): files other
// launches hand to this window (`<cli> file:line`, `--diff`, `--wait`), the window that already
// has a folder open, the last session's windows, and the shell command in PATH.
import { Channel, call } from "./invoke";

export interface CliFile {
  path: string;
  line: number | null;
  column: number | null;
  /** It doesn't exist yet: opens as an untitled editor that saves there (VS Code). */
  missing?: boolean;
}

/** Something another launch (or this process's own command line) asks this window to open. */
export interface OpenRequest {
  id: number;
  files: CliFile[];
  /** `--diff a b`: [left, right]. */
  diff: [string, string] | null;
  /** The launch waits until the tabs are closed (`--wait`): call `done(id)` then. */
  wait: boolean;
  /**
   * Folders to add to this window's workspace (`--add <folder>`, absolute). Rust always sends it
   * (empty when none); optional so requests built in the frontend needn't name it.
   */
  add?: string[];
  /** A link to the IDE for an extension's URI handler (D255: the OS opened `<scheme>://…`). */
  url?: string | null;
}

/** What the last session leaves for the first window of this one to reopen. */
export interface Restorable {
  /** The last session's windows' folders, the most recently used first. */
  folders: string[];
  /** Empty windows that kept unsaved untitled text (backup ids), the most recent first. */
  empty: string[];
}

/** "Install shell command in PATH": what it does and whether it's done. */
export interface ShellCommandInfo {
  name: string;
  path: string;
  target: string;
  folder: string;
  onPath: boolean;
  installed: boolean;
  steps: string[];
  note: string | null;
}

/** The taskbar jump list (Windows): recent folders and the "New window" task. */
export interface JumpList {
  folders: { path: string; title: string }[];
  /** The recent folders' heading. */
  category: string;
  /** The task's title. */
  newWindow: string;
}

export interface JumpListResult {
  /** Folders the user removed from the jump list (they leave the recent list too). */
  removed: string[];
  /** False where there's no jump list (macOS, Linux, test runs). */
  applied: boolean;
}

export const instancesIpc = {
  /** Requests come to `onOpen` from now on (those that came before arrive at once). */
  listen: (onOpen: (request: OpenRequest) => void): Promise<void> =>
    call<void>("instances_listen", { onOpen: new Channel<OpenRequest>(onOpen) }),
  /** The tabs of request `id` are closed: its `--wait` launch returns. */
  done: (id: number): Promise<void> => call<void>("instances_done", { id }),
  /** Brings the other window with `folder` open to the front; false when no window has it. */
  focusFolder: (folder: string): Promise<boolean> =>
    call<boolean>("instances_focus_folder", { folder }),
  /** The last session's windows (window.restoreWindows "all"), once: folders and empty windows. */
  restorable: (): Promise<Restorable> => call<Restorable>("instances_restorable"),
  /** This window becomes the last session's empty window `id` (one `restorable` handed out). */
  adoptEmpty: (id: string): Promise<void> => call<void>("instances_adopt_empty", { id }),
  /** Starts a window for the last session's empty window `id`, with its unsaved text. */
  restoreEmptyWindow: (id: string): Promise<boolean> =>
    call<boolean>("app_new_window", { folder: null, env: null, tag: null, empty: id }),
  /** The unsaved untitled text this window kept while it had no folder (JSON), or null. */
  emptyBackupsLoad: (): Promise<string | null> =>
    call<string | null>("instances_empty_backups_load"),
  /** Keeps this empty window's unsaved text for the next start; null removes it. */
  emptyBackupsSave: (json: string | null): Promise<void> =>
    call<void>("instances_empty_backups_save", { json }),
  /** Whether another window of the IDE runs (closing this one doesn't end the session). */
  othersRunning: (): Promise<boolean> => call<boolean>("instances_others_running"),
  shellCommandPlan: (): Promise<ShellCommandInfo> => call<ShellCommandInfo>("shell_command_plan"),
  installShellCommand: (): Promise<ShellCommandInfo> =>
    call<ShellCommandInfo>("shell_command_install"),
  uninstallShellCommand: (): Promise<ShellCommandInfo> =>
    call<ShellCommandInfo>("shell_command_uninstall"),
  /** Replaces the taskbar's jump list (Windows only; elsewhere `applied: false`). */
  setJumpList: (list: JumpList): Promise<JumpListResult> =>
    call<JumpListResult>("jump_list_set", { list }),
};
