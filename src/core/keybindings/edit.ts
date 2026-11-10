// Editing keybindings.json the way VS Code's keyboard shortcuts editor does (D204), per binding:
// a user's own entry is changed or removed in place; a default binding is replaced by a removal
// rule for it ("-command" with its key and `when`) plus the new rule. DOM-free and tested; the
// edits are applied to the file's text with the JSONC helpers, keeping comments.
import { appendJsoncArrayItem, setJsoncArrayItem } from "../settings/jsoncEdit";
import type { KeybindingRule } from "./index";
import { type Platform, parseKeybinding } from "./keys";

/** One row of the shortcuts table: which binding is being edited. */
export interface BindingRef {
  command: string;
  /** Its key, normalized chords joined by a space ("ctrl+k ctrl+c"). */
  key: string;
  when?: string | undefined;
  source: "default" | "user";
  args?: unknown;
}

export type RuleEdit =
  | { kind: "append"; value: KeybindingRule }
  | { kind: "replace"; index: number; value: KeybindingRule }
  | { kind: "remove"; index: number };

interface Entry {
  key?: unknown;
  mac?: unknown;
  command?: unknown;
  when?: unknown;
  args?: unknown;
}

function sameKey(a: string, b: string): boolean {
  try {
    return parseKeybinding(a).join(" ") === parseKeybinding(b).join(" ");
  } catch {
    return false;
  }
}

const blank = (when: unknown) => (typeof when === "string" && when.trim() ? when.trim() : "");

/** The index of the user's entry behind `ref` in keybindings.json (the last match), or -1. */
export function findUserEntry(
  entries: readonly unknown[],
  ref: BindingRef,
  platform: Platform,
): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as Entry | null;
    if (!e || typeof e !== "object" || e.command !== ref.command) continue;
    const key = platform === "mac" && typeof e.mac === "string" ? e.mac : e.key;
    if (typeof key !== "string" || !sameKey(key, ref.key)) continue;
    if (blank(e.when) !== blank(ref.when)) continue;
    return i;
  }
  return -1;
}

/** The rule for `command` on `key` with `when` (no `when` property when empty). */
function rule(
  command: string,
  key: string,
  when: string | undefined,
  args?: unknown,
): KeybindingRule {
  const w = blank(when);
  return { key, command, ...(w && { when: w }), ...(args !== undefined && { args }) };
}

/** Takes a default binding away: VS Code's removal rule, with its key and `when`. */
function removalOf(ref: BindingRef): KeybindingRule {
  return rule(`-${ref.command}`, ref.key, ref.when);
}

/** The user's entry for `ref`, or why there isn't one to edit. */
function userEntry(
  entries: readonly unknown[],
  ref: BindingRef,
  platform: Platform,
): { index: number; entry: Entry } {
  const index = findUserEntry(entries, ref, platform);
  if (index < 0) throw new Error(`keybindings.json has no entry for ${ref.command} on ${ref.key}.`);
  return { index, entry: entries[index] as Entry };
}

/** Keeps the entry's other fields; `key` (or `mac` on macOS when it has one) and `when` changed. */
function changedEntry(entry: Entry, platform: Platform, key: string, when: string): KeybindingRule {
  const out = { ...(entry as Record<string, unknown>) } as Record<string, unknown>;
  if (platform === "mac" && typeof entry.mac === "string") out.mac = key;
  else out.key = key;
  if (when) out.when = when;
  else delete out.when;
  return out as unknown as KeybindingRule;
}

/** Puts `ref` on another key (VS Code's "Change keybinding"). */
export function changeKey(
  entries: readonly unknown[],
  ref: BindingRef,
  newKey: string,
  platform: Platform,
): RuleEdit[] {
  if (ref.source === "user") {
    const { index, entry } = userEntry(entries, ref, platform);
    return [
      { kind: "replace", index, value: changedEntry(entry, platform, newKey, blank(ref.when)) },
    ];
  }
  return [
    { kind: "append", value: removalOf(ref) },
    { kind: "append", value: rule(ref.command, newKey, ref.when, ref.args) },
  ];
}

/** Gives `ref` another `when` clause (VS Code's "Change when expression"); "" removes it. */
export function changeWhen(
  entries: readonly unknown[],
  ref: BindingRef,
  when: string,
  platform: Platform,
): RuleEdit[] {
  if (blank(when) === blank(ref.when)) return [];
  if (ref.source === "user") {
    const { index, entry } = userEntry(entries, ref, platform);
    const key = (
      platform === "mac" && typeof entry.mac === "string" ? entry.mac : entry.key
    ) as string;
    return [{ kind: "replace", index, value: changedEntry(entry, platform, key, blank(when)) }];
  }
  return [
    { kind: "append", value: removalOf(ref) },
    { kind: "append", value: rule(ref.command, ref.key, when, ref.args) },
  ];
}

/** Removes `ref` (VS Code's "Remove keybinding"): the user's entry goes, a default is taken away. */
export function removeBinding(
  entries: readonly unknown[],
  ref: BindingRef,
  platform: Platform,
): RuleEdit[] {
  if (ref.source === "user") {
    const { index } = userEntry(entries, ref, platform);
    return [{ kind: "remove", index }];
  }
  return [{ kind: "append", value: removalOf(ref) }];
}

/** Another key for `command`, keeping the ones it has (VS Code's "Add keybinding"). */
export function addBinding(command: string, key: string, when?: string): RuleEdit[] {
  return [{ kind: "append", value: rule(command, key, when) }];
}

/** Applies edits to keybindings.json's text: replacements and removals first (last first), then appends. */
export function applyRuleEdits(text: string, edits: readonly RuleEdit[]): string {
  let next = text.trim() ? text : "[\n]\n";
  const inPlace = edits
    .filter((e): e is Exclude<RuleEdit, { kind: "append" }> => e.kind !== "append")
    .sort((a, b) => b.index - a.index);
  for (const e of inPlace)
    next = setJsoncArrayItem(next, e.index, e.kind === "replace" ? e.value : undefined);
  for (const e of edits) if (e.kind === "append") next = appendJsoncArrayItem(next, e.value);
  return next;
}
