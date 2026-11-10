// An external agent's session modes (D227): ACP's `modes` (Claude Code: default "Manual" /
// acceptEdits / plan / auto / bypassPermissions; Codex: read-only / workspace-write / agent "Auto
// review" / agent-full-access). Agents like these write files
// and run commands themselves, so the IDE's own review only sees a change after it's made; their
// mode decides whether they ask first. The IDE picks the mode that matches its own permission
// settings at the start of each turn. DOM-free.

export interface AcpMode {
  id: string;
  name: string;
}

export interface AcpModes {
  current: string | null;
  available: AcpMode[];
}

/** `modes` in a session/new or session/load answer, or null when the agent has none. */
export function parseModes(r: unknown): AcpModes | null {
  const m = (r as { modes?: unknown } | null)?.modes as
    | { currentModeId?: unknown; availableModes?: unknown }
    | undefined;
  if (!m || !Array.isArray(m.availableModes)) return null;
  const available: AcpMode[] = [];
  for (const raw of m.availableModes) {
    const x = raw as { id?: unknown; name?: unknown };
    if (typeof x?.id === "string")
      available.push({ id: x.id, name: typeof x.name === "string" ? x.name : x.id });
  }
  if (!available.length) return null;
  return { current: typeof m.currentModeId === "string" ? m.currentModeId : null, available };
}

/**
 * How much the IDE lets the agent do without asking: `ask` (edits are reviewed or commands ask),
 * `edits` (edits applied automatically, commands run automatically), `full` (full access).
 */
export type PermissionLevel = "ask" | "edits" | "full";

export function permissionLevel(reviewEdits: boolean, runCommands: string): PermissionLevel {
  if (runCommands === "full") return "full";
  return reviewEdits || runCommands === "ask" ? "ask" : "edits";
}

// Known ids and name words per level, most specific first. A plan or read-only-chat mode is never
// picked for "ask": the agent must still be able to work (it asks before writing).
const LEVELS: Record<PermissionLevel, RegExp[]> = {
  ask: [/^default$/i, /^read-only$/i, /^ask$/i, /\b(default|ask|read[- ]only)\b/i],
  edits: [/^acceptEdits$/i, /^auto$/i, /\b(accept edits|auto)\b/i],
  full: [/^bypassPermissions$/i, /^(agent-)?full-access$/i, /\b(bypass|full access|yolo)\b/i],
};

/** The agent's mode for `level`, or null when none of its modes is one. */
export function findMode(modes: AcpModes | null, level: PermissionLevel): string | null {
  if (!modes) return null;
  // Ids first: a mode named "Default" or "Auto review" mustn't win over one whose id says it.
  for (const key of ["id", "name"] as const)
    for (const pattern of LEVELS[level]) {
      const hit = modes.available.find((m) => pattern.test(m[key]));
      if (hit) return hit.id;
    }
  return null;
}

/** The mode to switch to for `level`, or null to leave the agent's mode as it is. */
/**
 * Whether the agent's mode `id` writes without asking (one of its edits / full modes): an agent
 * that moves itself there mid-turn while the IDE asks is put back (D227).
 */
export function writesWithoutAsking(modes: AcpModes | null, id: string): boolean {
  const mode = modes?.available.find((m) => m.id === id);
  if (!mode || findMode(modes, "ask") === id) return false;
  return (["edits", "full"] as const).some((level) =>
    LEVELS[level].some((p) => p.test(mode.id) || p.test(mode.name)),
  );
}

export function pickMode(modes: AcpModes | null, level: PermissionLevel): string | null {
  const id = findMode(modes, level);
  return id === modes?.current ? null : id;
}
