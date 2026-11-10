import assert from "node:assert/strict";
import { test } from "node:test";
import { agentDraftPrompt, draftFaceCode, parseAgentDraft } from "./agentDraft";
import { parseFace } from "./faces";

test("an agent drafted from a description (D245)", () => {
  const reply = [
    "Here it is:",
    "```json",
    JSON.stringify({
      label: "Migration helper",
      role: "Database migrations",
      description: "Writes and checks schema migrations. Use when the database changes.",
      instructions: "You write migrations.\n\n- Read the schema first.",
      access: "full",
    }),
    "```",
  ].join("\n");
  const draft = parseAgentDraft(reply);
  assert.deepEqual(draft, {
    label: "Migration helper",
    role: "Database migrations",
    description: "Writes and checks schema migrations. Use when the database changes.",
    instructions: "You write migrations.\n\n- Read the schema first.",
    access: "full",
  });
  // An unknown access reads as the safest; no name or description is no draft.
  assert.equal(parseAgentDraft('{"label":"A","description":"B","access":"root"}')?.access, "read");
  assert.equal(parseAgentDraft('{"label":"A"}'), null);
  assert.equal(parseAgentDraft("no json here"), null);
  assert.equal(parseAgentDraft("{not json}"), null);
  assert.match(
    agentDraftPrompt(" reviews SQL ", ["planner"]),
    /reviews SQL\n\nNames already taken.*planner/,
  );
  assert.ok(parseFace(draftFaceCode("Migration helper")), "a valid face code");
});
