// Regenerates src/ui/icons/sprite.svg from Lucide (ISC, dev dependency `lucide-static`).
// Only the icons listed here are included ("icon sprite with only the icons used").
// Usage: node scripts/build-icons.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// biome-ignore format: a compact list is easier to scan
export const ICONS = [
  "plug", "sliders-horizontal", "library", "files", "file", "file-code", "file-json", "file-text", "file-terminal", "image",
  "folder", "folder-open", "chevron-right", "chevron-down",
  "square-terminal", "bot", "x", "minus", "square", "copy",
  "refresh-cw", "file-plus", "folder-plus", "list-collapse",
  "panel-left", "panel-bottom", "panel-right", "plus", "trash-2", "pencil", "circle-alert",
  "columns-2", "rows-2", "maximize-2", "minimize-2", "menu", "search", "settings", "sun", "moon",
  "ellipsis", "globe", "circle-check", "info", "triangle-alert", "check", "layout-dashboard",
  "rotate-ccw", "braces", "keyboard", "case-sensitive", "whole-word", "regex", "replace",
  "replace-all", "list-tree", "circle-x", "radio", "circle-dot", "list-filter",
  "git-branch", "git-commit-horizontal", "git-compare", "git-merge", "undo-2", "arrow-up",
  "arrow-down", "cloud-upload", "cloud-download", "cloud", "target", "flask-conical", "circle-minus", "file-diff", "history", "arrow-left-right",
  "ban", "eye", "book-open", "zoom-in", "zoom-out", "scan", "code", "list-x", "refresh-ccw",
  "box", "square-function", "variable", "hash", "chart-column", "message-circle-question",
  "arrow-left", "arrow-right", "rotate-cw", "external-link", "app-window",
  "panel-top", "camera", "radio-tower", "bell", "bell-dot", "picture-in-picture-2",
  "monitor-smartphone", "blocks", "bookmark", "calendar", "clock", "shield", "star", "tag", "zap",
  "terminal", "square-dashed-mouse-pointer", "file-archive", "notebook", "file-type",
  "file-audio", "file-video", "file-spreadsheet", "pin", "pin-off",
  "paperclip", "at-sign", "brain", "file-up", "arrow-down-a-z",
  "case-upper", "git-pull-request", "git-fork", "folder-git-2", "grip-vertical",
  "list-chevrons-up-down", "key-round", "git-graph", "circle-user-round", "log-out", "log-in",
  "play", "pause", "bug-play", "redo-dot", "arrow-down-to-dot", "arrow-up-from-dot",
  "file-input", "folder-search", "locate", "scissors", "clipboard-paste", "clipboard-copy", "link", "copy-plus", "arrow-right-to-line", "check-check", "folder-x", "save", "save-all", "file-output", "redo-2", "wand-sparkles", "text-cursor-input", "palette", "archive", "eye-off", "download", "upload",
  "archive-restore", "text-select", "file-search", "hammer", "scroll-text", "message-square-code",
  "lightbulb", "file-symlink",
  "cpu", "circle-dashed", "sparkles", "puzzle", "arrow-up-right", "mic",
  "users", "list-checks", "rows-3", "server", "file-down", "layers", "text-wrap",
  "messages-square", "kanban", "list-todo", "list",
  "text-search", "message-square", "message-square-plus", "user-pen", "badge-check",
  "lock", "lock-open", "clipboard-clock",
  // The composer's Send (D385). It was in Icon.ts's names but not here, so the button drew
  // nothing; src/ui/iconNames.test.ts checks the names against the sprite now (D420).
  "corner-down-left",
];

// Our own glyphs (not Lucide): layout-region toggles in their "on" form (filled region), drawn
// on the same 24-unit grid as the Lucide outline versions so on/off swap without shifting.
const CUSTOM = {
  // The agent (D122, D123): a four-pointed star with concave sides — the common "AI" mark —
  // drawn on its own (Lucide's sparkle has a different curve).
  agent:
    '<path d="M12 2.5Q12.95 11.05 21.5 12 12.95 12.95 12 21.5 11.05 12.95 2.5 12 11.05 11.05 12 2.5Z" stroke-width="1.75" />',
  // Window "restore" as Windows draws it: the back window up and to the right (Lucide's "copy"
  // mirrored).
  "window-restore":
    '<rect width="14" height="14" x="2" y="8" rx="2" ry="2" /><path d="M20 16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2H10c-1.1 0-2 .9-2 2" />',
  // A notebook (D203): a page of cells, the first one run (our own drawing, for .ipynb files and
  // other notebook types).
  "notebook-cells":
    '<rect width="16" height="20" x="4" y="2" rx="2" /><rect width="8" height="5" x="9" y="6" rx="1" /><rect width="8" height="5" x="9" y="13" rx="1" /><path d="M6.5 8.5h.01" /><path d="M6.5 15.5h.01" />',
  // The terminal's split (D217): Lucide's square-terminal with a second pane on its right, so it
  // isn't mistaken for the editor's split (columns-2). Used by the terminal's split action only.
  "terminal-split":
    '<rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><path d="M15 3v18" /><path d="m6 9.5 2.5 2.5L6 14.5" /><path d="M10.5 14.5h1.5" />',
  "panel-left-on":
    '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M5 5h4v14H5z" fill="currentColor" stroke="none" />',
  "panel-bottom-on":
    '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M5 15h14v4H5z" fill="currentColor" stroke="none" />',
  "panel-right-on":
    '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 5h4v14h-4z" fill="currentColor" stroke="none" />',
  // The right region when the sidebar is on the right (D119): a column next to the right edge's.
  "panel-inner-right":
    '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M11 3v18" /><path d="M16 3v18" />',
  "panel-inner-right-on":
    '<rect width="18" height="18" x="3" y="3" rx="2" /><path d="M16 3v18" /><path d="M11 5h4v14h-4z" fill="currentColor" stroke="none" />',
};

const pkg = JSON.parse(
  await readFile(join(root, "node_modules/lucide-static/package.json"), "utf8"),
);
const symbols = [];
for (const name of ICONS) {
  const svg = await readFile(join(root, "node_modules/lucide-static/icons", `${name}.svg`), "utf8");
  const inner = svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/\s*\n\s*/g, "")
    .trim();
  symbols.push(`<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`);
}
for (const [name, inner] of Object.entries(CUSTOM)) {
  symbols.push(`<symbol id="i-${name}" viewBox="0 0 24 24">${inner}</symbol>`);
}
const sprite =
  `<!-- Icons from Lucide v${pkg.version} (ISC License, https://lucide.dev/license), plus panel-*-on and window-restore (in-repo). Generated by scripts/build-icons.mjs. -->\n` +
  `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">\n` +
  `${symbols.join("\n")}\n</svg>\n`;
await writeFile(join(root, "src/ui/icons/sprite.svg"), sprite);
console.log(`sprite.svg: ${symbols.length} icons, ${sprite.length} bytes`);
