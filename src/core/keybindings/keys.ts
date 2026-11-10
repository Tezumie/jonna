// Key normalization. A "chord" is one key press with modifiers, normalized to lowercase
// "ctrl+shift+alt+meta+key" (that modifier order). A keybinding is one or more chords ("ctrl+k ctrl+o").
// Keys come from KeyboardEvent.code (physical key), so bindings don't change with the layout's
// shifted characters, like VS Code's defaults.

export type Platform = "mac" | "windows" | "linux";

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "meta"] as const;
type Modifier = (typeof MODIFIER_ORDER)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  super: "meta",
};

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  " ": "space",
};

const CODE_TO_KEY: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  IntlBackslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Enter: "enter",
  NumpadEnter: "enter",
  Escape: "escape",
  Space: "space",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** Normalizes one chord written by a human ("Shift+Cmd+P") to canonical form ("shift+meta+p"). */
export function normalizeChord(chord: string): string {
  const parts = chord
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  // "ctrl++" means ctrl and the "+" key: an empty last part after a "+".
  if (chord.endsWith("++")) {
    parts.splice(parts.length - 2, 2, "+");
  }
  const mods = new Set<Modifier>();
  let key = "";
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part];
    if (mod) mods.add(mod);
    else if (part !== "") {
      if (key) throw new Error(`Keybinding "${chord}" has more than one key`);
      key = KEY_ALIASES[part] ?? part;
    }
  }
  if (!key) throw new Error(`Keybinding "${chord}" has no key`);
  return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key].join("+");
}

/** Splits and normalizes a keybinding into chords: "ctrl+k ctrl+o" → ["ctrl+k", "ctrl+o"]. */
export function parseKeybinding(binding: string): string[] {
  return binding.trim().split(/\s+/).map(normalizeChord);
}

export interface KeyEventLike {
  code: string;
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Chord for a keydown event, or null for a bare modifier press / unknown key. */
export function chordFromEvent(e: KeyEventLike): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^Numpad[0-9]$/.test(e.code)) key = `numpad${e.code.slice(6)}`;
  else if (/^F[0-9]{1,2}$/.test(e.code)) key = e.code.toLowerCase();
  else key = CODE_TO_KEY[e.code];
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("meta");
  return [...mods, key].join("+");
}

const MAC_SYMBOLS: Record<Modifier, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };
const MAC_ORDER: Modifier[] = ["ctrl", "alt", "shift", "meta"];
const PC_NAMES: Record<Modifier, string> = {
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  meta: "Win",
};
const KEY_LABELS: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageup: "PageUp",
  pagedown: "PageDown",
};

/** Human label: "Ctrl+Shift+P" on Windows/Linux, "⇧⌘P" on macOS. Chords separated by a space. */
export function keybindingLabel(chords: readonly string[], platform: Platform): string {
  return chords
    .map((chord) => {
      const parts = chord.split("+");
      const key = chord.endsWith("++") ? "+" : (parts.pop() ?? "");
      const mods = new Set(parts as Modifier[]);
      const keyLabel =
        KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key.toUpperCase());
      if (platform === "mac") {
        return MAC_ORDER.filter((m) => mods.has(m))
          .map((m) => MAC_SYMBOLS[m])
          .concat(keyLabel)
          .join("");
      }
      const names = MODIFIER_ORDER.filter((m) => mods.has(m)).map((m) =>
        m === "meta" && platform === "linux" ? "Super" : PC_NAMES[m],
      );
      return [...names, keyLabel].join("+");
    })
    .join(" ");
}
