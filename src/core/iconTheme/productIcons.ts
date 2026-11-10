// Product icon themes (D267, VS Code's `contributes.productIconThemes`): a font and the glyph it
// has for each of VS Code's codicons ("files", "search", "close"…). The IDE draws its own icons
// (Lucide names), so each of those is mapped to the codicon that plays the same part; an icon
// the theme has no glyph for (or with no counterpart) stays the IDE's. DOM-free and unit-tested.

export interface ProductIconDefinition {
  fontCharacter: string;
  fontId?: string;
}

export interface ProductIconThemeDocument {
  fonts: {
    id: string;
    src: { path: string; format: string }[];
    weight?: string;
    style?: string;
  }[];
  iconDefinitions: Record<string, ProductIconDefinition>;
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** A product icon theme's JSON, its fonts and definitions kept as far as they're usable. */
export function asProductIconTheme(raw: unknown): ProductIconThemeDocument {
  const o = obj(raw);
  const fonts = (Array.isArray(o.fonts) ? o.fonts : []).flatMap((f) => {
    const x = obj(f);
    const id = str(x.id);
    const src = (Array.isArray(x.src) ? x.src : []).flatMap((s) => {
      const path = str(obj(s).path);
      return path ? [{ path, format: str(obj(s).format) ?? "woff" }] : [];
    });
    if (!id || !src.length) return [];
    return [
      {
        id,
        src,
        ...(str(x.weight) && { weight: str(x.weight) }),
        ...(str(x.style) && { style: str(x.style) }),
      },
    ];
  });
  const iconDefinitions: Record<string, ProductIconDefinition> = {};
  for (const [id, d] of Object.entries(obj(o.iconDefinitions))) {
    const fontCharacter = str(obj(d).fontCharacter);
    if (!fontCharacter) continue;
    const fontId = str(obj(d).fontId);
    iconDefinitions[id] = { fontCharacter, ...(fontId && { fontId }) };
  }
  return { fonts, iconDefinitions };
}

/** "\\eb44" (VS Code's escaped form) or the character itself → the character. */
export function glyphText(fontCharacter: string): string {
  const m = /^\\([0-9a-fA-F]{1,6})$/.exec(fontCharacter);
  if (!m?.[1]) return fontCharacter;
  const code = Number.parseInt(m[1], 16);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/**
 * The IDE's icon → the codicon that does the same job in VS Code (the activity bar's, the
 * views' and editors' actions, the status bar's, the debugger's). Icons without one stay the
 * IDE's whatever the theme.
 */
export const CODICON_FOR: Readonly<Record<string, string>> = {
  // Activity bar and views.
  files: "files",
  search: "search",
  "git-branch": "source-control",
  "bug-play": "debug-alt",
  blocks: "extensions",
  puzzle: "extensions",
  "flask-conical": "beaker",
  settings: "settings-gear",
  "sliders-horizontal": "settings",
  "circle-user-round": "account",
  "list-tree": "list-tree",
  list: "list-flat",
  "list-collapse": "collapse-all",
  "list-filter": "filter",
  history: "history",
  "messages-square": "comment-discussion",
  "message-square-code": "comment-discussion",
  "message-circle-question": "question",
  // Common actions.
  x: "close",
  plus: "add",
  minus: "remove",
  "circle-minus": "remove",
  "refresh-cw": "refresh",
  "refresh-ccw": "refresh",
  "rotate-cw": "refresh",
  "rotate-ccw": "discard",
  "undo-2": "discard",
  "redo-2": "redo",
  ellipsis: "ellipsis",
  menu: "menu",
  check: "check",
  "check-check": "check-all",
  copy: "copy",
  "trash-2": "trash",
  pencil: "edit",
  save: "save",
  "save-all": "save-all",
  eye: "eye",
  "eye-off": "eye-closed",
  link: "link",
  "external-link": "link-external",
  pin: "pin",
  "list-x": "clear-all",
  "zoom-in": "zoom-in",
  "zoom-out": "zoom-out",
  "maximize-2": "screen-full",
  "minimize-2": "screen-normal",
  "arrow-up": "arrow-up",
  "arrow-down": "arrow-down",
  "arrow-left": "arrow-left",
  "arrow-right": "arrow-right",
  "arrow-left-right": "arrow-swap",
  "chevron-right": "chevron-right",
  "chevron-down": "chevron-down",
  "grip-vertical": "gripper",
  // Files and folders (the IDE's own, not a file icon theme's).
  file: "file",
  "file-code": "file-code",
  "file-text": "file",
  "file-plus": "new-file",
  "folder-plus": "new-folder",
  folder: "folder",
  "folder-open": "folder-opened",
  "file-archive": "file-zip",
  "file-diff": "diff",
  "file-symlink": "file-symlink-file",
  image: "file-media",
  notebook: "notebook",
  // Search and replace.
  "case-sensitive": "case-sensitive",
  "whole-word": "whole-word",
  regex: "regex",
  replace: "replace",
  "replace-all": "replace-all",
  // Layout.
  "columns-2": "split-horizontal",
  "rows-2": "split-vertical",
  "terminal-split": "split-horizontal",
  "panel-left": "layout-sidebar-left-off",
  "panel-left-on": "layout-sidebar-left",
  "panel-bottom": "layout-panel-off",
  "panel-bottom-on": "layout-panel",
  "panel-right": "layout-sidebar-right-off",
  "panel-right-on": "layout-sidebar-right",
  "window-restore": "multiple-windows",
  "app-window": "window",
  "layout-dashboard": "dashboard",
  // Terminal, running and debugging.
  terminal: "terminal",
  "square-terminal": "terminal",
  play: "play",
  pause: "debug-pause",
  square: "debug-stop",
  "redo-dot": "debug-step-over",
  "arrow-down-to-dot": "debug-step-into",
  "arrow-up-from-dot": "debug-step-out",
  "circle-dot": "debug-breakpoint",
  ban: "circle-slash",
  // Status and notifications.
  bell: "bell",
  "bell-dot": "bell-dot",
  info: "info",
  "triangle-alert": "warning",
  "circle-alert": "error",
  "circle-x": "error",
  "circle-check": "pass",
  "circle-dashed": "circle-large-outline",
  // Source control.
  "git-commit-horizontal": "git-commit",
  "git-compare": "git-compare",
  "git-merge": "git-merge",
  "git-pull-request": "git-pull-request",
  "git-fork": "repo-forked",
  "folder-git-2": "repo",
  "cloud-upload": "cloud-upload",
  "cloud-download": "cloud-download",
  cloud: "cloud",
  // Symbols and the rest.
  braces: "json",
  variable: "symbol-variable",
  "square-function": "symbol-method",
  hash: "symbol-number",
  box: "package",
  library: "library",
  server: "server",
  plug: "plug",
  target: "target",
  locate: "target",
  code: "code",
  keyboard: "keyboard",
  bookmark: "bookmark",
  star: "star-empty",
  tag: "tag",
  zap: "zap",
  sparkles: "sparkle",
  "wand-sparkles": "sparkle",
  lightbulb: "lightbulb",
  "key-round": "key",
  "log-out": "sign-out",
  "log-in": "sign-in",
  globe: "globe",
  clock: "watch",
  calendar: "calendar",
  shield: "shield",
  palette: "symbol-color",
  "text-wrap": "word-wrap",
  mic: "mic",
  users: "organization",
  archive: "archive",
  "book-open": "book",
  "chart-column": "graph",
  "list-todo": "checklist",
  "list-checks": "checklist",
  layers: "layers",
  cpu: "chip",
  hammer: "tools",
  "scroll-text": "output",
  camera: "device-camera",
  "at-sign": "mention",
  "radio-tower": "broadcast",
  download: "desktop-download",
};

let iconForCodicon: Map<string, string> | null = null;

/**
 * The IDE's icon for a VS Code codicon an extension names (`$(circle-slash)` → "ban",
 * `$(broadcast)` → "radio-tower"), the reverse of CODICON_FOR: the first IDE icon that maps to
 * it, or undefined (D284).
 */
export function iconForCodiconName(codicon: string): string | undefined {
  if (!iconForCodicon) {
    iconForCodicon = new Map();
    for (const [ide, code] of Object.entries(CODICON_FOR))
      if (!iconForCodicon.has(code)) iconForCodicon.set(code, ide);
  }
  return iconForCodicon.get(codicon);
}

/** The theme's glyph for the IDE's `icon`, or undefined (the IDE's own icon stays). */
export function productGlyph(
  doc: ProductIconThemeDocument,
  icon: string,
): ProductIconDefinition | undefined {
  const codicon = CODICON_FOR[icon];
  return codicon ? doc.iconDefinitions[codicon] : undefined;
}
