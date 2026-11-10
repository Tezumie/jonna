// Output channels (D209, VS Code's Output panel): named logs — Window, Extension host, Git, each
// language server, Tasks, Agent — each keeping its last records in memory for the Output tab,
// and (all but the Window's, which the session log already writes) sent to a file per channel
// in this session's logs folder. `log.level` (trace, debug, info, warn, error) drops what's
// below it, and `log.channelLevels` sets a channel's own (VS Code's Set log level per channel).
// DOM-free and tested; `output` is the window's instance.
import { Emitter } from "../events/index";
import type { Disposable } from "../lifecycle/index";

export type OutputLevel = "trace" | "debug" | "info" | "warn" | "error";

export const OUTPUT_LEVELS: readonly OutputLevel[] = ["trace", "debug", "info", "warn", "error"];

const RANK: Record<OutputLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

/** Whether `level` is shown and written under the threshold `min`. */
export function atLeast(level: OutputLevel, min: OutputLevel): boolean {
  return RANK[level] >= RANK[min];
}

/** A setting's value as a level ("info" when it isn't one). */
export function parseLevel(value: unknown): OutputLevel {
  return typeof value === "string" && (OUTPUT_LEVELS as readonly string[]).includes(value)
    ? (value as OutputLevel)
    : "info";
}

export interface OutputRecord {
  time: number;
  level: OutputLevel;
  text: string;
}

/** What a channel's file gets (core/ipc/diagnostics `LogEntry` with its channel). */
export interface ChannelEntry {
  channel: string;
  level: OutputLevel;
  source: string;
  message: string;
}

export interface ChannelInfo {
  id: string;
  label: string;
  records: number;
  /** What it keeps: its own level, or the default (log.level). */
  level: OutputLevel;
  /** Its level is its own (log.channelLevels), not the default. */
  ownLevel: boolean;
}

/** log.channelLevels' value: the entries that are levels (others are ignored). */
export function parseChannelLevels(value: unknown): Record<string, OutputLevel> {
  const out: Record<string, OutputLevel> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [id, level] of Object.entries(value))
    if (typeof level === "string" && (OUTPUT_LEVELS as readonly string[]).includes(level))
      out[id] = level as OutputLevel;
  return out;
}

/** The well-known channels, in the picker's order (language servers come after, by name). */
export const WINDOW_CHANNEL = "window";
export const BUILTIN_CHANNELS: readonly { id: string; label: string }[] = [
  { id: WINDOW_CHANNEL, label: "Window" },
  { id: "exthost", label: "Extension host" },
  { id: "git", label: "Git" },
  { id: "tasks", label: "Tasks" },
  { id: "agent", label: "Agent" },
];

const MAX_RECORDS = 5000;
const MAX_TEXT = 8000;
const MAX_PENDING = 2000;

/** "12:03:04.051 [info] text" (local time), as the Output tab and `output.read` show it. */
export function formatRecord(r: OutputRecord): string {
  const d = new Date(r.time);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return `${time} [${r.level}] ${r.text}`;
}

export class OutputService implements Disposable {
  private readonly channels = new Map<string, { label: string; records: OutputRecord[] }>();
  private readonly changed = new Emitter<string>();
  /** A channel's records changed (its id), or the list of channels or their levels did (""). */
  readonly onDidChange = this.changed.event;
  private threshold: OutputLevel = "info";
  private readonly own = new Map<string, OutputLevel>();
  private pending: ChannelEntry[] = [];
  private droppedPending = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Where channel files are written (set by the help extension; none in tests). */
  private sink: ((entries: ChannelEntry[]) => Promise<void> | void) | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly flushMs = 1000,
  ) {
    for (const c of BUILTIN_CHANNELS) this.channels.set(c.id, { label: c.label, records: [] });
  }

  get level(): OutputLevel {
    return this.threshold;
  }

  /** The default level (log.level): channels without their own. */
  setLevel(level: OutputLevel): void {
    if (this.threshold === level) return;
    this.threshold = level;
    this.changed.fire("");
  }

  /** The channels' own levels (log.channelLevels), replacing the ones set before. */
  setChannelLevels(levels: Readonly<Record<string, OutputLevel>>): void {
    const before = JSON.stringify([...this.own]);
    this.own.clear();
    for (const [id, level] of Object.entries(levels)) this.own.set(id, level);
    if (JSON.stringify([...this.own]) !== before) this.changed.fire("");
  }

  /** What channel `id` keeps: its own level, or the default. */
  levelOf(id: string): OutputLevel {
    return this.own.get(id) ?? this.threshold;
  }

  /** Channel `id`'s own level, if it has one. */
  ownLevel(id: string): OutputLevel | undefined {
    return this.own.get(id);
  }

  /** Whether a record at `level` would be kept in `channel` now (the Window channel by default). */
  enabled(level: OutputLevel, channel = WINDOW_CHANNEL): boolean {
    return atLeast(level, this.levelOf(channel));
  }

  setSink(sink: ((entries: ChannelEntry[]) => Promise<void> | void) | null): void {
    this.sink = sink;
  }

  /** Makes sure a channel exists (a language server's, when it starts), naming it. */
  register(id: string, label: string): void {
    const c = this.channels.get(id);
    if (c) {
      if (c.label !== label) {
        c.label = label;
        this.changed.fire("");
      }
      return;
    }
    this.channels.set(id, { label, records: [] });
    this.changed.fire("");
  }

  /**
   * Adds a record to a channel (made with `label`, or its id, if it's new). Below the level: not
   * kept, false. `source` names the writer in the file ("lsp", an extension's id).
   */
  append(id: string, level: OutputLevel, text: string, label?: string, source = id): boolean {
    if (!atLeast(level, this.levelOf(id))) return false;
    if (!this.channels.has(id)) this.register(id, label ?? id);
    const c = this.channels.get(id);
    if (!c) return false;
    const clipped = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)} …(cut)` : text;
    c.records.push({ time: this.now(), level, text: clipped });
    if (c.records.length > MAX_RECORDS) c.records.splice(0, c.records.length - MAX_RECORDS);
    // The Window channel's file is the session log itself (the error capture writes it).
    if (id !== WINDOW_CHANNEL) this.queue({ channel: id, level, source, message: clipped });
    this.changed.fire(id);
    return true;
  }

  private queue(entry: ChannelEntry): void {
    if (!this.sink) return;
    if (this.pending.length >= MAX_PENDING) {
      this.droppedPending++;
      return;
    }
    this.pending.push(entry);
    this.timer ??= setTimeout(() => void this.flush(), this.flushMs);
  }

  /** Writes what's queued to the channels' files now. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const entries = this.pending;
    this.pending = [];
    if (this.droppedPending) {
      const first = entries[0];
      if (first)
        entries.push({
          ...first,
          level: "warn",
          source: "log",
          message: `${this.droppedPending} more records were dropped (too many at once).`,
        });
      this.droppedPending = 0;
    }
    if (!entries.length || !this.sink) return;
    // Rust takes 500 a call.
    for (let i = 0; i < entries.length; i += 500)
      await Promise.resolve(this.sink(entries.slice(i, i + 500))).catch(() => {});
  }

  list(): ChannelInfo[] {
    const builtin = BUILTIN_CHANNELS.map((c) => c.id);
    return [...this.channels]
      .map(([id, c]) => ({
        id,
        label: c.label,
        records: c.records.length,
        level: this.levelOf(id),
        ownLevel: this.own.has(id),
      }))
      .sort((a, b) => {
        const ia = builtin.indexOf(a.id);
        const ib = builtin.indexOf(b.id);
        if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        return a.label.localeCompare(b.label);
      });
  }

  has(id: string): boolean {
    return this.channels.has(id);
  }

  label(id: string): string | undefined {
    return this.channels.get(id)?.label;
  }

  records(id: string): readonly OutputRecord[] {
    return this.channels.get(id)?.records ?? [];
  }

  /** The channel's last `lines` records as text. */
  text(id: string, lines = MAX_RECORDS): string {
    return this.records(id).slice(-lines).map(formatRecord).join("\n");
  }

  clear(id: string): void {
    const c = this.channels.get(id);
    if (!c) return;
    c.records = [];
    this.changed.fire(id);
  }

  dispose(): void {
    void this.flush();
    this.changed.dispose();
  }
}

/** The window's output channels. */
export const output = new OutputService();

/** "lsp.<server>": a language server's channel id. */
export const lspChannel = (server: string) => `lsp.${server}`;
