// Redaction for the problem report and the session log (D204). Text: API keys and tokens,
// `key=value` secrets, passwords in URLs, the home folder (`~`) and other users' folder names
// (`<user>`). Values (an `ide://` state dump): secrets by key name, file contents (text-like keys
// and any long string) replaced by their size. The Rust log has the same text rules
// (src-tauri/src/diagnostics/redact.rs). DOM-free.

const KNOWN_KEYS =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,})/g;
const BEARER = /\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// The name's parts around the keyword (and a URL's scheme below) are bounded: unbounded, a long
// run of letters (a base64 blob in a log line) took quadratic to cubic time (a frozen report).
const PAIRS =
  /([A-Za-z0-9_.-]{0,64}(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd|pwd|authorization|cookie|credential|signature)[A-Za-z0-9_.-]{0,64})("?'?\s*[:=]\s*"?'?)([^\s"',;&<>]{6,})/gi;
const URL_CREDENTIALS = /([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)[^/\s:@]+:[^/\s@]+@/g;
/** A JSON web token anywhere (an error that echoes a request), and PEM private keys. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const PEM_KEY =
  /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const WINDOWS_USER = /\b([A-Z]:[\\/]+Users[\\/]+)[^\\/\s'"`]+/gi;
const UNIX_USER = /(\/(?:home|Users)\/)[^/\s'"`]+/g;

/** Keys whose values are secrets, whatever they hold. */
const SECRET_KEY =
  /(api[-_]?key|apikey|token|secret|password|passwd|credential|cookie|authorization|private[-_]?key|access[-_]?key|bearer)/i;
/** Keys whose values are file or document contents (what the user wrote, not the IDE's state). */
const CONTENT_KEY =
  /^(text|content|contents|body|source|code|selection|selectedText|selectionText|preview|snippet|output|lines|diff|patch|markdown|prompt|html|clipboard|transcript|messages)$/i;
/** Longer strings are taken for contents too. */
const LONG_STRING = 400;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Redacts one text; `home` (the user's home folder) becomes `~`. */
export function redactText(text: string, home?: string | null): string {
  let out = text;
  if (home && home.length > 3) {
    for (const form of new Set([home, home.replace(/\\/g, "/")]))
      out = out.replace(new RegExp(escapeRegExp(form), "gi"), "~");
  }
  return out
    .replace(PEM_KEY, "-----BEGIN $1----- <redacted>")
    .replace(JWT, "<redacted>")
    .replace(KNOWN_KEYS, "<redacted>")
    .replace(BEARER, "$1 <redacted>")
    .replace(PAIRS, "$1$2<redacted>")
    .replace(URL_CREDENTIALS, "$1<redacted>@")
    .replace(WINDOWS_USER, "$1<user>")
    .replace(UNIX_USER, "$1<user>");
}

export interface RedactOptions {
  home?: string | null;
  /** Strings longer than this are replaced by their size (default 400). */
  longString?: number;
}

/** A JSON-like value with secrets and contents taken out (a copy; the input is untouched). */
export function redactValue(value: unknown, options: RedactOptions = {}): unknown {
  const long = options.longString ?? LONG_STRING;
  const walk = (v: unknown, key: string | null, depth: number): unknown => {
    if (key !== null && SECRET_KEY.test(key) && v !== null && v !== false && v !== "")
      return typeof v === "boolean" || typeof v === "number" ? v : "<redacted>";
    if (key !== null && CONTENT_KEY.test(key)) {
      if (typeof v === "string") return `<${v.length} characters>`;
      if (Array.isArray(v)) return `<${v.length} items>`;
      if (v && typeof v === "object") return "<contents>";
    }
    if (typeof v === "string")
      return v.length > long ? `<long text, ${v.length} characters>` : redactText(v, options.home);
    if (v === null || typeof v !== "object") return v;
    if (depth > 8) return "<…>";
    if (Array.isArray(v)) {
      const items = v.slice(0, 50).map((x) => walk(x, null, depth + 1));
      if (v.length > 50) items.push(`<${v.length - 50} more>`);
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>))
      out[redactText(k, options.home)] = walk(x, k, depth + 1);
    return out;
  };
  return walk(value, null, 0);
}
