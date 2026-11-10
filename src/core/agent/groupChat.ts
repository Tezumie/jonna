// Group chats and handoffs (D231): several agents and the user in one chat, the speaking agent
// changing per turn (one transcript, one session), after Grok's group chats; and VS Code's custom
// agents' `handoffs:` (buttons after a reply that move the conversation to another agent). This
// file is the DOM-free part: who answers a message, which mentions in a reply hand the next turn
// to another member, how many automatic turns a chain may take, what each member is told about
// the room, and the `handoffs:` front matter. Tested.

import type { Item } from "./conversation";

/** The main agent's member name (not a file: the IDE's own agent). */
export const MAIN_MEMBER = "agent";

/** At most this many agents in one group (the user comes on top). */
export const MAX_MEMBERS = 6;

/** Automatic turns between agents per user message, unless `agent.groupChat.maxAutoTurns` says. */
export const DEFAULT_MAX_AUTO_TURNS = 4;

export interface GroupMember {
  /** Its id: the agent file's `name`, or `agent` for the main agent. */
  name: string;
  /** Shown and mentioned as `@label`. */
  label: string;
  role?: string;
  description?: string;
}

/** One handoff of an agent file (VS Code's `handoffs:` entries). */
export interface Handoff {
  /** The button's text ("Start implementation"). */
  label: string;
  /** The agent the chat moves to (a name; `agent`, `plan` and `ask` are the built-in modes). */
  agent: string;
  /** Text put in the message box (or sent, with `send`). */
  prompt?: string;
  /** Send `prompt` at once instead of leaving it in the box. */
  send?: boolean;
}

/** Member names kept: known ones, once each, in order, at most MAX_MEMBERS. */
export function normalizeMembers(
  names: readonly string[],
  known: (name: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || !known(name) || out.some((n) => n.toLowerCase() === name.toLowerCase())) continue;
    out.push(name);
    if (out.length >= MAX_MEMBERS) break;
  }
  return out;
}

/** Same length, line breaks kept, so indexes into the result still point into the original. */
const blank = (s: string) => s.replace(/[^\n]/g, " ");

const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;

/**
 * Code blocks blanked out line by line (CommonMark, approximately):
 * - Fences of 3+ backticks or tildes, indented up to 3 spaces (any amount inside a list, where
 *   fences sit under the item's text), closed by a run of the same character at least as long.
 *   An unclosed fence runs to the end, like CommonMark.
 * - Indented code: a line indented 4+ spaces (or a tab) whose previous line is blank, the start,
 *   or indented code itself, since indented code can't interrupt a paragraph. Inside a list (from a
 *   list item until the next unindented, non-list line) indented lines are the item's continuation,
 *   not code. Lazy continuations and nested quotes aren't modelled; replies rarely need them.
 */
function withoutCodeBlocks(text: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  let previous: "start" | "blank" | "code" | "text" = "start";
  let inList = false;
  for (const line of text.split("\n")) {
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (close && close[0] === fence.char && close.length >= fence.length) fence = null;
      out.push(blank(line));
      // What follows a closed fence starts a new block, like after a blank line.
      previous = "blank";
      continue;
    }
    const open = (inList ? /^\s*(`{3,}|~{3,})(.*)$/ : /^ {0,3}(`{3,}|~{3,})(.*)$/).exec(line);
    // A backtick fence's info string can't contain a backtick (that's inline code instead).
    if (open?.[1] && !(open[1][0] === "`" && (open[2] ?? "").includes("`"))) {
      fence = { char: open[1][0] ?? "`", length: open[1].length };
      out.push(blank(line));
      continue;
    }
    if (!line.trim()) {
      out.push(line);
      if (previous !== "code") previous = "blank";
      continue;
    }
    const indented = /^(?: {4}|\t| {0,3}\t)/.test(line);
    if (indented && !inList && previous !== "text") {
      out.push(blank(line));
      previous = "code";
      continue;
    }
    if (LIST_ITEM.test(line)) inList = true;
    else if (!indented) inList = false;
    out.push(line);
    previous = "text";
  }
  return out.join("\n");
}

/**
 * Inline code spans blanked out: a run of N backticks opens a span that the next run of exactly N
 * closes (CommonMark), so ``` ``a `b` c`` ``` is one span. A run with no closer is plain text. A
 * span doesn't cross a blank line (it would leave its paragraph).
 */
function withoutInlineCode(text: string): string {
  const runs = /`+/g;
  let out = "";
  let last = 0;
  for (let open = runs.exec(text); open; open = runs.exec(text)) {
    const size = open[0].length;
    const closer = new RegExp(`(?<!\`)\`{${size}}(?!\`)`, "g");
    closer.lastIndex = open.index + size;
    const close = closer.exec(text);
    if (!close) continue;
    const end = close.index + size;
    if (/\n[ \t\r]*\n/.test(text.slice(open.index, end))) continue;
    out += text.slice(last, open.index) + blank(text.slice(open.index, end));
    last = end;
    runs.lastIndex = end;
  }
  return out + text.slice(last);
}

/** Code blocks and inline code blanked out (same length), so a mention in code doesn't count. */
function withoutCode(text: string): string {
  return withoutInlineCode(withoutCodeBlocks(text));
}

interface Found {
  name: string;
  index: number;
}

/**
 * Every `@mention` of a member in `text`, in order (a member once, at its first mention). A mention
 * is `@` at the start of a word followed by the member's label or name (case ignored; the longest
 * match wins, so `@Test runner` beats `@Test`), not followed by a letter or digit. Mentions inside
 * code don't count.
 */
function mentionsIn(text: string, members: readonly GroupMember[]): Found[] {
  const plain = withoutCode(text);
  const lower = plain.toLowerCase();
  const candidates = members
    .flatMap((m) => [
      { name: m.name, key: m.label.trim().toLowerCase() },
      { name: m.name, key: m.name.toLowerCase() },
    ])
    .filter((c) => c.key)
    .sort((a, b) => b.key.length - a.key.length);
  const out: Found[] = [];
  for (let i = plain.indexOf("@"); i >= 0; i = plain.indexOf("@", i + 1)) {
    // An e-mail address or a decorator (`a@b`, `x.@y`) isn't a mention.
    if (i > 0 && /[\w.@]/.test(plain[i - 1] ?? "")) continue;
    const hit = candidates.find(
      (c) =>
        lower.startsWith(c.key, i + 1) && !/[\p{L}\p{N}_]/u.test(plain[i + 1 + c.key.length] ?? ""),
    );
    if (hit) out.push({ name: hit.name, index: i });
  }
  return out;
}

const unique = (list: readonly Found[]): string[] => [...new Set(list.map((f) => f.name))];

/** A mention in a piece of shown text: a member's (`name`), or a call on everyone (`null`). */
export interface MentionRange {
  start: number;
  end: number;
  name: string | null;
}

/**
 * Where a piece of shown text (no Markdown: one text node of a rendered message) mentions a
 * member or calls on everyone (D273: the chat colors them, as Slack and Discord do). The same
 * rules as routing: a label or name after "@", not inside a word or an e-mail address, the
 * longest name first.
 */
export function mentionRanges(text: string, members: readonly GroupMember[]): MentionRange[] {
  const lower = text.toLowerCase();
  const candidates: { name: string | null; key: string }[] = [
    ...members.flatMap((m) => [
      { name: m.name, key: m.label.trim().toLowerCase() },
      { name: m.name, key: m.name.toLowerCase() },
    ]),
    ...EVERYONE_WORDS.map((w) => ({ name: null, key: w })),
  ]
    .filter((c) => c.key)
    .sort((a, b) => b.key.length - a.key.length);
  // Your messages show as typed: `@Name` between backticks is code there too.
  const ticks = [...text.matchAll(/`[^`\n]*`/g)].map((m) => [m.index, m.index + m[0].length]);
  const out: MentionRange[] = [];
  for (let i = text.indexOf("@"); i >= 0; i = text.indexOf("@", i + 1)) {
    if (i > 0 && /[\w.@]/.test(text[i - 1] ?? "")) continue;
    if (ticks.some(([a = 0, b = 0]) => i > a && i < b)) continue;
    const hit = candidates.find(
      (c) =>
        lower.startsWith(c.key, i + 1) && !/[\p{L}\p{N}_]/u.test(text[i + 1 + c.key.length] ?? ""),
    );
    if (!hit) continue;
    const end = i + 1 + hit.key.length;
    out.push({ start: i, end, name: hit.name });
    i = end - 1;
  }
  return out;
}

/** Members `text` mentions anywhere (the user's message), in order, each once. */
export function findMentions(text: string, members: readonly GroupMember[]): string[] {
  return unique(mentionsIn(text, members));
}

/**
 * Members an agent's reply hands the next turn to. The rule (simple on purpose, so an agent can
 * name a colleague without calling on them): the mention opens a line (after spaces, a list
 * bullet, a quote mark or bold), or follows an arrow (`→ @Forge`, `-> @Forge`). "As @Scout said"
 * in the middle of a sentence doesn't hand anything over. The speaker's own name doesn't count.
 */
export function handoffMentions(
  reply: string,
  members: readonly GroupMember[],
  speaker: string | null,
): string[] {
  const plain = withoutCode(reply);
  const handing = mentionsIn(reply, members).filter((f) => {
    if (speaker && f.name.toLowerCase() === speaker.toLowerCase()) return false;
    const lineStart = plain.lastIndexOf("\n", f.index - 1) + 1;
    const before = plain.slice(lineStart, f.index);
    return (
      /^\s*(?:(?:[-*+>]|\d+[.)])\s*)*(?:\*\*|__)?$/.test(before) ||
      /(?:→|->)\s*(?:\*\*)?$/.test(before)
    );
  });
  return unique(handing);
}

/**
 * Who answers a user's message: the first member it mentions (the others it mentions answer after,
 * in order); with no mention, the agent that spoke last, else the first member.
 */
export function routeMessage(
  text: string,
  members: readonly GroupMember[],
  lastSpeaker: string | null,
): { speaker: string; queue: string[] } | null {
  const mentioned = findMentions(text, members);
  const [first, ...rest] = mentioned;
  if (first) return { speaker: first, queue: rest };
  const last = lastSpeaker
    ? members.find((m) => m.name.toLowerCase() === lastSpeaker.toLowerCase())
    : undefined;
  const speaker = last?.name ?? members[0]?.name;
  return speaker ? { speaker, queue: [] } : null;
}

/**
 * The words that call on every member (D245, D273): `@channel` (Slack's, the one the @ list
 * offers), `@everyone` (Discord's) and `@all`.
 */
export const EVERYONE_WORDS = ["channel", "everyone", "all"] as const;

/**
 * The words the @ list offers, first one first (D274): `@channel` in a channel, `@everyone` in a
 * group chat that isn't one. All of them work in both.
 */
export function everyoneWords(inChannel: boolean): readonly string[] {
  return inChannel ? EVERYONE_WORDS : ["everyone", "all", "channel"];
}

/** `@channel`, `@everyone` or `@all` outside code: every member is called on. */
export function mentionsEveryone(text: string): boolean {
  return /(?:^|[^\w.@])@(?:channel|all|everyone)(?![\p{L}\p{N}_])/iu.test(withoutCode(text));
}

/**
 * Who answers a user's message (routeMessage), and who answers at the same time beside them
 * (D245): with `@channel` (or `@all`, `@everyone`), every other member; with several mentions and `together` (the
 * agent.groupChat.answerTogether setting), the others named. Those answer at once, read-only;
 * the rest of the round (`queue`) answers one after another as before.
 */
export function routeTogether(
  text: string,
  members: readonly GroupMember[],
  lastSpeaker: string | null,
  together: boolean,
): { speaker: string; queue: string[]; together: string[] } | null {
  const route = routeMessage(text, members, lastSpeaker);
  if (!route) return null;
  if (mentionsEveryone(text))
    return {
      speaker: route.speaker,
      queue: [],
      together: members.map((m) => m.name).filter((n) => n !== route.speaker),
    };
  if (together && route.queue.length) return { ...route, queue: [], together: route.queue };
  return { ...route, together: [] };
}

/** A member waiting for its turn: named by the user (free) or by an agent (counts). */
export interface ChainEntry {
  name: string;
  fromUser: boolean;
}

/** What's left of one user message's round: who answers next, and how many agent turns ran. */
export interface GroupChain {
  queue: readonly ChainEntry[];
  /** Turns started because an agent mentioned another (counted against the limit). */
  autoTurns: number;
}

/** The round a user message starts: the members it mentioned after the first. */
export function startChain(queued: readonly string[]): GroupChain {
  return { queue: queued.map((name) => ({ name, fromUser: true })), autoTurns: 0 };
}

/**
 * After a reply: the members it handed to go first (those not waiting already), then whoever the
 * user named. An agent-to-agent turn counts against `max`; past it those are dropped (`limited`:
 * the chat says it stopped and waits for the user). The user's own mentions still get their turn,
 * so the chain always ends: user mentions are finite and agent turns are capped.
 */
export function nextInChain(
  chain: GroupChain,
  handedTo: readonly string[],
  max: number,
): { next: ChainEntry | null; chain: GroupChain; limited: boolean } {
  const waiting = chain.queue.map((e) => e.name.toLowerCase());
  const fresh = handedTo
    .filter((n) => !waiting.includes(n.toLowerCase()))
    .map((name) => ({ name, fromUser: false }));
  const queue = [...fresh, ...chain.queue];
  let autoTurns = chain.autoTurns;
  let limited = false;
  while (queue.length) {
    const entry = queue.shift() as ChainEntry;
    if (!entry.fromUser) {
      if (autoTurns >= Math.max(0, max)) {
        limited = true;
        continue;
      }
      autoTurns++;
    }
    return { next: entry, chain: { queue, autoTurns }, limited };
  }
  return { next: null, chain: { queue: [], autoTurns }, limited };
}

/** Opens what a member is told with its turn (taken off again when a message is resent). */
export const GROUP_CONTEXT_TAG = "<group_chat>";

/** What an external agent is told was said while another model had the turn (D235). */
export const CATCH_UP_PREFIX = "Said in this chat since your last turn:\n";

/** The room's brief or a catch-up: for the agent, not shown with your message. */
export function isGroupContext(text: string): boolean {
  return text.startsWith(GROUP_CONTEXT_TAG) || text.startsWith(CATCH_UP_PREFIX);
}

const who = (m: GroupMember) => `${m.label}${m.role ? ` (${m.role})` : ""}`;

/**
 * What the member answering this turn is told (with the message, not in the system prompt, so
 * the prompt stays cached across speakers): who it is, who else is in the room, how to hand a
 * question to another member, and its own instructions.
 */
export function roomBrief(
  members: readonly GroupMember[],
  speaker: string,
  options: { instructions?: string | null } = {},
): string {
  const me = members.find((m) => m.name === speaker);
  const label = me?.label ?? speaker;
  // Nothing in it changes from one turn of the member to the next (who spoke last is in the
  // labels and the handoff note): it's sent again only when it changed (D253, `newContext`).
  const lines = [
    GROUP_CONTEXT_TAG,
    `This is a group chat between the user and ${members.length} agents. You are ${me ? who(me) : label}; answer as ${label} only.`,
    "In the room:",
    ...members.map(
      (m) =>
        `- @${m.label}${m.role ? ` (${m.role})` : ""}${m.description ? `: ${m.description}` : ""}${m.name === speaker ? " — you" : ""}`,
    ),
    `The assistant messages above were written by different members, each starting with its writer's [Name] (yours with [${label}]). Don't start your reply with a name tag, and don't repeat what another member already said.`,
    'Answer only your part. To hand a question or a task to another member, start a line with their @name and say what you need from them ("@Name, can you …"); they answer next. Mention someone that way only when you need them to act, and never write another member\'s reply.',
  ];
  const own = options.instructions?.trim();
  if (own) lines.push("", `Your own instructions as ${label}:`, own);
  lines.push("</group_chat>");
  return lines.join("\n");
}

/** The harness's message that starts an agent-to-agent turn (not shown in the chat). */
export function handoffNote(to: string, from: string | null): string {
  return from
    ? `(${from} handed the conversation to you, ${to}. Read the conversation above and answer your part.)`
    : `(Your turn, ${to}: the user's message above was for you too. Answer your part.)`;
}

/**
 * The `@query` being typed at `caret` (for the mention list), or null: an `@` at the start of a
 * word, the text after it up to the caret (no line break, at most 40 characters).
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1] ?? "")) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n@]/.test(query)) return null;
  return { start: at, query };
}

/** Members whose label or name starts with `query` first, then those containing it. */
export function matchMembers(query: string, members: readonly GroupMember[]): GroupMember[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...members];
  const starts = members.filter(
    (m) => m.label.toLowerCase().startsWith(q) || m.name.toLowerCase().startsWith(q),
  );
  const contains = members.filter(
    (m) =>
      !starts.includes(m) &&
      (m.label.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)),
  );
  return [...starts, ...contains];
}

/** A front-matter value: quotes and a trailing comment off. */
function scalar(raw: string): string {
  const v = raw.trim();
  const q = /^"((?:[^"\\]|\\.)*)"|^'((?:[^']|'')*)'/.exec(v);
  if (q)
    return q[1] !== undefined ? q[1].replace(/\\(.)/g, "$1") : (q[2] ?? "").replace(/''/g, "'");
  return v.replace(/\s+#.*$/, "");
}

/**
 * A flow map's body (`label: "A, B", agent: x`) split into `key: value` pairs at commas outside
 * quotes. A quote opens only at the start of a value (YAML), so `don't` in a plain value is text.
 */
function splitFlowPairs(body: string): string[] {
  const pairs: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] ?? "";
    if (quote) {
      current += ch;
      if (quote === '"' && ch === "\\") {
        current += body[i + 1] ?? "";
        i++;
      } else if (ch === quote) {
        // `''` inside single quotes is an escaped quote, not the end.
        if (quote === "'" && body[i + 1] === "'") {
          current += "'";
          i++;
        } else quote = null;
      }
    } else if ((ch === '"' || ch === "'") && /(?:^|:)\s*$/.test(current)) {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      pairs.push(current);
      current = "";
    } else current += ch;
  }
  pairs.push(current);
  return pairs;
}

/** A block scalar being read: its key, folded (`>`) or literal (`|`), and the key's column. */
interface BlockScalar {
  key: string;
  folded: boolean;
  column: number;
  lines: string[];
}

/**
 * A block scalar's text, as `parseSubagentFile` reads them: literal keeps the line breaks, folded
 * joins the lines with spaces. The common indentation goes; deeper indentation stays (literal).
 */
function blockText(block: BlockScalar): string {
  const indents = block.lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)?.[0].length ?? 0);
  const cut = indents.length ? Math.min(...indents) : 0;
  const lines = block.lines.map((l) => l.slice(cut).trimEnd());
  return (block.folded ? lines.map((l) => l.trim()).join(" ") : lines.join("\n")).trim();
}

/**
 * The `handoffs:` list of an agent file's front matter (VS Code's custom agents): entries with
 * `label`, `agent`, `prompt` and `send`, as YAML block items (`- label: …` then indented keys, the
 * `-` indented or at column 0) or flow maps (`- { label: …, agent: … }`). A value may be a block
 * scalar (`prompt: |` or `>` then more-indented lines). Entries without a label or an agent are
 * skipped; at most 8.
 */
export function parseHandoffs(header: string): Handoff[] {
  const lines = header.split(/\r?\n/);
  const start = lines.findIndex((l) => /^handoffs\s*:\s*$/.test(l));
  if (start < 0) return [];
  const entries: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  let block: BlockScalar | null = null;
  const endBlock = () => {
    if (block && current) current[block.key] = blockText(block);
    block = null;
  };
  /** One `key: value` at `column` (where the key starts); a `|` or `>` value opens a block. */
  const put = (pair: string, column: number) => {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(pair.trim());
    if (!kv?.[1] || !current) return;
    const marker = (kv[2] ?? "").replace(/\s+#.*$/, "").trim();
    if (/^[|>][+-]?$/.test(marker))
      block = { key: kv[1], folded: marker[0] === ">", column, lines: [] };
    else current[kv[1]] = scalar(kv[2] ?? "");
  };
  for (const line of lines.slice(start + 1)) {
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (block) {
      // A block scalar's lines are blank or indented deeper than its key.
      if (!line.trim() || indent > (block as BlockScalar).column) {
        (block as BlockScalar).lines.push(line);
        continue;
      }
      endBlock();
    }
    if (!line.trim() || /^\s*#/.test(line)) continue;
    // The next top-level key ends the list; a `- ` at column 0 is still one of its items (YAML
    // lets a key's list start at the key's own column).
    if (/^\S/.test(line) && !/^-(?:\s|$)/.test(line)) break;
    const item = /^(\s*-(?:\s+|$))(.*)$/.exec(line);
    if (item) {
      current = {};
      entries.push(current);
      const rest = (item[2] ?? "").trim();
      const flow = /^\{(.*)\}\s*(?:#.*)?$/.exec(rest);
      if (flow) for (const pair of splitFlowPairs(flow[1] ?? "")) put(pair, 0);
      else if (rest) put(rest, item[1]?.length ?? 0);
    } else put(line, indent);
  }
  endBlock();
  const out: Handoff[] = [];
  for (const e of entries) {
    const label = e.label?.trim().slice(0, 60);
    const agent = e.agent?.trim();
    if (!label || !agent) continue;
    const prompt = e.prompt?.trim();
    out.push({
      label,
      agent,
      ...(prompt && { prompt: prompt.slice(0, 4000) }),
      ...(e.send?.toLowerCase() === "true" && { send: true }),
    });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * Who's in the room after a user's message (D233): agents it mentions that aren't in it join, up
 * to MAX_MEMBERS. A chat with one agent (no members) becomes a group of that agent (`solo`, the
 * speaker until now) and the agents mentioned; mentioning only the agent the chat is already with
 * changes nothing. `mentioned` are names in the order the message gives them. Null: no change.
 */
export function membersAfterMentions(
  current: readonly string[],
  solo: string,
  mentioned: readonly string[],
): { names: string[]; joined: string[] } | null {
  const base = current.length ? [...current] : [solo];
  const lower = new Set(base.map((n) => n.toLowerCase()));
  const fresh: string[] = [];
  for (const name of mentioned) {
    const key = name.toLowerCase();
    if (lower.has(key)) continue;
    lower.add(key);
    fresh.push(name);
  }
  const joined = fresh.slice(0, Math.max(0, MAX_MEMBERS - base.length));
  if (!joined.length) return null;
  return { names: [...base, ...joined], joined };
}

/**
 * The member a resumed turn is for (D253): the `to` of the automatic messages after the last
 * reply (a handoff note, a report for the member that delegated), the newest first. Null when a
 * reply came after them, or the user wrote (their words route the turn).
 */
export function pendingFor(items: readonly Item[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.type === "assistant" && (it.text.trim() || it.speaker)) return null;
    if (it?.type !== "user") continue;
    if (!it.auto) return null;
    if (it.to) return it.to;
  }
  return null;
}

/** A brief that went this many of the user's messages ago is sent again (it may be trimmed). */
export const CONTEXT_REPEAT_AFTER = 12;

/**
 * The context entries a new message still needs (D253). A group brief or a channel line (`kindOf`
 * names their kind; null: always sent) goes only when the latest entry of its kind the model
 * reads (since the last summary) is a different one, or is more than CONTEXT_REPEAT_AFTER
 * messages back: the same text on every message was paid for on every request.
 */
export function newContext(
  history: readonly Item[],
  context: readonly string[],
  kindOf: (entry: string) => string | null,
): string[] {
  const latest = new Map<string, { text: string; age: number }>();
  let age = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const it = history[i];
    if (it?.type === "summary") break;
    if (it?.type !== "user") continue;
    for (const c of it.context ?? []) {
      const kind = kindOf(c);
      if (kind && !latest.has(kind)) latest.set(kind, { text: c, age });
    }
    age++;
  }
  return context.filter((c) => {
    const kind = kindOf(c);
    if (!kind) return true;
    const last = latest.get(kind);
    return !last || last.text !== c || last.age >= CONTEXT_REPEAT_AFTER;
  });
}
