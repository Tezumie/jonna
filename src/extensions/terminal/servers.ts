// Servers started in terminals, found in their output like VS Code's port detection: a local URL
// (`http://localhost:5173/`) or "listening on port 3000". The browser offers them; agents see
// them in `ide://terminals`. DOM-free, tested.

export interface DetectedServer {
  /** e.g. "http://localhost:5173/" (0.0.0.0 and [::] become localhost). */
  url: string;
  port: number;
  terminalId: number;
  /** When it was first seen. */
  time: number;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  "g",
);
const LOCAL_URL =
  /\bhttps?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w-]+\.localhost):(\d{2,5})(\/[^\s"'<>`)\]]*)?/gi;
const PORT_PHRASE =
  /\b(?:listening|running|started|serving|available|ready)\b[^\n]{0,40}?\bport\b[\s:=]*(\d{2,5})\b/gi;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Local server URLs in a piece of terminal output (normalized, without duplicates). */
export function findServerUrls(text: string): { url: string; port: number }[] {
  const plain = stripAnsi(text);
  const out = new Map<number, string>();
  for (const m of plain.matchAll(LOCAL_URL)) {
    const port = Number(m[2]);
    if (!port || port > 65535) continue;
    let host = (m[1] ?? "localhost").toLowerCase();
    if (host === "0.0.0.0" || host === "[::]") host = "localhost";
    const path = (m[3] ?? "/").replace(/[.,;:!?]+$/, "") || "/";
    if (!out.has(port))
      out.set(
        port,
        `${m[0].toLowerCase().startsWith("https") ? "https" : "http"}://${host}:${port}${path}`,
      );
  }
  for (const m of plain.matchAll(PORT_PHRASE)) {
    const port = Number(m[1]);
    if (port > 0 && port <= 65535 && !out.has(port)) out.set(port, `http://localhost:${port}/`);
  }
  return [...out].map(([port, url]) => ({ url, port }));
}

/** Per terminal: output since the last scan's tail, so URLs split across chunks are found. */
export class ServerScanner {
  private readonly carry = new Map<number, string>();

  scan(terminalId: number, text: string): { url: string; port: number }[] {
    const joined = (this.carry.get(terminalId) ?? "") + text;
    this.carry.set(terminalId, joined.slice(-300));
    return findServerUrls(joined);
  }

  forget(terminalId: number): void {
    this.carry.delete(terminalId);
  }
}
