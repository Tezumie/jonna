// What "@" can mention besides files (D109) and the context each one sends with a message (split
// from commands.ts in D221).

import { contextMentionCard } from "../../core/agent/mentions";
import type { WorkbenchServices } from "../../workbench/services";
import { mentionSourceFor } from "./composerExtras";
import { CONTEXT_MENTIONS, contextMentionText } from "./mentions";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";
import { webMentionContext } from "./webFetch";

/** What "@" can mention besides files (D109). */
export const MENTIONS = [
  {
    id: "@problems",
    label: "Problems",
    description: "Errors and warnings in open files",
    icon: "circle-alert" as const,
  },
  {
    id: "@terminal",
    label: "Terminal output",
    description: "The latest commands and their output",
    icon: "square-terminal" as const,
  },
  {
    id: "@selection",
    label: "Selection",
    description: "The text selected in the editor",
    icon: "code" as const,
  },
  {
    id: "@web",
    label: "Web page",
    description: "A page's text (asks for the address; or type it here)",
    icon: "globe" as const,
  },
  // @git, @commit, @branch, @chat, @rules, @symbol (D200, mentions.ts).
  ...CONTEXT_MENTIONS.map(({ id, label, description, icon }) => ({ id, label, description, icon })),
];

/** A mention's card label: "Problems", "Terminal output", the page's address. */
export function mentionLabel(mention: string): string {
  const source = mentionSourceFor(mention);
  if (source) return source.label(mention);
  if (mention.startsWith("@web ")) return mention.slice(5).replace(/^https?:\/\//, "");
  return (
    contextMentionCard(mention)?.label ?? MENTIONS.find((m) => m.id === mention)?.label ?? mention
  );
}

/** The context an @-mention sends with the message (looked up when the message is sent). */
export async function mentionContext(
  services: WorkbenchServices,
  mention: string,
  sessions: SessionManager,
  session?: AgentSession,
  message?: string,
): Promise<string> {
  const { state, dispatcher } = services;
  const other = await contextMentionText(services, sessions, mention).catch(
    (err) => `${mention}: ${err instanceof Error ? err.message : String(err)}`,
  );
  if (other !== null) return other;
  const read = async (path: string) =>
    state.has(path) ? (await state.get(path, { budget: 12000 })).value : null;
  const source = mentionSourceFor(mention);
  if (source) return source.context(mention, session, message);
  if (mention.startsWith("@web ")) return webMentionContext(mention.slice(5));
  if (mention === "@problems") {
    const d = (await read("ide://diagnostics")) as {
      items?: { path: string; line: number; severity: string; message: string }[];
    } | null;
    const items = (d?.items ?? []).filter(
      (i) => i.severity === "error" || i.severity === "warning",
    );
    return items.length
      ? `Problems (${items.length}):\n${items
          .slice(0, 60)
          .map((i) => `${i.path}:${i.line}: ${i.severity}: ${i.message}`)
          .join("\n")}`
      : "Problems: none.";
  }
  if (mention === "@terminal") {
    const r = (await dispatcher.execute("terminal.commands", { limit: 3 }).catch(() => null)) as {
      commands?: { command: string; exitCode?: number | null; output?: string }[];
    } | null;
    const cmds = r?.commands ?? [];
    return cmds.length
      ? `Latest terminal commands:\n${cmds
          .map(
            (c) =>
              `$ ${c.command}${c.exitCode !== undefined && c.exitCode !== null ? ` (exit ${c.exitCode})` : ""}\n${(c.output ?? "").slice(-4000)}`,
          )
          .join("\n\n")}`
      : "Terminal: no commands with output yet.";
  }
  if (mention === "@selection") {
    const a = (await read("ide://editors/active")) as {
      path?: string;
      selectedText?: string;
      selections?: { start: { line: number }; end: { line: number } }[];
    } | null;
    if (!a?.selectedText) return "Selection: nothing is selected.";
    const sel = a.selections?.[0];
    const lines = sel
      ? ` (lines ${Math.min(sel.start.line, sel.end.line)}-${Math.max(sel.start.line, sel.end.line)})`
      : "";
    return `Selected in ${a.path ?? "the editor"}${lines}:\n\`\`\`\n${a.selectedText.slice(0, 20000)}\n\`\`\``;
  }
  return `${mention}: unknown mention.`;
}
