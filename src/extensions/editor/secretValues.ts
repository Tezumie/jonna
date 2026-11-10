// Secret values hidden in the editor (`editor.hideSecrets`, off by default as in Zed, whose
// `redact_private_values` it follows; VS Code has no such setting): in files matching
// `editor.secretFiles`, the value of each `KEY=value` / `key: value` line, and every other line of
// content (a key file's body), is covered until the cursor is on its line. Comments, keys, empty
// values and PEM armor lines (`-----BEGIN …-----`) stay readable. DOM-free, tested.

import { globToRegExp } from "../../core/paths/glob";

/** Zed's `private_files` default. */
export const DEFAULT_SECRET_FILES: readonly string[] = [
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "**/*.cert",
  "**/*.crt",
  "**/secrets.yml",
];

/** A covered span: 1-based line, 1-based columns, `endColumn` exclusive (the engine's). */
export interface SecretRange {
  line: number;
  startColumn: number;
  endColumn: number;
}

/** Whether a file is one whose values are hidden (patterns match the path or its file name). */
export function isSecretFile(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  // `**/.env*` is meant for any folder: match the path with a leading slash so a file at the top
  // of the folder (or a relative path with no folder) counts too.
  const rooted = normalized.startsWith("/") ? normalized : `/${normalized}`;
  // Any case (D407): `.ENV` and `server.KEY` are the same files on Windows, and covering one
  // too many is the safe side.
  return (Array.isArray(patterns) ? patterns : DEFAULT_SECRET_FILES).some((p) => {
    const glob = globToRegExp(p);
    const re = new RegExp(glob.source, glob.flags.includes("i") ? glob.flags : `${glob.flags}i`);
    return re.test(normalized) || re.test(rooted) || re.test(rooted.slice(1));
  });
}

const ASSIGNMENT = /^(\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*(?:=|:(?=\s|$))\s*)(.*?)\s*$/;
const COMMENT = /^\s*(?:#|;|\/\/)/;
const ARMOR = /^\s*-----(?:BEGIN|END)[ A-Z0-9]*-----\s*$/;

/** The spans to cover in `text` (any line endings). */
export function secretRanges(text: string): SecretRange[] {
  const out: SecretRange[] = [];
  const lines = text.split(/\r?\n|\r/);
  // A key file's body is base64, whose "=" padding would read as an assignment: all of it.
  const armored = lines.some((l) => ARMOR.test(l));
  for (const [i, line] of lines.entries()) {
    if (!line.trim() || COMMENT.test(line) || ARMOR.test(line)) continue;
    const match = armored ? null : ASSIGNMENT.exec(line);
    // A long "name" with nothing after its "=" is a bare base64 key (a WireGuard key's padding),
    // not an empty setting (D407): all of it is covered below.
    const assignment = match && !match[2] && (match[1] ?? "").trim().length > 20 ? null : match;
    if (assignment) {
      const prefix = assignment[1] ?? "";
      const value = assignment[2] ?? "";
      if (value) {
        out.push({
          line: i + 1,
          startColumn: prefix.length + 1,
          endColumn: prefix.length + value.length + 1,
        });
      }
      continue;
    }
    // Content that isn't an assignment (a key file's base64, a YAML list item): all of it.
    const start = line.length - line.trimStart().length;
    const end = line.trimEnd().length;
    out.push({ line: i + 1, startColumn: start + 1, endColumn: end + 1 });
  }
  return out;
}

/** The ranges minus those on lines a cursor or selection touches (they show their text). */
export function coveredRanges(
  ranges: readonly SecretRange[],
  revealed: readonly { startLine: number; endLine: number }[],
): SecretRange[] {
  return ranges.filter((r) => !revealed.some((s) => r.line >= s.startLine && r.line <= s.endLine));
}
