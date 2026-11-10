import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorityString,
  formatRemoteLocation,
  isRemoteLocation,
  parseAuthority,
  parseRemoteLocation,
  remoteLabel,
  validHost,
} from "./remoteLocation";

test("remote locations round-trip (D252)", () => {
  const loc = { authority: { kind: "ssh" as const, host: "me@box:2222" }, path: "/home/me/my app" };
  const text = formatRemoteLocation(loc);
  assert.equal(text, "ssh://me@box:2222/home/me/my%20app");
  assert.deepEqual(parseRemoteLocation(text), loc);
  assert.deepEqual(parseRemoteLocation("ssh://box"), {
    authority: { kind: "ssh", host: "box" },
    path: "/",
  });
  assert.deepEqual(
    parseRemoteLocation("wsl://Ubuntu/root/x.code-workspace")?.path,
    "/root/x.code-workspace",
  );
  // Local paths and junk aren't remote.
  for (const local of ["C:\\x", "/home/me", "\\\\srv\\share", "ssh:/x", "ftp://box/x", "ssh:///x"])
    assert.equal(isRemoteLocation(local), false, local);
  assert.equal(parseRemoteLocation("ssh://box/a/../etc"), null);
  assert.equal(parseRemoteLocation("ssh://box/%E0%A4%A"), null);
});

test("hosts can't smuggle options or shell syntax", () => {
  assert.ok(validHost("ssh", "box"));
  assert.ok(validHost("ssh", "me@10.0.0.2:22"));
  assert.ok(validHost("ssh", "[fe80::1%25eth0]"));
  for (const bad of ["-oProxyCommand=calc", "box;rm", "a b", "box/x", "'box'", "$(x)", ""])
    assert.equal(validHost("ssh", bad), false, bad);
  assert.ok(validHost("wsl", "Ubuntu-24.04"));
  assert.equal(validHost("wsl", "Ubuntu 24"), false);
  assert.equal(parseRemoteLocation("ssh://-oProxyCommand=x/home"), null);
});

test("authorities and labels", () => {
  assert.deepEqual(parseAuthority("ssh:me@box"), { kind: "ssh", host: "me@box" });
  assert.equal(parseAuthority("ssh:-x"), null);
  assert.equal(parseAuthority("box"), null);
  assert.equal(authorityString({ kind: "wsl", host: "Ubuntu" }), "wsl:Ubuntu");
  assert.equal(remoteLabel({ kind: "ssh", host: "box" }), "SSH: box");
});

test("dev containers: container:<user@id> (D266)", () => {
  assert.deepEqual(parseAuthority("container:node@0123456789ab"), {
    kind: "container",
    host: "node@0123456789ab",
  });
  assert.equal(parseAuthority("container:a@b@c"), null);
  assert.equal(parseAuthority("container:-oops"), null);
  assert.equal(parseAuthority("container:x;rm"), null);
  assert.equal(
    remoteLabel({ kind: "container", host: "0123456789ab" }),
    "Dev container: 0123456789ab",
  );
  assert.deepEqual(parseRemoteLocation("container://node@0123456789ab/workspaces/app"), {
    authority: { kind: "container", host: "node@0123456789ab" },
    path: "/workspaces/app",
  });
});
