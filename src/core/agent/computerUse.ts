// Desktop control, the DOM-free part (D353), after Claude Code's computer use: which apps the
// agent may act on and how (tiers), what each action needs, the coordinate frame of a desktop
// screenshot (the browser tools' frame: the captured area scaled to fit 1568 px) and its mapping
// back to physical screen pixels, key chords as Windows virtual-key codes, and refusing to type
// what looks like a card number. extensions/agent/computerTool.ts runs the tool.

import { coordinateFrame, type KeyChord, type Modifier } from "./browserInput";

export const COMPUTER_ACTIONS = [
  "screenshot",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_move",
  "left_click_drag",
  "scroll",
  "type",
  "key",
  "wait",
  // D374: the clipboard, asked for like an app (copying between apps is ctrl+c / ctrl+v in each).
  "read_clipboard",
  "write_clipboard",
] as const;
export type ComputerAction = (typeof COMPUTER_ACTIONS)[number];

/**
 * How far the agent may go in an app. full: anything. click: look, left-click and scroll
 * (terminals, IDEs: typing there would run commands; use run_command). read: look only
 * (browsers: use the browser tools). ask: anything, but asked every time (system settings, the
 * IDE's own window). refused: never (password managers, banking and trading).
 */
export type AppTier = "full" | "click" | "read" | "ask" | "refused";

/** What an action needs from the app it acts on. */
export type ActionNeed = "see" | "click" | "input";

export interface WindowApp {
  /** The executable's file name ("notepad.exe"); may be empty. */
  process: string;
  title: string;
  isSelf: boolean;
}

export interface AppInfo {
  /** What a grant is kept by: the executable without ".exe", lower case. */
  key: string;
  /** How the user sees it named. */
  name: string;
  tier: AppTier;
  /** Why it has its tier (for the refusal or the card). */
  why: string;
}

const BROWSERS = [
  "chrome",
  "msedge",
  "firefox",
  "brave",
  "opera",
  "opera_gx",
  "vivaldi",
  "arc",
  "iexplore",
  "chromium",
  "waterfox",
  "librewolf",
  "thorium",
  "yandex",
];
const TERMINALS_AND_IDES = [
  "cmd",
  "powershell",
  "pwsh",
  "windowsterminal",
  "wt",
  "openconsole",
  "conhost",
  "mintty",
  "alacritty",
  "wezterm-gui",
  "wezterm",
  "hyper",
  "tabby",
  "warp",
  "putty",
  "kitty",
  "code",
  "code - insiders",
  "cursor",
  "windsurf",
  "zed",
  "devenv",
  "idea64",
  "idea",
  "pycharm64",
  "webstorm64",
  "rider64",
  "clion64",
  "goland64",
  "phpstorm64",
  "rubymine64",
  "datagrip64",
  "rustrover64",
  "studio64",
  "fleet",
  "sublime_text",
  "eclipse",
  "netbeans64",
];
const PASSWORD_MANAGERS = [
  "1password",
  "bitwarden",
  "keepass",
  "keepassxc",
  "lastpass",
  "dashlane",
  "keeper",
  "enpass",
  "roboform",
  "nordpass",
  "proton pass",
  "protonpass",
  "credentialuibroker",
];
/** Trading and banking apps (by executable). Budgeting and accounting apps stay at full. */
const FINANCE = [
  "thinkorswim",
  "tws",
  "ibgateway",
  "terminal64",
  "metatrader",
  "ninjatrader",
  "tradestation",
  "tradingview",
  "webull",
  "webull desktop",
  "etrade",
  "fidelity active trader pro",
  "activetraderpro",
  "robinhood",
  "coinbase",
  "binance",
  "kraken",
  "exodus",
  "ledger live",
  "trezor suite",
  "electrum",
];
const SYSTEM_SETTINGS = [
  "systemsettings",
  "control",
  "mmc",
  "regedit",
  "taskmgr",
  "gpedit",
  "secpol",
  "services",
  "msconfig",
  "computerdefaults",
  "useraccountcontrolsettings",
  "windowsdefender",
  "securityhealthsystray",
  "sechealthui",
  "diskmgmt",
  "compmgmt",
  "devmgmt",
  "netplwiz",
  "optionalfeatures",
];
/** Window titles that mark an app the executable doesn't name (Windows' app frame host). */
const TITLE_RULES: { re: RegExp; tier: AppTier; why: string }[] = [
  { re: /^settings$|windows security/i, tier: "ask", why: "system settings" },
  {
    re: /password manager|1password|bitwarden|keepass|lastpass/i,
    tier: "refused",
    why: "a password manager",
  },
];

/** "Notepad.exe" → "notepad". */
export function appKey(process: string): string {
  return process
    .trim()
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

/** The app a window belongs to, and its tier. */
export function classifyApp(w: WindowApp): AppInfo {
  if (w.isSelf)
    return {
      key: "<ide>",
      name: "the IDE",
      tier: "ask",
      why: "the IDE's own window (use the IDE's tools instead; asked every time)",
    };
  let key = appKey(w.process);
  let name = key || w.title || "an unknown app";
  // Store apps (Settings, Calculator…) run inside ApplicationFrameHost: their title names them.
  if (key === "applicationframehost" || key === "") {
    const title = w.title.trim() || "an unknown app";
    key = `app:${title.toLowerCase()}`;
    name = title;
  }
  const bare = key.replace(/^app:/, "");
  for (const rule of TITLE_RULES)
    if (rule.re.test(w.title) && (key.startsWith("app:") || rule.tier === "refused"))
      return { key, name, tier: rule.tier, why: rule.why };
  if (PASSWORD_MANAGERS.includes(bare))
    return { key, name, tier: "refused", why: "a password manager" };
  if (FINANCE.includes(bare))
    return { key, name, tier: "refused", why: "a trading, banking or crypto app" };
  if (SYSTEM_SETTINGS.includes(bare))
    return { key, name, tier: "ask", why: "system settings (asked every time)" };
  if (BROWSERS.includes(bare))
    return {
      key,
      name,
      tier: "read",
      why: "a web browser: it can be seen, not clicked or typed in (use the IDE's browser tools)",
    };
  if (TERMINALS_AND_IDES.includes(bare))
    return {
      key,
      name,
      tier: "click",
      why: "a terminal or IDE: left-click and scroll only, no typing, keys, right-click or drag (use run_command for commands)",
    };
  return { key, name, tier: "full", why: "" };
}

/** What an action needs from its app. Modifier clicks count as input (ctrl+click opens links). */
export function actionNeed(action: string, modifiers = ""): ActionNeed {
  switch (action) {
    case "screenshot":
    case "wait":
    case "read_clipboard":
      return "see";
    case "left_click":
    case "double_click":
    case "triple_click":
    case "scroll":
    case "mouse_move":
      return modifiers.trim() ? "input" : "click";
    default:
      return "input";
  }
}

export function tierAllows(tier: AppTier, need: ActionNeed): boolean {
  switch (tier) {
    case "refused":
      return false;
    case "read":
      return need === "see";
    case "click":
      return need !== "input";
    default:
      return true;
  }
}

/**
 * Whether an action on an app goes ahead: refused (the tier or the action isn't allowed there),
 * ask (the user decides: every time for the "ask" tier), or allowed (granted for this chat).
 */
export function accessDecision(
  app: AppInfo,
  need: ActionNeed,
  granted: boolean,
): { decision: "refused" | "ask" | "allowed"; everyTime: boolean; reason?: string } {
  if (app.tier === "refused")
    return {
      decision: "refused",
      everyTime: false,
      reason: `${app.name} is ${app.why}: the agent never acts on it. Ask the user to do this themselves.`,
    };
  if (!tierAllows(app.tier, need))
    return {
      decision: "refused",
      everyTime: false,
      reason: `${app.name} is ${app.why}.`,
    };
  if (app.tier === "ask") return { decision: "ask", everyTime: true };
  return granted
    ? { decision: "allowed", everyTime: false }
    : { decision: "ask", everyTime: false };
}

/** A rectangle of the virtual desktop in physical pixels. */
export interface ScreenArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The coordinate frame of a screenshot of `area`: its size scaled to fit 1568 px. */
export interface DesktopFrame {
  area: ScreenArea;
  width: number;
  height: number;
}

export function desktopFrame(area: ScreenArea): DesktopFrame {
  const f = coordinateFrame({ width: area.width, height: area.height });
  return { area: { ...area }, width: f.width, height: f.height };
}

/** A point of the frame → physical screen pixels (clamped inside the captured area). */
export function toScreen(frame: DesktopFrame, point: [number, number]): [number, number] {
  const { area } = frame;
  const sx = area.width / Math.max(1, frame.width);
  const sy = area.height / Math.max(1, frame.height);
  const x = Math.min(area.width - 1, Math.max(0, Math.round(point[0] * sx)));
  const y = Math.min(area.height - 1, Math.max(0, Math.round(point[1] * sy)));
  return [area.x + x, area.y + y];
}

/** Whether a point is inside the frame (a point past its edge is the model misreading it). */
export function inFrame(frame: DesktopFrame, point: [number, number]): boolean {
  return point[0] <= frame.width && point[1] <= frame.height;
}

/**
 * The capture for a zoom into `region` of the frame: that part of the screen in physical pixels,
 * and the image's size (the region's own detail, up to 1568 px on its long side, times `scale`).
 */
export function zoomCapture(
  frame: DesktopFrame,
  region: [number, number, number, number],
  scale = 1,
): { area: ScreenArea; outWidth: number; outHeight: number } {
  const [x0, y0, x1, y1] = region;
  const [left, top] = toScreen(frame, [Math.min(x0, frame.width), Math.min(y0, frame.height)]);
  const [right, bottom] = toScreen(frame, [Math.min(x1, frame.width), Math.min(y1, frame.height)]);
  const area = {
    x: left,
    y: top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
  const fit = coordinateFrame(area);
  return {
    area,
    outWidth: Math.max(1, Math.round(fit.width * scale)),
    outHeight: Math.max(1, Math.round(fit.height * scale)),
  };
}

const MODIFIER_VK: Record<Modifier, number> = { ctrl: 0x11, shift: 0x10, alt: 0x12, meta: 0x5b };

const NAMED_VK: Record<string, number> = {
  Enter: 0x0d,
  Escape: 0x1b,
  Backspace: 0x08,
  Tab: 0x09,
  " ": 0x20,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  Insert: 0x2d,
  Delete: 0x2e,
  Control: 0x11,
  Shift: 0x10,
  Alt: 0x12,
  Meta: 0x5b,
  CapsLock: 0x14,
  ContextMenu: 0x5d,
  PrintScreen: 0x2c,
  Pause: 0x13,
  NumLock: 0x90,
  ScrollLock: 0x91,
  AudioVolumeMute: 0xad,
  AudioVolumeDown: 0xae,
  AudioVolumeUp: 0xaf,
  MediaPlayPause: 0xb3,
  ";": 0xba,
  "=": 0xbb,
  "+": 0xbb,
  ",": 0xbc,
  "-": 0xbd,
  ".": 0xbe,
  "/": 0xbf,
  "`": 0xc0,
  "[": 0xdb,
  "\\": 0xdc,
  "]": 0xdd,
  "'": 0xde,
};

/** A chord as Windows virtual-key codes: the modifiers, then the key. */
export function chordToVks(chord: KeyChord): number[] {
  const mods = chord.modifiers.map((m) => MODIFIER_VK[m]);
  const k = chord.key;
  let vk: number | undefined = NAMED_VK[k];
  if (vk === undefined && /^[a-z0-9]$/i.test(k)) vk = k.toUpperCase().charCodeAt(0);
  if (vk === undefined) {
    const f = /^F([1-9]|1[0-9]|2[0-4])$/.exec(k);
    if (f) vk = 0x6f + Number(f[1]);
  }
  if (vk === undefined)
    throw new Error(`The key "${k}" can't be pressed as a key: use action type for text.`);
  return [...mods.filter((m) => m !== vk), vk];
}

/** Digits that look like a payment card number (13–19 digits passing the Luhn check). */
export function looksLikeCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\d[\d -]{11,}\d/g)) {
    const digits = m[0].replace(/[ -]/g, "");
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** The tool row's target: "left_click 640, 400", "type "hello"", or its action_summary. */
export function computerLabel(args: Record<string, unknown>): string {
  if (typeof args.action_summary === "string" && args.action_summary.trim())
    return args.action_summary.trim();
  const action = String(args.action ?? "");
  const at = Array.isArray(args.coordinate) ? ` ${args.coordinate.join(", ")}` : "";
  if (action === "type" && typeof args.text === "string")
    return `type "${args.text.length > 40 ? `${args.text.slice(0, 39)}…` : args.text}"`;
  if (action === "key" && typeof args.text === "string") return `key ${args.text}`;
  if (action === "write_clipboard" && typeof args.text === "string")
    return `copy "${args.text.length > 40 ? `${args.text.slice(0, 39)}…` : args.text}"`;
  if (action === "read_clipboard") return "read the clipboard";
  return `${action}${at}`;
}
