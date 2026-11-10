import assert from "node:assert/strict";
import { test } from "node:test";
import { commandCallerKind, commandInputSchema } from "./commandInput";

test("commandInputSchema: a JSON Schema becomes a validating dispatcher schema", () => {
  const { schema, error } = commandInputSchema({
    type: "object",
    description: "Run a cell",
    properties: {
      path: { type: "string", description: "The notebook" },
      index: { type: "integer", minimum: 0 },
      mode: { enum: ["all", "one"] },
      tags: { type: "array", items: { type: "string" } },
      options: { type: "object", properties: { echo: { type: "boolean" } } },
    },
    required: ["path"],
  });
  assert.equal(error, undefined);
  assert.equal(schema.json.type, "object");
  assert.equal(schema.json.description, "Run a cell");
  assert.deepEqual(schema.json.required, ["path"]);
  assert.equal(schema.json.properties?.path?.description, "The notebook");
  assert.ok(schema.validate({ path: "a.ipynb", index: 2, mode: "one", tags: ["x"] }).ok);
  assert.ok(schema.validate({ path: "a.ipynb", options: { echo: true } }).ok);
  assert.equal(schema.validate({}).ok, false); // path is required
  assert.equal(schema.validate({ path: "a", index: 1.5 }).ok, false);
  assert.equal(schema.validate({ path: "a", index: -1 }).ok, false);
  assert.equal(schema.validate({ path: "a", mode: "some" }).ok, false);
  assert.equal(schema.validate({ path: "a", tags: [1] }).ok, false);
  // Unknown keys are refused (agents' typos), unless the schema allows them.
  assert.equal(schema.validate({ path: "a", pth: "b" }).ok, false);
  const open = commandInputSchema({
    type: "object",
    properties: { path: { type: "string" } },
    additionalProperties: true,
  }).schema;
  assert.ok(open.validate({ path: "a", other: 1 }).ok);
  assert.equal(open.validate({ path: 3 }).ok, false);
  assert.equal(open.json.additionalProperties, true);
});

test("commandInputSchema: no schema or an invalid one takes any input, with the reason", () => {
  assert.equal(commandInputSchema(undefined).error, undefined);
  assert.ok(commandInputSchema(undefined).schema.validate("anything").ok);
  for (const bad of [
    { type: "string" },
    { type: "object", properties: { a: { type: "date" } } },
    { type: "object", properties: { a: { enum: [] } } },
    { type: "object", properties: {}, required: ["missing"] },
    { type: "object", properties: { a: { type: "array", items: 3 } } },
    { type: "object", additionalProperties: { type: "string" } },
    "object",
  ]) {
    const { schema, error } = commandInputSchema(bad);
    assert.ok(error, JSON.stringify(bad));
    assert.ok(schema.validate({ x: 1 }).ok);
  }
  // Too deep.
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 12; i++) deep = { type: "object", properties: { a: deep } };
  assert.match(commandInputSchema(deep).error ?? "", /deep/);
});

test("commandCallerKind: what a handler is told about who ran it", () => {
  assert.equal(commandCallerKind({ kind: "user" }), "user");
  assert.equal(commandCallerKind({ kind: "test" }), "user");
  assert.equal(commandCallerKind({ kind: "agent", session: "s" }), "agent");
  assert.equal(commandCallerKind({ kind: "mcp", client: "c" }), "agent");
  assert.equal(commandCallerKind({ kind: "acp", agent: "a", session: "s" }), "agent");
  assert.equal(commandCallerKind({ kind: "ext", id: "a.b" }), "extension");
});
