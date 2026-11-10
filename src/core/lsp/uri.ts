// file:// URIs ↔ OS paths for LSP (RFC 8089, the form VS Code sends). DOM-free.
// Windows: "C:\\a b\\x.ts" ↔ "file:///c%3A/a%20b/x.ts" (drive lowercased and colon encoded, as
// VS Code does; servers also accept "file:///C:/…" and we parse both). UNC: "\\\\srv\\share\\x" ↔
// "file://srv/share/x".

const KEEP = /[A-Za-z0-9\-._~!$&'()*+,;=@/]/;

function encodePath(path: string): string {
  let out = "";
  for (const ch of path) {
    if (KEEP.test(ch)) out += ch;
    else
      for (const b of new TextEncoder().encode(ch))
        out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export function pathToUri(path: string): string {
  if (path.startsWith("\\\\")) {
    const [host = "", ...rest] = path.slice(2).split(/[\\/]/);
    return `file://${host}/${encodePath(rest.join("/"))}`;
  }
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(path);
  if (drive) {
    const letter = (drive[1] as string).toLowerCase();
    return `file:///${letter}%3A/${encodePath((drive[2] as string).replaceAll("\\", "/"))}`;
  }
  return `file://${encodePath(path)}`;
}

/** The OS path of a file URI, or null for other schemes. */
export function uriToPath(uri: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(uri);
  if (!m) return null;
  const host = m[1] ?? "";
  const path = decodeURIComponent(m[2] ?? "/");
  if (host && host !== "localhost") return `\\\\${host}${path.replaceAll("/", "\\")}`;
  const drive = /^\/([A-Za-z]):(\/.*)?$/.exec(path);
  if (drive)
    return `${(drive[1] as string).toUpperCase()}:${(drive[2] ?? "\\").replaceAll("/", "\\")}`;
  return path;
}
