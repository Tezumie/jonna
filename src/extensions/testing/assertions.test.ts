import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fromJestFailureDetails,
  fromMessage,
  fromTapYaml,
  fromValues,
  valueText,
} from "./assertions";

test("fromValues / valueText: strings as they are, the rest as JSON", () => {
  assert.deepEqual(fromValues({ expected: 2, actual: 1 }), { expected: "2", actual: "1" });
  assert.deepEqual(fromValues({ expected: { a: [1] }, actual: "x" }), {
    expected: '{\n  "a": [\n    1\n  ]\n}',
    actual: "x",
  });
  assert.equal(fromValues({ expected: 1 }), null, "both are needed");
  assert.equal(fromValues({ expected: 1, actual: 1 }), null, "nothing to compare");
  assert.equal(valueText(undefined), "undefined");
});

test("fromJestFailureDetails: the matcher's values", () => {
  assert.deepEqual(
    fromJestFailureDetails([{}, { matcherResult: { actual: "a", expected: "b", pass: false } }]),
    { expected: "b", actual: "a" },
  );
  assert.equal(fromJestFailureDetails([{ message: "x" }]), null);
  assert.equal(fromJestFailureDetails(undefined), null);
});

test("fromMessage: Jest / Vitest '- Expected + Received' diffs", () => {
  const jest = `Error: expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 1

  Object {
-   "a": 2,
+   "a": 1,
  }
    at Object.<anonymous> (/w/a.test.js:4:13)`;
  assert.deepEqual(fromMessage(jest), {
    expected: 'Object {\n  "a": 2,\n}',
    actual: 'Object {\n  "a": 1,\n}',
  });
  const vitest =
    "AssertionError: expected 1 to be 2 // Object.is equality\n\n- Expected\n+ Received\n\n- 2\n+ 1\n\n ❯ a.test.ts:4:15";
  assert.deepEqual(fromMessage(vitest), { expected: "2", actual: "1" });
});

test("fromMessage: 'Expected: / Received:' lines (Jest's toBe, Playwright)", () => {
  assert.deepEqual(
    fromMessage(
      'expect(received).toBe(expected) // Object.is equality\n\nExpected: "b"\nReceived: "a"\n\n    at x',
    ),
    { expected: "b", actual: "a" },
  );
  assert.deepEqual(
    fromMessage(
      'Error: expect(page).toHaveTitle(expected)\n\nExpected pattern: /Playwright/\nReceived string:  "Example"\nCall log:',
    ),
    { expected: "/Playwright/", actual: "Example" },
  );
});

test("fromMessage: Node's assert diff", () => {
  const node =
    "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:\n+ actual - expected\n\n  {\n+   a: 1,\n-   a: 2,\n    b: 3\n  }\n\n    at TestContext.<anonymous>";
  assert.deepEqual(fromMessage(node), {
    expected: "{\n  a: 2,\n  b: 3\n}",
    actual: "{\n  a: 1,\n  b: 3\n}",
  });
});

test("fromMessage: pytest's assertion rewriting", () => {
  const simple = `    def test_add():
>       assert add(1, 1) == 3
E       assert 2 == 3
E        +  where 2 = add(1, 1)

test_calc.py:4: AssertionError`;
  assert.deepEqual(fromMessage(simple), { expected: "3", actual: "2" });
  const full = `E       AssertionError: assert [1, 2] == [1, 3]
E
E         At index 1 diff: 2 != 3
E
E         Full diff:
E           [
E               1,
E         -     3,
E         ?     ^
E         +     2,
E         ?     ^
E           ]`;
  assert.deepEqual(fromMessage(full), {
    expected: "[\n    1,\n    3,\n]",
    actual: "[\n    1,\n    2,\n]",
  });
  assert.deepEqual(fromMessage("E       assert 'ab' == 'ac'"), { expected: "ac", actual: "ab" });
});

test("fromMessage: unittest's 'first != second'", () => {
  assert.deepEqual(
    fromMessage(
      'Traceback (most recent call last):\n  File "t.py", line 5, in test_a\n    self.assertEqual(1, 2)\nAssertionError: 1 != 2',
    ),
    { expected: "2", actual: "1" },
  );
  assert.deepEqual(fromMessage("AssertionError: 'a' != 'b' : custom"), {
    expected: "b",
    actual: "a",
  });
  assert.equal(fromMessage("TypeError: x is not a function"), null);
});

test("fromTapYaml: node:test's expected / actual (scalars, blocks, maps)", () => {
  assert.deepEqual(fromTapYaml("expected: 2\nactual: 1\noperator: 'strictEqual'"), {
    expected: "2",
    actual: "1",
  });
  assert.deepEqual(
    fromTapYaml("expected: |-\n  hello\n  there\nactual: |-\n  hello\n  world\noperator: x"),
    { expected: "hello\nthere", actual: "hello\nworld" },
  );
  assert.deepEqual(
    fromTapYaml(
      "expected:\n  a: 2\n  b:\n    0: 1\nactual:\n  a: 1\n  b:\n    0: 1\nstack: |-\n  x",
    ),
    { expected: "a: 2\nb:\n  0: 1", actual: "a: 1\nb:\n  0: 1" },
  );
  assert.deepEqual(fromTapYaml("expected: 'it''s'\nactual: \"no\""), {
    expected: "it's",
    actual: "no",
  });
  assert.equal(fromTapYaml("error: 'boom'"), null);
});
