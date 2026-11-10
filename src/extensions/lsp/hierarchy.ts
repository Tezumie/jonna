// Call and type hierarchies from the language server (textDocument/prepareCallHierarchy and
// prepareTypeHierarchy, then callHierarchy/incomingCalls|outgoingCalls and
// typeHierarchy/supertypes|subtypes for each level). People get the `hierarchy` dock tab (VS
// Code's Call Hierarchy / Type Hierarchy view: a lazy tree, a direction toggle, rows open their
// location); agents get the same answers as data (`lsp.callHierarchy`, `lsp.typeHierarchy`).
// m7.12: Refresh (asks prepare again where the view was opened), "Show hierarchy of this item"
// (re-roots on a row, as VS Code's view does), a row menu, and a "results may be outdated" bar
// once a file the tree points into is edited or saved (the tree isn't rebuilt under the user).
// State: ide://lsp/hierarchy.

import { fsIpc } from "../../core/ipc/fs";
import type { DisposableStore } from "../../core/lifecycle/index";
import type { LanguageClient } from "../../core/lsp/client";
import {
  capabilityOf,
  defaultDirection,
  type HierarchyDirection,
  type HierarchyItem,
  type HierarchyKind,
  type HierarchyNode,
  HierarchySession,
  isDirectionOf,
  nodeOrigin,
  otherDirection,
  prepareMethod,
  rootNodes,
} from "../../core/lsp/hierarchy";
import { pathKey, samePath } from "../../core/paths/index";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { featureMatches } from "../../workbench/extensionFeatures";
import type { WorkbenchServices } from "../../workbench/services";
import { languageForPath } from "../editor/languages";
import { clientSource, extensionSource, type HierarchySource } from "./hierarchySource";
import {
  type HierarchyOrigin,
  hierarchyViewDescriptor,
  type ShownHierarchy,
} from "./hierarchyView";
import type { LspManager } from "./manager";

export interface HierarchyDeps {
  /** Runs `fn` with the file open in its server (index.ts). */
  withDoc<T>(path: string, fn: (client: LanguageClient, uri: string) => Promise<T>): Promise<T>;
  /** Workspace-relative path for data. */
  rel(path: string): string;
  /** The active editor's language (reactive), or null. */
  activeLanguage(): string | null;
}

const NAMES: Record<HierarchyKind, string> = { call: "call hierarchy", type: "type hierarchy" };
/** Context keys for the editor's menu and Shift+Alt+H (VS Code's names). */
const CONTEXT_KEYS: Record<HierarchyKind, string> = {
  call: "editorHasCallHierarchyProvider",
  type: "editorHasTypeHierarchyProvider",
};

export function registerHierarchy(
  sub: DisposableStore,
  services: WorkbenchServices,
  manager: LspManager,
  deps: HierarchyDeps,
): void {
  const { dispatcher, state, dock } = services;
  const shown = signal<ShownHierarchy | null>(null);
  /** A file the tree points into changed since it was shown (the bar offers Refresh). */
  const stale = signal(false);
  sub.add({ dispose: () => (shown.value = null) });
  sub.add(dock.views.register(hierarchyViewDescriptor(services, shown, stale, deps.rel)));

  /** An extension's provider of `kind` for `path`'s language (D255), with its owner. */
  const extensionProvider = (kind: HierarchyKind, path: string) => {
    const languageId = languageForPath(path);
    const key = kind === "call" ? "callHierarchy" : "typeHierarchy";
    const f = services.extensionFeatures.languages
      .peek()
      .find((x) => x[key] && featureMatches(x, languageId));
    const provider = f?.[key];
    return f && provider ? { owner: f.owner, provider, languageId } : null;
  };
  /** What an extension's prepare is asked with (the word and the line before the position). */
  const contextAt = async (path: string, line: number, column: number, languageId: string) => {
    const abs = services.workspace.resolve(path);
    const text =
      services.documents.text(abs) ??
      new TextDecoder().decode(await fsIpc.read(abs).catch(() => new Uint8Array()));
    const lineText = text.split(/\r?\n/)[line - 1] ?? "";
    const before = /[\w$]*$/.exec(lineText.slice(0, column - 1))?.[0] ?? "";
    const after = /^[\w$]*/.exec(lineText.slice(column - 1))?.[0] ?? "";
    return {
      path: abs,
      languageId,
      line,
      column,
      word: before + after,
      linePrefix: lineText.slice(0, column - 1),
    };
  };
  /**
   * Prepare at a position: where the hierarchy comes from and the symbols there. The language
   * server first; an extension's provider (D255) when there's no server for the file, it doesn't
   * provide this hierarchy, or it finds nothing there.
   */
  const prepare = async (
    kind: HierarchyKind,
    path: string,
    line: number,
    column: number,
  ): Promise<{ source: HierarchySource; roots: ReturnType<typeof rootNodes> }> => {
    const fromServer = () =>
      deps.withDoc(path, async (client, uri) => {
        if (!client.capabilities[capabilityOf(kind)])
          throw new Error(`${client.options.id} doesn't provide a ${NAMES[kind]}.`);
        // An edit still waiting in the editor reaches the server first.
        client.flushDocument?.(services.workspace.resolve(path));
        const items = await client.request<HierarchyItem[] | null>(prepareMethod(kind), {
          textDocument: { uri },
          position: { line: line - 1, character: column - 1 },
        });
        return { source: clientSource(client), roots: rootNodes(items) };
      });
    const ext = extensionProvider(kind, path);
    if (!ext) return fromServer();
    const served = await fromServer().catch(() => null);
    if (served?.roots.length) return served;
    const source = extensionSource(
      ext.owner,
      kind,
      ext.provider,
      await contextAt(path, line, column, ext.languageId),
    );
    const items = await source.request<HierarchyItem[]>(prepareMethod(kind), {});
    return { source, roots: rootNodes(items) };
  };
  const sessionFor = (
    kind: HierarchyKind,
    direction: HierarchyDirection,
    source: HierarchySource,
    roots: ReturnType<typeof rootNodes>,
  ) =>
    new HierarchySession(kind, direction, roots, (method, params) =>
      source.request<unknown>(method, params),
    );

  /** The given position, else the active editor's cursor. */
  const positionOf = async (input: {
    path?: string;
    line?: number;
    column?: number;
  }): Promise<{ path: string; line: number; column: number }> => {
    if (input.path && input.line !== undefined)
      return { path: input.path, line: input.line, column: input.column ?? 1 };
    const snap = await state.get("ide://editors/active").catch(() => null);
    const active = snap?.value as {
      absolutePath?: string | null;
      cursor?: { line: number; column: number };
    } | null;
    const at = active?.absolutePath;
    if (!at || (input.path && !samePath(services.workspace.resolve(input.path), at)))
      throw new Error("Give a path, line and column, or put the cursor on a symbol in an editor.");
    return { path: at, line: active.cursor?.line ?? 1, column: active.cursor?.column ?? 1 };
  };

  // ---- For agents: the hierarchy as data ----
  const query = (kind: HierarchyKind) => {
    const directions =
      kind === "call" ? (["incoming", "outgoing"] as const) : (["supertypes", "subtypes"] as const);
    return dispatcher.register({
      id: kind === "call" ? "lsp.callHierarchy" : "lsp.typeHierarchy",
      title:
        kind === "call" ? "Language server: call hierarchy" : "Language server: type hierarchy",
      category: "Language servers",
      description:
        kind === "call"
          ? "Who calls the function or method at a position (`direction` incoming, the default) or what it calls (outgoing), from the language server, `depth` levels deep (default 1, max 4). Each item has name, kind, path, 1-based line/column of its name and `calls` (the call sites: in the caller's file for incoming, in the parent's for outgoing), with `children` for the next level. Works on files that aren't open."
          : "The supertypes (`direction` supertypes) or subtypes (subtypes, the default) of the class or interface at a position, from the language server, `depth` levels deep (default 1, max 4). Each item has name, kind, path and 1-based line/column, with `children` for the next level.",
      input: s.object({
        path: s.string().describe("File, absolute or workspace-relative"),
        line: s.integer({ min: 1 }).describe("1-based line"),
        column: s.integer({ min: 1 }).describe("1-based column (UTF-16)"),
        direction: s
          .enum(directions)
          .describe(`Default ${defaultDirection(kind)}`)
          .optional(),
        depth: s.integer({ min: 1, max: 4 }).describe("Levels to load (default 1)").optional(),
      }),
      effects: ["read"],
      when: "workspaceOpen",
      agent: "discoverable",
      run: async ({ path, line, column, direction, depth }) => {
        const { source, roots } = await prepare(kind, path, line, column);
        const session = sessionFor(kind, direction ?? defaultDirection(kind), source, roots);
        await session.expand(depth ?? 1);
        return { direction: session.direction, items: session.data(deps.rel) };
      },
    });
  };
  sub.add(query("call"));
  sub.add(query("type"));

  // ---- For people: the hierarchy tab ----
  const show = (kind: HierarchyKind) => {
    const directions =
      kind === "call" ? (["incoming", "outgoing"] as const) : (["supertypes", "subtypes"] as const);
    return dispatcher.register({
      id: kind === "call" ? "lsp.showCallHierarchy" : "lsp.showTypeHierarchy",
      title: kind === "call" ? "Show call hierarchy" : "Show type hierarchy",
      category: "Language servers",
      description:
        kind === "call"
          ? "Opens the hierarchy tab with the calls to (incoming) or from (outgoing) the function at a position (default: the active editor's cursor), expandable level by level; rows open where the call is. Use lsp.callHierarchy to read the calls as data."
          : "Opens the hierarchy tab with the supertypes or subtypes of the type at a position (default: the active editor's cursor), expandable level by level. Use lsp.typeHierarchy to read them as data.",
      input: s.object({
        path: s.string().describe("File (default: the active editor's)").optional(),
        line: s.integer({ min: 1 }).describe("1-based line (default: the cursor's)").optional(),
        column: s.integer({ min: 1 }).describe("1-based column").optional(),
        direction: s
          .enum(directions)
          .describe(`Default ${defaultDirection(kind)}`)
          .optional(),
      }),
      effects: [],
      when: "workspaceOpen",
      run: async (input, ctx) => {
        const at = await positionOf(input);
        const { source, roots } = await prepare(kind, at.path, at.line, at.column);
        if (!roots.length) {
          const message = `No ${NAMES[kind]} at this position.`;
          if (ctx.caller.kind === "user") services.notifications.show("info", message);
          return { opened: false, message };
        }
        const session = sessionFor(kind, input.direction ?? defaultDirection(kind), source, roots);
        present(session, source, { path: at.path, line: at.line, column: at.column });
        dock.openView("hierarchy", null, undefined, true);
        return { opened: true, direction: session.direction, roots: session.data(deps.rel) };
      },
    });
  };
  sub.add(show("call"));
  sub.add(show("type"));

  /** Shows `session` in the tab (a new tree: the version moves on, the bar goes). */
  const present = (session: HierarchySession, source: HierarchySource, origin: HierarchyOrigin) => {
    const version = (shown.peek()?.version ?? -1) + 1;
    stale.value = false;
    shown.value = { session, server: source.id, source, origin, version };
  };
  const current = (): ShownHierarchy => {
    const c = shown.peek();
    if (!c) throw new Error("No hierarchy is shown (Show call hierarchy first).");
    return c;
  };
  /**
   * The hierarchy at `origin` again, in `direction`: prepare is asked anew (the code may have
   * changed); when it finds nothing there now, `fallback` (the rows that were shown) is asked
   * again instead. A server that stopped is started again by prepare; its error is the answer.
   */
  const reopen = async (
    kind: HierarchyKind,
    direction: HierarchyDirection,
    origin: HierarchyOrigin,
    fallback: readonly HierarchyNode[],
    source: HierarchySource,
  ) => {
    const running = source.running();
    const prepared = await prepare(kind, origin.path, origin.line, origin.column).catch(
      (err: unknown) => {
        if (!running) throw err;
        return null;
      },
    );
    const answered = prepared?.source ?? source;
    const roots = prepared?.roots.length
      ? prepared.roots
      : fallback.map(({ item, path }, i) => ({ id: `${i}`, item, path }));
    present(sessionFor(kind, direction, answered, roots), answered, origin);
  };

  sub.add(
    dispatcher.register({
      id: "lsp.refreshHierarchy",
      title: "Hierarchy: refresh",
      category: "Language servers",
      description:
        "Asks the language server again for the hierarchy shown in the hierarchy tab (the same symbol, the same direction), after the code changed. The tree starts over with its roots expanded.",
      input: s.empty(),
      effects: [],
      agent: "hidden",
      run: async () => {
        const c = current();
        const { session } = c;
        await reopen(session.kind, session.direction, c.origin, session.roots, c.source);
        const next = current().session;
        return { direction: next.direction, roots: next.data(deps.rel) };
      },
    }),
  );

  sub.add(
    dispatcher.register({
      id: "lsp.showHierarchyOfItem",
      title: "Hierarchy: show hierarchy of this item",
      category: "Language servers",
      description:
        "Re-roots the hierarchy tab on one of its rows (`id` from ide://lsp/hierarchy): shows the callers or callees (supertypes or subtypes) of that symbol instead, in the same direction, as VS Code's Show Call Hierarchy on a row does.",
      input: s.object({
        id: s.string().describe('The row\'s id (ide://lsp/hierarchy items[].id, e.g. "0/2")'),
      }),
      effects: [],
      agent: "hidden",
      run: async ({ id }) => {
        const c = current();
        const node = c.session.find(id);
        if (!node) throw new Error(`No row ${id} in the hierarchy (it may not be loaded yet).`);
        const origin = nodeOrigin(node);
        if (!origin) throw new Error(`${node.item.name} isn't in a file.`);
        await reopen(c.session.kind, c.session.direction, origin, [node], c.source);
        dock.openView("hierarchy", null, undefined, true);
        const next = current().session;
        return { direction: next.direction, roots: next.data(deps.rel) };
      },
    }),
  );

  // Following edits as VS Code's views do: an edit or a save in a file the tree points into
  // marks it outdated (a bar with Refresh) rather than rebuilding it under the user.
  const touched = (path: string) => {
    const c = shown.peek();
    if (!c || stale.peek()) return;
    const key = pathKey(path);
    if (c.session.files().some((f) => pathKey(f) === key)) stale.value = true;
  };
  sub.add(
    services.documents.onDidChange((path) => {
      // Closing a file fires too, with no text left: nothing changed.
      if (services.documents.text(path) !== null) touched(path);
    }),
  );
  sub.add(services.events.on("files.didSave", ({ path }) => touched(path)));
  sub.add(services.events.on("files.didChange", ({ path }) => touched(path)));
  sub.add(services.events.on("files.didDelete", ({ path }) => touched(path)));

  sub.add(
    dispatcher.register({
      id: "lsp.setHierarchyDirection",
      title: "Hierarchy: switch direction",
      category: "Language servers",
      description:
        "Switches the hierarchy tab between incoming and outgoing calls, or supertypes and subtypes (`direction`; toggles when omitted). The roots stay; their children are asked again.",
      input: s.object({
        direction: s.enum(["incoming", "outgoing", "supertypes", "subtypes"] as const).optional(),
      }),
      effects: [],
      agent: "hidden",
      run: ({ direction }) => {
        const current = shown.peek();
        if (!current) throw new Error("No hierarchy is shown (Show call hierarchy first).");
        const next = direction ?? otherDirection(current.session.direction);
        if (!isDirectionOf(current.session.kind, next))
          throw new Error(`A ${NAMES[current.session.kind]} has no ${next} direction.`);
        current.session.setDirection(next);
        shown.value = { ...current, version: current.version + 1 };
        // The levels are asked anew: what they show is current again.
        stale.value = false;
        return { direction: next };
      },
    }),
  );

  sub.add(
    state.register("ide://lsp/hierarchy", {
      description:
        "The hierarchy tab: kind (call or type), direction (incoming/outgoing, supertypes/subtypes), the server, outdated (a file it points into was edited or saved since it was shown: lsp.refreshHierarchy) and the rows loaded so far (id for lsp.showHierarchyOfItem, name, kind, path, 1-based line/column, call sites, children once expanded). Null when none is shown.",
      get: () => {
        const current = shown.peek();
        if (!current) return null;
        const { session } = current;
        return {
          kind: session.kind,
          direction: session.direction,
          server: current.server,
          outdated: stale.peek(),
          items: session.data(deps.rel),
        };
      },
    }),
  );

  // The editor's menu and Shift+Alt+H, while the active file's server answers them.
  const kinds: HierarchyKind[] = ["call", "type"];
  sub.add(
    effect(() => {
      const language = deps.activeLanguage();
      manager.statuses.value;
      const clients = services.languageClients.clients.value;
      const features = services.extensionFeatures.languages.value;
      const client = language
        ? clients.find((c) => c.state === "running" && c.handles(language))
        : undefined;
      // An extension's provider counts too (D255).
      const fromExtension = (kind: HierarchyKind) =>
        !!language &&
        features.some(
          (f) =>
            !!f[kind === "call" ? "callHierarchy" : "typeHierarchy"] && featureMatches(f, language),
        );
      for (const kind of kinds)
        services.context.set(
          CONTEXT_KEYS[kind],
          !!client?.capabilities[capabilityOf(kind)] || fromExtension(kind),
        );
      return undefined;
    }),
  );
  sub.add({
    dispose: () => {
      for (const kind of kinds) services.context.set(CONTEXT_KEYS[kind], undefined);
    },
  });
  sub.add(
    services.extensionFeatures.addMenus([
      {
        owner: "builtin.lsp",
        location: "editor/context",
        command: "lsp.showCallHierarchy",
        title: "Show call hierarchy",
        icon: "list-tree",
        when: CONTEXT_KEYS.call,
      },
      {
        owner: "builtin.lsp",
        location: "editor/context",
        command: "lsp.showTypeHierarchy",
        title: "Show type hierarchy",
        icon: "list-tree",
        when: CONTEXT_KEYS.type,
      },
    ]),
  );
}
