import assert from "node:assert/strict";
import { test } from "node:test";
import { basename, dirname, isWithin, joinPath, relativePath, upperDrive } from "./index";

test("posix paths", () => {
  assert.equal(basename("/a/b/c.ts"), "c.ts");
  assert.equal(basename("/a/b/"), "b");
  assert.equal(dirname("/a/b/c.ts"), "/a/b");
  assert.equal(dirname("/a"), "/");
  assert.equal(joinPath("/a/b", "c"), "/a/b/c");
  assert.equal(joinPath("/", "c"), "/c");
  assert.equal(relativePath("/w", "/w/src/x.ts"), "src/x.ts");
  assert.equal(relativePath("/w", "/w"), "");
  assert.equal(isWithin("/w", "/wx/a"), false);
});

test("windows paths", () => {
  assert.equal(basename("C:\\w\\src\\x.ts"), "x.ts");
  assert.equal(dirname("C:\\w\\x.ts"), "C:\\w");
  assert.equal(dirname("C:\\x.ts"), "C:\\");
  assert.equal(joinPath("C:\\w", "y.ts"), "C:\\w\\y.ts");
  assert.equal(joinPath("C:\\", "y.ts"), "C:\\y.ts");
  assert.equal(relativePath("C:\\w", "C:\\w\\src\\x.ts"), "src/x.ts");
  assert.equal(isWithin("C:\\w", "C:\\w\\a"), true);
});

test("resolving user/agent paths", async () => {
  const { isAbsolute, resolveInRoot } = await import("./index");
  assert.equal(isAbsolute("/a"), true);
  assert.equal(isAbsolute("C:\\a"), true);
  assert.equal(isAbsolute("src/a.ts"), false);
  assert.equal(resolveInRoot("/w", "src/a.ts"), "/w/src/a.ts");
  assert.equal(resolveInRoot("/w", "./src//a.ts"), "/w/src/a.ts");
  assert.equal(resolveInRoot("/w/a", "../b/c.ts"), "/w/b/c.ts");
  assert.equal(resolveInRoot("C:\\w", "..\\x"), "C:\\x");
  assert.equal(resolveInRoot("/w", "/abs.ts"), "/abs.ts");
  assert.equal(resolveInRoot("C:\\w", "src/a.ts"), "C:\\w\\src\\a.ts");
  // D161: absolute paths are collapsed and take the root's spelling.
  assert.equal(resolveInRoot("C:\\proj", "c:/PROJ/src/a.ts"), "C:\\proj\\src\\a.ts");
  assert.equal(resolveInRoot("C:\\proj", "C:\\proj\\..\\Windows\\x"), "C:\\Windows\\x");
  assert.equal(resolveInRoot("/w", "/w/./a/../b.ts"), "/w/b.ts");
  assert.equal(resolveInRoot("C:\\w", "C:/"), "C:\\");
});

test("windows: case-insensitive comparison, UNC, mixed separators", async () => {
  const { pathKey, samePath, rebase, displayPath, isWindowsPath, resolveInRoot } = await import(
    "./index"
  );
  assert.equal(isWindowsPath("C:\\a"), true);
  assert.equal(isWindowsPath("\\\\srv\\share"), true);
  assert.equal(isWindowsPath("/a"), false);
  assert.equal(samePath("C:\\Work\\A.ts", "c:/work/a.ts"), true);
  assert.equal(samePath("/w/A.ts", "/w/a.ts"), false);
  assert.equal(pathKey("C:\\Work\\"), "c:\\work");
  assert.equal(isWithin("C:\\Work", "c:\\work\\src\\x.ts"), true);
  assert.equal(isWithin("C:\\Work", "C:\\Workshop\\x.ts"), false);
  assert.equal(isWithin("C:\\", "C:\\x"), true);
  assert.equal(relativePath("C:\\Work", "c:\\work\\src\\x.ts"), "src/x.ts");
  assert.equal(displayPath("C:\\w", "C:\\w\\src\\x.ts"), "src\\x.ts");
  assert.equal(dirname("\\\\srv\\share\\x.ts"), "\\\\srv\\share");
  assert.equal(dirname("\\\\srv\\share"), "\\\\srv\\share");
  assert.equal(basename("\\\\srv\\share\\dir\\x.ts"), "x.ts");
  assert.equal(joinPath("\\\\srv\\share", "x"), "\\\\srv\\share\\x");
  assert.equal(isWithin("\\\\SRV\\share", "\\\\srv\\Share\\a"), true);
  assert.equal(resolveInRoot("C:\\w", "C:/x/y.ts"), "C:\\x\\y.ts");
  assert.equal(rebase("C:\\w\\Old", "C:\\w\\new", "c:\\w\\old\\a.ts"), "C:\\w\\new\\a.ts");
  assert.equal(rebase("/w/old", "/w/new", "/w/old/a.ts"), "/w/new/a.ts");
  assert.equal(rebase("/w/old", "/w/new", "/w/older/a.ts"), "/w/older/a.ts");
});

test("upperDrive: Monaco's lowercase drive letter back in capitals", () => {
  assert.equal(upperDrive("c:\\Users\\me\\a.ts"), "C:\\Users\\me\\a.ts");
  assert.equal(upperDrive("C:\\x"), "C:\\x");
  assert.equal(upperDrive("/home/me/a.ts"), "/home/me/a.ts");
  assert.equal(upperDrive("\\\\server\\share\\a"), "\\\\server\\share\\a");
});

test("isWithin judges a path with .. as the path it names", () => {
  assert.equal(isWithin("/proj", "/proj/../etc/passwd"), false);
  assert.equal(isWithin("C:\\proj", "C:\\proj\\..\\secret"), false);
  assert.equal(isWithin("C:\\proj", "c:/PROJ/a/../b"), true);
  assert.equal(isWithin("/proj", "/proj/a/.."), true);
  // A name that merely starts with dots is a name.
  assert.equal(isWithin("/proj", "/proj/..hidden"), true);
});
