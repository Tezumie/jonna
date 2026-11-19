import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeUrl,
  challengeOf,
  fromOwnLaunch,
  LAUNCH_WITHIN_MS,
  launchUrl,
  randomToken,
  readArrival,
  readPending,
} from "./launch";

test("launch: what the page was opened with", () => {
  assert.deepEqual(readArrival(""), { kind: "bare" });
  assert.deepEqual(readArrival("#"), { kind: "bare" });
  assert.deepEqual(readArrival("#connect"), { kind: "form" });
  assert.deepEqual(readArrival("#workspace"), { kind: "workspace" });
  assert.deepEqual(readArrival("#h=wss://a.example&t=code"), {
    kind: "link",
    link: { address: "wss://a.example", token: "code" },
  });
  assert.deepEqual(readArrival("#h=wss://a.example&t=code&n=abcdefgh12&c=CODE_code-1"), {
    kind: "link",
    link: { address: "wss://a.example", token: "code" },
    nonce: "abcdefgh12",
    code: "CODE_code-1",
  });
  // A link wins over a word beside it: nobody is sent on a trip by a link that names a host.
  assert.equal(readArrival("#workspace&h=wss://a.example&t=x").kind, "link");
  assert.deepEqual(readArrival("#signin&code=abcdefgh&state=12345678"), {
    kind: "signIn",
    code: "abcdefgh",
    state: "12345678",
  });
  // Half a sign-in, or one with anything but plain letters, is nothing.
  assert.deepEqual(readArrival("#signin&code=abcdefgh"), { kind: "signInEnded" });
  assert.deepEqual(readArrival("#signin&error=access_denied&state=12345678"), {
    kind: "signInEnded",
  });
  assert.deepEqual(readArrival("#signin&code=<script>&state=12345678"), {
    kind: "signInEnded",
  });
  assert.equal(
    (readArrival("#h=a&t=b&n=bad nonce!") as { nonce?: string }).nonce,
    undefined,
    "a number that isn't plain is dropped",
  );
});

test("launch: only a link with this tab's own number is followed", () => {
  const now = 1_000_000;
  const pending = { nonce: "abcdefgh12", at: now - 5000 };
  const back = readArrival("#h=wss://a.example&t=code&n=abcdefgh12");
  assert.equal(fromOwnLaunch(back, pending, now), true);
  assert.equal(fromOwnLaunch(back, null, now), false, "no trip was begun");
  assert.equal(fromOwnLaunch(back, { ...pending, nonce: "another123" }, now), false);
  assert.equal(fromOwnLaunch(readArrival("#h=wss://a.example&t=code"), pending, now), false);
  assert.equal(fromOwnLaunch(readArrival("#h=wss://a.example&n=abcdefgh12"), pending, now), false);
  assert.equal(
    fromOwnLaunch(back, { ...pending, at: now - LAUNCH_WITHIN_MS - 1 }, now),
    false,
    "a trip that old is over",
  );
  assert.equal(fromOwnLaunch(back, { ...pending, at: now + 60_000 }, now), false);
  assert.equal(fromOwnLaunch(readArrival("#workspace"), pending, now), false);
});

test("launch: the trip's address, and what is kept of it", () => {
  assert.equal(
    launchUrl("https://example.com/workspace", "abcdefgh12"),
    "https://example.com/workspace#n=abcdefgh12",
  );
  assert.equal(
    launchUrl("https://example.com/workspace#old", "abcdefgh12", "chal"),
    "https://example.com/workspace#n=abcdefgh12&c=chal",
  );
  assert.deepEqual(
    readPending(JSON.stringify({ nonce: "abcdefgh12", at: 5, verifier: "v".repeat(43) })),
    {
      nonce: "abcdefgh12",
      at: 5,
      verifier: "v".repeat(43),
    },
  );
  assert.equal(readPending(null), null);
  assert.equal(readPending("{"), null);
  assert.equal(readPending(JSON.stringify({ nonce: "x y", at: 5 })), null);
  assert.equal(readPending(JSON.stringify({ nonce: "abcdefgh12" })), null);
});

test("launch: tokens are plain text, and the challenge is PKCE's", async () => {
  const token = randomToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, randomToken());
  // RFC 7636 appendix B.
  assert.equal(
    await challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  const url = new URL(
    authorizeUrl("https://example.com/", "https://app.example.com/", "chal", "st"),
  );
  assert.equal(url.origin + url.pathname, "https://example.com/oauth/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.example.com/");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("client_id"), "desktop");
});
