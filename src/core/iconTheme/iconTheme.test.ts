import assert from "node:assert/strict";
import { test } from "node:test";
import { asIconTheme, IconTheme } from "./index";

const theme = new IconTheme(
  asIconTheme({
    iconDefinitions: {
      file: { iconPath: "./file.svg" },
      ts: { iconPath: "./ts.svg" },
      spec: { iconPath: "./spec.svg" },
      npm: { iconPath: "./npm.svg" },
      md: { iconPath: "./md.svg" },
      folder: { iconPath: "./folder.svg" },
      folderOpen: { iconPath: "./folder-open.svg" },
      src: { iconPath: "./src.svg" },
      srcOpen: { iconPath: "./src-open.svg" },
      root: { iconPath: "./root.svg" },
      npmLight: { iconPath: "./npm-light.svg" },
    },
    file: "file",
    folder: "folder",
    folderExpanded: "folderOpen",
    rootFolder: "root",
    fileExtensions: { ts: "ts", "spec.ts": "spec", gone: "missing" },
    fileNames: { "package.json": "npm" },
    languageIds: { markdown: "md" },
    folderNames: { src: "src" },
    folderNamesExpanded: { SRC: "srcOpen" },
    light: { fileNames: { "package.json": "npmLight" } },
  }),
);

test("icon themes: files by name, longest extension, language, default", () => {
  assert.equal(theme.resolve({ name: "Package.json", kind: "file" }), "npm");
  assert.equal(theme.resolve({ name: "package.json", kind: "file", light: true }), "npmLight");
  assert.equal(theme.resolve({ name: "a.spec.ts", kind: "file" }), "spec");
  assert.equal(theme.resolve({ name: "a.TS", kind: "file" }), "ts");
  assert.equal(theme.resolve({ name: "README", kind: "file", languageId: "markdown" }), "md");
  assert.equal(
    theme.resolve({ name: "x.gone", kind: "file" }),
    "file",
    "undefined icons fall back",
  );
  assert.equal(theme.resolve({ name: ".env", kind: "file" }), "file");
});

test("icon themes: folders by name, expanded, root", () => {
  assert.equal(theme.resolve({ name: "src", kind: "folder" }), "src");
  assert.equal(theme.resolve({ name: "Src", kind: "folder", expanded: true }), "srcOpen");
  assert.equal(theme.resolve({ name: "lib", kind: "folder", expanded: true }), "folderOpen");
  assert.equal(theme.resolve({ name: "lib", kind: "folder" }), "folder");
  assert.equal(theme.resolve({ name: "proj", kind: "folder", root: true }), "root");
  assert.throws(() => asIconTheme({ a: 1 }), /iconDefinitions/);
});
