// Who a new extension is by (D185): when an agent makes it, the agent (named after its model or
// agent program, with that brand's mark) and the person, if they've signed in to GitHub; when the
// person makes it, just them (if signed in). Written into the template's manifest as `authors`.

import type { Caller } from "../../core/dispatcher/index";
import type { ExtensionAuthor } from "../../core/extensions/authors";
import type { WorkbenchServices } from "../../workbench/services";

/** The agent behind a model id ("anthropic/claude-…", "ollama/qwen3:8b"). */
export function agentAuthor(model: string | null): ExtensionAuthor {
  const name = (model ?? "").split("/").slice(1).join("/") || model || "";
  const lower = name.toLowerCase();
  if (/claude/.test(lower))
    return { name: "Claude", url: "https://claude.ai", avatar: "brand:anthropic" };
  if (/^(gpt|o\d|chatgpt|codex)/.test(lower)) return { name: "GPT", avatar: "brand:openai" };
  if (/gemini/.test(lower)) return { name: "Gemini", avatar: "brand:gemini" };
  if (/grok/.test(lower)) return { name: "Grok", avatar: "brand:xai" };
  return { name: name || "Agent" };
}

/** An agent program connected over ACP (Claude Code, Codex, Gemini CLI…). */
export function acpAuthor(agent: string): ExtensionAuthor {
  const key = agent.toLowerCase().replace(/[^a-z]/g, "");
  if (key.includes("claude")) return { name: "Claude Code", avatar: "brand:claudecode" };
  if (key.includes("codex")) return { name: "Codex", avatar: "brand:codex" };
  if (key.includes("gemini")) return { name: "Gemini CLI", avatar: "brand:geminicli" };
  return { name: agent };
}

async function stateOf<T>(services: WorkbenchServices, path: string): Promise<T | null> {
  return ((await services.state.get(path).catch(() => null))?.value as T | undefined) ?? null;
}

export async function authorsFor(
  services: WorkbenchServices,
  caller: Caller,
): Promise<ExtensionAuthor[]> {
  const out: ExtensionAuthor[] = [];
  if (caller.kind === "agent") {
    const session = await stateOf<{ model?: string | null }>(services, "ide://agent/session");
    out.push(agentAuthor(session?.model ?? services.settings.get<string>("agent.model") ?? null));
  } else if (caller.kind === "acp") out.push(acpAuthor(caller.agent));
  const accounts = await stateOf<{
    github?: { accounts?: { host: string; login: string; active: boolean }[] };
  }>(services, "ide://accounts");
  const login = accounts?.github?.accounts?.find((g) => g.active && g.host === "github.com")?.login;
  if (login) out.push({ name: login, github: login });
  return out;
}
