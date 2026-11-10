// D323 (agent-prwatch-m7-68.jsonc): sets what the fake GitHub CLI says about pull request #7
// (../fake-github/pr.json, read by tests/fixtures/fake-gh/gh.mjs). Run from the sample folder:
// `node ../setup/prwatch-m7-68.mjs pending|failing|merged`.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const phase = process.argv[2] ?? "pending";
const base = join(resolve(process.cwd(), ".."), "fake-github");
const check = (name, conclusion) =>
  conclusion
    ? { name, status: "COMPLETED", conclusion }
    : { name, status: "IN_PROGRESS", conclusion: null };

const phases = {
  // Watched from here: the build passed, the tests still run.
  pending: {
    view: {
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [check("build", "SUCCESS"), check("test", null)],
      comments: [],
    },
  },
  // The tests failed and a reviewer asked for a test.
  failing: {
    view: {
      state: "OPEN",
      mergeable: "MERGEABLE",
      statusCheckRollup: [check("build", "SUCCESS"), check("test", "FAILURE")],
      comments: [],
    },
    threads: [
      {
        id: "PRRT_fake2",
        isResolved: false,
        isOutdated: false,
        path: "README.md",
        line: 2,
        originalLine: 2,
        startLine: null,
        diffSide: "RIGHT",
        comments: {
          nodes: [
            {
              databaseId: 301,
              body: "Please add a test for this.",
              createdAt: "2026-01-04T10:00:00Z",
              url: "https://github.com/tester/sample/pull/7#discussion_r301",
              author: { login: "reviewer" },
            },
          ],
        },
      },
    ],
  },
  merged: {
    view: {
      state: "MERGED",
      mergeable: "UNKNOWN",
      statusCheckRollup: [check("build", "SUCCESS"), check("test", "SUCCESS")],
      comments: [],
    },
  },
};

if (!phases[phase]) {
  console.error(`unknown phase ${phase}`);
  process.exit(1);
}
mkdirSync(base, { recursive: true });
writeFileSync(join(base, "pr.json"), JSON.stringify(phases[phase]));
console.log(`pull request #7: ${phase}`);
