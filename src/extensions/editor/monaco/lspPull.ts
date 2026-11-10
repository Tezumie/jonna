// Language-server features that keep state between requests (D204): semantic tokens with deltas
// (`full/delta`, applied to the tokens kept per document) and ranges (`range`, the visible part
// while the full tokens are on their way in a large file), and workspace pull diagnostics
// (`workspace/diagnostic` with result ids and partial results), shown in Problems for files that
// aren't open. Both are re-fetched when the server asks (…/refresh).

import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IMarkerService } from "monaco-editor/platform/markers/common/markers.js";
import { Emitter } from "../../../core/events/index";
import type { LanguageClient } from "../../../core/lsp/client";
import { type CancelToken, cancelSource } from "../../../core/lsp/jsonrpc";
import {
  resolveSemanticTokensDelta,
  type SemanticTokensDeltaResult,
} from "../../../core/lsp/semanticTokens";
import type * as lsp from "../../../core/lsp/types";
import { uriToPath } from "../../../core/lsp/uri";
import {
  nextWorkspacePull,
  WorkspaceDiagnostics,
  type WorkspaceDiagnostics as WorkspaceDiagnosticsState,
  type WorkspaceDocumentReport,
  type WorkspacePullOutcome,
  workspacePullOutcome,
} from "../../../core/lsp/workspaceDiagnostics";
import { pathKey } from "../../../core/paths/index";
import * as monaco from "./core";
import { toMarker } from "./lspConvert";

interface PullHelpers {
  ok(model: monaco.editor.ITextModel): boolean;
  doc(model: monaco.editor.ITextModel): { textDocument: { uri: string } };
  token(t: monaco.CancellationToken): CancelToken;
}

/** Semantic tokens: full (with deltas when the server has them) and ranges. */
export function addSemanticTokens(
  client: LanguageClient,
  languages: string[],
  disposables: monaco.IDisposable[],
  h: PullHelpers,
): void {
  const semantic = client.capabilities.semanticTokensProvider;
  if (!semantic) return;
  const legend = semantic.legend;
  // workspace/semanticTokens/refresh: Monaco asks every provider again.
  const changed = new Emitter<void>();
  const refresh = client.onRefresh((kind) => {
    if (kind === "semanticTokens") changed.fire();
  });
  disposables.push({
    dispose: () => {
      refresh.dispose();
      changed.dispose();
    },
  });
  const onDidChange = (listener: () => void): monaco.IDisposable => changed.event(listener);
  const delta = typeof semantic.full === "object" && !!semantic.full.delta;
  // The last tokens per document (by result id), which a delta applies to.
  const kept = new WeakMap<monaco.editor.ITextModel, { resultId: string; data: number[] }>();
  if (semantic.full) {
    disposables.push(
      monaco.languages.registerDocumentSemanticTokensProvider(languages, {
        getLegend: () => legend,
        onDidChange,
        provideDocumentSemanticTokens: async (model, lastResultId, token) => {
          if (!h.ok(model)) return null;
          const previous = kept.get(model);
          let result: { data: number[]; resultId?: string } | null = null;
          if (delta && previous && lastResultId === previous.resultId) {
            const r = await client
              .request<SemanticTokensDeltaResult | null>(
                "textDocument/semanticTokens/full/delta",
                { ...h.doc(model), previousResultId: previous.resultId },
                h.token(token),
              )
              .catch(() => null);
            try {
              result = r ? resolveSemanticTokensDelta(previous.data, r) : null;
            } catch {
              // Edits that don't fit what we kept: ask for the whole set.
              result = null;
            }
          }
          if (!result) {
            const r = await client
              .request<{ data: number[]; resultId?: string } | null>(
                "textDocument/semanticTokens/full",
                h.doc(model),
                h.token(token),
              )
              .catch(() => null);
            result = r
              ? { data: r.data, ...(r.resultId !== undefined && { resultId: r.resultId }) }
              : null;
          }
          if (!result) return null;
          if (result.resultId !== undefined)
            kept.set(model, { resultId: result.resultId, data: result.data });
          else kept.delete(model);
          // Monaco gets full tokens either way; it keeps no copy we'd have to match.
          return { data: new Uint32Array(result.data), resultId: result.resultId };
        },
        releaseDocumentSemanticTokens: () => {},
      }),
    );
  }
  if (semantic.range) {
    // Monaco asks for the visible range while a document's full tokens aren't there yet (a large
    // file), VS Code's way.
    disposables.push(
      monaco.languages.registerDocumentRangeSemanticTokensProvider(languages, {
        getLegend: () => legend,
        provideDocumentRangeSemanticTokens: async (model, range, token) => {
          if (!h.ok(model)) return null;
          const r = await client
            .request<{ data: number[] } | null>(
              "textDocument/semanticTokens/range",
              {
                ...h.doc(model),
                range: {
                  start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
                  end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
                },
              },
              h.token(token),
            )
            .catch(() => null);
          return r ? { data: new Uint32Array(r.data) } : null;
        },
      }),
    );
  }
}

/** How long after a change (save, file event, edit) the workspace is pulled again. */
const WORKSPACE_PULL_DELAY_MS = 1000;

interface MarkerServiceLike {
  changeOne(owner: string, resource: monaco.Uri, markers: monaco.editor.IMarkerData[]): void;
}

/**
 * Sets `owner`'s markers on a file that may have no model (setModelMarkers needs one): a server's
 * problems for a file that isn't open still show in Problems, as in VS Code (D218).
 */
export function setFileMarkers(
  owner: string,
  resource: monaco.Uri,
  markers: monaco.editor.IMarkerData[],
): void {
  (StandaloneServices.get(IMarkerService) as MarkerServiceLike).changeOne(owner, resource, markers);
}

/**
 * Workspace pull diagnostics: the server's problems for every file, set as markers (of their own
 * owner) on files that aren't open in this server; an open file's own pull or push wins. Pulled at
 * start, after changes (debounced), when the server asks, and 2 s after each answer (D218, VS
 * Code's client: problems that change without an edit here, a build's, show up); one request at a
 * time.
 */
export class WorkspacePull implements monaco.IDisposable {
  readonly state: WorkspaceDiagnosticsState = new WorkspaceDiagnostics();
  private readonly owner: string;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private again = false;
  private disposed = false;
  private cancel = cancelSource();
  private readonly subs: { dispose(): void }[] = [];
  /** Uris that have markers from us now. */
  private readonly shown = new Set<string>();

  constructor(private readonly client: LanguageClient) {
    this.owner = `lsp:${client.options.id}:workspace`;
    this.subs.push(
      client.onRefresh((kind) => {
        if (kind === "diagnostics") this.schedule(0);
      }),
    );
    this.schedule(0);
  }

  /** Something changed (a save, a file event, an edit): pull again soon. */
  schedule(delay = WORKSPACE_PULL_DELAY_MS): void {
    if (this.disposed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.pull(), delay);
  }

  private async pull(): Promise<void> {
    if (this.disposed || this.client.state !== "running") return;
    this.running = true;
    this.again = false;
    const caps = this.client.capabilities.diagnosticProvider;
    let outcome: WorkspacePullOutcome = "ok";
    try {
      const result = await this.client.requestWithPartialResults<{
        items?: WorkspaceDocumentReport[];
      } | null>(
        "workspace/diagnostic",
        {
          ...(caps?.identifier && { identifier: caps.identifier }),
          previousResultIds: this.state.previousResultIds(),
        },
        (value) => this.take((value as { items?: WorkspaceDocumentReport[] } | null)?.items),
        { token: this.cancel },
      );
      this.take(result?.items);
      this.failures = 0;
    } catch (err) {
      outcome = workspacePullOutcome(err, this.cancel.cancelled);
      if (outcome === "failed") this.failures++;
    } finally {
      this.running = false;
      if (this.again) this.schedule();
      else this.scheduleRepull(outcome);
    }
  }

  /** Failed pulls in a row (the timed pulls back off). */
  private failures = 0;

  /**
   * The timed pull after an answer (D218, VS Code's client: again 2 s after each answer), which
   * waits while the window is hidden. Changes and refresh requests pull sooner.
   */
  private scheduleRepull(outcome: WorkspacePullOutcome): void {
    const delay = nextWorkspacePull(outcome, this.failures);
    if (delay === null || this.disposed || this.client.state !== "running") return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (typeof document !== "undefined" && document.hidden) this.scheduleRepull(outcome);
      else void this.pull();
    }, delay);
  }

  private take(reports: WorkspaceDocumentReport[] | undefined): void {
    if (this.disposed) return;
    for (const uri of this.state.apply(reports)) this.render(uri);
  }

  /** Sets (or clears) one file's markers: only while the file isn't open in this server. */
  render(uri: string): void {
    const path = uriToPath(uri);
    if (!path) return;
    const resource = monaco.Uri.file(path);
    const items: readonly lsp.Diagnostic[] = this.open.has(pathKey(path))
      ? []
      : this.state.items(uri);
    if (!items.length && !this.shown.has(uri)) return;
    const markers = items.map((d) => toMarker(d, this.client.options.id));
    (StandaloneServices.get(IMarkerService) as MarkerServiceLike).changeOne(
      this.owner,
      resource,
      markers,
    );
    if (markers.length) this.shown.add(uri);
    else this.shown.delete(uri);
  }

  /** Files open in this server (path keys): their own pull or push diagnostics win. */
  private readonly open = new Set<string>();

  /** A file was opened or closed in this server: its own diagnostics take over, or ours come back. */
  openChanged(path: string, isOpen: boolean): void {
    const key = pathKey(path);
    if (isOpen) this.open.add(key);
    else this.open.delete(key);
    // The server's uri for the file may be spelled differently (a drive letter's case).
    for (const uri of this.state.uris()) {
      const p = uriToPath(uri);
      if (p && pathKey(p) === key) this.render(uri);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.cancel.cancel();
    for (const s of this.subs) s.dispose();
    const service = StandaloneServices.get(IMarkerService) as MarkerServiceLike;
    for (const uri of this.shown) {
      const path = uriToPath(uri);
      if (path) service.changeOne(this.owner, monaco.Uri.file(path), []);
    }
    this.shown.clear();
  }
}
