import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { looksLikeZip, readZip, zipAsText } from "./zip";

/** A minimal zip: each file stored (method 0) or deflated (8), UTF-8 names. */
function makeZip(files: { name: string; text: string; deflate?: boolean }[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.text);
    const data = f.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(f.deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(f.deflate ? 8 : 0, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(entry, name);
    offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, dir, end]));
}

test("readZip lists entries and reads stored and deflated ones", async () => {
  const zip = makeZip([
    { name: "src/", text: "" },
    { name: "src/a.ts", text: "export const a = 1;\n" },
    { name: "README.md", text: "# héllo\n".repeat(50), deflate: true },
  ]);
  assert.ok(looksLikeZip(zip));
  const entries = readZip(zip);
  assert.deepEqual(
    entries.map((e) => [e.name, e.dir]),
    [
      ["src/", true],
      ["src/a.ts", false],
      ["README.md", false],
    ],
  );
  const readme = await entries[2]?.read();
  assert.equal(new TextDecoder().decode(readme ?? new Uint8Array()), "# héllo\n".repeat(50));
});

test("read stops at its limit, whatever size the archive declares", async () => {
  const zip = makeZip([{ name: "big.txt", text: "a".repeat(100_000), deflate: true }]);
  const [entry] = readZip(zip);
  assert.equal(await entry?.read(1000), null);
  assert.equal((await entry?.read(200_000))?.length, 100_000);
});

test("readZip rejects bytes that aren't a zip", () => {
  assert.throws(() => readZip(new TextEncoder().encode("just some text, long enough to scan")));
  assert.equal(looksLikeZip(new Uint8Array([1, 2, 3, 4])), false);
});

test("zipAsText gives the path, the file list and the text files", async () => {
  const zip = makeZip([
    { name: "a.txt", text: "alpha" },
    { name: "pic.png", text: "\u0089PNG" },
    { name: "__MACOSX/._a.txt", text: "junk" },
  ]);
  const { text, files } = await zipAsText("x.zip", zip, "C:\\Downloads\\x.zip");
  assert.equal(files, 2);
  assert.match(text, /Zip archive x\.zip at C:\\Downloads\\x\.zip: 2 files/);
  assert.match(text, /=== a\.txt ===\nalpha/);
  assert.match(text, /pic\.png \(\d+ bytes\)/);
  assert.doesNotMatch(text, /=== pic\.png/);
  assert.doesNotMatch(text, /MACOSX/);
});
