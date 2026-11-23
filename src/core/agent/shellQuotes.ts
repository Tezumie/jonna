// Quotes in a command line, as far as a check on the line may trust them. The command checks
// (the allowlist, the denylist, agent.autoApprove's command patterns) look for `&`, redirects,
// groups and newlines outside quotes with one regular expression that pairs '…' and "…" from left
// to right. A shell agrees with that pairing only for plain quotes: bash's `\"` and `\'` are
// characters, not quotes (`npm test \" & rm -rf ~ \"` runs rm), and PowerShell reads typographic
// quotes as quotes (a newline between them is inside a string to it, a second command to the
// checks, or the other way round). Such a line is read with nothing taken as quoted. DOM-free.

/** ‘ ’ ‚ ‛ (PowerShell's single quotes) and “ ” „ ‟ (its double quotes). */
const TYPOGRAPHIC_QUOTES = /[‘-‟]/;

const QUOTED = /'[^']*'|"[^"]*"/g;

/** Whether the line has quote characters only PowerShell reads as quotes. */
export function hasTypographicQuotes(line: string): boolean {
  return TYPOGRAPHIC_QUOTES.test(line);
}

/**
 * Whether the line's quoting can't be told without knowing the shell: an escaped quote, a
 * typographic quote, or a quote left open. Never allowed by a pattern; the denylist reads it whole.
 */
export function quotesUnclear(line: string): boolean {
  if (/\\["']/.test(line) || hasTypographicQuotes(line)) return true;
  return /["']/.test(line.replace(QUOTED, ""));
}

/**
 * The line with what is quoted taken out (`''` in its place); `singleOnly` keeps "…" (bash and
 * PowerShell still run `$(…)` inside it). The whole line when its quoting is unclear.
 */
export function outsideQuotes(line: string, singleOnly = false): string {
  if (quotesUnclear(line)) return line;
  return line.replace(QUOTED, (quoted) => (singleOnly && quoted.startsWith('"') ? quoted : "''"));
}
