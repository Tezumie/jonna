// How tool results read to a model (D191, docs/agent-wishlist.md 2–7, 10): text comes back as
// text (not a JSON string with escaped newlines), a long document keeps its beginning and says
// how to read on, unknown names get "did you mean", command lookups are ranked and compact, and
// errors carry a code and a hint. DOM-free and tested.

/** A value as the model reads it: strings as they are, everything else as compact JSON. */
export function asText(value: unknown): string {
  if (value === undefined) return "done";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 1);
}

/**
 * The start of `text` from `offset` (documents are read from the top): when more follows, a
 * last line says how much and the offset to pass next.
 */
export function headText(text: string, limit: number, offset = 0): string {
  const from = Math.max(0, Math.min(offset, text.length));
  const rest = text.slice(from);
  if (rest.length <= limit) return from ? `[from character ${from}]\n${rest}` : rest;
  // Cut at a line end when there's one near the limit.
  const nl = rest.lastIndexOf("\n", limit);
  const cut = nl > limit * 0.8 ? nl : limit;
  const next = from + cut;
  return `${from ? `[from character ${from}]\n` : ""}${rest.slice(0, cut)}\n… [${text.length - next} more characters: call again with offset: ${next}]`;
}

/** Edit distance (Levenshtein), capped for speed on long strings. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++)
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[n] ?? 0;
}

/** The `max` names closest to `wanted` (shared words first, then spelling), for "did you mean". */
export function closest(wanted: string, names: readonly string[], max = 3): string[] {
  const w = wanted.toLowerCase();
  const words = w.split(/[^a-z0-9]+/).filter((x) => x.length > 1);
  return names
    .map((name) => {
      const n = name.toLowerCase();
      const shared = words.filter((x) => n.includes(x)).length;
      return { name, score: shared * 10 - distance(w, n) / Math.max(1, n.length) };
    })
    .filter((x) => x.score > -0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.name);
}

export interface CommandInfo {
  id: string;
  title: string;
  description: string;
  effects: readonly string[];
}

/**
 * Commands matching `query`, best first: the id's namespace ("git" → git.*), then words in the
 * id, the title, and last the description. Every word must match somewhere.
 */
export function rankCommands<C extends CommandInfo>(commands: readonly C[], query: string): C[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const scored: { c: C; score: number }[] = [];
  for (const c of commands) {
    const id = c.id.toLowerCase();
    const ns = id.split(".")[0] ?? "";
    const title = c.title.toLowerCase();
    const desc = c.description.toLowerCase();
    let score = 0;
    let all = true;
    for (const w of words) {
      if (ns === w) score += 8;
      else if (id.includes(w)) score += 6;
      else if (title.includes(w)) score += 4;
      else if (desc.includes(w)) score += 1;
      else {
        all = false;
        break;
      }
    }
    if (all) scored.push({ c, score: score - id.length / 100 });
  }
  return scored.sort((a, b) => b.score - a.score).map((x) => x.c);
}

/** One line per command: id — effects — whether it asks — the description's first sentence. */
export function commandLine(c: CommandInfo, asks?: string): string {
  const first = (c.description.match(/^.*?[.!?](\s|$)/)?.[0] ?? c.description).trim();
  const effects = c.effects.length ? c.effects.join(",") : "ui";
  return `${c.id} — ${effects}${asks ? ` — asks: ${asks}` : ""} — ${first.slice(0, 160)}`;
}

/** Namespaces ("git", "editor"…) with how many commands each has, most first. */
export function namespaces(commands: readonly { id: string }[]): string {
  const counts = new Map<string, number>();
  for (const c of commands) {
    const ns = c.id.split(".")[0] ?? c.id;
    counts.set(ns, (counts.get(ns) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ns, n]) => `${ns} (${n})`)
    .join(", ");
}

export interface StructuredError {
  code: string;
  message: string;
  hint?: string;
}

/** An error as a code, its message and what to try next (wishlist 10). */
export function structuredError(err: unknown, did?: string[]): StructuredError {
  const message = err instanceof Error ? err.message : String(err);
  const m = message.toLowerCase();
  const pick = (code: string, hint?: string): StructuredError => ({
    code,
    message,
    ...(hint && { hint }),
  });
  // The dispatcher's own errors carry a code (CommandError); a command's failure ("Failed") is
  // read from its message below.
  const own = (err as { code?: unknown; name?: unknown } | null)?.code;
  if ((err as { name?: unknown } | null)?.name === "CommandError") {
    if (own === "Denied")
      return pick("denied", "The user or a setting refused it: don't retry as is; ask the user.");
    if (own === "Disabled")
      return pick(
        "disabled",
        "Not available in the IDE's current state (the condition is in the message).",
      );
  }
  if (m.includes("unknown command"))
    return pick(
      "unknown_command",
      did?.length
        ? `Did you mean: ${did.join(", ")}?`
        : "Look it up with find_commands (a word, or { namespace }).",
    );
  if (m.includes("unknown state path"))
    return pick("unknown_path", did?.length ? `Did you mean: ${did.join(", ")}?` : undefined);
  if (m.includes("invalid input"))
    return pick(
      "invalid_input",
      "Check the input against the schema: find_commands { ids: [id] } shows it.",
    );
  if (m.includes("denied") || m.includes("not allowed") || m.includes("can only be"))
    return pick("denied", "The user or a setting refused it: ask the user, don't retry as is.");
  if (m.includes("outside") && (m.includes("workspace") || m.includes("scope")))
    return pick("outside_workspace", "Use a path inside the open folder.");
  if (m.includes("not found") || m.includes("no such file") || m.includes("enoent"))
    return pick("not_found", "Check the name or path (list_dir, find_files).");
  if (m.includes("no folder is open") || m.includes("open a folder"))
    return pick("no_folder", "Ask the user to open a folder.");
  if (m.includes("timed out") || m.includes("timeout"))
    return pick("timeout", "Try a smaller step, or run it in the background.");
  return pick("failed");
}

export function errorText(e: StructuredError): string {
  return `Error [${e.code}]: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}`;
}
