import assert from "node:assert/strict";
import { test } from "node:test";
import { manifestSchema } from "../../core/extensions/manifestSchema";
import { parseManifest } from "../../core/extensions/thirdParty";
import { EXAMPLES, exampleText } from "./examples";
import { guideSections } from "./moreCommands";

test("extension examples: every manifest loads, and the files it names are there (D191)", () => {
  assert.equal(EXAMPLES.length, 6);
  for (const e of EXAMPLES) {
    const json = JSON.parse(e.files["extension.json"] ?? "null");
    const m = parseManifest(json, "extension.json");
    if (m.main) assert.ok(e.files[m.main], `${e.name}: ${m.main}`);
    for (const v of m.contributes.views)
      if (v.path) assert.ok(e.files[v.path], `${e.name}: ${v.path}`);
    for (const v of m.contributes.viewers)
      if (v.path) assert.ok(e.files[v.path], `${e.name}: ${v.path}`);
    assert.match(exampleText(e), /```json/);
  }
});

test("manifestSchema: describes the fields the parser reads", () => {
  const schema = manifestSchema() as { properties: Record<string, unknown> };
  for (const key of ["id", "version", "displayName", "main", "icon", "screenshots", "contributes"])
    assert.ok(key in schema.properties, key);
  const contributes = schema.properties.contributes as { properties: Record<string, unknown> };
  for (const key of ["commands", "views", "menus", "viewers", "settings", "mcpServers"])
    assert.ok(key in contributes.properties, key);
});

test("guideSections: a table of contents from the ## headings", () => {
  const md =
    "# Guide\nIntro text. More.\n\n## extension.json (D1)\nThe manifest. Fields.\n\n## Code\nmain.js runs in a worker.\n";
  const s = guideSections(md);
  assert.deepEqual(
    s.map((x) => [x.id, x.title, x.lead]),
    [
      ["overview", "Overview", "Intro text."],
      ["extension.json", "extension.json", "The manifest."],
      ["code", "Code", "main.js runs in a worker."],
    ],
  );
});
