// VS Code's `workspaceContains:<glob>` activation: what to ask the file index's quick (fuzzy)
// search for first, so a match usually costs one small query; the caller then falls back to the
// folder's whole file list. DOM-free and unit-tested.

/** `a{b,c}d` → ["abd", "acd"] (one level of alternatives at a time, at most 20 results). */
export function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  const close = open < 0 ? -1 : pattern.indexOf("}", open);
  if (open < 0 || close < 0) return [pattern];
  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const out: string[] = [];
  for (const alt of pattern.slice(open + 1, close).split(",")) {
    for (const more of expandBraces(`${head}${alt}${tail}`)) {
      if (out.length >= 20) return out;
      out.push(more);
    }
  }
  return out;
}

/**
 * Words for the index's fuzzy search that files matching `pattern` contain: the last path
 * segment's literal text ("**\/*.ipynb" → ".ipynb", "**\/requirements*.txt" → "requirements.txt"),
 * or, when that segment has none ("**\/.venv/**"), the nearest one before it (".venv"). One per
 * brace alternative; empty when the pattern has no literal text at all ("**").
 */
export function globSearchTerms(pattern: string): string[] {
  const terms = new Set<string>();
  for (const alt of expandBraces(pattern.replace(/\\/g, "/"))) {
    const segments = alt.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const literal = (segments[i] ?? "").replace(/\[[^\]]*\]|[*?{}[\]]/g, "");
      if (literal) {
        terms.add(literal);
        break;
      }
    }
  }
  return [...terms];
}
