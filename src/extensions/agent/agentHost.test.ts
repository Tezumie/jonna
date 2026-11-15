import assert from "node:assert/strict";
import { test } from "node:test";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import {
  agentHost,
  type ChoicePrompt,
  DISMISS_ALL,
  headlessAgentHost,
  headlessPrompts,
  NOBODY,
  type PendingPrompt,
  setAgentHost,
  type TextPrompt,
} from "./agentHost";

const input: TextPrompt = {
  reason: "mcp.input",
  server: "github",
  prompt: "Token",
  password: true,
};
const stepUp: ChoicePrompt = {
  reason: "mcp.stepUp",
  server: "github",
  placeholder: "More access?",
  choices: [
    { id: "signIn", label: "Sign in again" },
    { id: "no", label: "Not now" },
  ],
};

test("with nothing set there is no screen, nobody watching, nowhere to run a script", () => {
  const services = {} as WorkbenchServices;
  const host = agentHost(services);
  assert.equal(host.screen, false);
  assert.equal(host.presence, NOBODY);
  assert.equal(host.presence.away(), true);
  assert.equal(host.presence.showing("s1"), false);
  assert.equal(host.workers, null);
  // The same host each time, until another is set.
  assert.equal(agentHost(services), host);
  const mine = headlessAgentHost({ presence: { ...NOBODY, away: () => false } });
  setAgentHost(services, mine);
  assert.equal(agentHost(services), mine);
  assert.equal(agentHost(services).presence.away(), false);
  // Other services keep their own.
  assert.equal(agentHost({} as WorkbenchServices).presence.away(), true);
});

test("the default policy dismisses every prompt, as closing it would", async () => {
  const prompts = headlessPrompts();
  assert.equal(await prompts.text(input), undefined);
  assert.equal(await prompts.choose(stepUp), undefined);
  assert.equal(
    await prompts.confirm({
      reason: "confirm",
      title: "Delete?",
      message: "",
      confirmLabel: "Delete",
    }),
    false,
  );
  const review = await prompts.review({
    reason: "mcp.samplingReview",
    server: "github",
    title: "Send?",
    message: "",
    label: "Answer",
    text: "the answer",
    signal: new AbortController().signal,
  });
  assert.deepEqual(review, { choice: "reject", text: "the answer" });
  assert.deepEqual(prompts.pending.peek(), []);
  assert.equal(DISMISS_ALL.decide({} as PendingPrompt), "dismiss");
});

test("a policy answers by reason", async () => {
  const prompts = headlessPrompts({
    decide: (p) =>
      p.prompt.reason === "mcp.stepUp"
        ? { answer: "signIn" }
        : p.prompt.reason === "confirm"
          ? { answer: "yes" }
          : p.prompt.reason === "mcp.samplingReview"
            ? { answer: "edited" }
            : "dismiss",
  });
  assert.equal(await prompts.choose(stepUp), "signIn");
  assert.equal(await prompts.text(input), undefined);
  assert.equal(
    await prompts.confirm({
      reason: "confirm",
      title: "Delete?",
      message: "",
      confirmLabel: "Delete",
    }),
    true,
  );
  const review = await prompts.review({
    reason: "mcp.samplingReview",
    server: "github",
    title: "Send?",
    message: "",
    label: "Answer",
    text: "the answer",
    signal: new AbortController().signal,
  });
  assert.deepEqual(review, { choice: "send", text: "edited" });
});

test("a prompt that waits is readable and answered by a front end", async () => {
  const prompts = headlessPrompts({ decide: () => "wait" });
  const typed = prompts.text(input);
  const picked = prompts.choose(stepUp);
  const [first, second] = prompts.pending.peek();
  assert.equal(first?.kind, "text");
  assert.equal(first?.prompt.reason, "mcp.input");
  assert.equal(second?.kind, "choice");
  if (first?.kind === "text") first.answer("secret");
  assert.equal(await typed, "secret");
  assert.equal(prompts.pending.peek().length, 1);
  // Who asked went away: the question on top is taken back.
  prompts.cancel();
  assert.equal(await picked, undefined);
  assert.deepEqual(prompts.pending.peek(), []);
});

test("a waiting review closes when its answer comes another way", async () => {
  const prompts = headlessPrompts({ decide: () => "wait" });
  const closed = new AbortController();
  const review = prompts.review({
    reason: "mcp.samplingReview",
    server: "github",
    title: "Send?",
    message: "",
    label: "Answer",
    text: "the answer",
    signal: closed.signal,
  });
  assert.equal(prompts.pending.peek().length, 1);
  closed.abort();
  assert.deepEqual(await review, { choice: "closed", text: "the answer" });
  assert.deepEqual(prompts.pending.peek(), []);
});

test("a question whose asker goes away is dismissed, and no other", async () => {
  const prompts = headlessPrompts({ decide: () => "wait" });
  const firstGone = new AbortController();
  const secondGone = new AbortController();
  // Two servers ask at once; the first one stops.
  const first = prompts.choose({ ...stepUp, server: "first", signal: firstGone.signal });
  const second = prompts.choose({ ...stepUp, server: "second", signal: secondGone.signal });
  const typed = prompts.text({ ...input, server: "third", signal: firstGone.signal });
  assert.equal(prompts.pending.peek().length, 3);
  firstGone.abort();
  // The newest question isn't the one that goes: each goes with its own asker.
  assert.deepEqual(
    prompts.pending.peek().map((p) => p.prompt.reason !== "confirm" && p.prompt.server),
    ["second"],
  );
  assert.equal(await first, undefined);
  assert.equal(await typed, undefined);
  const waiting = prompts.pending.peek()[0];
  if (waiting?.kind === "choice") waiting.answer("signIn");
  assert.equal(await second, "signIn");
  assert.deepEqual(prompts.pending.peek(), []);
  // Gone after the answer: nothing left to dismiss, nothing told.
  let told = 0;
  const watching = effect(() => {
    void prompts.pending.value;
    told++;
  });
  secondGone.abort();
  assert.equal(told, 1);
  watching.dispose();
  // Gone before asking: nothing is asked.
  assert.equal(await prompts.choose({ ...stepUp, signal: firstGone.signal }), undefined);
  assert.deepEqual(prompts.pending.peek(), []);
});

test("a question the policy answers at once doesn't stay tied to its asker", async () => {
  const prompts = headlessPrompts(DISMISS_ALL);
  const gone = new AbortController();
  let listening = 0;
  const add = gone.signal.addEventListener.bind(gone.signal);
  const remove = gone.signal.removeEventListener.bind(gone.signal);
  gone.signal.addEventListener = ((...args: Parameters<typeof add>) => {
    listening++;
    add(...args);
  }) as typeof add;
  gone.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
    listening--;
    remove(...args);
  }) as typeof remove;
  assert.equal(await prompts.choose({ ...stepUp, signal: gone.signal }), undefined);
  assert.equal(await prompts.text({ ...input, signal: gone.signal }), undefined);
  // A server that asks often would otherwise gather a listener per question.
  assert.equal(listening, 0);
});
