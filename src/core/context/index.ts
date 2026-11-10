// Context keys: named facts about the IDE's current state ("editorFocus", "workspaceOpen",
// "activeEditorDirty", …) that `when` clauses on commands and keybindings test.
import { Emitter } from "../events/index";
import type { Disposable } from "../lifecycle/index";
import { type ContextLookup, matchesWhen, WhenParseError } from "./when";

export { evaluateWhen, matchesWhen, parseWhen, type WhenExpr, WhenParseError } from "./when";

export type ContextValue = string | number | boolean | null | undefined | readonly unknown[];

export class ContextKeyService implements Disposable {
  private readonly values = new Map<string, ContextValue>();
  private readonly changed = new Emitter<readonly string[]>();
  /** Fires with the keys whose value changed. */
  readonly onDidChange = this.changed.event;
  readonly lookup: ContextLookup = (key) => this.get(key);

  /**
   * `fallback` answers keys nothing set: VS Code's `config.<setting>` reads the setting (D262:
   * an extension's menu items can test its settings that way).
   */
  constructor(private readonly fallback: (key: string) => ContextValue = () => undefined) {}

  get(key: string): ContextValue {
    return this.values.has(key) ? this.values.get(key) : this.fallback(key);
  }

  /** Tells listeners that keys answered by the fallback changed (a setting did). */
  changedOutside(keys: readonly string[]): void {
    if (keys.length) this.changed.fire(keys);
  }

  set(key: string, value: ContextValue): void {
    if (Object.is(this.values.get(key), value)) return;
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    this.changed.fire([key]);
  }

  /** Sets several keys and fires once. */
  setMany(entries: Record<string, ContextValue>): void {
    const changedKeys: string[] = [];
    for (const [key, value] of Object.entries(entries)) {
      if (Object.is(this.values.get(key), value)) continue;
      if (value === undefined) this.values.delete(key);
      else this.values.set(key, value);
      changedKeys.push(key);
    }
    if (changedKeys.length > 0) this.changed.fire(changedKeys);
  }

  /**
   * Whether `when` holds. A clause that can't be read (a typo in keybindings.json, an
   * extension's) never holds: throwing would break every key press, menu and command list that
   * meets it.
   */
  matches(when: string | undefined): boolean {
    try {
      return matchesWhen(when, this.lookup);
    } catch (err) {
      if (err instanceof WhenParseError) return false;
      throw err;
    }
  }

  snapshot(): Record<string, ContextValue> {
    return Object.fromEntries(this.values);
  }

  dispose(): void {
    this.changed.dispose();
  }
}
