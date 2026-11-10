// The agent editor's model (D230): what an agent may do as one of three access levels, mapped to
// and from its file's header, and the templates a new agent starts from. DOM-free and tested.
//
//   Read only       permissionMode: plan        (only the reading tools, whatever else it says)
//   Can edit files  tools: the reading tools + edit_file, write_file
//   Full            no tools line               (every tool, commands included)
//
// A tools line that is neither (a hand-written list) reads as "custom": the editor shows it in its
// Advanced fold and leaves it alone until another level is picked.

import { type NewAgentFile, newAgentFile } from "./agentFile";
import { FACE_EYES, FACE_SHAPES, type FaceSpec } from "./faces";
import { READ_TOOLS, type SubagentDef } from "./subagents";

export type AgentAccess = "read" | "edit" | "full";

/** The tools of "Can edit files": reading, plus changing files (no commands). */
export const EDIT_TOOLS: readonly string[] = [...READ_TOOLS, "edit_file", "write_file"];

export const ACCESS_LEVELS: readonly { id: AgentAccess; label: string; detail: string }[] = [
  { id: "read", label: "Read only", detail: "Reads and searches; changes nothing" },
  { id: "edit", label: "Can edit files", detail: "Reads and edits files; runs no commands" },
  { id: "full", label: "Full", detail: "Every tool the agent has, commands included" },
];

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The access level a definition has; null when its tools line is a list of its own. */
export function accessOf(def: Pick<SubagentDef, "readOnly" | "tools">): AgentAccess | null {
  if (def.readOnly) return "read";
  if (!def.tools) return "full";
  if (def.tools.every((t) => READ_TOOLS.includes(t))) return "read";
  if (sameSet(def.tools, EDIT_TOOLS)) return "edit";
  return null;
}

/**
 * The header fields that give a file `level` (for setHeaderFields). `text` is the file as it is:
 * a permissionMode other than plan (Claude Code's acceptEdits…) is kept unless the level is "read".
 */
export function accessFields(level: AgentAccess, text = ""): Record<string, string | null> {
  const plan = /^permissionMode\s*:\s*["']?plan["']?\s*(#.*)?$/m.test(text);
  const keepMode: Record<string, string | null> = plan ? { permissionMode: null } : {};
  switch (level) {
    case "read":
      return { permissionMode: "plan", readOnly: null, tools: null };
    case "edit":
      return { ...keepMode, readOnly: null, tools: EDIT_TOOLS.join(", ") };
    case "full":
      return { ...keepMode, readOnly: null, tools: null };
  }
}

/** The part of a new file that `level` sets (for newAgentFile). */
export function accessFile(level: AgentAccess): Pick<NewAgentFile, "tools" | "readOnly"> {
  if (level === "read") return { readOnly: true };
  if (level === "edit") return { tools: EDIT_TOOLS };
  return {};
}

/** A tools field as typed ("read_file, search" or one per line) → names, empty: none given. */
export function parseToolList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t, i, all) => t && all.indexOf(t) === i);
}

export interface AgentTemplate {
  id: string;
  /** The chip's text and the new agent's name. Empty for Blank. */
  label: string;
  role: string;
  description: string;
  instructions: string;
  access: AgentAccess;
  /** The mode its chats start in (D249): the planner plans, Chat answers. */
  startMode?: "plan" | "ask";
  /** A face code (core/agent/faces.ts); Blank has none (one from its name, or shuffled). */
  icon?: string;
}

/** Starting points for a new agent: recipes for code work, each a few practical lines. */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: "planner",
    label: "Planner",
    role: "Plans",
    description:
      "Works out how to make a change before anyone edits: reads the code, asks what's unclear, and writes a step-by-step plan. Read-only. Use before a change that spans several files.",
    access: "read",
    startMode: "plan",
    icon: "squircle-2-wide",
    instructions: `You plan code changes; you don't make them.

- Read enough of the code to understand how it works today: the files involved, their callers, the tests.
- If the request is ambiguous, ask one or two short questions before planning instead of guessing.
- Write a numbered plan: each step names the files and what changes there, in the order to do them. Then the risks, and how to check the result (which tests or commands).
- Keep it as small as the request allows. Don't change anything.`,
  },
  {
    id: "chat",
    label: "Chat",
    role: "Talks it through",
    description:
      "Answers questions and talks ideas through: explains code, compares approaches, drafts text. Read-only, so it's safe to think out loud with.",
    access: "read",
    startMode: "ask",
    icon: "round-5-happy",
    instructions: `You're a thoughtful colleague to talk things through with.

- Answer the question that was asked, directly and briefly, then add what's worth knowing.
- When it's about this project, read the code before answering and point to the files and lines.
- For a choice, give your recommendation and why, not a survey of every option.
- You don't change files or run commands. When the user wants something built, say what you'd do and suggest handing it to the planner or the builder.`,
  },
  {
    id: "builder",
    label: "Builder",
    role: "Builder",
    description:
      "Carries out a plan: makes the code changes it lists, step by step, and checks them. Use once a plan is agreed (from Plan mode or the plan helper).",
    access: "full",
    icon: "blob-1-dots",
    instructions: `You build what a plan describes.

- Read the plan and the files it names before changing anything. If a step is unclear or wrong for the code you find, say so instead of guessing.
- Work through the steps in order, keeping each change small and in the project's style. Don't add what the plan doesn't ask for.
- After the changes, run the project's checks or tests for what you touched and fix what they find.
- Report what you changed per step, how you checked it, and anything left or out of the plan.`,
  },
  {
    id: "reviewer",
    label: "Code reviewer",
    role: "Reviewer",
    description:
      "Reviews a change or a file for bugs, edge cases, security issues and missing tests, most severe first. Use after making changes.",
    access: "read",
    icon: "squircle-4-wide",
    instructions: `You review code like a careful senior engineer.

- Read the changed files and enough of their callers to understand the change.
- Look for bugs, unhandled edge cases (empty input, errors, concurrency), security issues, missing or wrong tests, and code that will confuse the next reader.
- Report only concrete problems, most severe first. For each: the file and line, what goes wrong, and a suggested fix.
- If it looks right, say so in one line. Don't change anything.`,
  },
  {
    id: "tests",
    label: "Test writer",
    role: "Tests",
    description:
      "Writes or extends tests for a piece of code, following the project's test style. Use after adding or changing behavior.",
    access: "edit",
    icon: "round-3-happy",
    instructions: `You write tests.

- Find how the project tests similar code (framework, file names, helpers) and follow it exactly.
- Cover the main behavior, the edge cases and the error paths; one idea per test, named for what it checks.
- Don't change the code under test. If it looks wrong, say so in your report instead.
- Report the tests you added, where, and how to run them.`,
  },
  {
    id: "docs",
    label: "Docs writer",
    role: "Docs",
    description:
      "Writes and updates documentation (READMEs, doc comments, guides) to match the code. Use after a change people need to know about.",
    access: "edit",
    icon: "cloud-6-dots",
    instructions: `You write documentation.

- Read the code first; document what it does, not what you guess.
- Match the existing docs' tone, structure and formatting. Keep it short: purpose, usage, an example, caveats.
- Update what's out of date rather than adding a second explanation.
- Report the files you changed.`,
  },
  {
    id: "refactorer",
    label: "Refactorer",
    role: "Refactoring",
    description:
      "Restructures code without changing what it does: renames, extractions, removing duplication. Use for cleanup in one area.",
    access: "edit",
    icon: "bean-2-tall",
    instructions: `You refactor code without changing its behavior.

- Understand the area and its callers before moving anything.
- Make small, mechanical steps: rename, extract, inline, remove duplication. Keep public interfaces unless told otherwise.
- Update every caller and import you affect.
- Report what you changed and anything that should be checked by running the tests.`,
  },
  {
    id: "debugger",
    label: "Debugger",
    role: "Debugging",
    description:
      "Finds the cause of a bug or a failing test by reproducing it, then fixes it. Use when something fails and the cause isn't obvious.",
    access: "full",
    icon: "drop-5-wide",
    instructions: `You find and fix bugs.

- Reproduce the problem first (run the failing test or command) and read the full error.
- Form a hypothesis, check it with the smallest experiment, and narrow down to the root cause. Don't guess-fix symptoms.
- Fix the cause with the smallest change, then run the reproduction again to confirm.
- Report the cause, the fix and how you verified it.`,
  },
  {
    id: "researcher",
    label: "Researcher",
    role: "Research",
    description:
      "Answers questions about the codebase: where something lives, how it works, what calls what. Read-only. Use before changing unfamiliar code.",
    access: "read",
    icon: "pebble-7-dots",
    instructions: `You research the codebase and answer a question.

- Search broadly first, then read the files that matter.
- Answer directly, with the files and lines that support it. Say what you couldn't confirm.
- Keep it short: the answer first, then the evidence. Don't change anything.`,
  },
  {
    id: "blank",
    label: "",
    role: "",
    description: "",
    access: "read",
    instructions: "",
  },
];

/** A template's agent as a file (named `name`), the way the editor creates it. */
export function templateFile(template: AgentTemplate, name: string): string {
  return newAgentFile({
    name,
    ...(template.label && template.label !== name && { label: template.label }),
    ...(template.role && { role: template.role }),
    ...(template.icon && { icon: template.icon }),
    description: template.description,
    instructions: template.instructions,
    ...accessFile(template.access),
    ...(template.startMode && { startMode: template.startMode }),
  });
}

/**
 * The editor's row of candidate faces: `count` different shape-and-eyes pairs (the color is the
 * swatch row's), `current` first so it shows as picked until another is.
 */
export function faceChoices(
  count: number,
  current?: FaceSpec,
  random: () => number = Math.random,
): FaceSpec[] {
  const color = current?.color ?? 1;
  const all = FACE_SHAPES.flatMap((shape) => FACE_EYES.map((eyes) => ({ shape, color, eyes })));
  // Fisher-Yates over a copy, then the current face moved to the front.
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1)) % (i + 1);
    [all[i], all[j]] = [all[j] as FaceSpec, all[i] as FaceSpec];
  }
  const rest = all.filter((f) => !current || f.shape !== current.shape || f.eyes !== current.eyes);
  return [...(current ? [{ ...current }] : []), ...rest].slice(0, Math.max(0, count));
}
