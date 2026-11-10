// Where a call or type hierarchy comes from: a language server, or an extension's provider (D255,
// VS Code's CallHierarchyProvider / TypeHierarchyProvider). The hierarchy view, its commands and
// HierarchySession speak LSP's shape (0-based ranges, numeric symbol kinds, file URIs); an
// extension's items are turned into it and back, its own item kept in `data` so it gets back
// exactly what it gave. DOM-free (tests in hierarchySource.test.ts).
import type { LanguageClient } from "../../core/lsp/client";
import {
  type HierarchyItem,
  type HierarchyKind,
  prepareMethod,
  symbolKindNumber,
} from "../../core/lsp/hierarchy";
import type { Range } from "../../core/lsp/types";
import { pathToUri } from "../../core/lsp/uri";
import type { FeatureContext, LanguageFeature, TextRange } from "../../workbench/extensionFeatures";
import type { HierarchyItemEntry } from "../../workbench/extensionProviders";

export interface HierarchySource {
  /** Shown in the tab: the server's id, or the extension's. */
  id: string;
  running(): boolean;
  request<T>(method: string, params: unknown): Promise<T>;
}

export function clientSource(client: LanguageClient): HierarchySource {
  return {
    id: client.options.id,
    running: () => client.state === "running",
    request: <T>(method: string, params: unknown) =>
      client.state === "running"
        ? client.request<T>(method, params)
        : Promise.reject(new Error("The language server stopped.")),
  };
}

/** A 1-based range (columns optional) as LSP's 0-based one. */
export function toLspRange(r: TextRange): Range {
  const startCharacter = (r.startColumn ?? 1) - 1;
  return {
    start: { line: r.startLine - 1, character: startCharacter },
    end: {
      line: (r.endLine ?? r.startLine) - 1,
      character: r.endColumn !== undefined ? r.endColumn - 1 : startCharacter,
    },
  };
}

const KEY = "extensionItem";

export function toLspItem(entry: HierarchyItemEntry): HierarchyItem {
  return {
    name: entry.name,
    kind: symbolKindNumber(entry.kind),
    ...(entry.detail && { detail: entry.detail }),
    uri: pathToUri(entry.path),
    range: toLspRange(entry.range),
    selectionRange: toLspRange(entry.selectionRange),
    data: { [KEY]: entry },
  };
}

/** The extension's own item behind an LSP-shaped one (null for one it didn't give). */
export function fromLspItem(item: unknown): HierarchyItemEntry | null {
  const data = (item as { data?: Record<string, unknown> } | null)?.data;
  const entry = data?.[KEY] as HierarchyItemEntry | undefined;
  return entry && typeof entry.path === "string" ? entry : null;
}

type CallHierarchy = NonNullable<LanguageFeature["callHierarchy"]>;
type TypeHierarchy = NonNullable<LanguageFeature["typeHierarchy"]>;

/**
 * An extension's hierarchy as a source: prepare is asked at `at` (the request's own position is
 * ignored: it's the same one), the children with the item it gave.
 */
export function extensionSource(
  owner: string,
  kind: HierarchyKind,
  provider: CallHierarchy | TypeHierarchy,
  at: FeatureContext,
): HierarchySource {
  const doc = (item: unknown) => {
    const entry = fromLspItem((item as { item?: unknown } | null)?.item);
    if (!entry) throw new Error("Not an item this extension gave.");
    return { path: entry.path, languageId: at.languageId, item: entry };
  };
  const calls = (list: { item: HierarchyItemEntry; fromRanges: TextRange[] }[], key: string) =>
    list.map((c) => ({ [key]: toLspItem(c.item), fromRanges: c.fromRanges.map(toLspRange) }));
  return {
    id: owner,
    running: () => true,
    request: async <T>(method: string, params: unknown): Promise<T> => {
      if (method === prepareMethod(kind)) return (await provider.prepare(at)).map(toLspItem) as T;
      if (kind === "call") {
        const p = provider as CallHierarchy;
        if (method === "callHierarchy/incomingCalls")
          return calls(await p.incoming(doc(params)), "from") as T;
        if (method === "callHierarchy/outgoingCalls")
          return calls(await p.outgoing(doc(params)), "to") as T;
      } else {
        const p = provider as TypeHierarchy;
        if (method === "typeHierarchy/supertypes")
          return (await p.supertypes(doc(params))).map(toLspItem) as T;
        if (method === "typeHierarchy/subtypes")
          return (await p.subtypes(doc(params))).map(toLspItem) as T;
      }
      throw new Error(`${owner} doesn't answer ${method}.`);
    },
  };
}
