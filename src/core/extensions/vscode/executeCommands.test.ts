// VS Code's vscode.execute…Provider commands: VS Code's arguments as the IDE's query, the IDE's
// answers as VS Code's classes, and what's answered when the IDE refuses.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderQuery } from "../providerQuery";
import type { WorkerApi } from "../rpc";
import {
  answerOf,
  emptyAnswer,
  isExecuteCommand,
  queryOf,
  runExecuteCommand,
} from "./executeCommands";
import {
  CodeAction,
  CodeActionKind,
  CompletionItemKind,
  CompletionList,
  DocumentSymbol,
  FoldingRangeKind,
  Hover,
  type SelectionRange,
  SymbolKind,
} from "./languageTypes";
import {
  Location,
  MarkdownString,
  Position,
  Range,
  SnippetString,
  TextEdit,
  Uri,
  WorkspaceEdit,
} from "./types";

const uri = Uri.file("/ws/a.ts");
const r = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({
  startLine,
  startColumn,
  endLine,
  endColumn,
});

test("VS Code's arguments become the IDE's 1-based query", () => {
  assert.deepEqual(queryOf("vscode.executeDefinitionProvider", [uri, new Position(2, 4)]), {
    kind: "definition",
    path: uri.fsPath,
    line: 3,
    column: 5,
  });
  assert.deepEqual(
    queryOf("vscode.executeCompletionItemProvider", [uri, new Position(0, 0), ".", 5]),
    {
      kind: "completion",
      path: uri.fsPath,
      line: 1,
      column: 1,
      triggerCharacter: ".",
      resolveCount: 5,
    },
  );
  assert.deepEqual(
    queryOf("vscode.executeCodeActionProvider", [
      uri,
      new Range(1, 0, 1, 3),
      CodeActionKind.QuickFix,
    ]),
    { kind: "codeActions", path: uri.fsPath, range: r(2, 1, 2, 4), only: "quickfix" },
  );
  assert.deepEqual(
    queryOf("vscode.executeFormatDocumentProvider", [uri, { tabSize: 4, insertSpaces: true }]),
    { kind: "formatDocument", path: uri.fsPath, tabSize: 4, insertSpaces: true },
  );
  assert.deepEqual(
    queryOf("vscode.executeSelectionRangeProvider", [uri, [new Position(0, 1), "nope"]]),
    { kind: "selectionRanges", path: uri.fsPath, positions: [{ line: 1, column: 2 }] },
  );
  // Missing what the command needs: no query (the empty answer).
  assert.equal(queryOf("vscode.executeHoverProvider", [uri]), undefined);
  assert.equal(
    queryOf("vscode.executeDocumentRenameProvider", [uri, new Position(0, 0)]),
    undefined,
  );
  assert.equal(queryOf("vscode.executeDocumentSymbolProvider", ["not a uri"]), undefined);
});

test("locations and links, hovers and symbols as VS Code's classes", () => {
  const q = (kind: ProviderQuery["kind"]): ProviderQuery => ({ kind, path: uri.fsPath });
  const [plain, link] = answerOf(q("definition"), [
    { path: "/ws/b.ts", range: r(1, 1, 1, 4) },
    { path: "/ws/c.ts", range: r(1, 1, 5, 2), targetSelectionRange: r(2, 3, 2, 6) },
  ]) as [Location, { targetUri: Uri; targetRange: Range; targetSelectionRange: Range }];
  assert.ok(plain instanceof Location);
  assert.equal(plain.uri.fsPath, Uri.file("/ws/b.ts").fsPath);
  assert.deepEqual([plain.range.end.line, plain.range.end.character], [0, 3]);
  assert.equal(link.targetUri.fsPath, Uri.file("/ws/c.ts").fsPath);
  assert.equal(link.targetSelectionRange.start.character, 2);
  // References are always plain locations.
  const refs = answerOf(q("references"), [
    { path: "/ws/c.ts", range: r(1, 1, 1, 2), targetSelectionRange: r(1, 1, 1, 2) },
  ]) as unknown[];
  assert.ok(refs[0] instanceof Location);

  const [hover] = answerOf(q("hover"), [
    { contents: ["**x**", "y"], range: r(1, 2, 1, 3) },
  ]) as Hover[];
  assert.ok(hover instanceof Hover);
  assert.ok(hover.contents[0] instanceof MarkdownString);
  assert.equal((hover.contents[1] as MarkdownString).value, "y");
  assert.equal(hover.range?.start.character, 1);

  const [cls] = answerOf(q("documentSymbols"), [
    {
      name: "A",
      detail: "",
      kind: SymbolKind.Class,
      range: r(1, 1, 9, 2),
      selectionRange: r(1, 7, 1, 8),
      children: [
        {
          name: "m",
          detail: "()",
          kind: 5,
          range: r(2, 3, 3, 4),
          selectionRange: r(2, 3, 2, 4),
          children: [],
        },
      ],
    },
  ]) as (DocumentSymbol & { location: Location; containerName: string })[];
  assert.ok(cls instanceof DocumentSymbol);
  assert.equal(cls?.kind, SymbolKind.Class);
  // Also a SymbolInformation, as VS Code's answer is.
  assert.ok(cls?.location instanceof Location);
  const method = cls?.children[0] as DocumentSymbol & { containerName: string };
  assert.equal(method.kind, SymbolKind.Method);
  assert.equal(method.containerName, "A");
});

test("completions, edits, code actions, folding and selection ranges", () => {
  const q = (kind: ProviderQuery["kind"]): ProviderQuery => ({ kind, path: uri.fsPath });
  const list = answerOf(q("completion"), {
    isIncomplete: true,
    items: [
      {
        label: "log",
        kind: "method",
        insertText: "log($1)",
        snippet: true,
        range: r(1, 1, 1, 3),
        insertRange: r(1, 1, 1, 2),
        documentation: "Logs.",
      },
      { label: "x", labelDetail: "()", kind: "enumMember", insertText: "x" },
    ],
  }) as CompletionList;
  assert.ok(list instanceof CompletionList);
  assert.equal(list.isIncomplete, true);
  const [log, x] = list.items;
  assert.equal(log?.kind, CompletionItemKind.Method);
  assert.ok(log?.insertText instanceof SnippetString);
  assert.ok(log?.range && "inserting" in log.range);
  assert.equal(x?.kind, CompletionItemKind.EnumMember);
  assert.deepEqual(x?.label, { label: "x", detail: "()" });

  const edits = answerOf(q("formatDocument"), [{ range: r(1, 1, 1, 3), text: "  " }]) as TextEdit[];
  assert.ok(edits[0] instanceof TextEdit);

  const [action] = answerOf(q("codeActions"), [
    {
      title: "Fix",
      kind: "quickfix",
      isPreferred: true,
      edits: [{ path: "/ws/a.ts", range: r(1, 1, 1, 1), text: "x" }],
      command: { id: "lsp.ts.run.3", title: "Fix" },
    },
  ]) as CodeAction[];
  assert.ok(action instanceof CodeAction);
  assert.equal(action?.kind?.value, "quickfix");
  assert.ok(action?.edit instanceof WorkspaceEdit);
  assert.equal(action?.edit?.size, 1);

  const [fold] = answerOf(q("foldingRanges"), [{ start: 3, end: 7, kind: "region" }]) as {
    start: number;
    end: number;
    kind?: FoldingRangeKind;
  }[];
  assert.deepEqual([fold?.start, fold?.end, fold?.kind], [2, 6, FoldingRangeKind.Region]);

  const [sel] = answerOf(q("selectionRanges"), [
    [r(1, 2, 1, 3), r(1, 1, 1, 9)],
  ]) as SelectionRange[];
  assert.equal(sel?.range.start.character, 1);
  assert.equal(sel?.parent?.range.end.character, 8);
  assert.equal(sel?.parent?.parent, undefined);
});

test("rename: the edits, or the providers' reason as an error", () => {
  const q: ProviderQuery = { kind: "rename", path: uri.fsPath, line: 1, column: 1, newName: "y" };
  const edit = answerOf(q, {
    edits: [{ path: "/ws/a.ts", range: r(1, 1, 1, 2), text: "y" }],
  }) as WorkspaceEdit;
  assert.ok(edit instanceof WorkspaceEdit);
  assert.throws(() => answerOf(q, { rejectReason: "Can't rename this." }), /Can't rename this/);
  assert.equal(answerOf(q, null), undefined);
  const prepare = answerOf(
    { kind: "prepareRename", path: uri.fsPath, line: 1, column: 1 },
    { range: r(1, 1, 1, 4), text: "abc" },
  ) as { range: Range; placeholder: string };
  assert.equal(prepare.placeholder, "abc");
});

test("runExecuteCommand: the IDE's answer, or the empty one when it refuses (logged)", async () => {
  const asked: ProviderQuery[] = [];
  const logs: string[] = [];
  let refuse = false;
  const ide = {
    languages: {
      execute: async (query: ProviderQuery) => {
        asked.push(query);
        if (refuse) throw new Error("needs fs.read");
        return [{ path: "/ws/b.ts", range: r(1, 1, 1, 2) }];
      },
    },
    commands: {
      execute: async (id: string, input: { query: string }) => {
        assert.equal(id, "quickOpen.findSymbols");
        return {
          symbols: [{ name: input.query, kind: "class", path: "src/A.ts", line: 4, column: 2 }],
        };
      },
    },
  } as unknown as WorkerApi;
  const options = { absolute: (p: string) => `/ws/${p}`, log: (t: string) => logs.push(t) };
  const refs = (await runExecuteCommand(
    ide,
    "vscode.executeReferenceProvider",
    [uri, new Position(0, 0)],
    options,
  )) as Location[];
  assert.equal(refs.length, 1);
  assert.equal(asked[0]?.kind, "references");
  refuse = true;
  assert.deepEqual(
    await runExecuteCommand(ide, "vscode.executeDocumentSymbolProvider", [uri], options),
    [],
  );
  assert.match(logs[0] ?? "", /executeDocumentSymbolProvider: needs fs.read/);
  const completions = await runExecuteCommand(
    ide,
    "vscode.executeCompletionItemProvider",
    [uri, new Position(0, 0)],
    options,
  );
  assert.ok(completions instanceof CompletionList);
  // Workspace symbols: the IDE's symbol search, relative paths made absolute.
  const [sym] = (await runExecuteCommand(
    ide,
    "vscode.executeWorkspaceSymbolProvider",
    ["Widget"],
    options,
  )) as { name: string; kind: SymbolKind; location: Location }[];
  assert.equal(sym?.name, "Widget");
  assert.equal(sym?.kind, SymbolKind.Class);
  assert.equal(sym?.location.uri.fsPath, Uri.file("/ws/src/A.ts").fsPath);
  assert.equal(sym?.location.range.start.line, 3);
  // What the IDE can't ask answers as VS Code does with no provider.
  assert.ok(isExecuteCommand("vscode.prepareCallHierarchy"));
  assert.deepEqual(await runExecuteCommand(ide, "vscode.prepareCallHierarchy", [uri], options), []);
  assert.equal(emptyAnswer("vscode.executeSignatureHelpProvider"), undefined);
  assert.equal(isExecuteCommand("vscode.open"), false);
});
