// An external agent's plan limits read from its `/status` text (D233). Codex reports them only
// as text there (codex-acp's `_meta.quota` holds token counts, not limits, D223): lines such as
// "5h limit: [████░░░░] 30% used (resets 14:32)" and "Weekly limit: 5% used (resets 09:00 on
// 3 Nov)", in a plain or Markdown (list, bold, table) layout. Lenient on purpose: anything that
// isn't such a line is skipped, and no limits found is null (the format changed, or none shown).
// DOM-free and tested.

export interface PlanLimit {
  /** As the agent names it: "5h", "Weekly"… */
  label: string;
  /** Percent of the limit used (0–100); "70% left" is 30 used. */
  usedPercent: number;
  /** When it resets, as the agent wrote it ("14:32", "in 2h 10m", "09:00 on 3 Nov"). */
  resets?: string;
}

const LIMIT_LINE =
  /(5\s*h(?:our)?|hourly|daily|weekly|monthly|[A-Za-z0-9-]+(?:\s+[A-Za-z0-9-]+)?)\s+(?:usage\s+)?limit\b[*_`|\s]*:?[*_`|\s]*(.*)$/i;
const PERCENT = /(\d{1,3}(?:\.\d+)?)\s*%\s*(used|left|remaining)?/i;
const RESETS = /\bresets?\b\s*(?:at\s+|on\s+)?([^)|\]]+?)\s*(?:\)|\||$)/i;

/** The labels as shown: "5h", "Weekly", with the first letter capitalized. */
function labelOf(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ");
  if (/^5\s*h(our)?$/i.test(t)) return "5h";
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/** The plan limits in a `/status` answer, or null when it shows none. */
export function parsePlanLimits(text: string): PlanLimit[] | null {
  const out: PlanLimit[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // Markdown decoration and box drawing around the line.
    const line = raw.replace(/^[\s>*\-•│|]+/, "").replace(/[│|\s]+$/, "");
    const m = LIMIT_LINE.exec(line);
    if (!m?.[1]) continue;
    // "Context window" isn't a plan limit, nor is a sentence that only mentions a limit.
    if (/context/i.test(m[1])) continue;
    const rest = m[2] ?? "";
    const pct = PERCENT.exec(rest);
    if (!pct?.[1]) continue;
    const value = Number(pct[1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) continue;
    const used = /left|remaining/i.test(pct[2] ?? "") ? 100 - value : value;
    const resets = RESETS.exec(rest)?.[1]?.trim();
    const label = labelOf(m[1]);
    if (out.some((l) => l.label === label)) continue;
    out.push({
      label,
      usedPercent: Math.round(used * 10) / 10,
      ...(resets && { resets }),
    });
  }
  return out.length ? out : null;
}
