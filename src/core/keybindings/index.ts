// Keybinding resolution, VS Code style: later rules win, `when` clauses filter, multi-chord
// bindings ("ctrl+k ctrl+o") enter a pending-chord state, and "-command" rules remove defaults.
// A key that is both a command and the start of chords (Ctrl+K: inline edit, like Cursor; D172)
// runs its command at once and still lets the next key finish a chord with a modifier (Ctrl+K
// Ctrl+O); any other next key goes through untouched (it's typing in what the command opened).
import { keybindingLabel, type Platform, parseKeybinding } from "./keys";
import { removalMatches } from "./whenLogic";

export {
  type EffectiveBinding,
  effectiveBindings,
  type KeybindingSource,
  removalMatches,
  type SourcedRule,
  validateUserKeybindings,
} from "./effective";

export {
  chordFromEvent,
  type KeyEventLike,
  keybindingLabel,
  normalizeChord,
  type Platform,
  parseKeybinding,
} from "./keys";

/** A keybinding as written in manifests and keybindings.json. */
export interface KeybindingRule {
  /** Default key (Windows/Linux, and macOS unless `mac` is given). */
  key: string;
  /** macOS override. */
  mac?: string;
  /** Command id. Prefix with "-" to remove matching earlier rules. */
  command: string;
  when?: string;
  args?: unknown;
}

interface ResolvedRule {
  chords: string[];
  command: string;
  when: string | undefined;
  args: unknown;
}

export type ResolveResult =
  | {
      kind: "command";
      command: string;
      args: unknown;
      /** Also started a chord: the next key may finish it (the command already ran). */
      chordPending?: boolean;
      /** Finished a chord started by a key that ran this command first. */
      after?: string;
    }
  | { kind: "chordStarted"; prefix: string }
  /** A chord was pending and this key didn't complete any binding. */
  | { kind: "chordCancelled" }
  | { kind: "none" };

export type WhenMatcher = (when: string | undefined) => boolean;

export class KeybindingResolver {
  private readonly rules: ResolvedRule[];
  private pendingChord: string | null = null;
  /** The command the pending chord's first key ran (a "soft" chord), if it ran one. */
  private softCommand: string | null = null;

  constructor(
    rules: readonly KeybindingRule[],
    private readonly platform: Platform,
  ) {
    this.rules = buildRules(rules, platform);
  }

  get pending(): string | null {
    return this.pendingChord;
  }

  /** Resolves one key press (normalized chord). Stateful for multi-chord bindings. */
  resolve(chord: string, matches: WhenMatcher): ResolveResult {
    const prefix = this.pendingChord;
    const soft = this.softCommand;
    this.pendingChord = null;
    this.softCommand = null;
    // After a key that opened something to type in, a plain key is typing, not a chord's second
    // key ("v" after Ctrl+K is the prompt's first letter, not Ctrl+K V); Ctrl+K Ctrl+O still works.
    // It still does what it does on its own (Esc closes what Ctrl+K opened).
    if (soft && !/^(ctrl|alt|meta)\+/.test(chord)) return this.resolve(chord, matches);
    const index = prefix === null ? 0 : 1;
    // Later rules take precedence (user overrides defaults), so search from the end: the latest
    // one-key command and whether any chord starts with this key.
    let single: ResolvedRule | undefined;
    let startsChord = false;
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i] as ResolvedRule;
      if (prefix !== null && rule.chords[0] !== prefix) continue;
      if (rule.chords[index] !== chord) continue;
      if (!matches(rule.when)) continue;
      if (rule.chords.length > index + 1) startsChord = true;
      else single ??= rule;
      if (single && startsChord) break;
      // The second key of a chord: the first match decides (as before).
      if (index === 1) break;
    }
    if (startsChord && single && index === 0) {
      this.pendingChord = chord;
      this.softCommand = single.command;
      return { kind: "command", command: single.command, args: single.args, chordPending: true };
    }
    if (startsChord && index === 0) {
      this.pendingChord = chord;
      return { kind: "chordStarted", prefix: chord };
    }
    if (single)
      return {
        kind: "command",
        command: single.command,
        args: single.args,
        ...(soft && { after: soft }),
      };
    if (prefix === null) return { kind: "none" };
    // After a key that ran a command, an unfinished chord is just the next key (typing).
    return soft ? { kind: "none" } : { kind: "chordCancelled" };
  }

  cancelChord(): void {
    this.pendingChord = null;
    this.softCommand = null;
  }

  /** The effective (last-defined) binding for a command, as chords. */
  keybindingFor(command: string): string[] | undefined {
    for (let i = this.rules.length - 1; i >= 0; i--) {
      const rule = this.rules[i] as ResolvedRule;
      if (rule.command === command) return rule.chords;
    }
    return undefined;
  }

  /** Display label for a command's binding ("Ctrl+Shift+P" / "⇧⌘P"), if bound. */
  labelFor(command: string): string | undefined {
    const chords = this.keybindingFor(command);
    return chords ? keybindingLabel(chords, this.platform) : undefined;
  }
}

function buildRules(rules: readonly KeybindingRule[], platform: Platform): ResolvedRule[] {
  const out: ResolvedRule[] = [];
  for (const rule of rules) {
    const key = platform === "mac" && rule.mac ? rule.mac : rule.key;
    if (rule.command.startsWith("-")) {
      // Removal: drop earlier rules for the command (and the key, when one is given; and only
      // the rule with the same `when`, when it has one: VS Code's rule, D219).
      const command = rule.command.slice(1);
      let chords: string | null = null;
      try {
        chords = key ? parseKeybinding(key).join(" ") : null;
      } catch {
        // An unreadable key reads as no key, as effectiveBindings takes it (the table shown).
      }
      const removal = { command, chords, when: rule.when };
      for (let i = out.length - 1; i >= 0; i--) {
        const existing = out[i] as ResolvedRule;
        if (removalMatches(removal, { ...existing, chords: existing.chords.join(" ") }))
          out.splice(i, 1);
      }
      continue;
    }
    // A key that can't be read ("ctrl+shift+", an extension's or a macOS override's typo) is
    // left out: throwing here would take every keybinding down with it.
    let chords: string[];
    try {
      chords = parseKeybinding(key);
    } catch {
      continue;
    }
    out.push({
      chords,
      command: rule.command,
      when: rule.when,
      args: rule.args,
    });
  }
  return out;
}
