// The agent's browser tools, the DOM-free part (D316): what browser_act's arguments become (an
// IDE command and its input, or a pause), key chords ("ctrl+shift+a", xdotool's names too), points
// and regions of the screenshot's coordinate frame, resize presets, and find's matching of the
// page outline. The tools in extensions/agent/browserTools.ts run what this returns.

export type Modifier = "ctrl" | "shift" | "alt" | "meta";
export interface KeyChord {
  key: string;
  modifiers: Modifier[];
}

/** Long side of the coordinate frame and of screenshots for models (as MODEL_MAX_SIDE). */
export const FRAME_MAX_SIDE = 1568;

const MODIFIERS: Record<string, Modifier> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  super: "meta",
  win: "meta",
  windows: "meta",
};

/** Key names as models write them (DOM names, xdotool's, short forms) → the DOM `key`. */
const KEYS: Record<string, string> = {
  enter: "Enter",
  return: "Enter",
  kp_enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  backspace: "Backspace",
  back_space: "Backspace",
  delete: "Delete",
  del: "Delete",
  tab: "Tab",
  space: " ",
  spacebar: " ",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  page_up: "PageUp",
  prior: "PageUp",
  pagedown: "PageDown",
  page_down: "PageDown",
  next: "PageDown",
  home: "Home",
  end: "End",
  insert: "Insert",
  plus: "+",
  minus: "-",
};

/** "ctrl+shift" / "cmd alt" → modifiers (empty for none). */
export function parseModifiers(text: unknown): Modifier[] {
  if (text === undefined || text === null || text === "") return [];
  if (typeof text !== "string") throw new Error("modifiers: a string like ctrl+shift.");
  const out: Modifier[] = [];
  for (const part of text.split(/[+\s]+/).filter(Boolean)) {
    const m = MODIFIERS[part.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${part}": use ctrl, shift, alt, cmd (meta).`);
    if (!out.includes(m)) out.push(m);
  }
  return out;
}

function keyName(word: string): string {
  if (word.length === 1) return word;
  const named = KEYS[word.toLowerCase()];
  if (named) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(word)) return word.toUpperCase();
  // DOM names the table doesn't list (CapsLock, ContextMenu, AudioVolumeUp…).
  if (/^[A-Z][A-Za-z0-9]+$/.test(word)) return word;
  throw new Error(`Unknown key "${word}": use a character or a name like Enter, Tab, ArrowDown.`);
}

/** One chord: "ctrl+shift+a", "Enter", "cmd++" (the key last). */
export function parseChord(text: string): KeyChord {
  if (text === "+") return { key: "+", modifiers: [] };
  const plusKey = text.endsWith("++");
  const parts = (plusKey ? text.slice(0, -2) : text).split("+").filter(Boolean);
  const last = plusKey ? "+" : parts.pop();
  if (!last) throw new Error(`No key in "${text}".`);
  const modifiers: Modifier[] = [];
  for (const p of parts) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m) throw new Error(`Unknown modifier "${p}" in "${text}".`);
    if (!modifiers.includes(m)) modifiers.push(m);
  }
  // A modifier as the key ("shift", "ctrl+shift") is a press of that key itself.
  const asKey = MODIFIERS[last.toLowerCase()];
  return { key: asKey ? capitalModifier(asKey) : keyName(last), modifiers };
}

function capitalModifier(m: Modifier): string {
  return m === "ctrl" ? "Control" : m === "meta" ? "Meta" : m === "alt" ? "Alt" : "Shift";
}

/** Space-separated chords ("Backspace Backspace ctrl+a"); a lone space is the space key. */
export function parseKeys(text: unknown): KeyChord[] {
  if (typeof text !== "string" || text === "") throw new Error("key: give the key(s) to press.");
  if (text.trim() === "") return [{ key: " ", modifiers: [] }];
  return text.trim().split(/\s+/).map(parseChord);
}

/** [x, y] in the coordinate frame (also "x,y" or a JSON array as a string). */
export function parsePoint(value: unknown, name = "coordinate"): [number, number] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(/^\s*\[/.test(v) ? v : `[${v}]`);
    } catch {
      throw new Error(`${name}: [x, y] numbers.`);
    }
  }
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    !v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  )
    throw new Error(`${name}: [x, y], two numbers ≥ 0 in the screenshot's coordinate frame.`);
  return [v[0] as number, v[1] as number];
}

/** [x0, y0, x1, y1] with x1 > x0 and y1 > y0. */
export function parseRegion(value: unknown): [number, number, number, number] {
  const v = typeof value === "string" ? safeJson(value) : value;
  if (
    !Array.isArray(v) ||
    v.length !== 4 ||
    !v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  )
    throw new Error("region: [x0, y0, x1, y1] in the coordinate frame.");
  const [x0, y0, x1, y1] = v as [number, number, number, number];
  if (x1 <= x0 || y1 <= y0) throw new Error("region: x1 > x0 and y1 > y0.");
  return [x0, y0, x1, y1];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The coordinate frame of a page whose viewport is `viewport` CSS pixels: the viewport, scaled
 * down to fit `maxSide`. Screenshots for models are this size (at scale 1), so a point read off one
 * is a point here; the bridge maps it back with the same scale.
 */
export function coordinateFrame(
  viewport: { width: number; height: number },
  maxSide = FRAME_MAX_SIDE,
): { width: number; height: number; scale: number } {
  const w = Math.max(1, viewport.width);
  const h = Math.max(1, viewport.height);
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.round(w * scale), height: Math.round(h * scale), scale };
}

/** A number in [min, max] (rounded when `integer`), else the default; strings of numbers too. */
export function numberIn(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  integer = true,
): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  const r = integer ? Math.round(n) : n;
  return Math.min(max, Math.max(min, r));
}

/** Claude Code's resize presets (desktop: the page fills the tab again). */
export function resizePreset(preset: string): Record<string, unknown> {
  switch (preset.toLowerCase()) {
    case "mobile":
      return { width: 375, height: 812 };
    case "tablet":
      return { width: 768, height: 1024 };
    case "desktop":
      return { device: "responsive" };
    default:
      throw new Error(`Unknown preset "${preset}": mobile, tablet or desktop.`);
  }
}

/** Whether a page is the user's own (a local server or a workspace file), not another site. */
export function isLocalPage(url: string): boolean {
  if (!url) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return true; // a workspace path ("index.html")
  try {
    const u = new URL(url);
    if (u.protocol === "file:") return true;
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host === "0.0.0.0" ||
      host.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/** The page's origin for remembering answers per site ("http://localhost:5173", a path's "file"). */
export function siteOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === "file:" ? "file" : u.origin;
  } catch {
    return "file";
  }
}

// ---- find ---------------------------------------------------------------------------------------

/** One line of the page outline the bridge sends for find: an element (or its text) and its ref. */
export interface OutlineLine {
  ref: string;
  line: string;
}

/**
 * Lines whose text contains `query` (case-insensitively; every word of a several-word query when
 * no line holds the phrase), one per ref, at most `limit`.
 */
export function findInOutline(
  lines: readonly OutlineLine[],
  query: string,
  limit = 20,
): OutlineLine[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) throw new Error("find: give the text to look for.");
  const pick = (test: (line: string) => boolean) => {
    const out: OutlineLine[] = [];
    const seen = new Set<string>();
    for (const l of lines) {
      if (out.length >= limit) break;
      if (seen.has(l.ref) || !test(l.line.toLowerCase().replace(/\s+/g, " "))) continue;
      seen.add(l.ref);
      out.push(l);
    }
    return out;
  };
  const phrase = pick((l) => l.includes(q));
  if (phrase.length) return phrase;
  const words = q.split(" ");
  return words.length > 1 ? pick((l) => words.every((w) => l.includes(w))) : [];
}

// ---- browser_act ------------------------------------------------------------------------------

/** What browser_act does: an IDE command with its input, or a pause. */
export type ActPlan =
  | { command: string; input: Record<string, unknown>; sleepMs?: undefined }
  | { sleepMs: number; input?: undefined; command?: undefined };

export const ACT_ACTIONS = [
  "click",
  "right_click",
  "double_click",
  "triple_click",
  "type",
  "press",
  "select",
  "scroll",
  "hover",
  "drag",
  "navigate",
  "back",
  "forward",
  "reload",
  "wait",
  "new_tab",
  "select_tab",
  "close_tab",
  // Run by the agent's tool itself, not planAct (D339, D340).
  "upload",
  "start_recording",
  "stop_recording",
] as const;

/** Claude Code's computer action names, taken too. */
const ACTION_ALIASES: Record<string, string> = {
  left_click: "click",
  left_click_drag: "drag",
  key: "press",
  scroll_to: "scroll",
  mouse_move: "hover",
};

const CLICKS: Record<string, { button: number; count: number }> = {
  click: { button: 0, count: 1 },
  right_click: { button: 2, count: 1 },
  double_click: { button: 0, count: 2 },
  triple_click: { button: 0, count: 3 },
};

/** Ticks of the wheel → pixels (Chromium scrolls about 100 px a tick). */
export const PIXELS_PER_TICK = 100;

/** Turns browser_act's arguments into what to run. Throws on bad arguments, with how to fix them. */
export function planAct(args: Record<string, unknown>): ActPlan {
  const raw = String(args.action ?? "");
  const action = ACTION_ALIASES[raw] ?? raw;
  const pick = (...keys: string[]) =>
    Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
  const loc = pick("ref", "selector", "name");
  const hasLoc = Object.keys(loc).length > 0;
  const at = args.coordinate !== undefined ? parsePoint(args.coordinate) : null;
  const modifiers = parseModifiers(args.modifiers);
  const mods = modifiers.length ? { modifiers } : {};
  const where = at ? { x: at[0], y: at[1] } : loc;
  const needTarget = () => {
    if (!at && !hasLoc)
      throw new Error(`${action}: give a ref (from browser_snapshot) or a coordinate [x, y].`);
  };
  const click = CLICKS[action];
  if (click) {
    needTarget();
    // A plain click on an element keeps browser.click (focus, the element's own click()).
    if (action === "click" && !at && !modifiers.length)
      return { command: "browser.click", input: loc };
    return { command: "browser.input", input: { op: "click", ...where, ...click, ...mods } };
  }
  switch (action) {
    case "hover":
      needTarget();
      return at
        ? { command: "browser.input", input: { op: "hover", ...where } }
        : { command: "browser.hover", input: loc };
    case "type":
      if (typeof args.text !== "string") throw new Error("type: give the text.");
      // Into an element (replacing its value), or at the focus as keystrokes.
      return hasLoc
        ? { command: "browser.type", input: { ...loc, ...pick("text", "submit") } }
        : {
            command: "browser.input",
            input: { op: "type", text: args.text, ...(args.submit === true && { submit: true }) },
          };
    case "press": {
      const keyText = args.key ?? args.text;
      const keys = parseKeys(keyText);
      const repeat = numberIn(args.repeat, 1, 100, 1);
      const only = keys[0];
      // One plain key on an element: browser.press, as before.
      if (keys.length === 1 && only && !only.modifiers.length && repeat === 1 && !modifiers.length)
        return { command: "browser.press", input: { ...loc, key: only.key } };
      const withMods = modifiers.length
        ? keys.map((k) => ({
            key: k.key,
            modifiers: [...new Set([...modifiers, ...k.modifiers])],
          }))
        : keys;
      return {
        command: "browser.input",
        input: { op: "key", keys: withMods, repeat, ...loc },
      };
    }
    case "select":
      return { command: "browser.select", input: { ...loc, ...pick("value") } };
    case "scroll": {
      const direction = args.scroll_direction;
      if (at || direction !== undefined || args.scroll_amount !== undefined) {
        const ticks = numberIn(args.scroll_amount, 1, 10, 3);
        const d = typeof direction === "string" ? direction : "down";
        if (!["up", "down", "left", "right"].includes(d))
          throw new Error("scroll_direction: up, down, left or right.");
        const px = ticks * PIXELS_PER_TICK;
        return {
          command: "browser.input",
          input: {
            op: "scroll",
            ...where,
            dx: d === "left" ? -px : d === "right" ? px : 0,
            dy: d === "up" ? -px : d === "down" ? px : 0,
            ...mods,
          },
        };
      }
      return { command: "browser.scroll", input: { ...loc, ...pick("to") } };
    }
    case "drag": {
      if (!at) throw new Error("drag: coordinate is where to drop, [x, y].");
      const from =
        args.start_coordinate !== undefined
          ? parsePoint(args.start_coordinate, "start_coordinate")
          : null;
      if (!from && !hasLoc)
        throw new Error("drag: start_coordinate [x, y] (or a ref) is what to pick up.");
      return {
        command: "browser.input",
        input: {
          op: "drag",
          ...(from ? { fromX: from[0], fromY: from[1] } : loc),
          x: at[0],
          y: at[1],
          ...mods,
        },
      };
    }
    case "navigate":
      if (typeof args.url !== "string" || !args.url) throw new Error("navigate: give the url.");
      return { command: "browser.navigate", input: pick("url") };
    case "back":
      return { command: "browser.back", input: {} };
    case "forward":
      return { command: "browser.forward", input: {} };
    case "reload":
      return { command: "browser.reload", input: {} };
    case "wait":
      if (args.duration !== undefined && args.text === undefined && args.selector === undefined)
        return { sleepMs: Math.round(numberIn(args.duration, 0, 10, 1, false) * 1000) };
      return {
        command: "browser.wait",
        input: { ...pick("selector", "text"), timeoutMs: 10000 },
      };
    case "new_tab":
      return {
        command: "browser.open",
        input: { newTab: true, ...(typeof args.url === "string" && args.url && { url: args.url }) },
      };
    case "select_tab":
    case "close_tab":
      if (typeof args.tab !== "string" || !args.tab)
        throw new Error(`${action}: give the tab id (browser_inspect what: tabs).`);
      return {
        command: action === "select_tab" ? "browser.selectTab" : "browser.closeTab",
        input: { tab: args.tab },
      };
    default:
      throw new Error(`Unknown action "${raw}". Use one of: ${ACT_ACTIONS.join(", ")}.`);
  }
}

/** The row's text for a browser_act call: its action_summary, else action and target. */
export function actLabel(args: Record<string, unknown>): string {
  const summary = typeof args.action_summary === "string" ? args.action_summary.trim() : "";
  if (summary) return summary.length > 120 ? `${summary.slice(0, 119)}…` : summary;
  const at = Array.isArray(args.coordinate) ? `(${args.coordinate.join(", ")})` : "";
  return `${String(args.action ?? "")} ${String(
    args.ref ?? args.name ?? args.url ?? args.key ?? args.tab ?? at,
  )}`.trim();
}

/** A filter for `pattern`: a regular expression (case-insensitive), else plain text. */
export function textMatcher(pattern?: string): (text: string) => boolean {
  if (!pattern) return () => true;
  try {
    const re = new RegExp(pattern, "i");
    return (text) => re.test(text);
  } catch {
    const want = pattern.toLowerCase();
    return (text) => text.toLowerCase().includes(want);
  }
}
