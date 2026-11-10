// Types and constants shared by the agent session's modules (session.ts and the session*.ts
// files split from it in D221). session.ts re-exports the public ones.

import type { SentAttachment, Upload } from "../../core/agent/attachments";
import { findCustomMode } from "../../core/agent/chatModes";
import { customModes } from "./customModes";

export type SessionStatus = "idle" | "running" | "waiting";

/** Agent does the work; Ask answers; Plan researches and plans (D180); the user's own (D227). */
export type ChatMode = "agent" | "ask" | "plan" | `custom:${string}`;
export type BuiltInMode = "agent" | "ask" | "plan";

/** What a mode tells the model, with each message (Agent needs nothing extra). */
export const MODE_RULES: Record<BuiltInMode, string | null> = {
  agent: null,
  ask: "Ask mode: answer the question and explain. You can read files, search and look at the IDE's state, but don't change files, run commands or change the IDE (you don't have those tools in this mode). If the user wants a change made, say what you'd change and suggest switching to Agent mode.",
  plan: "Plan mode: investigate first (read files, search; nothing is changed in this mode), then reply with a concrete plan: the files to change and what to do in each, in order, plus how to check it works. Record the steps with update_plan. Ask a short question first only if something essential is unclear. Your final answer is the plan document: Markdown with a # title, nothing before it; the IDE saves it as a file the user can edit. The user reviews it and presses Build to have it carried out.",
};

/** A custom mode's instructions as they go with a message. */
const customRules = (name: string, instructions: string) =>
  `${name} mode (the user's own mode; follow it):
${instructions}`;

/** What a mode tells the model with each message: built-in rules, or a custom mode's own. */
export function modeRules(mode: ChatMode): string | null {
  if (mode === "agent" || mode === "ask" || mode === "plan") return MODE_RULES[mode];
  const custom = findCustomMode(customModes.peek(), mode);
  return custom ? customRules(custom.name, custom.instructions) : null;
}

/** Every mode's rules (a retried message's old mode rules are told apart from its context). */
export function allModeRules(): Set<string> {
  return new Set([
    ...Object.values(MODE_RULES).filter((r): r is string => !!r),
    ...customModes.peek().map((m) => customRules(m.name, m.instructions)),
  ]);
}

export interface PermissionRequest {
  id: string;
  title: string;
  detail?: string;
  /** "Always allow" pattern (none for destructive requests). */
  always?: string;
  /** The "always" checkbox's own words instead of "Always allow <pattern>" ("Allow for this chat", D353). */
  alwaysLabel?: string;
  /**
   * A second choice beside "always" (D374: "Remember in every chat" for an app the computer tool
   * uses): when ticked, `run` keeps it and the answer is "always".
   */
  remember?: { label: string; run(): void };
  /** Asked even in full-access mode (the agent changing the IDE itself, D176). */
  evenWithFullAccess?: boolean;
  danger?: boolean;
  /** A short heading ("Run a command") and what it's about, shown as code; the title is the fallback. */
  heading?: string;
  code?: string;
  kind?: "command" | "ide" | "tool" | "agent";
  resolve(answer: "once" | "always" | "deny"): void;
}

/** A message sent while the agent worked, waiting for the next step (D151). */
export interface QueuedMessage {
  id: string;
  text: string;
  context: string[];
  images?: string[];
  attachments?: SentAttachment[];
  /** What the box held (files, pastes, images; project files): put back on Take back / Stop. */
  uploads?: Upload[];
  paths?: string[];
}

/** Tools whose file gets the rules that cover it (D200). */
export const RULE_TOOLS = new Set(["read_file", "edit_file", "write_file"]);

/** Tool calls without an update_plan before the plan reminder (D154). */
export const PLAN_NUDGE_AFTER = 6;

/** Below this context (tokens), the small-model profile is used (agent.smallModelProfile "auto"). */
export const SMALL_CONTEXT = 8192;
