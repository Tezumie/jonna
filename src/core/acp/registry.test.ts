import assert from "node:assert/strict";
import { test } from "node:test";
import snapshot from "../../assets/acp-registry/registry.json";
import {
  agentDisplayName,
  allowedUrl,
  chooseRun,
  compareVersions,
  filterAgents,
  packageLaunch,
  parseRegistry,
  pathProgram,
  type RegistryAgent,
  safeCommandPath,
  sanitizeInstalledMap,
  sanitizeSvg,
} from "./registry";

const SHA = "a".repeat(64);
const agent = (over: Record<string, unknown> = {}) => ({
  id: "demo",
  name: "Demo",
  version: "1.2.3",
  description: "A demo agent",
  repository: "https://github.com/acme/demo",
  authors: ["Acme"],
  license: "MIT",
  license_url: "https://github.com/acme/demo/blob/main/LICENSE",
  distribution: { npx: { package: "@acme/demo@1.2.3", args: ["--acp"] } },
  ...over,
});

test("parseRegistry: the bundled snapshot parses with nothing skipped (D215)", () => {
  const parsed = parseRegistry(snapshot);
  assert.deepEqual(parsed.skipped, []);
  assert.ok(parsed.agents.length >= 30);
  for (const id of ["claude-acp", "codex-acp", "gemini", "github-copilot-cli", "cursor", "goose"])
    assert.ok(
      parsed.agents.some((a) => a.id === id),
      id,
    );
  // Quarantined and copyleft agents were left out when it was made.
  for (const id of ["corust-agent", "minion-code", "vtcode", "qoder"])
    assert.ok(!parsed.agents.some((a) => a.id === id), id);
  // Every icon is inline and one-color.
  assert.ok(
    parsed.agents.every((a) => a.icon?.src.startsWith("data:image/svg+xml,") && a.icon.mono),
  );
});

test("parseRegistry: a bad agent is skipped with its reason, the rest kept", () => {
  const parsed = parseRegistry({
    version: "1.0.0",
    agents: [
      agent(),
      agent({ id: "../evil" }),
      agent({ id: "gpl", license: "GPL-3.0-or-later" }),
      agent({ id: "agpl", license: "AGPL-3.0" }),
      agent({ id: "pkg", distribution: { npx: { package: "demo; rm -rf /" } } }),
      agent({ id: "none", distribution: {} }),
      agent({ id: "envy", distribution: { npx: { package: "x", env: { LD_PRELOAD: "/x.so" } } } }),
      agent({ id: "http", repository: "http://example.com" }),
      agent({
        id: "slip",
        distribution: {
          binary: { "linux-x86_64": { archive: "https://e.com/a.tar.gz", cmd: "../../bin/sh" } },
        },
      }),
      agent({
        id: "abs",
        distribution: {
          binary: { "windows-x86_64": { archive: "https://e.com/a.zip", cmd: "C:\\x.exe" } },
        },
      }),
      agent({
        id: "badsha",
        distribution: {
          binary: {
            "linux-x86_64": { archive: "https://e.com/a.tgz", cmd: "./a", sha256: "nope" },
          },
        },
      }),
      agent({
        id: "dmg",
        distribution: {
          binary: { "darwin-aarch64": { archive: "https://e.com/a.dmg", cmd: "./a" } },
        },
      }),
      agent(),
      "not an object",
    ],
  });
  assert.deepEqual(
    parsed.agents.map((a) => a.id),
    ["demo"],
  );
  const reasons = Object.fromEntries(parsed.skipped.map((s) => [s.id, s.reason]));
  assert.match(reasons["../evil"] ?? "", /plain name/);
  assert.match(reasons.gpl ?? "", /copyleft/);
  assert.match(reasons.agpl ?? "", /copyleft/);
  assert.match(reasons.pkg ?? "", /package name/);
  assert.match(reasons.none ?? "", /no way to run/);
  assert.match(reasons.envy ?? "", /LD_PRELOAD/);
  assert.match(reasons.http ?? "", /https/);
  assert.match(reasons.slip ?? "", /leaves its folder/);
  assert.match(reasons.abs ?? "", /leaves its folder/);
  assert.match(reasons.badsha ?? "", /SHA-256/);
  assert.match(reasons.dmg ?? "", /installer/);
  assert.match(reasons.demo ?? "", /twice/);
  assert.equal(parsed.skipped.length, 13);
});

test("parseRegistry: refuses what isn't a registry", () => {
  assert.throws(() => parseRegistry(null), /Not an agent registry/);
  assert.throws(() => parseRegistry({ agents: {} }), /Not an agent registry/);
  assert.throws(() => parseRegistry({ agents: new Array(600).fill(agent()) }), /too many/);
});

test("parseRegistry: binary targets, checksums lowercased, unknown platforms ignored", () => {
  const { agents } = parseRegistry({
    agents: [
      agent({
        distribution: {
          binary: {
            "linux-x86_64": {
              archive: "https://e.com/a.tar.gz",
              sha256: SHA.toUpperCase(),
              cmd: "./dist/demo",
              args: ["acp"],
            },
            "windows-x86_64": { archive: "https://e.com/a.zip", cmd: "./dist\\demo.cmd" },
            "plan9-mips": { archive: "https://e.com/a.zip", cmd: "./demo" },
          },
        },
      }),
    ],
  });
  const binary = agents[0]?.distribution.binary;
  assert.equal(binary?.["linux-x86_64"]?.sha256, SHA);
  assert.deepEqual(binary?.["linux-x86_64"]?.args, ["acp"]);
  assert.equal(binary?.["windows-x86_64"]?.sha256, undefined);
  assert.deepEqual(Object.keys(binary ?? {}).sort(), ["linux-x86_64", "windows-x86_64"]);
});

test("parseRegistry: loopback archives only when allowed (test builds)", () => {
  const raw = {
    agents: [
      agent({
        distribution: {
          binary: { "linux-x86_64": { archive: "http://127.0.0.1:9/a.tgz", cmd: "./a" } },
        },
      }),
    ],
  };
  assert.equal(parseRegistry(raw).agents.length, 0);
  assert.equal(parseRegistry(raw, { allowLoopback: true }).agents.length, 1);
  assert.equal(allowedUrl("http://localhost:1/x", true), true);
  assert.equal(allowedUrl("http://10.0.0.1/x", true), false);
  assert.equal(allowedUrl("https://user:pw@e.com/x"), false);
});

test("sanitizeSvg: scripts, handlers, links, styles and foreignObject are refused", () => {
  const ok =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="currentColor" d="M0 0h16v16z"/></svg>';
  assert.ok(sanitizeSvg(ok)?.mono);
  assert.equal(sanitizeSvg(ok.replace("currentColor", "#ff0000"))?.mono, false);
  for (const bad of [
    "<svg><script>alert(1)</script></svg>",
    '<svg onload="alert(1)"></svg>',
    "<svg><foreignObject><div/></foreignObject></svg>",
    '<svg><a href="javascript:alert(1)"/></svg>',
    '<svg><image href="https://tracker.example/x.png"/></svg>',
    '<svg><use href="https://e.com/x.svg#a"/></svg>',
    "<svg><style>@import url(https://e.com/x.css)</style></svg>",
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
    "<html><svg/></html>",
    `<svg>${"x".repeat(40_000)}</svg>`,
  ])
    assert.equal(sanitizeSvg(bad), null, bad.slice(0, 40));
  // An inline data URL icon is checked again; a remote one is kept as an address to fetch.
  const viaData = parseRegistry({
    agents: [agent({ icon: `data:image/svg+xml,${encodeURIComponent("<svg onload=x>")}` })],
  });
  assert.equal(viaData.agents[0]?.icon, undefined);
  const remote = parseRegistry({ agents: [agent({ icon: "https://cdn.example/demo.svg" })] });
  assert.equal(remote.agents[0]?.iconUrl, "https://cdn.example/demo.svg");
});

test("safeCommandPath", () => {
  assert.ok(safeCommandPath("./kimi"));
  assert.ok(safeCommandPath("./dist-package\\cursor-agent.cmd"));
  assert.ok(!safeCommandPath("../x"));
  assert.ok(!safeCommandPath("a/../../x"));
  assert.ok(!safeCommandPath("/bin/sh"));
  assert.ok(!safeCommandPath("C:\\Windows\\cmd.exe"));
  assert.ok(!safeCommandPath("./"));
});

const parsedOne = (distribution: unknown): RegistryAgent => {
  const a = parseRegistry({ agents: [agent({ distribution })] }).agents[0];
  assert.ok(a);
  return a;
};

test("chooseRun: binary for this platform first, then npx with Node, uvx with uv", () => {
  const both = parsedOne({
    binary: { "linux-x86_64": { archive: "https://e.com/k.tgz", cmd: "./kilo", args: ["acp"] } },
    npx: { package: "@kilocode/cli@1.0.0", args: ["acp"] },
  });
  assert.equal(chooseRun(both, "linux-x86_64", { npx: true, uvx: false })?.kind, "binary");
  // No build for this platform: npx.
  assert.equal(chooseRun(both, "windows-aarch64", { npx: true, uvx: false })?.kind, "npx");
  assert.equal(chooseRun(both, null, { npx: false, uvx: false })?.kind, "npx");
  const py = parsedOne({ uvx: { package: "fast-agent-acp==0.10.1", args: ["-x"] } });
  assert.equal(chooseRun(py, "linux-x86_64", { npx: true, uvx: true })?.kind, "uvx");
  const onlyMac = parsedOne({
    binary: { "darwin-aarch64": { archive: "https://e.com/a.tgz", cmd: "./a" } },
  });
  assert.equal(chooseRun(onlyMac, "linux-x86_64", { npx: true, uvx: true }), null);
  assert.deepEqual(packageLaunch("npx", { package: "@a/b@1", args: ["--acp"], env: {} }), {
    command: "npx",
    args: ["-y", "@a/b@1", "--acp"],
    env: {},
  });
  assert.deepEqual(packageLaunch("uvx", { package: "p==1", args: [], env: { A: "1" } }).args, [
    "p==1",
  ]);
});

test("pathProgram: the program a person would have on PATH", () => {
  const t = (cmd: string) => pathProgram({ archive: "", cmd, args: [], env: {} });
  assert.equal(t("./kimi"), "kimi");
  assert.equal(t("./dist-package\\cursor-agent.cmd"), "cursor-agent");
  assert.equal(t("./kimi.exe"), "kimi");
  assert.equal(t("./sigit-linux-amd64"), null);
});

test("agentDisplayName: GitHub's two Copilots, and names already taken", () => {
  const all = [
    { id: "github-copilot-cli", name: "Copilot" },
    { id: "github-copilot", name: "Copilot" },
    { id: "cursor", name: "Cursor" },
  ];
  assert.equal(agentDisplayName(all[0] as RegistryAgent, all, new Set()), "Copilot");
  assert.equal(
    agentDisplayName(all[1] as RegistryAgent, all, new Set()),
    "Copilot (github-copilot)",
  );
  assert.equal(
    agentDisplayName(all[2] as RegistryAgent, all, new Set(["Cursor"])),
    "Cursor (cursor)",
  );
});

test("filterAgents and compareVersions", () => {
  const { agents } = parseRegistry(snapshot);
  assert.deepEqual(
    filterAgents(agents, "goose").map((a) => a.id),
    ["goose"],
  );
  assert.ok(filterAgents(agents, "").length === agents.length);
  assert.equal(compareVersions("1.10.0", "1.9.2"), 1);
  assert.equal(compareVersions("2026.10.22", "2026.10.22"), 0);
  assert.equal(compareVersions("0.9", "0.10"), -1);
});

test("sanitizeInstalledMap: keeps checked entries only", () => {
  const map = sanitizeInstalledMap({
    kimi: {
      id: "kimi",
      name: "Kimi CLI",
      version: "1.52.0",
      kind: "binary",
      command: "/data/acp-agents/kimi/1.52.0/kimi",
      args: ["acp"],
      env: {},
      verified: true,
      installedAt: 1,
    },
    other: { id: "nope", name: "x", version: "1", kind: "npx", command: "npx" },
    bad: { id: "bad", name: "x", version: "1", kind: "shell", command: "sh" },
    envy: {
      id: "envy",
      name: "x",
      version: "1",
      kind: "npx",
      command: "npx",
      env: { NODE_OPTIONS: "--require /x.js" },
    },
  });
  assert.deepEqual(Object.keys(map), ["kimi"]);
  assert.equal(map.kimi?.verified, true);
});
