import assert from "node:assert/strict";
import { test } from "node:test";
import { networkMode, planSandbox, type SandboxInfo, sandboxResultNote } from "./sandbox";
import {
  allowanceResult,
  cleanHost,
  DEFAULT_DENY_READ,
  PROTECT_FOLDERS,
  parseAllowanceArgs,
  parseAllowanceSuggestion,
  projectAllowances,
  projectKey,
  sandboxPolicy,
  withProjectAllowance,
} from "./sandboxPolicy";

const windows: SandboxInfo = {
  mechanism: "low-integrity",
  limitsWrites: true,
  limitsNetwork: false,
  limitsReads: true,
  network: "proxy",
  note: "Windows.",
};
const mac: SandboxInfo = {
  mechanism: "sandbox-exec",
  limitsWrites: true,
  limitsNetwork: true,
  limitsReads: true,
  network: "blocked",
  note: "macOS.",
};
const linux: SandboxInfo = { ...mac, mechanism: "bubblewrap", note: "Linux." };

test("D350: hosts are cleaned to what the filter matches", () => {
  assert.equal(cleanHost("https://Registry.NPMJS.org/pkg?x=1"), "registry.npmjs.org");
  assert.equal(cleanHost("user@example.com:8443"), "example.com");
  assert.equal(cleanHost("*.github.com"), "*.github.com");
  assert.equal(cleanHost("*"), "*");
  assert.equal(cleanHost("not a host"), null);
  assert.equal(cleanHost("a..b"), null);
  assert.equal(cleanHost(3), null);
});

test("D350: a project's allowances are found by folder, whatever its slashes and drive case", () => {
  assert.equal(projectKey("C:\\Work\\App\\"), "c:/work/app");
  assert.equal(projectKey("/home/me/app/"), "/home/me/app");
  const projects = { "C:/Work/App": { allowHosts: ["pypi.org"], allowWrite: ["D:/cache"] } };
  assert.deepEqual(projectAllowances(projects, "c:\\work\\app"), {
    allowWrite: ["D:/cache"],
    allowHosts: ["pypi.org"],
  });
  assert.deepEqual(projectAllowances(projects, "C:/Other"), { allowWrite: [], allowHosts: [] });
  assert.deepEqual(projectAllowances("junk", "C:/Work/App"), { allowWrite: [], allowHosts: [] });
  // Adding keeps what's there, under the key it already has.
  const next = withProjectAllowance(projects, "c:\\work\\app", { hosts: ["pypi.org", "x.org"] });
  assert.deepEqual(next, {
    "C:/Work/App": { allowWrite: ["D:/cache"], allowHosts: ["pypi.org", "x.org"] },
  });
  assert.deepEqual(withProjectAllowance(undefined, "/a", { folders: ["/tmp/x"] }), {
    "/a": { allowWrite: ["/tmp/x"] },
  });
});

test("D349, D350: the policy joins the user's lists and the project's; denyRead has defaults", () => {
  const p = sandboxPolicy({
    denyRead: undefined,
    allowWrite: ["/opt/cache"],
    allowHosts: ["https://registry.npmjs.org", "bad host"],
    projects: { "/w": { allowHosts: ["pypi.org"], allowWrite: ["/opt/cache", "/srv/x"] } },
    folder: "/w",
  });
  assert.deepEqual(p.denyRead, [...DEFAULT_DENY_READ]);
  assert.deepEqual(p.allowWrite, ["/opt/cache", "/srv/x"]);
  assert.deepEqual(p.allowHosts, ["registry.npmjs.org", "pypi.org"]);
  // The user emptied the list: nothing is hidden.
  const none = sandboxPolicy({
    denyRead: [],
    allowWrite: undefined,
    allowHosts: undefined,
    projects: undefined,
    folder: null,
  });
  assert.deepEqual(none, {
    denyRead: [],
    allowWrite: [],
    allowHosts: [],
    protectFolders: [...PROTECT_FOLDERS],
  });
  // D392: the IDE's own configuration folders travel with it (product.json's names).
  assert.ok(PROTECT_FOLDERS.length >= 1);
  for (const name of PROTECT_FOLDERS) assert.match(name, /^\.[^/\\]+$/);
});

test("D348: what the network limit is per system, and bubblewrap with hosts", () => {
  assert.equal(networkMode(windows), "proxy");
  assert.equal(networkMode(mac, ["pypi.org"]), "blocked");
  assert.equal(networkMode(linux), "blocked");
  assert.equal(networkMode(linux, ["pypi.org"]), "proxy");
  // An older info without the field.
  assert.equal(networkMode({ ...windows, network: undefined }), "open");
});

test("D348–D350: the permission card says what's hidden, allowed and how the network is limited", () => {
  const policy = sandboxPolicy({
    denyRead: ["~/.ssh", "~/.aws", "~/.netrc"],
    allowWrite: ["D:/cache"],
    allowHosts: ["pypi.org"],
    projects: undefined,
    folder: null,
  });
  const w = planSandbox({
    setting: "auto",
    info: windows,
    requested: undefined,
    remote: false,
    policy,
  });
  assert.equal(
    w.card,
    "In the sandbox: writes only in the folder, D:/cache and a temp folder; secrets hidden (~/.ssh, ~/.aws and 1 more); tools that use the proxy settings reach only localhost and pypi.org; other programs' connections aren't limited.",
  );
  assert.deepEqual(w.policy, policy);
  const m = planSandbox({
    setting: "auto",
    info: mac,
    requested: undefined,
    remote: false,
    policy,
  });
  assert.match(m.card, /no network except localhost and pypi\.org\.$/);
});

test("D350: refused hosts lead to suggest_sandbox_allowance", () => {
  const note = sandboxResultNote({
    info: mac,
    failed: true,
    output: "curl: (56) CONNECT tunnel failed, response 403",
    blockedHosts: ["example.com"],
    notes: ["couldn't hide /x"],
  });
  assert.match(note, /\[sandbox: couldn't hide \/x\]/);
  assert.match(
    note,
    /network filter refused example\.com\. .*suggest_sandbox_allowance with that host/,
  );
  assert.match(note, /or the network, or a hidden secret\)/);
  assert.match(note, /sandbox: false — the user is asked first/);
  // Refused but it still passed (a fallback): said, without the retry hint.
  const ok = sandboxResultNote({ info: mac, failed: false, output: "", blockedHosts: ["a.org"] });
  assert.match(ok, /refused a\.org/);
  assert.doesNotMatch(ok, /sandbox: false/);
});

test("D350: suggest_sandbox_allowance takes hosts and folders outside the project only", () => {
  const ok = parseAllowanceArgs(
    { hosts: ["https://pypi.org/simple"], folders: ["~/.cache/pip"], reason: "pip install" },
    "/home/me/app",
  );
  assert.deepEqual(ok, {
    folder: "/home/me/app",
    hosts: ["pypi.org"],
    folders: ["~/.cache/pip"],
    reason: "pip install",
  });
  if ("error" in ok) return;
  assert.match(allowanceResult(ok), /connections to pypi\.org and writes in ~\/\.cache\/pip/);
  assert.deepEqual(parseAllowanceSuggestion(JSON.stringify({ ...ok, added: true })), {
    ...ok,
    added: true,
  });
  const err = (args: Record<string, unknown>, root: string | null = "C:\\w\\app") => {
    const r = parseAllowanceArgs(args, root);
    return "error" in r ? r.error : "";
  };
  assert.match(err({ hosts: ["*"] }), /turn the network filter off/);
  assert.match(err({ hosts: ["not a host"] }), /isn't a host/);
  assert.match(err({ folders: ["C:\\"] }), /too wide/);
  assert.match(err({ folders: ["/"] }), /too wide/);
  assert.match(err({ folders: ["C:/w/app/build"] }), /writable already/);
  assert.match(err({ folders: ["relative/dir"] }), /isn't an absolute path/);
  // A `..` reaches what the checks above refuse (the drive's root, the project).
  assert.match(err({ folders: ["C:\\Windows\\.."] }), /has \. or \.\./);
  assert.match(err({ folders: ["~/x/../.."] }), /has \. or \.\./);
  assert.match(err({}), /give hosts or folders/);
  assert.match(err({ hosts: ["a.org"] }, null), /no folder is open/);
  assert.equal(parseAllowanceSuggestion("nope"), null);
});
