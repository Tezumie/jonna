import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountPageUrl,
  accountsServer,
  hasAccounts,
  hasPlanPage,
  hasSync,
  type OwnServices,
  planPageUrl,
} from "./ownServices";

const config = (over: Partial<OwnServices> = {}): OwnServices => ({
  accountsUrl: "https://accounts.example.com",
  accountPagePath: "/account",
  planPagePath: "/account#plan",
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

test("own services: a build with no plan page says nothing of plans", () => {
  const base = {
    accountsUrl: "https://example.test",
    accountPagePath: "/account",
    syncBuiltIn: true,
  };
  assert.equal(hasPlanPage({ ...base, planPagePath: "/account#plan" }), true);
  assert.equal(hasPlanPage({ ...base, planPagePath: "" }), false);
  assert.equal(hasPlanPage({ ...base, planPagePath: "  " }), false);
});
