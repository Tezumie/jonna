// How a conversation is laid out (D104, D159): like Claude's chat, what the agent says between
// steps shows as text in the conversation, and the steps between two texts (tool calls, the
// thinking behind them) collapse into a work group ("Ran 3 commands"). The turn's answer (its
// last text, after the last tool call) shows last. Cards the agent shows the user (display tools,
// D171) sit in the conversation like its text. Notices stay outside. DOM-free.
import { isRecordingStop } from "../../../core/agent/browserRecording";
import type { Item } from "../../../core/agent/conversation";
import { DISPLAY_TOOL_NAMES } from "../../../core/agent/displayCards";
import { leadsTurn, TURN_CARD_TOOLS, TURN_HIDDEN_TOOLS } from "../../../core/agent/turnTools";

type Assistant = Extract<Item, { type: "assistant" }>;
type Tool = Extract<Item, { type: "tool" }>;

/** One line in a work group. */
export type WorkEntry =
  | { kind: "item"; item: Assistant | Tool }
  /**
   * A step's thinking whose text shows outside the group: the answer's (the group's last row),
   * or, with `lead`, the thinking of the text just above the group (its first row).
   */
  | { kind: "thinking"; item: Assistant; lead?: boolean };

export type Segment =
  | { kind: "item"; item: Item; hideThinking?: boolean }
  | {
      kind: "work";
      /** Stable per turn: the first work item's id. */
      id: string;
      entries: WorkEntry[];
      /** Files whose proposed changes the group's tools made (diff cards under the group). */
      changes: string[];
      /** The session turn it belongs to, when known (its changes card acts on that turn's, D160). */
      turn?: number;
    };

/** An assistant step shown at all (a tool-calling step with no prose shows only its tools). */
const visible = (a: Assistant) => !!(a.text || a.thinking || a.streaming);

export function layoutTurns(items: readonly Item[]): Segment[] {
  const out: Segment[] = [];
  let turn: Item[] = [];
  let number: number | undefined;
  /** Where the user's message that started the turn is in `out` (-1: none). */
  let userAt = -1;
  const flush = () => {
    // A chapter marked before anything else of the turn (D302) opens it: its divider goes above
    // the user's message that started it.
    const leading =
      userAt < 0
        ? []
        : turn.filter(
            (it, i) =>
              it.type === "tool" &&
              it.name === "mark_chapter" &&
              it.status !== "error" &&
              leadsTurn(turn, i),
          );
    if (leading.length) {
      out.splice(userAt, 0, ...leading.map((item): Segment => ({ kind: "item", item })));
      turn = turn.filter((it) => !leading.includes(it));
    }
    if (turn.length) out.push(...layoutTurn(turn, number));
    turn = [];
    userAt = -1;
  };
  for (const item of items) {
    // "Carry on" after an output-limit cut-off (D157) is the harness talking within the same
    // turn: the work goes on in the same group, and the message itself isn't shown.
    if (item.type === "user" && (item.auto === "limit" || item.auto === "continue")) continue;
    // A group chat's next agent (D231): its reply is a turn of its own, the harness's note isn't
    // shown (the agent's face and name above its reply say who took over).
    if (item.type === "user" && item.auto === "group") {
      flush();
      continue;
    }
    if (item.type === "user") {
      flush();
      if (item.turn !== undefined) number = item.turn;
      userAt = out.length;
      out.push({ kind: "item", item });
    } else turn.push(item);
  }
  flush();
  return out;
}

function layoutTurn(items: readonly Item[], turn?: number): Segment[] {
  // The answer: the last assistant text with no tool call after it.
  let answer: Assistant | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    // The verify step's run (D127) comes after the answer: it doesn't make the answer "work".
    if (it?.type === "tool" && it.check) continue;
    if (it?.type === "tool") break;
    if (it?.type === "assistant" && (it.text || it.streaming)) {
      answer = it;
      break;
    }
  }
  const out: Segment[] = [];
  const notices: Item[] = [];
  const changes: string[] = [];
  let group: WorkEntry[] = [];
  let lastWork: Extract<Segment, { kind: "work" }> | undefined;
  const flush = () => {
    const first = group[0];
    if (!first) return;
    lastWork = {
      kind: "work",
      id: `work:${first.item.id}`,
      entries: group,
      changes: [],
      ...(turn !== undefined && { turn }),
    };
    out.push(lastWork);
    group = [];
  };
  for (const it of items) {
    if (it.type === "notice" || it.type === "summary") notices.push(it);
    else if (it === answer) {
      // Its thinking (or, before any text, its "Thinking…") belongs to the work.
      if (it.thinking || !it.text) group.push({ kind: "thinking", item: it });
    } else if (it.type === "tool" && TURN_HIDDEN_TOOLS.has(it.name) && it.status !== "error") {
      // The turn's wrap-up shows in the box at its end, a withdrawn task as its card (D301, D303).
    } else if (
      it.type === "tool" &&
      (DISPLAY_TOOL_NAMES.has(it.name) ||
        TURN_CARD_TOOLS.has(it.name) ||
        (isRecordingStop(it.name, it.args) && it.status === "done")) &&
      it.status !== "error"
    ) {
      // A card for the user (a chart, links, a question, D171): in the conversation where it was
      // shown, like text said between steps; a call that failed stays a row in the work.
      flush();
      out.push({ kind: "item", item: it });
    } else if (it.type === "tool") {
      group.push({ kind: "item", item: it });
      for (const p of it.changes ?? []) if (!changes.includes(p)) changes.push(p);
    } else if (it.type === "assistant" && it.text.trim()) {
      // Said between steps: in the conversation, like the answer; the steps it led to start a
      // new group, which opens with its thinking.
      flush();
      out.push({ kind: "item", item: it, hideThinking: !!it.thinking });
      if (it.thinking) group.push({ kind: "thinking", item: it, lead: true });
    } else if (it.type === "assistant" && visible(it)) group.push({ kind: "item", item: it });
  }
  flush();
  // The turn's file changes: one card, under its last group (D154).
  if (lastWork) lastWork.changes = changes;
  if (answer?.text) out.push({ kind: "item", item: answer, hideThinking: !!lastWork });
  out.push(...notices.map((item) => ({ kind: "item" as const, item })));
  return out;
}

/**
 * The rows an open work group shows (D151), in the order things happened, kept short like a
 * modern chat's: what the agent said between steps, and one row per tool call. Thinking stays out
 * of the way: the first step's thinking (with nothing said yet) is the first row, under its
 * headline; a later step's thinking goes inside its first tool row (a second click); the answer's
 * thinking is the last row, "Thought process".
 */
export type WorkRow =
  /** Text the agent wrote between steps; `thinking` opens under it. */
  | { kind: "note"; id: string; item: Assistant; text: string }
  /** A step that only thought (nothing said or called yet): its headline. */
  | { kind: "thought"; id: string; item: Assistant; text: string }
  /** A tool call, with the thinking of the step that made it (if it said nothing). */
  | { kind: "tool"; id: string; item: Tool; thinking?: Assistant }
  /** The answer's thinking. */
  | { kind: "thoughts"; id: string; item: Assistant };

export function workRows(entries: readonly WorkEntry[]): WorkRow[] {
  const rows: WorkRow[] = [];
  let carry: Assistant | undefined;
  for (const e of entries) {
    const it = e.item;
    if (e.kind === "thinking") {
      if (it.type === "assistant" && it.thinking.trim())
        rows.push(
          e.lead
            ? { kind: "thought", id: `${it.id}:lead`, item: it, text: thoughtHeadline(it.thinking) }
            : { kind: "thoughts", id: `${it.id}:thoughts`, item: it },
        );
      continue;
    }
    if (it.type === "assistant") {
      carry = undefined;
      if (it.text.trim()) rows.push({ kind: "note", id: `${it.id}:note`, item: it, text: it.text });
      else if (it.thinking.trim()) {
        if (!rows.length)
          rows.push({
            kind: "thought",
            id: `${it.id}:thought`,
            item: it,
            text: thoughtHeadline(it.thinking),
          });
        else carry = it;
      }
      continue;
    }
    rows.push({ kind: "tool", id: `${it.id}:tool`, item: it, ...(carry && { thinking: carry }) });
    carry = undefined;
  }
  // A later step still thinking (no tool call yet): its headline, so the open group isn't stale.
  if (carry)
    rows.push({
      kind: "thought",
      id: `${carry.id}:thought`,
      item: carry,
      text: thoughtHeadline(carry.thinking),
    });
  return rows;
}

/** A thought in one line: its last heading ("**Planning the layout**"), else its first sentence. */
export function thoughtHeadline(thinking: string): string {
  const heads = [
    ...thinking.matchAll(/^\s*(?:\*\*([^*\n]{3,80})\*\*|#{1,4}\s+([^\n]{3,80}))\s*$/gm),
  ];
  const last = heads[heads.length - 1];
  const head = (last?.[1] ?? last?.[2])?.trim().replace(/[.:…]+$/, "");
  if (head) return head;
  const plain = thinking.replace(/\s+/g, " ").trim();
  const sentence = /^(.{8,}?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain;
  return sentence.length > 90 ? `${sentence.slice(0, 88).trimEnd()}…` : sentence;
}

const COUNTS: [test: (name: string) => boolean, one: string, many: string][] = [
  [(n) => n === "write_file", "created a file", "created # files"],
  [(n) => n === "edit_file" || n === "acp:edit", "edited a file", "edited # files"],
  [(n) => n === "read_file" || n === "acp:read", "read a file", "read # files"],
  [(n) => n === "run_command" || n === "acp:execute", "ran a command", "ran # commands"],
  [
    (n) => ["search", "find_files", "find_commands", "acp:search"].includes(n),
    "searched once",
    "searched # times",
  ],
  [(n) => n === "list_dir", "listed a folder", "listed # folders"],
  [(n) => n === "explore", "explored the code", "explored the code # times"],
  [(n) => n === "screenshot", "took a screenshot", "took # screenshots"],
  [(n) => n.startsWith("browser_"), "used the browser", "used the browser # times"],
  [(n) => n === "process_output", "read a command's output", "read command output # times"],
  [(n) => n === "kill_process", "stopped a command", "stopped # commands"],
];

/** "Created 2 files, read a file, ran 3 commands" (or "Thought for 4s" with no tools). */
export function workSummary(entries: readonly WorkEntry[]): string {
  // The plan's updates show on its card (D300), not as work done.
  const tools = entries.flatMap((e) =>
    e.kind === "item" && e.item.type === "tool" && e.item.name !== "update_plan" ? [e.item] : [],
  );
  if (!tools.length) {
    const ms = entries.reduce(
      (t, e) => t + (e.item.type === "assistant" ? (e.item.thinkingMs ?? 0) : 0),
      0,
    );
    return ms ? `Thought for ${Math.max(1, Math.round(ms / 1000))}s` : "Thought";
  }
  const parts: string[] = [];
  const counted = new Set<Tool>();
  // The verify step's runs (D127) say what they were, and their failures aren't "failed tools".
  const checks = tools.filter((t) => t.check);
  for (const t of checks) counted.add(t);
  if (checks.length) {
    const bad = checks.filter((t) => t.status === "error").length;
    parts.push(
      bad === checks.length
        ? "checks failed"
        : bad
          ? `checks failed, then passed`
          : "checks passed",
    );
  }
  for (const [test, one, many] of COUNTS) {
    const n = tools.filter((t) => !counted.has(t) && test(t.name));
    for (const t of n) counted.add(t);
    if (n.length) parts.push(n.length === 1 ? one : many.replace("#", String(n.length)));
  }
  const rest = tools.length - counted.size;
  if (rest) parts.push(rest === 1 ? "used a tool" : `used ${rest} tools`);
  const failed = tools.filter((t) => t.status === "error" && !t.check).length;
  if (failed) parts.push(`${failed} failed`);
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const PRESENT: Record<string, string> = {
  Read: "Reading",
  Edited: "Editing",
  Edit: "Editing",
  Wrote: "Writing",
  Write: "Writing",
  Ran: "Running",
  Run: "Running",
  "Ran command": "Running",
  Searched: "Searching",
  Listed: "Listing",
  Found: "Finding",
  "Looked at": "Looking at",
  "Looked up": "Looking up",
  "Looked at page": "Looking at the page",
  "Inspected page": "Inspecting the page",
  "Read console": "Reading the console",
  "Took screenshot": "Taking a screenshot",
  "Updated plan": "Updating the plan",
};

/** What the group's shimmer line says while the turn runs, or null when it isn't working. */
export function workActivity(
  entries: readonly WorkEntry[],
  label: (tool: Tool) => { verb: string; target: string },
): string | null {
  const last = entries[entries.length - 1];
  if (!last) return null;
  const it = last.item;
  if (it.type === "tool") {
    if (it.status === "pending") return "Waiting for your answer";
    if (it.status !== "running") return null;
    const { verb, target } = label(it);
    return `${PRESENT[verb] ?? verb} ${target}`.trim();
  }
  if (!it.streaming) return null;
  // A tool call being written (a whole file can take a minute): say which (D119).
  if (it.toolDraft) return draftActivity(it.toolDraft);
  if (last.kind === "thinking") return it.text ? null : thinkingActivity(it.thinking);
  return it.text ? WORKING : thinkingActivity(it.thinking);
}

/** The status line's "nothing specific" activity: shown as one of `WORKING_PHRASES`. */
export const WORKING = "Working";

/**
 * What the status line says while the agent works and nothing more specific is known (D151): plain
 * words, never "Thinking", one at a time for a few seconds each.
 */
export const WORKING_PHRASES = [
  "Working on it",
  "Looking into it",
  "Piecing it together",
  "Sorting it out",
  "Weighing the options",
  "Lining things up",
  "Getting the details right",
  "Mulling it over",
] as const;

const DRAFT_VERBS: Record<string, string> = {
  write_file: "Writing",
  edit_file: "Editing",
  read_file: "Reading",
  run_command: "Preparing a command",
  search: "Searching",
  find_files: "Finding files",
  list_dir: "Listing",
  update_plan: "Planning",
  call_command: "Preparing an IDE command",
};

export function draftActivity(d: { name: string; path?: string; chars: number }): string {
  const verb = DRAFT_VERBS[d.name] ?? `Preparing ${d.name.replace(/_/g, " ")}`;
  const size = d.chars >= 2000 ? ` (${Math.round(d.chars / 1000)}k characters)` : "";
  return `${verb}${d.path ? ` ${d.path}` : ""}${size}`;
}

/**
 * While thinking: the latest heading in the model's thoughts ("**Planning the layout**", as many
 * models write them), else the generic "Working" (the status line turns that into one of its
 * phrases, D151).
 */
export function thinkingActivity(thinking: string): string {
  const heads = [
    ...thinking.matchAll(/^\s*(?:\*\*([^*\n]{3,80})\*\*|#{1,4}\s+([^\n]{3,80}))\s*$/gm),
  ];
  const last = heads[heads.length - 1];
  const head = (last?.[1] ?? last?.[2])?.trim().replace(/[.:…]+$/, "");
  return head ? head : WORKING;
}
