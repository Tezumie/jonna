// How local-history versions are labeled (index.ts, the Timeline).

const SOURCE_LABELS: Record<string, string> = {
  original: "Before first change",
  external: "Changed outside the app",
  save: "Saved",
  agent: "Agent edit",
  "agent revert": "Agent revert",
  replace: "Replace all",
  "before replace": "Before replace all",
  restore: "Restored",
  git: "Git revert",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/** "just now", "5 min ago", "3 h ago", else the date. */
export function ago(timestamp: number, now = Date.now()): string {
  const s = Math.round((now - timestamp) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(timestamp).toLocaleString();
}
