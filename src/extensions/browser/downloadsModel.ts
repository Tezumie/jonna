// The downloads list (DOM-free, tested): what the Rust side reported (`downloads.rs`), newest
// first, and the words the view, the status bar and agents show for it.
import type { Download } from "../../core/ipc/browser";

export type { Download };

/** Newest first; a report replaces the one with the same id. */
export function applyDownload(list: readonly Download[], next: Download): Download[] {
  const others = list.filter((d) => d.id !== next.id);
  return [next, ...others].sort((a, b) => b.id - a.id);
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} kB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 0–1 while the size is known, else null (an indeterminate bar). */
export function fraction(d: Download): number | null {
  if (d.state === "done") return 1;
  if (!d.total || d.total <= 0) return null;
  return Math.max(0, Math.min(1, d.received / d.total));
}

/** "1.2 MB of 4.0 MB", "Done, 4.0 MB", "Cancelled"… */
export function describe(d: Download): string {
  switch (d.state) {
    case "progress":
      if (d.total) return `${formatSize(d.received)} of ${formatSize(d.total)}`;
      return d.received ? formatSize(d.received) : "Starting";
    case "done":
      return d.received ? `Done, ${formatSize(d.received)}` : "Done";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return d.error ? `Failed: ${d.error}` : "Failed";
  }
}

/** The status bar's words: nothing without downloads this session, else the running ones. */
export function statusText(list: readonly Download[]): { text: string; tooltip: string } | null {
  if (!list.length) return null;
  const running = list.filter((d) => d.state === "progress");
  if (!running.length)
    return {
      text: "$(download)",
      tooltip: `${list.length} download${list.length === 1 ? "" : "s"}: show the list`,
    };
  const known = running.filter((d) => d.total);
  const total = known.reduce((n, d) => n + (d.total ?? 0), 0);
  const received = known.reduce((n, d) => n + d.received, 0);
  const percent =
    known.length === running.length && total > 0 ? Math.floor((received / total) * 100) : null;
  const count = running.length === 1 ? "" : ` ${running.length}`;
  return {
    text: `$(download)${count}${percent === null ? "" : ` ${percent}%`}`,
    tooltip: `Downloading ${running.map((d) => d.fileName).join(", ")}`,
  };
}

/** What agents read (`ide://downloads`, `browser.downloads`). */
export function summary(d: Download): Record<string, unknown> {
  return {
    id: d.id,
    file: d.fileName,
    url: d.url,
    state: d.state,
    progress: describe(d),
    ...(d.path && { path: d.path }),
    canCancel: d.canCancel && d.state === "progress",
  };
}
