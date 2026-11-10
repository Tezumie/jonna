import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendNote,
  dreamPrompt,
  isMemoryFile,
  linksIn,
  looksSecret,
  memoryIndex,
  noteLine,
  notesIn,
  notesOfType,
  noteTypes,
  parseDream,
  parseNote,
  replaceNote,
  searchMemory,
  topicFile,
} from "./memory";

test("topicFile makes safe names", () => {
  assert.equal(topicFile("Testing & CI"), "testing-ci.md");
  assert.equal(topicFile("../../etc/passwd"), "etc-passwd.md");
  assert.equal(topicFile("deploy.md"), "deploy.md");
  assert.equal(topicFile("!!!"), "notes.md");
  assert.ok(isMemoryFile("deploy.md"));
  assert.ok(!isMemoryFile(".hidden.md"));
  assert.ok(!isMemoryFile("a/b.md"));
});

test("appendNote: new file gets a heading; duplicates are skipped", () => {
  const line = noteLine("Run tests with  npm test", "2026-10-18", "session-abcdef123");
  assert.equal(line, "- Run tests with npm test _(2026-10-18, session def123)_");
  const first = appendNote(null, "Testing", line);
  assert.equal(first, `# Testing\n\n${line}\n`);
  const again = appendNote(
    first,
    "Testing",
    noteLine("run tests with npm test", "2026-10-19", "x"),
  );
  assert.equal(again, null);
  const second = appendNote(first, "Testing", "- Use --runInBand on CI");
  assert.equal(second, `# Testing\n\n${line}\n- Use --runInBand on CI\n`);
});

test("looksSecret catches keys and passwords, not ordinary notes", () => {
  assert.ok(looksSecret("the key is sk-abcdefghijklmnopqrstuv"));
  assert.ok(looksSecret("password: hunter2hunter2"));
  assert.ok(looksSecret("ghp_abcdefghijklmnopqrstuvwxyz0123"));
  assert.ok(!looksSecret("Run npm test; the token parser lives in src/lex.ts"));
});

test("memoryIndex lists topics with a preview, names only past the limit", () => {
  const files = [
    { name: "testing.md", text: "# Testing\n\n- npm test _(d, session s)_\n- Use node 22\n" },
    { name: "deploy.md", text: "# Deploy\n\n- make ship, not ./deploy.sh\n" },
  ];
  const index = memoryIndex(files);
  assert.match(index, /^- deploy\.md — Deploy \(1 note\)\n {4}· make ship/);
  assert.match(index, /- testing\.md — Testing \(2 notes\)\n {4}· npm test\n/);
  const small = memoryIndex(files, 40);
  assert.ok(small.includes("- testing.md — Testing (2 notes)"));
  assert.ok(!small.includes("· npm test"));
});

test("a note's why goes with it, and the index shows only the fact (D270)", () => {
  const line = noteLine("Don't push to main", "2026-11-03", "s-123456", "they merge\n  it");
  assert.equal(line, "- Don't push to main — why: they merge it _(2026-11-03, session 123456)_");
  // The same fact with another why isn't added twice.
  const text = appendNote(null, "Git", line) ?? "";
  assert.equal(appendNote(text, "Git", noteLine("don't push to main", "d", "s", "other")), null);
  assert.match(memoryIndex([{ name: "git.md", text }]), /· Don't push to main$/);
});

test("replaceNote updates or removes the first note with those words (D270)", () => {
  const text = "# Build\n\n- Build with make _(d, session a)_\n- Lint with biome\n";
  assert.equal(
    replaceNote(text, "BUILD   with", "- Build with npm run build _(e, session b)_"),
    "# Build\n\n- Build with npm run build _(e, session b)_\n- Lint with biome\n",
  );
  assert.equal(
    replaceNote(text, "lint with", null),
    "# Build\n\n- Build with make _(d, session a)_\n",
  );
  // Only notes match, not the heading; nothing matching: null.
  assert.equal(replaceNote(text, "# Build", null), null);
  assert.equal(replaceNote(text, "cargo", null), null);
  assert.equal(replaceNote(text, "  ", null), null);
});

test("searchMemory matches every word", () => {
  const files = [{ name: "a.md", text: "- Tests run with npm test\n- Lint with biome\n" }];
  assert.deepEqual(searchMemory(files, "NPM tests"), [
    { name: "a.md", line: "- Tests run with npm test" },
  ]);
  assert.deepEqual(searchMemory(files, "cargo"), []);
});

test("parseDream reads files and deletes", () => {
  const out = `<think>hmm</think>Here you go:
=== file: Testing.md ===
\`\`\`markdown
# Testing
- npm test
\`\`\`
=== file: deploy.md ===
# Deploy
- make ship
=== delete: old-notes.md ===
=== delete: deploy.md ===`;
  const r = parseDream(out);
  assert.deepEqual(
    r.files.map((f) => f.name),
    ["testing.md", "deploy.md"],
  );
  assert.equal(r.files[0]?.text, "# Testing\n- npm test\n");
  // A file both written and deleted is kept.
  assert.deepEqual(r.deletes, ["old-notes.md"]);
  assert.throws(() => parseDream("I tidied it up!"), /no memory files/);
});

test("dreamPrompt includes memory, sessions and focus", () => {
  const p = dreamPrompt(
    [{ name: "a.md", text: "# A\n- x" }],
    [{ title: "Fix", text: "USER: hi" }],
    "tests",
  );
  assert.ok(p.includes('<file name="a.md">'));
  assert.ok(p.includes('<session title="Fix">'));
  assert.ok(p.includes("Pay special attention to: tests"));
});

test("typed notes: a [type] tag, **Why:** and **How to apply:** on one line (D315)", () => {
  const line = noteLine(
    "Integration tests hit a real database",
    "2026-11-06",
    "s-abcdef",
    "mocks hid a broken migration",
    {
      type: "feedback",
      how: "tests/int uses the test container",
    },
  );
  assert.equal(
    line,
    "- [feedback] Integration tests hit a real database — **Why:** mocks hid a broken migration — **How to apply:** tests/int uses the test container _(2026-11-06, session abcdef)_",
  );
  assert.deepEqual(parseNote(line), {
    type: "feedback",
    fact: "Integration tests hit a real database",
    why: "mocks hid a broken migration",
    how: "tests/int uses the test container",
  });
  // Older notes read as before: no type, the why after " — why: ".
  assert.deepEqual(parseNote("- Don't push to main — why: they merge it _(d, session a)_"), {
    fact: "Don't push to main",
    why: "they merge it",
  });
  assert.deepEqual(parseNote("- [unknown] tag stays text"), { fact: "[unknown] tag stays text" });
  // The same fact typed or not is the same note.
  const text = appendNote(null, "Testing", line) ?? "";
  assert.equal(appendNote(text, "Testing", "- integration tests hit a real database"), null);
  // The index counts the kinds and tags the preview.
  const index = memoryIndex([
    { name: "testing.md", text: `${text}- Use node 22\n- [project] Freeze on 2026-12-01\n` },
  ]);
  assert.match(
    index,
    /^- testing\.md — Testing \(3 notes: 1 feedback, 1 project\)\n {4}· \[feedback\] Integration tests/,
  );
  assert.deepEqual(
    notesOfType([{ name: "testing.md", text: `${text}- [project] Freeze` }], "project"),
    [{ name: "testing.md", line: "- [project] Freeze" }],
  );
});

test("[[topic]] links between topics (D315)", () => {
  assert.deepEqual(noteTypes("- [feedback] a\n- [feedback] b\n- c\n- [reference] d"), {
    feedback: 2,
    reference: 1,
  });
  assert.deepEqual(linksIn("- See [[Testing & CI]] and [[deploy]], [[deploy]]"), [
    "testing-ci.md",
    "deploy.md",
  ]);
  assert.deepEqual(linksIn("no links [here]"), []);
});

test("the tidy-up keeps types, why / how and links", () => {
  const p = dreamPrompt([{ name: "a.md", text: "# A\n- [feedback] x" }], []);
  assert.match(p, /type tag/);
  assert.match(p, /\*\*How to apply:\*\*/);
  assert.match(p, /already records/);
  const r = parseDream(
    "=== file: a.md ===\n# A\n- [feedback] x — **Why:** y — **How to apply:** z",
  );
  assert.equal(parseNote(notesIn(r.files[0]?.text ?? "")[0] ?? "").how, "z");
});
