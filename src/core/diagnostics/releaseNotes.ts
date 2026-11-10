// Release notes (D204): the bundled notes file (docs/release-notes.md) split into releases, and
// when "What's new" opens by itself. DOM-free.

export interface ReleaseNote {
  /** "m7.4", the heading's first word. */
  id: string;
  /** The heading after the id ("Jupyter as a built-in extension"). */
  title: string;
  /** The release's Markdown, without its heading. */
  body: string;
}

/** `## <id> — <title>` sections, newest first as in the file; text before the first is skipped. */
export function parseReleaseNotes(markdown: string): ReleaseNote[] {
  const notes: ReleaseNote[] = [];
  let current: ReleaseNote | null = null;
  const lines: string[] = [];
  const close = () => {
    if (current) notes.push({ ...current, body: lines.join("\n").trim() });
    lines.length = 0;
  };
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^##\s+(\S+)(?:\s+[—–-]\s+(.*))?\s*$/.exec(line);
    if (m) {
      close();
      current = { id: m[1] ?? "", title: (m[2] ?? "").trim(), body: "" };
    } else if (current) lines.push(line);
  }
  close();
  return notes;
}

/**
 * Whether to open "What's new" at start: after an update (a different version ran before), when
 * the setting is on. Not on a first start (nothing changed for that user) or in a test run.
 */
export function shouldShowReleaseNotes(
  previous: string | null | undefined,
  current: string,
  enabled: boolean,
): boolean {
  return enabled && !!previous && previous !== current;
}
