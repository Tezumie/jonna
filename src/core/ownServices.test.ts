import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountPageUrl,
  accountsServer,
  hasAccounts,
  hasPlanPage,
  hasSync,
  hasTeamPage,
  hasTeams,
  type OwnServices,
  planPageUrl,
  teamPageUrl,
  webAppUrl,
} from "./ownServices";

const config = (over: Partial<OwnServices> = {}): OwnServices => ({
  accountsUrl: "https://accounts.example.com",
  accountPagePath: "/account",
  planPagePath: "/account#plan",
  teamPagePath: "/account#team",
  webAppPath: "",
  syncBuiltIn: true,
  ...over,
});

test("own services: a build without an accounts server has no accounts and no sync", () => {
  assert.equal(hasAccounts(config()), true);
  assert.equal(hasSync(config()), true);
  assert.equal(hasAccounts(config({ accountsUrl: "" })), false);
  assert.equal(hasAccounts(config({ accountsUrl: "  " })), false);
  assert.equal(hasSync(config({ accountsUrl: "" })), false);
});

test("own services: sync can be left out of a build that has accounts", () => {
  const without = config({ syncBuiltIn: false });
  assert.equal(hasAccounts(without), true);
  assert.equal(hasSync(without), false);
});

test("own services: the setting overrides the build's server, when the build has one", () => {
  assert.equal(accountsServer(undefined, config()), "https://accounts.example.com");
  assert.equal(
    accountsServer("", config({ accountsUrl: "https://a.example/" })),
    "https://a.example",
  );
  assert.equal(accountsServer(" http://127.0.0.1:8787/ ", config()), "http://127.0.0.1:8787");
  // Only this computer itself: a settings file can't point the account at someone's server.
  for (const local of ["http://localhost:5000", "http://[::1]:8787", "https://dev.localhost"]) {
    assert.equal(accountsServer(local, config(), false), local);
  }
  for (const elsewhere of [
    "https://evil.example",
    "http://127.0.0.1.evil.example",
    "http://localhost.evil.example:80",
    "http://user@127.0.0.1@evil.example",
    "http://192.168.1.5:8787",
    "file:///localhost",
    "not a url",
  ]) {
    assert.equal(
      accountsServer(elsewhere, config(), false),
      "https://accounts.example.com",
      elsewhere,
    );
  }
  // A development build takes any server (a staging one, another machine on the network).
  assert.equal(
    accountsServer("https://staging.example/", config(), true),
    "https://staging.example",
  );
  // No accounts in the build: a setting left in someone's file doesn't bring them back.
  assert.equal(accountsServer("", config({ accountsUrl: "" })), "");
  assert.equal(accountsServer("http://127.0.0.1:8787", config({ accountsUrl: "" })), "");
});

test("own services: the pages the app opens", () => {
  assert.equal(
    accountPageUrl("https://accounts.example.com", config()),
    "https://accounts.example.com/account",
  );
  assert.equal(
    planPageUrl("https://accounts.example.com/", config()),
    "https://accounts.example.com/account#plan",
  );
  // The server in use (the setting, while developing it) is the one the pages are on.
  assert.equal(
    planPageUrl("http://127.0.0.1:8787", config()),
    "http://127.0.0.1:8787/account#plan",
  );
  // Other paths, with or without the leading slash.
  const own = config({ accountPagePath: "me", planPagePath: "/billing?from=app" });
  assert.equal(accountPageUrl("https://a.example", own), "https://a.example/me");
  assert.equal(planPageUrl("https://a.example", own), "https://a.example/billing?from=app");
  // A page that lives somewhere else is opened as it is.
  const elsewhere = config({ planPagePath: "https://billing.example.com/portal" });
  assert.equal(planPageUrl("https://a.example", elsewhere), "https://billing.example.com/portal");
  assert.equal(accountPageUrl("https://a.example", elsewhere), "https://a.example/account");
});

test("own services: the team page, and a build whose service has no teams", () => {
  assert.equal(
    teamPageUrl("https://accounts.example.com/", config()),
    "https://accounts.example.com/account#team",
  );
  assert.equal(
    teamPageUrl("http://127.0.0.1:8787", config()),
    "http://127.0.0.1:8787/account#team",
  );
  assert.equal(
    teamPageUrl("https://a.example", config({ teamPagePath: "https://teams.example.com/mine" })),
    "https://teams.example.com/mine",
  );
  assert.equal(hasTeamPage(config()), true);
  assert.equal(hasTeamPage(config({ teamPagePath: "" })), false);
  assert.equal(hasTeamPage(config({ teamPagePath: "  " })), false);
  // The plan page stays when there are no teams.
  assert.equal(hasPlanPage(config({ teamPagePath: "" })), true);
});

test("own services: a build with no plan page says nothing of plans", () => {
  const base = {
    accountsUrl: "https://example.test",
    accountPagePath: "/account",
    teamPagePath: "/account#team",
    webAppPath: "",
    syncBuiltIn: true,
  };
  assert.equal(hasPlanPage({ ...base, planPagePath: "/account#plan" }), true);
  assert.equal(hasPlanPage({ ...base, planPagePath: "" }), false);
  assert.equal(hasPlanPage({ ...base, planPagePath: "  " }), false);
});

test("own services: teams' libraries need Sync in the build and a service with teams", () => {
  assert.equal(hasTeams(config()), true);
  assert.equal(hasTeams(config({ teamPagePath: "" })), false);
  assert.equal(hasTeams(config({ syncBuiltIn: false })), false);
  assert.equal(hasTeams(config({ accountsUrl: "" })), false);
});

test("own services: the web page is where the build says, or nowhere", () => {
  assert.equal(webAppUrl(config()), null);
  assert.equal(webAppUrl(config({ webAppPath: "/app/" })), "https://accounts.example.com/app/");
  assert.equal(
    webAppUrl(config({ webAppPath: "https://ide.example.com/" })),
    "https://ide.example.com/",
  );
  // A path needs a server to be a path of.
  assert.equal(webAppUrl(config({ accountsUrl: "", webAppPath: "/app/" })), null);
});
