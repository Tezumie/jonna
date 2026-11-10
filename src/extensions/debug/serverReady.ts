// launch.json `serverReadyAction` (D204), VS Code's: when the debugged program prints that its
// server is up ("listening on port 3000", Vite's "Local: http://localhost:5173/"), open its
// address — in the system browser ("openExternally"), in Chrome or Edge with the debugger attached
// ("debugWithChrome", "debugWithEdge"), or by starting another configuration ("startDebugging").
// `pattern` is a regular expression whose first group is the port or the address; `uriFormat`
// turns it into the address ("%s" → the group). `killOnServerStop` ends the browser session with
// the server's. DOM-free and tested.

export type ServerReadyKind =
  | "openExternally"
  | "debugWithChrome"
  | "debugWithEdge"
  | "startDebugging";

export interface ServerReady {
  pattern: RegExp;
  /** "http://localhost:%s" when the group is a port, else "%s" (VS Code's default). */
  uriFormat: string | null;
  action: ServerReadyKind;
  /** startDebugging: the configuration to start. */
  name?: string;
  /** debugWith*: the browser session's webRoot. */
  webRoot?: string;
  killOnServerStop: boolean;
}

/** VS Code's default pattern. */
export const DEFAULT_PATTERN = "listening on.* (https?://\\S+|[0-9]+)";

export function parseServerReady(raw: unknown): ServerReady | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kinds: ServerReadyKind[] = [
    "openExternally",
    "debugWithChrome",
    "debugWithEdge",
    "startDebugging",
  ];
  const action = kinds.includes(r.action as ServerReadyKind)
    ? (r.action as ServerReadyKind)
    : "openExternally";
  let pattern: RegExp;
  try {
    pattern = new RegExp(
      typeof r.pattern === "string" && r.pattern ? r.pattern : DEFAULT_PATTERN,
      "i",
    );
  } catch {
    return null;
  }
  const name =
    typeof r.name === "string" && r.name
      ? r.name
      : typeof r.config === "object" &&
          r.config &&
          typeof (r.config as { name?: unknown }).name === "string"
        ? (r.config as { name: string }).name
        : undefined;
  return {
    pattern,
    uriFormat: typeof r.uriFormat === "string" && r.uriFormat ? r.uriFormat : null,
    action,
    ...(name ? { name } : {}),
    ...(typeof r.webRoot === "string" && r.webRoot ? { webRoot: r.webRoot } : {}),
    killOnServerStop: r.killOnServerStop === true,
  };
}

/** Terminal escape sequences out, so a colored "Local:" line still matches. */
export function plainText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, "");
}

/** The address once `output` (everything printed so far, or a line) matches; else null. */
export function serverReadyUri(output: string, s: ServerReady): string | null {
  const m = s.pattern.exec(plainText(output));
  if (!m) return null;
  const group = m[1] ?? "";
  const format = s.uriFormat ?? (/^\d+$/.test(group) ? "http://localhost:%s" : "%s");
  if (!format.includes("%s")) return format;
  if (!group) return null;
  return format.replace("%s", group);
}

/**
 * Output is watched line by line, keeping a short tail so a line split across chunks still
 * matches; returns the new tail and the address once found.
 */
export function feedServerReady(
  tail: string,
  chunk: string,
  s: ServerReady,
): { tail: string; uri: string | null } {
  const text = tail + chunk;
  const lines = text.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  for (const line of lines) {
    const uri = serverReadyUri(line, s);
    if (uri) return { tail: "", uri };
  }
  // Only whole lines: "listening on port 30" may be "3000" once the rest arrives.
  return { tail: rest.slice(-2000), uri: null };
}
