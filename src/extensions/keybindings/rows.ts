// The keyboard shortcuts table's rows (D204): every palette command and every editor-engine
// command (Monaco's actions, and its other bound commands such as cursorDown), one row per
// binding, filtered by text or, in quotes, by key ("ctrl+d": VS Code's record-keys search).
// DOM-free and tested.
import type { EffectiveBinding } from "../../core/keybindings/effective";
import { parseKeybinding } from "../../core/keybindings/keys";
import { engineCommandTitle } from "./engineTitles";

export interface ShortcutCommand {
  id: string;
  title: string;
  category?: string | undefined;
  /** The editor engine's own command (Monaco's). */
  engine?: boolean;
}

export interface ShortcutRow {
  command: ShortcutCommand;
  binding: EffectiveBinding | undefined;
}

/** The key a quoted query asks for, as normalized chords ("ctrl+k ctrl+c"), or undefined. */
export function quotedKey(query: string): { chords?: string; label: string } | undefined {
  const inner = /^"(.+)"$/.exec(query.trim())?.[1]?.replace(/\s+/g, " ").trim();
  if (inner === undefined) return undefined;
  try {
    return { chords: parseKeybinding(inner).join(" "), label: inner.toLowerCase() };
  } catch {
    // A label such as "⇧⌘P" (Show same keybindings on macOS) isn't a parsable key.
    return { label: inner.toLowerCase() };
  }
}

export function shortcutRows(
  commands: readonly ShortcutCommand[],
  table: readonly EffectiveBinding[],
  query: string,
  engineTitle: (id: string) => string | undefined = () => undefined,
): ShortcutRow[] {
  const all = new Map<string, ShortcutCommand>();
  for (const c of commands) all.set(c.id, c);
  // Bound engine commands that aren't actions (cursorDown, deleteLeft…) still get a row.
  for (const b of table)
    if (b.engine && !all.has(b.command))
      all.set(b.command, {
        id: b.command,
        title: engineTitle(b.command) ?? engineCommandTitle(b.command),
        engine: true,
      });
  const q = query.trim().toLowerCase();
  const exact = quotedKey(q);
  const byCommand = new Map<string, EffectiveBinding[]>();
  for (const b of table) {
    const list = byCommand.get(b.command);
    if (list) list.push(b);
    else byCommand.set(b.command, [b]);
  }
  const out: ShortcutRow[] = [];
  for (const command of all.values()) {
    const bindings = byCommand.get(command.id) ?? [];
    for (const binding of bindings.length ? bindings : [undefined]) {
      if (exact) {
        if (
          binding &&
          (binding.chords.join(" ") === exact.chords || binding.label.toLowerCase() === exact.label)
        )
          out.push({ command, binding });
        continue;
      }
      const hay =
        `${command.category ?? ""} ${command.title} ${command.id} ${binding?.label ?? ""} ${binding?.chords.join(" ") ?? ""} ${binding?.when ?? ""}`.toLowerCase();
      if (!q || hay.includes(q)) out.push({ command, binding });
    }
  }
  return out.sort(
    (a, b) =>
      Number(!a.binding) - Number(!b.binding) ||
      `${a.command.category ?? ""} ${a.command.title}`.localeCompare(
        `${b.command.category ?? ""} ${b.command.title}`,
      ),
  );
}
