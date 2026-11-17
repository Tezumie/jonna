// What arrived by sync and wasn't accepted on this computer yet. One of the account's other
// computers (or anyone holding its keys) can write the user's files; here they are "from
// another computer" until the person accepts them: a skill or command among them pre-approves
// no tools, and a keyboard shortcut among them that could run something isn't applied. The
// backend keeps the record (which file, with what content) outside what syncs; a file edited
// here afterwards has other content, and so counts as accepted. DOM-free and tested.
import { parseSkillFile } from "../agent/skills";
import { parseCommandFile } from "../agent/slash";
import { validateUserKeybindings } from "../keybindings/effective";
import type { KeybindingRule } from "../keybindings/index";
import { type Signal, signal } from "../reactive/index";
import { parseJsonc } from "../settings/jsonc";

/**
 * Counts up when what waits changed without a file changing (the person accepted something):
 * whoever applied the list (the keyboard shortcuts) reads it again.
 */
export const incomingRevision: Signal<number> = signal(0);

/** One file as the backend lists it: written by a sync download, unchanged and not accepted. */
export interface IncomingFile {
  /** Its synced name (`keybindings.json`, `skills/review/SKILL.md`). */
  path: string;
  /**
   * For the keyboard shortcuts: the file as it was before the first download that wasn't
   * accepted (null: there was none), so only what is new is held back.
   */
  before: string | null;
  /** Whether the person was told about it already. */
  told: boolean;
}

/** Command families that run programs, start the agent or drive a debugger. */
const RUNNING_FAMILIES: readonly string[] = [
  "terminal.",
  "task.",
  "tasks.",
  "agent.",
  "debug.",
  "shell.",
  "exec.",
  "tests.",
  "testing.",
  "notebook.",
  "mcp.",
  "extensions.",
  "remote.",
  "dev.",
  "workbench.action.terminal",
];

function hasContent(args: unknown): boolean {
  if (args === undefined || args === null || args === "") return false;
  if (Array.isArray(args)) return args.length > 0;
  if (typeof args === "object") return Object.keys(args).length > 0;
  return true;
}

/**
 * Whether a keyboard shortcut could run something on a key press: it carries arguments (Enter
 * bound to a terminal command with its text), or its command is in a family that runs
 * programs. A removal ("-command") only takes a shortcut away.
 */
export function bindingCanRun(rule: Pick<KeybindingRule, "command" | "args">): boolean {
  if (rule.command.startsWith("-")) return false;
  if (hasContent(rule.args)) return true;
  return RUNNING_FAMILIES.some((family) => rule.command.startsWith(family));
}

/** A shortcut's identity, for telling one that was here already from a new one. */
function bindingKey(rule: KeybindingRule): string {
  return JSON.stringify([
    rule.key,
    rule.mac ?? null,
    rule.command,
    rule.when ?? null,
    rule.args ?? null,
  ]);
}

function rulesOf(text: string | null): KeybindingRule[] {
  if (!text?.trim()) return [];
  const parsed = parseJsonc(text);
  return parsed.ok ? validateUserKeybindings(parsed.value).rules : [];
}

/**
 * The shortcuts of a keybindings file that arrived by sync, split: `applied` are in use,
 * `withheld` wait until the file is accepted here. Held back are the ones that could run
 * something (`bindingCanRun`) and weren't in the file before it arrived. `incoming` null: the
 * file is the person's own, and everything applies.
 */
export function splitBindings(
  rules: readonly KeybindingRule[],
  incoming: Pick<IncomingFile, "before"> | null,
): { applied: KeybindingRule[]; withheld: KeybindingRule[] } {
  if (!incoming) return { applied: [...rules], withheld: [] };
  const known = new Set(rulesOf(incoming.before).filter(bindingCanRun).map(bindingKey));
  const applied: KeybindingRule[] = [];
  const withheld: KeybindingRule[] = [];
  for (const rule of rules)
    (bindingCanRun(rule) && !known.has(bindingKey(rule)) ? withheld : applied).push(rule);
  return { applied, withheld };
}

/** The synced name of the keyboard shortcuts file. */
export const KEYBINDINGS_FILE = "keybindings.json";

/** The entry of the keyboard shortcuts file among what arrived, or null. */
export function incomingKeybindings(files: readonly IncomingFile[]): IncomingFile | null {
  return files.find((f) => f.path === KEYBINDINGS_FILE) ?? null;
}

/**
 * Whether the user's own skill in folder `folder` (of the IDE's user skills folder) has a file
 * that arrived by sync and wasn't accepted here: any of its files, since a script the skill
 * runs is as much the skill as its SKILL.md.
 */
export function skillIsIncoming(files: readonly IncomingFile[], folder: string): boolean {
  // Letter case aside: on a file system that doesn't tell `Review` from `review` they are
  // one folder, and taking one too many as not accepted only makes its tools ask.
  const prefix = `skills/${folder}/`.toLowerCase();
  return files.some((f) => f.path.toLowerCase().startsWith(prefix));
}

/** Whether the user's own command file `file` (`ship.md`) arrived by sync and wasn't accepted. */
export function commandIsIncoming(files: readonly IncomingFile[], file: string): boolean {
  const name = `commands/${file}`.toLowerCase();
  return files.some((f) => f.path.toLowerCase() === name);
}

export type IncomingKind = "skill" | "command" | "keybindings" | "rules";

/** One thing to review: a skill (all its files), a command, the shortcuts, a rules file. */
export interface IncomingItem {
  /** `skills/review`, `commands/ship.md`, `keybindings.json`, `AGENTS.md`. */
  id: string;
  kind: IncomingKind;
  /** As shown: the skill's or command's name, "Keyboard shortcuts", the file's name. */
  name: string;
  /** What it waits for, in a sentence. */
  detail: string;
  /** Whether it could run commands once accepted (false: it only steers the agent). */
  runs: boolean;
  /** The files it stands for (what accepting it accepts). */
  paths: string[];
  /** Whether the person was told about all of it. */
  told: boolean;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * What arrived, as things to review. `read` gives a file's text now (null: not readable), for
 * what a skill or a command asks for. Shortcuts with nothing held back aren't listed.
 */
export async function incomingItems(
  files: readonly IncomingFile[],
  read: (path: string) => Promise<string | null>,
): Promise<IncomingItem[]> {
  const items: IncomingItem[] = [];
  const skills = new Map<string, IncomingFile[]>();
  for (const file of files) {
    const parts = file.path.split("/");
    if (file.path === KEYBINDINGS_FILE) {
      const { withheld } = splitBindings(rulesOf(await read(file.path)), file);
      if (withheld.length === 0) continue;
      items.push({
        id: file.path,
        kind: "keybindings",
        name: "Keyboard shortcuts",
        detail: `${plural(withheld.length, "shortcut", "shortcuts")} that could run something ${withheld.length === 1 ? "isn't" : "aren't"} in use here yet: ${withheld
          .slice(0, 3)
          .map((rule) => `${rule.key} (${rule.command})`)
          .join(", ")}${withheld.length > 3 ? "…" : ""}`,
        runs: true,
        paths: [file.path],
        told: file.told,
      });
    } else if (parts[0] === "skills" && parts.length > 2) {
      const folder = parts[1] ?? "";
      skills.set(folder, [...(skills.get(folder) ?? []), file]);
    } else if (parts[0] === "commands" && parts.length === 2) {
      const text = await read(file.path);
      // Not readable: taken to ask for tools, so it is counted rather than missed.
      const tools = text === null ? null : parseCommandFile(text).allowedTools;
      const runs = tools === null || tools.length > 0;
      items.push({
        id: file.path,
        kind: "command",
        name: `/${(parts[1] ?? "").replace(/\.md$/i, "")}`,
        detail: runs
          ? `Its tools ask before they run until you accept it${tools?.length ? `: ${tools.join(", ")}` : ""}.`
          : "A command from another computer. It approves no tools by itself.",
        runs,
        paths: [file.path],
        told: file.told,
      });
    } else {
      items.push({
        id: file.path,
        kind: "rules",
        name: file.path,
        detail: "Steers the agent and runs nothing by itself. It is in use here already.",
        runs: false,
        paths: [file.path],
        told: file.told,
      });
    }
  }
  for (const [folder, parts] of skills) {
    const text = await read(`skills/${folder}/SKILL.md`);
    const tools = text === null ? null : (parseSkillFile(text, folder).skill?.allowedTools ?? []);
    const runs = tools === null || tools.length > 0;
    items.push({
      id: `skills/${folder}`,
      kind: "skill",
      name: folder,
      detail: runs
        ? `Its tools ask before they run until you accept it${tools?.length ? `: ${tools.join(", ")}` : ""}.`
        : `A skill from another computer (${plural(parts.length, "file", "files")}). It approves no tools by itself.`,
      runs,
      paths: parts.map((f) => f.path),
      told: parts.every((f) => f.told),
    });
  }
  // What can run commands first, then by name.
  return items.sort((a, b) => Number(b.runs) - Number(a.runs) || a.id.localeCompare(b.id));
}

/**
 * What to say the first time such content arrives: null when nothing that can run commands is
 * new since the person was last told.
 */
export function incomingNotice(items: readonly IncomingItem[]): string | null {
  const running = items.filter((item) => item.runs);
  if (!running.some((item) => !item.told)) return null;
  return `Settings from another of your computers include ${plural(running.length, "item", "items")} that can run commands. Review them before they apply here.`;
}

/** The files accepting `id` accepts (null: every file), or an error when nothing has that id. */
export function pathsToAccept(items: readonly IncomingItem[], id: string | null): string[] | null {
  if (id === null) return null;
  const item = items.find((entry) => entry.id === id);
  if (!item) throw new Error(`Nothing called ${id} is waiting to be accepted.`);
  return item.paths;
}
