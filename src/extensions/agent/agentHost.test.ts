import assert from "node:assert/strict";
import { test } from "node:test";
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
