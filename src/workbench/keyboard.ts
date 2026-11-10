// Global keyboard handling: one capture-phase keydown listener resolves chords against the
// keybinding rules and runs matching commands through the dispatcher (so a keybinding is just
// another way to call a command). Unbound keys pass through to Monaco / the terminal untouched.

import type { ContextKeyService } from "../core/context/index";
import type { Dispatcher } from "../core/dispatcher/index";
import { on } from "../core/dom/index";
import { builtinCommand } from "../core/extensions/vscode/builtinCommands";
import {
  chordFromEvent,
  KeybindingResolver,
  type KeybindingRule,
  keybindingLabel,
  type Platform,
  parseKeybinding,
  removalMatches,
  type SourcedRule,
} from "../core/keybindings/index";
import { type Disposable, DisposableStore, toDisposable } from "../core/lifecycle/index";
import { type Signal, signal } from "../core/reactive/index";
import { isModalDialogOpen } from "../ui/Dialog";
import type { Notifications } from "../ui/Notifications";

/**
 * The editor engine's own keybindings (Monaco's Ctrl+D, Alt+Up, Ctrl+/…; D204). Monaco handles
 * its keys itself; the IDE lists them, lets them through to it while an editor has focus, writes
 * the user's rules for them to Monaco, and runs a two-key one whose first key the IDE took.
 */
export interface EngineKeys {
  /** The engine's default rules (this platform's keys, Monaco's `when` clauses). */
  defaults: readonly KeybindingRule[];
  /** Whether the engine has this command. */
  has(command: string): boolean;
  /** An engine command's title, when it has one. */
  title(command: string): string | undefined;
  /** The engine's actions (bound or not), for the shortcuts list. */
  actions(): readonly { id: string; title: string }[];
  /** The user's rules for engine commands, replacing the earlier set. */
  apply(rules: readonly KeybindingRule[]): void;
  /** Runs an engine command in the focused editor. */
  run(command: string, args: unknown): void;
  /**
   * Whether the focused editor has a binding of its own for this key that holds now (its `when`
   * checked against its context). A key the IDE and the editor share goes to the editor then
   * (D209), as VS Code's editor keys do.
   */
  handles?(e: KeyboardEvent): boolean;
  /**
   * The same for a two-key chord (D219): the focused editor's command for `first` then `second`
   * when its binding holds now, or null. The IDE took the first key, so it runs the command.
   */
  chordCommand?(
    first: KeyboardEvent,
    second: KeyboardEvent,
  ): { command: string; args: unknown } | null;
}

export class KeyboardService implements Disposable {
  private readonly store = new DisposableStore();
  private resolver: KeybindingResolver;
  private rules: KeybindingRule[] = [];
  private userRules: KeybindingRule[] = [];
  private engine: EngineKeys | null = null;
  /** Keys (one, or two: "ctrl+k ctrl+c") an IDE default and an engine default share (D209, D219). */
  private sharedKeys = new Set<string>();
  /** The user's own keys for IDE commands ("chords\0command"): those win over the editor's. */
  private userKeys = new Set<string>();
  /** The first key of a chord the IDE is waiting on (asked about again with the second, D219). */
  private chordStart: KeyboardEvent | null = null;
  private suspended = 0;
  private readonly extensionRules = new Set<KeybindingRule[]>();
  /** Last few key presses and how they resolved (keybinding troubleshooting, `ide://dev/keyboard`). */
  readonly recent: { chord: string; result: string; target: string }[] = [];
  /** Bumped when the rules change (UI showing keybinding hints re-renders). */
  readonly rulesVersion: Signal<number> = signal(0);
  /** Label of a pending first chord ("Ctrl+K"), shown in the status bar. */
  readonly pendingChord: Signal<string | null> = signal<string | null>(null);
  /**
   * A chord finished after its first key had run a command of its own (Ctrl+K: inline edit, then
   * Ctrl+K Ctrl+O): that command's owner can undo what it opened (D172).
   */
  readonly chordAfterCommand: Signal<{ command: string; chord: string } | null> = signal<{
    command: string;
    chord: string;
  } | null>(null);

  constructor(
    private readonly platform: Platform,
    private readonly dispatcher: Dispatcher,
    private readonly context: ContextKeyService,
    private readonly notifications: Notifications,
  ) {
    this.resolver = new KeybindingResolver([], platform);
  }

  /** Replaces the default rules (from manifests). */
  setRules(rules: KeybindingRule[]): void {
    this.rules = [...rules];
    this.rebuild();
  }

  /** Adds rules from a third-party extension (D102); they sit between the defaults and the user's. */
  addRules(rules: readonly KeybindingRule[]): Disposable {
    const entry = [...rules];
    this.extensionRules.add(entry);
    this.rebuild();
    return toDisposable(() => {
      if (this.extensionRules.delete(entry)) this.rebuild();
    });
  }

  /** Replaces the user's rules (keybindings.json); they come after, so they win. */
  setUserRules(rules: KeybindingRule[]): void {
    this.userRules = [...rules];
    this.rebuild();
  }

  /** Connects the editor engine's keybindings (once it has loaded). Dispose to disconnect. */
  setEngine(engine: EngineKeys): Disposable {
    this.engine = engine;
    this.rebuild();
    return toDisposable(() => {
      if (this.engine !== engine) return;
      this.engine = null;
      this.rebuild();
    });
  }

  /** The command (or "-command" removal) is the editor engine's, not a dispatcher command. */
  engineOwns(command: string): boolean {
    const id = command.startsWith("-") ? command.slice(1) : command;
    return !!this.engine && !this.dispatcher.has(id) && this.engine.has(id);
  }

  /** An engine command's title (Monaco's action label), if any. */
  engineTitle(command: string): string | undefined {
    return this.engine?.title(command);
  }

  /** The engine's actions, bound or not ([] before it loads). */
  engineActions(): readonly { id: string; title: string }[] {
    return this.engine?.actions() ?? [];
  }

  private rebuild(): void {
    // Engine rules are in the IDE's table so its capture listener lets their keys through to the
    // editor (where Monaco checks its own `when`), behind the IDE's defaults as before; the
    // user's win over both. Removals stay as they are.
    const engineDefaults = this.engine?.defaults ?? [];
    const chordsOf = (r: KeybindingRule): string | null => {
      try {
        const key = this.platform === "mac" && r.mac ? r.mac : r.key;
        return key.trim() ? parseKeybinding(key).join(" ") : null;
      } catch {
        return null;
      }
    };
    const passThrough = (r: KeybindingRule): KeybindingRule[] => {
      if (!r.command.startsWith("-")) return [{ ...r, when: "editorFocus" }];
      if (!r.when?.trim()) return [r];
      // A removal with a `when` takes the engine default with that clause (Monaco applies it
      // too); in this table those all read "editorFocus", so it's matched here (D219).
      const command = r.command.slice(1);
      const removal = { command, chords: chordsOf(r), when: r.when };
      const hit = engineDefaults.some((d) =>
        removalMatches(removal, { command: d.command, chords: chordsOf(d) ?? "", when: d.when }),
      );
      return hit ? [{ ...r, when: "editorFocus" }] : [];
    };
    const engineUser = this.userRules.filter((r) => this.engineOwns(r.command));
    this.resolver = new KeybindingResolver(
      [
        ...engineDefaults.flatMap(passThrough),
        ...this.rules,
        ...[...this.extensionRules].flat(),
        ...this.userRules.flatMap((r) => (this.engineOwns(r.command) ? passThrough(r) : [r])),
      ],
      this.platform,
    );
    this.engine?.apply(engineUser);
    const keysOf = (r: KeybindingRule): string | null => {
      if (r.command.startsWith("-")) return null;
      const chords = chordsOf(r);
      // One key, or two (a three-key chord isn't something Monaco binds).
      return chords && chords.split(" ").length <= 2 ? chords : null;
    };
    const engineKeys = new Set(engineDefaults.map(keysOf));
    // Only the IDE's own: an extension's binding beats the editor's built-in one when its `when`
    // holds (VS Code weighs extension keybindings above editor contributions).
    this.sharedKeys = new Set(
      this.rules.map(keysOf).filter((k): k is string => k !== null && engineKeys.has(k)),
    );
    this.userKeys = new Set(
      this.userRules
        .filter((r) => !this.engineOwns(r.command))
        .map((r) => `${keysOf(r)}\0${r.command}`),
    );
    this.rulesVersion.value = this.rulesVersion.peek() + 1;
  }

  /** Defaults (the engine's first) then user rules, with their source. */
  get allRules(): readonly SourcedRule[] {
    return [
      ...(this.engine?.defaults ?? []).map((r) => ({
        ...r,
        source: "default" as const,
        engine: true,
      })),
      ...this.rules.map((r) => ({ ...r, source: "default" as const })),
      ...[...this.extensionRules].flat().map((r) => ({ ...r, source: "default" as const })),
      ...this.userRules.map((r) => ({
        ...r,
        source: "user" as const,
        ...(this.engineOwns(r.command) && { engine: true }),
      })),
    ];
  }

  get platformName(): Platform {
    return this.platform;
  }

  /** Lets keys through untouched (recording a new keybinding). Dispose to resume. */
  suspend(): Disposable {
    this.suspended++;
    let done = false;
    return {
      dispose: () => {
        if (!done) this.suspended--;
        done = true;
      },
    };
  }

  /** "Ctrl+Shift+P" / "⇧⌘P" for a command, if bound. */
  labelFor(command: string): string | undefined {
    return this.resolver.labelFor(command);
  }

  /** Label for a literal binding ("ctrl+f2", mac "cmd+f2"), e.g. keys the editor engine owns. */
  labelForKeys(key: string, mac?: string): string {
    return keybindingLabel(
      parseKeybinding(this.platform === "mac" && mac ? mac : key),
      this.platform,
    );
  }

  attach(target: Window): void {
    this.store.add(this.attachDisposable(target));
  }

  /** Keys in another window (an auxiliary window) go through the same bindings. */
  attachDisposable(target: Window): Disposable {
    return on(target, "keydown", (e) => this.onKeyDown(e), { capture: true });
  }

  /** Keys a focused terminal takes for the program in it (set by the terminal, D192). */
  private shellKeys: ((chord: string) => boolean) | null = null;

  /** While `take(chord)` is true, the key goes to the focused terminal instead of a binding. */
  setShellKeys(take: ((chord: string) => boolean) | null): Disposable {
    this.shellKeys = take;
    return {
      dispose: () => {
        if (this.shellKeys === take) this.shellKeys = null;
      },
    };
  }

  private onKeyDown(e: KeyboardEvent): void {
    // This window capture listener runs before a modal dialog's own: under a dialog the keys are
    // its own (Esc, Tab, Enter), never a command behind it.
    if (e.isComposing || this.suspended > 0 || isModalDialogOpen()) return;
    const chord = chordFromEvent(e);
    if (!chord) return;
    // A program in the terminal (Claude Code, nano, tmux) gets its own keys (Ctrl+K, Ctrl+B…),
    // unless a chord is already half typed.
    if (!this.pendingChord.peek() && this.shellKeys?.(chord)) return;
    // While the quick input is open, plain keys belong to it.
    if (
      this.context.get("quickInputVisible") &&
      !/^(ctrl|alt|meta)\+/.test(chord) &&
      !/^f\d+$/.test(chord)
    )
      return;
    const prefix = this.resolver.pending;
    const secondKey = prefix !== null;
    const first = this.chordStart;
    const result = this.resolver.resolve(chord, (when) => this.context.matches(when));
    this.chordStart = this.resolver.pending !== null ? e : null;
    if (__DEV__) {
      const t = e.target instanceof Element ? e.target : null;
      this.recent.unshift({
        chord,
        result: result.kind === "command" ? `command:${result.command}` : result.kind,
        target: t
          ? `${t.tagName.toLowerCase()}${t.className && typeof t.className === "string" ? `.${t.className.split(" ").join(".")}` : ""}`
          : "?",
      });
      this.recent.length = Math.min(this.recent.length, 10);
    }
    switch (result.kind) {
      case "none":
        return;
      case "chordStarted":
        this.pendingChord.value = keybindingLabel([result.prefix], this.platform);
        break;
      case "chordCancelled":
        this.pendingChord.value = null;
        this.notifications.show("info", "That key combination is not a command.");
        break;
      case "command":
        if (this.engine && this.engineOwns(result.command)) {
          this.pendingChord.value = null;
          // One key: the editor handles it (and checks its own `when`). The second key of a
          // chord: the IDE took the first, so it runs the command itself.
          if (!secondKey) return;
          this.engine.run(result.command, result.args);
          break;
        }
        // A key the IDE's default and the editor's share (Ctrl+PageDown: next tab, or the next
        // page of suggestions): in an editor whose own binding holds now, the editor has it
        // (D209). The user's own keybinding still wins.
        if (
          !secondKey &&
          this.sharedKeys.has(chord) &&
          !this.userKeys.has(`${chord}\0${result.command}`) &&
          this.context.get("editorFocus") &&
          this.engine?.handles?.(e)
        ) {
          this.pendingChord.value = null;
          return;
        }
        // The same for a two-key chord the IDE and the editor share (D219): the IDE took the
        // first key, so when the editor's binding holds it runs the editor's command itself.
        if (prefix !== null && first && this.runEditorsChord(prefix, first, e, result.command)) {
          this.pendingChord.value = null;
          break;
        }
        // A key that also starts chords ran its command; no "waiting for the second key" hint
        // (the command's own UI is up, and the next key is most likely typing in it).
        this.pendingChord.value = null;
        if (result.after) this.chordAfterCommand.value = { command: result.after, chord };
        void this.run(result.command, result.args);
        break;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * A two-key chord an IDE default (`command`) shares with the editor engine: runs the editor's
   * command when its binding holds in the focused editor (D219). False: the IDE's runs.
   */
  private runEditorsChord(
    prefix: string,
    first: KeyboardEvent,
    second: KeyboardEvent,
    command: string,
  ): boolean {
    const keys = `${prefix} ${chordFromEvent(second)}`;
    if (!this.sharedKeys.has(keys) || this.userKeys.has(`${keys}\0${command}`)) return false;
    if (!this.context.get("editorFocus") || !this.engine) return false;
    const editors = this.engine.chordCommand?.(first, second);
    if (!editors) return false;
    this.engine.run(editors.command, editors.args);
    return true;
  }

  private async run(command: string, args: unknown): Promise<void> {
    // A VS Code command id pasted into keybindings.json by hand (`workbench.action.files.save`):
    // the IDE's command for it, as the importer translates them (D379).
    if (!this.dispatcher.has(command)) {
      const target = builtinCommand(command);
      if (target && this.dispatcher.has(target.command)) {
        command = target.command;
        args = args ?? target.input;
      }
    }
    // Failures are surfaced centrally (Workbench listens to `command.executed`).
    await this.dispatcher.execute(command, args ?? {}).catch(() => {});
  }

  dispose(): void {
    this.store.dispose();
  }
}
