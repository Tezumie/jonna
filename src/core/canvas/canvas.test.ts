// The bundled canvas extension's model (D181): src-tauri/bundled-extensions/canvas/main.js is a
// plain worker script, so it's loaded here as the worker would, and its `model` export tested.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

interface Node {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  label?: string;
  color?: string;
  file?: string;
}
interface Edge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
}
interface Doc {
  nodes: Node[];
  edges: Edge[];
  extra: Record<string, unknown>;
}
interface Model {
  parseCanvas(text: string): Doc;
  serializeCanvas(doc: Doc): string;
  applyOps(
    doc: Doc,
    ops: unknown[],
  ): { doc: Doc; added: Record<string, string>; changed: string[]; removed: string[] };
  describe(
    doc: Doc,
    selection?: string[],
  ): { nodes: Node[]; edges: unknown[]; selection: string[] };
}

const source = readFileSync(
  join(process.cwd(), "src-tauri/bundled-extensions/canvas/main.js"),
  "utf8",
);
const exportsObject: { model?: Model } = {};
new Function("exports", source)(exportsObject);
const model = exportsObject.model as Model;
const empty = (): Doc => model.parseCanvas("");

test("canvas: parses JSON Canvas, keeps unknown fields, drops broken edges", () => {
  const doc = model.parseCanvas(
    JSON.stringify({
      nodes: [
        { id: "a", type: "text", text: "A", x: 1.4, y: 2, width: 100, height: 50, mine: 1 },
        { id: "b", type: "file", file: "src/a.ts", x: 0, y: 0, width: 100, height: 50 },
        { id: "a", type: "text", text: "duplicate", x: 0, y: 0, width: 1, height: 1 },
      ],
      edges: [
        { id: "e1", fromNode: "a", toNode: "b" },
        { id: "e2", fromNode: "a", toNode: "missing" },
      ],
      other: true,
    }),
  );
  assert.equal(doc.nodes.length, 2);
  assert.equal(doc.nodes[0]?.x, 1);
  assert.equal((doc.nodes[0] as unknown as { mine: number }).mine, 1);
  assert.deepEqual(
    doc.edges.map((e) => e.id),
    ["e1"],
  );
  assert.match(model.serializeCanvas(doc), /"other": true/);
  assert.throws(() => model.parseCanvas("{nope"), /valid canvas/);
});

test("canvas: one edit adds cards by ref, connects them and lays them out as a tree", () => {
  const r = model.applyOps(empty(), [
    { op: "add", ref: "ui", text: "## UI" },
    { op: "add", ref: "core", text: "## Core" },
    { op: "add", ref: "ipc", text: "IPC", color: "green" },
    { op: "connect", from: "ui", to: "core", label: "commands" },
    { op: "connect", from: "core", to: "ipc" },
    { op: "layout", style: "tree" },
  ]);
  const { ui, core, ipc } = r.added as Record<string, string>;
  const at = (id: string | undefined) => r.doc.nodes.find((n) => n.id === id) as Node;
  assert.ok(at(ui).x < at(core).x && at(core).x < at(ipc).x, "left to right along the arrows");
  assert.equal(at(ipc).color, "4");
  assert.equal(r.doc.edges.length, 2);
  assert.equal(r.doc.edges[0]?.label, "commands");
  // Cards don't overlap.
  const [a, b] = [at(ui), at(core)];
  assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y);
});

test("canvas: placement next to a card, updates, groups and removal", () => {
  let doc = model.applyOps(empty(), [
    { op: "add", ref: "a", text: "A", x: 0, y: 0, width: 200, height: 100 },
  ]).doc;
  const a = doc.nodes[0] as Node;
  let r = model.applyOps(doc, [{ op: "add", ref: "b", text: "B", near: a.id, side: "below" }]);
  doc = r.doc;
  const b = doc.nodes.find((n) => n.id === r.added.b) as Node;
  assert.ok(b.y >= a.y + a.height, "below");
  r = model.applyOps(doc, [
    { op: "update", id: a.id, text: "A\nwith\nmany\nmore\nlines\nnow" },
    { op: "connect", from: a.id, to: b.id },
    { op: "group", ids: [a.id, b.id], label: "Pair" },
  ]);
  doc = r.doc;
  assert.equal(doc.nodes[0]?.type, "group", "groups go first (lowest)");
  assert.ok((doc.nodes.find((n) => n.id === a.id) as Node).height > 100, "grew to fit");
  r = model.applyOps(doc, [{ op: "remove", ids: [a.id] }]);
  assert.equal(r.doc.edges.length, 0, "its arrows go with it");
  assert.ok(r.removed.includes(a.id));
});

test("canvas: a bad op fails the whole call and says which", () => {
  const doc = model.applyOps(empty(), [{ op: "add", text: "A" }]).doc;
  assert.throws(
    () =>
      model.applyOps(doc, [
        { op: "add", text: "B" },
        { op: "connect", from: "B", to: "nowhere" },
      ]),
    /ops\[1\] \(connect\): no card "B"/,
  );
  assert.throws(() => model.applyOps(doc, [{ op: "add", color: "pink" }]), /color/);
  assert.throws(() => model.applyOps(doc, [{ op: "fly" }]), /op must be/);
  assert.equal(doc.nodes.length, 1, "the document itself is untouched");
});

test("canvas: reading gives the agent every field it can act on", () => {
  const doc = model.applyOps(empty(), [
    { op: "add", ref: "f", file: "src/main.ts" },
    { op: "add", ref: "l", url: "https://example.com" },
  ]).doc;
  const out = model.describe(doc, ["x"]);
  assert.deepEqual(
    out.nodes.map((n) => n.type),
    ["file", "link"],
  );
  assert.equal(out.nodes[0]?.file, "src/main.ts");
  assert.deepEqual(out.selection, ["x"]);
});

const mdSource = readFileSync(
  join(process.cwd(), "src-tauri/bundled-extensions/canvas/markdown.js"),
  "utf8",
);
const mdScope: {
  canvasMarkdown?: { render(s: string): string; toggleTask(s: string, line: number): string };
} = {};
new Function("self", mdSource)(mdScope);
const md = mdScope.canvasMarkdown as NonNullable<typeof mdScope.canvasMarkdown>;

test("canvas markdown: nothing in a card's text becomes markup it didn't ask for", () => {
  const attacks = [
    '<img src=x onerror="alert(1)">',
    '[x](https://a.example/"onmouseover="alert(1))',
    "[x](https://a.example/(https://b.example/ onmouseover=alert(1) x=)",
    'https://a.example/" onmouseover="alert(1)',
    '[[a" onmouseover="alert(1)]] **<b>bold</b>** _<i>it</i>_ `<script>`',
    "[**x**](https://a.example/_y_) https://a.example/**z**",
  ];
  for (const text of attacks) {
    const html = md.render(text);
    // Every tag is one the renderer makes, and no attribute holds a quote or an event handler.
    for (const tag of html.match(/<[^>]*>/g) ?? []) {
      assert.match(tag, /^<\/?(p|br|a|span|strong|em|del|code)\b/, `${text} → ${tag}`);
      assert.doesNotMatch(tag, /\son\w+=/i, `${text} → ${tag}`);
    }
  }
  assert.match(md.render("[docs](https://x.example)"), /data-url="https:\/\/x.example"/);
});

test("canvas markdown: tasks tick on their own line, in quotes too", () => {
  const text = "intro\n> - [ ] quoted\n- [ ] plain";
  const lines = [...md.render(text).matchAll(/data-line="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(lines, [1, 2]);
  assert.equal(md.toggleTask(text, 1), "intro\n> - [x] quoted\n- [ ] plain");
  assert.equal(md.toggleTask(text, 2), "intro\n> - [ ] quoted\n- [x] plain");
});

const geoSource = readFileSync(
  join(process.cwd(), "src-tauri/bundled-extensions/canvas/geometry.js"),
  "utf8",
);
interface Rect {
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
const geoScope: {
  canvasGeometry?: {
    snapToObjects(
      r: Rect,
      others: Rect[],
      t: number,
    ): { dx: number; dy: number; guides: unknown[] };
    align(n: Rect[], how: string): void;
    distribute(n: Rect[], axis: string): void;
    justify(n: Rect[], d: "width" | "height"): void;
    arrange(n: Rect[], style: string, gap: number): void;
    resize(
      s: Rect,
      dir: string,
      dx: number,
      dy: number,
      keep: boolean,
      min: { width: number; height: number },
    ): Rect;
  };
} = {};
new Function("self", geoSource)(geoScope);
const geo = geoScope.canvasGeometry as NonNullable<typeof geoScope.canvasGeometry>;
const box = (x: number, y: number, width = 100, height = 50): Rect => ({ x, y, width, height });

test("canvas geometry: snapping to another card's edges and centre, with a guide (D184)", () => {
  const other = box(0, 0);
  const near = geo.snapToObjects(box(6, 200), [other], 8);
  assert.equal(near.dx, -6, "left edges line up");
  assert.equal(near.guides.length, 1);
  const centred = geo.snapToObjects(box(103, 200, 94), [other], 8);
  assert.equal(centred.dx, -3, "right edge to right edge (the closest)");
  assert.equal(geo.snapToObjects(box(30, 200), [other], 8).dx, 0, "too far: no snap");
});

test("canvas geometry: align, distribute, justify, arrange, resize", () => {
  const a = box(0, 0);
  const b = box(50, 100, 200);
  const c = box(400, 30);
  geo.align([a, b, c], "right");
  assert.deepEqual(
    [a, b, c].map((n) => n.x + n.width),
    [500, 500, 500],
  );
  const row = [box(0, 0), box(150, 0), box(500, 0)];
  geo.distribute(row, "x");
  assert.deepEqual(
    row.map((n) => n.x),
    [0, 250, 500],
  );
  geo.justify(row, "height");
  const grid = [box(0, 0), box(0, 0), box(0, 0), box(0, 0)];
  geo.arrange(grid, "grid", 20);
  assert.deepEqual(
    grid.map((n) => [n.x, n.y]),
    [
      [0, 0],
      [120, 0],
      [0, 70],
      [120, 70],
    ],
  );
  const fromLeft = geo.resize(box(100, 100, 200, 100), "w", 50, 0, false, {
    width: 40,
    height: 40,
  });
  assert.deepEqual(fromLeft, { x: 150, y: 100, width: 150, height: 100 }, "right edge stays");
  const ratio = geo.resize(box(0, 0, 200, 100), "se", 100, 0, true, { width: 40, height: 40 });
  assert.equal(ratio.height, 150, "Shift keeps the ratio");
});
