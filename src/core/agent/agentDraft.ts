// Generate an agent from a description (D245, Claude Code's `/agents` "Generate with Claude" and
// VS Code's): the model drafts the name, role, description, instructions and access; the draft
// opens in the agent editor to check before Create agent. DOM-free and tested.

import type { AgentAccess } from "./agentTemplates";
import { FACE_EYES, FACE_SHAPES } from "./faces";

export interface AgentDraft {
  label: string;
  role: string;
  description: string;
  instructions: string;
  access: AgentAccess;
}

export const AGENT_DRAFT_SYSTEM = `You write agent definitions for a coding IDE. An agent is a specialist the user chats with or hands work to: it has a name, a short role, a description (what it does and when to use it, which the main agent reads to decide when to delegate), instructions (how it works) and an access level:
- "read": reads and searches only (reviewers, planners, researchers, explainers)
- "edit": reads and edits files, runs no commands (writers, refactorers)
- "full": every tool, commands included (builders, debuggers, test runners)
Pick the lowest access that does the job.

Reply with one JSON object and nothing else:
{"label": "Short name, 1-3 words", "role": "2-4 words", "description": "One or two sentences: what it does, then 'Use when…'", "instructions": "Markdown: a first line saying what it is, then 3-6 bullet points on how it works and what its report contains", "access": "read" | "edit" | "full"}`;

/** The request: the user's description, and the names already taken. */
export function agentDraftPrompt(description: string, taken: readonly string[]): string {
  const names = taken.length ? `\n\nNames already taken (pick another): ${taken.join(", ")}` : "";
  return `Draft an agent from this description:\n\n${description.trim()}${names}`;
}

const ACCESS: readonly AgentAccess[] = ["read", "edit", "full"];

const text = (v: unknown, max: number): string =>
  typeof v === "string" ? v.trim().replace(/\r\n/g, "\n").slice(0, max) : "";

/** The model's reply → a draft; null when it isn't one (no JSON object, no name or description). */
export function parseAgentDraft(reply: string): AgentDraft | null {
  // The object, wherever it is: inside a ```json fence, or after a sentence.
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = text(o.label ?? o.name, 40).replace(/\s+/g, " ");
  const description = text(o.description, 600).replace(/\s+/g, " ");
  if (!label || !description) return null;
  const access = ACCESS.find((a) => a === o.access) ?? "read";
  return {
    label,
    role: text(o.role, 40).replace(/\s+/g, " "),
    description,
    instructions: text(o.instructions, 6000),
    access,
  };
}

/** A face for a drafted agent, from its name (the editor's shuffle can change it). */
export function draftFaceCode(label: string): string {
  let h = 0;
  for (const c of label) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0;
  const shape = FACE_SHAPES[h % FACE_SHAPES.length] ?? "round";
  const eyes = FACE_EYES[(h >>> 8) % FACE_EYES.length] ?? "dots";
  return `${shape}-${(h % 8) + 1}-${eyes}`;
}
