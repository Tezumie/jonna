// The host's questions for a front end that isn't the window (agentHost.ts): with no screen,
// a question that doesn't belong to a chat (an MCP server's input, sign-in again, elicitation,
// sampling, a confirmation) is dismissed by policy or waits in the host's `pending` list. These
// make that list readable (`ide://agent/hostPrompts`) and answerable (`agent.answerHostPrompt`),
// so a terminal or an attached client can do what the window's input box and dialogs do.
// Registered only where the host keeps such a list. DOM-free.
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { agentHost, type HeadlessPrompts, type PendingPrompt } from "./agentHost";

/** A waiting prompt as plain data (a password's value is never part of it). */
function describe(entry: PendingPrompt): Record<string, unknown> {
  const base = { id: entry.id, kind: entry.kind, reason: entry.prompt.reason };
  switch (entry.kind) {
    case "text":
      return {
        ...base,
        server: entry.prompt.server,
        prompt: entry.prompt.prompt,
        ...(entry.prompt.placeholder && { placeholder: entry.prompt.placeholder }),
        ...(entry.prompt.password && { password: true }),
        ...(entry.prompt.value !== undefined &&
          !entry.prompt.password && { value: entry.prompt.value }),
      };
    case "choice":
      return {
        ...base,
        server: entry.prompt.server,
        placeholder: entry.prompt.placeholder,
        choices: entry.prompt.choices.map((c) => ({ ...c })),
      };
    case "review":
      return {
        ...base,
        server: entry.prompt.server,
        title: entry.prompt.title,
        message: entry.prompt.message,
        label: entry.prompt.label,
        text: entry.prompt.text,
      };
    case "confirm":
      return {
        ...base,
        title: entry.prompt.title,
        message: entry.prompt.message,
        confirmLabel: entry.prompt.confirmLabel,
        ...(entry.prompt.destructive && { destructive: true }),
      };
  }
}

/** Registers the state path and the command when the agent's host keeps waiting prompts. */
export function registerHostPromptCommands(
  sub: DisposableStore,
  services: WorkbenchServices,
): void {
  const prompts = agentHost(services).prompts as Partial<HeadlessPrompts>;
  const pending = prompts.pending;
  if (!pending) return;
  sub.add(
    services.state.register("ide://agent/hostPrompts", {
      description:
        "Questions waiting with no window to show them (an MCP server's input, its sign-in again, an elicitation, a sampling request, a confirmation): each one's id, kind (text, choice, review, confirm), why it is asked and its fields. Answer with agent.answerHostPrompt.",
      get: () => pending.peek().map(describe),
    }),
  );
  sub.add(
    services.dispatcher.register({
      id: "agent.answerHostPrompt",
      title: "Answer a waiting question",
      category: "Agent",
      description:
        "Answers a question that waits with no window to show it (ide://agent/hostPrompts), by `id` (default: the oldest). A text prompt takes `text`; a choice takes `choice` (a choice's id); a review takes `text` (the text to send) or `reject: true`; a confirmation takes `confirm`. `dismiss: true` closes any of them unanswered, as Esc does in the window.",
      input: s.object({
        id: s.string().optional(),
        text: s.string().optional(),
        choice: s.string().optional(),
        confirm: s.boolean().optional(),
        reject: s.boolean().optional(),
        dismiss: s.boolean().optional(),
      }),
      effects: [],
      agent: "hidden",
      palette: false,
      run: ({ id, text, choice, confirm, reject, dismiss }) => {
        const entry = pending.peek().find((p) => !id || p.id === id);
        if (!entry) throw new Error("No question is waiting.");
        switch (entry.kind) {
          case "text": {
            if (dismiss) entry.answer(undefined);
            else {
              if (text === undefined) throw new Error("Give the answer in `text`.");
              const problem = entry.prompt.validate?.(text);
              if (problem) throw new Error(problem);
              entry.answer(text);
            }
            break;
          }
          case "choice": {
            if (dismiss) entry.answer(undefined);
            else {
              if (!entry.prompt.choices.some((c) => c.id === choice))
                throw new Error(
                  `Give one of the choices in \`choice\`: ${entry.prompt.choices.map((c) => c.id).join(", ")}.`,
                );
              entry.answer(choice);
            }
            break;
          }
          case "review":
            entry.answer(
              dismiss
                ? { choice: "closed", text: entry.prompt.text }
                : reject
                  ? { choice: "reject", text: entry.prompt.text }
                  : { choice: "send", text: text ?? entry.prompt.text },
            );
            break;
          case "confirm":
            entry.answer(!dismiss && confirm === true);
            break;
        }
        return { answered: entry.id, waiting: pending.peek().length };
      },
    }),
  );
}
