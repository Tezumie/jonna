import assert from "node:assert/strict";
import { test } from "node:test";
import { accountsManifest, backupTitle, parseGhAuth, signInProviders } from "./model";

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

test("a build without an accounts server: no IDE account command or setting", () => {
  const manifest = {
    id: "builtin.accounts",
    version: "0.1.0",
    activation: ["*"],
    contributes: {
      commands: [
        { id: "accounts.signIn", title: "Sign in…" },
        { id: "accounts.cancelSignIn", title: "Cancel sign-in" },
        { id: "accounts.syncSettings", title: "Backup and sync settings…" },
      ],
      settings: {
        "accounts.serverUrl": { type: "string", default: "", description: "The accounts server." },
      },
    },
  };
  // Everything, as written, in a build with both.
  assert.deepEqual(accountsManifest(manifest, { accounts: true, sync: true }), manifest);
  const none = accountsManifest(manifest, { accounts: false, sync: false });
  assert.deepEqual(
    none.contributes?.commands?.map((c) => c.id),
    ["accounts.signIn", "accounts.syncSettings"],
  );
  assert.deepEqual(none.contributes?.settings, {});
  assert.equal(none.contributes?.commands?.[1]?.title, "Back up settings…");
  // Accounts without Sync: the account stays, sync leaves the title.
  const noSync = accountsManifest(manifest, { accounts: true, sync: false });
  assert.equal(noSync.contributes?.commands?.length, 3);
  assert.equal(backupTitle(true), "Backup and sync settings…");
  assert.deepEqual(signInProviders(true), ["ide", "github"]);
  assert.deepEqual(signInProviders(false), ["github"]);
});
