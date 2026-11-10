// Call and type hierarchies (LSP 3.16/3.17): the requests for each direction, and the server's
// answers turned into tree nodes (the dock's hierarchy view) and plain data (agents). DOM-free;
// tested. The items are kept as the server sent them: the next level is asked with the item
// itself (its `data` is the server's own).
import type { Range } from "./types";
import { uriToPath } from "./uri";

export type HierarchyKind = "call" | "type";
export type CallDirection = "incoming" | "outgoing";
export type TypeDirection = "supertypes" | "subtypes";
export type HierarchyDirection = CallDirection | TypeDirection;

/** CallHierarchyItem and TypeHierarchyItem have the same shape. */
export interface HierarchyItem {
  name: string;
  kind: number;
  tags?: number[];
  detail?: string;
  uri: string;
  range: Range;
  selectionRange: Range;
  data?: unknown;
}

export interface IncomingCall {
  from: HierarchyItem;
  /** Where `from` makes the calls (in `from`'s file). */
  fromRanges: Range[];
}

export interface OutgoingCall {
  to: HierarchyItem;
  /** Where the calls are made (in the file of the item that was asked about). */
  fromRanges: Range[];
}

export interface HierarchyNode {
  /** Unique in its tree: the parent's id plus this item's place among its siblings. */
  id: string;
  item: HierarchyItem;
  /** The item's file (null for a URI that isn't a file). */
  path: string | null;
  /** The call sites behind this row (calls only): in the caller's file, or the parent's. */
  calls?: { path: string | null; ranges: Range[] };
}

export const DIRECTIONS: Record<HierarchyKind, readonly HierarchyDirection[]> = {
  call: ["incoming", "outgoing"],
  type: ["supertypes", "subtypes"],
};

/** Where a view opens: VS Code shows incoming calls and subtypes first. */
export function defaultDirection(kind: HierarchyKind): HierarchyDirection {
  return kind === "call" ? "incoming" : "subtypes";
}

export function isDirectionOf(kind: HierarchyKind, direction: string): boolean {
  return (DIRECTIONS[kind] as readonly string[]).includes(direction);
}

/** The other direction of the same hierarchy (the view's toggle). */
export function otherDirection(direction: HierarchyDirection): HierarchyDirection {
  switch (direction) {
    case "incoming":
      return "outgoing";
    case "outgoing":
      return "incoming";
    case "supertypes":
      return "subtypes";
    case "subtypes":
      return "supertypes";
  }
}

export function kindOfDirection(direction: HierarchyDirection): HierarchyKind {
  return direction === "incoming" || direction === "outgoing" ? "call" : "type";
}

export function prepareMethod(kind: HierarchyKind): string {
  return kind === "call"
    ? "textDocument/prepareCallHierarchy"
    : "textDocument/prepareTypeHierarchy";
}

export function childrenMethod(direction: HierarchyDirection): string {
  switch (direction) {
    case "incoming":
      return "callHierarchy/incomingCalls";
    case "outgoing":
      return "callHierarchy/outgoingCalls";
    case "supertypes":
      return "typeHierarchy/supertypes";
    case "subtypes":
      return "typeHierarchy/subtypes";
  }
}

/** The server capability that says it answers `kind`. */
export function capabilityOf(
  kind: HierarchyKind,
): "callHierarchyProvider" | "typeHierarchyProvider" {
  return kind === "call" ? "callHierarchyProvider" : "typeHierarchyProvider";
}

/** The rows for prepare's answer (the symbols at the position, usually one). */
export function rootNodes(items: readonly HierarchyItem[] | null | undefined): HierarchyNode[] {
  return (items ?? []).filter(isItem).map((item, i) => ({
    id: `${i}`,
    item,
    path: uriToPath(item.uri),
  }));
}

/**
 * The rows under `parent` for the answer to `childrenMethod(direction)`: callers (with where they
 * call), callees (with where the parent calls them), supertypes or subtypes.
 */
export function childNodes(
  direction: HierarchyDirection,
  parent: HierarchyNode,
  answer: unknown,
): HierarchyNode[] {
  if (!Array.isArray(answer)) return [];
  const out: HierarchyNode[] = [];
  for (const entry of answer as unknown[]) {
    const id = `${parent.id}/${out.length}`;
    if (direction === "incoming") {
      const call = entry as Partial<IncomingCall> | null;
      if (!call || !isItem(call.from)) continue;
      const path = uriToPath(call.from.uri);
      out.push({ id, item: call.from, path, calls: { path, ranges: call.fromRanges ?? [] } });
    } else if (direction === "outgoing") {
      const call = entry as Partial<OutgoingCall> | null;
      if (!call || !isItem(call.to)) continue;
      out.push({
        id,
        item: call.to,
        path: uriToPath(call.to.uri),
        calls: { path: parent.path, ranges: call.fromRanges ?? [] },
      });
    } else if (isItem(entry)) {
      out.push({ id, item: entry, path: uriToPath(entry.uri) });
    }
  }
  return out;
}

function isItem(x: unknown): x is HierarchyItem {
  const i = x as Partial<HierarchyItem> | null;
  return (
    !!i &&
    typeof i.name === "string" &&
    typeof i.uri === "string" &&
    !!i.selectionRange?.start &&
    !!i.range?.start
  );
}

/** Where a click on the row goes: the first call site, else the symbol's name. */
export function nodeTarget(
  node: HierarchyNode,
): { path: string; line: number; column: number } | null {
  const site = node.calls?.ranges[0];
  if (site && node.calls?.path)
    return { path: node.calls.path, line: site.start.line + 1, column: site.start.character + 1 };
  if (!node.path) return null;
  const at = node.item.selectionRange.start;
  return { path: node.path, line: at.line + 1, column: at.character + 1 };
}

const SYMBOL_KINDS = [
  "",
  "file",
  "module",
  "namespace",
  "package",
  "class",
  "method",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "function",
  "variable",
  "constant",
  "string",
  "number",
  "boolean",
  "array",
  "object",
  "key",
  "null",
  "enumMember",
  "struct",
  "event",
  "operator",
  "typeParameter",
];

/** A symbol kind's name as LSP's number (D255: an extension's hierarchy items); "function" else. */
export function symbolKindNumber(name: string): number {
  const at = SYMBOL_KINDS.indexOf(name);
  return at > 0 ? at : 12;
}

/** LSP's SymbolKind number as its name ("function", "class"…). */
export function symbolKindName(kind: number): string {
  return SYMBOL_KINDS[kind] || "variable";
}

/** One row as plain data (1-based lines and columns; `rel` makes paths workspace-relative). */
export interface HierarchyData {
  /** The row's id in the view (lsp.showHierarchyOfItem takes it). */
  id: string;
  name: string;
  kind: string;
  detail?: string;
  path: string;
  line: number;
  column: number;
  /** The call sites (calls only): their file and 1-based positions. */
  calls?: { path: string; positions: { line: number; column: number }[] };
  deprecated?: true;
  children?: HierarchyData[];
}

export function nodeData(
  node: HierarchyNode,
  rel: (path: string) => string,
  children?: HierarchyData[],
): HierarchyData {
  const at = node.item.selectionRange.start;
  return {
    id: node.id,
    name: node.item.name,
    kind: symbolKindName(node.item.kind),
    ...(node.item.detail ? { detail: node.item.detail } : {}),
    path: node.path ? rel(node.path) : node.item.uri,
    line: at.line + 1,
    column: at.character + 1,
    ...(node.calls && {
      calls: {
        path: node.calls.path ? rel(node.calls.path) : "",
        positions: node.calls.ranges.map((r) => ({
          line: r.start.line + 1,
          column: r.start.character + 1,
        })),
      },
    }),
    // SymbolTag.Deprecated (1).
    ...(node.item.tags?.includes(1) ? { deprecated: true as const } : {}),
    ...(children ? { children } : {}),
  };
}

/**
 * The tree as data, from the rows loaded so far (`loaded`: node id → its children). Children
 * not asked for yet are left out; `limit` caps the rows (a wide hierarchy stays readable).
 */
export function treeData(
  roots: readonly HierarchyNode[],
  loaded: ReadonlyMap<string, readonly HierarchyNode[]>,
  rel: (path: string) => string,
  limit = 500,
): HierarchyData[] {
  let left = limit;
  const walk = (nodes: readonly HierarchyNode[]): HierarchyData[] => {
    const out: HierarchyData[] = [];
    for (const n of nodes) {
      if (left <= 0) break;
      left--;
      const kids = loaded.get(n.id);
      out.push(nodeData(n, rel, kids ? walk(kids) : undefined));
    }
    return out;
  };
  return walk(roots);
}

/**
 * One hierarchy being browsed: its roots (prepare's answer) and the levels loaded so far, asked
 * lazily (a row's children when it's expanded). Switching direction keeps the roots and forgets
 * the levels; an answer for the old direction that arrives late is dropped.
 */
export class HierarchySession {
  private readonly loadedLevels = new Map<string, HierarchyNode[]>();
  private readonly pending = new Map<string, Promise<HierarchyNode[]>>();
  private generation = 0;

  constructor(
    readonly kind: HierarchyKind,
    private currentDirection: HierarchyDirection,
    readonly roots: readonly HierarchyNode[],
    /** Sends a request to the server that answered prepare. */
    private readonly request: (method: string, params: unknown) => Promise<unknown>,
  ) {}

  get direction(): HierarchyDirection {
    return this.currentDirection;
  }

  /** Node id → its children, for the levels loaded in the current direction. */
  get loaded(): ReadonlyMap<string, readonly HierarchyNode[]> {
    return this.loadedLevels;
  }

  /** Starts over in `direction` (one of this hierarchy's). False when it isn't one. */
  setDirection(direction: HierarchyDirection): boolean {
    if (!isDirectionOf(this.kind, direction)) return false;
    if (direction === this.currentDirection) return true;
    this.currentDirection = direction;
    this.generation++;
    this.loadedLevels.clear();
    this.pending.clear();
    return true;
  }

  /** The rows under `node` (asked once; a failed request rejects and is asked again next time). */
  children(node: HierarchyNode): Promise<HierarchyNode[]> {
    const known = this.loadedLevels.get(node.id);
    if (known) return Promise.resolve(known);
    const inFlight = this.pending.get(node.id);
    if (inFlight) return inFlight;
    const generation = this.generation;
    const direction = this.currentDirection;
    const p = this.request(childrenMethod(direction), { item: node.item }).then(
      (answer) => {
        const kids = childNodes(direction, node, answer);
        if (generation === this.generation) {
          this.loadedLevels.set(node.id, kids);
          this.pending.delete(node.id);
        }
        return kids;
      },
      (err: unknown) => {
        if (generation === this.generation) this.pending.delete(node.id);
        throw err;
      },
    );
    this.pending.set(node.id, p);
    return p;
  }

  /**
   * Loads `depth` levels under the roots, breadth first, stopping once `limit` rows are known
   * (calls can recurse forever). A level that fails is left out.
   */
  async expand(depth: number, limit = 200): Promise<void> {
    let level: readonly HierarchyNode[] = this.roots;
    let count = level.length;
    for (let d = 0; d < depth && level.length && count < limit; d++) {
      const next: HierarchyNode[] = [];
      for (const node of level) {
        if (count >= limit) break;
        const kids = await this.children(node).catch(() => []);
        count += kids.length;
        next.push(...kids);
      }
      level = next;
    }
  }

  /** The loaded tree as plain data. */
  data(rel: (path: string) => string, limit?: number): HierarchyData[] {
    return treeData(this.roots, this.loadedLevels, rel, limit);
  }

  /** The row with `id` among the roots and the levels loaded so far. */
  find(id: string): HierarchyNode | undefined {
    return findNode(this.roots, this.loadedLevels, id);
  }

  /** The files the loaded rows point into (their symbols and call sites). */
  files(): string[] {
    return treeFiles(this.roots, this.loadedLevels);
  }
}

/** The row with `id` among `roots` and the levels in `loaded`. */
export function findNode(
  roots: readonly HierarchyNode[],
  loaded: ReadonlyMap<string, readonly HierarchyNode[]>,
  id: string,
): HierarchyNode | undefined {
  const root = roots.find((r) => r.id === id);
  if (root) return root;
  // A child's id is its parent's plus "/n": its level is the parent's list.
  const slash = id.lastIndexOf("/");
  if (slash < 0) return undefined;
  return loaded.get(id.slice(0, slash))?.find((n) => n.id === id);
}

/**
 * The files the rows point into, each once: the symbols' and the call sites' (a change in any
 * of them may make the tree outdated).
 */
export function treeFiles(
  roots: readonly HierarchyNode[],
  loaded: ReadonlyMap<string, readonly HierarchyNode[]>,
): string[] {
  const out = new Set<string>();
  const add = (n: HierarchyNode) => {
    if (n.path) out.add(n.path);
    if (n.calls?.path) out.add(n.calls.path);
  };
  for (const r of roots) add(r);
  for (const level of loaded.values()) for (const n of level) add(n);
  return [...out];
}

/**
 * Where to ask prepare again to show the hierarchy of `node` itself (VS Code's "Show call
 * hierarchy" on a row): its symbol's name, 1-based. Null for a symbol outside a file.
 */
export function nodeOrigin(
  node: HierarchyNode,
): { path: string; line: number; column: number } | null {
  if (!node.path) return null;
  const at = node.item.selectionRange.start;
  return { path: node.path, line: at.line + 1, column: at.character + 1 };
}

/** "Callers of f", "Calls from f", "Supertypes of T", "Subtypes of T" (the view's header). */
export function hierarchyTitle(direction: HierarchyDirection, name: string): string {
  switch (direction) {
    case "incoming":
      return `Callers of ${name}`;
    case "outgoing":
      return `Calls from ${name}`;
    case "supertypes":
      return `Supertypes of ${name}`;
    case "subtypes":
      return `Subtypes of ${name}`;
  }
}
