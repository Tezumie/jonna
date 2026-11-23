// The shim's configuration and workspace.fs pieces that need no host: a changed setting reaches
// the cache and onDidChangeConfiguration, values are copies and nested properties, and a write
// makes the folders above the file.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkerApi } from "../rpc";
import { FileSystemError, FileType } from "./types";
import { ShimConfiguration, type ShimFileSystem, writeWithParents } from "./workspace";

const tick = () => new Promise((r) => setTimeout(r, 0));

function configuration(settings: Record<string, unknown>) {
  let changed: (keys: string[]) => void = () => {};
  const ide = {
    settings: {
      get: async (key: string) => settings[key],
      onChange: (listener: (keys: string[]) => void) => {
        changed = listener;
        return { dispose() {} };
      },
      update: async () => {},
    },
  } as unknown as WorkerApi;
  return { config: new ShimConfiguration(ide), changed: (keys: string[]) => changed(keys) };
}

test("a changed editor setting reaches the cache and onDidChangeConfiguration", async () => {
  const settings: Record<string, unknown> = { "editor.tabSize": 4, "files.exclude": { a: true } };
  const { config, changed } = configuration(settings);
  await config.preload(["editor.tabSize", "files.exclude"]);
  const events: { affectsConfiguration(section: string): boolean }[] = [];
  config.onDidChange.event((e) => events.push(e));

  settings["editor.tabSize"] = 2;
  changed(["editor.tabSize"]);
  await tick();
  assert.equal(config.get("editor").get("tabSize"), 2);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.ok(e);
  assert.equal(e.affectsConfiguration("editor"), true);
  assert.equal(e.affectsConfiguration("editor.tabSize"), true);
  assert.equal(e.affectsConfiguration("editor.insertSpaces"), false);
  assert.equal(e.affectsConfiguration("files"), false);

  // One that was never read before is current from then on too.
  settings["editor.rulers"] = [80];
  changed(["editor.rulers"]);
  await tick();
  assert.deepEqual(config.get().get("editor.rulers"), [80]);
});

test("configuration values are copies, and nested keys are nested properties", async () => {
  const { config } = configuration({
    "acme.list": ["a"],
    "acme.format.enable": true,
    "acme.format.options": { width: 80 },
    "acme.enable": false,
  });
  await config.preload(["acme.list", "acme.format.enable", "acme.format.options", "acme.enable"]);
  const acme = config.get("acme");
  (acme.get<string[]>("list") ?? []).push("b");
  assert.deepEqual(acme.get("list"), ["a"]);
  const options = acme.get<{ width: number }>("format.options");
  assert.ok(options);
  options.width = 1;
  assert.equal(acme.get("format.options.width"), 80);

  assert.equal(acme.enable, false);
  assert.equal((acme.format as { enable: boolean }).enable, true);
  const root = config.get() as unknown as { acme: { format: { options: { width: number } } } };
  assert.equal(root.acme.format.options.width, 80);
  // Its own methods aren't replaced by a setting of the same name.
  assert.equal(typeof acme.get, "function");
});

test("workspace.fs.writeFile makes the folders above the file", async () => {
  const folders = new Set<string>(["/data"]);
  const files = new Map<string, Uint8Array>();
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
  const fs = {
    writeFile: async (path: string, data: Uint8Array) => {
      if (!folders.has(parentOf(path))) throw FileSystemError.FileNotFound(path);
      files.set(path, data);
    },
    createDirectory: async (path: string) => {
      // Recursive, as Node's is.
      for (let p = path; p; p = parentOf(p)) folders.add(p);
    },
    stat: async () => ({ type: FileType.File, ctime: 0, mtime: 0, size: 0 }),
  } as unknown as ShimFileSystem;
  const data = new Uint8Array([1]);
  await writeWithParents(fs, "/data/storage/acme.x/global/cache.json", data);
  assert.equal(files.get("/data/storage/acme.x/global/cache.json"), data);
  assert.ok(folders.has("/data/storage/acme.x/global"));

  // A Windows path's folder; any other failure is the caller's.
  const made: string[] = [];
  let failed = false;
  const windows = {
    writeFile: async () => {
      if (failed) return;
      failed = true;
      throw FileSystemError.FileNotFound("x");
    },
    createDirectory: async (path: string) => void made.push(path),
  } as unknown as ShimFileSystem;
  await writeWithParents(windows, "C:\\data\\global\\cache.json", data);
  assert.deepEqual(made, ["C:\\data\\global"]);
  const denied = {
    writeFile: async () => {
      throw FileSystemError.NoPermissions("x");
    },
    createDirectory: async () => assert.fail("no folder is made"),
  } as unknown as ShimFileSystem;
  await assert.rejects(writeWithParents(denied, "/data/a/b.json", data), /NoPermissions|x/);
});
