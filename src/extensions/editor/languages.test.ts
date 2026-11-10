import assert from "node:assert/strict";
import { test } from "node:test";
import {
  associatedLanguage,
  detectLanguage,
  firstLineOf,
  languageForPath,
  parseFileAssociations,
  setContributedLanguages,
  setFileAssociations,
} from "./languages";

test("detectLanguage: VS Code's order — name, pattern, extension, first line", () => {
  const langs = [
    { id: "python", extensions: [".py"], firstLine: "^#!\\s*/?.*\\bpython[0-9.-]*\\b" },
    { id: "plaintext-like", extensions: [".txt"] },
    { id: "jsonc", extensions: [".jsonc"], filenames: ["tsconfig.json"] },
    { id: "json", extensions: [".json"] },
    // ms-python's pip requirements (filenamePatterns), registered later.
    {
      id: "pip-requirements",
      extensions: [".pip"],
      filenamePatterns: ["*requirements*.txt", "requirements/*.in"],
    },
    { id: "typescript", extensions: [".ts"] },
    { id: "typescript-defs", extensions: [".d.ts"] },
  ];
  assert.equal(detectLanguage("/p/requirements.txt", langs), "pip-requirements");
  assert.equal(detectLanguage("C:\\p\\dev-requirements.txt", langs), "pip-requirements");
  assert.equal(detectLanguage("/p/REQUIREMENTS.TXT", langs), "pip-requirements");
  assert.equal(detectLanguage("/p/requirements/base.in", langs), "pip-requirements");
  assert.equal(detectLanguage("/p/notes.txt", langs), "plaintext-like");
  // A file name beats an extension, case aside.
  assert.equal(detectLanguage("/p/TSConfig.json", langs), "jsonc");
  assert.equal(detectLanguage("/p/a.json", langs), "json");
  // The longest extension wins.
  assert.equal(detectLanguage("/p/x.d.ts", langs), "typescript-defs");
  assert.equal(detectLanguage("/p/x.ts", langs), "typescript");
  // The first line only when nothing else decides.
  assert.equal(detectLanguage("/p/run", langs, "#!/usr/bin/env python3"), "python");
  assert.equal(detectLanguage("/p/run", langs, "\uFEFF#!/usr/bin/python"), "python");
  assert.equal(detectLanguage("/p/run.json", langs, "#!/usr/bin/env python3"), "json");
  assert.equal(detectLanguage("/p/run", langs, "echo hi"), "plaintext");
  // A later registration wins a tie.
  const tie = [
    { id: "a", extensions: [".x"] },
    { id: "b", extensions: [".x"] },
  ];
  assert.equal(detectLanguage("/p/a.x", tie), "b");
  // A broken firstLine RegExp is ignored.
  assert.equal(
    detectLanguage("/p/run", [{ id: "bad", extensions: [], firstLine: "(" }], "("),
    "plaintext",
  );
});

test("languageForPath: shebangs of the built-in languages, contributed patterns", () => {
  assert.equal(languageForPath("/p/script", "#!/bin/bash"), "shellscript");
  assert.equal(languageForPath("/p/script", "#!/usr/bin/env node"), "javascript");
  assert.equal(languageForPath("/p/script", "#!/usr/bin/env python"), "python");
  assert.equal(languageForPath("/p/script"), "plaintext");
  assert.equal(firstLineOf("#!/bin/sh\r\necho"), "#!/bin/sh");
  assert.equal(firstLineOf("x".repeat(5000)).length, 1000);
  setContributedLanguages([
    { id: "pip-requirements", extensions: [], filenamePatterns: ["*requirements*.txt"] },
  ]);
  try {
    assert.equal(languageForPath("/p/requirements-dev.txt"), "pip-requirements");
    // A built-in file name still beats a contributed pattern.
    assert.equal(languageForPath("/p/Dockerfile"), "dockerfile");
  } finally {
    setContributedLanguages([]);
  }
});

test("files.associations: names, patterns and paths (D201)", () => {
  const list = parseFileAssociations({
    "*.mdx": "markdown",
    "Dockerfile.*": "dockerfile",
    "*.tsx": "typescriptreact",
    "**/templates/*.html": "jinja",
    "special.txt": "ini",
    "*.txt": "markdown",
    "*.empty": "",
    nope: 3,
  });
  assert.equal(list.length, 6);
  assert.equal(associatedLanguage("/p/docs/intro.mdx", list), "markdown");
  assert.equal(associatedLanguage("/p/Dockerfile.dev", list), "dockerfile");
  // Case doesn't matter (VS Code), and Windows paths work.
  assert.equal(associatedLanguage("C:\\p\\DOCKERFILE.prod", list), "dockerfile");
  // VS Code's language ids are the editor's.
  assert.equal(associatedLanguage("/p/a.tsx", list), "tsx");
  // A pattern with a slash is matched against the path, in any folder.
  assert.equal(associatedLanguage("/p/app/templates/base.html", list), "jinja");
  assert.equal(associatedLanguage("C:\\p\\templates\\base.html", list), "jinja");
  assert.equal(associatedLanguage("/p/app/base.html", list), undefined);
  // A plain name beats a pattern.
  assert.equal(associatedLanguage("/p/special.txt", list), "ini");
  assert.equal(associatedLanguage("/p/other.txt", list), "markdown");
  assert.equal(associatedLanguage("/p/x.empty", list), undefined);
  assert.deepEqual(parseFileAssociations(null), []);
  assert.deepEqual(parseFileAssociations(["*.a"]), []);
});

test("languageForPath asks files.associations first", () => {
  assert.equal(languageForPath("/p/a.mdx"), "plaintext");
  setFileAssociations({ "*.mdx": "markdown", "*.ts": "javascript" });
  try {
    assert.equal(languageForPath("/p/a.mdx"), "markdown");
    assert.equal(languageForPath("/p/a.ts"), "javascript");
    assert.equal(languageForPath("/p/a.py"), "python");
  } finally {
    setFileAssociations({});
  }
  assert.equal(languageForPath("/p/a.ts"), "typescript");
});
