// File-type tint for file icons (DESIGN.md §9: `--file-icon-*`). Returns the token suffix, so
// callers write `color: var(--file-icon-<tint>)`. DOM-free.

// biome-ignore format: a compact table is easier to scan
const BY_EXT: Record<string, string> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".json": "json", ".jsonc": "json", ".lock": "json",
  ".html": "markup", ".htm": "markup", ".xml": "markup", ".vue": "markup", ".svelte": "markup",
  ".css": "style", ".scss": "style", ".sass": "style", ".less": "style",
  ".md": "md", ".markdown": "md", ".txt": "md", ".rst": "md",
  ".rs": "rust", ".py": "python", ".go": "go", ".ipynb": "notebook",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".fish": "shell", ".ps1": "shell",
  ".bat": "shell", ".cmd": "shell",
  ".toml": "config", ".yaml": "config", ".yml": "config", ".ini": "config", ".env": "config",
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".svg": "image",
  ".webp": "image", ".ico": "image", ".icns": "image",
};

const BY_NAME: Record<string, string> = {
  dockerfile: "config",
  makefile: "config",
  ".gitignore": "config",
  ".editorconfig": "config",
  license: "md",
};

export function fileIconTint(name: string): string {
  const lower = name.toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return byName;
  const dot = lower.lastIndexOf(".");
  return (dot >= 0 && BY_EXT[lower.slice(dot)]) || "default";
}
