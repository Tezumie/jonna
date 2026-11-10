// Scheduled messages for the agent (D253, Claude Code's wake-ups and scheduled tasks): "in 20
// minutes, check the deploy", "every hour, look at the queue", "weekdays at 9:00, sum up what
// changed". When one is due its prompt goes to a chat, a channel (an agent's DM included, so one
// agent can hand another work for later) or a new chat with an agent. They run only while the
// IDE is open; one missed while it was closed runs once when the folder opens again.
//
// DOM-free: the parsing of "when", the next run and the descriptions are here, the timer and the
// sending in extensions/agent/schedules.ts.

/** Where a schedule's prompt goes. */
export type ScheduleTarget =
  /** A chat (a session id): its agent gets the prompt as a message. */
  | { kind: "chat"; session: string }
  /** A channel ("#general") or an agent's direct messages (its name): agent.postToChannel. */
  | { kind: "channel"; channel: string }
  /** A new chat with an agent ("agent" for the main one) each time. */
  | { kind: "new"; agent: string };

/** How a schedule repeats: every so many ms, or at a local time of day (on some weekdays). */
export type Repeat = { every: number } | { at: string; days?: number[] };

export interface Schedule {
  id: string;
  /** Short, for lists ("Check the deploy"). */
  label: string;
  /** What is sent. */
  prompt: string;
  target: ScheduleTarget;
  /** When it runs next (ms since the epoch). */
  next: number;
  repeat?: Repeat;
  created: number;
  createdBy: "user" | "agent";
  /** The chat whose agent made it (it's listed there), when an agent did. */
  from?: string;
  /** A repeating one stops after this. */
  expires?: number;
  runs: number;
  lastRun?: number;
  /** Why the last run couldn't be sent. */
  lastError?: string;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
/** The soonest a one-off can run: shorter waits belong to process_output's wait_for. */
export const MIN_DELAY = MINUTE;
/** The shortest repeat: a model checking every few seconds would spend for nothing. */
export const MIN_EVERY = 5 * MINUTE;
/** The furthest ahead a schedule can start. */
export const MAX_AHEAD = 30 * DAY;
/** A repeating schedule stops after this many days unless told otherwise. */
export const DEFAULT_EXPIRY_DAYS = 7;
/** The longest a repeat runs (D292: "every day" for a year; each one is approved when made). */
export const MAX_EXPIRY_DAYS = 365;
/** Most schedules a folder keeps. */
export const MAX_SCHEDULES = 50;

export type When = { at: number } | { repeat: Repeat; first: number };

const UNITS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: MINUTE,
  min: MINUTE,
  mins: MINUTE,
  minute: MINUTE,
  minutes: MINUTE,
  h: HOUR,
  hr: HOUR,
  hrs: HOUR,
  hour: HOUR,
  hours: HOUR,
  d: DAY,
  day: DAY,
  days: DAY,
};

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "1h 30m", "90 minutes", "2 hours", "an hour": ms, or null. */
export function parseDuration(text: string): number | null {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/\b(an?|one)\s+(?=[a-z])/g, "1 ")
    .replace(/\band\b|,/g, " ");
  if (!t) return null;
  let total = 0;
  let rest = t;
  const part = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*/;
  while (rest.length) {
    const m = part.exec(rest);
    const unit = m ? UNITS[m[2] ?? ""] : undefined;
    if (!m || unit === undefined) return null;
    total += Number(m[1]) * unit;
    rest = rest.slice(m[0].length);
  }
  return total > 0 ? Math.round(total) : null;
}

/** "9", "9:30", "09:30", "9am", "3:15 pm", "15h30": minutes after midnight, or null. */
export function parseClock(text: string): number | null {
  const m = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(text.trim().toLowerCase());
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const half = m[3]?.replace(/\./g, "");
  if (minute > 59) return null;
  if (half) {
    if (hour < 1 || hour > 12) return null;
    if (half === "pm" && hour !== 12) hour += 12;
    if (half === "am" && hour === 12) hour = 0;
  } else if (hour > 23 || (!m[2] && !half)) {
    // A bare number isn't a time ("9" could be anything): "9:00" or "9am".
    return null;
  }
  return hour * 60 + minute;
}

const clockText = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** The first local time `clock` ("HH:MM") on one of `days` (all when absent) after `after`. */
export function nextAt(clock: string, days: readonly number[] | undefined, after: number): number {
  const minutes = parseClock(clock) ?? 0;
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setHours(Math.floor(minutes / 60), minutes % 60);
  // At most a week and a day ahead; setDate keeps the local time across daylight-saving changes.
  for (let i = 0; i < 9; i++) {
    if (d.getTime() > after && (!days?.length || days.includes(d.getDay()))) return d.getTime();
    d.setDate(d.getDate() + 1);
    d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  }
  return after + DAY;
}

/** The days a phrase names: "weekday(s)", "weekend", "monday", "mon and thu", or null. */
function parseDays(text: string): number[] | null {
  const t = text.trim().toLowerCase().replace(/s\b/g, "");
  if (t === "weekday") return [1, 2, 3, 4, 5];
  if (t === "weekend") return [0, 6];
  if (t === "day") return [];
  const names = t.split(/\s*(?:,|and|&|\/)\s*/).filter(Boolean);
  const days: number[] = [];
  for (const n of names) {
    const i = WEEKDAYS.findIndex((w) => w === n || (n.length >= 3 && w.startsWith(n)));
    if (i < 0) return null;
    if (!days.includes(i)) days.push(i);
  }
  return days.length ? days.sort((a, b) => a - b) : null;
}

/**
 * When a schedule runs, from what a person or a model writes: "in 20 minutes", "20m", "at 15:30",
 * "tomorrow at 9am", "2026-11-03 09:00" (local), an ISO time with a zone, "every 30 minutes",
 * "hourly", "daily at 9:00", "every weekday at 9am", "every monday and thursday at 17:00".
 * An error says what's accepted.
 */
export function parseWhen(text: string, now: number): When | { error: string } {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  const fail = {
    error: `Couldn't read "${text}" as a time. Use "in 20 minutes", "at 15:30", "tomorrow at 9am", "2026-11-03 09:00", "every 2 hours", "daily at 9:00" or "every weekday at 9am".`,
  };
  if (!t) return fail;
  if (t === "hourly") return { repeat: { every: HOUR }, first: now + HOUR };
  // every <duration>
  const every = /^every (.+)$/.exec(t);
  if (every) {
    const body = every[1] ?? "";
    const atDays = /^(.+?) at (.+)$/.exec(body);
    if (atDays) {
      const days = parseDays(atDays[1] ?? "");
      const clock = parseClock(atDays[2] ?? "");
      if (days === null || clock === null) return fail;
      const repeat: Repeat = { at: clockText(clock), ...(days.length && { days }) };
      return { repeat, first: nextAt(repeat.at, days, now) };
    }
    const ms = parseDuration(/^\d/.test(body) ? body : `1 ${body}`);
    if (ms === null) return fail;
    return { repeat: { every: ms }, first: now + ms };
  }
  const daily = /^(?:daily|every day|each day)(?: at)? (.+)$/.exec(t);
  if (daily) {
    const clock = parseClock(daily[1] ?? "");
    if (clock === null) return fail;
    const at = clockText(clock);
    return { repeat: { at }, first: nextAt(at, undefined, now) };
  }
  const inDuration = /^in (.+)$/.exec(t);
  if (inDuration) {
    const ms = parseDuration(inDuration[1] ?? "");
    return ms === null ? fail : { at: now + ms };
  }
  const bare = parseDuration(t);
  if (bare !== null) return { at: now + bare };
  const tomorrow = /^tomorrow(?: at)? (.+)$/.exec(t);
  if (tomorrow) {
    const clock = parseClock(tomorrow[1] ?? "");
    if (clock === null) return fail;
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(Math.floor(clock / 60), clock % 60, 0, 0);
    return { at: d.getTime() };
  }
  const at = /^(?:at |today at )?(.+)$/.exec(t);
  const clock = parseClock(at?.[1] ?? "");
  if (clock !== null) return { at: nextAt(clockText(clock), undefined, now) };
  // A date and time: "2026-11-03 09:00" is local; an ISO time with Z or an offset is exact.
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (local) {
    const d = new Date(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4] ?? 9),
      Number(local[5] ?? 0),
      Number(local[6] ?? 0),
    );
    return Number.isNaN(d.getTime()) ? fail : { at: d.getTime() };
  }
  if (/^\d{4}-\d{2}-\d{2}t.+(z|[+-]\d{2}:?\d{2})$/.test(t)) {
    const ms = Date.parse(text.trim());
    return Number.isNaN(ms) ? fail : { at: ms };
  }
  return fail;
}

/** Why `when` can't be a schedule (too soon, too often, too far), or null. */
export function whenProblem(when: When, now: number): string | null {
  const first = "at" in when ? when.at : when.first;
  if ("repeat" in when && "every" in when.repeat && when.repeat.every < MIN_EVERY)
    return `Repeating schedules run at most every ${MIN_EVERY / MINUTE} minutes. To wait for a command, use process_output with wait_for instead.`;
  if (first < now + MIN_DELAY - 1000)
    return first <= now
      ? "That time has passed."
      : "That's less than a minute away: do it now, or use process_output with wait_for to wait for a command.";
  if (first > now + MAX_AHEAD) return `Schedules start at most ${MAX_AHEAD / DAY} days ahead.`;
  return null;
}

/**
 * The schedule after a run at `now`: a one-off is done (null); a repeating one moves to its next
 * time after now (runs missed while the IDE was closed aren't made up, one ran for all of them),
 * or ends when that's past its expiry.
 */
export function afterRun(s: Schedule, now: number): Schedule | null {
  if (!s.repeat) return null;
  let next: number;
  if ("every" in s.repeat) {
    const every = Math.max(s.repeat.every, MIN_EVERY);
    // Keep the rhythm it started with (every hour on the half hour), skipping missed ones.
    const behind = Math.max(0, Math.floor((now - s.next) / every) + 1);
    next = s.next + behind * every;
    if (next <= now) next = now + every;
  } else next = nextAt(s.repeat.at, s.repeat.days, now);
  if (s.expires !== undefined && next > s.expires) return null;
  return { ...s, next, runs: s.runs + 1, lastRun: now };
}

/** The schedules due at `now`, soonest first. */
export function dueSchedules(list: readonly Schedule[], now: number): Schedule[] {
  return list.filter((s) => s.next <= now).sort((a, b) => a.next - b.next);
}

/** Ms until the soonest schedule (0 if one is due), or null with none. */
export function untilNext(list: readonly Schedule[], now: number): number | null {
  if (!list.length) return null;
  return Math.max(0, Math.min(...list.map((s) => s.next)) - now);
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "every 30 min", "every day at 09:00", "weekdays at 09:00", "Mon, Thu at 17:00", "once". */
export function describeRepeat(repeat: Repeat | undefined): string {
  if (!repeat) return "once";
  if ("every" in repeat) return `every ${durationText(repeat.every)}`;
  const days = repeat.days ?? [];
  if (!days.length) return `every day at ${repeat.at}`;
  if (days.join() === "1,2,3,4,5") return `weekdays at ${repeat.at}`;
  if (days.join() === "0,6") return `weekends at ${repeat.at}`;
  return `${days.map((d) => DAY_SHORT[d]).join(", ")} at ${repeat.at}`;
}

/** "45 s", "20 min", "1 h 30 min", "2 days". */
export function durationText(ms: number): string {
  if (ms < MINUTE) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min`;
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    const m = Math.round((ms % HOUR) / MINUTE);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.round(ms / DAY);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** When it runs next, for people: "in 20 min (14:05)", "tomorrow at 09:00", "Mon 3 Nov at 09:00". */
export function describeNext(next: number, now: number): string {
  const d = new Date(next);
  const time = clockText(d.getHours() * 60 + d.getMinutes());
  const left = next - now;
  if (left <= 0) return "now";
  if (left < 6 * HOUR) return `in ${durationText(left)} (${time})`;
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return `today at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${DAY_SHORT[d.getDay()]} ${d.getDate()} ${d.toLocaleString("en", { month: "short" })} at ${time}`;
}

/** A short label from the prompt: its first line, at most 60 characters. */
export function labelFor(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "Scheduled message";
}

/** What the agent reads when a schedule runs: the prompt, and that it's a scheduled one. */
export function scheduledText(s: Schedule, now: number): string {
  const late = now - s.next > 2 * MINUTE;
  const when = describeRepeat(s.repeat);
  return `Scheduled message (${when}${s.repeat ? `, run ${s.runs + 1}` : ""}${late ? `; it was due at ${new Date(s.next).toLocaleString()} but the IDE was closed` : ""}; schedule id ${s.id}):\n\n${s.prompt}`;
}

/** Schedules read back from storage: anything malformed is dropped. */
export function validSchedules(data: unknown): Schedule[] {
  if (!Array.isArray(data)) return [];
  const out: Schedule[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Partial<Schedule>;
    const target = s.target as ScheduleTarget | undefined;
    const targetOk =
      !!target &&
      ((target.kind === "chat" && typeof target.session === "string") ||
        (target.kind === "channel" && typeof target.channel === "string") ||
        (target.kind === "new" && typeof target.agent === "string"));
    const repeatOk =
      s.repeat === undefined ||
      ("every" in s.repeat && typeof s.repeat.every === "number" && s.repeat.every > 0) ||
      ("at" in s.repeat && parseClock(String(s.repeat.at)) !== null);
    if (
      typeof s.id !== "string" ||
      typeof s.prompt !== "string" ||
      typeof s.next !== "number" ||
      !Number.isFinite(s.next) ||
      !targetOk ||
      !repeatOk
    )
      continue;
    out.push({
      id: s.id,
      label: typeof s.label === "string" ? s.label : labelFor(s.prompt),
      prompt: s.prompt,
      target: target as ScheduleTarget,
      next: s.next,
      ...(s.repeat && { repeat: s.repeat }),
      created: typeof s.created === "number" ? s.created : s.next,
      createdBy: s.createdBy === "agent" ? "agent" : "user",
      ...(typeof s.from === "string" && { from: s.from }),
      ...(typeof s.expires === "number" && { expires: s.expires }),
      runs: typeof s.runs === "number" ? s.runs : 0,
      ...(typeof s.lastRun === "number" && { lastRun: s.lastRun }),
      ...(typeof s.lastError === "string" && { lastError: s.lastError }),
    });
  }
  return out.slice(0, MAX_SCHEDULES);
}
