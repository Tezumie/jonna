import assert from "node:assert/strict";
import { test } from "node:test";
import { autofetchPeriod, restartsAutofetch } from "./autofetch";

test("only the autofetch settings restart its timer", () => {
  assert.equal(restartsAutofetch(["git.autofetch"]), true);
  assert.equal(restartsAutofetch(["editor.fontSize", "git.autofetchPeriod"]), true);
  assert.equal(restartsAutofetch(["workbench.colorTheme"]), false);
  assert.equal(restartsAutofetch(["git.graph.allBranches"]), false);
  assert.equal(restartsAutofetch([]), false);
});

test("git.autofetchPeriod: default 180 s, at least 30", () => {
  assert.equal(autofetchPeriod(undefined), 180);
  assert.equal(autofetchPeriod(5), 30);
  assert.equal(autofetchPeriod(600), 600);
  assert.equal(autofetchPeriod(Number.NaN), 180);
});
