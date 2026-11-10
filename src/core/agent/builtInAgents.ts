// The team every user starts with (D237, D241, D245, D272): beside the main agent (Agent mode, it
// builds), a planner (Plan mode) and a chat partner (Ask mode), named Plato and Gabby, so #general
// has people in it from the first run. Each is an agent file's text, written once into the user's
// agents folder (subagents.ts seedTeam), where it's the user's to edit or delete; Reset to defaults
// writes them again. The builder, the reviewer and the tester stay as templates in the agent
// editor. Each shows its model's logo (D270); the faces the first team was written with are kept
// below, so a file that still has its first face moves to the logo once.

import { setHeaderFields } from "./agentFile";
import { AGENT_TEMPLATES, templateFile } from "./agentTemplates";
import { MODEL_ICON } from "./faces";
import { BUILTIN_SUBAGENTS } from "./subagents";

export interface BuiltInAgent {
  name: string;
  /** Its name as shown ("Plato"). */
  label: string;
  /** Its role: the mode its chats start in ("Plan"). */
  role: string;
  /** The agent file it would be (header and instructions). */
  text: string;
}

/** The team: its role is the mode its chats start in (the main agent's is Agent). */
const TEAM: readonly { name: string; template: string; label: string; role: string }[] = [
  { name: "planner", template: "planner", label: "Plato", role: "Plan" },
  { name: "chat", template: "chat", label: "Gabby", role: "Ask" },
];

/** The faces the team's files were written with before D270 (the builder was one then). */
const FIRST_ICONS: Readonly<Record<string, string>> = {
  planner: "squircle-2-wide",
  builder: "blob-1-dots",
  chat: "round-5-happy",
};

/** The first team (D237): seeded before D245, so a user who had it isn't given it again. */
export const FIRST_TEAM: readonly string[] = ["builder", "reviewer", "tester"];

/** How the team works together in a channel: each one's lane, and handing on with @Name. */
const TEAMWORK: Record<string, string> = {
  planner:
    "\n\nIn a channel: when the plan is agreed, hand it to the main agent (in Agent mode, it builds) with a line starting with its @name and the plan. Don't build it yourself.",
  chat: "\n\nIn a channel: when the talk turns into work, hand it on with a line starting with the planner's @name (a change to work out) or the main agent's (a small, clear change it can build).",
};

/**
 * The built-in subagent of the same name's instructions: a team agent replaces it, so delegating
 * to it works as before.
 */
function ownPrompt(name: string): string | undefined {
  return BUILTIN_SUBAGENTS.find((d) => d.name === name)?.prompt;
}

export const BUILT_IN_AGENTS: readonly BuiltInAgent[] = TEAM.flatMap((t) => {
  const template = AGENT_TEMPLATES.find((x) => x.id === t.template);
  if (!template) return [];
  return [
    {
      name: t.name,
      label: t.label,
      role: t.role,
      text: templateFile(
        {
          ...template,
          label: t.label,
          role: t.role,
          icon: MODEL_ICON,
          instructions: (ownPrompt(t.name) ?? template.instructions) + (TEAMWORK[t.name] ?? ""),
        },
        t.name,
      ),
    },
  ];
});

export const BUILT_IN_AGENT_NAMES: readonly string[] = BUILT_IN_AGENTS.map((a) => a.name);

/**
 * The mode each team agent's chats start in (D249): the planner plans, Chat answers. For the
 * files written before `mode:` was (D245); a `mode:` in the file wins.
 */
export const TEAM_START_MODES: Readonly<Record<string, "plan" | "ask">> = Object.fromEntries(
  TEAM.flatMap((t) => {
    const mode = AGENT_TEMPLATES.find((x) => x.id === t.template)?.startMode;
    return mode ? [[t.name, mode]] : [];
  }),
);

/**
 * A team agent's file moved to its model's logo (D270), when it still has the face it was first
 * written with; null when it's not a team agent's or the user changed the face.
 */
export function withTeamModelIcon(name: string, text: string): string | null {
  const first = FIRST_ICONS[name];
  const header = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const icon = header ? /^icon\s*:\s*["']?([^"'\r\n]*?)["']?\s*$/m.exec(header)?.[1] : undefined;
  return first && icon?.trim() === first ? setHeaderFields(text, { icon: MODEL_ICON }) : null;
}
