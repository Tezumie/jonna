import assert from "node:assert/strict";
import { test } from "node:test";
import { greetingName, partOfDay, pickGreeting } from "./greetings";

const at = (hour: number) => new Date(2026, 10, 2, hour);

test("partOfDay", () => {
  assert.equal(partOfDay(3), "night");
  assert.equal(partOfDay(9), "morning");
  assert.equal(partOfDay(14), "afternoon");
  assert.equal(partOfDay(20), "evening");
});

test("greetingName: the first word, shortened; none when empty", () => {
  assert.equal(greetingName("  Sam Lee "), "Sam");
  assert.equal(greetingName("x".repeat(40))?.length, 24);
  assert.equal(greetingName(""), null);
  assert.equal(greetingName(null), null);
});

test("pickGreeting: the name when known, never when not", () => {
  for (let i = 0; i < 20; i++) {
    const r = () => i / 20;
    assert.match(pickGreeting("new", "Sam", true, at(10), r), /Sam/);
    assert.doesNotMatch(pickGreeting("project", null, true, at(10), r), /undefined|, \?|,\s*$/);
  }
});

test("pickGreeting: lines for another time of day are left out", () => {
  for (let i = 0; i < 20; i++) {
    const line = pickGreeting("new", null, true, at(14), () => i / 20);
    assert.doesNotMatch(line, /Coffee and code|midnight oil/);
  }
  assert.equal(
    pickGreeting("project", null, true, at(9), () => 0),
    "Good morning",
  );
});

test("pickGreeting: a brand-new user isn't welcomed back; a returning one can be", () => {
  const back = /Welcome back|Where were we|pick this up|Back at it|Fresh start/;
  const seen = new Set<string>();
  for (const place of ["new", "project"] as const)
    for (const name of ["Sam", null])
      for (const hour of [3, 10, 14, 20])
        for (let i = 0; i < 40; i++) {
          const r = () => i / 40;
          assert.doesNotMatch(pickGreeting(place, name, false, at(hour), r), back);
          seen.add(pickGreeting(place, name, true, at(hour), r));
        }
  assert.ok([...seen].some((line) => back.test(line)));
});
