// /btw (D389, Claude Code's): a side question about the chat, answered by the chat's model from
// the conversation so far, with no tools. The question and its answer show as a card in the chat
// but aren't part of the conversation (a notice): the agent's next turn never sees them, and a
// running turn isn't interrupted.
import { conversationMarkdown } from "../../core/agent/compact";
import type { WorkbenchServices } from "../../workbench/services";
import { newId } from "./ids";
import type { ProviderRegistry } from "./providers";
import type { AgentSession } from "./session";

/** The end of the conversation the side question gets (characters). */
const CONTEXT_CHARS = 24_000;

const SYSTEM =
  "You answer a quick side question the user asks about the conversation below, which is between them and a coding agent. Answer briefly and directly from what the conversation shows; say so when it doesn't. You can't use tools, read files or change anything, and your answer doesn't become part of the conversation.";

export async function runSideQuestion(
  services: WorkbenchServices,
  providers: ProviderRegistry,
  session: AgentSession,
  question: string,
): Promise<Record<string, unknown>> {
  const transcript = conversationMarkdown(session.title.peek(), session.items);
  const context =
    transcript.length > CONTEXT_CHARS
      ? `…(earlier messages left out)\n${transcript.slice(-CONTEXT_CHARS)}`
      : transcript;
  const item: {
    type: "notice";
    id: string;
    text: string;
    tone: "info";
    aside: { question: string; answer: string; pending?: boolean };
  } = {
    type: "notice",
    id: newId("n"),
    text: question,
    tone: "info",
    aside: { question, answer: "", pending: true },
  };
  session.items.push(item);
  session.bump();
  const model = session.model.peek() ?? providers.defaultModel()?.key ?? undefined;
  try {
    const answer = await services.languageModel.generate({
      purpose: "aside",
      ...(model && { model }),
      system: SYSTEM,
      prompt: `The conversation so far:\n\n${context}\n\n---\n\nSide question: ${question}`,
      maxTokens: 2000,
      onText: (text) => {
        item.aside.answer = text;
        session.bump();
      },
    });
    item.aside = { question, answer: answer.trim() || "(no answer)" };
  } catch (err) {
    item.aside = {
      question,
      answer: `Couldn't answer: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  session.bump();
  return { question, answer: item.aside.answer, item: item.id };
}
