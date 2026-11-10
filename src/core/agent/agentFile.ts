// Editing an agent's file in place (D230): the agent editor changes header fields (label, role,
// icon, description, model, tools, permissionMode) and the instructions without rewriting what it
// doesn't know — Claude Code's own keys (`color`, `hooks`, `skills`…) and comments stay as they
// were, so a file shared with Claude Code or VS Code keeps working there. DOM-free and tested.

/** A header value written back: plain when it can be, else double-quoted with escapes. */
export function headerValue(value: string): string {
  const v = value.replace(/\r?\n/g, " ").trim();
  if (v === "") return '""';
  // YAML reads these specially (or they'd start a comment, a list, a mapping…): quote them.
  if (/^[\s\-?:,[\]{}#&*!|>'"%@`]|: |\s#|^(true|false|null|yes|no|on|off|~)$/i.test(v))
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return v;
}

interface Split {
  bom: string;
  header: string[];
  newline: string;
  body: string;
}

function split(text: string): Split | null {
  const m = /^(﻿?)---(\r?\n)([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  return {
    bom: m[1] ?? "",
    newline: m[2] ?? "\n",
    header: (m[3] ?? "").split(/\r?\n/),
    body: m[4] ?? "",
  };
}

/** Where a key's entry spans in the header lines: its line and the indented / list lines after. */
function entryRange(lines: readonly string[], key: string): [number, number] | null {
  const start = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && /^(\s+\S|\s*-\s)/.test(lines[end] ?? "")) end++;
  return [start, end];
}

/**
 * Sets header fields: a string replaces (or adds) the key, null removes it. Other keys, their
 * order and comments are kept; new keys go at the end of the header.
 */
export function setHeaderFields(text: string, fields: Record<string, string | null>): string {
  const parts = split(text);
  if (!parts) return text;
  const lines = [...parts.header];
  for (const [key, value] of Object.entries(fields)) {
    const range = entryRange(lines, key);
    const line = value === null ? null : `${key}: ${headerValue(value)}`;
    if (range) lines.splice(range[0], range[1] - range[0], ...(line === null ? [] : [line]));
    else if (line !== null) lines.push(line);
  }
  const nl = parts.newline;
  return `${parts.bom}---${nl}${lines.join(nl)}${nl}---${nl}${parts.body}`;
}

/** Replaces the instructions (the text after the header), ending with one newline. */
export function setBody(text: string, body: string): string {
  const parts = split(text);
  if (!parts) return text;
  const nl = parts.newline;
  const head = text.slice(0, text.length - parts.body.length);
  const clean = body.replace(/\r?\n/g, nl).trim();
  return `${head}${nl}${clean}${nl}`;
}

export interface NewAgentFile {
  name: string;
  label?: string;
  role?: string;
  icon?: string;
  description: string;
  model?: string;
  /** Tool names; omitted: every tool the agent has. */
  tools?: readonly string[];
  readOnly?: boolean;
  /** The mode its chats start in (D249); Agent is left out. */
  startMode?: "agent" | "plan" | "ask";
  instructions: string;
}

/** A new agent's file (the format Claude Code reads, plus label / role / icon). */
export function newAgentFile(agent: NewAgentFile): string {
  const lines = [
    "---",
    `name: ${agent.name}`,
    ...(agent.label ? [`label: ${headerValue(agent.label)}`] : []),
    ...(agent.role ? [`role: ${headerValue(agent.role)}`] : []),
    ...(agent.icon ? [`icon: ${agent.icon}`] : []),
    `description: ${headerValue(agent.description || "What it does, and when to hand work to it.")}`,
    ...(agent.tools ? [`tools: ${agent.tools.join(", ")}`] : []),
    ...(agent.readOnly ? ["permissionMode: plan"] : []),
    ...(agent.startMode && agent.startMode !== "agent" ? [`mode: ${agent.startMode}`] : []),
    `model: ${agent.model || "inherit"}`,
    "---",
    "",
    agent.instructions.trim(),
    "",
  ];
  return lines.join("\n");
}

/** An agent id from a display name: "Test runner" → "test-runner" (empty when nothing's left). */
export function agentIdFromLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}
