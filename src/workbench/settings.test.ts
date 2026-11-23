import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setTransport, type Transport } from "../core/ipc/invoke";
import { parseJsonc } from "../core/settings/jsonc";
import { SettingsService } from "./settings";

const USER = "/config/settings.json";
const KEYS = "/config/keybindings.json";

/** Settings files in memory behind a transport: missing, locked (a sharing violation) or text. */
function fakeDisk(files: Record<string, string>) {
  const locked = new Set<string>();
  const writes: string[] = [];
  let workspaceSettings: string | null = null;
  /** Reads of this path wait until released (a read that is under way). */
  let held: { path: string; release: () => void; waiting: Promise<void> } | null = null;
  const transport: Transport = {
    kind: "fake",
    state: "open",
    request: async (command, args) => {
      const path = String((args as { path?: unknown } | undefined)?.path ?? "");
      if (command === "settings_paths")
        return {
          userSettings: USER,
          userKeybindings: KEYS,
          workspaceSettings,
          configDir: "/config",
        };
      if (command === "fs_read") {
        if (held?.path === path) {
          const wait = held.waiting;
          held = null;
          await wait;
        }
        if (locked.has(path)) throw { code: "Io", message: "sharing violation" };
        const text = files[path];
        if (text === undefined) throw { code: "NotFound", message: `no such file: ${path}` };
        return new TextEncoder().encode(text).buffer;
      }
      if (command === "fs_stat") throw { code: "NotFound", message: "no such folder" };
      return undefined;
    },
    requestRaw: async (command, body, headers) => {
      assert.equal(command, "fs_write");
      const path = decodeURIComponent(headers["x-path"] ?? "");
      files[path] = new TextDecoder().decode(body as Uint8Array);
      writes.push(path);
      return undefined;
    },
    openChannel: () => ({ id: 1, wire: () => ({ __channel: 1 }), close: () => {} }),
    onClose: () => () => {},
  };
  setTransport(transport);
  return {
    files,
    writes,
    lock: (path: string, on: boolean) => void (on ? locked.add(path) : locked.delete(path)),
    openFolder: (path: string | null) => {
      workspaceSettings = path;
    },
    /** The next read of `path` waits; returns what lets it go on. */
    holdNextRead(path: string): () => void {
      let release = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      held = { path, release, waiting };
      return release;
    },
  };
}

const values = (text: string | undefined) => {
  const parsed = parseJsonc(text ?? "");
  assert.ok(parsed.ok, text ?? "");
  return parsed.value;
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => setTransport(null));

test("a settings change before the file was first read keeps everything in the file", async () => {
  const disk = fakeDisk({ [USER]: '{\n  // mine\n  "a": 1,\n  "b": 2\n}\n' });
  const service = new SettingsService();
  // Startup: the paths are known, the first read of the file is still under way.
  const release = disk.holdNextRead(USER);
  const loading = service.load();
  await tick();
  const update = service.update("c", 3);
  release();
  await Promise.all([loading, update]);
  assert.deepEqual(values(disk.files[USER]), { a: 1, b: 2, c: 3 });
  assert.ok(disk.files[USER]?.includes("// mine"));
  assert.deepEqual(service.model.layerValues("user"), { a: 1, b: 2, c: 3 });
  service.dispose();
});

test("a settings file that can't be read is not taken for an empty one", async () => {
  const text = '{\n  "a": 1,\n  "b": 2\n}\n';
  const disk = fakeDisk({ [USER]: text });
  const service = new SettingsService();
  await service.load();
  // A reload (the watcher's) runs into a sharing violation: the values read before stay.
  disk.lock(USER, true);
  await service.reload("user");
  assert.deepEqual(service.model.layerValues("user"), { a: 1, b: 2 });
  // A write is refused, with nothing written and nothing shown that isn't in the file.
  await assert.rejects(service.update("c", 3), /settings\.json couldn't be read/);
  await assert.rejects(service.updateMany({ c: 3 }), /couldn't be read/);
  await assert.rejects(service.updateForLanguage("go", "c", 3), /couldn't be read/);
  assert.equal(disk.files[USER], text);
  assert.deepEqual(disk.writes, []);
  assert.deepEqual(service.model.layerValues("user"), { a: 1, b: 2 });
  // Readable again: the change goes in beside the rest.
  disk.lock(USER, false);
  await service.update("c", 3);
  assert.deepEqual(values(disk.files[USER]), { a: 1, b: 2, c: 3 });
  // A file that isn't there is an empty one: the first change makes it.
  delete disk.files[USER];
  await service.update("d", 4);
  assert.deepEqual(values(disk.files[USER]), { d: 4 });
  service.dispose();
});

test("a settings change is made on the file as it is now, not as this window last saw it", async () => {
  const disk = fakeDisk({ [USER]: '{\n  "a": 1\n}\n' });
  const service = new SettingsService();
  await service.load();
  // Another window (or the user, in an editor) adds a setting; no reload has run here yet.
  disk.files[USER] = '{\n  "a": 1,\n  "theirs": true\n}\n';
  await service.update("mine", true);
  assert.deepEqual(values(disk.files[USER]), { a: 1, theirs: true, mine: true });
  assert.deepEqual(service.model.layerValues("user"), { a: 1, theirs: true, mine: true });
  // Several at once: each builds on the one before, and the last value shown is the file's.
  await Promise.all([service.update("x", 1), service.update("y", 2), service.update("a", 5)]);
  assert.deepEqual(values(disk.files[USER]), { a: 5, theirs: true, mine: true, x: 1, y: 2 });
  assert.deepEqual(service.model.layerValues("user"), values(disk.files[USER]));
  // A file with a syntax error is refused, and left as it is.
  const broken = '{\n  "a": 1\n  "b": 2\n}\n';
  disk.files[USER] = broken;
  await assert.rejects(service.update("z", 1), /syntax error \(line 3\)/);
  assert.equal(disk.files[USER], broken);
  service.dispose();
});

test("after a folder switch a workspace setting goes into the new folder's file only", async () => {
  const one = "/one/.ide/settings.json";
  const two = "/two/.ide/settings.json";
  const disk = fakeDisk({
    [one]: '{\n  "from.one": true\n}\n',
    [two]: '{\n  "from.two": true\n}\n',
  });
  const service = new SettingsService();
  disk.openFolder(one);
  await service.load();
  assert.deepEqual(service.model.layerValues("workspace"), { "from.one": true });
  // The other folder opens; its settings file is still being read when a setting changes.
  disk.openFolder(two);
  const release = disk.holdNextRead(two);
  const loading = service.load();
  await tick();
  await tick();
  assert.equal(service.filePath("workspace"), two);
  const update = service.update("k", 1, "workspace");
  release();
  await Promise.all([loading, update]);
  assert.deepEqual(values(disk.files[two]), { "from.two": true, k: 1 });
  assert.deepEqual(values(disk.files[one]), { "from.one": true });
  assert.deepEqual(service.model.layerValues("workspace"), { "from.two": true, k: 1 });
  service.dispose();
});

test("a closed folder's settings stop applying, and its scope can't be written", async () => {
  const one = "/one/.ide/settings.json";
  const disk = fakeDisk({ [one]: '{\n  "editor.fontSize": 20\n}\n', [USER]: '{ "a": 1 }' });
  const service = new SettingsService();
  disk.openFolder(one);
  await service.load();
  assert.deepEqual(service.model.layerValues("workspace"), { "editor.fontSize": 20 });
  service.workspaceClosed();
  assert.deepEqual(service.model.layerValues("workspace"), {});
  assert.equal(service.filePath("workspace"), null);
  await assert.rejects(service.update("editor.fontSize", 30, "workspace"), /Open a folder/);
  assert.deepEqual(values(disk.files[one]), { "editor.fontSize": 20 });
  // The user's settings are untouched.
  assert.deepEqual(service.model.layerValues("user"), { a: 1 });
  service.dispose();
});
