import assert from "node:assert/strict";
import { test } from "node:test";
import { workspaceFileSchema } from "./workspaceFileSchema";

test("the workspace file's schema: folders, settings, launch, tasks, extensions", () => {
  const settings = { type: "object", properties: { "editor.tabSize": { type: "number" } } };
  const schema = workspaceFileSchema(settings) as {
    required: string[];
    properties: Record<string, Record<string, unknown>>;
    additionalProperties: boolean;
  };
  assert.deepEqual(schema.required, ["folders"]);
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "extensions",
    "folders",
    "launch",
    "remoteAuthority",
    "settings",
    "tasks",
  ]);
  const folders = schema.properties.folders as {
    items: { properties: Record<string, unknown> };
  };
  assert.ok(folders.items.properties.path && folders.items.properties.name);
  // The workspace settings schema, as given.
  assert.deepEqual(schema.properties.settings?.properties, settings.properties);
  assert.equal(schema.additionalProperties, false);
});
