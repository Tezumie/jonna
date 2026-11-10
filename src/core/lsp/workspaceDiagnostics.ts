// Workspace pull diagnostics (D204, `workspace/diagnostic`): the server reports problems for every
// file of the project, open or not, as full reports (with a result id) or "unchanged" (the one we
// sent as previous still holds). This keeps the latest per file and the result ids to send next
// time; partial results (streamed through $/progress) go through the same `apply`. DOM-free and
// tested.
import { METHOD_NOT_FOUND, RpcError } from "./jsonrpc";
import type { Diagnostic } from "./types";

/** After a workspace pull answers, the next one goes out this long after (VS Code's 2 s). */
export const WORKSPACE_REPULL_MS = 2000;
/** Failed pulls back off up to this. */
export const WORKSPACE_REPULL_MAX_MS = 60_000;

/**
 * When the next workspace pull goes out on its own (D218: VS Code's client pulls the workspace
 * again a moment after each answer, besides edits and refresh requests; a server may also hold
 * the request open until something changes). `failures`: failed pulls in a row so far, this one
 * included. Null: no more timed pulls — the server doesn't answer `workspace/diagnostic` (method
 * not found) or the request was cancelled (stopped; changes and refreshes still pull).
 */
export function nextWorkspacePull(outcome: WorkspacePullOutcome, failures: number): number | null {
  if (outcome === "ok") return WORKSPACE_REPULL_MS;
  if (outcome !== "failed") return null;
  return Math.min(WORKSPACE_REPULL_MS * 2 ** Math.max(0, failures), WORKSPACE_REPULL_MAX_MS);
}

export type WorkspacePullOutcome = "ok" | "failed" | "unsupported" | "cancelled";

const CONTENT_MODIFIED = -32801;
const SERVER_CANCELLED = -32802;

/** What a failed workspace pull means for the timed ones (LSP's error codes). */
export function workspacePullOutcome(err: unknown, cancelledByUs: boolean): WorkspacePullOutcome {
  if (cancelledByUs) return "cancelled";
  const code = err instanceof RpcError ? err.code : undefined;
  if (code === METHOD_NOT_FOUND) return "unsupported";
  // ContentModified, or ServerCancelled asking to be asked again (its default): pull again.
  if (code === CONTENT_MODIFIED) return "ok";
  if (code === SERVER_CANCELLED) {
    const data = (err as RpcError).data as { retriggerRequest?: boolean } | undefined;
    return data?.retriggerRequest === false ? "cancelled" : "ok";
  }
  return "failed";
}

export interface WorkspaceFullReport {
  kind: "full";
  uri: string;
  version?: number | null;
  resultId?: string;
  items: Diagnostic[];
}

export interface WorkspaceUnchangedReport {
  kind: "unchanged";
  uri: string;
  version?: number | null;
  resultId: string;
}

export type WorkspaceDocumentReport = WorkspaceFullReport | WorkspaceUnchangedReport;

export class WorkspaceDiagnostics {
  private readonly byUri = new Map<string, { resultId?: string; items: Diagnostic[] }>();

  /** Takes reports in (a final answer or a partial result); returns the uris whose items changed. */
  apply(reports: readonly WorkspaceDocumentReport[] | undefined): string[] {
    const changed: string[] = [];
    for (const report of reports ?? []) {
      if (!report || typeof report.uri !== "string") continue;
      if (report.kind === "unchanged") {
        const known = this.byUri.get(report.uri);
        // Unchanged against a result id we no longer hold: keep what we have.
        if (known) known.resultId = report.resultId;
        continue;
      }
      if (report.kind !== "full") continue;
      const items = Array.isArray(report.items) ? report.items : [];
      const before = this.byUri.get(report.uri);
      // A clean file with no result id has nothing to keep: a big repository's thousands of
      // clean files don't stay in memory (or get sent back) for nothing.
      if (!items.length && report.resultId === undefined) this.byUri.delete(report.uri);
      else
        this.byUri.set(report.uri, {
          ...(report.resultId !== undefined && { resultId: report.resultId }),
          items,
        });
      if (JSON.stringify(before?.items ?? []) !== JSON.stringify(items)) changed.push(report.uri);
    }
    return changed;
  }

  /** `previousResultIds` for the next request. */
  previousResultIds(): { uri: string; value: string }[] {
    const out: { uri: string; value: string }[] = [];
    for (const [uri, entry] of this.byUri)
      if (entry.resultId !== undefined) out.push({ uri, value: entry.resultId });
    return out;
  }

  items(uri: string): readonly Diagnostic[] {
    return this.byUri.get(uri)?.items ?? [];
  }

  uris(): string[] {
    return [...this.byUri.keys()];
  }

  /** Forgets everything (the server restarted); returns the uris that had items. */
  clear(): string[] {
    const had = [...this.byUri].filter(([, e]) => e.items.length).map(([uri]) => uri);
    this.byUri.clear();
    return had;
  }
}
