// Log levels of extensions' log output channels (VS Code's "Developer: Set Log Level…"): a default
// for every channel and one per channel (by its Output channel id), picked by the user and kept
// across sessions. A log channel writes only lines at or above its level (VS Code's
// LogOutputChannel.logLevel); the extension hears changes (onDidChangeLogLevel, and
// env.onDidChangeLogLevel for the default). DOM-free and unit-tested.
import { type Signal, signal } from "../reactive/index";

/** The levels, quietest last as VS Code's LogLevel numbers them (Off 0 … Error 5). */
export const LOG_LEVELS = ["off", "trace", "debug", "info", "warning", "error"] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

/** VS Code's default level. */
export const DEFAULT_LOG_LEVEL: LogLevelName = "info";

/** The key of the default level (a channel id never is: those start with "ext."). */
export const DEFAULT_KEY = "default";

/** At most this many channel levels are kept (old channels' levels go first). */
const MAX_LEVELS = 200;

export function isLogLevel(v: unknown): v is LogLevelName {
  return typeof v === "string" && (LOG_LEVELS as readonly string[]).includes(v);
}

/** VS Code's LogLevel number of a level name. */
export function logLevelNumber(level: LogLevelName): number {
  return LOG_LEVELS.indexOf(level);
}

/** A level as VS Code numbers it, or a name, as a name (undefined: not one). */
export function logLevelName(v: unknown): LogLevelName | undefined {
  if (isLogLevel(v)) return v;
  if (typeof v === "number" && Number.isInteger(v)) return LOG_LEVELS[v];
  return undefined;
}

/** What a worker hears: the default and its own channels' levels, as VS Code's numbers. */
export interface LogLevelsMessage {
  default: number;
  /** Channel id → level (only channels with a level of their own). */
  channels: Record<string, number>;
}

export class LogLevels {
  /** "default" and channel ids → their level (absent: the default's, or Info). */
  readonly all: Signal<ReadonlyMap<string, LogLevelName>> = signal<
    ReadonlyMap<string, LogLevelName>
  >(new Map());

  /** The default level (VS Code's env.logLevel). */
  get default(): LogLevelName {
    return this.all.value.get(DEFAULT_KEY) ?? DEFAULT_LOG_LEVEL;
  }

  /** A channel's level: its own, else the default. */
  levelOf(channelId: string): LogLevelName {
    return this.all.value.get(channelId) ?? this.default;
  }

  /** Sets `key`'s level ("default" or a channel id); null takes a channel's own level away. */
  set(key: string, level: LogLevelName | null): void {
    const current = this.all.peek().get(key);
    if (key === DEFAULT_KEY && level === DEFAULT_LOG_LEVEL) level = null;
    if ((level ?? undefined) === current) return;
    const next = new Map(this.all.peek());
    next.delete(key);
    if (level) next.set(key, level);
    while (next.size > MAX_LEVELS) next.delete(next.keys().next().value as string);
    this.all.value = next;
  }

  /** Loads saved levels (unknown keys and levels are skipped). */
  load(raw: unknown): void {
    const next = new Map<string, LogLevelName>();
    if (raw && typeof raw === "object" && !Array.isArray(raw))
      for (const [key, level] of Object.entries(raw as Record<string, unknown>)) {
        if (next.size >= MAX_LEVELS) break;
        if (isLogLevel(level) && (key === DEFAULT_KEY || /^ext\.[^\s]{1,300}$/.test(key)))
          next.set(key, level);
      }
    this.all.value = next;
  }

  /** What to save. */
  toJSON(): Record<string, LogLevelName> {
    return Object.fromEntries(this.all.peek());
  }

  /** The default and the levels of channels whose id starts with `prefix`, for one extension. */
  messageFor(prefix: string): LogLevelsMessage {
    const channels: Record<string, number> = {};
    for (const [key, level] of this.all.value)
      if (key !== DEFAULT_KEY && key.startsWith(prefix)) channels[key] = logLevelNumber(level);
    return { default: logLevelNumber(this.default), channels };
  }
}
