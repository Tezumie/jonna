// Trusted input (D346): what a click, a drag, a wheel turn, a key chord or typed text becomes as
// DevTools protocol calls (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`,
// `Input.insertText`), which the browser turns into events the page sees as a person's
// (`isTrusted`). Used for the user's own Chrome / Edge (over its debugging socket) and for the
// built-in tab on Windows (WebView2's in-process protocol). Points are the page's CSS pixels;
// `hostPoint` places them in the webview that shows the page. Keys follow a US layout, as
// Puppeteer's do; a character outside it is inserted as text. DOM-free and tested.

export type Modifier = "ctrl" | "shift" | "alt" | "meta";

export interface CdpCall {
  method: string;
  params: Record<string, unknown>;
}
/** A protocol call, or a pause between calls (a frame's worth while dragging). */
export type InputStep = CdpCall | { waitMs: number };

/** The protocol's modifier bits. */
export function modifierBits(mods: readonly Modifier[] = []): number {
  let bits = 0;
  if (mods.includes("alt")) bits |= 1;
  if (mods.includes("ctrl")) bits |= 2;
  if (mods.includes("meta")) bits |= 4;
  if (mods.includes("shift")) bits |= 8;
  return bits;
}

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  /** What the key types (none for keys that don't). */
  text?: string;
  /** 1: the left one of a pair (modifiers). */
  location?: number;
}

const NAMED: Record<string, Omit<KeyDef, "key">> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Escape: { code: "Escape", keyCode: 27 },
  Delete: { code: "Delete", keyCode: 46 },
  Insert: { code: "Insert", keyCode: 45 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  Shift: { code: "ShiftLeft", keyCode: 16, location: 1 },
  Control: { code: "ControlLeft", keyCode: 17, location: 1 },
  Alt: { code: "AltLeft", keyCode: 18, location: 1 },
  Meta: { code: "MetaLeft", keyCode: 91, location: 1 },
  CapsLock: { code: "CapsLock", keyCode: 20 },
  ContextMenu: { code: "ContextMenu", keyCode: 93 },
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = { code: `F${i}`, keyCode: 111 + i };

/** Punctuation on a US keyboard: [code, keyCode, unshifted, shifted]. */
const PUNCTUATION: [string, number, string, string][] = [
  ["Space", 32, " ", " "],
  ["Minus", 189, "-", "_"],
  ["Equal", 187, "=", "+"],
  ["BracketLeft", 219, "[", "{"],
  ["BracketRight", 221, "]", "}"],
  ["Backslash", 220, "\\", "|"],
  ["Semicolon", 186, ";", ":"],
  ["Quote", 222, "'", '"'],
  ["Comma", 188, ",", "<"],
  ["Period", 190, ".", ">"],
  ["Slash", 191, "/", "?"],
  ["Backquote", 192, "`", "~"],
];
const DIGIT_SHIFTED = ")!@#$%^&*(";

/**
 * The key `key` (a DOM key name or one character) with `shift` held, or null when a US keyboard
 * has no such key (it is then inserted as text). Shift makes letters capitals and digits and
 * punctuation their shifted signs, as on the keyboard.
 */
export function keyDefinition(key: string, shift = false): KeyDef | null {
  const named = NAMED[key];
  if (named) return { key, ...named };
  if (key.length !== 1) return null;
  if (/[a-z]/i.test(key)) {
    const upper = key.toUpperCase();
    const typed = shift ? upper : key;
    return { key: typed, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: typed };
  }
  const digit = "0123456789".indexOf(key);
  if (digit >= 0) {
    const typed = shift ? (DIGIT_SHIFTED[digit] ?? key) : key;
    return { key: typed, code: `Digit${key}`, keyCode: 48 + digit, text: typed };
  }
  const shiftedDigit = DIGIT_SHIFTED.indexOf(key);
  if (shiftedDigit >= 0)
    return { key, code: `Digit${shiftedDigit}`, keyCode: 48 + shiftedDigit, text: key };
  for (const [code, keyCode, plain, shifted] of PUNCTUATION) {
    if (key === plain || key === shifted) {
      const typed = shift ? shifted : key;
      return { key: typed, code, keyCode, text: typed };
    }
  }
  return null;
}

/** Whether `key` needs Shift on a US keyboard (capitals, shifted signs). */
function needsShift(key: string): boolean {
  if (key.length !== 1) return false;
  if (/[A-Z]/.test(key)) return true;
  if (DIGIT_SHIFTED.includes(key)) return true;
  return PUNCTUATION.some(([, , plain, shifted]) => key === shifted && key !== plain);
}

const MODIFIER_KEYS: [Modifier, string][] = [
  ["ctrl", "Control"],
  ["alt", "Alt"],
  ["meta", "Meta"],
  ["shift", "Shift"],
];

function keyEvent(type: string, def: KeyDef, modifiers: number, text?: string): CdpCall {
  return {
    method: "Input.dispatchKeyEvent",
    params: {
      type,
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      modifiers,
      ...(text !== undefined && { text, unmodifiedText: text }),
      ...(def.location !== undefined && { location: def.location }),
    },
  };
}

/** One key press: down (with its text when it types one) and up, under `modifiers` bits. */
function pressSteps(def: KeyDef, modifiers: number): CdpCall[] {
  // Ctrl, Alt or Meta held: a shortcut, never text.
  const typing = def.text !== undefined && (modifiers & 0b0111) === 0;
  return [
    keyEvent(typing ? "keyDown" : "rawKeyDown", def, modifiers, typing ? def.text : undefined),
    keyEvent("keyUp", def, modifiers),
  ];
}

/**
 * A key chord: the modifiers go down in order, the key is pressed, and they come up in reverse,
 * as a person presses them. A character no US key types (é, ü, an emoji) is inserted as text
 * when no shortcut modifier is held. Throws on an unknown key name.
 */
export function chordSteps(key: string, modifiers: readonly Modifier[] = []): CdpCall[] {
  const shift = modifiers.includes("shift");
  const def = keyDefinition(key, shift);
  if (!def) {
    if (key.length > 0 && [...key].length === 1 && !modifiers.some((m) => m !== "shift"))
      return [{ method: "Input.insertText", params: { text: key } }];
    throw new Error(`Unknown key "${key}".`);
  }
  const held = MODIFIER_KEYS.filter(([m]) => modifiers.includes(m));
  const steps: CdpCall[] = [];
  let bits = 0;
  for (const [m, name] of held) {
    bits |= modifierBits([m]);
    const modDef = keyDefinition(name);
    if (modDef) steps.push(keyEvent("rawKeyDown", modDef, bits));
  }
  steps.push(...pressSteps(def, bits));
  for (const [m, name] of [...held].reverse()) {
    bits &= ~modifierBits([m]);
    const modDef = keyDefinition(name);
    if (modDef) steps.push(keyEvent("keyUp", modDef, bits));
  }
  return steps;
}

/** Past this many characters, text is inserted in one call instead of typed key by key. */
export const TYPE_KEYS_MAX = 300;

/**
 * Text typed at the focus: each character a key press (Shift held for capitals and shifted
 * signs, a new line as Enter), characters no US key types inserted as text. Long text is
 * inserted at once (a key press per character would take seconds).
 */
export function typeSteps(text: string): CdpCall[] {
  const chars = [...text];
  if (chars.length > TYPE_KEYS_MAX)
    return [{ method: "Input.insertText", params: { text: text.replace(/\r?\n/g, "\n") } }];
  const steps: CdpCall[] = [];
  let pending = "";
  const flush = () => {
    if (pending) steps.push({ method: "Input.insertText", params: { text: pending } });
    pending = "";
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? "";
    if (ch === "\r" && chars[i + 1] === "\n") continue;
    const key = ch === "\n" || ch === "\r" ? "Enter" : ch;
    const def = keyDefinition(key, needsShift(key));
    if (!def) {
      pending += ch;
      continue;
    }
    flush();
    steps.push(...(needsShift(key) ? chordSteps(key, ["shift"]) : pressSteps(def, 0)));
  }
  flush();
  return steps;
}

export type ButtonName = "left" | "middle" | "right";
const BUTTON_NAMES: ButtonName[] = ["left", "middle", "right"];
/** The `buttons` bitmask while a button is down. */
const BUTTON_BITS: Record<ButtonName, number> = { left: 1, right: 2, middle: 4 };

export interface Point {
  x: number;
  y: number;
}

function mouse(
  type: string,
  at: Point,
  modifiers: number,
  extra: Record<string, unknown> = {},
): CdpCall {
  return {
    method: "Input.dispatchMouseEvent",
    params: {
      type,
      x: round2(at.x),
      y: round2(at.y),
      modifiers,
      button: "none",
      buttons: 0,
      pointerType: "mouse",
      ...extra,
    },
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Moving the pointer to a point (hover). */
export function hoverSteps(at: Point, mods: readonly Modifier[] = []): CdpCall[] {
  return [mouse("mouseMoved", at, modifierBits(mods))];
}

/** A click with `button` (0 left, 1 middle, 2 right), `count` 1–3 (double, triple). */
export function clickSteps(
  at: Point,
  button = 0,
  count = 1,
  mods: readonly Modifier[] = [],
): CdpCall[] {
  const name = BUTTON_NAMES[button] ?? "left";
  const bits = modifierBits(mods);
  const steps = [mouse("mouseMoved", at, bits)];
  for (let i = 1; i <= Math.min(3, Math.max(1, count)); i++) {
    steps.push(
      mouse("mousePressed", at, bits, { button: name, buttons: BUTTON_BITS[name], clickCount: i }),
      mouse("mouseReleased", at, bits, { button: name, buttons: 0, clickCount: i }),
    );
  }
  return steps;
}

/** A wheel turn of `dx` / `dy` pixels at a point. */
export function wheelSteps(at: Point, dx: number, dy: number, mods: readonly Modifier[] = []) {
  const bits = modifierBits(mods);
  return [mouse("mouseMoved", at, bits), mouse("mouseWheel", at, bits, { deltaX: dx, deltaY: dy })];
}

/** Steps a drag moves through between press and release. */
export const DRAG_STEPS = 8;

/**
 * Pressing at `from`, moving in steps (a frame apart) with the button held, releasing at `to`:
 * sliders, canvases, sortable lists that follow the pointer.
 */
export function dragSteps(from: Point, to: Point, mods: readonly Modifier[] = []): InputStep[] {
  const bits = modifierBits(mods);
  const steps: InputStep[] = [
    mouse("mouseMoved", from, bits),
    mouse("mousePressed", from, bits, { button: "left", buttons: 1, clickCount: 1 }),
  ];
  for (let i = 1; i <= DRAG_STEPS; i++) {
    const at = {
      x: from.x + ((to.x - from.x) * i) / DRAG_STEPS,
      y: from.y + ((to.y - from.y) * i) / DRAG_STEPS,
    };
    steps.push({ waitMs: 16 }, mouse("mouseMoved", at, bits, { button: "left", buttons: 1 }));
  }
  steps.push(mouse("mouseReleased", to, bits, { button: "left", buttons: 0, clickCount: 1 }));
  return steps;
}

/** The page's viewport in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}
/** A box in the host webview's CSS pixels (the frame's getBoundingClientRect). */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A page point (its CSS pixels) in the webview that shows the page in `box`: the frame's place
 * in the IDE, scaled when it is drawn smaller or larger (device mode).
 */
export function hostPoint(at: Point, viewport: Viewport, box: Box): Point {
  const sx = viewport.width > 0 ? box.width / viewport.width : 1;
  const sy = viewport.height > 0 ? box.height / viewport.height : 1;
  return { x: box.left + at.x * sx, y: box.top + at.y * sy };
}

/** Steps with every mouse point moved by `place` (a page point → where the protocol takes it). */
export function placeSteps(steps: readonly InputStep[], place: (p: Point) => Point): InputStep[] {
  return steps.map((s) => {
    if (!("method" in s) || s.method !== "Input.dispatchMouseEvent") return s;
    const x = Number(s.params.x);
    const y = Number(s.params.y);
    const p = place({ x, y });
    return { method: s.method, params: { ...s.params, x: round2(p.x), y: round2(p.y) } };
  });
}

/** How a chord list reads back ("ctrl+a Enter ×3"), as the bridge says it. */
export function chordsText(
  keys: readonly { key: string; modifiers?: readonly Modifier[] }[],
  repeat = 1,
): string {
  const text = keys
    .map((k) => [...(k.modifiers ?? []), k.key === " " ? "Space" : k.key].join("+"))
    .join(" ");
  return `${text}${repeat > 1 ? ` ×${repeat}` : ""}`;
}
