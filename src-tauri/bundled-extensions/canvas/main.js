// Canvas — a bundled extension (D181; runs in a sandboxed worker, API: docs/extensions.md).
// A canvas is a .canvas file in the JSON Canvas 1.0 format (jsoncanvas.org, the format Obsidian
// uses): cards ("nodes": text in Markdown, a file, a link, a group) and arrows ("edges"). The
// viewer page (viewer.js) is where the user draws; the commands here are how the agent (and
// scripts) read and change a canvas: one `canvas.edit` call with a list of operations, so a whole
// diagram is one step and one permission. Edits go to the file; an open viewer picks the change up
// from the file (it merges its own unsaved moves) and lights up what changed.

const GRID = 20;
const GAP = 80;
const NAMED_COLORS = { red: "1", orange: "2", yellow: "3", green: "4", cyan: "5", purple: "6" };
const SIDES = ["top", "right", "bottom", "left"];
const TYPES = ["text", "file", "link", "group"];
const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
function imageType(file) {
  const ext = file.toLowerCase().split(".").pop();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml" }[ext] ?? `image/${ext}`;
}

// ---- The model (no `ide` here: unit-tested in src/core/canvas/canvas.test.ts) ----------------

const snap = (v) => Math.round(v / GRID) * GRID;
const num = (v, fallback) =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;

function newId(taken) {
  for (;;) {
    let id = "";
    for (let i = 0; i < 16; i++) id += Math.floor(Math.random() * 16).toString(16);
    if (!taken.has(id)) return id;
  }
}

/** A canvas file's text as { nodes, edges, extra }; empty text is an empty canvas. */
function parseCanvas(text) {
  if (!text?.trim()) return { nodes: [], edges: [], extra: {} };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`This isn't a valid canvas file (JSON Canvas): ${err.message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("This isn't a valid canvas file (JSON Canvas): expected an object.");
  const { nodes: rawNodes, edges: rawEdges, ...extra } = raw;
  const nodes = [];
  const ids = new Set();
  for (const n of Array.isArray(rawNodes) ? rawNodes : []) {
    if (!n || typeof n !== "object" || typeof n.id !== "string" || ids.has(n.id)) continue;
    // Unknown types and fields (another app's) are kept as they are.
    nodes.push({
      ...n,
      x: num(n.x, 0),
      y: num(n.y, 0),
      width: Math.max(GRID, num(n.width, 260)),
      height: Math.max(GRID, num(n.height, 60)),
    });
    ids.add(n.id);
  }
  const edges = [];
  const edgeIds = new Set();
  for (const e of Array.isArray(rawEdges) ? rawEdges : []) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || edgeIds.has(e.id)) continue;
    if (!ids.has(e.fromNode) || !ids.has(e.toNode)) continue;
    edges.push({ ...e });
    edgeIds.add(e.id);
  }
  return { nodes, edges, extra };
}

/** Tabs and the same top-level order Obsidian writes. */
function serializeCanvas(doc) {
  return JSON.stringify({ nodes: doc.nodes, edges: doc.edges, ...doc.extra }, null, "\t");
}

function normalizeColor(c) {
  if (c === undefined) return undefined;
  if (c === null || c === "") return null;
  const s = String(c).trim().toLowerCase();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  if (/^[1-6]$/.test(s)) return s;
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(s)) return s;
  throw new Error(`color "${c}": use 1–6 (red, orange, yellow, green, cyan, purple) or #rrggbb`);
}

/** A size that fits a card's content (Markdown text is measured roughly, at 13 px). */
function fitSize(node) {
  if (node.type === "file")
    return IMAGE.test(node.file ?? "") ? { width: 320, height: 240 } : { width: 400, height: 260 };
  if (node.type === "link") return { width: 340, height: 100 };
  if (node.type === "group") return { width: 400, height: 300 };
  const lines = String(node.text ?? "").split("\n");
  const longest = Math.max(...lines.map((l) => l.length), 8);
  const width = Math.min(440, Math.max(220, snap(longest * 7.4 + 40)));
  const perLine = Math.max(10, Math.floor((width - 40) / 7.4));
  let rows = 0;
  for (const l of lines) {
    const heading = /^#{1,3}\s/.test(l);
    const fence = /^```/.test(l);
    rows += fence ? 0.6 : Math.max(1, Math.ceil(l.length / perLine)) * (heading ? 1.5 : 1);
  }
  return { width, height: Math.min(640, Math.max(60, snap(rows * 21 + 34))) };
}

function rectOf(n) {
  return { x: n.x, y: n.y, width: n.width, height: n.height };
}

function bounds(nodes) {
  if (!nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function overlaps(a, b, margin = 20) {
  return (
    a.x < b.x + b.width + margin &&
    b.x < a.x + a.width + margin &&
    a.y < b.y + b.height + margin &&
    b.y < a.y + a.height + margin
  );
}

const solid = (doc) => doc.nodes.filter((n) => n.type !== "group");

/** Moves `rect` along one axis until it overlaps no card (groups don't count). */
function freeSpot(doc, rect, axis) {
  const r = { ...rect };
  for (let i = 0; i < 200 && solid(doc).some((n) => overlaps(r, n)); i++)
    if (axis === "x") r.x += GRID * 2;
    else r.y += GRID * 2;
  return { x: snap(r.x), y: snap(r.y) };
}

/** Which sides an arrow between two cards leaves and enters by (the closer pair). */
function autoSides(a, b) {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

/** Lays cards out: tree (left to right along the arrows), grid, row or column. */
function layout(doc, ids, style) {
  const nodes = (ids ? ids.map((id) => doc.nodes.find((n) => n.id === id)) : solid(doc)).filter(
    (n) => n && n.type !== "group",
  );
  if (!nodes.length) return [];
  const origin = bounds(nodes);
  const set = new Set(nodes.map((n) => n.id));
  if (style === "row" || style === "column") {
    let at = style === "row" ? origin.x : origin.y;
    for (const n of nodes) {
      if (style === "row") {
        n.x = snap(at);
        n.y = snap(origin.y);
        at += n.width + GAP / 2;
      } else {
        n.x = snap(origin.x);
        n.y = snap(at);
        at += n.height + GAP / 2;
      }
    }
  } else if (style === "grid") {
    const cols = Math.ceil(Math.sqrt(nodes.length));
    const cellW = Math.max(...nodes.map((n) => n.width)) + GAP / 2;
    const rows = [];
    nodes.forEach((n, i) => {
      const r = Math.floor(i / cols);
      rows[r] = Math.max(rows[r] ?? 0, n.height);
    });
    nodes.forEach((n, i) => {
      const r = Math.floor(i / cols);
      let y = origin.y;
      for (let k = 0; k < r; k++) y += rows[k] + GAP / 2;
      n.x = snap(origin.x + (i % cols) * cellW);
      n.y = snap(y);
    });
  } else {
    // tree: each card one column right of the furthest card pointing at it (cycles are cut by
    // capping the passes), then each column's cards stacked, ordered by their parents' rows.
    const edges = doc.edges.filter((e) => set.has(e.fromNode) && set.has(e.toNode));
    const level = new Map(nodes.map((n) => [n.id, 0]));
    for (let pass = 0; pass < nodes.length; pass++) {
      let moved = false;
      for (const e of edges) {
        const want = level.get(e.fromNode) + 1;
        if (want > level.get(e.toNode) && want < nodes.length) {
          level.set(e.toNode, want);
          moved = true;
        }
      }
      if (!moved) break;
    }
    const columns = [];
    for (const n of nodes) {
      const at = level.get(n.id);
      if (!columns[at]) columns[at] = [];
      columns[at].push(n);
    }
    const rowOf = new Map();
    let x = origin.x;
    const heights = columns.map((c) =>
      (c ?? []).reduce((h, n) => h + n.height + GAP / 2, -GAP / 2),
    );
    const tallest = Math.max(...heights);
    columns.forEach((column, i) => {
      if (!column) return;
      const parentRow = (n) => {
        const rows = edges
          .filter((e) => e.toNode === n.id && rowOf.has(e.fromNode))
          .map((e) => rowOf.get(e.fromNode));
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Infinity;
      };
      if (i > 0) column.sort((a, b) => parentRow(a) - parentRow(b));
      let y = origin.y + (tallest - heights[i]) / 2;
      column.forEach((n, row) => {
        n.x = snap(x);
        n.y = snap(y);
        rowOf.set(n.id, row);
        y += n.height + GAP / 2;
      });
      x += Math.max(...column.map((n) => n.width)) + GAP * 1.5;
    });
  }
  return nodes.map((n) => n.id);
}

/**
 * Applies `ops` to a copy of `doc`. All or nothing: a bad op throws, naming it. Returns the new
 * doc and what changed; `added` maps each add's ref (or its index in `ops`) to the new id.
 */
function applyOps(doc, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new Error("ops: give a list of operations.");
  const next = {
    nodes: doc.nodes.map((n) => ({ ...n })),
    edges: doc.edges.map((e) => ({ ...e })),
    extra: { ...doc.extra },
  };
  const added = {};
  const changed = new Set();
  const removed = new Set();
  const refs = new Map();
  const taken = () => new Set([...next.nodes.map((n) => n.id), ...next.edges.map((e) => e.id)]);
  const node = (key, what) => {
    const id = refs.get(key) ?? key;
    const found = next.nodes.find((n) => n.id === id);
    if (!found) throw new Error(`${what}: no card "${key}" (use an id from canvas.read or a ref)`);
    return found;
  };
  // Cards added without a place in this call go in a row under what's there, wrapping.
  let cursor = null;
  const place = (rect) => {
    if (!cursor) {
      const b = bounds(solid(next));
      cursor = b
        ? { startX: b.x, x: b.x, y: b.y + b.height + GAP, rowH: 0 }
        : { startX: 0, x: 0, y: 0, rowH: 0 };
    }
    if (cursor.x > cursor.startX && cursor.x + rect.width - cursor.startX > 1600) {
      cursor.x = cursor.startX;
      cursor.y += cursor.rowH + GAP / 2;
      cursor.rowH = 0;
    }
    const at = freeSpot(next, { ...rect, x: cursor.x, y: cursor.y }, "x");
    cursor.x = at.x + rect.width + GAP / 2;
    cursor.rowH = Math.max(cursor.rowH, rect.height);
    return at;
  };

  ops.forEach((op, index) => {
    const what = `ops[${index}] (${op?.op ?? "?"})`;
    if (!op || typeof op !== "object") throw new Error(`${what}: not an object`);
    switch (op.op) {
      case "add": {
        const type =
          op.type ?? (op.url ? "link" : op.file ? "file" : op.label && !op.text ? "group" : "text");
        if (!TYPES.includes(type)) throw new Error(`${what}: type must be ${TYPES.join(", ")}`);
        const n = { id: newId(taken()), type };
        if (type === "text") n.text = String(op.text ?? "");
        if (type === "file") {
          if (!op.file) throw new Error(`${what}: a file card needs file (a workspace path)`);
          n.file = String(op.file).replace(/\\/g, "/");
          if (op.subpath) n.subpath = String(op.subpath);
        }
        if (type === "link") {
          if (!/^https?:\/\//i.test(String(op.url ?? "")))
            throw new Error(`${what}: url must start with http(s)://`);
          n.url = String(op.url);
        }
        if (type === "group" && op.label) n.label = String(op.label);
        const color = normalizeColor(op.color);
        if (color) n.color = color;
        const fit = fitSize(n);
        n.width = Math.max(GRID * 2, num(op.width, fit.width));
        n.height = Math.max(GRID * 2, num(op.height, fit.height));
        if (typeof op.x === "number" && typeof op.y === "number") {
          n.x = Math.round(op.x);
          n.y = Math.round(op.y);
        } else if (op.near !== undefined) {
          const a = node(op.near, what);
          const side =
            SIDES.includes(op.side) || ["right", "below", "left", "above"].includes(op.side)
              ? op.side
              : "right";
          const at =
            side === "below" || side === "bottom"
              ? { x: a.x, y: a.y + a.height + GAP }
              : side === "above" || side === "top"
                ? { x: a.x, y: a.y - n.height - GAP }
                : side === "left"
                  ? { x: a.x - n.width - GAP, y: a.y }
                  : { x: a.x + a.width + GAP, y: a.y };
          const spot = freeSpot(
            next,
            { ...at, width: n.width, height: n.height },
            side === "below" || side === "above" || side === "bottom" || side === "top" ? "x" : "y",
          );
          n.x = spot.x;
          n.y = spot.y;
        } else {
          const spot = place({ width: n.width, height: n.height });
          n.x = spot.x;
          n.y = spot.y;
        }
        // Groups sit under everything (the first nodes are drawn lowest).
        if (type === "group") next.nodes.unshift(n);
        else next.nodes.push(n);
        const key = op.ref !== undefined ? String(op.ref) : String(index);
        if (op.ref !== undefined) refs.set(String(op.ref), n.id);
        added[key] = n.id;
        changed.add(n.id);
        break;
      }
      case "update": {
        const n = node(op.id, what);
        for (const f of ["text", "file", "url", "label", "subpath"])
          if (op[f] !== undefined) n[f] = String(op[f]);
        for (const f of ["x", "y", "width", "height"])
          if (typeof op[f] === "number")
            n[f] = Math.max(f === "width" || f === "height" ? GRID * 2 : -1e7, Math.round(op[f]));
        if (op.color !== undefined) {
          const c = normalizeColor(op.color);
          if (c) n.color = c;
          else delete n.color;
        }
        // New text that no longer fits grows the card (unless a height was given).
        if (op.text !== undefined && op.height === undefined && n.type === "text")
          n.height = Math.max(n.height, fitSize(n).height);
        changed.add(n.id);
        break;
      }
      case "remove": {
        const ids = Array.isArray(op.ids) ? op.ids : op.id !== undefined ? [op.id] : [];
        if (!ids.length) throw new Error(`${what}: give ids`);
        for (const key of ids) {
          const id = refs.get(key) ?? key;
          const edge = next.edges.findIndex((e) => e.id === id);
          if (edge >= 0) {
            next.edges.splice(edge, 1);
            removed.add(id);
            continue;
          }
          // Gone already (inside a group removed with its contents, or an arrow of a card).
          if (removed.has(id)) continue;
          const n = node(key, what);
          const inside =
            op.withContents && n.type === "group"
              ? next.nodes.filter(
                  (m) =>
                    m !== n &&
                    overlaps(rectOf(m), rectOf(n), -1) &&
                    m.x >= n.x &&
                    m.y >= n.y &&
                    m.x + m.width <= n.x + n.width &&
                    m.y + m.height <= n.y + n.height,
                )
              : [];
          for (const gone of [n, ...inside]) {
            next.nodes = next.nodes.filter((m) => m !== gone);
            next.edges = next.edges.filter((e) => {
              const keep = e.fromNode !== gone.id && e.toNode !== gone.id;
              if (!keep) removed.add(e.id);
              return keep;
            });
            removed.add(gone.id);
            changed.delete(gone.id);
          }
        }
        break;
      }
      case "connect": {
        const a = node(op.from, what);
        const b = node(op.to, what);
        const e = { id: newId(taken()), fromNode: a.id, toNode: b.id };
        if (SIDES.includes(op.fromSide)) e.fromSide = op.fromSide;
        if (SIDES.includes(op.toSide)) e.toSide = op.toSide;
        if (op.fromEnd === "arrow") e.fromEnd = "arrow";
        if (op.toEnd === "none") e.toEnd = "none";
        if (op.label) e.label = String(op.label);
        const color = normalizeColor(op.color);
        if (color) e.color = color;
        next.edges.push(e);
        if (op.ref !== undefined) refs.set(String(op.ref), e.id);
        added[op.ref !== undefined ? String(op.ref) : String(index)] = e.id;
        changed.add(e.id);
        break;
      }
      case "disconnect": {
        const ids = new Set((Array.isArray(op.ids) ? op.ids : []).map((k) => refs.get(k) ?? k));
        const from = op.from !== undefined ? node(op.from, what).id : null;
        const to = op.to !== undefined ? node(op.to, what).id : null;
        if (!ids.size && !from && !to) throw new Error(`${what}: give ids, or from / to`);
        next.edges = next.edges.filter((e) => {
          const hit =
            ids.has(e.id) ||
            ((from || to) && (!from || e.fromNode === from) && (!to || e.toNode === to));
          if (hit) removed.add(e.id);
          return !hit;
        });
        break;
      }
      case "group": {
        const members = (Array.isArray(op.ids) ? op.ids : []).map((k) => node(k, what));
        if (!members.length) throw new Error(`${what}: give the ids of the cards to group`);
        const b = bounds(members);
        const g = {
          id: newId(taken()),
          type: "group",
          x: snap(b.x - 40),
          y: snap(b.y - 60),
          width: snap(b.width + 80),
          height: snap(b.height + 100),
        };
        if (op.label) g.label = String(op.label);
        const color = normalizeColor(op.color);
        if (color) g.color = color;
        next.nodes.unshift(g);
        if (op.ref !== undefined) refs.set(String(op.ref), g.id);
        added[op.ref !== undefined ? String(op.ref) : String(index)] = g.id;
        changed.add(g.id);
        break;
      }
      case "layout": {
        const style = op.style ?? "tree";
        if (!["tree", "grid", "row", "column"].includes(style))
          throw new Error(`${what}: style must be tree, grid, row or column`);
        const ids = Array.isArray(op.ids) ? op.ids.map((k) => node(k, what).id) : null;
        for (const id of layout(next, ids, style)) changed.add(id);
        break;
      }
      case "clear":
        for (const n of next.nodes) removed.add(n.id);
        for (const e of next.edges) removed.add(e.id);
        next.nodes = [];
        next.edges = [];
        changed.clear();
        break;
      default:
        throw new Error(
          `${what}: op must be add, update, remove, connect, disconnect, group, layout or clear`,
        );
    }
  });
  return { doc: next, added, changed: [...changed], removed: [...removed] };
}

/** A canvas as the agent reads it: short, every field it can act on. */
function describe(doc, selection) {
  // Long texts are cut, and say so: an update replaces the whole text, so the agent mustn't
  // write a cut one back.
  const cut = (t) =>
    t.length > 20000 ? `${t.slice(0, 20000)}… [cut: ${t.length} characters in all]` : t;
  return {
    nodes: doc.nodes.map((n) => {
      const out = { id: n.id, type: n.type, x: n.x, y: n.y, width: n.width, height: n.height };
      if (n.color) out.color = n.color;
      if (typeof n.text === "string") out.text = cut(n.text);
      if (n.file) out.file = n.file;
      if (n.subpath) out.subpath = n.subpath;
      if (n.url) out.url = n.url;
      if (n.label) out.label = n.label;
      return out;
    }),
    edges: doc.edges.map((e) => {
      const out = { id: e.id, from: e.fromNode, to: e.toNode };
      if (e.label) out.label = e.label;
      if (e.color) out.color = e.color;
      if (e.toEnd === "none") out.toEnd = "none";
      if (e.fromEnd === "arrow") out.fromEnd = "arrow";
      return out;
    }),
    selection: selection ?? [],
  };
}

exports.model = { parseCanvas, serializeCanvas, applyOps, describe, fitSize, layout, autoSides };

// ---- The extension -------------------------------------------------------------------------

/** Viewers open per canvas (normalized path), and their selection. */
const open = new Map(); // key → { tabs, selection }
/** Cards to show when a canvas's viewer has loaded (it was opened by a command). */
const pendingFocus = new Map();
/** Canvases whose page has loaded its file (it said so). */
const ready = new Set();
/** An export to hand to a canvas's page once it has loaded. */
const pendingExports = new Map();
/** The canvas last opened or used (where the explorer's "Add to canvas" puts things). */
let lastActive = null;
/** Exports asked for by canvas.export, waiting for the page's picture: request id → resolve. */
const exportsPending = new Map();
/** Set by the Canvases view: a canvas was written (a new one shows in the list). */
let canvasWritten = (_path) => {};
let rootCache = null;

async function root() {
  rootCache = await ide.workspace.root();
  if (!rootCache) throw new Error("Open a folder first: canvases are files in the project.");
  return rootCache;
}

const isAbsolute = (p) => /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
const windows = (r) => /^[a-zA-Z]:/.test(r ?? "");

/** The workspace's folders (several in a multi-root workspace), kept current by the IDE. */
const folders = () => ide.workspace.workspaceFolders ?? [];

/**
 * A project path made absolute: relative to the first folder, or, with several folders, to the
 * folder its first part names ("api/src/x.ts", as the IDE writes them and quick open picks them).
 */
function absolute(path) {
  if (isAbsolute(path)) return path;
  const all = folders();
  if (all.length > 1) {
    const [head, ...rest] = path
      .replace(/\\/g, "/")
      .replace(/^\.?\/+/, "")
      .split("/");
    const named = all.find((f) => f.name === head);
    if (named) return rest.length ? `${named.path}/${rest.join("/")}` : named.path;
  }
  return `${rootCache ?? all[0]?.path ?? ""}/${path}`;
}

/** One key per file, whatever slashes or case (Windows) a path came with. */
function keyOf(path) {
  const r = rootCache ?? "";
  let p = absolute(path);
  p = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  // "." and ".." as the IDE resolves them (the page's path comes resolved).
  const out = [];
  for (const part of p.split("/")) {
    if (part === ".") continue;
    if (part === ".." && out.length > 1) out.pop();
    else out.push(part);
  }
  p = out.join("/");
  return windows(r) ? p.toLowerCase() : p;
}

/**
 * Relative to the project, with forward slashes (what's shown and stored in file cards): with
 * several folders, the folder's name first ("api/src/x.ts"), which the IDE's file calls read back.
 */
function relative(path) {
  if (folders().length > 1) {
    // A path in none of the folders comes back as it is.
    return isAbsolute(path) ? ide.workspace.asRelativePath(path).replace(/\\/g, "/") : path;
  }
  const r = (rootCache ?? "").replace(/\\/g, "/");
  const p = path.replace(/\\/g, "/");
  const same = windows(r)
    ? p.toLowerCase().startsWith(`${r.toLowerCase()}/`)
    : p.startsWith(`${r}/`);
  return same ? p.slice(r.length + 1) : p;
}

async function canvasFolder() {
  // canvas.folder: where new canvases go (and where the list looks first).
  const chosen = await ide.settings.get("canvas.folder").catch(() => "");
  if (typeof chosen === "string" && chosen.trim())
    return chosen.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const ws = await ide.state.get("ide://workspace").catch(() => null);
  // The IDE's own folder name comes from the workspace state (never written here: AGENTS.md rule 1).
  return ws?.workspaceFolder ? `${ws.workspaceFolder}/canvas` : "canvas";
}

/**
 * Every canvas folder to look in: canvas.folder (or the IDE's workspace folder's), then the other
 * workspace folders the project has (.vscode, .codevre: read, never created).
 */
async function canvasFolders() {
  const first = await canvasFolder();
  const ws = await ide.state.get("ide://workspace").catch(() => null);
  const others = (ws?.existingWorkspaceFolders || []).map((f) => `${f}/canvas`);
  return [first, ...others.filter((f) => f !== first)];
}

async function resolvePath(input) {
  await root();
  let p = typeof input?.path === "string" && input.path.trim() ? input.path.trim() : "";
  if (!p) {
    // The main canvas: the first folder that has one, else a new one in the first folder.
    const folders = await canvasFolders();
    p = `${folders[0]}/main.canvas`;
    for (const f of folders)
      if (await exists(`${f}/main.canvas`)) {
        p = `${f}/main.canvas`;
        break;
      }
  }
  return p.endsWith(".canvas") ? p : `${p}.canvas`;
}

async function exists(path) {
  try {
    await ide.workspace.fs.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function load(path) {
  if (!(await exists(path))) return { nodes: [], edges: [], extra: {} };
  return parseCanvas(await ide.workspace.fs.read(path));
}

async function show(path, ids, flash) {
  const key = keyOf(path);
  if (open.get(key)?.tabs > 0) {
    await ide.ui.webview("canvas.viewer").postMessage({ type: "focus", key, ids, flash });
    return;
  }
  pendingFocus.set(key, { ids, flash });
  await ide.commands.execute("viewer.open", {
    path,
    viewer: "canvas.viewer",
    preview: false,
    toSide: true,
    preserveFocus: true,
  });
}

/** A Markdown file narrowed to a heading ("#Setup"): that heading and what's under it. */
function section(text, subpath) {
  if (typeof subpath !== "string" || !subpath.startsWith("#") || subpath.startsWith("#^"))
    return text;
  const want = subpath.slice(1).trim().toLowerCase();
  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) =>
      /^#{1,6}\s/.test(l) &&
      l
        .replace(/^#+\s*/, "")
        .trim()
        .toLowerCase() === want,
  );
  if (start < 0) return text;
  const level = /^(#+)/.exec(lines[start])[1].length;
  let end = start + 1;
  while (end < lines.length && !new RegExp(`^#{1,${level}}\\s`).test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

async function settings() {
  const width = await ide.settings.get("canvas.cardWidth");
  return {
    snap: (await ide.settings.get("canvas.snapToGrid")) !== false,
    grid: (await ide.settings.get("canvas.showGrid")) !== false,
    arrows: (await ide.settings.get("canvas.arrowStyle")) ?? "curved",
    cardWidth: typeof width === "number" && width >= 120 && width <= 1200 ? width : 260,
    imagePreview: (await ide.settings.get("canvas.showImages")) !== false,
    snapObjects: (await ide.settings.get("canvas.snapToObjects")) !== false,
    embedPages: (await ide.settings.get("canvas.embedPages")) !== false,
  };
}

/**
 * A name not taken yet: `make(1)` ("name"), then `make(2)` ("name 2")… Throws rather than
 * overwrite when they're all taken.
 */
async function freeName(make) {
  for (let i = 1; i < 1000; i++) {
    const candidate = make(i);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error("Every name like that is taken: pick another.");
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Whether a canvas has a file card for `file` (the page's save may still be on its way). */
async function onCanvas(canvasPath, file) {
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const doc = parseCanvas(await ide.workspace.fs.read(canvasPath));
      if (
        doc.nodes.some(
          (n) =>
            (n.type === "file" && norm(n.file) === norm(file)) ||
            (n.type === "group" && n.background && norm(n.background) === norm(file)),
        )
      )
        return true;
    } catch {
      // Unreadable: no.
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

/**
 * The project's canvases, relative: the canvas folder, then every other .canvas file the search
 * finds (it skips .gitignored and hidden folders, so the canvas folder is listed on its own).
 */
async function findCanvases() {
  await root();
  const folders = await canvasFolders();
  const found = new Set();
  const main = `${folders[0]}/main.canvas`;
  for (const folder of folders)
    for (const e of await ide.workspace.fs.list(folder).catch(() => []))
      if (e.kind === "file" && e.name.endsWith(".canvas")) found.add(relative(e.path));
  try {
    // One match per file: a canvas starts with "{".
    const { matches } = await ide.workspace.findText("^\\s*\\{", {
      isRegex: true,
      include: ["**/*.canvas"],
      maxResults: 2000,
    });
    for (const m of matches) found.add(m.rel.replace(/\\/g, "/"));
  } catch {
    // No search (no folder yet): the canvas folder is enough.
  }
  // The main one first, then by name ("untitled" before "untitled-2").
  const name = (p) => p.replace(/\.canvas$/, "");
  return [...found].sort((a, b) =>
    a === main ? -1 : b === main ? 1 : name(a).localeCompare(name(b), undefined, { numeric: true }),
  );
}

exports.activate = (ide) => {
  const viewer = ide.ui.webview("canvas.viewer");

  ide.commands.register("canvas.open", async (input) => {
    const path = await resolvePath(input);
    if (!(await exists(path)))
      await ide.workspace.fs.write(path, serializeCanvas({ nodes: [], edges: [], extra: {} }));
    canvasWritten(path);
    await ide.commands.execute("viewer.open", { path, viewer: "canvas.viewer", preview: false });
    return { path: relative(path) };
  });

  ide.commands.register("canvas.new", async (input) => {
    await root();
    // From the explorer's menu, `path` is a folder to make it in; otherwise it names the file
    // (".canvas" added), like every other command's.
    let path = typeof input?.path === "string" ? input.path.trim() : "";
    let folder = await canvasFolder();
    const kind = path
      ? await ide.workspace.fs.stat(path).then(
          (st) => st.kind,
          () => null,
        )
      : null;
    if (kind === "dir" || kind === "directory") {
      folder = path;
      path = "";
    } else if (path && !path.endsWith(".canvas")) path = `${path}.canvas`;
    if (!path) {
      for (let i = 1; i < 1000; i++) {
        const candidate = `${folder}/${i === 1 ? "untitled" : `untitled-${i}`}.canvas`;
        if (!(await exists(candidate))) {
          path = candidate;
          break;
        }
      }
    }
    if (await exists(path)) throw new Error(`${relative(path)} already exists.`);
    await ide.workspace.fs.write(path, serializeCanvas({ nodes: [], edges: [], extra: {} }));
    canvasWritten(path);
    await ide.commands.execute("viewer.open", { path, viewer: "canvas.viewer", preview: false });
    return { path: relative(path) };
  });

  // The sidebar's +, and the palette: a canvas with a name you give it.
  ide.commands.register("canvas.newNamed", async (input) => {
    await root();
    // From the explorer's folder menu: made in that folder.
    const inFolder =
      typeof input?.path === "string" && input.path.trim()
        ? input.path.trim()
        : await canvasFolder();
    const name = await ide.ui.showInput({
      prompt: "Name of the new canvas",
      placeholder: "architecture, sprint plan…",
    });
    const clean = name
      ?.trim()
      .replace(/\.canvas$/i, "")
      .replace(/[<>:"\\|?*]/g, "-")
      .replace(/\s+/g, " ");
    if (!clean) return { path: null };
    // A name with a / is a path from the project's top, unless it came from a folder's menu.
    const fromFolder = typeof input?.path === "string" && input.path.trim();
    const path =
      clean.includes("/") && !fromFolder ? `${clean}.canvas` : `${inFolder}/${clean}.canvas`;
    if (await exists(path)) {
      await ide.commands.execute("viewer.open", { path, viewer: "canvas.viewer", preview: false });
      return { path: relative(path), existed: true };
    }
    await ide.workspace.fs.write(path, serializeCanvas({ nodes: [], edges: [], extra: {} }));
    canvasWritten(path);
    await ide.commands.execute("viewer.open", { path, viewer: "canvas.viewer", preview: false });
    return { path: relative(path) };
  });

  // The explorer's "Add to canvas": a file, or a folder's files, onto the canvas in use.
  ide.commands.register("canvas.addFiles", async (input) => {
    await root();
    const paths = (Array.isArray(input?.paths) ? input.paths : [input?.path]).filter(
      (p) => typeof p === "string" && p,
    );
    if (!paths.length) throw new Error("Give a file or folder to add.");
    const files = [];
    for (const p of paths) {
      const st = await ide.workspace.fs.stat(p).catch(() => null);
      if (!st) continue;
      if (st.kind === "dir" || st.kind === "directory") {
        const entries = await ide.workspace.fs.list(p).catch(() => []);
        for (const e of entries)
          if (e.kind === "file" && !e.name.startsWith(".")) files.push(relative(e.path));
      } else files.push(relative(p));
    }
    const chosen = files.filter((f) => !f.endsWith(".canvas") || files.length === 1).slice(0, 60);
    if (!chosen.length) throw new Error("No files to add there.");
    const target =
      lastActive && open.get(keyOf(lastActive))?.tabs > 0 ? lastActive : await resolvePath({});
    const before = await load(target);
    const result = applyOps(
      before,
      chosen.map((file) => ({ op: "add", file })),
    );
    await ide.workspace.fs.write(target, serializeCanvas(result.doc));
    canvasWritten(target);
    await show(target, result.changed, true).catch(() => {});
    return { path: relative(target), added: chosen.length };
  });

  ide.commands.register("canvas.export", async (input) => {
    const path = await resolvePath(input);
    if (!(await exists(path))) throw new Error(`${relative(path)} doesn't exist.`);
    const key = keyOf(path);
    const request = `x${Date.now()}${Math.random().toString(16).slice(2, 8)}`;
    const options = {
      type: "exportRequest",
      key,
      request,
      format: input?.format === "svg" ? "svg" : "png",
      area: input?.area === "view" ? "view" : "all",
      scale: [1, 2, 3].includes(input?.scale) ? input.scale : 2,
      privacy: input?.privacy === true,
    };
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Gone either way: a page opening later doesn't export by surprise.
        exportsPending.delete(request);
        if (pendingExports.get(key)?.request === request) pendingExports.delete(key);
        reject(new Error("The canvas page didn't answer in time: is the canvas open?"));
      }, 30000);
      exportsPending.set(request, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
    // The page draws the picture, once it has loaded its file (opened first when it isn't).
    try {
      if (ready.has(key)) await viewer.postMessage(options);
      else {
        pendingExports.set(key, options);
        if (!(open.get(key)?.tabs > 0)) await show(path, [], false);
      }
    } catch (err) {
      exportsPending.get(request)?.reject(err);
      exportsPending.delete(request);
    }
    return { path: await done };
  });

  ide.commands.register("canvas.read", async (input) => {
    const path = await resolvePath(input);
    if (!(await exists(path)))
      return { path: relative(path), exists: false, nodes: [], edges: [], selection: [] };
    const doc = await load(path);
    const shown = open.get(keyOf(path))?.tabs > 0 ? open.get(keyOf(path)) : null;
    return {
      path: relative(path),
      exists: true,
      // The user has it open: they see what changes.
      open: !!shown,
      ...describe(doc, shown?.selection),
    };
  });

  ide.commands.register("canvas.edit", async (input) => {
    const path = await resolvePath(input);
    const before = await load(path);
    const result = applyOps(before, input?.ops);
    await ide.workspace.fs.write(path, serializeCanvas(result.doc));
    canvasWritten(path);
    if (input?.reveal !== false) await show(path, result.changed, true).catch(() => {});
    return {
      path: relative(path),
      added: result.added,
      changed: result.changed,
      removed: result.removed,
      cards: result.doc.nodes.length,
      arrows: result.doc.edges.length,
    };
  });

  ide.commands.register("canvas.focus", async (input) => {
    const path = await resolvePath(input);
    if (!(await exists(path))) throw new Error(`${relative(path)} doesn't exist.`);
    const ids = Array.isArray(input?.ids) ? input.ids.map(String) : [];
    await show(path, ids, false);
    return { path: relative(path) };
  });

  ide.commands.register("canvas.list", async () => ({ canvases: await findCanvases() }));

  // The sidebar's Canvases view: every canvas in the project, the main one first.
  let listed = new Set();
  const tree = ide.ui.registerTreeView("canvas.list", {
    getChildren: async (parent) => {
      if (parent) return [];
      let found = [];
      try {
        found = await findCanvases();
        listed = new Set(found.map(keyOf));
      } catch {
        return [{ id: "none", label: "Open a folder to keep canvases", icon: "info" }];
      }
      if (!found.length)
        return [
          {
            id: "new",
            label: "New canvas",
            description: "none yet",
            icon: "plus",
            command: { id: "canvas.newNamed" },
          },
        ];
      return found.map((path) => {
        const slash = path.lastIndexOf("/");
        return {
          id: path,
          label: path.slice(slash + 1).replace(/\.canvas$/, ""),
          description: slash > 0 ? path.slice(0, slash) : "",
          tooltip: path,
          icon: "layout-dashboard",
          command: { id: "canvas.open", input: { path } },
        };
      });
    },
  });
  let refreshTimer = null;
  const refresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => tree.refresh(), 300);
  };
  canvasWritten = (path) => {
    if (!listed.has(keyOf(path))) refresh();
  };
  ide.commands.register("canvas.refresh", () => {
    tree.refresh();
    return { refreshed: true };
  });
  // A canvas written for the first time (the agent's, canvas.new, a save from elsewhere) shows up.
  ide.events.on("files.didChange", (e) => {
    const path = e?.path;
    if (typeof path === "string" && path.endsWith(".canvas") && !listed.has(keyOf(path))) refresh();
  });
  for (const type of ["files.didCreate", "files.didDelete", "files.didRename"])
    ide.events.on(type, (e) => {
      const paths = [e?.path, e?.from, e?.to, e?.oldPath, e?.newPath].filter(
        (x) => typeof x === "string",
      );
      // A folder (it may hold canvases) or a canvas.
      if (!paths.length || paths.some((x) => x.endsWith(".canvas") || !/\.[^/\\]+$/.test(x)))
        refresh();
    });

  // The viewer pages.
  viewer.onMessage(async (m) => {
    if (!m || typeof m !== "object") return;
    if (rootCache === null) await root().catch(() => {});
    const key = typeof m.path === "string" ? keyOf(m.path) : null;
    // Tabs opening and closing, from the IDE (the page's own word can't be had when it closes).
    if (key && m.ide === "viewerOpened") {
      const entry = open.get(key) ?? { tabs: 0, selection: [] };
      entry.tabs++;
      open.set(key, entry);
      return;
    }
    if (key && m.ide === "viewerClosed") {
      const entry = open.get(key);
      if (entry && --entry.tabs <= 0) {
        open.delete(key);
        ready.delete(key);
      }
      return;
    }
    try {
      switch (m.type) {
        case "open": {
          if (!key) return;
          await root();
          const k = keyOf(m.path);
          ready.add(k);
          lastActive = String(m.path);
          await viewer.postMessage({ type: "settings", key: k, ...(await settings()) });
          const exportNow = pendingExports.get(k);
          if (exportNow) {
            pendingExports.delete(k);
            // A moment for its previews (images) to arrive.
            setTimeout(() => void viewer.postMessage(exportNow), 1500);
          }
          const focus = pendingFocus.get(k);
          if (focus) {
            pendingFocus.delete(k);
            await viewer.postMessage({ type: "focus", key: k, ...focus });
          }
          return;
        }
        case "selection":
          if (typeof m.path === "string") lastActive = m.path;
          if (key && open.has(key))
            open.get(key).selection = Array.isArray(m.ids) ? m.ids.slice(0, 500).map(String) : [];
          return;
        case "openFile":
          await ide.editor.open(String(m.file));
          return;
        case "openLink":
          if (/^https?:\/\//i.test(String(m.url)))
            await ide.commands.execute("browser.open", { url: String(m.url) });
          return;
        case "mdCss": {
          // The IDE's Markdown styles for this theme (D187): cards read like the preview.
          const r = await ide.commands
            .execute("editor.renderMarkdown", { text: "", css: true })
            .catch(() => null);
          if (r?.css) await viewer.postMessage({ type: "mdCss", key, css: r.css });
          return;
        }
        case "renderMd": {
          // A Markdown file card, rendered by the IDE as its preview renders it (D187); only a
          // file on this canvas, narrowed to the card's heading.
          const file = String(m.file);
          const subpath = typeof m.subpath === "string" ? m.subpath : "";
          const out = { type: "renderedMd", key, file, subpath };
          try {
            if (!key || !(await onCanvas(m.path, file))) throw new Error("not on this canvas");
            const text = section(await ide.workspace.fs.read(file), subpath);
            const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
            const r = await ide.commands.execute("editor.renderMarkdown", {
              text: text.slice(0, 200000),
              base: dir,
              css: false,
            });
            out.html = r?.html ?? "";
          } catch (err) {
            out.error = err instanceof Error ? err.message : String(err);
          }
          await viewer.postMessage(out);
          return;
        }
        case "preview": {
          // A file card's content, by kind: an image, Markdown (rendered by the page), a nested
          // canvas's summary, or the first lines colored as the editor colors them; with the
          // file icon theme's icon. Only for a file that's on a card of that canvas: the page
          // can't read the project at will.
          const file = String(m.file);
          const out = { type: "preview", key, file };
          try {
            if (!key || !(await onCanvas(m.path, file))) throw new Error("not on this canvas");
            const kind = IMAGE.test(file) ? imageType(file) : null;
            const plainText = !kind && !/\.(md|markdown|canvas)$/i.test(file);
            // One call: a code file's colored lines come with its icon; the rest ask the icon only.
            const rendered = await ide.commands
              .execute(
                "editor.renderFile",
                plainText ? { path: file, maxLines: 80 } : { path: file, iconOnly: true },
              )
              .catch(() => null);
            if (rendered?.icon) out.icon = rendered.icon;
            if (kind) {
              if ((await ide.settings.get("canvas.showImages")) === false)
                throw new Error("image previews are off (canvas.showImages)");
              // Images come as data: URLs (the page's origin can't load project files).
              out.image = `data:${kind};base64,${await ide.workspace.fs.readBase64(file)}`;
            } else if (/\.(md|markdown)$/i.test(file)) {
              out.markdown = (await ide.workspace.fs.read(file)).slice(0, 200000);
            } else if (/\.canvas$/i.test(file)) {
              const inner = parseCanvas(await ide.workspace.fs.read(file));
              out.summary = {
                cards: inner.nodes.length,
                arrows: inner.edges.length,
                titles: inner.nodes
                  .map((n) =>
                    n.type === "group"
                      ? n.label
                      : n.type === "file"
                        ? n.file
                        : n.type === "link"
                          ? n.url
                          : String(n.text ?? "").split("\n")[0],
                  )
                  .filter((t) => typeof t === "string" && t.trim())
                  .map((t) => t.replace(/^#+\s*/, "").slice(0, 80))
                  .slice(0, 12),
              };
            } else {
              const r = rendered;
              if (!r) throw new Error("couldn't read it");
              if (r?.binary) out.note = "A binary file: double-click to open it.";
              else if (r?.tooLarge) out.note = "A large file: double-click to open it.";
              else {
                out.html = r?.html ?? "";
                out.lines = r?.lines;
                out.totalLines = r?.totalLines;
                out.language = r?.language;
              }
            }
          } catch (err) {
            out.error = err instanceof Error ? err.message : String(err);
          }
          // Only to the canvas that asked (an image can be megabytes).
          await viewer.postMessage(out);
          return;
        }
        case "settings":
          await ide.commands.execute("settings.open", { query: "canvas." });
          return;
        case "reveal":
          await ide.commands.execute("explorer.reveal", { path: String(m.file) });
          return;
        case "ask": {
          // Files and images: the IDE's file search; links: its input box. With `id`, the answer
          // changes that card (swap a file, change a link, a group's background).
          const IMAGES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif"];
          const imageOnly =
            m.kind === "image" || m.kind === "background" || (m.kind === "swap" && m.image);
          let answer;
          if (["file", "image", "swap", "background"].includes(m.kind)) {
            const picked = await ide.commands.execute("quickOpen.pickFile", {
              placeholder: imageOnly
                ? "Search images in the project"
                : m.kind === "swap"
                  ? "Search for the file to show instead"
                  : "Search files to put on the canvas",
              ...(imageOnly && { extensions: IMAGES }),
            });
            answer = picked?.path ?? undefined;
          } else
            answer = await ide.ui.showInput({
              prompt: m.kind === "url" ? "New link" : "Link to put on the canvas",
              placeholder: "https://…",
              ...(typeof m.value === "string" && { value: m.value }),
            });
          if (answer?.trim())
            await viewer.postMessage({
              type: "answer",
              key,
              kind: m.kind === "image" ? "file" : m.kind,
              value: answer.trim().replace(/\\/g, "/"),
              at: m.at,
              ...(m.id && { id: String(m.id) }),
            });
          return;
        }
        case "convert": {
          // A text card becomes a Markdown file next to the canvas (Obsidian's "Convert to file").
          const text = String(m.text ?? "");
          const first = text.split("\n").find((l) => l.trim()) ?? "";
          const suggested =
            first
              .replace(/^#+\s*/, "")
              .replace(/[<>:"\\/|?*]/g, "")
              .trim()
              .slice(0, 60) || "Untitled";
          const name = await ide.ui.showInput({
            prompt: "Name of the new note",
            value: suggested,
          });
          // "notes\idea" (Windows) and "notes/idea" both mean a folder, next to the canvas.
          const clean = name
            ?.trim()
            .replace(/\\/g, "/")
            .replace(/\.md$/i, "")
            .split("/")
            .map((part) => part.replace(/[<>:"|?*]/g, "-").replace(/[. ]+$/, ""))
            .filter((part) => part && part !== "." && part !== "..")
            .join("/");
          if (!clean) return;
          if (clean.split("/").some((part) => RESERVED.test(part)))
            throw new Error(`"${clean}" can't be a file name on Windows.`);
          if (!/\.canvas$/i.test(String(m.path))) return;
          const base = relative(m.path);
          const dir = base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : ".";
          const target = await freeName((i) =>
            i === 1 ? `${dir}/${clean}.md` : `${dir}/${clean} ${i}.md`,
          );
          await ide.workspace.fs.write(target, text);
          await viewer.postMessage({
            type: "answer",
            key,
            kind: "converted",
            id: String(m.id),
            value: relative(target).replace(/^\.\//, ""),
          });
          return;
        }
        case "pasteImage": {
          // An image pasted onto the canvas is saved beside it (attachments/) and shown on a card.
          const ext = {
            "image/png": "png",
            "image/jpeg": "jpg",
            "image/gif": "gif",
            "image/webp": "webp",
          }[String(m.mime)];
          if (!ext || typeof m.data !== "string") return;
          if (!key || !open.has(key) || !/\.canvas$/i.test(String(m.path))) return;
          const base = relative(m.path);
          const dir = `${base.includes("/") ? base.slice(0, base.lastIndexOf("/")) : "."}/attachments`;
          const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
          const target = await freeName((i) =>
            i === 1
              ? `${dir}/Pasted image ${stamp}.${ext}`
              : `${dir}/Pasted image ${stamp} ${i}.${ext}`,
          );
          await ide.workspace.fs.writeBase64(target, m.data);
          await viewer.postMessage({
            type: "answer",
            key,
            kind: "file",
            value: relative(target).replace(/^\.\//, ""),
            at: m.at,
          });
          return;
        }
        case "exportError": {
          const waiting = exportsPending.get(m.request);
          exportsPending.delete(m.request);
          waiting?.reject(new Error(`Couldn't export: ${m.message}`));
          return;
        }
        case "exportFile": {
          // The page's export (a PNG as base64, or SVG text), saved beside its canvas.
          if (!key || !open.has(key) || !/\.canvas$/i.test(String(m.path))) return;
          const waiting = m.request ? exportsPending.get(m.request) : null;
          // A request already answered (the canvas is open twice): the second picture is dropped.
          if (m.request && !waiting) return;
          if (m.request) exportsPending.delete(m.request);
          const stem = relative(m.path).replace(/\.canvas$/i, "");
          const ext = m.format === "svg" ? "svg" : "png";
          try {
            const target = await freeName((i) =>
              i === 1 ? `${stem}.${ext}` : `${stem} ${i}.${ext}`,
            );
            if (ext === "svg") await ide.workspace.fs.write(target, String(m.text ?? ""));
            else await ide.workspace.fs.writeBase64(target, String(m.data ?? ""));
            if (waiting) {
              // Asked by a command (the agent, a script): it gets the path; no notice.
              waiting.resolve(relative(target));
              return;
            }
            const choice = await ide.ui.notify(`Exported ${relative(target)}.`, {
              kind: "success",
              actions: ["Open", "Show in explorer"],
            });
            if (choice === "Open") await ide.editor.open(target).catch(() => {});
            if (choice === "Show in explorer")
              await ide.commands.execute("explorer.reveal", { path: target }).catch(() => {});
          } catch (err) {
            if (waiting) waiting.reject(err);
            else throw err;
          }
          return;
        }
      }
    } catch (err) {
      await ide.ui.notify(`Canvas: ${err instanceof Error ? err.message : String(err)}`, {
        kind: "error",
      });
    }
  });

  // A file shown on a card changed: its preview is fetched again.
  ide.events.on("files.didChange", async (e) => {
    if (typeof e?.path !== "string" || e.path.endsWith(".canvas") || !open.size) return;
    await root().catch(() => {});
    await viewer.postMessage({ type: "previewStale", file: relative(e.path) });
  });

  ide.settings.onChange(async (keys) => {
    if (!keys.some((k) => k.startsWith("canvas."))) return;
    const s = await settings();
    for (const key of open.keys()) await viewer.postMessage({ type: "settings", key, ...s });
  });
};

exports.deactivate = () => {};
