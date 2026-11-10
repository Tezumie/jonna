// Monaco's own keybindings (D204), for the keyboard shortcuts editor: the defaults it registers
// (Ctrl+D, Alt+Up, Ctrl+/, F12…) with their `when` clauses and titles, and the user's
// keybindings.json rules for Monaco commands applied as Monaco's own user rules (dynamic
// keybindings, so "-command" removals and `when` clauses behave as in VS Code).
import { StandardKeyboardEvent } from "monaco-editor/base/browser/keyboardEvent.js";
import { KeyChord, KeyCodeUtils } from "monaco-editor/base/common/keyCodes.js";
import { EditorExtensionsRegistry } from "monaco-editor/editor/browser/editorExtensions.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { CommandsRegistry } from "monaco-editor/platform/commands/common/commands.js";
import { IKeybindingService } from "monaco-editor/platform/keybinding/common/keybinding.js";
import type { KeybindingRule, Platform } from "../../../core/keybindings/index";
import { parseKeybinding } from "../../../core/keybindings/index";
import type { Disposable } from "../../../core/lifecycle/index";
import type { EngineKeybinding } from "../engine";
import * as monaco from "./core";

interface ResolvedItem {
  resolvedKeybinding?: { getUserSettingsLabel(): string | null };
  command: string | null;
  commandArgs?: unknown;
  when?: { serialize(): string };
  isDefault: boolean;
}

interface KeybindingServiceLike {
  getKeybindings(): ResolvedItem[];
  softDispatch(e: unknown, target: unknown): { kind: number; commandId?: string | null };
}

interface ActionLike {
  id: string;
  label: string;
}

const CTRL_CMD = 1 << 11;
const SHIFT = 1 << 10;
const ALT = 1 << 9;
const WIN_CTRL = 1 << 8;

/** One IDE chord ("ctrl+shift+d") → Monaco's key number, or null when Monaco has no such key. */
export function monacoChord(chord: string, platform: Platform): number | null {
  const parts = chord.split("+");
  const key = chord.endsWith("++") ? "+" : (parts.pop() ?? "");
  const code = KeyCodeUtils.fromUserSettings(key) as number;
  if (!code) return null;
  let n = code;
  for (const mod of parts) {
    if (mod === "shift") n |= SHIFT;
    else if (mod === "alt") n |= ALT;
    // CtrlCmd is Cmd on macOS and Ctrl elsewhere; WinCtrl is the other one.
    else if (mod === "ctrl") n |= platform === "mac" ? WIN_CTRL : CTRL_CMD;
    else if (mod === "meta") n |= platform === "mac" ? CTRL_CMD : WIN_CTRL;
  }
  return n;
}

/** A keybinding ("ctrl+k ctrl+c") → Monaco's number (two chords at most), or null. */
export function monacoKeybinding(key: string, platform: Platform): number | null {
  let chords: string[];
  try {
    chords = parseKeybinding(key);
  } catch {
    return null;
  }
  const first = chords[0] ? monacoChord(chords[0], platform) : null;
  if (first === null || chords.length > 2) return null;
  if (chords.length === 1) return first;
  const second = monacoChord(chords[1] as string, platform);
  return second === null ? null : (KeyChord(first, second) as number);
}

function keybindingService(): KeybindingServiceLike {
  return StandaloneServices.get(IKeybindingService) as KeybindingServiceLike;
}

/** Titles of Monaco's editor actions by id ("Add selection to next find match"). */
function actionTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  for (const action of EditorExtensionsRegistry.getEditorActions() as ActionLike[])
    if (action.label) titles.set(action.id, action.label);
  return titles;
}

let defaults: EngineKeybinding[] | undefined;

/**
 * Monaco's default keybindings, as IDE rules for this platform (user-settings key names). Read
 * once, before any user rule is applied: Monaco's list is the one after removals.
 */
export function engineKeybindings(): EngineKeybinding[] {
  defaults ??= readDefaults();
  return defaults;
}

function readDefaults(): EngineKeybinding[] {
  const items = keybindingService()
    .getKeybindings()
    .filter((k) => k.isDefault);
  const titles = actionTitles();
  const out: EngineKeybinding[] = [];
  for (const item of items) {
    const command = item.command;
    if (!command || command.startsWith("-") || command.startsWith("^")) continue;
    const key = item.resolvedKeybinding?.getUserSettingsLabel();
    if (!key) continue;
    const when = item.when?.serialize();
    out.push({
      command,
      key,
      ...(when && { when }),
      ...(item.commandArgs !== undefined && { args: item.commandArgs }),
      ...(titles.has(command) && { title: titles.get(command) }),
    });
  }
  return out;
}

/**
 * Whether Monaco would run a command for this key in the focused editor now: its binding's `when`
 * checked against the editor's own context (suggestions open, a peek view…), without running it
 * (D209: a key the IDE and the editor share goes to the editor then).
 */
export function engineHandlesKey(e: KeyboardEvent): boolean {
  try {
    const target = e.target instanceof HTMLElement ? e.target : document.activeElement;
    const r = keybindingService().softDispatch(new StandardKeyboardEvent(e), target);
    // ResultKind.KbFound with a command (a null command is a removal).
    return r.kind === 2 && !!r.commandId;
  } catch {
    return false;
  }
}

/** The parts of Monaco's keybinding service a two-key lookup needs (not in its public typings). */
interface ChordLookup {
  resolveKeyboardEvent(e: unknown): { getDispatchChords(): (string | null)[] };
  _contextKeyService: { getContext(target: unknown): unknown };
  _getResolver(): {
    resolve(
      context: unknown,
      currentChords: string[],
      keypress: string,
    ): { kind: number; commandId?: string | null; commandArgs?: unknown };
  };
}

/**
 * The command Monaco would run for the two-key chord `first` `second` in the focused editor now
 * (its binding's `when` checked as `engineHandlesKey` does), or null (D219). The IDE took the
 * first key, so Monaco's own chord state never saw it: the lookup is done on its resolver.
 */
export function engineChordCommand(
  first: KeyboardEvent,
  second: KeyboardEvent,
): { command: string; args: unknown } | null {
  try {
    const service = keybindingService() as unknown as ChordLookup;
    if (typeof service._getResolver !== "function" || !service._contextKeyService) return null;
    const dispatch = (e: KeyboardEvent) =>
      service.resolveKeyboardEvent(new StandardKeyboardEvent(e)).getDispatchChords()[0] ?? null;
    const a = dispatch(first);
    const b = dispatch(second);
    if (!a || !b) return null;
    const target = second.target instanceof HTMLElement ? second.target : document.activeElement;
    const context = service._contextKeyService.getContext(target);
    const r = service._getResolver().resolve(context, [a], b);
    // ResultKind.KbFound with a command (a null command is a removal).
    return r.kind === 2 && r.commandId ? { command: r.commandId, args: r.commandArgs } : null;
  } catch {
    return null;
  }
}

/** Whether Monaco has a command with this id. */
export function hasEngineCommand(id: string): boolean {
  return !!CommandsRegistry.getCommand(id);
}

/** Every Monaco editor action (id and title), bound or not, for the shortcuts list. */
export function engineActions(): { id: string; title: string }[] {
  return [...actionTitles()].map(([id, title]) => ({ id, title }));
}

/**
 * Applies the user's rules for Monaco commands (replacing the previous set): additions get
 * Monaco's user priority, "-command" removals take Monaco defaults away (with the key and `when`
 * when given). Rules whose key Monaco can't express are skipped (returned).
 */
export function applyEngineUserKeybindings(
  rules: readonly KeybindingRule[],
  platform: Platform,
): { applied: Disposable; skipped: KeybindingRule[] } {
  engineKeybindings();
  const skipped: KeybindingRule[] = [];
  const out: monaco.editor.IKeybindingRule[] = [];
  for (const rule of rules) {
    const key = platform === "mac" && rule.mac ? rule.mac : rule.key;
    const removal = rule.command.startsWith("-");
    const keybinding = key.trim() ? monacoKeybinding(key, platform) : removal ? 0 : null;
    if (keybinding === null) {
      skipped.push(rule);
      continue;
    }
    out.push({
      keybinding,
      command: rule.command,
      ...(rule.when && { when: rule.when }),
      ...(rule.args !== undefined && { commandArgs: rule.args }),
    });
  }
  return { applied: monaco.editor.addKeybindingRules(out), skipped };
}
