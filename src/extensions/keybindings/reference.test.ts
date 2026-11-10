import assert from "node:assert/strict";
import { test } from "node:test";
import { effectiveBindings } from "../../core/keybindings/effective";
import { buildReference, referenceText } from "./reference";

const rules = [
  { key: "ctrl+shift+p", mac: "cmd+shift+p", command: "palette.show", source: "default" as const },
  { key: "f1", command: "palette.show", source: "default" as const },
  { key: "ctrl+b", mac: "cmd+b", command: "layout.toggleSidebar", source: "default" as const },
  // The user moved the side bar to another key and removed the default.
  { key: "ctrl+b", command: "-layout.toggleSidebar", source: "user" as const },
  { key: "ctrl+alt+b", command: "layout.toggleSidebar", source: "user" as const },
];

test("shortcuts reference: this platform's keys, the user's changes, editor keys", () => {
  const pc = buildReference(effectiveBindings(rules, "windows"), "windows");
  const general = pc.find((s) => s.title === "General");
  assert.deepEqual(general?.rows[0], { label: "Show all commands", keys: ["Ctrl+Shift+P", "F1"] });
  const display = pc.find((s) => s.title === "Display");
  assert.deepEqual(display?.rows, [{ label: "Toggle side bar", keys: ["Ctrl+Alt+B"] }]);
  const editing = pc.find((s) => s.title === "Basic editing");
  assert.ok(editing?.rows.some((r) => r.label === "Toggle line comment" && r.keys[0] === "Ctrl+/"));
  // Sections with no bound command and no editor keys are left out.
  assert.equal(
    pc.find((s) => s.title === "Debug"),
    undefined,
  );
  const mac = buildReference(effectiveBindings(rules, "mac"), "mac");
  const macEditing = mac.find((s) => s.title === "Basic editing");
  assert.ok(macEditing?.rows.some((r) => r.label === "Delete line" && r.keys[0] === "⇧⌘K"));
  assert.match(referenceText(pc), /General\n {2}Ctrl\+Shift\+P or F1 {2}Show all commands/);
});

test("shortcuts reference: unregistered commands are left out", () => {
  const sections = buildReference(effectiveBindings(rules, "linux"), "linux", {
    has: (c) => c !== "palette.show",
  });
  assert.equal(
    sections.find((s) => s.title === "General"),
    undefined,
  );
});
