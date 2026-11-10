// D251: launch configurations and compounds of a multi-root workspace.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findCompound,
  findConfig,
  ownLaunchEntries,
  parseCompounds,
  resolveCompound,
} from "./compounds";
import { type LaunchConfig, parseLaunchJson } from "./launch";

const FOLDERS = [
  { name: "api", path: "/w/api" },
  { name: "web", path: "/w/web" },
];
const vars = (folder: string) => ({
  workspaceFolder: folder,
  folders: FOLDERS,
  pathSeparator: "/",
});

/** One folder's launch.json, read as configurations.ts reads it. */
function load(json: unknown, folder: string, name: string | undefined, multi: boolean) {
  const v = vars(folder);
  return ownLaunchEntries(
    parseLaunchJson(json, "launch.json", v),
    parseCompounds(json, "launch.json", v),
    folder,
    name,
    multi,
  );
}

const API = {
  configurations: [
    { name: "Server", type: "node", request: "launch", program: "${workspaceFolder}/s.js" },
    { name: "Shared", type: "node", request: "launch", cwd: "${workspaceFolder:web}" },
  ],
  compounds: [{ name: "Both", configurations: ["Server", { name: "Client", folder: "web" }] }],
};
const WEB = {
  configurations: [
    { name: "Client", type: "chrome", request: "launch", webRoot: "${workspaceFolder}" },
    { name: "Shared", type: "node", request: "launch" },
  ],
};

test("each folder's configurations: its ${workspaceFolder}, named with the folder", () => {
  const api = load(API, "/w/api", "api", true);
  const web = load(WEB, "/w/web", "web", true);
  const list: LaunchConfig[] = [...api.configs, ...web.configs];
  assert.deepEqual(
    list.map((c) => [c.name, c.plainName, c.folderName, c.workspaceFolder]),
    [
      ["Server (api)", "Server", "api", "/w/api"],
      ["Shared (api)", "Shared", "api", "/w/api"],
      ["Client (web)", "Client", "web", "/w/web"],
      ["Shared (web)", "Shared", "web", "/w/web"],
    ],
  );
  assert.equal(list[0]?.program, "/w/api/s.js");
  assert.equal(list[1]?.cwd, "/w/web");
  assert.equal(list[2]?.raw.webRoot, "/w/web");
  // By full name, by its own when it's clear, nearest folder first; ambiguity refused.
  assert.equal(findConfig(list, "Client")?.name, "Client (web)");
  assert.equal(findConfig(list, "Shared (web)")?.name, "Shared (web)");
  assert.equal(findConfig(list, "Shared", "/w/web")?.name, "Shared (web)");
  assert.throws(() => findConfig(list, "Shared"), /Several folders/);
  // The workspace file's: "(workspace)", in the active file's folder.
  const own = load(
    { configurations: [{ name: "All", type: "node", request: "launch" }] },
    "/w/web",
    undefined,
    true,
  );
  assert.deepEqual(
    own.configs.map((c) => [c.name, c.folderName, c.workspaceFolder]),
    [["All (workspace)", undefined, "/w/web"]],
  );
});

test("compounds name configurations across folders: a folder object, 'Name (folder)', or their own", () => {
  const api = load(API, "/w/api", "api", true);
  const web = load(WEB, "/w/web", "web", true);
  const list = [...api.configs, ...web.configs];
  const both = findCompound(api.compounds, "Both");
  assert.ok(both);
  assert.equal(both.name, "Both (api)");
  assert.deepEqual(
    resolveCompound(both, list).map((c) => c.name),
    ["Server (api)", "Client (web)"],
  );
  // From the workspace file: "Name (folder)" strings and { name, folder } objects.
  const [mixed] = parseCompounds(
    {
      compounds: [
        { name: "Mixed", configurations: ["Shared (web)", { name: "Shared", folder: "api" }] },
      ],
    },
    "x.code-workspace",
  );
  assert.ok(mixed);
  assert.deepEqual(
    resolveCompound(mixed, list).map((c) => c.name),
    ["Shared (web)", "Shared (api)"],
  );
  // A plain name several folders have: the compound's own folder's.
  const [near] = parseCompounds({ compounds: [{ name: "N", configurations: ["Shared"] }] }, "l");
  assert.ok(near);
  assert.deepEqual(
    resolveCompound({ ...near, workspaceFolder: "/w/web" }, list).map((c) => c.name),
    ["Shared (web)"],
  );
  const [missing] = parseCompounds(
    { compounds: [{ name: "M", configurations: [{ name: "Client", folder: "api" }] }] },
    "l",
  );
  assert.ok(missing);
  assert.throws(() => resolveCompound(missing, list), /"Client \(api\)"/);
});

test("one folder: names as written, a compound's folder field ignored (as before)", () => {
  const single = load(API, "/w/api", "api", false);
  assert.deepEqual(
    single.configs.map((c) => [c.name, c.plainName, c.folderName]),
    [
      ["Server", undefined, undefined],
      ["Shared", undefined, undefined],
    ],
  );
  const list = [...single.configs, ...parseLaunchJson(WEB, "launch.json", vars("/w/api"))].filter(
    (c, i, all) => all.findIndex((x) => x.name === c.name) === i,
  );
  const [both] = single.compounds;
  assert.ok(both);
  assert.equal(both.name, "Both");
  assert.deepEqual(
    resolveCompound(both, list).map((c) => c.name),
    ["Server", "Client"],
  );
  // A missing entry is named as written, its folder left out (no folder names with one folder).
  const [missing] = parseCompounds(
    { compounds: [{ name: "M", configurations: [{ name: "Nope", folder: "api" }] }] },
    "l",
  );
  assert.ok(missing);
  assert.throws(
    () => resolveCompound(missing, list),
    (err: Error) => err.message.includes('"Nope"') && !err.message.includes("(api)"),
  );
});
