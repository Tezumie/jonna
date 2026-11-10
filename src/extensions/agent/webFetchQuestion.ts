// web_fetch's `prompt` (D321): the page is read by a model with the question, in a subagent's own
// context, and only the answer reaches the agent. The model: agent.webFetch.model, else the
// Explore agent's (the cheap helper model the user picked, if any), else the chat's. Its usage is
// logged like a subagent's (the Usage page, source "subagent").

import type { ToolOutcome } from "../../core/agent/loop";
import {
  answerResult,
  fallbackResult,
  foundNothing,
  mergeTask,
  PAGE_QUESTION_SYSTEM,
  partTask,
  splitPage,
} from "../../core/agent/webQuestion";
import type { WorkbenchServices } from "../../workbench/services";
import { exploreAgent, subagentModel } from "./subagents";
import type { ToolHost } from "./tools";

/** The model that reads pages for questions (null: the chat's). */
export function pageQuestionModel(services: WorkbenchServices): string | null {
  const own = services.settings.peek<string>("agent.webFetch.model")?.trim();
  if (own) return own;
  return subagentModel(services, exploreAgent());
}

export async function answerFromPage(
  host: ToolHost,
  itemId: string,
  page: { url: string; title?: string; text: string; truncated?: boolean },
  question: string,
): Promise<ToolOutcome> {
  const titled = { url: page.url, ...(page.title && { title: page.title }) };
  const subagent = host.subagent?.bind(host);
  if (!subagent)
    return {
      result: fallbackResult(titled, page.text, "no model is available here"),
      summary: "page text (no model)",
    };
  const model = pageQuestionModel(host.services);
  const { parts, truncated } = splitPage(page.text);
  const ask = (task: string) =>
    subagent({
      system: PAGE_QUESTION_SYSTEM,
      task,
      tools: [],
      maxSteps: 1,
      model,
      progress: (line) => host.output(itemId, `${line}\n`),
    });
  try {
    const found: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (host.cancelled()) return { result: "Stopped by the user.", isError: true };
      if (parts.length > 1) host.output(itemId, `Reading part ${i + 1} of ${parts.length}…\n`);
      const answer = await ask(partTask(question, titled, parts[i] ?? "", i, parts.length));
      if (!foundNothing(answer)) found.push(answer.trim());
    }
    const cut =
      truncated || page.truncated
        ? "the page goes on past what was read; web_fetch without a prompt and with max_chars reads more of it"
        : undefined;
    if (!found.length)
      return {
        result: answerResult(titled, question, "The page doesn't answer this.", cut),
        summary: "not on the page",
      };
    const answer =
      found.length === 1 ? (found[0] ?? "") : await ask(mergeTask(question, page.url, found));
    if (!answer.trim()) throw new Error("the model's answer was empty");
    const result = answerResult(titled, question, answer, cut);
    return {
      result,
      summary: `answered${parts.length > 1 ? ` from ${parts.length} parts` : ""}`,
      detail: answer.trim(),
    };
  } catch (err) {
    if (host.cancelled()) return { result: "Stopped by the user.", isError: true };
    return {
      result: fallbackResult(titled, page.text, err instanceof Error ? err.message : String(err)),
      summary: "page text (the model failed)",
    };
  }
}
