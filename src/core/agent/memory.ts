// Project memory (D110): what the agent learns about a project, as Markdown files in
// `<workspace folder>/memory/` — one file per topic, a bullet per note with when and in which session it was
// written. The agent writes notes as it works ("in-band", no review: they're notes, not code); the
// next session gets only an index (topics and their first lines) and reads a topic when it's
// relevant (progressive loading). A note can carry a short why (D270), and a note that's wrong
// or outdated is replaced or removed in place rather than contradicted by a new one. "Tidying up" (dreaming) is a separate, user-started pass: the
// model reads the memory and recent sessions and proposes a curated version, which the user
// reviews like any agent edit — the memory itself is untouched until accepted.
// Typed notes (D315, like Claude Code's memory types): a note can say what kind it is — user (who
// the user is, their preferences), feedback (how to work: corrections and approaches that worked),
// project (ongoing work, goals, constraints the code doesn't show) or reference (where something
// lives outside the repo) — as a `[type]` tag, and feedback and project notes carry
// `**Why:**` and `**How to apply:**`. A note stays one line (so replacing, de-duplicating and the
// tidy-up keep working), and older untyped notes read as before. `[[topic]]` links one topic to
// another. DOM-free and tested.

export interface MemoryFile {
  /** File name in the memory folder ("testing.md"). */
  name: string;
  text: string;
}

/** Most of the index the system prompt gets (topics past it are still listed by name). */
const INDEX_LIMIT = 1800;
const NOTE_LIMIT = 600;
const WHY_LIMIT = 200;
/** A note's why, after the fact: `- fact — why: reason _(date, session)_` (before D315). */
const WHY_MARK = " — why: ";
/** D315's parts after the fact: ` — **Why:** reason — **How to apply:** how`. */
const WHY_PART = " — **Why:** ";
const HOW_PART = " — **How to apply:** ";

/** The kinds of note (D315). */
export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];
export const isMemoryType = (v: unknown): v is MemoryType =>
  typeof v === "string" && (MEMORY_TYPES as readonly string[]).includes(v);

/** "Testing & CI" → "testing-ci.md" (lowercase words joined by dashes). */
export function topicFile(topic: string): string {
  const slug = topic
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "notes"}.md`;
}

/** Valid memory file names: what topicFile makes (no folders, no dot files). */
export const isMemoryFile = (name: string) => /^[a-z0-9][a-z0-9-]*\.md$/.test(name);

/** The title of a topic file (its first heading), else its name. */
export function topicTitle(file: MemoryFile): string {
  const heading = /^#\s+(.+)$/m.exec(file.text)?.[1]?.trim();
  return heading || file.name.replace(/\.md$/, "").replace(/-/g, " ");
}

/** Notes (bullet lines) in a topic file. */
export function notesIn(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => /^\s*[-*]\s+\S/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, "").trim());
}

/**
 * What looks like a secret (keys, tokens, passwords): memory is plain text in the folder, maybe
 * committed, so these are refused.
 */
export function looksSecret(text: string): boolean {
  return (
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/.test(text) ||
    /\bgh[pousr]_[A-Za-z0-9]{20,}/.test(text) ||
    /\bAKIA[0-9A-Z]{16}\b/.test(text) ||
    /\bxox[abpr]-[A-Za-z0-9-]{10,}/.test(text) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) ||
    /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i.test(text)
  );
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * One note as a bullet, with provenance ("2026-10-18, session ab12"): untyped with its why as
 * before; with a type (D315), the `[type]` tag and its **Why:** / **How to apply:** parts.
 */
export function noteLine(
  note: string,
  date: string,
  session: string,
  why?: string,
  typed: { type?: MemoryType; how?: string } = {},
): string {
  const text = oneLine(note).slice(0, NOTE_LIMIT);
  const reason = why ? oneLine(why).slice(0, WHY_LIMIT) : "";
  const how = typed.how ? oneLine(typed.how).slice(0, WHY_LIMIT) : "";
  const stamp = ` _(${date}, session ${session.slice(-6)})_`;
  if (!typed.type) return `- ${text}${reason ? `${WHY_MARK}${reason}` : ""}${stamp}`;
  return `- [${typed.type}] ${text}${reason ? `${WHY_PART}${reason}` : ""}${how ? `${HOW_PART}${how}` : ""}${stamp}`;
}

/** A note line without its bullet and provenance. */
const bareNote = (line: string) =>
  line
    .replace(/\s*_\([^)]*\)_\s*$/, "")
    .replace(/^\s*[-*]\s+/, "")
    .trim();

export interface ParsedNote {
  type?: MemoryType;
  fact: string;
  why?: string;
  how?: string;
}

/** A note line's parts: its type tag, fact, why and how to apply (either way of writing them). */
export function parseNote(line: string): ParsedNote {
  let rest = bareNote(line);
  const tag = /^\[([a-z]+)\]\s+/.exec(rest);
  const type = tag && isMemoryType(tag[1]) ? tag[1] : undefined;
  if (type && tag) rest = rest.slice(tag[0].length);
  const cut = (mark: string): string | undefined => {
    const at = rest.indexOf(mark);
    if (at < 0) return undefined;
    const after = rest.slice(at + mark.length);
    rest = rest.slice(0, at);
    return after.trim() || undefined;
  };
  // The last part first: how, then why (either mark).
  const how = cut(HOW_PART);
  const why = cut(WHY_PART) ?? cut(WHY_MARK);
  return { ...(type && { type }), fact: rest.trim(), ...(why && { why }), ...(how && { how }) };
}

/** A note's fact alone (no tag, why or provenance): what makes two notes the same. */
const factOf = (line: string) => parseNote(line).fact.toLowerCase();

/** The `[[topic]]` links in a topic's text, as file names (D315). */
export function linksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]\n]{1,60})\]\]/g)) {
    const name = topicFile(m[1] ?? "");
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** How many notes of each type a topic has (untyped ones aren't counted). */
export function noteTypes(text: string): Partial<Record<MemoryType, number>> {
  const out: Partial<Record<MemoryType, number>> = {};
  for (const n of notesIn(text)) {
    const type = parseNote(n).type;
    if (type) out[type] = (out[type] ?? 0) + 1;
  }
  return out;
}

/** The notes of one type across topics, with their file. */
export function notesOfType(
  files: readonly MemoryFile[],
  type: MemoryType,
): { name: string; line: string }[] {
  const hits: { name: string; line: string }[] = [];
  for (const f of files)
    for (const n of notesIn(f.text))
      if (parseNote(n).type === type) hits.push({ name: f.name, line: `- ${n}` });
  return hits;
}

/**
 * The topic file with the first note containing `match` (words, case and spacing ignored)
 * replaced by `line`, or removed when `line` is null (D270: a correction updates the note instead
 * of adding a contradicting one). Null when no note matches.
 */
export function replaceNote(text: string, match: string, line: string | null): string | null {
  const want = oneLine(match).toLowerCase();
  if (!want) return null;
  const lines = text.split("\n");
  const i = lines.findIndex(
    (l) => /^\s*[-*]\s/.test(l) && oneLine(bareNote(l)).toLowerCase().includes(want),
  );
  if (i < 0) return null;
  if (line === null) lines.splice(i, 1);
  else lines[i] = line;
  return lines.join("\n");
}

/**
 * The topic file with the note added (a new file starts with the topic as its heading). A note
 * already there (same words, any provenance) isn't added twice: returns null.
 */
export function appendNote(text: string | null, topic: string, line: string): string | null {
  // The same fact with another why (or type) is still the same note.
  const body = text ?? `# ${topic.replace(/\.md$/, "").trim()}\n`;
  if (text && body.split("\n").some((l) => /^\s*[-*]\s/.test(l) && factOf(l) === factOf(line)))
    return null;
  return `${body.replace(/\s*$/, "")}\n${text ? "" : "\n"}${line}\n`;
}

/**
 * The index for the system prompt: each topic with its note count and first notes (their facts,
 * not their whys), kept whole until the limit. Reading a topic gives everything.
 */
export function memoryIndex(
  files: readonly MemoryFile[],
  limit = INDEX_LIMIT,
  /** Notes shown per topic (the user's own: all that fit, they're their preferences). */
  perTopic = 2,
): string {
  const lines: string[] = [];
  let used = 0;
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const notes = notesIn(f.text);
    const parsed = notes.map(parseNote);
    // How many of each kind (D315); untyped notes aren't counted.
    const kinds = MEMORY_TYPES.map((t) => [t, parsed.filter((p) => p.type === t).length] as const)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `${n} ${t}`);
    const head = `- ${f.name} — ${topicTitle(f)} (${notes.length} note${notes.length === 1 ? "" : "s"}${kinds.length ? `: ${kinds.join(", ")}` : ""})`;
    const preview = parsed
      .slice(0, perTopic)
      .map((p) => `    · ${p.type ? `[${p.type}] ` : ""}${p.fact.slice(0, 120)}`);
    const block = [head, ...preview].join("\n");
    if (used + block.length > limit) {
      lines.push(head);
      used += head.length;
    } else {
      lines.push(block);
      used += block.length;
    }
  }
  return lines.join("\n");
}

/** Lines matching every word of `query` (case-insensitive), with their file. */
export function searchMemory(
  files: readonly MemoryFile[],
  query: string,
  max = 30,
): { name: string; line: string }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { name: string; line: string }[] = [];
  for (const f of files)
    for (const line of f.text.split("\n")) {
      const l = line.toLowerCase();
      if (line.trim() && words.every((w) => l.includes(w))) {
        hits.push({ name: f.name, line: line.trim() });
        if (hits.length >= max) return hits;
      }
    }
  return hits;
}

// ---- Tidying up (dreaming) ------------------------------------------------------------------------

export const DREAM_SYSTEM =
  "You curate a coding agent's project memory: short Markdown notes the agent reads before working on this project. You keep what is true and useful, and nothing else.";

export function dreamPrompt(
  files: readonly MemoryFile[],
  sessions: readonly { title: string; text: string }[],
  focus?: string,
): string {
  const memory = files.length
    ? files.map((f) => `<file name="${f.name}">\n${f.text.trim()}\n</file>`).join("\n")
    : "(empty)";
  const recent = sessions.length
    ? sessions
        .map((s) => `<session title="${s.title.replace(/"/g, "'")}">\n${s.text}\n</session>`)
        .join("\n")
    : "(none)";
  return [
    "Rewrite the project memory below. Use the recent sessions as evidence.",
    "1. Verify: drop or fix notes the sessions show are wrong or outdated; when notes contradict, keep what the newest evidence supports.",
    "2. Organize: merge duplicates, group related notes into topic files, drop one-off noise.",
    '3. Enrich: add durable lessons the sessions show but the memory lacks (commands that work, conventions, the user\'s stated preferences, known pitfalls). Look especially for the user\'s corrections ("no, use…", "don\'t…") and anything they asked to be remembered. Never secrets.',
    'Keep each note one line starting with "- ", with its " — why: …" if it has one, and keep the _(date, session …)_ provenance of notes you keep (merged notes keep the newest).',
    'Keep a note\'s type tag ([user], [feedback], [project] or [reference]) right after "- ", and its " — **Why:** …" and " — **How to apply:** …" parts; give an untyped note a tag when its kind is clear. A [project] note with a relative date ("next week") gets the absolute date. Keep [[topic]] links to files that still exist.',
    "Drop notes that only repeat what the repository already records (its code, README, AGENTS.md, git history).",
    focus ? `Pay special attention to: ${focus}` : "",
    "",
    "Reply with only the files, each as:",
    "=== file: topic-name.md ===",
    "# Topic title",
    "- note",
    "and for a file to remove: === delete: old-name.md ===",
    "File names: lowercase words joined by dashes, ending in .md. List every file that should exist afterwards.",
    "",
    "<memory>",
    memory,
    "</memory>",
    "<recent_sessions>",
    recent,
    "</recent_sessions>",
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
}

export interface DreamResult {
  files: MemoryFile[];
  deletes: string[];
}

/**
 * The model's curated memory. Files it didn't mention stay as they are (a small model may drop
 * some); only an explicit delete removes one. Throws when there's nothing usable.
 */
export function parseDream(output: string): DreamResult {
  const text = output.replace(/<think>[\s\S]*?<\/think>/g, "");
  const files: MemoryFile[] = [];
  const deletes: string[] = [];
  const re = /^===\s*(file|delete)\s*:\s*([^\n=]+?)\s*===\s*$/gim;
  const marks = [...text.matchAll(re)];
  marks.forEach((m, i) => {
    const kind = (m[1] ?? "").toLowerCase();
    const name = topicFile(m[2] ?? "");
    if (kind === "delete") {
      deletes.push(name);
      return;
    }
    const start = (m.index ?? 0) + m[0].length;
    const end = marks[i + 1]?.index ?? text.length;
    const body = text
      .slice(start, end)
      .replace(/^\s*```(?:markdown|md)?\s*\n/, "")
      .replace(/\n```\s*$/, "")
      .trim();
    if (!body || looksSecret(body)) return;
    const existing = files.find((f) => f.name === name);
    if (existing) existing.text += `\n${body}\n`;
    else files.push({ name, text: `${body}\n` });
  });
  if (!files.length && !deletes.length)
    throw new Error("The model's reply had no memory files (=== file: name.md ===).");
  return { files, deletes: deletes.filter((d) => !files.some((f) => f.name === d)) };
}
