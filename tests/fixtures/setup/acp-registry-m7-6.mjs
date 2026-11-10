// A local ACP agent registry for tests/scripts/acp-registry-m7-6.jsonc (D215): serves
// /registry.json and a tiny archive holding a "binary" agent for this platform (a launcher
// around tools/mock-acp.mjs from the test's folder: a .tar.gz with a shell script on Linux and
// macOS, a .zip with a .cmd on Windows), its SHA-256 in the registry, plus one whose SHA-256 is
// wrong and one npx agent. Usage (from the sample folder): node ../setup/acp-registry-m7-6.mjs [port]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { crc32, gzipSync } from "node:zlib";

const port = Number(process.argv[2] ?? 11994);
const base = `http://127.0.0.1:${port}`;
const windows = process.platform === "win32";
const platform = `${{ win32: "windows", darwin: "darwin", linux: "linux" }[process.platform]}-${
  process.arch === "arm64" ? "aarch64" : "x86_64"
}`;
const mock = readFileSync(join(process.cwd(), "tools/mock-acp.mjs"));

/** A ustar archive of [name, data, mode]. */
function tar(files) {
  const blocks = [];
  for (const [name, data, mode] of files) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write(`${mode.toString(8).padStart(7, "0")}\0`, 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    h.write(
      `${Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, "0")}\0`,
      136,
    );
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** A stored zip of [name, data]. */
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, n, data);
    central.push(dir, n);
    offset += 30 + n.length + data.length;
  }
  const dirBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dirBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dirBytes, end]);
}

const archive = windows
  ? zip([
      ["mock-agent/agent.cmd", Buffer.from('@echo off\r\nnode "%~dp0mock-acp.mjs" %*\r\n')],
      ["mock-agent/mock-acp.mjs", mock],
    ])
  : gzipSync(
      tar([
        [
          "mock-agent/agent",
          Buffer.from('#!/bin/sh\nexec node "$(dirname "$0")/mock-acp.mjs" "$@"\n'),
          0o755,
        ],
        ["mock-agent/mock-acp.mjs", mock, 0o644],
      ]),
    );
const archiveName = windows ? "mock-agent.zip" : "mock-agent.tar.gz";
const sha256 = createHash("sha256").update(archive).digest("hex");
const icon = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>')}`;
const binary = (sha) => ({
  [platform]: {
    archive: `${base}/${archiveName}`,
    sha256: sha,
    cmd: windows ? "./mock-agent\\agent.cmd" : "./mock-agent/agent",
  },
});
const registry = {
  version: "1.0.0",
  agents: [
    {
      id: "mock-binary",
      name: "Mock binary agent",
      version: "1.0.0",
      description: "A test agent downloaded as an archive",
      repository: "https://github.com/example/mock-binary",
      website: "https://example.com/mock-binary",
      authors: ["Test Authors"],
      license: "MIT",
      license_url: "https://github.com/example/mock-binary/blob/main/LICENSE",
      icon,
      distribution: { binary: binary(sha256) },
    },
    {
      id: "mock-bad-sha",
      name: "Mock tampered agent",
      version: "1.0.0",
      description: "Its download doesn't match the listed SHA-256",
      license: "MIT",
      distribution: { binary: binary("0".repeat(64)) },
    },
    {
      id: "mock-npx",
      name: "Mock npx agent",
      version: "2.0.0",
      description: "Runs with npx",
      license: "Apache-2.0",
      distribution: { npx: { package: "@example/mock-npx-agent@2.0.0", args: ["--acp"] } },
    },
    {
      id: "corust-like",
      name: "Copyleft agent",
      version: "1.0.0",
      description: "Left out: GPL",
      license: "GPL-3.0-only",
      distribution: { npx: { package: "copyleft-agent" } },
    },
  ],
};

createServer((req, res) => {
  if (req.url === "/registry.json") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(registry));
  } else if (req.url === `/${archiveName}`) {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": archive.length,
    });
    res.end(archive);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`Server running at http://localhost:${port}/`));
