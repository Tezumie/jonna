// Diagnostics (D204, Rust: src-tauri/src/ipc/diagnostics.rs): the session log, the problem
// report's zip, starting with extensions off, and what this start knows about the last one.
import { call, isTauri } from "./invoke";

export interface SessionInfo {
  /** This session's log file, and the folder of session logs. */
  logFile: string;
  logsDir: string;
  /** This session's output channel files (D209). */
  channelsDir: string;
  /** Why extensions are off for this session ("commandLine": --disable-extensions). */
  extensionsOff: "commandLine" | "restart" | null;
  /** The next start differs: "off" (extensions off) or "on". */
  nextStart: "off" | "on" | null;
  /** The version that ran before this one (null on a first start). */
  previousVersion: string | null;
}

export interface LogEntry {
  level: "error" | "warn" | "info" | "debug" | "trace";
  source: string;
  message: string;
  /** An output channel's own file (D209); the session log without. */
  channel?: string;
}

export interface ReportFile {
  name: string;
  text?: string;
  /** Binary contents as base64 (the screenshot). */
  base64?: string;
}

let cached: Promise<SessionInfo | null> | null = null;

export const sessionIpc = {
  /** Fresh each call (the next-start flag can change). */
  info: (): Promise<SessionInfo | null> =>
    isTauri() ? call<SessionInfo>("session_info") : Promise.resolve(null),
  /** Read once: whether this session runs with extensions off. */
  extensionsOff: async (): Promise<boolean> => {
    cached ??= sessionIpc.info().catch(() => null);
    return !!(await cached)?.extensionsOff;
  },
  /**
   * Sets how the next start runs (true: extensions off, false: on, null: as usual) and restarts
   * when `restart`. Returns whether the app restarts (test runs never do).
   */
  relaunch: (extensionsOff: boolean | null, restart: boolean): Promise<boolean> =>
    call<boolean>("app_relaunch", { extensionsOff, restart }),
};

export const logIpc = {
  write: (entries: LogEntry[]): Promise<void> =>
    isTauri() ? call<void>("log_write", { entries }) : Promise.resolve(),
  /** The session log's last `max` records (already redacted). */
  recent: (max: number): Promise<string[]> =>
    isTauri() ? call<string[]>("log_recent", { max }) : Promise.resolve([]),
  /** The git command lines run after `after` (seq), oldest first, redacted (the Git channel). */
  gitCommands: (after: number): Promise<GitCall[]> =>
    isTauri() ? call<GitCall[]>("log_git_commands", { after }) : Promise.resolve([]),
};

/** A git command line the IDE ran (Rust: git/journal.rs). */
export interface GitCall {
  seq: number;
  /** The arguments after `git`. */
  args: string[];
  ms: number;
  /** git's error, or null when it succeeded. */
  error: string | null;
}

export const reportIpc = {
  /** Writes the report's files as a zip at `path` (picked in the save dialog). */
  saveZip: (path: string, files: ReportFile[]): Promise<void> =>
    call<void>("report_save_zip", { path, files }),
};
