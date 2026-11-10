// Settings profiles (D130): the user's settings.json, keybindings.json and snippet files in one
// JSON file, to move them to another machine (VS Code's Export / Import Profile, without the
// cloud). The files travel as text, comments included. API keys aren't in them (Rust keeps
// those apart) and never travel. DOM-free.

export const PROFILE_FORMAT = "ide-settings-profile";

export interface Profile {
  format: typeof PROFILE_FORMAT;
  version: 1;
  /** The app that wrote it (product name) and when. */
  app: string;
  exported: string;
  settings?: string;
  keybindings?: string;
  /** Snippet file name → text (`<user data>/snippets`). */
  snippets?: Record<string, string>;
}

export type ProfilePart = "settings" | "keybindings" | "snippets";

export function buildProfile(
  app: string,
  parts: { settings?: string; keybindings?: string; snippets?: Record<string, string> },
  now = new Date(),
): Profile {
  return {
    format: PROFILE_FORMAT,
    version: 1,
    app,
    exported: now.toISOString(),
    ...(parts.settings?.trim() && { settings: parts.settings }),
    ...(parts.keybindings?.trim() && { keybindings: parts.keybindings }),
    ...(parts.snippets && Object.keys(parts.snippets).length && { snippets: parts.snippets }),
  };
}

const SNIPPET_NAME = /^[\w.-]+\.(json|code-snippets)$/;

/** Reads a profile file; throws a readable error for anything else. Unsafe snippet names are dropped. */
export function parseProfile(text: string): Profile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("That file isn't a settings profile (not JSON).");
  }
  const v = value as Partial<Profile> | null;
  if (!v || typeof v !== "object" || v.format !== PROFILE_FORMAT)
    throw new Error("That file isn't a settings profile.");
  if (v.version !== 1) throw new Error(`Unsupported profile version ${String(v.version)}.`);
  const str = (x: unknown) => (typeof x === "string" ? x : undefined);
  const snippets: Record<string, string> = {};
  if (v.snippets && typeof v.snippets === "object")
    for (const [name, body] of Object.entries(v.snippets))
      if (SNIPPET_NAME.test(name) && !name.startsWith(".") && typeof body === "string")
        snippets[name] = body;
  const settings = str(v.settings);
  const keybindings = str(v.keybindings);
  return {
    format: PROFILE_FORMAT,
    version: 1,
    app: str(v.app) ?? "",
    exported: str(v.exported) ?? "",
    ...(settings !== undefined && { settings }),
    ...(keybindings !== undefined && { keybindings }),
    ...(Object.keys(snippets).length && { snippets }),
  };
}

/** What a profile holds, for the confirmation ("settings, keybindings and 3 snippet files"). */
export function profileSummary(p: Profile): string {
  const parts: string[] = [];
  if (p.settings !== undefined) parts.push("settings");
  if (p.keybindings !== undefined) parts.push("keybindings");
  const n = Object.keys(p.snippets ?? {}).length;
  if (n) parts.push(`${n} snippet file${n === 1 ? "" : "s"}`);
  if (!parts.length) return "nothing";
  return parts.length === 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
