// Every icon name the code may ask for is drawn in the sprite (D420): a name in `IconName`
// with no symbol draws nothing, silently, as the composer's Send did.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("icons: every IconName has a symbol in the sprite, and the other way round", () => {
  const source = readFileSync("src/ui/Icon.ts", "utf8");
  const start = source.indexOf("export type IconName");
  const names = [...source.slice(start, source.indexOf(";", start)).matchAll(/\| "([a-z0-9-]+)"/g)]
    .map((m) => m[1] ?? "")
    .sort();
  const sprite = readFileSync("src/ui/icons/sprite.svg", "utf8");
  const symbols = [...sprite.matchAll(/id="i-([a-z0-9-]+)"/g)].map((m) => m[1] ?? "").sort();
  assert.ok(names.length > 100);
  assert.deepEqual(
    names.filter((n) => !symbols.includes(n)),
    [],
    "names without a symbol: add them to scripts/build-icons.mjs and run it",
  );
  assert.deepEqual(
    symbols.filter((s) => !names.includes(s)),
    [],
    "symbols without a name in IconName",
  );
});
