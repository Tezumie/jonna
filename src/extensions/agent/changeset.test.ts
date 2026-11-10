import assert from "node:assert/strict";
import { test } from "node:test";
import { fsIpc } from "../../core/ipc/fs";
import { looksBinary, readDiskForAgent } from "./changeset";

type Fs = { stat: typeof fsIpc.stat; read: typeof fsIpc.read };

/** Runs `body` with fsIpc's stat/read replaced (no Tauri in tests). */
async function withFs(fake: Fs, body: () => Promise<void>): Promise<void> {
  const real: Fs = { stat: fsIpc.stat, read: fsIpc.read };
  Object.assign(fsIpc, fake);
  try {
    await body();
  } finally {
    Object.assign(fsIpc, real);
  }
}

const file = (size: number) => async () => ({
  kind: "file" as const,
  size,
  mtimeMs: 0,
  readonly: false,
});

test("looksBinary: a NUL byte early on", () => {
  assert.ok(looksBinary(Uint8Array.from([0x50, 0x4b, 0x00])));
  assert.ok(!looksBinary(new TextEncoder().encode("text")));
});

test("readDiskForAgent: refuses large files before reading them", async () => {
  let read = false;
  await withFs(
    {
      stat: file(10 * 1024 * 1024) as unknown as Fs["stat"],
      read: async () => {
        read = true;
        return new Uint8Array();
      },
    },
    async () => {
      const result = await readDiskForAgent("/w/big.log");
      assert.equal(result.kind, "tooLarge");
      assert.ok(!read);
    },
  );
});

test("readDiskForAgent: binary, text with BOM, missing", async () => {
  await withFs(
    {
      stat: file(3) as unknown as Fs["stat"],
      read: async () => Uint8Array.from([0x00, 0x01, 0x02]),
    },
    async () => assert.equal((await readDiskForAgent("/w/a.bin")).kind, "binary"),
  );
  await withFs(
    {
      stat: file(4) as unknown as Fs["stat"],
      read: async () => Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]),
    },
    async () => assert.deepEqual(await readDiskForAgent("/w/a.txt"), { kind: "text", text: "a" }),
  );
  await withFs(
    {
      stat: (async () => {
        throw new Error("not found");
      }) as Fs["stat"],
      read: async () => new Uint8Array(),
    },
    async () => assert.equal((await readDiskForAgent("/w/none")).kind, "missing"),
  );
});

test("accept: a proposal made while writing stays; a double accept writes once (D159)", async () => {
  const { Changeset } = await import("./changeset");
  const disk = new Map<string, string>([["/w/a.ts", "old"]]);
  const writes: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const services = {
    quickDiff: { bufferText: () => null, writeBuffer: async () => false },
    events: { emit: () => {} },
    history: { push: () => {} },
  } as unknown as ConstructorParameters<typeof Changeset>[0];
  const real = { read: fsIpc.read, write: fsIpc.write, stat: fsIpc.stat };
  Object.assign(fsIpc, {
    stat: async (p: string) => {
      const t = disk.get(p);
      if (t === undefined) throw new Error("missing");
      return { kind: "file", size: t.length, mtimeMs: 0, readonly: false };
    },
    read: async (p: string) => {
      const t = disk.get(p);
      if (t === undefined) throw new Error("missing");
      return new TextEncoder().encode(t);
    },
    write: async (p: string, bytes: Uint8Array) => {
      await gate;
      writes.push(p);
      disk.set(p, new TextDecoder().decode(bytes));
    },
  });
  try {
    const cs = new Changeset(services, "s1");
    // Staged proposals (the memory tidy-up's): written on accept, as all were before D199.
    await cs.propose("/w/a.ts", "first", 1, { staged: true });
    const accepting = cs.accept(["/w/a.ts"]);
    const twice = cs.accept(["/w/a.ts"]);
    // The agent edits the file again while the first proposal is being written.
    await new Promise((r) => setTimeout(r, 0));
    await cs.propose("/w/a.ts", "second", 1);
    release();
    await Promise.all([accepting, twice]);
    assert.equal(writes.length, 1);
    assert.equal(cs.get("/w/a.ts")?.proposed, "second");
    // Rejecting it: the card says rejected, not changed.
    await cs.reject(["/w/a.ts"]);
    // Turn 1's second proposal was rejected (its first was applied: the card shows that).
    assert.equal(cs.wasRejected("/w/a.ts", 1), true);
    assert.ok(cs.appliedStat("/w/a.ts", 1));
    await cs.propose("/w/b.ts", "new file", 2, { staged: true });
    await cs.reject(["/w/b.ts"]);
    assert.equal(cs.wasRejected("/w/b.ts"), true);
    assert.deepEqual(Object.keys(cs.appliedJSON()), ["1#/w/a.ts"]);
    // Per turn: turn 1 wrote it; turn 2 did not.
    assert.ok(cs.appliedStat("/w/a.ts", 1));
    assert.equal(cs.appliedStat("/w/a.ts", 2), undefined);
  } finally {
    Object.assign(fsIpc, real);
  }
});

test("accept: edits made to the file since the proposal are kept, or it refuses (D161)", async () => {
  const { Changeset } = await import("./changeset");
  const disk = new Map<string, string>([["/w/a.ts", "a\nb\nc\nd\ne\n"]]);
  const services = {
    quickDiff: { bufferText: () => null, writeBuffer: async () => false },
    events: { emit: () => {} },
    history: { push: () => {} },
  } as unknown as ConstructorParameters<typeof Changeset>[0];
  const real = { read: fsIpc.read, write: fsIpc.write, stat: fsIpc.stat };
  Object.assign(fsIpc, {
    stat: async (p: string) => {
      const t = disk.get(p);
      if (t === undefined) throw new Error("missing");
      return { kind: "file", size: t.length, mtimeMs: 0, readonly: false };
    },
    read: async (p: string) => {
      const t = disk.get(p);
      if (t === undefined) throw new Error("missing");
      return new TextEncoder().encode(t);
    },
    write: async (p: string, bytes: Uint8Array) => {
      disk.set(p, new TextDecoder().decode(bytes));
    },
  });
  try {
    const cs = new Changeset(services, "s1");
    await cs.propose("/w/a.ts", "a\nb\nc\nd\nE\n", 1, { staged: true });
    disk.set("/w/a.ts", "A\nb\nc\nd\ne\n"); // the user edits line 1 meanwhile
    await cs.accept(["/w/a.ts"]);
    assert.equal(disk.get("/w/a.ts"), "A\nb\nc\nd\nE\n");
    // The same line changed by both: refused, the user's text stays, the proposal stays.
    await cs.propose("/w/a.ts", "A\nb\nc\nd\nF\n", 2, { staged: true });
    disk.set("/w/a.ts", "A\nb\nc\nd\nmine\n");
    await assert.rejects(cs.accept(["/w/a.ts"]), /changed since/);
    assert.equal(disk.get("/w/a.ts"), "A\nb\nc\nd\nmine\n");
    assert.ok(cs.get("/w/a.ts"));
  } finally {
    Object.assign(fsIpc, real);
  }
});

test("editableText: refuses files that would be corrupted by editing (D161)", async () => {
  const { editableText } = await import("./changeset");
  const services = {
    quickDiff: { bufferText: () => null },
  } as unknown as Parameters<typeof editableText>[0];
  const read = (bytes: number[]) => async () => Uint8Array.from(bytes);
  // Windows-1252 "é", UTF-16LE with BOM: refused, not rewritten with replacement characters.
  for (const bytes of [
    [0x63, 0x61, 0x66, 0xe9],
    [0xff, 0xfe, 0x61, 0x00],
  ])
    await withFs(
      { stat: file(bytes.length) as unknown as Fs["stat"], read: read(bytes) as Fs["read"] },
      async () => {
        await assert.rejects(editableText(services, "/w/a.txt"), /UTF-8/);
      },
    );
  await withFs(
    { stat: file(3) as unknown as Fs["stat"], read: read([0xc3, 0xa9, 0x0a]) as Fs["read"] },
    async () => assert.equal(await editableText(services, "/w/a.txt"), "é\n"),
  );
  await withFs(
    {
      stat: file(10 * 1024 * 1024) as unknown as Fs["stat"],
      read: read([]) as Fs["read"],
    },
    async () => {
      await assert.rejects(editableText(services, "/w/big.txt"), /too large/);
    },
  );
});

/** A fake disk for the changeset (fsIpc's read, write, stat and trash). */
async function withDisk(
  files: Record<string, string>,
  body: (disk: Map<string, string>) => Promise<void>,
): Promise<void> {
  const disk = new Map(Object.entries(files));
  const real = { read: fsIpc.read, write: fsIpc.write, stat: fsIpc.stat, trash: fsIpc.trash };
  Object.assign(fsIpc, {
    stat: async (p: string) => {
      const t = disk.get(p);
      if (t === undefined) throw new Error("missing");
      return { kind: "file", size: t.length, mtimeMs: 0, readonly: false };
    },
    read: async (p: string) => {
      const t = disk.get(p);
      if (t === undefined) throw new Error("missing");
      return new TextEncoder().encode(t);
    },
    write: async (p: string, bytes: Uint8Array) => {
      disk.set(p, new TextDecoder().decode(bytes));
    },
    trash: async (p: string) => {
      disk.delete(p);
      return "trash-id";
    },
  });
  try {
    await body(disk);
  } finally {
    Object.assign(fsIpc, real);
  }
}

test("on disk (D199): written at once, accept keeps it, reject reverts on top of the user's edits", async () => {
  const { Changeset } = await import("./changeset");
  const pushed: string[] = [];
  const services = {
    quickDiff: { bufferText: () => null, writeBuffer: async () => false },
    events: { emit: () => {} },
    history: { push: (e: { label: string }) => pushed.push(e.label) },
  } as unknown as ConstructorParameters<typeof Changeset>[0];
  await withDisk({ "/w/a.ts": "a\nb\nc\nd\ne\n" }, async (disk) => {
    const cs = new Changeset(services, "s1");
    await cs.propose("/w/a.ts", "a\nb\nc\nd\nE\n", 1);
    // On disk now: commands and tests see it; the agent reads the file itself.
    assert.equal(disk.get("/w/a.ts"), "a\nb\nc\nd\nE\n");
    assert.equal(await cs.current("/w/a.ts"), "a\nb\nc\nd\nE\n");
    assert.equal(cs.get("/w/a.ts")?.onDisk, true);
    // The user types on line 1; rejecting puts back line 5 only.
    disk.set("/w/a.ts", "A\nb\nc\nd\nE\n");
    await cs.reject(["/w/a.ts"]);
    assert.equal(disk.get("/w/a.ts"), "A\nb\nc\nd\ne\n");
    assert.equal(cs.get("/w/a.ts"), undefined);
    assert.equal(cs.wasRejected("/w/a.ts", 1), true);
    // Accepting keeps the file and makes one undo entry.
    await cs.propose("/w/a.ts", "A\nb\nc\nd\nX\n", 2);
    await cs.accept(["/w/a.ts"]);
    assert.equal(disk.get("/w/a.ts"), "A\nb\nc\nd\nX\n");
    assert.equal(cs.get("/w/a.ts"), undefined);
    assert.equal(pushed.length, 1);
    // The same lines changed by both: reject refuses, both stay.
    await cs.propose("/w/a.ts", "A\nb\nc\nd\nY\n", 3);
    disk.set("/w/a.ts", "A\nb\nc\nd\nmine\n");
    await assert.rejects(cs.reject(["/w/a.ts"]), /same lines/);
    assert.equal(disk.get("/w/a.ts"), "A\nb\nc\nd\nmine\n");
    assert.ok(cs.get("/w/a.ts"));
  });
});

test("what the agent last saw of a file: its reads and its own writes", async () => {
  const { Changeset } = await import("./changeset");
  const services = {
    quickDiff: { bufferText: () => null, writeBuffer: async () => false },
    events: { emit: () => {} },
    history: { push: () => {} },
  } as unknown as ConstructorParameters<typeof Changeset>[0];
  await withDisk({ "/w/a.ts": "a\n" }, async (disk) => {
    const cs = new Changeset(services, "s1");
    assert.equal(cs.changedSinceSeen("/w/a.ts", "anything"), false);
    cs.noteSeen("/w/a.ts", "a\n");
    await cs.propose("/w/a.ts", "b\n", 1);
    assert.equal(cs.changedSinceSeen("/w/a.ts", "b\n"), false);
    // Someone changed it since: what the agent saw is no longer the file (write_file refuses).
    disk.set("/w/a.ts", "c\n");
    assert.ok(cs.changedSinceSeen("/w/a.ts", (await cs.current("/w/a.ts")) ?? ""));
    // Saved with the chat (D221): a restarted chat still knows.
    const again = new Changeset(services, "s1");
    again.restoreSeen(JSON.parse(JSON.stringify(cs.seenJSON())));
    assert.ok(again.changedSinceSeen("/w/a.ts", "c\n"));
    assert.equal(again.changedSinceSeen("/w/a.ts", "b\n"), false);
    assert.doesNotMatch(JSON.stringify(cs.seenJSON()), /b\\n/);
  });
});

test("text fingerprints tell texts apart (D221)", async () => {
  const { textFingerprint } = await import("./changeset");
  assert.equal(textFingerprint("abc"), textFingerprint("abc"));
  assert.notEqual(textFingerprint("abc"), textFingerprint("abd"));
  assert.notEqual(textFingerprint("ab"), textFingerprint("ba"));
  assert.notEqual(textFingerprint(""), textFingerprint(" "));
  assert.notEqual(textFingerprint("a\r\nb"), textFingerprint("a\nb"));
});

test("on disk (D199): created and deleted files, hunks", async () => {
  const { Changeset, reviewHunks } = await import("./changeset");
  const services = {
    quickDiff: { bufferText: () => null, writeBuffer: async () => false },
    events: { emit: () => {} },
    history: { push: () => {} },
  } as unknown as ConstructorParameters<typeof Changeset>[0];
  await withDisk({ "/w/old.ts": "keep\n", "/w/h.ts": "1\n2\n3\n4\n5\n" }, async (disk) => {
    const cs = new Changeset(services, "s1");
    // A new file: rejecting removes it.
    await cs.propose("/w/new.ts", "fresh\n", 1);
    assert.equal(disk.get("/w/new.ts"), "fresh\n");
    await cs.reject(["/w/new.ts"]);
    assert.equal(disk.has("/w/new.ts"), false);
    // A deletion: gone at once; rejecting brings it back.
    await cs.proposeDelete("/w/old.ts", 1);
    assert.equal(disk.has("/w/old.ts"), false);
    await cs.reject(["/w/old.ts"]);
    assert.equal(disk.get("/w/old.ts"), "keep\n");
    // Two changes: hunks in the file's current lines; reject one, accept the other.
    await cs.propose("/w/h.ts", "1\nTWO\n3\n4\nFIVE\nsix\n", 2);
    assert.deepEqual(await cs.hunks("/w/h.ts"), [
      { startLine: 2, lines: 1, added: 1, removed: 1 },
      { startLine: 5, lines: 2, added: 2, removed: 1 },
    ]);
    await cs.hunk("/w/h.ts", 2, "reject");
    assert.equal(disk.get("/w/h.ts"), "1\n2\n3\n4\nFIVE\nsix\n");
    await cs.hunk("/w/h.ts", 5, "accept");
    assert.equal(cs.get("/w/h.ts"), undefined);
    assert.equal(disk.get("/w/h.ts"), "1\n2\n3\n4\nFIVE\nsix\n");
    assert.deepEqual(reviewHunks("a\nb\n", "a\n"), [
      { startLine: 2, lines: 0, added: 0, removed: 1 },
    ]);
  });
});

test("on disk (D199): the user's typing since isn't an agent change", async () => {
  const { Changeset } = await import("./changeset");
  const services = {
    quickDiff: { bufferText: () => null, writeBuffer: async () => false },
    events: { emit: () => {} },
    history: { push: () => {} },
  } as unknown as ConstructorParameters<typeof Changeset>[0];
  await withDisk({ "/w/u.ts": "a\nb\nc\nd\ne\n" }, async (disk) => {
    const cs = new Changeset(services, "s1");
    await cs.propose("/w/u.ts", "a\nB\nc\nd\ne\n", 1);
    // The user edits line 4 afterwards.
    disk.set("/w/u.ts", "a\nB\nc\nmine\ne\n");
    assert.deepEqual(await cs.hunks("/w/u.ts"), [{ startLine: 2, lines: 1, added: 1, removed: 1 }]);
    await assert.rejects(cs.hunk("/w/u.ts", 4, "reject"), /No pending change/);
    await cs.hunk("/w/u.ts", 2, "reject");
    assert.equal(disk.get("/w/u.ts"), "a\nb\nc\nmine\ne\n");
    assert.equal(cs.get("/w/u.ts"), undefined);
  });
});

test("afterRestore: the review follows a checkpoint restore (D200)", async () => {
  const { Changeset } = await import("./changeset");
  const cs = new Changeset({} as ConstructorParameters<typeof Changeset>[0], "s1");
  cs.restore([
    { path: "/w/old.ts", original: "a", proposed: "b", turn: 1, onDisk: true },
    { path: "/w/back.ts", original: "x", proposed: "y", turn: 2, onDisk: true },
    { path: "/w/both.ts", original: "o", proposed: "o2", turn: 3, onDisk: true },
    { path: "/w/new.ts", original: null, proposed: "n", turn: 2, onDisk: true },
    { path: "/w/staged.md", original: "m", proposed: "m2", turn: 2 },
  ]);
  cs.afterRestore(
    2,
    new Map<string, string | null>([
      ["/w/back.ts", "x"],
      ["/w/both.ts", "o1"],
      ["/w/new.ts", null],
    ]),
  );
  const files = cs.files.peek();
  assert.deepEqual(
    files.map((f) => f.path),
    ["/w/old.ts", "/w/both.ts"],
  );
  assert.equal(files[1]?.proposed, "o1");
  assert.equal(files[1]?.turn, 1);
});

test("D308/D309: changed-on-disk notes and the read guard", async () => {
  const { Changeset } = await import("./changeset");
  const { fileChangeNotes } = await import("./changeNotices");
  const { readGuard } = await import("./readGuard");
  const services = {
    quickDiff: { bufferText: () => null, writeBuffer: async () => false },
    events: { emit: () => {} },
    history: { push: () => {} },
    workspace: { folders: { peek: () => [] }, root: { peek: () => "/w" } },
  } as unknown as ConstructorParameters<typeof Changeset>[0];
  await withDisk({ "/w/a.ts": "one\ntwo\n", "/w/b.ts": "x\n" }, async (disk) => {
    const cs = new Changeset(services, "s1");
    // Not read yet: edit_file is refused, and the error names the read to make.
    const refused = readGuard(cs, "/w/a.ts", "a.ts", "one\ntwo\n", "edit_file");
    assert.match(
      refused?.result ?? "",
      /haven't read a\.ts.*Call read_file with \{"path": "a\.ts"\}/,
    );
    cs.noteSeen("/w/a.ts", "one\ntwo\n");
    assert.equal(readGuard(cs, "/w/a.ts", "a.ts", "one\ntwo\n", "edit_file"), null);
    // Unchanged: no note. The agent's own write isn't news either.
    assert.equal(await fileChangeNotes(services, cs, "s1"), null);
    await cs.propose("/w/a.ts", "one\nTWO\n", 1);
    assert.equal(await fileChangeNotes(services, cs, "s1"), null);
    // Someone else changes it: one note with the diff, then nothing more.
    disk.set("/w/a.ts", "one\nTWO\nthree\n");
    assert.match(
      readGuard(cs, "/w/a.ts", "a.ts", "one\nTWO\nthree\n", "write_file")?.result ?? "",
      /changed since you last read it/,
    );
    const note = await fileChangeNotes(services, cs, "s1");
    assert.match(note ?? "", /^a\.ts changed since you last read it[\s\S]*@@ line 3 @@\n\+three/);
    assert.equal(await fileChangeNotes(services, cs, "s1"), null);
    // Shown whole, the change counts as read: the edit may go ahead.
    assert.equal(readGuard(cs, "/w/a.ts", "a.ts", "one\nTWO\nthree\n", "edit_file"), null);
    // A file only written by the agent counts as read; a deleted one is told.
    await cs.propose("/w/c.ts", "new\n", 1);
    assert.equal(readGuard(cs, "/w/c.ts", "c.ts", "new\n", "edit_file"), null);
    disk.delete("/w/c.ts");
    assert.match((await fileChangeNotes(services, cs, "s1")) ?? "", /c\.ts was deleted/);
  });
});
