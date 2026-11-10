import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AskCard,
  type AskQuestion,
  askResult,
  askSummary,
  normalizeAnswers,
  parseAskUser,
  picksOf,
  previewText,
  SKIPPED,
  skipAll,
} from "./askUser";

const two = {
  questions: [
    {
      question: "Which auth method?",
      header: "Auth method",
      options: [
        {
          label: "OAuth (Recommended)",
          description: "Sign in with GitHub",
          preview: "```ts\nlogin()\n```",
        },
        { label: "Password", description: "A form of our own" },
      ],
    },
    {
      question: "Which parts?",
      header: "Parts",
      multiSelect: true,
      options: [{ label: "Tests" }, { label: "Docs" }, { label: "Lint" }],
    },
  ],
};

test("ask_user: several questions with headers, previews and several picks (D312)", () => {
  const card = parseAskUser(two) as AskCard;
  assert.equal(card.kind, "ask");
  assert.equal(card.questions.length, 2);
  assert.equal(card.questions[0]?.header, "Auth method");
  assert.equal(card.questions[0]?.options[0]?.preview, "```ts\nlogin()\n```");
  assert.equal(card.questions[1]?.multiSelect, true);
  assert.equal(previewText("```ts\nlogin()\n```"), "login()");
  assert.equal(previewText("plain\n"), "plain");
});

test("ask_user: what can't be asked says why", () => {
  assert.deepEqual(parseAskUser({ questions: [] }), { error: "give 1 to 4 questions" });
  assert.match(
    (parseAskUser({ questions: Array(5).fill(two.questions[0]) }) as { error: string }).error,
    /at most 4/,
  );
  assert.match(
    (parseAskUser({ questions: [two.questions[0], two.questions[0]] }) as { error: string }).error,
    /repeats/,
  );
  assert.match(
    (parseAskUser({ questions: [{ question: "Q?", options: [] }] }) as { error: string }).error,
    /no options/,
  );
  // Duplicate labels are shown once.
  const dup = parseAskUser({ question: "Q?", options: ["A", "A", "B"] }) as AskCard;
  assert.deepEqual(
    dup.questions[0]?.options.map((o) => o.label),
    ["A", "B"],
  );
});

test("ask_user: answers keyed by question, header or number; every question answered", () => {
  const card = parseAskUser(two) as AskCard;
  assert.deepEqual(normalizeAnswers(card, { "auth method": "Password", 2: ["Tests", "Lint"] }), {
    "Which auth method?": "Password",
    "Which parts?": "Tests, Lint",
  });
  assert.match(
    (normalizeAnswers(card, { "Which auth method?": "Password" }) as { error: string }).error,
    /question 2 has no answer/,
  );
  assert.match((normalizeAnswers(card, { Nope: "x" }) as { error: string }).error, /no question/);
});

test("ask_user: the result the model gets", () => {
  const card = parseAskUser(two) as AskCard;
  const answers = { "Which auth method?": "Magic links", "Which parts?": "Tests, Lint" };
  assert.equal(
    askResult(card, answers),
    "The user answered your questions:\n- Which auth method? → Magic links (in their own words)\n- Which parts? → Tests, Lint\nGo on with these answers in mind.",
  );
  assert.equal(askSummary(card, answers), "Magic links; Tests, Lint");
  assert.match(askResult(card, "just do it"), /replied instead of picking: just do it/);
  // One question keeps the older one-line form.
  const one = parseAskUser({ question: "Which?", options: ["A", "B"] }) as AskCard;
  assert.equal(askResult(one, { "Which?": "B" }), "The user answered: B");
  assert.equal(askResult(one, "C"), "The user answered: C");
});

test("ask_user: picks and the user's own words in an answer", () => {
  const card = parseAskUser(two) as AskCard;
  const multi = card.questions[1];
  const single = card.questions[0];
  assert.ok(multi && single);
  assert.deepEqual(picksOf(multi, "Tests, Lint"), { picks: ["Tests", "Lint"], other: "" });
  assert.deepEqual(picksOf(multi, "Tests, also CI"), { picks: ["Tests"], other: "also CI" });
  assert.deepEqual(picksOf(single, "Password"), { picks: ["Password"], other: "" });
  assert.deepEqual(picksOf(single, "Neither"), { picks: [], other: "Neither" });
  assert.deepEqual(picksOf(single, undefined), { picks: [], other: "" });
});

test("ask_user: a skipped question (D335)", () => {
  const card = parseAskUser(two) as AskCard;
  const all = skipAll(card);
  assert.deepEqual(Object.values(all), [SKIPPED, SKIPPED]);
  assert.match(
    askResult(card, all),
    /^The user skipped these questions\. Go on with your own judgment/,
  );
  assert.equal(askSummary(card, all), "Skipped");
  const some = { "Which auth method?": SKIPPED, "Which parts?": "Tests" };
  assert.match(
    askResult(card, some),
    /- Which auth method\? → \(skipped\)\n- Which parts\? → Tests\n/,
  );
  assert.match(askResult(card, some), /for a skipped one, use your own judgment\.$/);
  assert.equal(askSummary(card, some), "skipped; Tests");
  const one = parseAskUser({ question: "Which?", options: ["A", "B"] }) as AskCard;
  assert.match(askResult(one, skipAll(one)), /^The user skipped this question\. /);
  assert.deepEqual(picksOf(card.questions[1] as AskQuestion, SKIPPED), { picks: [], other: "" });
  // Skipped answers pass agent.answer's check (every question has one).
  assert.deepEqual(normalizeAnswers(card, all), all);
});
