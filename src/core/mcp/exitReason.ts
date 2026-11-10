// Why a local MCP server's process ended, from what it printed to stderr (D345): the line that
// says what went wrong, not the last lines, which for a Node crash are "}", a blank line and
// "Node.js v24…". DOM-free and tested.

/** Lines that say nothing about the failure (stack frames, braces, runtime banners). */
const NOISE = [
  /^\s*$/,
  /^\s*[{}[\](),;]+\s*$/,
  /^\s*at\s/,
  /^Node\.js v\d/,
  /^\s*\^+\s*$/,
  /^\s*code: '/,
  /^\s*requireStack:/,
  /^Traceback \(most recent call last\):$/,
  /^\s+File "/,
];

/** The most telling line: an error's own line if there is one, else the last meaningful one. */
export function exitReason(stderr: readonly string[]): string {
  const lines = stderr.map((l) => l.trimEnd()).filter((l) => !NOISE.some((re) => re.test(l)));
  const error = lines.findLast((l) =>
    /\b(Error|Exception|error:|ENOENT|EACCES|not found|No such file|cannot find)/i.test(l),
  );
  const line = error ?? lines[lines.length - 1];
  return line ? line.trim().slice(0, 300) : "";
}
