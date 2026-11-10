import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptContent,
  type ElicitField,
  elicitFields,
  fieldPrompt,
  parseFieldValue,
} from "./elicitation";

test("a requested schema becomes fields", () => {
  const fields = elicitFields({
    type: "object",
    properties: {
      name: { type: "string", title: "Your name", minLength: 2 },
      age: { type: "integer", minimum: 0, maximum: 150 },
      ok: { type: "boolean", default: true },
      color: { type: "string", enum: ["r", "g"], enumNames: ["Red", "Green"] },
      size: {
        type: "string",
        oneOf: [
          { const: "s", title: "Small" },
          { const: "l", title: "Large" },
        ],
      },
      email: { type: "string", format: "email", description: "For the receipt" },
    },
    required: ["name", "color"],
  });
  assert.deepEqual(
    fields.map((f) => [f.name, f.kind, f.required]),
    [
      ["name", "string", true],
      ["age", "integer", false],
      ["ok", "boolean", false],
      ["color", "enum", true],
      ["size", "enum", false],
      ["email", "string", false],
    ],
  );
  assert.deepEqual(fields[3]?.options, [
    { value: "r", label: "Red" },
    { value: "g", label: "Green" },
  ]);
  assert.equal(fields[4]?.options?.[1]?.label, "Large");
  assert.equal(fieldPrompt(fields[1] as ElicitField), "age (0 to 150, optional)");
  assert.equal(fieldPrompt(fields[5] as ElicitField), "email (email, optional): For the receipt");
  assert.throws(() => elicitFields({ properties: { x: { type: "object" } } }), /simple value/);
});

test("typed values are checked", () => {
  const fields = elicitFields({
    properties: {
      name: { type: "string", minLength: 2 },
      age: { type: "integer", minimum: 0, maximum: 150 },
      ok: { type: "boolean" },
      color: { type: "string", enum: ["r", "g"], enumNames: ["Red", "Green"] },
      email: { type: "string", format: "email" },
    },
    required: ["name"],
  });
  const [name, age, ok, color, email] = fields as [
    ElicitField,
    ElicitField,
    ElicitField,
    ElicitField,
    ElicitField,
  ];
  assert.ok(parseFieldValue(name, "").error);
  assert.ok(parseFieldValue(name, "A").error);
  assert.deepEqual(parseFieldValue(name, " Ada "), { value: "Ada" });
  assert.deepEqual(parseFieldValue(age, ""), {});
  assert.ok(parseFieldValue(age, "1.5").error);
  assert.ok(parseFieldValue(age, "200").error);
  assert.deepEqual(parseFieldValue(age, "42"), { value: 42 });
  assert.deepEqual(parseFieldValue(ok, "yes"), { value: true });
  assert.deepEqual(parseFieldValue(ok, "No"), { value: false });
  assert.deepEqual(parseFieldValue(color, "green"), { value: "g" });
  assert.ok(parseFieldValue(color, "blue").error);
  assert.ok(parseFieldValue(email, "nope").error);
  assert.deepEqual(acceptContent([name, age], { name: "Ada", age: undefined }), {
    action: "accept",
    content: { name: "Ada" },
  });
  assert.throws(() => acceptContent([name], {}), /required/);
});
