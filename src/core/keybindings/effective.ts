// The effective keybinding table (defaults + user rules after "-command" removals), with the
// source of each binding and conflicts: two commands on the same key whose `when` clauses can
// both hold (identical clauses, or one of them unconditional), unless the clauses can't hold
// together (`explorerFocus` and the editor's keys, `isMac` and `!isMac`, `x < 2` and `x > 5`;
// D209, D219: whenLogic.ts), with this platform's constants substituted first (`isMac` on
// Windows is false, so such a binding conflicts with nothing there). A key the IDE and
// the editor engine share is "resolved", not a conflict (D209): in an editor the engine's binding
// runs when its own `when` holds, as VS Code's editor keys do, and the IDE's everywhere else; a
// user's keybinding wins over both. DOM-free and tested.

import type { KeybindingRule } from "./index";
import { keybindingLabel, type Platform, parseKeybinding } from "./keys";
import {
  platformConstants,
  removalMatches,
  whenAlwaysHolds,
  whensCanOverlap,
  whensEqual,
} from "./whenLogic";

export {
  removalMatches,
  type WhenConstants,
  whensCanOverlap,
  whensEqual,
} from "./whenLogic";

export type KeybindingSource = "default" | "user";

export interface SourcedRule extends KeybindingRule {
  source: KeybindingSource;
  /** The editor engine's command (Monaco's own, D204). */
  engine?: boolean;
}

export interface EffectiveBinding {
  command: string;
  /** Normalized chords, e.g. ["ctrl+k", "ctrl+o"]. */
  chords: string[];
  label: string;
  when: string | undefined;
  source: KeybindingSource;
  /** The editor engine's command (Monaco's own, D204). */
  engine?: boolean;
  args?: unknown;
  /** Other commands bound to the same key that can be active at the same time. */
  conflicts: string[];
  /** Commands on the same key where it's settled which one runs (D209), with how. */
  resolved: { command: string; note: string }[];
}

export function effectiveBindings(
  rules: readonly SourcedRule[],
  platform: Platform,
): EffectiveBinding[] {
  const out: Omit<EffectiveBinding, "conflicts" | "resolved">[] = [];
  for (const rule of rules) {
    const key = platform === "mac" && rule.mac ? rule.mac : rule.key;
    if (rule.command.startsWith("-")) {
      const command = rule.command.slice(1);
      const chords = key ? (safeParse(key)?.join(" ") ?? null) : null;
      // With a `when`, only the binding with that clause goes (VS Code's rule, D219).
      const removal = { command, chords, when: rule.when };
      for (let i = out.length - 1; i >= 0; i--) {
        const b = out[i];
        if (b && removalMatches(removal, { ...b, chords: b.chords.join(" ") })) out.splice(i, 1);
      }
      continue;
    }
    const chords = safeParse(key);
    if (!chords) continue;
    out.push({
      command: rule.command,
      chords,
      label: keybindingLabel(chords, platform),
      when: rule.when,
      source: rule.source,
      ...(rule.engine && { engine: true }),
      ...(rule.args !== undefined && { args: rule.args }),
    });
  }
  // Grouped by key first: with the editor engine's few hundred bindings (D204) a pairwise scan of
  // the whole table would be slow for every refresh.
  const constants = platformConstants(platform);
  const byKey = new Map<string, typeof out>();
  for (const b of out) {
    const key = b.chords.join(" ");
    const list = byKey.get(key);
    if (list) list.push(b);
    else byKey.set(key, [b]);
  }
  return out.map((b) => {
    const conflicts: string[] = [];
    const resolved: { command: string; note: string }[] = [];
    for (const o of byKey.get(b.chords.join(" ")) ?? []) {
      if (o === b || o.command === b.command) continue;
      // The engine sorts out its own defaults (their when clauses are its context keys).
      if (o.engine && b.engine && o.source === "default" && b.source === "default") continue;
      if (!whensCanOverlap(effectiveWhen(b), effectiveWhen(o), constants)) continue;
      const note = resolution(b, o);
      if (note) resolved.push({ command: o.command, note });
      else if (
        whenAlwaysHolds(o.when, constants) ||
        whenAlwaysHolds(b.when, constants) ||
        whensEqual(o.when, b.when, constants)
      )
        conflicts.push(o.command);
    }
    return { ...b, conflicts, resolved };
  });
}

/** The engine's keys only reach it in an editor: their clause, as the IDE sees it. */
function effectiveWhen(b: { when: string | undefined; engine?: boolean }): string | undefined {
  if (!b.engine) return b.when;
  return b.when ? `editorFocus && (${b.when})` : "editorFocus";
}

/**
 * How a key shared by the IDE and the editor engine is settled (D209), from `b`'s side; undefined
 * when it isn't (two IDE commands, or two of the user's own: a real conflict).
 */
function resolution(
  b: { command: string; source: KeybindingSource; engine?: boolean; when: string | undefined },
  o: { command: string; source: KeybindingSource; engine?: boolean },
): string | undefined {
  if (!!b.engine === !!o.engine) return undefined;
  if (b.source === "user" && o.source === "user") return undefined;
  const editorSide = b.engine ? b : o;
  const ideSide = b.engine ? o : b;
  if (ideSide.source === "user")
    return b === ideSide
      ? `Your keybinding wins over the editor's ${o.command}.`
      : `Your keybinding for ${o.command} wins over this.`;
  if (editorSide.source === "user")
    return b === editorSide
      ? `Your keybinding: in an editor this runs instead of ${o.command}.`
      : `Your keybinding for ${o.command} runs instead in an editor.`;
  return b === editorSide
    ? `Runs in an editor when ${b.when ? `"${b.when}" holds` : "it has focus"}; ${o.command} runs everywhere else.`
    : `In an editor, the editor's ${o.command} runs first when its condition holds; this runs everywhere else.`;
}

function safeParse(key: string): string[] | undefined {
  try {
    return parseKeybinding(key);
  } catch {
    return undefined;
  }
}

/** Validates a parsed keybindings.json value; returns the rules and per-entry problems. */
export function validateUserKeybindings(value: unknown): {
  rules: KeybindingRule[];
  problems: string[];
} {
  if (!Array.isArray(value))
    return { rules: [], problems: ["keybindings.json must contain an array"] };
  const rules: KeybindingRule[] = [];
  const problems: string[] = [];
  value.forEach((entry, i) => {
    const e = entry as Partial<KeybindingRule> | null;
    if (!e || typeof e !== "object" || typeof e.key !== "string" || typeof e.command !== "string") {
      problems.push(`entry ${i + 1}: needs "key" and "command" strings`);
      return;
    }
    if (!safeParse(e.key)) {
      problems.push(`entry ${i + 1}: can't read key "${e.key}"`);
      return;
    }
    rules.push({
      key: e.key,
      command: e.command,
      ...(typeof e.mac === "string" && { mac: e.mac }),
      ...(typeof e.when === "string" && { when: e.when }),
      ...(e.args !== undefined && { args: e.args }),
    });
  });
  return { rules, problems };
}
