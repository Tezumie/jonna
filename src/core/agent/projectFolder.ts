// Where a new project goes when the agent is asked to build something with no folder open (D121):
// a folder name from the request ("make a snake game" → "snake-game") and, when the request
// names a place ("in C:\dev", "under ~/code/site"), that place. DOM-free.

const STOP = new Set([
  "a",
  "an",
  "the",
  "me",
  "my",
  "our",
  "us",
  "some",
  "simple",
  "basic",
  "small",
  "little",
  "new",
  "quick",
  "nice",
  "cool",
  "please",
  "for",
  "with",
  "that",
  "which",
  "using",
  "in",
  "on",
  "of",
  "to",
  "and",
  "app",
  "project",
  "can",
  "you",
  "i",
  "want",
  "would",
  "like",
  "could",
  "help",
  "build",
  "make",
  "create",
  "write",
  "start",
  "set",
  "up",
  "code",
  "program",
  "just",
]);
const KEEP_SHORT = new Set(["ai", "ui", "api", "cli", "3d", "2d", "io"]);

/** A short kebab-case folder name for what the message asks to build. */
export function suggestFolderName(message: string): string {
  const text = message
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, "")
    .replace(/(?:[a-z]:)?[\\/][^\s]*/gi, " "); // paths aren't part of the name
  // The words after "make / build / create …", else the whole message.
  const m = /\b(?:make|build|create|write|start|scaffold|generate|code|set up)\b\s+(.*)/.exec(text);
  const words = (m?.[1] ?? text)
    .split(/[^a-z0-9+#.]+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w && !STOP.has(w) && (w.length > 2 || KEEP_SHORT.has(w)));
  const name = words
    .slice(0, 3)
    .join("-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
  return name.replace(/^-+|-+$/g, "") || "new-project";
}

/** An absolute folder the message names as the place to work ("in C:\dev\x", "at ~/code"). */
export function pathInMessage(message: string, home: string | null): string | null {
  const m = /(?:^|\s)((?:[a-zA-Z]:[\\/]|~[\\/]|\/)(?:[^\s"'`,;]+))/.exec(message);
  const raw = m?.[1]?.replace(/[.)]+$/, "");
  if (!raw) return null;
  if (raw.startsWith("~")) return home ? `${home}${raw.slice(1)}` : null;
  return raw;
}
