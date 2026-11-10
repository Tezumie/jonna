// "Configure default build task" / "Configure default test task" (VS Code's): the picked task
// becomes `"group": { "kind": "build", "isDefault": true }` in tasks.json and every other task of
// that group stops being the default. A task detected from package.json gets an entry of its
// own (`"type": "npm"`, or a shell task for pnpm / yarn / bun) with the same label, which then
// wins over the detected one. Comments outside the "tasks" array are kept; the array itself is
// written back as JSON. DOM-free and tested.
import { parseJsonc } from "../../core/settings/jsonc";
import { setJsoncProperty } from "../../core/settings/jsoncEdit";
import type { TaskDefinition } from "./tasks";

const EMPTY_FILE = `{
  // See "Run task…" and VS Code's tasks.json format.
  "version": "2.0.0",
  "tasks": []
}
`;

/** The label a tasks.json entry gets (as `parseTasksJson` reads it). */
export function entryLabel(entry: Record<string, unknown>): string | undefined {
  if (typeof entry.label === "string") return entry.label;
  if (typeof entry.taskName === "string") return entry.taskName;
  if (entry.type === "npm" && typeof entry.script === "string") return `npm: ${entry.script}`;
  return typeof entry.command === "string" ? entry.command : undefined;
}

function groupKind(group: unknown): string | undefined {
  if (typeof group === "string") return group;
  if (group && typeof group === "object" && typeof (group as { kind?: unknown }).kind === "string")
    return (group as { kind: string }).kind;
  return undefined;
}

/** The tasks.json entry for a task found in package.json ("npm: build", "pnpm: test"). */
export function entryForDetected(task: TaskDefinition): Record<string, unknown> {
  const match = /^(npm|pnpm|yarn|bun): (.+)$/.exec(task.label);
  const manager = match?.[1];
  const script = match?.[2];
  if (manager === "npm" && script)
    return {
      type: "npm",
      script,
      label: task.label,
      ...(task.detail && { detail: task.detail }),
      problemMatcher: [],
    };
  // Make, Cargo, tsc… (detect.ts): a shell task run from its folder, with its matcher.
  return {
    label: task.label,
    type: "shell",
    command: task.command,
    ...(task.folder && { options: { cwd: `\${workspaceFolder}/${task.folder}` } }),
    ...(task.detail && { detail: task.detail }),
    problemMatcher: task.problemMatcher ?? [],
  };
}

/** Whether a tasks.json's text has a default task of `kind`. */
export function hasDefaultTask(text: string, kind: string): boolean {
  const parsed = parseJsonc(text);
  const tasks = parsed.ok ? (parsed.value as { tasks?: unknown } | null)?.tasks : undefined;
  return (
    Array.isArray(tasks) &&
    tasks.some((t) => {
      const g = (t as { group?: unknown } | null)?.group;
      return groupKind(g) === kind && (g as { isDefault?: unknown }).isDefault === true;
    })
  );
}

/**
 * `text` (a tasks.json, or "" for a new one) with `task` as the default of `kind`, or with no
 * default of `kind` when `task` is null (another file holds the new one). Returns null when the
 * file can't be read as JSON (left for the user to fix).
 */
export function setDefaultTask(
  text: string,
  kind: "build" | "test",
  task: TaskDefinition | null,
): string | null {
  const source = text.trim() ? text : EMPTY_FILE;
  const parsed = parseJsonc(source);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") return null;
  const top = parsed.value as Record<string, unknown>;
  const list = Array.isArray(top.tasks) ? [...top.tasks] : [];
  let found = false;
  const tasks = list.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const entry = { ...(raw as Record<string, unknown>) };
    if (task && entryLabel(entry) === task.label) {
      found = true;
      entry.group = { kind, isDefault: true };
      return entry;
    }
    // Others in the group stay in it, no longer the default (VS Code writes the plain kind).
    const g = entry.group;
    if (groupKind(g) === kind && g && typeof g === "object") entry.group = kind;
    return entry;
  });
  if (task && !found) tasks.push({ ...entryForDetected(task), group: { kind, isDefault: true } });
  let out = source;
  if (top.version === undefined) out = setJsoncProperty(out, "version", "2.0.0");
  return setJsoncProperty(out, "tasks", tasks);
}
