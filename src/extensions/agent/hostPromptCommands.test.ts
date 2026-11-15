import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextKeyService } from "../../core/context/index";
import { Dispatcher } from "../../core/dispatcher/index";
import { DisposableStore } from "../../core/lifecycle/index";
import { ALLOW_ALL } from "../../core/permissions/index";
import { StateTree } from "../../core/state/index";
import type { WorkbenchServices } from "../../workbench/services";
import { headlessAgentHost, setAgentHost } from "./agentHost";
import { registerHostPromptCommands } from "./hostPromptCommands";

function services(): WorkbenchServices {
  const dispatcher = new Dispatcher({
    context: new ContextKeyService(),
    permissions: ALLOW_ALL,
    events: { emit: () => {} },
    audit: () => {},
  });
  return { dispatcher, state: new StateTree() } as unknown as WorkbenchServices;
}

test("waiting host prompts are listed and answered through the command", async () => {
  const s = services();
  const host = headlessAgentHost({ permissions: { otherwise: "wait" } });
  setAgentHost(s, host);
  const sub = new DisposableStore();
  registerHostPromptCommands(sub, s);
  const list = async () =>
    (await s.state.get("ide://agent/hostPrompts")).value as Record<string, unknown>[];
  const run = (input: unknown) =>
    s.dispatcher.execute("agent.answerHostPrompt", input, { kind: "frontend", name: "test" });

  const token = host.prompts.text({
    reason: "mcp.input",
    server: "github",
    prompt: "Token",
    password: true,
    value: "old-secret",
    validate: (value) => (value.length < 3 ? "Too short." : undefined),
  });
  const access = host.prompts.choose({
    reason: "mcp.stepUp",
    server: "github",
    placeholder: "More access?",
    choices: [
      { id: "signIn", label: "Sign in again" },
      { id: "no", label: "Not now" },
    ],
  });
  const sure = host.prompts.confirm({
    reason: "confirm",
    title: "Delete?",
    message: "It can't be undone.",
    confirmLabel: "Delete",
  });

  const waiting = await list();
  assert.deepEqual(
    waiting.map((p) => `${p.kind}/${p.reason}`),
    ["text/mcp.input", "choice/mcp.stepUp", "confirm/confirm"],
  );
  // A password's present value is never told.
  assert.equal(waiting[0]?.password, true);
  assert.equal("value" in (waiting[0] ?? {}), false);

  // The oldest by default; a value the prompt refuses is an error and the prompt stays.
  await assert.rejects(run({ text: "x" }), /Too short/);
  await run({ text: "secret-token" });
  assert.equal(await token, "secret-token");
  await assert.rejects(run({ choice: "maybe" }), /signIn, no/);
  await run({ choice: "signIn" });
  assert.equal(await access, "signIn");
  await run({ confirm: true });
  assert.equal(await sure, true);
  assert.deepEqual(await list(), []);
  await assert.rejects(run({}), /No question is waiting/);

  // Dismissed: as closing it in the window.
  const again = host.prompts.text({ reason: "mcp.input", server: "x", prompt: "Value" });
  await run({ dismiss: true });
  assert.equal(await again, undefined);
  sub.dispose();
});

test("where the host shows its own questions, nothing is registered", () => {
  const s = services();
  // A host with prompts of its own and no waiting list (the window's).
  const own = headlessAgentHost().prompts;
  setAgentHost(s, {
    ...headlessAgentHost(),
    prompts: {
      text: own.text,
      choose: own.choose,
      review: own.review,
      confirm: own.confirm,
      cancel: own.cancel,
    },
  });
  const sub = new DisposableStore();
  registerHostPromptCommands(sub, s);
  assert.equal(s.dispatcher.has("agent.answerHostPrompt"), false);
  sub.dispose();
});
