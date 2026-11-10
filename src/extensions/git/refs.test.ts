import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitUrl,
  initials,
  parseRefs,
  personColor,
  repoNameFrom,
  siteName,
  validRepoName,
  webUrl,
} from "./refs";

test("refs become badges: current branch first, a same-named remote compact", () => {
  const badges = parseRefs(
    ["tag: v1", "origin/main", "HEAD -> main", "origin/HEAD", "feature", "upstream/dev"],
    ["origin", "upstream"],
  );
  assert.deepEqual(
    badges.map((b) => [b.kind, b.name, b.compact]),
    [
      ["head", "main", false],
      ["branch", "feature", false],
      ["remote", "origin/main", true],
      ["remote", "upstream/dev", false],
      ["tag", "v1", false],
    ],
  );
  assert.deepEqual(
    parseRefs(["HEAD"], []).map((b) => b.kind),
    ["detached"],
  );
  // A branch named like a remote's isn't a remote branch unless that remote exists.
  assert.equal(parseRefs(["origin/x"], [])[0]?.kind, "branch");
});

test("remote URLs become web pages", () => {
  assert.equal(webUrl("git@github.com:Tezumie/ide.git"), "https://github.com/Tezumie/ide");
  assert.equal(webUrl("https://github.com/a/b.git"), "https://github.com/a/b");
  assert.equal(
    webUrl("https://user@gitlab.com/group/sub/proj"),
    "https://gitlab.com/group/sub/proj",
  );
  assert.equal(
    webUrl("ssh://git@bitbucket.org:22/team/repo.git"),
    "https://bitbucket.org/team/repo",
  );
  assert.equal(webUrl("/home/me/repo.git"), null);
  assert.equal(webUrl("C:\\repos\\x"), null);
  assert.equal(siteName("https://github.com/a/b"), "GitHub");
  assert.equal(commitUrl("https://github.com/a/b", "abc"), "https://github.com/a/b/commit/abc");
  assert.equal(commitUrl("https://gitlab.com/a/b", "abc"), "https://gitlab.com/a/b/-/commit/abc");
});

test("initials and a stable color per person", () => {
  assert.equal(initials("Ada Lovelace"), "AL");
  assert.equal(initials("tezumie"), "T");
  assert.equal(initials("Jean-Luc Picard"), "JP");
  assert.equal(initials(""), "?");
  assert.equal(personColor("a@b.c"), personColor("A@B.C"));
  assert.ok(personColor("x@y.z") >= 0 && personColor("x@y.z") < 6);
});

test("publishing names a repository after the folder", () => {
  assert.equal(repoNameFrom("My App!"), "My-App");
  assert.equal(repoNameFrom("Desktop-IDE"), "Desktop-IDE");
  assert.equal(repoNameFrom("..."), "repository");
  assert.equal(validRepoName("my-app"), undefined);
  assert.equal(validRepoName("me/my.app"), undefined);
  assert.ok(validRepoName(""));
  assert.ok(validRepoName("a b"));
  assert.ok(validRepoName("-x"));
  assert.ok(validRepoName("a/b/c"));
  assert.ok(validRepoName(".."));
  assert.equal(validRepoName(".github"), undefined);
});
