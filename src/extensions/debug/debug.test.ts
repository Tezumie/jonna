import assert from "node:assert/strict";
import { test } from "node:test";
import { BreakpointStore, parseHitCondition } from "./breakpoints";
import {
  cdpCondition,
  describe,
  inspectorPort,
  inspectorUrl,
  logMessageExpression,
  pathToUrl,
  scriptUrlRegex,
  urlToPath,
} from "./cdp";
import { adapterFor, configForFile, dapLaunchArguments, parseLaunchJson } from "./launch";
import { dataUrlText, decodeVlq, SourceMap } from "./sourcemap";

const v = { workspaceFolder: "/w/app", file: "/w/app/src/main.ts", pathSeparator: "/" };
const tools = { python: "python3", lldbDap: "lldb-dap", gdb: "gdb" };

test("breakpoints: toggle, conditions, moves, save and restore", () => {
  const s = new BreakpointStore();
  assert.ok(s.toggle("/w/a.js", 3));
  s.add("/w/a.js", 7, "i > 2");
  s.add("/w/b.js", 1);
  assert.equal(s.forPath("/w/a.js").length, 2);
  assert.equal(s.toggle("/w/a.js", 3), null);
  assert.deepEqual(
    s.forPath("/w/a.js").map((b) => [b.line, b.condition]),
    [[7, "i > 2"]],
  );
  // Adding where one is updates it (no duplicate).
  s.add("/w/a.js", 7);
  assert.equal(s.forPath("/w/a.js").length, 1);
  assert.equal(s.forPath("/w/a.js")[0]?.condition, undefined);

  // Edits move them; two landing on one line become one.
  s.add("/w/a.js", 9);
  s.moveLines("/w/a.js", [10, 12]);
  assert.deepEqual(
    s.forPath("/w/a.js").map((b) => b.line),
    [10, 12],
  );
  s.moveLines("/w/a.js", [10, 10]);
  assert.deepEqual(
    s.forPath("/w/a.js").map((b) => b.line),
    [10],
  );

  // Glyphs: hollow only while a session runs and couldn't place it.
  const [bp] = s.forPath("/w/a.js");
  s.update(bp?.id ?? 0, { verified: false });
  assert.equal(s.glyphs(true).get("/w/a.js")?.[0]?.state, "unverified");
  assert.equal(s.glyphs(false).get("/w/a.js")?.[0]?.state, "verified");
  s.clearVerification();
  assert.equal(s.forPath("/w/a.js")[0]?.verified, undefined);

  s.update(bp?.id ?? 0, { enabled: false });
  s.uncaught.value = true;
  const saved = s.save();
  const t = new BreakpointStore();
  t.restore(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(t.save(), saved);
  assert.equal(t.glyphs(false).get("/w/a.js")?.[0]?.state, "disabled");
  t.restore({ breakpoints: [{ path: 5 }, { path: "/x", line: 0 }, { path: "/x", line: 2 }] });
  assert.equal(t.list.peek().length, 1);
  assert.equal(t.uncaught.peek(), false);
});

test("launch.json: variables, defaults and debuggers", () => {
  const configs = parseLaunchJson(
    {
      configurations: [
        {
          name: "App",
          type: "node",
          request: "launch",
          program: "${workspaceFolder}/index.js",
          args: ["--port", "3000"],
          env: { DEBUG: "1", BAD: 2 },
          preLaunchTask: "build",
        },
        {
          name: "Py",
          type: "debugpy",
          request: "launch",
          program: "${file}",
          python: "/venv/bin/python",
        },
        {
          name: "Native",
          type: "lldb-dap",
          request: "launch",
          program: "${workspaceFolder}/a.out",
        },
        { name: "Custom", type: "mydbg", debugAdapter: { command: "mydbg-dap", args: ["--dap"] } },
        { name: "Unknown", type: "cobol" },
        { type: "node" },
      ],
    },
    ".vscode/launch.json",
    v,
  );
  assert.deepEqual(
    configs.map((c) => c.name),
    ["App", "Py", "Native", "Custom", "Unknown"],
  );
  const [app, py, native, custom, unknown] = configs;
  assert.equal(app?.program, "/w/app/index.js");
  assert.deepEqual(app?.env, { DEBUG: "1" });
  assert.equal(app?.preLaunchTask, "build");
  assert.deepEqual(adapterFor(app as never, tools), { kind: "cdp" });
  const pyAdapter = adapterFor(py as never, tools);
  assert.equal(pyAdapter.kind === "dap" && pyAdapter.command, "/venv/bin/python");
  assert.deepEqual(pyAdapter.kind === "dap" && pyAdapter.args, ["-m", "debugpy.adapter"]);
  assert.equal(adapterFor(native as never, tools).kind, "dap");
  const c = adapterFor(custom as never, tools);
  assert.equal(c.kind === "dap" && c.command, "mydbg-dap");
  assert.throws(() => adapterFor(unknown as never, tools), /debugAdapter/);
  const args = dapLaunchArguments(py as never);
  assert.equal(args.program, "/w/app/src/main.ts");
  assert.equal(args.console, "integratedTerminal");

  assert.equal(configForFile("/w/app/x.py", v)?.type, "debugpy");
  assert.equal(configForFile("/w/app/x.mjs", v)?.type, "node");
  assert.equal(configForFile("/w/app/x.ts", v)?.cwd, "/w/app");
  assert.equal(configForFile("/w/app/readme.md", v), null);
});

test("node inspector helpers", () => {
  assert.equal(
    inspectorUrl("\u001b[0mDebugger listening on ws://127.0.0.1:40123/0f1e-aa\r\nFor help…"),
    "ws://127.0.0.1:40123/0f1e-aa",
  );
  assert.equal(inspectorUrl("hello"), null);
  // Cut inside the address (output as it's written): not yet.
  assert.equal(inspectorUrl("Debugger listening on ws://127.0.0.1:40123/0f"), null);
  // D253: wrapped by a narrow terminal inside the address, then the help line right after.
  const uuid = "967a3a47-66fc-44db-a861-1634a6439b5a";
  assert.equal(
    inspectorUrl(`Debugger listening on ws://127.0.0.1:62096/${uuid.slice(0, 20)}
${uuid.slice(20)}
For help, see: x`),
    `ws://127.0.0.1:62096/${uuid}`,
  );
  assert.equal(
    inspectorUrl(`Debugger listening on ws://127.0.0.1:62096/${uuid.slice(0, 20)}`),
    null,
  );
  assert.equal(inspectorPort("Debugger listening on ws://127.0.0.1:62096/96[2;1Hgarbled"), 62096);
  assert.equal(inspectorPort("Debugger listening on ws://127.0.0.1:"), null);
  assert.equal(pathToUrl("/w/my app/a.js", false), "file:///w/my%20app/a.js");
  assert.equal(pathToUrl("C:\\w\\a b\\x.js", true), "file:///C:/w/a%20b/x.js");
  assert.equal(urlToPath("file:///C:/w/a%20b/x.js", true), "C:\\w\\a b\\x.js");
  assert.equal(urlToPath("file:///w/my%20app/a.js", false), "/w/my app/a.js");
  assert.equal(urlToPath("node:internal/main", false), null);
  // UNC paths (a network share, \\wsl.localhost): the server is the URL's host, as Node writes it.
  assert.equal(pathToUrl("\\\\srv\\share\\a b.js", true), "file://srv/share/a%20b.js");
  assert.equal(urlToPath("file://srv/share/a%20b.js", true), "\\\\srv\\share\\a b.js");
  assert.ok(
    new RegExp(scriptUrlRegex("\\\\srv\\share\\a.js", true, true)).test("file://srv/share/a.js"),
  );
  // A stray "%" isn't thrown on.
  assert.equal(urlToPath("file:///C:/w/100%.js", true), "C:\\w\\100%.js");
  const re = new RegExp(scriptUrlRegex("/w/a.js", false, false));
  assert.ok(re.test("file:///w/a.js"));
  assert.ok(re.test("/w/a.js"));
  assert.ok(!re.test("file:///w/a.jsx"));
  const ci = new RegExp(scriptUrlRegex("C:\\W\\A.js", true, true));
  assert.ok(ci.test("file:///c:/w/a.js"));
  assert.equal(describe({ type: "string", value: "hi" }), '"hi"');
  assert.equal(describe({ type: "object", subtype: "null" }), "null");
  assert.equal(describe({ type: "number", unserializableValue: "NaN" }), "NaN");
  assert.equal(describe({ type: "object", description: "Array(3)" }), "Array(3)");
});

test("hit counts, logpoints and conditions compile to inspector conditions", () => {
  assert.deepEqual(parseHitCondition("5"), { op: ">=", n: 5 });
  assert.deepEqual(parseHitCondition(" > 2"), { op: ">", n: 2 });
  assert.deepEqual(parseHitCondition("=3"), { op: "==", n: 3 });
  assert.deepEqual(parseHitCondition("%2"), { op: "%", n: 2 });
  assert.equal(parseHitCondition("%0"), null);
  assert.equal(parseHitCondition("abc"), null);
  assert.equal(cdpCondition({ line: 1 }, "k"), null);

  // Run a condition the way the inspector would: in the frame's scope, each hit.
  const g = globalThis as { __ideHits?: unknown; __ideLogpoint?: unknown };
  const hits = (bp: Parameters<typeof cdpCondition>[0], scopes: Record<string, unknown>[]) => {
    g.__ideHits = undefined;
    const cond = cdpCondition(bp, `key-${Math.random()}`) ?? "true";
    return scopes.map((vars) =>
      Boolean(new Function(...Object.keys(vars), `return (${cond});`)(...Object.values(vars))),
    );
  };
  assert.deepEqual(hits({ line: 1, hitCondition: "3" }, [{}, {}, {}, {}]), [
    false,
    false,
    true,
    true,
  ]);
  assert.deepEqual(hits({ line: 1, hitCondition: "==2" }, [{}, {}, {}]), [false, true, false]);
  assert.deepEqual(hits({ line: 1, hitCondition: "%2" }, [{}, {}, {}, {}]), [
    false,
    true,
    false,
    true,
  ]);
  // The count only moves when the condition holds.
  assert.deepEqual(
    hits({ line: 1, condition: "i > 0", hitCondition: "2" }, [{ i: 0 }, { i: 1 }, { i: 2 }]),
    [false, false, true],
  );
  // A logpoint never stops and reports through the binding, `{expr}` filled in.
  const logged: string[] = [];
  g.__ideLogpoint = (m: string) => logged.push(m);
  assert.deepEqual(
    hits({ line: 1, logMessage: "i={i} o={o} bad={nope.x} `tick` $5 \\n" }, [
      { i: 1, o: { a: [1] } },
    ]),
    [false],
  );
  g.__ideLogpoint = undefined;
  assert.equal(logged[0], 'i=1 o={"a":[1]} bad=<nope is not defined> `tick` $5 \\n');
  assert.ok(logMessageExpression("plain").startsWith("`"));
});

test("source maps: both directions, relative sources, inline maps", () => {
  assert.deepEqual(decodeVlq("AAgBC"), [0, 0, 16, 1]);
  assert.deepEqual(decodeVlq("2HwrB"), [123, 696]);
  // esbuild's map of src/app.ts → dist/app.js (the interface and blank lines are gone).
  const map = new SourceMap(
    {
      version: 3,
      sources: ["../src/app.ts"],
      mappings:
        "AAEA,SAAS,KAAK,GAAc;AAC1B,QAAM,QAAQ,EAAE,IAAI;AACpB,SAAO;AACT;AAEA,QAAQ,IAAI,KAAK,EAAE,GAAG,EAAE,CAAC,CAAC;",
    },
    "file:///w/dist/app.js.map",
    (url) => urlToPath(url, false),
  );
  assert.deepEqual(map.sources, ["/w/src/app.ts"]);
  assert.ok(map.hasSource("/w/src/app.ts"));
  // Generated line 1 (`const twice…`) is source line 3; the call is line 7.
  assert.deepEqual(map.original(1, 8), { path: "/w/src/app.ts", line: 3, col: 8 });
  assert.equal(map.original(4, 0)?.line, 7);
  assert.deepEqual(map.generated("/w/src/app.ts", 3), { line: 1, col: 0, sourceLine: 3 });
  // A blank source line moves to the next mapped one.
  assert.equal(map.generated("/w/src/app.ts", 6)?.sourceLine, 7);
  assert.equal(map.generated("/w/other.ts", 1), null);
  // Case-insensitive paths when asked; sourceRoot; non-file sources.
  const win = new SourceMap(
    {
      version: 3,
      sourceRoot: "file:///C:/W/src",
      sources: ["A.ts", "webpack://x/y.js"],
      mappings: "AAAA",
    },
    "file:///C:/w/dist/a.js",
    (url) => urlToPath(url, true),
    (p) => p.toLowerCase(),
  );
  assert.deepEqual(win.sources, ["C:\\W\\src\\A.ts", null]);
  assert.ok(win.hasSource("c:\\w\\SRC\\a.ts"));
  assert.equal(dataUrlText(`data:application/json;base64,${btoa('{"a":1}')}`), '{"a":1}');
  assert.equal(dataUrlText("data:application/json,%7B%7D"), "{}");
});
