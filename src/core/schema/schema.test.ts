import assert from "node:assert/strict";
import { test } from "node:test";
import { formatIssues, type Infer, s } from "./index";

const editSchema = s.object({
  path: s.string({ minLength: 1 }).describe("Absolute file path"),
  line: s.integer({ min: 1 }).optional(),
  mode: s.enum(["insert", "replace"] as const),
  tags: s.array(s.string()).optional(),
});

test("infers TS types (compile-time) and emits JSON Schema", () => {
  type Edit = Infer<typeof editSchema>;
  const sample: Edit = { path: "/a", mode: "insert" }; // line/tags optional
  const withAll: Edit = { path: "/a", mode: "replace", line: 3, tags: ["x"] };
  assert.ok(sample && withAll);
  assert.deepEqual(editSchema.json, {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "Absolute file path" },
      line: { type: "integer", minimum: 1 },
      mode: { enum: ["insert", "replace"] },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["path", "mode"],
    additionalProperties: false,
  });
});

test("validates good input", () => {
  const result = editSchema.validate({ path: "/x", mode: "insert", line: 2, tags: [] });
  assert.equal(result.ok, true);
});

test("reports every issue with a path", () => {
  const result = editSchema.validate({ path: "", line: 1.5, mode: "delete", extra: 1, tags: [1] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  const paths = result.issues.map((i) => i.path).sort();
  assert.deepEqual(paths, ["/extra", "/line", "/mode", "/path", "/tags/0"]);
  assert.match(formatIssues(result.issues), /\/extra: unknown property/);
});

test("missing required, wrong root type, optional undefined", () => {
  const missing = editSchema.validate({ mode: "insert" });
  assert.equal(missing.ok, false);
  assert.equal(editSchema.validate(null).ok, false);
  assert.equal(s.string().optional().validate(undefined).ok, true);
  assert.equal(s.empty().validate({}).ok, true);
  assert.equal(s.empty().validate({ a: 1 }).ok, false);
  assert.equal(s.number({ max: 3 }).validate(4).ok, false);
  assert.equal(s.number().validate(Number.NaN).ok, false);
  assert.equal(s.boolean().validate("true").ok, false);
});

test("union accepts any listed shape and explains failures", () => {
  const where = s.union(
    s.enum(["main", "bottom"] as const),
    s.object({ groupId: s.string(), index: s.integer().optional() }),
  );
  assert.equal(where.validate("main").ok, true);
  assert.equal(where.validate({ groupId: "g1" }).ok, true);
  const bad = where.validate({ groupId: 3 });
  assert.equal(bad.ok, false);
  assert.ok(where.json.anyOf?.length === 2);
});

test("object: keys inherited from Object.prototype are still unknown properties", () => {
  const schema = s.object({ name: s.string() });
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const input = JSON.parse(`{ "name": "a", "${key}": 1 }`) as unknown;
    const result = schema.validate(input);
    assert.equal(result.ok, false, key);
  }
});
