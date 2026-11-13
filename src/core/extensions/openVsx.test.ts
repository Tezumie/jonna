import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatCount,
  isNewerVersion,
  isStoreUrl,
  offeredUpdate,
  oldEnough,
  parseStoreDetails,
  parseStoreSearch,
  readmeImageSource,
  readmeLink,
  storeVersions,
} from "./openVsx";

test("search results keep what the view shows and drop entries without a usable name", () => {
  const r = parseStoreSearch(
    JSON.stringify({
      offset: 0,
      totalSize: 412,
      extensions: [
        {
          namespace: "dracula-theme",
          name: "theme-dracula",
          version: "2.25.1",
          displayName: "Dracula Theme Official",
          description: "Official Dracula Theme.",
          downloadCount: 1200000,
          averageRating: 4.6,
          verified: true,
        },
        { namespace: "../x", name: "evil", version: "1.0.0" },
        { namespace: "a", name: "b" },
        { namespace: "PKief", name: "material-icon-theme", version: "5.10.0" },
      ],
    }),
  );
  assert.equal(r.total, 412);
  assert.deepEqual(
    r.items.map((i) => i.id),
    ["dracula-theme.theme-dracula", "pkief.material-icon-theme"],
  );
  assert.equal(r.items[0]?.rating, 4.6);
  assert.equal(r.items[0]?.verified, true);
  // No display name: its name.
  assert.equal(r.items[1]?.displayName, "material-icon-theme");
  assert.throws(() => parseStoreSearch("<html>"), /isn't JSON/);
  assert.throws(() => parseStoreSearch('{"error":"Rate limited"}'), /Rate limited/);
});

test("details: Open VSX's not-found is null", () => {
  assert.equal(parseStoreDetails('{"error":"Extension not found: a.b"}'), null);
  assert.equal(
    parseStoreDetails('{"namespace":"a","name":"b","version":"1.0.0"}')?.version,
    "1.0.0",
  );
});

test("details: the page's facts, links only on the web, files only from Open VSX", () => {
  const d = parseStoreDetails(
    JSON.stringify({
      namespace: "esbenp",
      name: "prettier-vscode",
      version: "12.4.0",
      displayName: "Prettier - Code formatter",
      namespaceDisplayName: "Prettier",
      publishedBy: { fullName: "Someone", loginName: "someone" },
      timestamp: "2026-03-16T19:14:43.319347Z",
      reviewCount: 17,
      license: "MIT",
      homepage: "javascript:alert(1)",
      repository: "git+https://github.com/prettier/prettier-vscode.git",
      bugs: "https://github.com/prettier/prettier-vscode/issues",
      categories: ["Formatters"],
      tags: ["__web_extension", "formatter", "prettier"],
      downloadSizes: { universal: 3643663 },
      engines: { vscode: "^1.101.0" },
      files: {
        icon: "https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png",
        readme: "https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/readme.md",
        changelog: "https://evil.example/changelog.md",
        manifest: "http://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/package.json",
      },
    }),
  );
  assert.ok(d);
  assert.equal(d.publisher, "Prettier");
  assert.equal(d.iconUrl, "https://open-vsx.org/api/esbenp/prettier-vscode/12.4.0/file/icon.png");
  assert.equal(d.files.readme?.endsWith("/readme.md"), true);
  assert.equal(d.files.changelog, undefined);
  assert.equal(d.files.manifest, undefined);
  assert.equal(d.homepage, undefined);
  assert.equal(d.repository, "https://github.com/prettier/prettier-vscode");
  assert.deepEqual(d.tags, ["formatter", "prettier"]);
  assert.equal(d.size, 3643663);
  assert.equal(d.engine, "^1.101.0");
  assert.equal(d.reviewCount, 17);
});

test("details: an extension pack's members, well-formed ids only", () => {
  const d = parseStoreDetails(
    JSON.stringify({
      namespace: "ms-toolsai",
      name: "jupyter",
      version: "2025.9.0",
      bundledExtensions: [
        { namespace: "ms-toolsai", extension: "jupyter-keymap" },
        { namespace: "ms-toolsai", extension: "jupyter-renderers" },
        { namespace: "../x", extension: "y" },
        "ms-python.python",
        null,
      ],
    }),
  );
  assert.deepEqual(d?.pack, ["ms-toolsai.jupyter-keymap", "ms-toolsai.jupyter-renderers"]);
  assert.deepEqual(parseStoreDetails('{"namespace":"a","name":"b","version":"1.0.0"}')?.pack, []);
});

test("store addresses: Open VSX's hosts over https only", () => {
  assert.equal(isStoreUrl("https://open-vsx.org/api/a/b"), true);
  assert.equal(isStoreUrl("https://openvsx.eclipsecontent.org/a/b/1/icon.png"), true);
  assert.equal(isStoreUrl("http://open-vsx.org/api/a/b"), false);
  assert.equal(isStoreUrl("https://open-vsx.org.evil.example/x"), false);
  assert.equal(isStoreUrl("https://user:pw@open-vsx.org/x"), false);
  assert.equal(isStoreUrl("not a url"), false);
});

test("README images: Open VSX's files through the store, others through remote images", () => {
  const base = "https://open-vsx.org/api/a/b/1.0.0/file/readme.md";
  assert.deepEqual(readmeImageSource("images/shot.png", base), {
    kind: "store",
    url: "https://open-vsx.org/api/a/b/1.0.0/file/images/shot.png",
  });
  assert.deepEqual(readmeImageSource("https://img.shields.io/badge/x-y-blue", base), {
    kind: "remote",
    url: "https://img.shields.io/badge/x-y-blue",
  });
  assert.equal(readmeImageSource("http://example.com/a.png", base), null);
  assert.equal(readmeImageSource("//evil.example/a.png", base), null);
  assert.equal(readmeImageSource("data:image/png;base64,AAAA", base)?.kind, "data");
  assert.equal(readmeImageSource("x.png", undefined), null);
  assert.equal(
    readmeLink("docs/usage.md", base),
    "https://open-vsx.org/api/a/b/1.0.0/file/docs/usage.md",
  );
  assert.equal(readmeLink("#install", base), null);
  assert.equal(readmeLink("javascript:alert(1)", base), null);
  assert.equal(formatCount(9771761), "9.8M");
  assert.equal(formatCount(12345), "12K");
  assert.equal(formatCount(2_000_000), "2M");
});

test("versions compare as semver: numbers, then a release after its pre-release", () => {
  assert.equal(isNewerVersion("1.10.0", "1.9.3"), true);
  assert.equal(isNewerVersion("1.9.3", "1.10.0"), false);
  assert.equal(isNewerVersion("2.0.0", "2.0.0"), false);
  assert.equal(isNewerVersion("2.0.0", "2.0.0-beta.2"), true);
  assert.equal(isNewerVersion("2.0.0-beta.10", "2.0.0-beta.9"), true);
  assert.equal(isNewerVersion("2.0.0-beta.1", "2.0.0"), false);
  assert.equal(isNewerVersion("latest", "1.0.0"), false);
});

test("D258: the versions Open VSX has, newest first", () => {
  assert.deepEqual(
    storeVersions(
      JSON.stringify({
        allVersions: { latest: "x", "1.10.0": "a", "1.2.0": "b", "2.0.0-beta": "c", "2.0.0": "d" },
      }),
    ),
    ["2.0.0", "2.0.0-beta", "1.10.0", "1.2.0"],
  );
  assert.deepEqual(storeVersions("not json"), []);
});

test("D267: a brand-new version waits; an older newer one is offered meanwhile", async () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  assert.equal(oldEnough("2026-11-03T06:00:00Z", now, 24), false);
  assert.equal(oldEnough("2026-11-01T06:00:00Z", now, 24), true);
  assert.equal(oldEnough(undefined, now, 24), true);
  assert.equal(oldEnough("2026-11-03T11:00:00Z", now, 0), true);
  const dates: Record<string, string> = {
    "1.3.0": "2026-11-03T10:00:00Z",
    "1.2.1": "2026-11-03T08:00:00Z",
    "1.2.0": "2026-10-20T00:00:00Z",
  };
  const asked: string[] = [];
  const releasedOf = async (v: string) => {
    asked.push(v);
    return { released: dates[v] };
  };
  const versions = ["1.3.0", "1.2.1", "1.2.0", "1.1.0"];
  const latest = { version: "1.3.0", released: dates["1.3.0"] };
  assert.equal(await offeredUpdate("1.1.0", latest, versions, releasedOf, now, 24), "1.2.0");
  assert.deepEqual(asked, ["1.2.1", "1.2.0"]);
  // Nothing old enough above the installed one: no update yet.
  assert.equal(await offeredUpdate("1.2.0", latest, versions, releasedOf, now, 24), null);
  // No delay: the latest.
  assert.equal(await offeredUpdate("1.1.0", latest, versions, releasedOf, now, 0), "1.3.0");
  assert.equal(await offeredUpdate("1.3.0", latest, versions, releasedOf, now, 24), null);
});

test("an update made for a newer VS Code isn't offered; an older one that fits is", async () => {
  const engines: Record<string, string> = { "3.30.0": "^1.107.0", "3.29.0": "^1.107.0" };
  const detailsOf = async (v: string) => ({ engine: engines[v] ?? "^1.100.0" });
  const fits = (engine: string | undefined) => engine !== "^1.107.0";
  const latest = { version: "3.30.0", engine: engines["3.30.0"] };
  const versions = ["3.30.0", "3.29.0", "3.27.0", "3.26.0"];
  assert.equal(await offeredUpdate("3.26.0", latest, versions, detailsOf, 0, 0, fits), "3.27.0");
  assert.equal(await offeredUpdate("3.27.0", latest, versions, detailsOf, 0, 0, fits), null);
});

test("an update that can't be read, or is a pre-release, isn't offered", async () => {
  const latest = { version: "2.0.0", engine: "^9.0.0" };
  const fits = (engine: string | undefined) => engine !== "^9.0.0";
  // The next one down fails to load: skipped, the one after is offered.
  const flaky = async (v: string) => {
    if (v === "1.9.0") throw new Error("offline");
    return { engine: "^1.0.0" };
  };
  const versions = ["2.0.0", "2.0.0-rc.1", "1.9.0", "1.8.0"];
  assert.equal(await offeredUpdate("1.0.0", latest, versions, flaky, 0, 0, fits), "1.8.0");
  // Nothing readable: no update, rather than an unchecked one.
  const none = async () => undefined;
  assert.equal(await offeredUpdate("1.0.0", latest, versions, none, 0, 0, fits), null);
});
