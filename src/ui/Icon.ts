// Icons: one inline SVG sprite (Lucide, ISC) injected once; icons reference symbols by id.
import { iconForCodiconName } from "../core/iconTheme/productIcons";
import { signal } from "../core/reactive/index";
import { fileIconTint } from "./fileTint";
import sprite from "./icons/sprite.svg";

export type IconName =
  | "lock"
  | "lock-open"
  | "clipboard-clock"
  | "messages-square"
  | "kanban"
  | "list-todo"
  | "list"
  | "text-wrap"
  | "file-down"
  | "layers"
  | "users"
  | "list-checks"
  | "rows-3"
  | "server"
  | "plug"
  | "sliders-horizontal"
  | "library"
  | "cpu"
  | "sparkles"
  | "mic"
  | "puzzle"
  | "arrow-up-right"
  | "corner-down-left"
  | "circle-dashed"
  | "lightbulb"
  | "file-symlink"
  | "archive-restore"
  | "text-select"
  | "file-search"
  | "text-search"
  | "message-square"
  | "message-square-plus"
  | "user-pen"
  | "badge-check"
  | "hammer"
  | "scroll-text"
  | "message-square-code"
  | "file-input"
  | "folder-search"
  | "locate"
  | "scissors"
  | "clipboard-paste"
  | "clipboard-copy"
  | "link"
  | "chart-column"
  | "message-circle-question"
  | "copy-plus"
  | "arrow-right-to-line"
  | "check-check"
  | "folder-x"
  | "save"
  | "save-all"
  | "file-output"
  | "redo-2"
  | "wand-sparkles"
  | "text-cursor-input"
  | "palette"
  | "archive"
  | "eye-off"
  | "download"
  | "upload"
  | "files"
  | "case-upper"
  | "git-pull-request"
  | "git-fork"
  | "folder-git-2"
  | "grip-vertical"
  | "list-chevrons-up-down"
  | "key-round"
  | "git-graph"
  | "circle-user-round"
  | "log-out"
  | "log-in"
  | "play"
  | "pause"
  | "bug-play"
  | "redo-dot"
  | "arrow-down-to-dot"
  | "arrow-up-from-dot"
  | "ban"
  | "eye"
  | "book-open"
  | "zoom-in"
  | "zoom-out"
  | "scan"
  | "code"
  | "list-x"
  | "refresh-ccw"
  | "file"
  | "file-code"
  | "file-json"
  | "file-text"
  | "file-terminal"
  | "image"
  | "folder"
  | "folder-open"
  | "chevron-right"
  | "chevron-down"
  | "square-terminal"
  | "terminal-split"
  | "bot"
  | "agent"
  | "pin"
  | "pin-off"
  | "paperclip"
  | "at-sign"
  | "brain"
  | "file-up"
  | "arrow-down-a-z"
  | "x"
  | "minus"
  | "square"
  | "copy"
  | "refresh-cw"
  | "file-plus"
  | "folder-plus"
  | "list-collapse"
  | "panel-left"
  | "panel-bottom"
  | "panel-right"
  | "plus"
  | "trash-2"
  | "rotate-ccw"
  | "braces"
  | "keyboard"
  | "case-sensitive"
  | "whole-word"
  | "regex"
  | "replace"
  | "replace-all"
  | "list-tree"
  | "circle-x"
  | "radio"
  | "circle-dot"
  | "list-filter"
  | "pencil"
  | "circle-alert"
  | "columns-2"
  | "rows-2"
  | "maximize-2"
  | "minimize-2"
  | "menu"
  | "search"
  | "settings"
  | "sun"
  | "moon"
  | "ellipsis"
  | "globe"
  | "circle-check"
  | "info"
  | "triangle-alert"
  | "check"
  | "layout-dashboard"
  | "panel-top"
  | "camera"
  | "radio-tower"
  | "bell"
  | "bell-dot"
  | "picture-in-picture-2"
  | "monitor-smartphone"
  | "panel-left-on"
  | "panel-bottom-on"
  | "panel-right-on"
  | "git-branch"
  | "git-commit-horizontal"
  | "git-compare"
  | "git-merge"
  | "undo-2"
  | "arrow-up"
  | "arrow-down"
  | "cloud-upload"
  | "cloud"
  | "target"
  | "flask-conical"
  | "circle-minus"
  | "cloud-download"
  | "file-diff"
  | "history"
  | "arrow-left-right"
  | "box"
  | "square-function"
  | "variable"
  | "hash"
  | "arrow-left"
  | "arrow-right"
  | "rotate-cw"
  | "external-link"
  | "app-window"
  | "blocks"
  | "shield"
  | "clock"
  | "calendar"
  | "star"
  | "tag"
  | "bookmark"
  | "zap"
  | "terminal"
  | "square-dashed-mouse-pointer"
  | "window-restore"
  | "panel-inner-right"
  | "panel-inner-right-on"
  | "file-archive"
  | "notebook"
  | "notebook-cells"
  | "file-type"
  | "file-audio"
  | "file-video"
  | "file-spreadsheet"
  | ThemedIconName;

/**
 * A file or folder icon from the active file icon theme (D132): "fi:file:<name>",
 * "fi:folder:<name>", "fi:folder-open:<name>", "fi:root:<name>", "fi:root-open:<name>".
 * `icon()` renders these through the theme (the IDE's own glyphs by default).
 */
export type ThemedIconName =
  `fi:${"file" | "folder" | "folder-open" | "root" | "root-open"}:${string}`;

export type ThemedIconKind = "file" | "folder" | "folder-open" | "root" | "root-open";

export const folderIcon = (name: string, expanded: boolean, root = false): ThemedIconName =>
  `fi:${root ? (expanded ? "root-open" : "root") : expanded ? "folder-open" : "folder"}:${name}`;

/** Renders themed icons; the workbench installs the active theme's (workbench/fileIcons.ts). */
type ThemedRenderer = (kind: ThemedIconKind, name: string) => SVGSVGElement;
let themedRenderer: ThemedRenderer | null = null;
let themedInfo = { minimal: true, hidesExplorerArrows: false };
/** Bumped when the file icon theme changes: views showing themed icons re-render. */
export const themedIconsVersion = signal(0);

export function setThemedIconRenderer(
  render: ThemedRenderer | null,
  info: { minimal: boolean; hidesExplorerArrows: boolean },
): void {
  themedRenderer = render;
  themedInfo = info;
  themedIconsVersion.value = themedIconsVersion.peek() + 1;
}

/** The active file icon theme: the IDE's minimal set, and whether it hides tree arrows. */
export const fileIconThemeInfo = (): { minimal: boolean; hidesExplorerArrows: boolean } =>
  themedInfo;

/** The IDE's own glyph for a themed name (the minimal theme): a tinted file icon or a folder. */
export function minimalThemedIcon(kind: ThemedIconKind, name: string): SVGSVGElement {
  if (kind === "file") {
    const svg = icon(minimalFileIcon(name));
    svg.style.color = `var(--file-icon-${fileIconTint(name)})`;
    return svg;
  }
  return icon(kind.endsWith("open") ? "folder-open" : "folder");
}

const SVG_NS = "http://www.w3.org/2000/svg";
const injected = new WeakSet<Document>();

/** Adds the sprite to a document (idempotent per document: the main one, auxiliary windows). */
export function installIconSprite(doc: Document = document): void {
  if (injected.has(doc)) return;
  injected.add(doc);
  const holder = doc.createElement("div");
  holder.hidden = true;
  holder.setAttribute("aria-hidden", "true");
  holder.innerHTML = sprite; // bundled at build time from our own file, not user content
  doc.body.prepend(holder);
}

/**
 * An image (an extension's own icon file, D260) drawn as a mask in the icon color, as VS Code
 * draws view container icons: it follows the theme and the hover / active colors.
 */
export function imageIcon(url: string): HTMLElement {
  const image = document.createElement("span");
  image.className = "icon icon-image";
  image.setAttribute("aria-hidden", "true");
  image.style.setProperty("--icon-image", `url("${url}")`);
  return image;
}

/**
 * The product icon theme's glyph for one of the IDE's icons (D267, workbench/productIcons.ts),
 * or null: the IDE's own. Unset: always the IDE's.
 */
type ProductRenderer = (name: string) => SVGSVGElement | null;
let productRenderer: ProductRenderer | null = null;

export function setProductIconRenderer(render: ProductRenderer | null): void {
  productRenderer = render;
}

/** `<svg class="icon"><use href="#i-name"/></svg>`. Decorative unless a label is given. */
export function icon(name: IconName, label?: string): SVGSVGElement {
  if (name.startsWith("fi:")) {
    const rest = name.slice(3);
    const kind = rest.slice(0, rest.indexOf(":")) as ThemedIconKind;
    const file = rest.slice(rest.indexOf(":") + 1);
    const svg = (themedRenderer ?? minimalThemedIcon)(kind, file);
    svg.dataset.themedIcon = name;
    if (label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
    }
    return svg;
  }
  // A product icon theme's glyph (D267), or the IDE's sprite.
  const svg = productRenderer?.(name) ?? document.createElementNS(SVG_NS, "svg");
  svg.classList.add("icon", `icon-${name}`);
  // Swapped when the product icon theme changes.
  svg.dataset.icon = name;
  if (svg.firstChild) {
    if (label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
    } else svg.setAttribute("aria-hidden", "true");
    return svg;
  }
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

/** A file's icon from the active file icon theme (the IDE's own small set by default). */
export const fileIcon = (name: string): ThemedIconName => `fi:file:${name}`;

/** The IDE's own small file-type icon set (the "Minimal" file icon theme). */
export function minimalFileIcon(name: string): IconName {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".")) : "";
  if ([".json", ".jsonc", ".lock"].includes(ext)) return "file-json";
  if ([".md", ".markdown", ".txt", ".rst"].includes(ext) || lower === "license") return "file-text";
  if ([".sh", ".bash", ".zsh", ".ps1", ".bat", ".cmd"].includes(ext)) return "file-terminal";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".icns"].includes(ext))
    return "image";
  // D120: the files the newer viewers open.
  if (
    [
      ".zip",
      ".jar",
      ".war",
      ".vsix",
      ".whl",
      ".nupkg",
      ".epub",
      ".apk",
      ".tar",
      ".gz",
      ".tgz",
      ".7z",
      ".rar",
    ].includes(ext)
  )
    return "file-archive";
  if (ext === ".ipynb") return "notebook-cells";
  if ([".ttf", ".otf", ".woff", ".woff2"].includes(ext)) return "file-type";
  if ([".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".opus"].includes(ext))
    return "file-audio";
  if ([".mp4", ".webm", ".ogv", ".mov", ".m4v"].includes(ext)) return "file-video";
  if ([".csv", ".tsv", ".xlsx", ".xls"].includes(ext)) return "file-spreadsheet";
  const code = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".rs",
    ".go",
    ".py",
    ".java",
    ".kt",
    ".c",
    ".h",
  ];
  const more = [
    ".cpp",
    ".hpp",
    ".cs",
    ".swift",
    ".rb",
    ".php",
    ".lua",
    ".zig",
    ".html",
    ".css",
    ".scss",
  ];
  const config = [".vue", ".svelte", ".toml", ".yaml", ".yml", ".xml", ".sql", ".graphql"];
  if (code.includes(ext) || more.includes(ext) || config.includes(ext)) return "file-code";
  return "file";
}

/**
 * An icon name the sprite has; a VS Code codicon an extension names maps to the IDE's icon for
 * it (D284: `circle-slash` → "ban"); anything else falls back (D176).
 */
export function knownIcon(name: string | undefined, fallback: IconName = "circle-dot"): IconName {
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) return fallback;
  if (document.getElementById(`i-${name}`)) return name as IconName;
  const mapped = iconForCodiconName(name);
  return mapped && document.getElementById(`i-${mapped}`) ? (mapped as IconName) : fallback;
}
