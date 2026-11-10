// The canvas page (D181): an infinite board of cards and arrows for a .canvas file (JSON Canvas).
// Pan with the wheel, Space+drag or the middle button; zoom with Ctrl+wheel or a pinch. Double-
// click the board for a card, drag a card's edge dot to draw an arrow (onto empty space: a new
// card). Edits save to the file (debounced). When the file changes on disk (the agent's
// canvas.edit, git, another window) the page takes the new version, keeps its own unsaved
// changes on top, and lights up what changed; Ctrl+Z undoes the agent's edit like any other.

(() => {
  const NS = "ide-webview";
  const GRID = 20;
  const MIN_ZOOM = 0.1;
  const MAX_ZOOM = 4;
  const SAVE_MS = 300;
  const md = self.canvasMarkdown;
  const geo = self.canvasGeometry;

  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  const world = $("world");
  const svg = $("edges");
  const marqueeEl = $("marquee");
  const emptyEl = $("empty");
  const toolbar = $("toolbar");
  const selectionBar = $("selectionbar");
  const errorEl = $("error");
  const SVG = "http://www.w3.org/2000/svg";

  // ---- State ----------------------------------------------------------------------------------
  let file = null; // { path, name, canSave }
  let key = "";
  let doc = { nodes: [], edges: [], extra: {} };
  let broken = false; // the file isn't a valid canvas: shown, never saved over
  let lastText = null; // the file's text as last saved or received
  let view = { x: 0, y: 0, zoom: 1 };
  const selected = new Set(); // node and edge ids
  let editing = null; // { id, textarea } or { edgeId, input } or { groupId, input }
  let snapOn = true;
  /** Set by the find bar: marks matches again after a redraw. */
  let afterRender = null;
  /** Bumped per preview that arrives (a card redraws when its file's preview changes). */
  let previewVersion = 0;
  /** The extension's settings that shape drawing (sent by main.js). */
  const prefs = {
    arrows: "curved",
    cardWidth: 260,
    imagePreview: true,
    snapObjects: true,
    embedPages: true,
  };
  /** Rendered notes, web pages and dragging out of cards (cards.js, D187); set up at the end. */
  let cards = null;
  const undoStack = [];
  const redoStack = [];
  let saveTimer = 0;
  /** Ids changed (or "deleted") here since the last save: kept when the file changes under us. */
  const dirty = new Map();
  const nodeEls = new Map();
  const labelEls = new Map();
  const previews = new Map(); // file → { text, error } | "loading"
  let spaceDown = false;

  const post = (message) => parent.postMessage({ ns: NS, message }, "*");
  const byId = (id) => doc.nodes.find((n) => n.id === id);
  const edgeById = (id) => doc.edges.find((e) => e.id === id);
  const snap = (v) => (snapOn ? Math.round(v / GRID) * GRID : Math.round(v));
  /** Read-only by choice (the toolbar's lock, Obsidian's "Read-only"): this view only. */
  let locked = false;
  const readOnly = () => broken || locked || !file?.canSave;
  /** Whether saving is possible at all (the lock stops editing, not saving what was done). */
  const canWrite = () => !broken && !!file?.canSave;
  const keyOf = (path) => {
    const p = String(path).replace(/\\/g, "/").replace(/\/+/g, "/");
    return /^[a-zA-Z]:/.test(p) ? p.toLowerCase() : p;
  };
  const newId = () => {
    const taken = new Set([...doc.nodes.map((n) => n.id), ...doc.edges.map((e) => e.id)]);
    for (;;) {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (!taken.has(id)) return id;
    }
  };

  // ---- Parsing (the same rules as main.js) -----------------------------------------------------
  function parse(text) {
    if (!text?.trim()) return { nodes: [], edges: [], extra: {} };
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("expected an object");
    const { nodes: rn, edges: re, ...extra } = raw;
    const nodes = [];
    const ids = new Set();
    for (const n of Array.isArray(rn) ? rn : []) {
      if (!n || typeof n !== "object" || typeof n.id !== "string" || ids.has(n.id)) continue;
      const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : d);
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
    for (const e of Array.isArray(re) ? re : [])
      if (
        e &&
        typeof e.id === "string" &&
        ids.has(e.fromNode) &&
        ids.has(e.toNode) &&
        !edges.some((x) => x.id === e.id)
      )
        edges.push({ ...e });
    return { nodes, edges, extra };
  }
  const serialize = (d) =>
    JSON.stringify({ nodes: d.nodes, edges: d.edges, ...d.extra }, null, "\t");
  const clone = (d) => ({
    nodes: d.nodes.map((n) => ({ ...n })),
    edges: d.edges.map((e) => ({ ...e })),
    extra: { ...d.extra },
  });

  // ---- Saving, undo, and changes from outside --------------------------------------------------
  /** Call before changing `doc` (one undo step); returns the step. */
  function checkpoint() {
    const step = clone(doc);
    undoStack.push(step);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    return step;
  }
  /** After changing `doc`: marks what changed, renders, and saves soon. */
  function changed(ids, deletedIds = [], now = false) {
    for (const id of ids) dirty.set(id, "set");
    for (const id of deletedIds) dirty.set(id, "deleted");
    render();
    if (now) saveNow();
    else scheduleSave();
  }
  function scheduleSave() {
    if (!canWrite()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, SAVE_MS);
  }
  /**
   * Saves sent but not yet seen back from the file, oldest first, with the ids each carried:
   * if someone else's version of the file lands first (the agent's canvas.edit read the file
   * before our save reached it), those ids are put back on top of it, so nothing typed is lost.
   */
  const inFlight = [];
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!canWrite() || !loaded) return;
    const text = serialize(doc);
    if (text === lastText) {
      dirty.clear();
      return;
    }
    inFlight.push({ text, ids: new Map(dirty) });
    if (inFlight.length > 30) inFlight.shift();
    dirty.clear();
    lastText = text;
    parent.postMessage({ ns: NS, save: text }, "*");
  }
  function restore(from, to) {
    if (!from.length || readOnly()) return;
    to.push(clone(doc));
    const before = doc;
    doc = from.pop();
    for (const id of diff(before, doc)) dirty.set(id, byId(id) || edgeById(id) ? "set" : "deleted");
    for (const id of [...selected]) if (!byId(id) && !edgeById(id)) selected.delete(id);
    render();
    scheduleSave();
  }

  /** Ids whose node or edge differs between two docs (added, removed or changed). */
  function diff(a, b) {
    const out = new Set();
    const index = (list) => new Map(list.map((x) => [x.id, JSON.stringify(x)]));
    for (const [x, y] of [
      [index(a.nodes), index(b.nodes)],
      [index(a.edges), index(b.edges)],
    ]) {
      for (const [id, v] of x) if (y.get(id) !== v) out.add(id);
      for (const id of y.keys()) if (!x.has(id)) out.add(id);
    }
    return out;
  }

  /** The canvas loaded once (a broken or unreadable file doesn't count until it's fixed). */
  let loaded = false;
  /** A version of the file that came during a drag: taken when the drag ends. */
  let heldFile = null;

  /** The file arrived or changed on disk. */
  function receive(f) {
    if (gesture) {
      heldFile = f;
      return;
    }
    const first = !loaded;
    file = { path: f.path, name: f.name, canSave: f.canSave !== false };
    key = keyOf(f.path);
    if (f.error !== undefined && f.text === undefined) {
      showError(`Couldn't read ${f.name}: ${f.error}`);
      return;
    }
    // Our own save coming back: everything up to it is on disk.
    const echo = inFlight.findIndex((x) => x.text === f.text);
    if (echo >= 0) {
      inFlight.splice(0, echo + 1);
      if (!first) return;
    }
    if (f.text === lastText && !first) return;
    let incoming;
    try {
      incoming = parse(f.text);
    } catch (err) {
      broken = true;
      showError(
        `${f.name} isn't a valid canvas file (JSON Canvas): ${err.message}. It's left as it is; fix it in the text editor.`,
      );
      return;
    }
    broken = false;
    showError(null);
    lastText = f.text;
    // Our changes not yet on disk (unsaved, or saved but overtaken) win for their cards.
    const mine = new Map();
    for (const x of inFlight) for (const [id, state] of x.ids) mine.set(id, state);
    for (const [id, state] of dirty) mine.set(id, state);
    if (!first && mine.size) {
      for (const [id, state] of mine) {
        const local = byId(id) ?? edgeById(id);
        const list = local && "fromNode" in local ? "edges" : "nodes";
        if (state === "deleted" || !local) {
          incoming.nodes = incoming.nodes.filter((n) => n.id !== id);
          incoming.edges = incoming.edges.filter((e) => e.id !== id);
        } else {
          const at = incoming[list].findIndex((x) => x.id === id);
          if (at >= 0) incoming[list][at] = { ...local };
          else incoming[list].push({ ...local });
          dirty.set(id, "set");
        }
        if (state === "deleted") dirty.set(id, "deleted");
      }
      inFlight.length = 0;
      const ids = new Set(incoming.nodes.map((n) => n.id));
      incoming.edges = incoming.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode));
    }
    const changedIds = first ? new Set() : diff(doc, incoming);
    if (!first && changedIds.size) {
      // The outside change is one undo step.
      undoStack.push(clone(doc));
      redoStack.length = 0;
    }
    doc = incoming;
    loaded = true;
    // A menu opened on the old version would act on cards that are gone.
    menus?.close();
    for (const id of [...selected]) if (!byId(id) && !edgeById(id)) selected.delete(id);
    if (editing?.id && !byId(editing.id)) stopEditing(false);
    render();
    if (first) {
      restoreView() || fit(doc.nodes);
      post({ type: "open", path: f.path });
      cards?.askCss();
    } else flash([...changedIds]);
    if (dirty.size) scheduleSave();
  }

  function showError(text) {
    errorEl.hidden = !text;
    errorEl.textContent = text ?? "";
    stage.classList.toggle("is-broken", !!text);
  }

  // ---- View -------------------------------------------------------------------------------------
  function applyView() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
    const size = GRID * view.zoom * (view.zoom < 0.5 ? 4 : 1);
    stage.style.backgroundSize = `${size}px ${size}px`;
    stage.style.backgroundPosition = `${view.x}px ${view.y}px`;
    stage.classList.toggle("is-far", view.zoom < 0.45);
    // Text stays readable as long as it can be; only far, far out do cards show their titles.
    stage.classList.toggle("is-tiny", view.zoom < 0.16);
    const zoomLabel = document.querySelector("[data-action='zoom-reset']");
    if (zoomLabel) zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
    try {
      sessionStorage.setItem(`canvas-view:${key}`, JSON.stringify(view));
    } catch {
      // No storage here (a preview): the view just isn't remembered.
    }
  }
  function restoreView() {
    try {
      const v = JSON.parse(sessionStorage.getItem(`canvas-view:${key}`) ?? "null");
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.zoom)) {
        view = v;
        applyView();
        return true;
      }
    } catch {
      // Not remembered.
    }
    return false;
  }
  const toWorld = (cx, cy) => {
    const r = stage.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.zoom, y: (cy - r.top - view.y) / view.zoom };
  };
  function zoomAt(cx, cy, zoom) {
    const r = stage.getBoundingClientRect();
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    const px = cx - r.left;
    const py = cy - r.top;
    view.x = px - ((px - view.x) / view.zoom) * z;
    view.y = py - ((py - view.y) / view.zoom) * z;
    view.zoom = z;
    applyView();
  }
  function boundsOf(nodes) {
    if (!nodes.length) return null;
    const x = Math.min(...nodes.map((n) => n.x));
    const y = Math.min(...nodes.map((n) => n.y));
    return {
      x,
      y,
      width: Math.max(...nodes.map((n) => n.x + n.width)) - x,
      height: Math.max(...nodes.map((n) => n.y + n.height)) - y,
    };
  }
  function fit(nodes, maxZoom = 1) {
    const r = stage.getBoundingClientRect();
    const b = boundsOf(nodes);
    if (!b || !r.width) {
      view = { x: r.width / 2, y: r.height / 2, zoom: 1 };
      applyView();
      return;
    }
    const pad = 60;
    const zoom = Math.min(
      maxZoom,
      Math.max(
        MIN_ZOOM,
        Math.min((r.width - pad * 2) / b.width, (r.height - pad * 2 - 50) / b.height),
      ),
    );
    view = {
      zoom,
      x: r.width / 2 - (b.x + b.width / 2) * zoom,
      y: (r.height - 50) / 2 - (b.y + b.height / 2) * zoom,
    };
    applyView();
  }
  /** Shows these cards: zooms out to them only when they aren't all in view. */
  function reveal(ids) {
    const nodes = ids.map(byId).filter(Boolean);
    if (!nodes.length) return;
    const r = stage.getBoundingClientRect();
    const b = boundsOf(nodes);
    const left = b.x * view.zoom + view.x;
    const top = b.y * view.zoom + view.y;
    const inView =
      left >= 0 &&
      top >= 0 &&
      left + b.width * view.zoom <= r.width &&
      top + b.height * view.zoom <= r.height - 50;
    if (!inView) fit(nodes, Math.max(view.zoom, 0.5) > 1 ? 1 : Math.max(view.zoom, 0.6));
  }
  function flash(ids) {
    for (const id of ids) {
      const el = nodeEls.get(id);
      if (!el) continue;
      el.classList.remove("is-flash");
      void el.offsetWidth;
      el.classList.add("is-flash");
    }
    for (const id of ids) {
      const path = svg.querySelector(`[data-edge="${CSS.escape(id)}"]`);
      if (path) {
        path.classList.remove("is-flash");
        void path.getBBox();
        path.classList.add("is-flash");
      }
    }
  }

  // ---- Rendering ----------------------------------------------------------------------------------
  const colorVar = (c) =>
    !c ? "" : /^[1-6]$/.test(c) ? `var(--label-${c})` : /^#[0-9a-f]{3,8}$/i.test(c) ? c : "";
  const fileName = (p) => String(p).split("/").pop();
  /** A Markdown file narrowed to a heading ("#Setup"): that heading and what's under it. */
  function section(text, subpath) {
    if (!subpath?.startsWith("#") || subpath.startsWith("#^")) return text;
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
  const host = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };

  function nodeContent(n, el) {
    // What the card shows depends on (not the preview's text or image itself: an image is big).
    const p = n.file ? previews.get(n.file) : n.background ? previews.get(n.background) : undefined;
    const previewState =
      p === undefined ? "" : typeof p === "string" ? p : `${p.version}:${p.error ?? ""}`;
    const sig = JSON.stringify([
      n.background,
      n.backgroundStyle,
      n.subpath,
      n.type,
      n.text,
      n.file,
      n.url,
      n.label,
      previewState,
      prefs.imagePreview,
      prefs.embedPages,
      n.embed,
      cards?.mdState(n) ?? "",
    ]);
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    const body = el.querySelector(".node-body");
    if (n.type === "text") {
      // Styled by the IDE's Markdown preview rules (D187).
      body.innerHTML = `<div class="md md-document ide-md card-md">${md.render(n.text ?? "") || '<p class="placeholder">Empty card</p>'}</div>`;
      cards?.markDraggable(body, n);
    } else if (n.type === "file" && typeof n.file !== "string")
      body.textContent = "(a file card without a file)";
    else if (n.type === "file") {
      const image = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(n.file ?? "");
      const p = previews.get(n.file);
      if (!p) {
        previews.set(n.file, "loading");
        post({ type: "preview", path: file?.path, file: n.file });
      }
      const ready = p && p !== "loading" ? p : null;
      body.innerHTML = "";
      const head = document.createElement("div");
      head.className = "file-head";
      // The file icon theme's icon (markup the IDE built and sanitized), else ours.
      const glyph = document.createElement("span");
      glyph.className = "file-icon";
      glyph.innerHTML = ready?.icon ?? (image ? ICONS.image : ICONS.file);
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = fileName(n.file) + (n.subpath ?? "");
      const where = document.createElement("span");
      where.className = "file-path";
      // The folder, when there is one (the name is already shown).
      where.textContent = n.file.includes("/") ? n.file.slice(0, n.file.lastIndexOf("/")) : "";
      head.append(glyph, name, where);
      body.append(head);
      const message = (text) => {
        const note = document.createElement("div");
        note.className = "file-note";
        note.textContent = text;
        body.append(note);
      };
      if (!ready) message("Loading…");
      else if (ready.error)
        message(
          /showImages/.test(ready.error)
            ? "Image previews are off (canvas.showImages). Double-click to open it."
            : `Couldn't show it: ${ready.error}`,
        );
      else if (ready.image) {
        const img = document.createElement("img");
        img.className = "file-image";
        img.alt = fileName(n.file);
        img.draggable = false;
        img.src = ready.image;
        body.append(img);
      } else if (typeof ready.markdown === "string") {
        const doc = document.createElement("div");
        doc.className = "file-markdown md md-document ide-md card-md";
        const fallback = md.render(section(ready.markdown, n.subpath));
        if (cards) cards.markdownInto(doc, n, fallback);
        else doc.innerHTML = fallback || '<p class="placeholder">Empty note</p>';
        body.append(doc);
      } else if (ready.summary) {
        const sum = document.createElement("div");
        sum.className = "file-summary";
        const line = document.createElement("div");
        line.className = "file-note";
        line.textContent = `A canvas: ${ready.summary.cards} cards, ${ready.summary.arrows} arrows. Double-click to open it.`;
        const list = document.createElement("ul");
        for (const t of ready.summary.titles) {
          const li = document.createElement("li");
          li.textContent = t;
          list.append(li);
        }
        sum.append(line, list);
        body.append(sum);
      } else if (typeof ready.html === "string") {
        const pre = document.createElement("pre");
        pre.className = "file-preview is-code";
        // Spans with inline colors only (built and escaped by the IDE: editor.renderFile).
        pre.innerHTML = ready.html;
        body.append(pre);
        if (ready.totalLines > ready.lines) message(`${ready.lines} of ${ready.totalLines} lines`);
      } else message(ready.note ?? "Double-click to open it.");
    } else if (n.type === "link") {
      if (cards) cards.linkInto(body, n, host);
      else body.textContent = n.url ?? "";
    } else if (n.type === "group") {
      body.innerHTML = "";
      const label = el.querySelector(".group-label");
      label.textContent = n.label ?? "";
      label.hidden = !n.label;
      // A background image (JSON Canvas: background, backgroundStyle cover | ratio | repeat).
      if (n.background) {
        const p = previews.get(n.background);
        if (!p) {
          previews.set(n.background, "loading");
          post({ type: "preview", path: file?.path, file: n.background });
        }
        const image = p && p !== "loading" ? p.image : null;
        body.classList.add("has-background");
        body.style.backgroundImage = image ? `url("${image}")` : "";
        const style = n.backgroundStyle ?? "cover";
        body.style.backgroundSize =
          style === "cover" ? "cover" : style === "ratio" ? "contain" : "auto";
        body.style.backgroundRepeat = style === "repeat" ? "repeat" : "no-repeat";
        body.style.backgroundPosition = "center";
      } else {
        body.classList.remove("has-background");
        body.style.backgroundImage = "";
      }
    } else body.textContent = `(${n.type} card)`;
  }

  function nodeElement(n) {
    let el = nodeEls.get(n.id);
    if (!el) {
      el = document.createElement("div");
      el.dataset.id = n.id;
      el.innerHTML = `<div class="group-label" hidden></div><div class="node-body"></div>${["n", "e", "s", "w", "se"].map((d) => `<div class="resize" data-dir="${d}"></div>`).join("")}${["top", "right", "bottom", "left"].map((s) => `<div class="handle" data-side="${s}" title="Drag to draw an arrow"></div>`).join("")}`;
      nodeEls.set(n.id, el);
    }
    el.className = `node is-${n.type}${selected.has(n.id) ? " is-selected" : ""}${n.color ? " has-color" : ""}${el.classList.contains("is-flash") ? " is-flash" : ""}${editing?.id === n.id ? " is-editing" : ""}`;
    el.style.left = `${n.x}px`;
    el.style.top = `${n.y}px`;
    el.style.width = `${n.width}px`;
    el.style.height = `${n.height}px`;
    el.style.setProperty("--c", colorVar(n.color) || "var(--fg-muted)");
    if (editing?.id !== n.id) nodeContent(n, el);
    return el;
  }

  function render() {
    // Cards that went are taken out first: the ordering below then never has to move the card
    // being typed in (moving it would blur it).
    const live = new Set(doc.nodes.map((n) => n.id));
    for (const [id, el] of nodeEls)
      if (!live.has(id)) {
        el.remove();
        nodeEls.delete(id);
      }
    // Groups under the arrows, cards over them, in the file's order.
    const groups = doc.nodes.filter((n) => n.type === "group");
    const cards = doc.nodes.filter((n) => n.type !== "group");
    const desired = [...groups.map(nodeElement), svg, ...cards.map(nodeElement)];
    let ref = world.firstChild;
    for (const el of desired) {
      if (el === ref) {
        ref = ref.nextSibling;
        continue;
      }
      world.insertBefore(el, ref);
    }
    renderEdges();
    afterRender?.();
    emptyEl.hidden = doc.nodes.length > 0 || broken;
    renderSelectionBar();
  }

  /** Alignment guides while dragging (snap to objects). */
  function drawGuides(guides) {
    for (const old of svg.querySelectorAll(".guide")) old.remove();
    for (const gd of guides) {
      const line = document.createElementNS(SVG, "line");
      line.setAttribute("x1", String(gd.x1));
      line.setAttribute("y1", String(gd.y1));
      line.setAttribute("x2", String(gd.x2));
      line.setAttribute("y2", String(gd.y2));
      line.setAttribute("class", "guide");
      svg.append(line);
    }
  }
  function anchor(n, side) {
    switch (side) {
      case "top":
        return { x: n.x + n.width / 2, y: n.y, dx: 0, dy: -1 };
      case "bottom":
        return { x: n.x + n.width / 2, y: n.y + n.height, dx: 0, dy: 1 };
      case "left":
        return { x: n.x, y: n.y + n.height / 2, dx: -1, dy: 0 };
      default:
        return { x: n.x + n.width, y: n.y + n.height / 2, dx: 1, dy: 0 };
    }
  }
  function autoSides(a, b) {
    const dx = b.x + b.width / 2 - (a.x + a.width / 2);
    const dy = b.y + b.height / 2 - (a.y + a.height / 2);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
    return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
  }
  /** The curve between two anchors, and its middle (for the label). */
  function curve(p, q) {
    if (prefs.arrows === "straight")
      return {
        d: `M${p.x},${p.y} L${q.x},${q.y}`,
        mid: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 },
        c1: q,
        c2: p,
      };
    if (prefs.arrows === "elbow") {
      // Out of the first card's side, across, into the second's: right angles only.
      const out = { x: p.x + p.dx * 24, y: p.y + p.dy * 24 };
      const into = { x: q.x + q.dx * 24, y: q.y + q.dy * 24 };
      const horizontal = p.dx !== 0;
      const bend = horizontal
        ? [
            { x: (out.x + into.x) / 2, y: out.y },
            { x: (out.x + into.x) / 2, y: into.y },
          ]
        : [
            { x: out.x, y: (out.y + into.y) / 2 },
            { x: into.x, y: (out.y + into.y) / 2 },
          ];
      const points = [p, out, ...bend, into, q];
      return {
        d: `M${points.map((pt) => `${pt.x},${pt.y}`).join(" L")}`,
        mid: { x: (bend[0].x + bend[1].x) / 2, y: (bend[0].y + bend[1].y) / 2 },
        c1: out,
        c2: into,
      };
    }
    const d = Math.max(40, Math.min(160, Math.hypot(q.x - p.x, q.y - p.y) / 2.5));
    const c1 = { x: p.x + p.dx * d, y: p.y + p.dy * d };
    const c2 = { x: q.x + q.dx * d, y: q.y + q.dy * d };
    const at = (t) => {
      const u = 1 - t;
      return {
        x: u * u * u * p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * q.x,
        y: u * u * u * p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * q.y,
      };
    };
    return {
      d: `M${p.x},${p.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${q.x},${q.y}`,
      mid: at(0.5),
      c1,
      c2,
    };
  }
  function arrowHead(tip, from) {
    const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
    const s = 10;
    const a = { x: tip.x - s * Math.cos(angle - 0.45), y: tip.y - s * Math.sin(angle - 0.45) };
    const b = { x: tip.x - s * Math.cos(angle + 0.45), y: tip.y - s * Math.sin(angle + 0.45) };
    return `M${tip.x},${tip.y} L${a.x},${a.y} L${b.x},${b.y} Z`;
  }

  function renderEdges() {
    svg.replaceChildren();
    const seen = new Set();
    for (const e of doc.edges) {
      const a = byId(e.fromNode);
      const b = byId(e.toNode);
      if (!a || !b) continue;
      const [fs, ts] = autoSides(a, b);
      const p = anchor(a, e.fromSide ?? fs);
      const q = anchor(b, e.toSide ?? ts);
      // Arrowheads end at the card's edge; the line stops short of the tip.
      const c = curve(p, q);
      const g = document.createElementNS(SVG, "g");
      g.setAttribute("data-edge", e.id);
      g.setAttribute(
        "class",
        `edge${selected.has(e.id) ? " is-selected" : ""}${e.color ? " has-color" : ""}`,
      );
      if (e.color) g.style.setProperty("--c", colorVar(e.color));
      const hit = document.createElementNS(SVG, "path");
      hit.setAttribute("d", c.d);
      hit.setAttribute("class", "edge-hit");
      const line = document.createElementNS(SVG, "path");
      line.setAttribute("d", c.d);
      line.setAttribute("class", "edge-line");
      g.append(hit, line);
      if (e.toEnd !== "none") {
        const head = document.createElementNS(SVG, "path");
        head.setAttribute("d", arrowHead(q, c.c2));
        head.setAttribute("class", "edge-head");
        g.append(head);
      }
      if (e.fromEnd === "arrow") {
        const head = document.createElementNS(SVG, "path");
        head.setAttribute("d", arrowHead(p, c.c1));
        head.setAttribute("class", "edge-head");
        g.append(head);
      }
      // A selected arrow's ends can be dragged (reconnect, or off a card to disconnect).
      if (selected.has(e.id) && !readOnly())
        for (const [end, pt] of [
          ["from", p],
          ["to", q],
        ]) {
          const dot = document.createElementNS(SVG, "circle");
          dot.setAttribute("cx", String(pt.x));
          dot.setAttribute("cy", String(pt.y));
          dot.setAttribute("r", "6");
          dot.setAttribute("class", "edge-end");
          dot.setAttribute("data-edge", e.id);
          dot.setAttribute("data-end", end);
          g.append(dot);
        }
      svg.append(g);
      if (e.label || editing?.edgeId === e.id) {
        let label = labelEls.get(e.id);
        if (!label) {
          label = document.createElement("div");
          label.className = "edge-label";
          label.dataset.edge = e.id;
          labelEls.set(e.id, label);
          world.append(label);
        }
        if (editing?.edgeId !== e.id) label.textContent = e.label ?? "";
        label.style.left = `${c.mid.x}px`;
        label.style.top = `${c.mid.y}px`;
        label.classList.toggle("is-selected", selected.has(e.id));
        seen.add(e.id);
      }
    }
    for (const [id, el] of labelEls)
      if (!seen.has(id)) {
        el.remove();
        labelEls.delete(id);
      }
  }

  // ---- Toolbars ---------------------------------------------------------------------------------
  const ICONS = {
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7M12 17h.01"/></svg>',
    export:
      '<svg viewBox="0 0 24 24"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>',
    align:
      '<svg viewBox="0 0 24 24"><path d="M4 3v18"/><rect x="7" y="6" width="12" height="4" rx="1"/><rect x="7" y="14" width="8" height="4" rx="1"/></svg>',
    image:
      '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg>',
    search:
      '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/></svg>',
    card: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 10h8M8 14h5"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1"/></svg>',
    group:
      '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" stroke-dasharray="3 2"/><rect x="7" y="9" width="5" height="4" rx="1"/><rect x="13" y="12" width="4" height="4" rx="1"/></svg>',
    arrange:
      '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="6" height="5" rx="1"/><rect x="15" y="3" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M9 6.5h3v12h3M12 5.5h3"/></svg>',
    undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg>',
    minus: '<svg viewBox="0 0 24 24"><path d="M6 12h12"/></svg>',
    plus: '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>',
    fit: '<svg viewBox="0 0 24 24"><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/></svg>',
    trash:
      '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    none: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/><path d="m7 17 10-10"/></svg>',
  };
  function button(action, icon, title, label) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.action = action;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.innerHTML = icon ? ICONS[icon] : "";
    if (label) b.append(label);
    return b;
  }
  function divider() {
    const d = document.createElement("span");
    d.className = "bar-divider";
    return d;
  }
  toolbar.append(
    button("add-card", "card", "Add a card (double-click the board)"),
    button("add-file", "file", "Add a file… (search the project)"),
    button("add-image", "image", "Add an image… (search the project's images)"),
    button("add-link", "link", "Add a link…"),
    button("add-group", "group", "Group the selected cards, or add a group"),
    button(
      "arrange",
      "arrange",
      "Arrange: along the arrows, or in a grid (the selection, or everything)",
    ),
    divider(),
    button("undo", "undo", "Undo (Ctrl+Z)"),
    button("redo", "redo", "Redo (Ctrl+Shift+Z)"),
    divider(),
    button("zoom-out", "minus", "Zoom out (Ctrl+wheel, -)"),
    button("zoom-reset", null, "Zoom to 100%", "100%"),
    button("zoom-in", "plus", "Zoom in (+)"),
    button("fit", "fit", "Fit everything (Shift+1)"),
    divider(),
    button("find", "search", "Find on the canvas (Ctrl+F)"),
    button("export", "export", "Export as an image…"),
    button("lock", "lock", "Read-only: look without changing anything"),
    button("help", "help", "Canvas help and shortcuts (?)"),
    button("settings", "gear", "Canvas settings"),
  );

  function renderSelectionBar() {
    const ids = [...selected];
    selectionBar.hidden = !ids.length || readOnly() || !!editing;
    if (selectionBar.hidden) return;
    const current = new Set(ids.map((id) => (byId(id) ?? edgeById(id))?.color ?? ""));
    selectionBar.replaceChildren();
    const none = button("color", "none", "No color");
    none.dataset.color = "";
    selectionBar.append(none);
    ["red", "orange", "yellow", "green", "cyan", "purple"].forEach((name, i) => {
      const b = button("color", null, name[0].toUpperCase() + name.slice(1));
      b.dataset.color = String(i + 1);
      b.classList.add("swatch");
      b.style.setProperty("--c", `var(--label-${i + 1})`);
      if (current.size === 1 && current.has(String(i + 1))) b.classList.add("is-on");
      selectionBar.append(b);
    });
    selectionBar.append(divider());
    if (ids.filter(byId).length > 1)
      selectionBar.append(button("add-group", "group", "Group these"));
    if (ids.filter(byId).length > 1) selectionBar.append(button("align", "align", "Align…"));
    selectionBar.append(button("delete", "trash", "Delete (Del)"));
  }

  /** `at`: where on the board (a context menu's point); otherwise the middle of the view. */
  function onAction(action, el, at) {
    const center = () => {
      if (at) return at;
      const r = stage.getBoundingClientRect();
      return toWorld(r.left + r.width / 2, r.top + r.height / 2 - 30);
    };
    switch (action) {
      case "add-card": {
        const at = center();
        addCard(at.x - 130, at.y - 30, true);
        return;
      }
      case "add-file":
      case "add-image":
      case "add-link":
        if (readOnly()) return;
        post({
          type: "ask",
          path: file.path,
          kind: action === "add-file" ? "file" : action === "add-image" ? "image" : "link",
          at: center(),
        });
        return;
      case "find":
        menus.openFind();
        return;
      case "settings":
        post({ type: "settings" });
        return;
      case "lock":
        // Typing is finished and saved before the lock (it stops edits, not saves).
        if (!locked && editing) stopEditing(true);
        if (saveTimer) saveNow();
        locked = !locked;
        toolbar.querySelector("[data-action='lock']")?.classList.toggle("is-on", locked);
        document.body.classList.toggle("is-locked", locked);
        render();
        return;
      case "help":
        menus.showHelp();
        return;
      case "align":
        menus.openAlignMenu(el);
        return;
      case "export":
        exporter.open();
        return;
      case "add-group":
        groupSelection(at);
        return;
      case "arrange":
        arrange();
        return;
      case "undo":
        restore(undoStack, redoStack);
        return;
      case "redo":
        restore(redoStack, undoStack);
        return;
      case "zoom-in":
      case "zoom-out": {
        const r = stage.getBoundingClientRect();
        zoomAt(
          r.left + r.width / 2,
          r.top + r.height / 2,
          view.zoom * (action === "zoom-in" ? 1.25 : 0.8),
        );
        return;
      }
      case "zoom-reset": {
        const r = stage.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1);
        return;
      }
      case "fit":
        fit(doc.nodes);
        return;
      case "color": {
        if (readOnly()) return;
        checkpoint();
        const color = el.dataset.color;
        for (const id of selected) {
          const item = byId(id) ?? edgeById(id);
          if (!item) continue;
          if (color) item.color = color;
          else delete item.color;
        }
        changed([...selected]);
        return;
      }
      case "delete":
        removeSelection();
        return;
    }
  }
  for (const bar of [toolbar, selectionBar])
    bar.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-action]");
      if (b) onAction(b.dataset.action, b);
    });
  for (const bar of [toolbar, selectionBar])
    bar.addEventListener("pointerdown", (e) => e.stopPropagation());

  // ---- Editing operations ---------------------------------------------------------------------
  function select(ids, add = false) {
    if (!add) selected.clear();
    for (const id of ids) selected.add(id);
    render();
    clearTimeout(select.timer);
    select.timer = setTimeout(
      () => post({ type: "selection", path: file?.path, ids: [...selected] }),
      150,
    );
  }
  function addCard(x, y, edit, text = "") {
    if (readOnly()) return null;
    const step = checkpoint();
    const n = {
      id: newId(),
      type: "text",
      text,
      x: snap(x),
      y: snap(y),
      width: prefs.cardWidth,
      height: 80,
    };
    doc.nodes.push(n);
    selected.clear();
    selected.add(n.id);
    changed([n.id]);
    if (edit) startEditing(n.id, true, step);
    return n;
  }
  function addFromAnswer(kind, value, at) {
    if (readOnly()) return;
    checkpoint();
    const n =
      kind === "file"
        ? {
            id: newId(),
            type: "file",
            file: value,
            x: snap(at.x - 200),
            y: snap(at.y - 130),
            width: 400,
            height: 260,
          }
        : {
            id: newId(),
            type: "link",
            url: /^https?:\/\//i.test(value) ? value : `https://${value}`,
            x: snap(at.x - 170),
            y: snap(at.y - 50),
            width: 340,
            height: 100,
          };
    // A page shown in the card gets room for it (D187).
    if (n.type === "link" && prefs.embedPages && cards?.embedUrl(n.url)) {
      n.width = 560;
      n.height = 400;
    }
    doc.nodes.push(n);
    select([n.id]);
    changed([n.id]);
  }
  function removeSelection() {
    if (readOnly() || !selected.size) return;
    checkpoint();
    const gone = [];
    for (const id of selected) {
      if (byId(id)) {
        doc.nodes = doc.nodes.filter((n) => n.id !== id);
        gone.push(id);
        for (const e of doc.edges) if (e.fromNode === id || e.toNode === id) gone.push(e.id);
        doc.edges = doc.edges.filter((e) => e.fromNode !== id && e.toNode !== id);
      } else if (edgeById(id)) {
        doc.edges = doc.edges.filter((e) => e.id !== id);
        gone.push(id);
      }
    }
    selected.clear();
    changed([], gone);
  }
  function groupSelection(at) {
    if (readOnly()) return;
    const members = at ? [] : [...selected].map(byId).filter((n) => n && n.type !== "group");
    checkpoint();
    let g;
    if (members.length) {
      const b = boundsOf(members);
      g = {
        id: newId(),
        type: "group",
        label: "Group",
        x: snap(b.x - 40),
        y: snap(b.y - 60),
        width: snap(b.width + 80),
        height: snap(b.height + 100),
      };
    } else {
      const r = stage.getBoundingClientRect();
      const c = at ?? toWorld(r.left + r.width / 2, r.top + r.height / 2);
      g = {
        id: newId(),
        type: "group",
        label: "Group",
        x: snap(c.x - 200),
        y: snap(c.y - 150),
        width: 400,
        height: 300,
      };
    }
    doc.nodes.unshift(g);
    select([g.id]);
    changed([g.id]);
    startEditing(g.id);
  }
  /** Tree along the arrows when the cards have any, else a grid (selection, or everything). */
  function arrange() {
    if (readOnly()) return;
    const ids = [...selected].filter((id) => byId(id) && byId(id).type !== "group");
    const nodes = ids.length > 1 ? ids.map(byId) : doc.nodes.filter((n) => n.type !== "group");
    if (nodes.length < 2) return;
    checkpoint();
    const set = new Set(nodes.map((n) => n.id));
    const edges = doc.edges.filter((e) => set.has(e.fromNode) && set.has(e.toNode));
    const origin = boundsOf(nodes);
    if (edges.length) {
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
      const heights = columns.map((c) => (c ?? []).reduce((h, n) => h + n.height + 40, -40));
      const tallest = Math.max(...heights);
      const rowOf = new Map();
      let x = origin.x;
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
          y += n.height + 40;
        });
        x += Math.max(...column.map((n) => n.width)) + 120;
      });
    } else {
      const cols = Math.ceil(Math.sqrt(nodes.length));
      const cellW = Math.max(...nodes.map((n) => n.width)) + 40;
      let y = origin.y;
      for (let r = 0; r * cols < nodes.length; r++) {
        const row = nodes.slice(r * cols, r * cols + cols);
        row.forEach((n, i) => {
          n.x = snap(origin.x + i * cellW);
          n.y = snap(y);
        });
        y += Math.max(...row.map((n) => n.height)) + 40;
      }
    }
    changed(nodes.map((n) => n.id));
  }

  /** `step`: a new card's undo step, dropped again if the card is left empty. */
  function startEditing(id, fresh = false, step = null) {
    if (readOnly()) return;
    const n = byId(id);
    const el = nodeEls.get(id);
    if (!n || !el) return;
    stopEditing(true);
    if (n.type === "group") {
      const input = document.createElement("input");
      input.className = "group-input";
      input.value = n.label ?? "";
      input.placeholder = "Group name";
      el.append(input);
      editing = { groupId: id, input };
      input.focus();
      input.select();
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" || e.key === "Escape") stopEditing(e.key === "Enter");
      });
      input.addEventListener("blur", () => stopEditing(true));
      renderSelectionBar();
      return;
    }
    if (n.type !== "text") return;
    const textarea = document.createElement("textarea");
    textarea.className = "node-editor";
    textarea.value = n.text ?? "";
    textarea.spellcheck = true;
    el.querySelector(".node-body").replaceChildren(textarea);
    editing = { id, textarea, fresh, step, before: n.text ?? "" };
    el.classList.add("is-editing");
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    const grow = () => {
      // Looked up each time: the file may have changed (and `doc` with it) while typing.
      const card = byId(id);
      const need = snap(textarea.scrollHeight + 24);
      if (card && need > card.height) {
        card.height = need;
        el.style.height = `${card.height}px`;
        renderEdges();
      }
    };
    textarea.addEventListener("input", grow);
    textarea.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        stopEditing(true);
      }
    });
    textarea.addEventListener("blur", () => stopEditing(true));
    renderSelectionBar();
  }
  function stopEditing(commit) {
    const e = editing;
    if (!e) return;
    editing = null;
    if (e.groupId) {
      const g = byId(e.groupId);
      e.input.remove();
      if (g && commit && e.input.value.trim() !== (g.label ?? "")) {
        checkpoint();
        g.label = e.input.value.trim();
        if (!g.label) delete g.label;
        nodeEls.get(g.id).dataset.sig = "";
        changed([g.id]);
      } else render();
      return;
    }
    if (e.edgeId) {
      const edge = edgeById(e.edgeId);
      const value = e.input.value.trim();
      e.input.remove();
      if (edge && commit && value !== (edge.label ?? "")) {
        checkpoint();
        if (value) edge.label = value;
        else delete edge.label;
        changed([edge.id]);
      } else render();
      return;
    }
    const n = byId(e.id);
    const el = nodeEls.get(e.id);
    if (el) {
      el.classList.remove("is-editing");
      el.dataset.sig = "";
    }
    if (!n) return render();
    const text = e.textarea.value;
    if (commit && e.fresh && !text.trim()) {
      // A new card left empty goes away (and so does its undo step).
      doc.nodes = doc.nodes.filter((x) => x.id !== n.id);
      doc.edges = doc.edges.filter((x) => x.fromNode !== n.id && x.toNode !== n.id);
      const at = undoStack.lastIndexOf(e.step);
      if (at >= 0) undoStack.splice(at, 1);
      selected.delete(n.id);
      changed([], [n.id]);
      return;
    }
    if (commit && text !== e.before) {
      // The step was taken when editing started (fresh) or is taken now.
      if (!e.fresh) {
        const after = n.text;
        n.text = e.before;
        checkpoint();
        n.text = after;
      }
      n.text = text;
      // Typing is saved at once: the tab may be closing (its page goes before a timer fires).
      changed([n.id], [], true);
    } else render();
  }
  function editEdgeLabel(id) {
    if (readOnly()) return;
    const edge = edgeById(id);
    if (!edge) return;
    stopEditing(true);
    editing = { edgeId: id, input: document.createElement("input") };
    renderEdges();
    const label = labelEls.get(id);
    const input = editing.input;
    input.className = "edge-input";
    input.value = edge.label ?? "";
    input.placeholder = "Label";
    label.replaceChildren(input);
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" || e.key === "Escape") stopEditing(e.key === "Enter");
    });
    input.addEventListener("blur", () => stopEditing(true));
  }

  // ---- Pointer ------------------------------------------------------------------------------------
  let gesture = null;
  const insideGroup = (g) =>
    doc.nodes.filter(
      (n) =>
        n !== g &&
        n.x >= g.x &&
        n.y >= g.y &&
        n.x + n.width <= g.x + g.width &&
        n.y + n.height <= g.y + g.height,
    );

  stage.addEventListener("pointerdown", (e) => {
    if (e.target.closest("textarea, input")) return;
    // A card's scrollbar, a link / image / heading or selected text being dragged out (D187),
    // and a web page in use: the browser's own handling.
    if (cards?.onScrollbar(e) || cards?.startsNativeDrag(e)) return;
    if (e.target.closest(".node.is-selected .web-frame")) return;
    // The press is kept from moving focus (it would select text): finish typing by hand.
    if (editing) stopEditing(true);
    window.focus();
    const at = toWorld(e.clientX, e.clientY);
    const panning = e.button === 1 || (e.button === 0 && spaceDown);
    if (panning) {
      gesture = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    } else if (e.button !== 0) {
      return;
    } else {
      const handle = e.target.closest(".handle");
      const resize = e.target.closest(".resize");
      let nodeEl = e.target.closest(".node");
      // Inside a group, the empty area is board: you select a group by its name (or a box
      // around it).
      if (
        nodeEl?.classList.contains("is-group") &&
        !handle &&
        !resize &&
        !e.target.closest(".group-label")
      )
        nodeEl = null;
      const edgeEl = e.target.closest("[data-edge]");
      const end = e.target.closest(".edge-end");
      if (end && !readOnly()) {
        // An arrow's end dragged onto another card reconnects it; onto empty space, removes it.
        const edge = edgeById(end.dataset.edge);
        if (edge) gesture = { kind: "reconnect", edge, end: end.dataset.end, sx: at.x, sy: at.y };
      } else if (handle && !readOnly()) {
        const from = byId(nodeEl.dataset.id);
        gesture = { kind: "connect", from, side: handle.dataset.side, at };
      } else if (resize && !readOnly()) {
        const n = byId(nodeEl.dataset.id);
        checkpoint();
        gesture = {
          kind: "resize",
          n,
          dir: resize.dataset.dir || "se",
          start: { x: n.x, y: n.y, width: n.width, height: n.height },
          sx: at.x,
          sy: at.y,
          moved: false,
        };
      } else if (nodeEl) {
        const id = nodeEl.dataset.id;
        // A ticked box in a task list ticks, without starting a drag.
        if (e.target.matches("input[type=checkbox]")) {
          e.preventDefault();
          const n = byId(id);
          if (readOnly() || !n) return;
          checkpoint();
          n.text = md.toggleTask(n.text, Number(e.target.dataset.line));
          nodeEls.get(id).dataset.sig = "";
          changed([id]);
          return;
        }
        const link = e.target.closest(".md-link");
        if (link && (e.ctrlKey || e.metaKey)) {
          post({ type: "openLink", url: link.dataset.url });
          return;
        }
        // Shift / Ctrl on a selected card takes it out only if the press ends without a drag
        // (a Shift-drag moves it along one axis).
        let toggleOff = null;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          if (selected.has(id)) toggleOff = id;
          else select([...selected, id]);
        } else if (!selected.has(id)) select([id]);
        if (readOnly()) {
          if (toggleOff) {
            selected.delete(toggleOff);
            select([...selected]);
          }
          return;
        }
        const moving = new Map();
        for (const sid of selected) {
          const n = byId(sid);
          if (!n) continue;
          moving.set(n, { x: n.x, y: n.y });
          if (n.type === "group") for (const m of insideGroup(n)) moving.set(m, { x: m.x, y: m.y });
        }
        gesture = {
          kind: "move",
          moving,
          sx: at.x,
          sy: at.y,
          moved: false,
          toggleOff,
          // Alt-drag moves copies, leaving the originals (made once the drag starts).
          copy: e.altKey,
        };
      } else if (edgeEl) {
        const id = edgeEl.dataset.edge;
        if (e.shiftKey) {
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          select([...selected]);
        } else select([id]);
        return;
      } else {
        gesture = {
          kind: "marquee",
          sx: at.x,
          sy: at.y,
          add: e.shiftKey,
          base: e.shiftKey ? new Set(selected) : new Set(),
        };
        if (!e.shiftKey) select([]);
      }
    }
    stage.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  stage.addEventListener("pointermove", (e) => {
    if (!gesture) return;
    const at = toWorld(e.clientX, e.clientY);
    switch (gesture.kind) {
      case "pan":
        view.x = gesture.vx + e.clientX - gesture.sx;
        view.y = gesture.vy + e.clientY - gesture.sy;
        applyView();
        break;
      case "move": {
        let dx = at.x - gesture.sx;
        let dy = at.y - gesture.sy;
        if (!gesture.moved && Math.hypot(dx, dy) * view.zoom < 3) return;
        if (!gesture.moved) {
          if (gesture.copy) {
            // The selection, groups' contents and the arrows among them, copied in place; the
            // copies are what moves (duplicate takes the undo step).
            const nodes = new Set();
            for (const n of gesture.moving.keys()) nodes.add(n);
            duplicate([...nodes], 0, 0);
            gesture.moving = new Map(
              [...selected]
                .map(byId)
                .filter(Boolean)
                .map((n) => [n, { x: n.x, y: n.y }]),
            );
          } else checkpoint();
          gesture.toggleOff = null;
        }
        gesture.moved = true;
        // Shift: along one axis only.
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        // Space held: no snapping at all; otherwise to the grid, then to other cards' edges.
        const free = spaceDown;
        const place = (v) => (free ? Math.round(v) : snap(v));
        let guides = [];
        if (!free && prefs.snapObjects) {
          const moved = [...gesture.moving.entries()].map(([n, s0]) => ({
            x: s0.x + dx,
            y: s0.y + dy,
            width: n.width,
            height: n.height,
          }));
          const box = boundsOf(moved);
          const ids = new Set([...gesture.moving.keys()].map((n) => n.id));
          const others = doc.nodes.filter((n) => !ids.has(n.id) && n.type !== "group");
          const hit = geo.snapToObjects(box, others, 8 / view.zoom);
          if (hit.dx || hit.dy) {
            dx += hit.dx;
            dy += hit.dy;
            guides = hit.guides;
          }
          gesture.alignedX = hit.dx !== 0;
          gesture.alignedY = hit.dy !== 0;
        } else {
          gesture.alignedX = false;
          gesture.alignedY = false;
        }
        // Per axis: lined up with a card on one, on the grid on the other.
        for (const [n, start] of gesture.moving) {
          n.x = gesture.alignedX ? Math.round(start.x + dx) : place(start.x + dx);
          n.y = gesture.alignedY ? Math.round(start.y + dy) : place(start.y + dy);
          const el = nodeEls.get(n.id);
          if (el) {
            el.style.left = `${n.x}px`;
            el.style.top = `${n.y}px`;
          }
        }
        renderEdges();
        drawGuides(guides);
        break;
      }
      case "resize": {
        const n = gesture.n;
        // Every edge and the corner; Shift keeps the shape, Space turns snapping off.
        const r = geo.resize(
          gesture.start,
          gesture.dir,
          at.x - gesture.sx,
          at.y - gesture.sy,
          e.shiftKey,
          {
            width: GRID * 4,
            height: GRID * 2,
          },
        );
        const place = (v) => (spaceDown || e.shiftKey ? Math.round(v) : snap(v));
        const x2 = place(r.x + r.width);
        const y2 = place(r.y + r.height);
        n.x = gesture.dir.includes("w") ? place(r.x) : r.x;
        n.y = gesture.dir.includes("n") ? place(r.y) : r.y;
        n.width = Math.max(GRID * 4, (gesture.dir.includes("w") ? r.x + r.width : x2) - n.x);
        n.height = Math.max(GRID * 2, (gesture.dir.includes("n") ? r.y + r.height : y2) - n.y);
        gesture.moved = true;
        const el = nodeEls.get(n.id);
        el.style.left = `${n.x}px`;
        el.style.top = `${n.y}px`;
        el.style.width = `${n.width}px`;
        el.style.height = `${n.height}px`;
        renderEdges();
        break;
      }
      case "reconnect": {
        // A small wobble on the end is a click, not a drag (it would remove the arrow).
        if (!gesture.at && Math.hypot(at.x - gesture.sx, at.y - gesture.sy) * view.zoom < 6) break;
        renderEdges();
        const edge = gesture.edge;
        const fixed = byId(gesture.end === "to" ? edge.fromNode : edge.toNode);
        if (!fixed) break;
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".node");
        const to = target && target.dataset.id !== fixed.id ? byId(target.dataset.id) : null;
        const sides = to ? autoSides(fixed, to) : null;
        const p = anchor(
          fixed,
          sides
            ? sides[0]
            : autoSides(fixed, { ...fixed, x: at.x, y: at.y, width: 0, height: 0 })[0],
        );
        const q = to ? anchor(to, sides[1]) : { x: at.x, y: at.y, dx: -p.dx, dy: -p.dy };
        const c = curve(p, q);
        const g = document.createElementNS(SVG, "g");
        g.setAttribute("class", "edge is-drawing");
        const line = document.createElementNS(SVG, "path");
        line.setAttribute("d", c.d);
        line.setAttribute("class", "edge-line");
        g.append(line);
        svg.append(g);
        gesture.at = at;
        gesture.to = to;
        break;
      }
      case "connect": {
        renderEdges();
        const p = anchor(gesture.from, gesture.side);
        const target = document.elementFromPoint(e.clientX, e.clientY)?.closest(".node");
        const to = target && target.dataset.id !== gesture.from.id ? byId(target.dataset.id) : null;
        const q = to
          ? anchor(to, autoSides(gesture.from, to)[1])
          : { x: at.x, y: at.y, dx: -p.dx, dy: -p.dy };
        const c = curve(p, q);
        const g = document.createElementNS(SVG, "g");
        g.setAttribute("class", "edge is-drawing");
        const line = document.createElementNS(SVG, "path");
        line.setAttribute("d", c.d);
        line.setAttribute("class", "edge-line");
        const head = document.createElementNS(SVG, "path");
        head.setAttribute("d", arrowHead(q, c.c2));
        head.setAttribute("class", "edge-head");
        g.append(line, head);
        svg.append(g);
        gesture.at = at;
        gesture.to = to;
        break;
      }
      case "marquee": {
        const x = Math.min(gesture.sx, at.x);
        const y = Math.min(gesture.sy, at.y);
        const w = Math.abs(at.x - gesture.sx);
        const h = Math.abs(at.y - gesture.sy);
        marqueeEl.hidden = false;
        marqueeEl.style.left = `${x * view.zoom + view.x}px`;
        marqueeEl.style.top = `${y * view.zoom + view.y}px`;
        marqueeEl.style.width = `${w * view.zoom}px`;
        marqueeEl.style.height = `${h * view.zoom}px`;
        const hits = doc.nodes
          .filter((n) => n.x < x + w && x < n.x + n.width && n.y < y + h && y < n.y + n.height)
          // A group is taken only when the box covers it whole (it's usually what you start in).
          .filter(
            (n) =>
              n.type !== "group" ||
              (n.x >= x && n.y >= y && n.x + n.width <= x + w && n.y + n.height <= y + h),
          )
          .map((n) => n.id);
        selected.clear();
        for (const id of gesture.base) selected.add(id);
        for (const id of hits) selected.add(id);
        for (const [id, el] of nodeEls) el.classList.toggle("is-selected", selected.has(id));
        break;
      }
    }
  });

  function endGesture(e) {
    finishGesture(e);
    // A version of the file that came meanwhile.
    const held = heldFile;
    heldFile = null;
    if (held) receive(held);
  }
  function finishGesture(e) {
    const g = gesture;
    gesture = null;
    if (!g) return;
    marqueeEl.hidden = true;
    drawGuides([]);
    if (g.kind === "move" && g.moved) changed([...g.moving.keys()].map((n) => n.id));
    else if (g.kind === "move" && g.toggleOff) {
      selected.delete(g.toggleOff);
      select([...selected]);
    } else if (g.kind === "reconnect" && e) {
      if (!g.at) return renderEdges();
      checkpoint();
      const edge = edgeById(g.edge.id);
      if (!edge) return render();
      if (g.to) {
        // Onto a card: that end moves there (its side is worked out again).
        if (g.end === "to") {
          edge.toNode = g.to.id;
          delete edge.toSide;
        } else {
          edge.fromNode = g.to.id;
          delete edge.fromSide;
        }
        changed([edge.id]);
      } else {
        // Off any card: disconnected.
        doc.edges = doc.edges.filter((x) => x.id !== edge.id);
        selected.delete(edge.id);
        changed([], [edge.id]);
      }
    } else if (g.kind === "resize") {
      if (g.moved) changed([g.n.id]);
      else undoStack.pop();
    } else if (g.kind === "marquee") select([...selected]);
    else if (g.kind === "connect" && e) {
      const p = g.at;
      if (!p) return renderEdges();
      checkpoint();
      let to = g.to;
      const created = [];
      if (!to) {
        // Onto empty space: a new card there, connected, ready to type.
        to = {
          id: newId(),
          type: "text",
          text: "",
          width: prefs.cardWidth,
          height: 80,
          x: 0,
          y: 0,
        };
        const side = g.side;
        to.x = snap(side === "left" ? p.x - to.width : side === "right" ? p.x : p.x - to.width / 2);
        to.y = snap(
          side === "top" ? p.y - to.height : side === "bottom" ? p.y : p.y - to.height / 2,
        );
        doc.nodes.push(to);
        created.push(to.id);
      }
      const edge = { id: newId(), fromNode: g.from.id, fromSide: g.side, toNode: to.id };
      edge.toSide = autoSides(g.from, to)[1];
      doc.edges.push(edge);
      created.push(edge.id);
      select(created.length > 1 ? [to.id] : [edge.id]);
      changed(created);
      if (created.length > 1) startEditing(to.id, false);
    }
  }
  stage.addEventListener("pointerup", endGesture);
  // A drag the system took away (a touch turned into a scroll…): what moved stays moved and is
  // saved; a resize that didn't change anything leaves no undo step; no arrow is drawn.
  stage.addEventListener("pointercancel", () => {
    if (gesture?.kind === "connect") gesture = null;
    endGesture(null);
    render();
  });

  stage.addEventListener("dblclick", (e) => {
    if (e.target.closest("textarea, input")) return;
    const nodeEl = e.target.closest(".node");
    const edgeEl = e.target.closest("[data-edge]");
    if (nodeEl) {
      const n = byId(nodeEl.dataset.id);
      if (!n) return;
      if (n.type === "text") startEditing(n.id);
      else if (n.type === "file") post({ type: "openFile", file: n.file });
      else if (n.type === "link") post({ type: "openLink", url: n.url });
      else if (n.type === "group" && e.target.closest(".group-label")) startEditing(n.id);
      if (n.type !== "group") return;
    }
    if (edgeEl) {
      editEdgeLabel(edgeEl.dataset.edge);
      return;
    }
    if (e.target.closest(".group-label")) return;
    const at = toWorld(e.clientX, e.clientY);
    addCard(at.x - 130, at.y - 40, true);
  });

  stage.addEventListener(
    "wheel",
    (e) => {
      if (e.target.closest("textarea")) return;
      // A card's own scrolling content scrolls while it can.
      // Any card's, selected or not (D187): its scrollbar shows whenever it overflows.
      const scroller = e.target.closest(
        ".file-preview, .file-markdown, .node.is-text .node-body, .md-pre pre, .md-table-wrap",
      );
      if (!e.ctrlKey && !e.metaKey && scroller) {
        const across = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
        const delta = across ? e.deltaX || e.deltaY : e.deltaY;
        const canScroll = across
          ? delta > 0
            ? scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1
            : scroller.scrollLeft > 0
          : delta > 0
            ? scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1
            : scroller.scrollTop > 0;
        if (canScroll) return;
      }
      e.preventDefault();
      if (e.ctrlKey || e.metaKey)
        zoomAt(
          e.clientX,
          e.clientY,
          view.zoom * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)),
        );
      else {
        const k = e.deltaMode === 1 ? 20 : 1;
        view.x -= (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * k;
        view.y -= (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * k;
        applyView();
      }
    },
    { passive: false },
  );

  // ---- Keyboard and clipboard -------------------------------------------------------------------
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("textarea, input")) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (e.key === " " && !spaceDown) {
      spaceDown = true;
      stage.classList.add("is-panning");
      e.preventDefault();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
      e.preventDefault();
      removeSelection();
    } else if (mod && k === "z") {
      e.preventDefault();
      if (e.shiftKey) restore(redoStack, undoStack);
      else restore(undoStack, redoStack);
    } else if (mod && k === "y") {
      e.preventDefault();
      restore(redoStack, undoStack);
    } else if (mod && k === "a") {
      e.preventDefault();
      select(doc.nodes.map((n) => n.id));
    } else if (mod && k === "d" && selected.size && !readOnly()) {
      e.preventDefault();
      duplicate([...selected].map(byId).filter(Boolean), 40, 40);
    } else if (mod && k === "f") {
      e.preventDefault();
      menus.openFind();
    } else if (e.key === "F2" && selected.size === 1) {
      e.preventDefault();
      const id = [...selected][0];
      if (edgeById(id)) editEdgeLabel(id);
      else startEditing(id);
    } else if (mod && k === "g") {
      e.preventDefault();
      groupSelection();
    } else if (e.key === "Escape") {
      select([]);
    } else if (e.key === "Enter" && selected.size === 1) {
      e.preventDefault();
      const id = [...selected][0];
      if (edgeById(id)) editEdgeLabel(id);
      else startEditing(id);
    } else if (e.key === "!" || (e.shiftKey && e.code === "Digit1")) {
      fit(doc.nodes);
    } else if (e.key === "@" || (e.shiftKey && e.code === "Digit2")) {
      // Zoom to the selection (everything when nothing is selected).
      const nodes = [...selected].map(byId).filter(Boolean);
      fit(nodes.length ? nodes : doc.nodes, 2);
    } else if (e.key === "?" && !mod) {
      menus.showHelp();
    } else if (!mod && (e.key === "+" || e.key === "=")) onAction("zoom-in");
    else if (!mod && e.key === "-") onAction("zoom-out");
    else if (mod && e.key === "0") {
      e.preventDefault();
      onAction("zoom-reset");
    } else if (e.key.startsWith("Arrow") && selected.size && !readOnly()) {
      e.preventDefault();
      const step = e.shiftKey ? GRID * 5 : GRID;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      checkpoint();
      const ids = [];
      for (const id of selected) {
        const n = byId(id);
        if (!n) continue;
        n.x += dx;
        n.y += dy;
        ids.push(id);
      }
      changed(ids);
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.key === " ") {
      spaceDown = false;
      stage.classList.remove("is-panning");
    }
  });
  addEventListener("blur", () => {
    spaceDown = false;
    stage.classList.remove("is-panning");
    // Focus leaving the page comes before its tab closes or moves: save what's pending now.
    if (saveTimer) saveNow();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && saveTimer) saveNow();
  });

  function duplicate(nodes, dx, dy, edgesToo = doc.edges) {
    if (!nodes.length || readOnly()) return;
    checkpoint();
    const map = new Map();
    for (const n of nodes) {
      const copy = { ...n, id: newId(), x: snap(n.x + dx), y: snap(n.y + dy) };
      map.set(n.id, copy.id);
      if (copy.type === "group") doc.nodes.unshift(copy);
      else doc.nodes.push(copy);
    }
    const edges = edgesToo
      .filter((e) => map.has(e.fromNode) && map.has(e.toNode))
      .map((e) => ({
        ...e,
        id: newId(),
        fromNode: map.get(e.fromNode),
        toNode: map.get(e.toNode),
      }));
    doc.edges.push(...edges);
    select([...map.values()]);
    changed([...map.values(), ...edges.map((e) => e.id)]);
  }

  const CLIP = "application/x-canvas-cards";
  document.addEventListener("copy", (e) => copy(e, false));
  document.addEventListener("cut", (e) => copy(e, true));
  function copy(e, cut) {
    if (e.target.closest?.("textarea, input") || !selected.size) return;
    const nodes = [...selected].map(byId).filter(Boolean);
    if (!nodes.length) return;
    const ids = new Set(nodes.map((n) => n.id));
    const payload = JSON.stringify({
      nodes,
      edges: doc.edges.filter((x) => ids.has(x.fromNode) && ids.has(x.toNode)),
    });
    e.clipboardData.setData(CLIP, payload);
    menus.setClip(JSON.parse(payload));
    // Elsewhere, the cards' text.
    e.clipboardData.setData(
      "text/plain",
      nodes.map((n) => n.text ?? n.file ?? n.url ?? n.label ?? "").join("\n\n"),
    );
    e.preventDefault();
    if (cut) removeSelection();
  }
  document.addEventListener("paste", (e) => {
    if (e.target.closest?.("textarea, input") || readOnly()) return;
    e.preventDefault();
    // A pasted image (a screenshot…) is saved beside the canvas and shown on a card.
    const image = [...(e.clipboardData.files ?? [])].find((f) => f.type.startsWith("image/"));
    if (image && image.size < 16 * 1024 * 1024) {
      const r = stage.getBoundingClientRect();
      const at = toWorld(r.left + r.width / 2, r.top + r.height / 2);
      const reader = new FileReader();
      reader.onload = () => {
        const data = String(reader.result ?? "");
        const comma = data.indexOf(",");
        if (comma > 0)
          post({
            type: "pasteImage",
            path: file?.path,
            mime: image.type,
            data: data.slice(comma + 1),
            at,
          });
      };
      reader.readAsDataURL(image);
      return;
    }
    const cards = e.clipboardData.getData(CLIP);
    if (cards) {
      try {
        const data = JSON.parse(cards);
        const b = boundsOf(data.nodes);
        const r = stage.getBoundingClientRect();
        const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
        duplicate(data.nodes, c.x - b.x - b.width / 2, c.y - b.y - b.height / 2, data.edges);
        return;
      } catch {
        // Not ours after all: pasted as text below.
      }
    }
    const text = e.clipboardData.getData("text/plain").trim();
    if (!text) return;
    const r = stage.getBoundingClientRect();
    const c = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    if (/^https?:\/\/\S+$/i.test(text)) addFromAnswer("link", text, c);
    else {
      const n = addCard(c.x - 130, c.y - 40, false, text);
      if (n) {
        n.height = Math.min(600, snap(text.split("\n").length * 21 + 40));
        changed([n.id]);
      }
    }
  });

  // ---- Messages -------------------------------------------------------------------------------------
  addEventListener("message", (e) => {
    const data = e.data;
    if (data?.ns !== NS) return;
    if (data.theme) {
      for (const [k, v] of Object.entries(data.theme.vars ?? {}))
        document.documentElement.style.setProperty(k, v);
      document.documentElement.dataset.theme = data.theme.kind ?? "dark";
      // The Markdown styles follow the theme.
      cards?.clear();
      cards?.askCss();
      // File cards carry the theme's colors and icons: fetched again.
      if (loaded && previews.size) {
        previews.clear();
        for (const el of nodeEls.values()) el.dataset.sig = "";
        render();
      }
      return;
    }
    if (data.file) {
      receive(data.file);
      return;
    }
    if ("saved" in data) {
      if (data.saved === false) showError(`Couldn't save: ${data.error ?? "unknown error"}`);
      return;
    }
    const m = data.message;
    if (!m || typeof m !== "object") return;
    if (m.type === "previewStale") {
      // The file changed: shown again from scratch.
      cards?.stale(m.file);
      if (!previews.has(m.file)) return;
      previews.delete(m.file);
      for (const n of doc.nodes)
        if (n.file === m.file) {
          const el = nodeEls.get(n.id);
          if (el) {
            el.dataset.sig = "";
            nodeContent(n, el);
          }
        }
      return;
    }
    if (m.key !== undefined && m.key !== key) return;
    if (m.type === "mdCss") {
      cards?.setCss(m.css);
      for (const el of nodeEls.values()) el.dataset.sig = "";
      render();
      return;
    }
    if (m.type === "renderedMd") {
      cards?.receiveRendered(m);
      return;
    }
    if (m.type === "preview") {
      previewVersion++;
      previews.set(m.file, { ...m, version: previewVersion });
      for (const n of doc.nodes)
        if (n.file === m.file || n.background === m.file)
          nodeContent(n, nodeEls.get(n.id) ?? nodeElement(n));
      return;
    }
    if (m.type === "settings") {
      snapOn = m.snap !== false;
      stage.classList.toggle("no-grid", m.grid === false);
      const redraw =
        prefs.arrows !== m.arrows ||
        prefs.imagePreview !== (m.imagePreview !== false) ||
        prefs.embedPages !== (m.embedPages !== false);
      prefs.embedPages = m.embedPages !== false;
      prefs.arrows = ["curved", "straight", "elbow"].includes(m.arrows) ? m.arrows : "curved";
      prefs.cardWidth = Number.isFinite(m.cardWidth) ? m.cardWidth : 260;
      prefs.imagePreview = m.imagePreview !== false;
      prefs.snapObjects = m.snapObjects !== false;
      if (redraw) {
        // Previews asked for under the old setting are asked for again.
        previews.clear();
        for (const el of nodeEls.values()) el.dataset.sig = "";
        render();
      }
    } else if (m.type === "focus") {
      const ids = (m.ids ?? []).filter((id) => byId(id) || edgeById(id));
      const nodeIds = ids.flatMap((id) => {
        const edge = edgeById(id);
        return edge ? [edge.fromNode, edge.toNode] : [id];
      });
      if (nodeIds.length) reveal([...new Set(nodeIds)]);
      else if (!m.flash) fit(doc.nodes);
      if (m.flash) flash(ids);
    } else if (m.type === "exportRequest") {
      void exporter.run(m);
    } else if (m.type === "answer") {
      // A change to an existing card (swap file, change link, group background, converted).
      const target = m.id ? byId(m.id) : null;
      if (m.id && target && !readOnly()) {
        checkpoint();
        if (m.kind === "swap") {
          target.file = m.value;
          delete target.subpath;
        } else if (m.kind === "url") {
          target.url = /^https?:\/\//i.test(m.value) ? m.value : `https://${m.value}`;
        } else if (m.kind === "background") {
          target.background = m.value;
          target.backgroundStyle ??= "cover";
        } else if (m.kind === "converted") {
          target.type = "file";
          target.file = m.value;
          delete target.text;
        }
        const el = nodeEls.get(target.id);
        if (el) el.dataset.sig = "";
        changed([target.id], [], true);
      } else if (!m.id) addFromAnswer(m.kind, m.value, m.at ?? { x: 0, y: 0 });
    }
  });
  addEventListener("pagehide", () => {
    if (saveTimer) saveNow();
    if (file) post({ type: "close", path: file.path });
  });
  addEventListener("resize", () => applyView());

  // The context menus and the find bar (menus.js) work through this.
  /** An arrow's drawing (for the export): path, arrowheads, label point. */
  function edgeShape(e) {
    const a = byId(e.fromNode);
    const b = byId(e.toNode);
    if (!a || !b) return null;
    const [fs, ts] = autoSides(a, b);
    const p = anchor(a, e.fromSide ?? fs);
    const q = anchor(b, e.toSide ?? ts);
    const c = curve(p, q);
    const heads = [];
    if (e.toEnd !== "none") heads.push(arrowHead(q, c.c2));
    if (e.fromEnd === "arrow") heads.push(arrowHead(p, c.c1));
    return { d: c.d, heads, mid: c.mid };
  }
  let toastTimer = 0;
  const toastEl = document.createElement("div");
  toastEl.className = "toast";
  toastEl.hidden = true;
  document.body.append(toastEl);
  /** A short note at the bottom of the page. */
  function toast(text) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), 3000);
  }
  const pageApi = {
    get doc() {
      return doc;
    },
    get editing() {
      return editing;
    },
    get file() {
      return file;
    },
    get locked() {
      return locked;
    },
    previews,
    stage,
    selected,
    nodeEls,
    prefs,
    ICONS,
    GRID,
    byId,
    edgeById,
    readOnly,
    checkpoint,
    changed,
    select,
    snap,
    post,
    toWorld,
    reveal,
    fit,
    boundsOf,
    button,
    insideGroup,
    startEditing,
    stopEditing,
    editEdgeLabel,
    addCard,
    duplicate,
    removeSelection,
    groupSelection,
    arrange,
    onAction,
    setDoc: (next) => {
      doc = next;
    },
    get view() {
      return view;
    },
    edgeShape,
    toast,
    /** Draws these cards again (their content changed). */
    refresh: (match) => {
      for (const n of doc.nodes)
        if (match(n)) {
          const el = nodeEls.get(n.id);
          if (el) {
            el.dataset.sig = "";
            nodeContent(n, el);
          }
        }
    },
    /** A card for something dragged out of another (a link, a file, a note's heading). */
    addItem: (item, at) => {
      if (readOnly()) return;
      checkpoint();
      const isFile = item.kind === "file";
      const n = {
        id: newId(),
        type: isFile ? "file" : "link",
        ...(isFile ? { file: item.file } : { url: item.url }),
        ...(item.subpath && { subpath: item.subpath }),
        x: snap(at.x - (isFile ? 200 : 170)),
        y: snap(at.y - (isFile ? 130 : 50)),
        width: isFile ? 400 : 340,
        height: isFile ? 260 : 100,
      };
      if (!isFile && cards?.embedUrl(n.url) && prefs.embedPages) {
        n.width = 560;
        n.height = 400;
      }
      doc.nodes.push(n);
      select([n.id]);
      changed([n.id]);
    },
  };
  const menus = self.canvasMenus(pageApi);
  const exporter = self.canvasExport(pageApi);
  cards = self.canvasCards(pageApi);
  afterRender = () => menus.afterRender();

  applyView();
  parent.postMessage({ ns: NS, ready: true }, "*");
  // For UI tests and the curious: the page's state.
  self.canvasDebug = () => ({
    nodes: doc.nodes.length,
    edges: doc.edges.length,
    selected: [...selected],
    view,
    dirty: dirty.size,
    undo: undoStack.length,
  });
})();
