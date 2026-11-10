import assert from "node:assert/strict";
import { test } from "node:test";
import { Emitter } from "../core/events/index";
import { signal } from "../core/reactive/index";
import {
  type ContributedTask,
  childUri,
  DebugAdapterRegistry,
  DebugTrackerRegistry,
  EMPTY_SCM_STATE,
  FileSystemRegistry,
  fileNameProblem,
  makeUri,
  parentUri,
  type ScmProviderEntry,
  type ScmState,
  SourceControlRegistry,
  scmCount,
  TaskProviderRegistry,
  tasksJsonEntries,
  trackedTransport,
  uriPath,
  uriScheme,
} from "./extensionRegistries";

const task = (label: string): ContributedTask => ({
  owner: "acme.x",
  label,
  source: "X",
  spec: { kind: "shell", command: label },
  command: label,
  background: false,
});

test("uri helpers: schemes, never a Windows drive; normalized paths", () => {
  assert.equal(uriScheme("memfs:/a/b.txt"), "memfs");
  assert.equal(uriScheme("MemFS:/a"), "memfs");
  assert.equal(uriScheme("C:/Users/x"), null);
  assert.equal(uriScheme("C:\\Users\\x"), null);
  assert.equal(uriScheme("/home/x"), null);
  assert.equal(uriScheme("https://example.com"), null, "an authority (//) isn't a provider path");
  assert.equal(uriPath("memfs:/a/./b/../c//d/"), "/a/c/d");
  assert.equal(uriPath("memfs:/../.."), "/");
  assert.equal(makeUri("memfs", "a\\b"), "memfs:/a/b");
  assert.equal(childUri("memfs:/", "x"), "memfs:/x");
  assert.equal(childUri("memfs:/dir", "x"), "memfs:/dir/x");
});

test("tasks: every provider's list, tasks.json entries resolved, failures skipped", async () => {
  const registry = new TaskProviderRegistry();
  const errors: string[] = [];
  registry.add({ owner: "acme.x", type: "demo", provide: async () => [task("demo: a")] });
  registry.add({
    owner: "acme.y",
    type: "other",
    provide: async () => {
      throw new Error("broken");
    },
    resolve: async (definition) => ({
      ...task("other: resolved"),
      detail: String(definition.flavor),
    }),
  });
  const files = [
    {
      tasks: [
        { type: "other", label: "Mine", flavor: "x" },
        { type: "shell", command: "ls" },
      ],
    },
    null,
    { tasks: "no" },
  ];
  const list = await registry.tasks(files, (m) => errors.push(m));
  assert.deepEqual(
    list.map((t) => [t.label, t.detail]),
    [
      ["demo: a", undefined],
      ["Mine", "x"],
    ],
  );
  assert.deepEqual(errors, ["broken"]);
  assert.equal(tasksJsonEntries(files).length, 2);
});

test("tasks: no providers, nothing asked", async () => {
  assert.deepEqual(await new TaskProviderRegistry().tasks([{ tasks: [{ type: "x" }] }]), []);
});

test("scm: counts (own count or every resource) and quick diff's original", async () => {
  const state = (s: Partial<ScmState>) => signal<ScmState>({ ...EMPTY_SCM_STATE, ...s });
  const entry = (key: string, s: Partial<ScmState>, original?: string): ScmProviderEntry => ({
    owner: "acme.x",
    key,
    label: key,
    rootPath: "/ws/notes",
    state: state(s),
    setInput: () => {},
    accept: async () => {},
    open: async () => {},
    ...(original !== undefined && { original: async () => original }),
  });
  const registry = new SourceControlRegistry();
  registry.add(
    entry("a", {
      groups: [
        {
          id: "g",
          label: "G",
          hideWhenEmpty: false,
          resources: [{ path: "/ws/notes/1" }, { path: "/ws/notes/2" }],
        },
      ],
    }),
  );
  const off = registry.add(entry("b", { count: 5 }, "base"));
  assert.equal(registry.count(), 7);
  assert.equal(scmCount({ ...EMPTY_SCM_STATE, count: -3 }), 0);
  const within = (root: string, path: string) => path.startsWith(`${root}/`);
  assert.equal(await registry.original("/ws/notes/1", within), "base");
  assert.equal(await registry.original("/ws/other/1", within), null, "outside its folder");
  off.dispose();
  assert.equal(registry.count(), 2);
});

test("debug: the newest adapter of a type wins", async () => {
  const registry = new DebugAdapterRegistry();
  const adapter = (label: string) => ({
    owner: "acme.x",
    type: "demo",
    label,
    snippets: [],
    connect: async () => ({
      transport: { send: () => {}, onMessage: new Emitter<string>().event },
      kill: async () => {},
    }),
  });
  registry.add(adapter("placeholder"));
  const off = registry.add(adapter("real"));
  assert.equal(registry.get("demo")?.label, "real");
  off.dispose();
  assert.equal(registry.get("demo")?.label, "placeholder");
  assert.equal(registry.get("other"), undefined);
});

test("file systems: a URI finds its provider; file paths and other schemes don't", () => {
  const registry = new FileSystemRegistry();
  const changed = new Emitter<readonly { path: string; kind: "changed" }[]>();
  registry.add({
    owner: "acme.x",
    scheme: "memfs",
    label: "Memory",
    readonly: false,
    stat: async () => ({ kind: "file", size: 0, mtimeMs: 0, readonly: false }),
    readDirectory: async () => [],
    readFile: async () => new Uint8Array(),
    writeFile: async () => {},
    createDirectory: async () => {},
    delete: async () => {},
    rename: async () => {},
    onDidChange: changed.event,
  });
  assert.equal(registry.owns("memfs:/a.txt"), true);
  assert.equal(registry.owns("MEMFS:/a.txt"), true);
  assert.equal(registry.owns("other:/a.txt"), false);
  assert.equal(registry.owns("/home/memfs:/a"), false);
  assert.equal(registry.of("acme.x").length, 1);
});

test("file systems (D234): parent URIs, names, changes and waiting for a provider", async () => {
  assert.equal(parentUri("memfs:/a/b.txt"), "memfs:/a");
  assert.equal(parentUri("memfs:/b.txt"), "memfs:/");
  assert.equal(parentUri("memfs:/"), "memfs:/");
  assert.equal(fileNameProblem("notes.txt"), null);
  assert.ok(fileNameProblem(""));
  assert.ok(fileNameProblem(".."));
  assert.ok(fileNameProblem("a/b"));
  assert.ok(fileNameProblem("a\b"));

  const registry = new FileSystemRegistry();
  const heard: string[] = [];
  registry.onDidChangeFiles((changes) => heard.push(...changes.map((c) => c.path)));
  registry.fireChanges([{ path: "memfs:/a", kind: "changed" }]);
  registry.fireChanges([]);
  assert.deepEqual(heard, ["memfs:/a"]);

  assert.equal(
    await registry.whenServed("/home/x.txt", 1000),
    undefined,
    "a file path isn't waited for",
  );
  const asked: string[] = [];
  registry.onWillNeedScheme((scheme) => {
    asked.push(scheme);
    // The extension starts and registers its provider.
    setTimeout(() => registry.add(fakeFileSystem("memfs")), 50);
  });
  const found = await registry.whenServed("memfs:/a.txt", 2000);
  assert.equal(found?.scheme, "memfs");
  assert.deepEqual(asked, ["memfs"]);
  assert.equal(await registry.whenServed("other:/x", 250), undefined, "nobody serves it");
});

function fakeFileSystem(scheme: string) {
  const fail = () => Promise.reject(new Error("no"));
  return {
    owner: "acme.fs",
    scheme,
    label: scheme,
    readonly: false,
    stat: fail,
    readDirectory: fail,
    readFile: fail,
    writeFile: fail,
    createDirectory: fail,
    delete: fail,
    rename: fail,
    onDidChange: new Emitter<readonly { path: string; kind: "changed" }[]>().event,
  };
}

test("D258: debug adapter trackers see a session's messages both ways", async () => {
  const registry = new DebugTrackerRegistry();
  const seen: string[] = [];
  registry.add({
    owner: "acme.x",
    type: "node",
    create: async (s) => ({
      willReceive: (m) => seen.push(`to ${s.id} ${(m as { command: string }).command}`),
      didSend: (m) => seen.push(`from ${(m as { event: string }).event}`),
      willStop: () => seen.push("stop"),
      exit: () => seen.push("exit"),
    }),
  });
  registry.add({ owner: "acme.y", type: "python", create: async () => null });
  const trackers = await registry.start({ id: "s1", type: "node", name: "x" });
  assert.equal(trackers.length, 1);
  const incoming = new Emitter<string>();
  const sent: string[] = [];
  const tracked = trackedTransport(
    { send: (b) => sent.push(b), onMessage: incoming.event, close: () => sent.push("closed") },
    trackers,
  );
  const got: string[] = [];
  tracked.onMessage((b) => got.push(b));
  tracked.send(JSON.stringify({ command: "launch" }));
  incoming.fire(JSON.stringify({ event: "stopped" }));
  tracked.close?.();
  assert.deepEqual(seen, ["to s1 launch", "from stopped", "stop"]);
  assert.equal(got.length, 1);
  assert.equal(sent[0], JSON.stringify({ command: "launch" }));
});
