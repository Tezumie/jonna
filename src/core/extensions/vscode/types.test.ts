// D256: the `vscode` shim's core types, its converters and small helpers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromLocation, fromRange, markdownOf, pathOf, toRange, uriOf } from "./convert";
import { snippetText } from "./editors";
import { SnippetTextEdit, TimelineItem, TimelineTriggerKind } from "./extraTypes";
import { l10nFormat } from "./index";
import { decodeSemanticTokens, globToRegExp, languagesOf, matchSelector } from "./languages";
import { SemanticTokensBuilder, SemanticTokensLegend } from "./languageTypes";
import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  eventOf,
  Location,
  MarkdownString,
  Position,
  QuickInputButtons,
  Range,
  Selection,
  SnippetString,
  Uri,
  WorkspaceEdit,
} from "./types";
import {
  LanguageModelChatMessage,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  NotebookRange,
} from "./workbenchTypes";

test("Position and Range follow VS Code's rules", () => {
  const r = new Range(3, 4, 1, 2);
  assert.deepEqual([r.start.line, r.start.character, r.end.line, r.end.character], [1, 2, 3, 4]);
  assert.ok(r.contains(new Position(2, 0)));
  assert.ok(!r.contains(new Position(3, 5)));
  assert.ok(r.intersection(new Range(3, 0, 5, 0))?.isEqual(new Range(3, 0, 3, 4)));
  assert.equal(r.intersection(new Range(4, 0, 5, 0)), undefined);
  assert.ok(new Range(1, 1, 1, 1).isEmpty);
  assert.ok(new Selection(2, 0, 1, 0).isReversed);
  assert.ok(new Position(1, 5).translate({ characterDelta: -2 }).isEqual(new Position(1, 3)));
  assert.throws(() => new Position(-1, 0));
});

test("Uri: files on Windows and elsewhere, parse, joinPath, toString", () => {
  const win = Uri.file("C:\\Users\\me\\a b.ts");
  assert.equal(win.path, "/C:/Users/me/a b.ts");
  assert.equal(win.fsPath, "c:\\Users\\me\\a b.ts");
  assert.equal(win.toString(), "file:///c%3A/Users/me/a%20b.ts");
  const parsed = Uri.parse("file:///c%3A/Users/me/a%20b.ts");
  assert.equal(parsed.fsPath, "c:\\Users\\me\\a b.ts");
  assert.equal(Uri.file("/home/me/x.ts").fsPath, "/home/me/x.ts");
  assert.equal(Uri.file("\\\\server\\share\\x").fsPath, "\\\\server\\share\\x");
  assert.equal(Uri.joinPath(Uri.file("/a/b"), "../c", "d.ts").path, "/a/c/d.ts");
  const web = Uri.parse("https://example.com/p?q=1#top");
  assert.deepEqual(
    [web.scheme, web.authority, web.path, web.query, web.fragment],
    ["https", "example.com", "/p", "q=1", "top"],
  );
  assert.equal(Uri.revive(JSON.parse(JSON.stringify(win)))?.fsPath, win.fsPath);
  assert.equal(uriOf("memfs:/a/b.txt").scheme, "memfs");
  assert.equal(uriOf("C:\\a.txt").scheme, "file");
  assert.equal(pathOf(Uri.parse("memfs:/a/b.txt")), "memfs:/a/b.txt");
});

test("the IDE's 1-based ranges and VS Code's 0-based ones", () => {
  const r = new Range(0, 2, 1, 4);
  assert.deepEqual(fromRange(r), { startLine: 1, startColumn: 3, endLine: 2, endColumn: 5 });
  assert.ok(toRange(fromRange(r)).isEqual(r));
  // Whole lines: through the end line's break.
  assert.ok(toRange({ startLine: 2, endLine: 3 }).isEqual(new Range(1, 0, 3, 0)));
  assert.deepEqual(fromLocation(new Location(Uri.file("/w/a.ts"), new Position(4, 0))), {
    path: "/w/a.ts",
    startLine: 5,
    startColumn: 1,
    endLine: 5,
    endColumn: 1,
  });
  assert.deepEqual(
    fromLocation({
      targetUri: Uri.file("/w/b.ts"),
      targetRange: new Range(0, 0, 9, 0),
      targetSelectionRange: new Range(2, 4, 2, 8),
    }),
    { path: "/w/b.ts", startLine: 3, startColumn: 5, endLine: 3, endColumn: 9 },
  );
  assert.equal(
    markdownOf([new MarkdownString("**a**"), { language: "ts", value: "let x" }]),
    "**a**\n\n```ts\nlet x\n```",
  );
});

test("events, cancellation and WorkspaceEdit", () => {
  const e = new EventEmitter<number>();
  const seen: number[] = [];
  const d = e.event((n) => seen.push(n));
  e.fire(1);
  d.dispose();
  e.fire(2);
  assert.deepEqual(seen, [1]);

  const source = new CancellationTokenSource();
  let cancelled = 0;
  source.token.onCancellationRequested(() => cancelled++);
  source.cancel();
  source.cancel();
  assert.ok(source.token.isCancellationRequested);
  assert.equal(cancelled, 1);
  // A listener added after cancelling runs at once.
  source.token.onCancellationRequested(() => cancelled++);
  assert.equal(cancelled, 2);

  const edit = new WorkspaceEdit();
  const a = Uri.file("/w/a.ts");
  edit.insert(a, new Position(0, 0), "x");
  edit.replace(a, new Range(1, 0, 1, 2), "y");
  edit.createFile(Uri.file("/w/new.ts"));
  assert.equal(edit.size, 2);
  assert.equal(edit.get(a).length, 2);
  edit.set(a, []);
  assert.equal(edit.get(a).length, 0);
  assert.equal(edit.operations().length, 1);
});

test("snippets, semantic tokens, selectors, l10n", () => {
  const s = new SnippetString()
    .appendText("f(")
    .appendPlaceholder("a")
    .appendText(", ")
    .appendTabstop()
    .appendText(")");
  assert.equal(s.value, "f(${1:a}, $2)");
  assert.equal(snippetText(s.value), "f(a, )");

  const legend = new SemanticTokensLegend(["function", "variable"], ["readonly"]);
  const builder = new SemanticTokensBuilder(legend);
  builder.push(new Range(2, 4, 2, 7), "variable", ["readonly"]);
  builder.push(0, 0, 3, 0, 0);
  assert.deepEqual(decodeSemanticTokens(builder.build().data, legend), [
    { line: 1, column: 1, length: 3, type: "function" },
    { line: 3, column: 5, length: 3, type: "variable", modifiers: ["readonly"] },
  ]);

  const doc = { languageId: "typescript", uri: Uri.file("/w/src/a.test.ts") };
  assert.equal(matchSelector("typescript", doc), 10);
  assert.equal(matchSelector({ scheme: "file", pattern: "**/*.test.ts" }, doc), 10);
  assert.equal(
    matchSelector([{ language: "python" }, { language: "typescript", scheme: "untitled" }], doc),
    0,
  );
  assert.deepEqual(languagesOf([{ language: "a" }, "b"]), ["a", "b"]);
  assert.deepEqual(languagesOf({ pattern: "**/*.x" }), ["*"]);
  assert.ok(globToRegExp("**/*.{ts,js}").test("a/b/c.js"));
  assert.ok(!globToRegExp("*.ts").test("a/b.ts"));

  assert.equal(l10nFormat("{0} of {1}", 2, 5), "2 of 5");
  assert.equal(l10nFormat("Hi {name}", { name: "Ada" }), "Hi Ada");
});

test("D261: Uri authorities keep their port and user, queries their #, with(null) clears", () => {
  assert.equal(Uri.parse("http://localhost:3000/").toString(), "http://localhost:3000/");
  assert.equal(
    Uri.parse("https://me@Example.COM:8443/a").toString(),
    "https://me@example.com:8443/a",
  );
  const q = Uri.from({ scheme: "http", authority: "x", path: "/", query: "q=#x" });
  assert.equal(q.toString(), "http://x/?q=%23x");
  assert.equal(Uri.parse(q.toString()).query, "q=#x");
  assert.equal(
    Uri.parse("http://x/a?b#c").with({ query: null, fragment: null }).toString(),
    "http://x/a",
  );
});

test("stable members the coverage probe found missing (vscode.d.ts, D295)", () => {
  // QuickInputButtons is a class with a static Back, as VS Code's.
  assert.equal(typeof QuickInputButtons, "function");
  assert.equal(QuickInputButtons.Back.tooltip, "Back");
  const r = new NotebookRange(1, 3);
  assert.deepEqual([r.with({ end: 5 }).start, r.with({ end: 5 }).end], [1, 5]);
  assert.equal(r.with({}), r);
  assert.equal(TimelineTriggerKind.Automatic, 2);
  // A timeline item for a file is named after it.
  const item = new TimelineItem(Uri.file("/ws/src/a.ts"), 5);
  assert.equal(item.label, "a.ts");
  assert.equal(new TimelineItem("Saved", 6).label, "Saved");
});

test("audit: emitter subscriptions, Disposable.from, Selection's JSON", () => {
  const e = new EventEmitter<number>();
  const seen: number[] = [];
  const listener = (n: number) => seen.push(n);
  // The same listener twice is two subscriptions: disposing one keeps the other.
  const first = e.event(listener);
  e.event(listener);
  first.dispose();
  e.fire(1);
  assert.deepEqual(seen, [1]);
  // A listener without thisArgs isn't called on an internal object.
  let self: unknown = "unset";
  e.event(function (this: unknown) {
    self = this;
  });
  e.fire(2);
  assert.equal(self, undefined);
  // Something without dispose is skipped; the rest still dispose.
  let disposed = 0;
  Disposable.from({} as { dispose(): void }, { dispose: () => disposed++ }).dispose();
  assert.equal(disposed, 1);
  // eventOf: thisArgs bound, the Disposable added to `disposables`, disposing unsubscribes.
  let unsubscribed = 0;
  let deliver: (n: number) => void = () => {};
  const event = eventOf<number>((l) => {
    deliver = (n) => void l(n);
    return { dispose: () => unsubscribed++ };
  });
  const bag: { dispose(): unknown }[] = [];
  const owner = { got: 0 };
  event(
    function (this: typeof owner, n) {
      this.got = n;
    },
    owner,
    bag,
  );
  deliver(7);
  assert.equal(owner.got, 7);
  assert.equal(bag.length, 1);
  bag[0]?.dispose();
  assert.equal(unsubscribed, 1);
  // A Selection crosses JSON with its anchor and active ends.
  assert.deepEqual(JSON.parse(JSON.stringify(new Selection(2, 1, 0, 0))), {
    start: { line: 0, character: 0 },
    end: { line: 2, character: 1 },
    active: { line: 0, character: 0 },
    anchor: { line: 2, character: 1 },
  });
});

test("audit: a file or web Uri's path is absolute; joinPath keeps a trailing slash", () => {
  const u = Uri.from({ scheme: "file", path: "c:/w/a.ts" });
  assert.equal(u.path, "/c:/w/a.ts");
  assert.equal(u.fsPath, "c:\\w\\a.ts");
  assert.equal(u.toString(), "file:///c%3A/w/a.ts");
  assert.equal(Uri.parse("https://example.com").path, "/");
  // Other schemes keep a relative path.
  assert.equal(Uri.from({ scheme: "untitled", path: "Untitled-1" }).path, "Untitled-1");
  assert.equal(Uri.joinPath(Uri.file("/a"), "b/").path, "/a/b/");
  assert.equal(Uri.joinPath(Uri.file("/a"), "b").path, "/a/b");
});

test("audit: snippet edits in a WorkspaceEdit are text edits; snippet variables; ranges", () => {
  const edit = new WorkspaceEdit();
  const a = Uri.file("/w/a.ts");
  edit.set(a, [
    new SnippetTextEdit(new Range(0, 0, 0, 1), new SnippetString("f(${1:x})$0")),
    [SnippetTextEdit.insert(new Position(1, 0), new SnippetString("y")), { label: "m" }],
  ]);
  assert.equal(edit.notebookOps.length, 0);
  const texts = edit.get(a);
  assert.deepEqual(
    texts.map((t) => t.newText),
    ["f(x)", "y"],
  );
  assert.ok(texts[1]?.range instanceof Range);
  assert.ok(texts[1]?.range.isEmpty);
  // A variable's default is escaped, and none has no ":".
  const variable = new SnippetString().appendVariable("TM_FILENAME", "a}b").value;
  assert.equal(variable, "${TM_FILENAME:a\\}b}");
  assert.equal(new SnippetString().appendVariable("TM_FILENAME", "").value, "${TM_FILENAME}");
  // NotebookRange orders its bounds and refuses negative ones, as VS Code's.
  const r = new NotebookRange(4, 2);
  assert.deepEqual([r.start, r.end], [2, 4]);
  assert.throws(() => new NotebookRange(-1, 2));
  // A chat message keeps its tool parts.
  const call = new LanguageModelToolCallPart("c1", "tool", {});
  const message = LanguageModelChatMessage.Assistant([call as never]);
  assert.equal(message.content[0], call);
  assert.ok(
    LanguageModelChatMessage.User([{ value: "hi" } as never]).content[0] instanceof
      LanguageModelTextPart,
  );
});
