// Canvas layout maths (D184), DOM-free so it can be unit-tested (src/core/canvas): snapping a
// moving card to other cards' edges and centres (with the guide lines to draw), aligning,
// distributing, arranging and justifying a selection, and the tree / grid layouts. Rects are
// { x, y, width, height }; functions that move cards change them in place and return nothing.

(() => {
  const right = (r) => r.x + r.width;
  const bottom = (r) => r.y + r.height;
  const centerX = (r) => r.x + r.width / 2;
  const centerY = (r) => r.y + r.height / 2;

  /**
   * Where `rect` should move so one of its edges or its centre lines up with another card's
   * (within `threshold`), per axis, and the guides showing it. Returns { dx, dy, guides }.
   */
  function snapToObjects(rect, others, threshold) {
    const best = { x: null, y: null };
    const consider = (axis, from, to, other) => {
      const d = to - from;
      if (Math.abs(d) > threshold) return;
      if (!best[axis] || Math.abs(d) < Math.abs(best[axis].d)) best[axis] = { d, at: to, other };
    };
    for (const o of others) {
      for (const a of [rect.x, centerX(rect), right(rect)])
        for (const b of [o.x, centerX(o), right(o)]) consider("x", a, b, o);
      for (const a of [rect.y, centerY(rect), bottom(rect)])
        for (const b of [o.y, centerY(o), bottom(o)]) consider("y", a, b, o);
    }
    const dx = best.x ? best.x.d : 0;
    const dy = best.y ? best.y.d : 0;
    const moved = { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
    const guides = [];
    // A vertical line through both cards at the shared x, a horizontal one at the shared y.
    if (best.x) {
      const o = best.x.other;
      guides.push({
        x1: best.x.at,
        y1: Math.min(moved.y, o.y) - 12,
        x2: best.x.at,
        y2: Math.max(bottom(moved), bottom(o)) + 12,
      });
    }
    if (best.y) {
      const o = best.y.other;
      guides.push({
        x1: Math.min(moved.x, o.x) - 12,
        y1: best.y.at,
        x2: Math.max(right(moved), right(o)) + 12,
        y2: best.y.at,
      });
    }
    return { dx, dy, guides };
  }

  /** left | center | right | top | middle | bottom: to the selection's outermost edge (or centre). */
  function align(nodes, how) {
    if (nodes.length < 2) return;
    const minX = Math.min(...nodes.map((n) => n.x));
    const maxX = Math.max(...nodes.map(right));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxY = Math.max(...nodes.map(bottom));
    for (const n of nodes) {
      if (how === "left") n.x = minX;
      else if (how === "right") n.x = maxX - n.width;
      else if (how === "center") n.x = Math.round((minX + maxX) / 2 - n.width / 2);
      else if (how === "top") n.y = minY;
      else if (how === "bottom") n.y = maxY - n.height;
      else if (how === "middle") n.y = Math.round((minY + maxY) / 2 - n.height / 2);
    }
  }

  /** Even gaps between the cards along an axis, the outer two staying put. */
  function distribute(nodes, axis) {
    if (nodes.length < 3) return;
    const pos = axis === "x" ? "x" : "y";
    const size = axis === "x" ? "width" : "height";
    const sorted = [...nodes].sort((a, b) => a[pos] - b[pos]);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const span = last[pos] + last[size] - first[pos];
    const total = sorted.reduce((s, n) => s + n[size], 0);
    const gap = (span - total) / (sorted.length - 1);
    let at = first[pos];
    for (const n of sorted) {
      n[pos] = Math.round(at);
      at += n[size] + gap;
    }
  }

  /** The same width (or height) for all: the widest's (tallest's). */
  function justify(nodes, dimension) {
    if (nodes.length < 2) return;
    const max = Math.max(...nodes.map((n) => n[dimension]));
    for (const n of nodes) n[dimension] = max;
  }

  /** row | column | grid, from the selection's top-left, with `gap` between cards. */
  function arrange(nodes, style, gap, snap = (v) => v) {
    if (!nodes.length) return;
    const x0 = Math.min(...nodes.map((n) => n.x));
    const y0 = Math.min(...nodes.map((n) => n.y));
    // In reading order, so a row stays the row you see.
    const ordered = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x);
    if (style === "row" || style === "column") {
      let at = style === "row" ? x0 : y0;
      for (const n of ordered) {
        if (style === "row") {
          n.x = snap(at);
          n.y = snap(y0);
          at += n.width + gap;
        } else {
          n.x = snap(x0);
          n.y = snap(at);
          at += n.height + gap;
        }
      }
      return;
    }
    const cols = Math.ceil(Math.sqrt(ordered.length));
    const cellW = Math.max(...ordered.map((n) => n.width)) + gap;
    let y = y0;
    for (let r = 0; r * cols < ordered.length; r++) {
      const row = ordered.slice(r * cols, r * cols + cols);
      row.forEach((n, i) => {
        n.x = snap(x0 + i * cellW);
        n.y = snap(y);
      });
      y += Math.max(...row.map((n) => n.height)) + gap;
    }
  }

  /**
   * Left to right along the arrows: each card one column right of the furthest card pointing at
   * it (cycles cut by capping the passes), each column's cards ordered by their parents' rows.
   */
  function tree(nodes, edges, gap, snap = (v) => v) {
    if (!nodes.length) return;
    const set = new Set(nodes.map((n) => n.id));
    const links = edges.filter((e) => set.has(e.fromNode) && set.has(e.toNode));
    const x0 = Math.min(...nodes.map((n) => n.x));
    const y0 = Math.min(...nodes.map((n) => n.y));
    const level = new Map(nodes.map((n) => [n.id, 0]));
    for (let pass = 0; pass < nodes.length; pass++) {
      let moved = false;
      for (const e of links) {
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
    const heights = columns.map((c) => (c ?? []).reduce((h, n) => h + n.height + gap, -gap));
    const tallest = Math.max(...heights);
    const rowOf = new Map();
    let x = x0;
    columns.forEach((column, i) => {
      if (!column) return;
      const parentRow = (n) => {
        const rows = links
          .filter((e) => e.toNode === n.id && rowOf.has(e.fromNode))
          .map((e) => rowOf.get(e.fromNode));
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Infinity;
      };
      if (i > 0) column.sort((a, b) => parentRow(a) - parentRow(b));
      let y = y0 + (tallest - heights[i]) / 2;
      column.forEach((n, row) => {
        n.x = snap(x);
        n.y = snap(y);
        rowOf.set(n.id, row);
        y += n.height + gap;
      });
      x += Math.max(...column.map((n) => n.width)) + gap * 3;
    });
  }

  /** The new rect when one of a card's edges (or the corner) is dragged; `keepRatio`: Shift. */
  function resize(start, dir, dx, dy, keepRatio, min) {
    let { x, y, width, height } = start;
    if (dir.includes("e")) width = start.width + dx;
    if (dir.includes("s")) height = start.height + dy;
    if (dir.includes("w")) width = start.width - dx;
    if (dir.includes("n")) height = start.height - dy;
    if (keepRatio && start.height > 0) {
      const ratio = start.width / start.height;
      if (dir === "n" || dir === "s") width = height * ratio;
      else height = width / ratio;
    }
    width = Math.max(min.width, width);
    height = Math.max(min.height, height);
    if (dir.includes("w")) x = start.x + start.width - width;
    if (dir.includes("n")) y = start.y + start.height - height;
    return { x, y, width, height };
  }

  self.canvasGeometry = { snapToObjects, align, distribute, justify, arrange, tree, resize };
})();
