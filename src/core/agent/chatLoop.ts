// A loop in a chat (D332, Claude Code's /loop and ScheduleWakeup): `/loop <prompt>` has the agent
// do a check again and again: `/loop 5m check the build` every five minutes, `/loop check the
// build` self-paced (each turn ends with schedule_wakeup, which says when to look next: 60 s to
// an hour). Each check arrives as a scheduled message (the IDE's schedules time it); a check where
// nothing changed (schedule_wakeup's noop) is shown folded with the quiet ones next to it, as one
// line "N quiet checks". A loop ends when the agent stops it, the user presses Stop, a self-paced
// turn ends without a wake-up, or after LOOP_DAYS. DOM-free and tested.

import type { Item } from "./conversation";
import { DAY, durationText, MINUTE, parseDuration } from "./schedules";

export const LOOP_DAYS = 7;
export const MIN_WAKE_SECONDS = 60;
export const MAX_WAKE_SECONDS = 3600;
/** A fixed loop's interval: at least a minute, at most a day. */
export const MIN_EVERY_MS = MINUTE;
export const MAX_EVERY_MS = DAY;

export interface ChatLoop {
  session: string;
  prompt: string;
  /** A fixed interval (ms); none: self-paced (the agent picks each delay). */
  every?: number;
  started: number;
  expires: number;
  /** The pending check's schedule id; none while a check runs (or the agent hasn't said when). */
  schedule?: string;
  /** When that check is due. */
  next?: number;
  /** Checks sent so far (the first, the /loop message itself, counts). */
  ticks: number;
  /** Checks the agent marked as quiet (noop). */
  quiet: number;
  /** The agent's reason for the last delay, shown to the user. */
  reason?: string;
}

/**
 * `/loop` arguments: an interval first ("5m", "30s", "2h", "1d", "10 min") or last ("… every 5
 * minutes"), then the prompt. No interval: self-paced.
 */
export function parseLoopArgs(
  args: string,
): { prompt: string; every?: number } | { error: string } {
  const text = args.trim();
  const usage =
    'Say what to check: "/loop check the build" (self-paced) or "/loop 5m check the build" (every five minutes).';
  // An interval alone ("/loop 5m"): nothing to check.
  if (!text || parseDuration(text) !== null) return { error: usage };
  let prompt = text;
  let every: number | null = null;
  const lead = /^(\d+(?:\.\d+)?\s*[a-z]+)\s+([\s\S]+)$/i.exec(text);
  const leadMs = lead ? parseDuration(lead[1] ?? "") : null;
  if (lead && leadMs !== null) {
    every = leadMs;
    prompt = lead[2] ?? "";
  } else {
    const tail = /^([\s\S]+?)[,;]?\s+every\s+(\d+(?:\.\d+)?\s*[a-z]+|[a-z]+)\s*$/i.exec(text);
    const body = tail?.[2] ?? "";
    const tailMs = tail ? parseDuration(/^\d/.test(body) ? body : `1 ${body}`) : null;
    if (tail && tailMs !== null) {
      every = tailMs;
      prompt = tail[1] ?? "";
    }
  }
  prompt = prompt.trim();
  if (!prompt) return { error: usage };
  if (every === null) return { prompt };
  if (every < MIN_EVERY_MS) return { error: "A loop checks at most once a minute." };
  if (every > MAX_EVERY_MS)
    return { error: "A loop checks at least once a day: use the schedule tool for longer waits." };
  return { prompt, every };
}

/** schedule_wakeup's delay, in whole seconds within [60, 3600]. */
export function clampDelay(seconds: unknown): number {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return MIN_WAKE_SECONDS;
  return Math.min(MAX_WAKE_SECONDS, Math.max(MIN_WAKE_SECONDS, Math.round(n)));
}

/** How the loop paces itself, for people: "every 5 min" or "self-paced". */
export function loopPace(loop: Pick<ChatLoop, "every">): string {
  return loop.every ? `every ${durationText(loop.every)}` : "self-paced";
}

/** What opens a check's message (after the scheduled message's first line). */
export const LOOP_MARK = "Loop check";

/** A check's message: what to do, and how to end the turn. */
export function tickPrompt(loop: ChatLoop, n: number): string {
  const end = new Date(loop.expires).toISOString().slice(0, 10);
  const how = loop.every
    ? "When done, call schedule_wakeup with noop: true if nothing changed since the last check, or stop: true to end the loop (the next check comes by itself)."
    : "When done, call schedule_wakeup with the same prompt and the delay until the next check (noop: true if nothing changed; stop: true to end the loop). Without it, the loop ends.";
  return `${LOOP_MARK} ${n} (/loop, ${loopPace(loop)}, until ${end}). ${how}\n\n${loop.prompt}`;
}

/** What the /loop message itself carries: the loop's rules for its first check. */
export function loopStartContext(loop: ChatLoop): string {
  return `The user started a loop (/loop, ${loopPace(loop)}): do this check now and again later, until it's done or ${LOOP_DAYS} days pass. ${
    loop.every
      ? `The next checks come every ${durationText(loop.every)} by themselves. At the end of each turn call schedule_wakeup with noop: true when nothing changed since the last check, or stop: true when the loop is no longer needed.`
      : "You pace it: at the end of each turn call schedule_wakeup { delay_seconds (60–3600: shorter while things change, longer when idle), prompt: the same prompt, reason: one short sentence on the delay, noop: true when nothing changed, stop: true to end it }. A turn without it ends the loop."
  } Keep each check's answer short; say only what changed.\n\nThe prompt: ${loop.prompt}`;
}

/** A check's number when `text` is a loop check's scheduled message, else null. */
export function readTick(text: string): number | null {
  const body = text.split("\n\n").slice(1).join("\n\n");
  const m = new RegExp(`^${LOOP_MARK} (\\d+) \\(/loop`).exec(body);
  return m ? Number(m[1]) : null;
}

/** The prompt of a check's message (what to check), for its row. */
export function tickPromptText(text: string): string {
  return text.split("\n\n").slice(2).join("\n\n").trim();
}

/**
 * A check that changed nothing: from its message to the next user message, a schedule_wakeup
 * call with noop and without stop, and no file changed.
 */
function quietTick(span: readonly Item[]): boolean {
  let noop = false;
  for (const it of span) {
    if (it.type === "assistant" && it.streaming) return false;
    if (it.type !== "tool") continue;
    if (it.status === "pending" || it.status === "running") return false;
    if (it.changes?.length) return false;
    if (it.name === "schedule_wakeup") {
      const a = (it.args ?? {}) as { noop?: unknown; stop?: unknown };
      if (a.stop === true) return false;
      if (a.noop === true && it.status === "done") noop = true;
    }
  }
  return noop;
}

/**
 * The conversation as the chat draws it: runs of quiet checks (one or more next to each other)
 * become one notice, "N quiet checks". Everything else is unchanged (the same objects).
 */
export function collapseQuietTicks(items: readonly Item[]): readonly Item[] {
  if (!items.some((it) => it.type === "user" && it.auto === "schedule")) return items;
  const out: Item[] = [];
  let run: Item[][] = [];
  const flushRun = () => {
    const first = run[0]?.[0];
    if (first) {
      const n = run.length;
      out.push({
        type: "notice",
        id: `quiet-${first.id}`,
        text: `${n} quiet check${n === 1 ? "" : "s"}`,
        tone: "info",
      });
    }
    run = [];
  };
  let i = 0;
  while (i < items.length) {
    const it = items[i] as Item;
    if (it.type === "user" && it.auto === "schedule" && readTick(it.text) !== null) {
      let j = i + 1;
      while (j < items.length) {
        const next = items[j] as Item;
        if (next.type === "user" && !(next.auto === "limit" || next.auto === "continue")) break;
        j++;
      }
      const span = items.slice(i, j);
      if (quietTick(span.slice(1))) {
        run.push(span);
        i = j;
        continue;
      }
    }
    flushRun();
    out.push(it);
    i++;
  }
  flushRun();
  return out;
}

/** Loops as saved (with the folder): the well-formed ones still running. */
export function validLoops(data: unknown, now: number): ChatLoop[] {
  if (!Array.isArray(data)) return [];
  const out: ChatLoop[] = [];
  for (const raw of data) {
    const l = raw as Partial<ChatLoop> | null;
    if (
      !l ||
      typeof l.session !== "string" ||
      typeof l.prompt !== "string" ||
      typeof l.started !== "number" ||
      typeof l.expires !== "number" ||
      l.expires <= now
    )
      continue;
    out.push({
      session: l.session,
      prompt: l.prompt,
      ...(typeof l.every === "number" && l.every >= MIN_EVERY_MS && { every: l.every }),
      started: l.started,
      expires: l.expires,
      ...(typeof l.schedule === "string" && { schedule: l.schedule }),
      ...(typeof l.next === "number" && { next: l.next }),
      ticks: typeof l.ticks === "number" ? l.ticks : 1,
      quiet: typeof l.quiet === "number" ? l.quiet : 0,
      ...(typeof l.reason === "string" && { reason: l.reason }),
    });
  }
  return out;
}

/** A new loop for a chat. */
export function newLoop(
  session: string,
  prompt: string,
  every: number | undefined,
  now: number,
): ChatLoop {
  return {
    session,
    prompt,
    ...(every && { every }),
    started: now,
    expires: now + LOOP_DAYS * DAY,
    ticks: 1,
    quiet: 0,
  };
}
