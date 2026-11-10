// A chat's name when its model didn't give one (D294). The first message asks the model to open
// its reply with `<title>…</title>` (D124, core/agent/title.ts); a model that ignores it (small
// and free ones often do, and external agents aren't asked) left the chat named after the first
// words of the message. Then one short request to the chat's own model names it: the first
// message and the start of the reply in, a few words out. Only while the name is still the one
// made from the message (a rename by the user stays), and only with agent.autoTitle on.

import { cleanTitle, splitTitle } from "../../core/agent/title";
import { aiIpc } from "../../core/ipc/agent";
import { newId } from "./ids";
import type { AgentSession } from "./session";
import { priceOf } from "./usage";
import { recordUsage } from "./usageLog";

const SYSTEM =
  "You name chats. Reply with a title of 2 to 6 words for the conversation below, in the language it's written in: no quotes, no punctuation at the end, nothing else.";

/** Names `session` from its first exchange, when its title is still `placeholder`. */
export async function nameChat(session: AgentSession, placeholder: string): Promise<void> {
  if (session.services.settings.peek<boolean>("agent.autoTitle") === false) return;
  const first = session.items.find((it) => it.type === "user");
  const reply = session.items.find((it) => it.type === "assistant" && it.text.trim());
  if (first?.type !== "user" || reply?.type !== "assistant") return;
  const providers = session.providers;
  const key = session.model.peek();
  // The chat's model; an external agent's chat (no model of ours) uses the default one.
  const choice =
    (key && !key.startsWith("acp/") && providers.find(key)) || providers.defaultModel();
  if (!choice) return;
  let text = "";
  try {
    await aiIpc.chat(
      newId("t"),
      {
        provider: choice.provider,
        model: choice.model,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: `The user wrote:\n${first.text.slice(0, 1500)}\n\nThe reply began:\n${reply.text.slice(0, 800)}`,
          },
        ],
        think: false,
        noCache: true,
        temperature: 0.2,
        maxTokens: 24,
      },
      (event) => {
        if (event.kind === "text") text += event.text;
        if (event.kind === "done")
          recordUsage(session.services, {
            source: "chat",
            choice,
            event,
            price: priceOf(session.services, providers, choice.key),
          });
      },
    );
  } catch {
    return;
  }
  // A model may still wrap it (<title>…</title>) or add a line after it.
  const raw = splitTitle(text.trim()).title ?? text.trim().split(/\r?\n/)[0] ?? "";
  const title = cleanTitle(raw.replace(/^title:\s*/i, ""));
  if (!title || session.deleted || session.title.peek() !== placeholder) return;
  session.title.value = title;
  void session.save();
}
