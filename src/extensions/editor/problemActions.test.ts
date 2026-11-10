import assert from "node:assert/strict";
import { test } from "node:test";
import type { Diagnostic } from "./engine";
import { actionMenuItems, MenuActionWidgetService } from "./monaco/actionMenu";
import { fixPrompt, formatProblem, matchProblems, problemMenu } from "./problemActions";

const d = (over: Partial<Diagnostic>): Diagnostic => ({
  path: "/w/src/a.ts",
  line: 2,
  column: 1,
  endLine: 2,
  endColumn: 4,
  severity: "error",
  message: "Cannot find name 'foo'.",
  source: "typescript",
  code: "2304",
  ...over,
});
const rel = (p: string) => p.replace("/w/", "");

test("problems: compiler-style text, matching, agent prompt", () => {
  assert.equal(
    formatProblem(d({}), rel),
    "src/a.ts:2:1 - error typescript(2304): Cannot find name 'foo'.",
  );
  assert.equal(
    formatProblem(d({ source: undefined, code: undefined, severity: "warning" }), rel),
    "src/a.ts:2:1 - warning: Cannot find name 'foo'.",
  );
  const all = [d({}), d({ line: 5 }), d({ path: "/w/b.ts" })];
  assert.equal(matchProblems(all, {}, rel).length, 3);
  assert.equal(matchProblems(all, { path: "src/a.ts" }, rel).length, 2);
  assert.equal(matchProblems(all, { path: "src\\a.ts", line: 5 }, rel).length, 1);
  assert.equal(matchProblems(all, { path: "/w/b.ts" }, rel).length, 1);
  assert.equal(matchProblems(all, { message: "other" }, rel).length, 0);
  const one = fixPrompt([d({})], rel);
  assert.match(one, /reports this problem:\n\n```\nsrc\/a\.ts:2:1/);
  assert.match(one, /Fix it\.$/);
  assert.match(fixPrompt(all, rel), /these 3 problems[\s\S]*Fix them\.$/);
  // A message with a fence gets a longer one.
  assert.match(fixPrompt([d({ message: "use ```x```" })], rel), /````\n/);
});

test("problems: the row menu acts on the row's problem", () => {
  const calls: [string, unknown][] = [];
  let went = 0;
  const items = problemMenu(d({}), (c, i) => calls.push([c, i]), { goTo: () => went++ });
  assert.deepEqual(
    items.map((i) => i.label),
    [
      "Go to problem",
      "Copy",
      "Copy message",
      "Copy problems in this file",
      "Copy all problems",
      "Fix with agent",
      "Fix all in this file with agent",
    ],
  );
  for (const i of items) i.run?.();
  assert.equal(went, 1);
  assert.deepEqual(calls[0], [
    "problems.copy",
    { path: "/w/src/a.ts", line: 2, column: 1, message: "Cannot find name 'foo'." },
  ]);
  assert.deepEqual(calls[1]?.[1], {
    path: "/w/src/a.ts",
    line: 2,
    column: 1,
    message: "Cannot find name 'foo'.",
    format: "message",
  });
  assert.equal(calls[4]?.[0], "problems.fixWithAgent");
  const inFile = problemMenu(d({}), () => {}, { goTo: () => {}, inFileList: true });
  assert.ok(!inFile.some((i) => i.label === "Copy all problems"));
});

test("code action rows become menu items with separators between groups", () => {
  const picked: unknown[] = [];
  const items = actionMenuItems(
    [
      { kind: "header" },
      { kind: "action", item: "a", label: "Add missing function" },
      { kind: "action", item: "b", label: "Ignore", disabled: true },
      { kind: "header" },
      { kind: "action", item: "c", label: "Extract", keybinding: { getLabel: () => "Ctrl+." } },
      { kind: "separator" },
    ],
    (i) => picked.push(i),
  );
  assert.deepEqual(
    items.map(({ run: _run, ...rest }) => rest),
    [
      { label: "Add missing function" },
      { label: "Ignore", disabled: true },
      { label: "Extract", keybinding: "Ctrl+.", separatorBefore: true },
    ],
  );
  items[2]?.run();
  assert.deepEqual(picked, ["c"]);
});

test("code action menu service: a pick applies, a dismissal reports a cancel", async () => {
  let current: { items: readonly { run(): void }[]; onClose: () => void } | null = null;
  const service = new MenuActionWidgetService({
    showMenu: (_at, items, onClose) => {
      current = { items, onClose };
      return { dispose: () => onClose() };
    },
  });
  const log: string[] = [];
  const delegate = {
    onSelect: (item: unknown) => {
      log.push(`select ${String(item)}`);
      service.hide(false); // what Monaco's controller does
    },
    onHide: (cancel?: boolean) => log.push(`hide ${cancel}`),
  };
  const rows = [{ kind: "action" as const, item: "a", label: "Fix" }];
  service.show("w", true, rows, delegate, { x: 1, y: 2 });
  assert.equal(service.isVisible, true);
  // Like the IDE menu: it closes, then runs the item.
  const picked = current as unknown as { items: { run(): void }[]; onClose: () => void };
  picked.onClose();
  picked.items[0]?.run();
  await Promise.resolve();
  assert.deepEqual(log, ["select a"]);
  assert.equal(service.isVisible, false);
  log.length = 0;
  service.show("w", true, rows, delegate, { x: 1, y: 2 });
  service.hide(true);
  await Promise.resolve();
  assert.deepEqual(log, ["hide true"]);
  log.length = 0;
  service.show("w", true, [], delegate, { x: 0, y: 0 });
  assert.equal(service.isVisible, false, "nothing to show: no menu");
});
