import assert from "node:assert/strict";
import { test } from "node:test";
import { accountsServer, parseGhAuth } from "./model";

test("gh auth status: new and old formats, active account", () => {
  const now = `github.com
  ✓ Logged in to github.com account octo (keyring)
  - Active account: true
  - Git operations protocol: https

  ✓ Logged in to github.com account work-me (keyring)
  - Active account: false`;
  assert.deepEqual(parseGhAuth(now), [
    { host: "github.com", login: "octo", active: true },
    { host: "github.com", login: "work-me", active: false },
  ]);
  assert.deepEqual(parseGhAuth("github.com\n  ✓ Logged in to github.com as old (oauth_token)"), [
    { host: "github.com", login: "old", active: true },
  ]);
  assert.deepEqual(parseGhAuth("You are not logged into any GitHub hosts."), []);
});

test("the setting overrides the product's server", () => {
  assert.equal(accountsServer("", ""), "");
  assert.equal(accountsServer(undefined, "https://a.example/"), "https://a.example");
  assert.equal(
    accountsServer(" http://127.0.0.1:8787/ ", "https://a.example"),
    "http://127.0.0.1:8787",
  );
});
