// ask_user's questions (D171, D312): one to four questions in one card, each with a short header
// chip, two to four options (a label, what it means, and an optional preview shown while the
// option is focused), one or several picks, and always a typed answer of the user's own. Like
// Claude Code's AskUserQuestion; the older single-question form (question / options /
// descriptions / multi_select) still reads. The answers come back as one result keyed by
// question. DOM-free and tested.

export interface AskOption {
  label: string;
  /** What picking it means, or its trade-off. */
  description?: string;
  /** Shown beside the options while this one is focused (a mockup, code, a comparison). */
  preview?: string;
}

export interface AskQuestion {
  question: string;
  /** A short chip label ("Auth method"). */
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface AskCard {
  kind: "ask";
  questions: AskQuestion[];
}

/** The user's answers, by question text (several picks joined by ", "). */
export type AskAnswers = Record<string, string>;

/** What a waiting question gets: a message typed in the chat, or the card's answers. */
export type QuestionAnswer = string | { answers: AskAnswers };

export const MAX_QUESTIONS = 4;

/** A question the user skipped (the card's Skip, D335): its answer, and what the model reads. */
export const SKIPPED = "The user skipped this question";

/** Every question of a card skipped (Skip on a one-question card, agent.answer's `skip`). */
export function skipAll(card: AskCard): AskAnswers {
  return Object.fromEntries(card.questions.map((q, i) => [questionKey(q, i), SKIPPED]));
}
/** Older calls had up to six options; the description asks for two to four. */
const MAX_OPTIONS = 6;
const HEADER_LIMIT = 24;
const PREVIEW_LIMIT = 4000;

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function optionsOf(raw: unknown, notes: unknown): AskOption[] {
  const notesIn = Array.isArray(notes) ? notes : [];
  const seen = new Set<string>();
  const out: AskOption[] = [];
  (Array.isArray(raw) ? raw : []).forEach((o, i) => {
    const obj = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
    const label = typeof o === "string" ? o.trim() : text(obj.label);
    if (!label || seen.has(label)) return;
    seen.add(label);
    const description = text(obj.description) || text(notesIn[i]);
    const preview =
      typeof obj.preview === "string"
        ? obj.preview.replace(/\s+$/, "").slice(0, PREVIEW_LIMIT)
        : "";
    out.push({
      label,
      ...(description && { description }),
      ...(preview.trim() && { preview }),
    });
  });
  return out.slice(0, MAX_OPTIONS);
}

function questionOf(raw: Record<string, unknown>): AskQuestion | null {
  const options = optionsOf(raw.options, raw.descriptions);
  if (!options.length) return null;
  const header = text(raw.header).slice(0, HEADER_LIMIT);
  return {
    question: text(raw.question),
    ...(header && { header }),
    options,
    ...((raw.multiSelect === true || raw.multi_select === true) && { multiSelect: true }),
  };
}

/**
 * The questions a call asks, or why it can't be shown: `questions` (1–4), or the older single
 * question at the top level. Question texts must differ (the answers are keyed by them).
 */
export function parseAskUser(args: unknown): AskCard | { error: string } {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const list = Array.isArray(a.questions)
    ? (a.questions as unknown[]).map((q) =>
        q && typeof q === "object" ? questionOf(q as Record<string, unknown>) : null,
      )
    : [questionOf(a)];
  if (!list.length) return { error: "give 1 to 4 questions" };
  if (list.length > MAX_QUESTIONS) return { error: `at most ${MAX_QUESTIONS} questions at once` };
  const questions: AskQuestion[] = [];
  for (const [i, q] of list.entries()) {
    if (!q) return { error: `question ${i + 1} has no options` };
    if (list.length > 1 && !q.question) return { error: `question ${i + 1} has no text` };
    if (questions.some((x) => x.question === q.question))
      return { error: `question ${i + 1} repeats an earlier one: each needs its own text` };
    questions.push(q);
  }
  return { kind: "ask", questions };
}

/** The key an answer is kept under: the question, else its header, else its number. */
export function questionKey(q: AskQuestion, index: number): string {
  return q.question || q.header || `Question ${index + 1}`;
}

/**
 * The options an answer picked: the one it is, or with several picks (joined by ", ") each
 * option that's one of its parts, matched whole, so an option with a comma still counts. What's
 * left over is the user's own words.
 */
export function picksOf(
  q: AskQuestion,
  answer: string | undefined,
): { picks: string[]; other: string } {
  if (answer === undefined || answer === SKIPPED) return { picks: [], other: "" };
  const labels = q.options.map((o) => o.label);
  if (labels.includes(answer)) return { picks: [answer], other: "" };
  if (!q.multiSelect) return { picks: [], other: answer };
  const padded = `, ${answer}, `;
  const picks = labels.filter((t) => padded.includes(`, ${t}, `));
  let rest = padded;
  for (const p of picks) rest = rest.replace(`, ${p}, `, ", ");
  return { picks, other: rest.replace(/^,\s*|,\s*$/g, "").trim() };
}

/** Answers as given to agent.answer (keyed by question, header or number) → keyed by question. */
export function normalizeAnswers(
  card: AskCard,
  raw: Record<string, unknown>,
): AskAnswers | { error: string } {
  const out: AskAnswers = {};
  for (const [key, value] of Object.entries(raw)) {
    const i = card.questions.findIndex(
      (q, n) =>
        q.question === key ||
        questionKey(q, n) === key ||
        (q.header !== undefined && q.header.toLowerCase() === key.toLowerCase()) ||
        String(n + 1) === key,
    );
    const q = card.questions[i];
    if (!q) return { error: `no question "${key}"` };
    const answer = Array.isArray(value)
      ? value
          .map((v) => String(v).trim())
          .filter(Boolean)
          .join(", ")
      : typeof value === "string"
        ? value.trim()
        : "";
    if (answer) out[questionKey(q, i)] = answer;
  }
  const missing = card.questions.findIndex((q, i) => !out[questionKey(q, i)]);
  if (missing >= 0)
    return { error: `question ${missing + 1} has no answer (answer every question)` };
  return out;
}

/**
 * What the model gets back: one question keeps the older one-line form; several list each
 * question with its answer, the user's own words marked as such.
 */
export function askResult(card: AskCard, answers: AskAnswers | string): string {
  const ownJudgment = "Go on with your own judgment, and say what you chose.";
  if (typeof answers === "string")
    return card.questions.length === 1
      ? `The user answered: ${answers}`
      : `The user replied instead of picking: ${answers}`;
  if (card.questions.length === 1) {
    const q = card.questions[0] as AskQuestion;
    const answer = answers[questionKey(q, 0)] ?? "";
    return answer === SKIPPED ? `${SKIPPED}. ${ownJudgment}` : `The user answered: ${answer}`;
  }
  const skipped = card.questions.filter((q, i) => answers[questionKey(q, i)] === SKIPPED).length;
  if (skipped === card.questions.length) return `The user skipped these questions. ${ownJudgment}`;
  const lines = card.questions.map((q, i) => {
    const key = questionKey(q, i);
    const answer = answers[key] ?? "";
    if (answer === SKIPPED) return `- ${key} → (skipped)`;
    const { other } = picksOf(q, answer);
    return `- ${key} → ${answer}${other ? " (in their own words)" : ""}`;
  });
  return `The user answered your questions:\n${lines.join("\n")}\nGo on with these answers in mind${skipped ? "; for a skipped one, use your own judgment" : ""}.`;
}

/** One line for the card's tool row and summaries: the answers, short. */
export function askSummary(card: AskCard, answers: AskAnswers | string): string {
  if (typeof answers === "string") return answers;
  const all = card.questions.map((q, i) => answers[questionKey(q, i)] ?? "");
  if (all.every((a) => a === SKIPPED)) return "Skipped";
  return all
    .map((a) => (a === SKIPPED ? "skipped" : a))
    .filter(Boolean)
    .join("; ");
}

/** A preview's text without a Markdown fence around it (shown as monospace either way). */
export function previewText(preview: string): string {
  const fenced = /^\s*```[\w+-]*\n([\s\S]*?)\n?```\s*$/.exec(preview);
  return (fenced?.[1] ?? preview).replace(/\s+$/, "");
}
