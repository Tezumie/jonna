// D352 (agent-automerge-m7-94.jsonc): sets what the fake GitHub CLI says about pull request #7
// (../fake-github/pr.json, read by tests/fixtures/fake-gh/gh.mjs): a repository that doesn't allow
// GitHub's auto-merge (so the IDE merges it), no review required, the tests still running
// ("pending") or passed ("passing"). Run from the sample folder:
// `node ../setup/automerge-m7-94.mjs pending|passing`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const phase = process.argv[2] ?? "pending";
const base = join(resolve(process.cwd(), ".."), "fake-github");
const check = (name, conclusion) =>
  conclusion
    ? { name, status: "COMPLETED", conclusion }
    : { name, status: "IN_PROGRESS", conclusion: null };
const view = (tests) => ({
  state: "OPEN",
  mergeable: "MERGEABLE",
  mergeStateStatus: tests ? "CLEAN" : "BLOCKED",
  reviewDecision: "",
  isDraft: false,
  autoMergeRequest: null,
  statusCheckRollup: [check("build", "SUCCESS"), check("test", tests)],
  comments: [],
});
const phases = {
  pending: { repo: { autoMergeAllowed: false }, view: view(null) },
  passing: { repo: { autoMergeAllowed: false }, view: view("SUCCESS") },
};

if (!phases[phase]) {
  console.error(`unknown phase ${phase}`);
  process.exit(1);
}
mkdirSync(base, { recursive: true });
writeFileSync(join(base, "pr.json"), JSON.stringify(phases[phase]));
console.log(`pull request #7: ${phase}`);
