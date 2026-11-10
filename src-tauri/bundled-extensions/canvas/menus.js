// The canvas page's context menus and find bar (D183), split from viewer.js, which hands over
// what they need (`page`). The page's own menus replace the web view's (which offered Inspect).

self.canvasMenus = (page) => {
  const {
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
  } = page;

  // ---- Context menus ------------------------------------------------------------------------------
  // The page's own (the web view's would offer Inspect): what fits where you clicked. One level
  // of submenus (Align, Direction, Go to group…).
  const menuEl = document.createElement("div");
  menuEl.className = "ctx-menu";
  menuEl.setAttribute("role", "menu");
  menuEl.hidden = true;
  const subEl = document.createElement("div");
  subEl.className = "ctx-menu is-sub";
  subEl.setAttribute("role", "menu");
  subEl.hidden = true;
  document.body.append(menuEl, subEl);
  /** Cards copied here (Copy / Cut), for Paste from the menu. */
  let clip = null;

  function closeMenu() {
    for (const el of [menuEl, subEl]) {
      el.hidden = true;
      el.replaceChildren();
    }
  }
  function closeSub() {
    subEl.hidden = true;
    subEl.replaceChildren();
    for (const b of menuEl.querySelectorAll(".is-open")) b.classList.remove("is-open");
  }
  /** Places a panel at (x, y), kept inside the page. */
  function place(el, x, y, flipFrom) {
    el.hidden = false;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = x;
    if (left + w > innerWidth - 4)
      left = flipFrom !== undefined ? flipFrom - w : innerWidth - w - 4;
    el.style.left = `${Math.max(4, left)}px`;
    el.style.top = `${Math.max(4, y + h > innerHeight - 4 ? innerHeight - h - 4 : y)}px`;
  }
  /**
   * items: { label, run, key?, danger?, disabled?, checked? } | { label, submenu: items } | "-"
   * | { swatches: ids }
   */
  function fill(panel, items) {
    panel.replaceChildren();
    let pendingLine = false;
    for (const item of items) {
      if (item === "-") {
        pendingLine = panel.childElementCount > 0;
        continue;
      }
      if (pendingLine) {
        const line = document.createElement("div");
        line.className = "ctx-line";
        panel.append(line);
        pendingLine = false;
      }
      if (item.swatches) {
        panel.append(swatchRow(item.swatches));
        continue;
      }
      if (item.heading) {
        const h = document.createElement("div");
        h.className = "ctx-heading";
        h.textContent = item.heading;
        panel.append(h);
        continue;
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = `ctx-item${item.danger ? " is-danger" : ""}`;
      b.setAttribute("role", item.checked === undefined ? "menuitem" : "menuitemradio");
      if (item.checked !== undefined) b.setAttribute("aria-checked", String(item.checked));
      b.disabled = !!item.disabled || (item.submenu !== undefined && !item.submenu.length);
      const check = document.createElement("span");
      check.className = "ctx-check";
      check.textContent = item.checked ? "✓" : "";
      const label = document.createElement("span");
      label.className = "ctx-label";
      label.textContent = item.label;
      const key = document.createElement("span");
      key.className = "ctx-key";
      key.textContent = item.submenu ? "›" : (item.key ?? "");
      b.append(check, label, key);
      if (item.submenu) {
        b.dataset.submenu = "true";
        const open = () => {
          if (b.classList.contains("is-open")) return;
          closeSub();
          b.classList.add("is-open");
          fill(subEl, item.submenu);
          const r = b.getBoundingClientRect();
          place(subEl, r.right + 2, r.top - 4, r.left - 2);
        };
        b.addEventListener("pointerenter", open);
        b.addEventListener("click", () => {
          open();
          subEl.querySelector("button:not(:disabled)")?.focus();
        });
      } else {
        if (panel === menuEl) b.addEventListener("pointerenter", closeSub);
        b.addEventListener("click", () => {
          closeMenu();
          item.run();
        });
      }
      panel.append(b);
    }
  }
  function swatchRow(ids) {
    const row = document.createElement("div");
    row.className = "ctx-swatches";
    const current = new Set(ids.map((id) => (byId(id) ?? edgeById(id))?.color ?? ""));
    for (const c of ["", "1", "2", "3", "4", "5", "6"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = c ? "swatch" : "swatch is-none";
      b.title = c
        ? ["Red", "Orange", "Yellow", "Green", "Cyan", "Purple"][Number(c) - 1]
        : "No color";
      if (c) b.style.setProperty("--c", `var(--label-${c})`);
      else b.innerHTML = ICONS.none;
      if (current.size === 1 && current.has(c)) b.classList.add("is-on");
      b.addEventListener("click", () => {
        closeMenu();
        setColor(ids, c);
      });
      row.append(b);
    }
    // Any color (the format takes #rrggbb too).
    const custom = document.createElement("button");
    custom.type = "button";
    custom.className = "swatch is-custom";
    custom.title = "Custom color…";
    const one = [...current][0];
    if (current.size === 1 && one?.startsWith("#")) {
      custom.classList.add("is-on");
      custom.style.setProperty("--c", one);
    }
    const input = document.createElement("input");
    input.type = "color";
    input.value = one?.startsWith("#") && one.length === 7 ? one : "#3fb5c4";
    input.className = "swatch-input";
    input.addEventListener("change", () => {
      closeMenu();
      setColor(ids, input.value);
    });
    custom.addEventListener("click", () => input.click());
    row.append(custom, input);
    return row;
  }
  function openMenu(x, y, items) {
    closeMenu();
    fill(menuEl, items);
    place(menuEl, x, y);
    menuEl.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
  }
  for (const panel of [menuEl, subEl])
    panel.addEventListener("keydown", (e) => {
      e.stopPropagation();
      const buttons = [...panel.querySelectorAll("button:not(:disabled)")];
      const at = buttons.indexOf(document.activeElement);
      if (e.key === "Escape") {
        if (panel === subEl) {
          const opener = menuEl.querySelector(".is-open");
          closeSub();
          opener?.focus();
        } else closeMenu();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        buttons[(at + step + buttons.length) % buttons.length]?.focus();
      } else if (e.key === "ArrowRight" && panel === menuEl) {
        // Opens a submenu; never runs an ordinary item.
        if (document.activeElement?.dataset?.submenu) document.activeElement.click();
      } else if (e.key === "ArrowLeft" && panel === subEl) {
        const opener = menuEl.querySelector(".is-open");
        closeSub();
        opener?.focus();
      }
    });
  addEventListener(
    "pointerdown",
    (e) => {
      if (!menuEl.hidden && !menuEl.contains(e.target) && !subEl.contains(e.target)) closeMenu();
    },
    true,
  );
  addEventListener("blur", closeMenu);
  stage.addEventListener("wheel", closeMenu, { passive: true });

  function setColor(ids, color) {
    if (readOnly()) return;
    checkpoint();
    for (const id of ids) {
      const item = byId(id) ?? edgeById(id);
      if (!item) continue;
      if (color) item.color = color;
      else delete item.color;
    }
    changed(ids);
  }
  /** Copies text the page's way (a menu click is a user gesture, so this works in the web view). */
  function copyText(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    try {
      document.execCommand("copy");
    } catch {
      // Copying isn't available here: nothing to do.
    }
    area.remove();
  }
  function reorder(ids, toFront) {
    if (readOnly()) return;
    checkpoint();
    const set = new Set(ids);
    const moving = page.doc.nodes.filter((n) => set.has(n.id));
    const rest = page.doc.nodes.filter((n) => !set.has(n.id));
    page.doc.nodes = toFront ? [...rest, ...moving] : [...moving, ...rest];
    changed(ids);
  }
  function fitToText(ids) {
    if (readOnly()) return;
    checkpoint();
    const done = [];
    for (const id of ids) {
      const n = byId(id);
      const el = nodeEls.get(id);
      const body = el?.querySelector(".node-body");
      if (n?.type !== "text" || !body) continue;
      // The content's own height: let it size itself for a moment.
      el.style.height = "auto";
      body.style.flex = "none";
      const need = body.scrollHeight;
      body.style.flex = "";
      n.height = Math.max(GRID * 3, snap(need + 4));
      done.push(id);
    }
    changed(done);
  }
  function ungroup(id) {
    if (readOnly() || byId(id)?.type !== "group") return;
    checkpoint();
    page.doc.nodes = page.doc.nodes.filter((n) => n.id !== id);
    selected.delete(id);
    changed([], [id]);
  }
  function copyCards(cut) {
    const nodes = [...selected].map(byId).filter(Boolean);
    if (!nodes.length) return;
    // Through the system clipboard too (the page's copy handler fills both), like Ctrl+C; a menu
    // click is a user gesture, so this works here.
    try {
      if (document.execCommand(cut ? "cut" : "copy")) return;
    } catch {
      // Not available: the menu's own clipboard below.
    }
    const ids = new Set(nodes.map((n) => n.id));
    clip = {
      nodes: nodes.map((n) => ({ ...n })),
      edges: page.doc.edges
        .filter((x) => ids.has(x.fromNode) && ids.has(x.toNode))
        .map((x) => ({ ...x })),
    };
    if (cut) removeSelection();
  }
  function pasteCards(at) {
    if (!clip || readOnly()) return;
    const b = boundsOf(clip.nodes);
    duplicate(clip.nodes, at.x - b.x - b.width / 2, at.y - b.y - b.height / 2, clip.edges);
  }

  const geo = self.canvasGeometry;
  /** The selection's cards (not groups), or all of them if `withGroups`. */
  const cardsOf = (ids, withGroups = false) =>
    ids.map(byId).filter((n) => n && (withGroups || n.type !== "group"));
  /** Moves cards with a geometry function, as one undo step. */
  function relayout(ids, fn) {
    if (readOnly()) return;
    const nodes = cardsOf(ids, true);
    if (nodes.length < 2) return;
    checkpoint();
    // A group's cards go where it goes (unless they're being placed themselves).
    const placed = new Set(nodes.map((n) => n.id));
    const carried = nodes
      .filter((n) => n.type === "group")
      .map((g) => ({ g, x: g.x, y: g.y, inside: insideGroup(g).filter((m) => !placed.has(m.id)) }));
    fn(nodes);
    for (const n of nodes) {
      n.x = Math.round(n.x);
      n.y = Math.round(n.y);
    }
    const moved = nodes.map((n) => n.id);
    for (const c of carried)
      for (const m of c.inside) {
        m.x += c.g.x - c.x;
        m.y += c.g.y - c.y;
        moved.push(m.id);
      }
    changed(moved);
  }
  /** The Align menu (the selection bar's button, and a card's context menu). */
  function alignItems(ids) {
    const ro = readOnly();
    const few = ids.length < 2;
    const a = (label, fn, need = 2) => ({
      label,
      disabled: ro || ids.length < need,
      run: () => relayout(ids, fn),
    });
    return [
      a("Align left", (n) => geo.align(n, "left")),
      a("Align centre", (n) => geo.align(n, "center")),
      a("Align right", (n) => geo.align(n, "right")),
      "-",
      a("Align top", (n) => geo.align(n, "top")),
      a("Align middle", (n) => geo.align(n, "middle")),
      a("Align bottom", (n) => geo.align(n, "bottom")),
      "-",
      a("Arrange in a row", (n) => geo.arrange(n, "row", GRID * 2, snap)),
      a("Arrange in a column", (n) => geo.arrange(n, "column", GRID * 2, snap)),
      a("Arrange in a grid", (n) => geo.arrange(n, "grid", GRID * 2, snap)),
      "-",
      a("Spread out horizontally", (n) => geo.distribute(n, "x"), 3),
      a("Spread out vertically", (n) => geo.distribute(n, "y"), 3),
      "-",
      a("Same width", (n) => geo.justify(n, "width")),
      a("Same height", (n) => geo.justify(n, "height")),
      ...(few ? [{ heading: "Select two or more cards" }] : []),
    ];
  }
  function openAlignMenu(anchor) {
    const r = anchor.getBoundingClientRect();
    openMenu(r.left, r.bottom + 4, alignItems([...selected].filter((x) => byId(x))));
  }
  /** Headings of a Markdown file card's text (for "Narrow to heading"). */
  function headingsOf(n) {
    const p = page.previews.get(n.file);
    if (!p || typeof p !== "object" || typeof p.markdown !== "string") return [];
    return p.markdown
      .split("\n")
      .filter((l) => /^#{1,6}\s/.test(l))
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 40);
  }
  function update(id, fn) {
    if (readOnly()) return;
    const n = byId(id) ?? edgeById(id);
    if (!n) return;
    checkpoint();
    fn(n);
    const el = nodeEls.get(id);
    if (el) el.dataset.sig = "";
    changed([id]);
  }

  function nodeMenu(e, id) {
    const ro = readOnly();
    if (!selected.has(id)) select([id]);
    const ids = [...selected].filter((x) => byId(x));
    const n = byId(id);
    const single = ids.length === 1;
    const items = [];
    if (single && n.type === "text") {
      items.push({ label: "Edit", key: "Enter", run: () => startEditing(id), disabled: ro });
      items.push({
        label: "Convert to file…",
        disabled: ro,
        run: () => post({ type: "convert", path: page.file?.path, id, text: n.text ?? "" }),
      });
    }
    if (single && n.type === "file") {
      const md = /\.(md|markdown)$/i.test(n.file);
      items.push({ label: "Open file", run: () => post({ type: "openFile", file: n.file }) });
      items.push({ label: "Show in explorer", run: () => post({ type: "reveal", file: n.file }) });
      items.push({ label: "Copy path", run: () => copyText(n.file) });
      items.push({
        label: "Swap file…",
        disabled: ro,
        run: () =>
          post({
            type: "ask",
            path: page.file?.path,
            kind: "swap",
            id,
            image: /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(n.file),
          }),
      });
      if (md) {
        const heads = headingsOf(n);
        items.push({
          label: "Narrow to heading",
          submenu: heads.map((h) => ({
            label: h,
            checked: n.subpath === `#${h}`,
            disabled: ro,
            run: () => update(id, (x) => (x.subpath = `#${h}`)),
          })),
        });
        if (n.subpath)
          items.push({
            label: "Show the whole file",
            disabled: ro,
            run: () => update(id, (x) => delete x.subpath),
          });
      }
    }
    if (single && n.type === "link") {
      items.push({ label: "Open link", run: () => post({ type: "openLink", url: n.url }) });
      items.push({ label: "Copy link", run: () => copyText(n.url) });
      // A page shown in the card, or just its address (D187: some sites refuse to be shown).
      items.push({
        label: n.embed === false ? "Show the page" : "Show as a link",
        disabled: ro || !page.prefs.embedPages,
        run: () =>
          update(id, (x) => {
            if (x.embed === false) delete x.embed;
            else x.embed = false;
          }),
      });
      items.push({
        label: "Change link…",
        disabled: ro,
        run: () => post({ type: "ask", path: page.file?.path, kind: "url", id, value: n.url }),
      });
    }
    if (single && n.type === "group") {
      items.push({ label: "Rename", key: "F2", run: () => startEditing(id), disabled: ro });
      items.push({
        label: "Select what's inside",
        run: () => select(insideGroup(n).map((m) => m.id)),
      });
      items.push({
        label: "Background",
        submenu: [
          {
            label: n.background ? "Replace image…" : "Set image…",
            disabled: ro,
            run: () => post({ type: "ask", path: page.file?.path, kind: "background", id }),
          },
          ...(n.background
            ? [
                "-",
                ...["cover", "ratio", "repeat"].map((style) => ({
                  label: { cover: "Cover", ratio: "Keep aspect ratio", repeat: "Repeat" }[style],
                  checked: (n.backgroundStyle ?? "cover") === style,
                  disabled: ro,
                  run: () => update(id, (x) => (x.backgroundStyle = style)),
                })),
                "-",
                {
                  label: "Remove image",
                  disabled: ro,
                  run: () =>
                    update(id, (x) => {
                      delete x.background;
                      delete x.backgroundStyle;
                    }),
                },
              ]
            : []),
        ],
      });
      items.push({ label: "Ungroup", run: () => ungroup(id), disabled: ro });
    }
    if (!ro) items.push("-", { swatches: ids });
    items.push(
      "-",
      { label: "Zoom to selection", key: "Shift+2", run: () => fit(cardsOf(ids, true), 2) },
      { label: "Align", submenu: alignItems(ids) },
      {
        label: "Duplicate",
        key: "Ctrl+D",
        run: () => duplicate(ids.map(byId).filter(Boolean), 40, 40),
        disabled: ro,
      },
      {
        label: "Group",
        key: "Ctrl+G",
        run: () => groupSelection(),
        disabled: ro || ids.every((x) => byId(x).type === "group"),
      },
      { label: "Bring to front", run: () => reorder(ids, true), disabled: ro },
      { label: "Send to back", run: () => reorder(ids, false), disabled: ro },
    );
    if (ids.some((x) => byId(x).type === "text"))
      items.push({ label: "Fit to text", run: () => fitToText(ids), disabled: ro });
    items.push(
      "-",
      { label: "Copy", key: "Ctrl+C", run: () => copyCards(false) },
      { label: "Cut", key: "Ctrl+X", run: () => copyCards(true), disabled: ro },
      { label: "Delete", key: "Del", danger: true, run: () => removeSelection(), disabled: ro },
    );
    openMenu(e.clientX, e.clientY, items);
  }

  function edgeMenu(e, id) {
    const ro = readOnly();
    select([id]);
    const edge = edgeById(id);
    const set = (fn) => () => update(id, fn);
    // Right-clicked near one end: "go to" offers the card at the other end first (Obsidian).
    const at = toWorld(e.clientX, e.clientY);
    const from = byId(edge.fromNode);
    const to = byId(edge.toNode);
    const dist = (n) =>
      n ? Math.hypot(n.x + n.width / 2 - at.x, n.y + n.height / 2 - at.y) : Infinity;
    const goTo = (n) => () => {
      select([n.id]);
      reveal([n.id]);
    };
    const direction = edge.fromEnd === "arrow" ? "both" : edge.toEnd === "none" ? "none" : "one";
    const dir = (value, label) => ({
      label,
      checked: direction === value,
      disabled: ro,
      run: set((x) => {
        delete x.fromEnd;
        delete x.toEnd;
        if (value === "none") x.toEnd = "none";
        if (value === "both") x.fromEnd = "arrow";
      }),
    });
    const near = dist(from) < dist(to) ? to : from;
    openMenu(e.clientX, e.clientY, [
      {
        label: edge.label ? "Edit label" : "Add label",
        key: "Enter",
        run: () => editEdgeLabel(id),
        disabled: ro,
      },
      ...(edge.label
        ? [{ label: "Remove label", disabled: ro, run: set((x) => delete x.label) }]
        : []),
      "-",
      ...(near ? [{ label: "Follow to the other end", run: goTo(near) }] : []),
      {
        label: "Direction",
        submenu: [
          dir("none", "No arrows"),
          dir("one", "One way"),
          dir("both", "Both ways"),
          "-",
          {
            label: "Reverse",
            disabled: ro,
            run: set((x) => {
              const { fromNode, toNode, fromSide, toSide } = x;
              x.fromNode = toNode;
              x.toNode = fromNode;
              delete x.fromSide;
              delete x.toSide;
              if (toSide) x.fromSide = toSide;
              if (fromSide) x.toSide = fromSide;
            }),
          },
        ],
      },
      ...(ro ? [] : ["-", { swatches: [id] }]),
      "-",
      { label: "Delete", key: "Del", danger: true, run: () => removeSelection(), disabled: ro },
    ]);
  }

  function boardMenu(e, at) {
    const ro = readOnly();
    const groups = page.doc.nodes.filter((n) => n.type === "group");
    openMenu(e.clientX, e.clientY, [
      {
        label: "Add card here",
        run: () => addCard(at.x - prefs.cardWidth / 2, at.y - 40, true),
        disabled: ro,
      },
      { label: "Add file…", run: () => onAction("add-file", null, at), disabled: ro },
      { label: "Add image…", run: () => onAction("add-image", null, at), disabled: ro },
      { label: "Add link…", run: () => onAction("add-link", null, at), disabled: ro },
      { label: "Add group here", run: () => onAction("add-group", null, at), disabled: ro },
      "-",
      { label: "Paste", key: "Ctrl+V", run: () => pasteCards(at), disabled: ro || !clip },
      { label: "Select all", key: "Ctrl+A", run: () => select(page.doc.nodes.map((n) => n.id)) },
      "-",
      {
        label: "Go to group",
        submenu: groups.map((g) => ({
          label: g.label || "Unnamed group",
          run: () => {
            select([g.id]);
            fit([g], 1);
          },
        })),
      },
      { label: "Arrange", run: () => arrange(), disabled: ro || page.doc.nodes.length < 2 },
      { label: "Fit everything", key: "Shift+1", run: () => fit(page.doc.nodes) },
      { label: "Zoom to 100%", key: "Ctrl+0", run: () => onAction("zoom-reset") },
      "-",
      { label: "Find…", key: "Ctrl+F", run: () => openFind() },
      { label: "Export as image…", run: () => onAction("export") },
      { label: page.locked ? "Allow changes" : "Read-only", run: () => onAction("lock") },
      { label: "Help and shortcuts", key: "?", run: () => showHelp() },
      { label: "Canvas settings", run: () => post({ type: "settings" }) },
    ]);
  }

  // ---- Help ---------------------------------------------------------------------------------------
  const help = document.createElement("div");
  help.className = "help";
  help.hidden = true;
  help.setAttribute("role", "dialog");
  help.setAttribute("aria-label", "Canvas help");
  const HELP = [
    ["Add a card", "Double-click the board"],
    ["Edit a card", "Double-click it, or Enter / F2"],
    ["Stop editing", "Esc, or Ctrl+Enter"],
    ["Draw an arrow", "Drag a dot on a card's edge"],
    ["Reconnect an arrow", "Select it, drag an end onto a card (or off, to remove it)"],
    ["Move, one axis only", "Shift-drag"],
    ["Duplicate while moving", "Alt-drag"],
    ["Move without snapping", "Hold Space while dragging"],
    ["Resize", "Drag an edge or the corner; Shift keeps the shape"],
    ["Select several", "Drag a box, or Shift-click"],
    ["Pan", "Wheel, Space-drag, or the middle button"],
    ["Zoom", "Ctrl+wheel, + and -, Ctrl+0 for 100%"],
    ["Fit everything / the selection", "Shift+1 / Shift+2"],
    ["Group", "Ctrl+G"],
    ["Duplicate", "Ctrl+D"],
    ["Find", "Ctrl+F"],
    ["Undo / redo", "Ctrl+Z / Ctrl+Shift+Z or Ctrl+Y"],
    ["Delete", "Delete or Backspace"],
    ["Open a file or link card", "Double-click it; Ctrl+click a link in text"],
    ["Use a web page in a card", "Select the card, then click into the page"],
    ["Card from a note's link, image or heading", "Select the note's card, drag it onto the board"],
    ["Card from text", "Select text in a card and drag it onto the board"],
  ];
  function showHelp() {
    help.replaceChildren();
    const title = document.createElement("div");
    title.className = "help-title";
    title.textContent = "Canvas shortcuts";
    const close = button("help-close", "none", "Close (Esc)");
    close.addEventListener("click", () => (help.hidden = true));
    const head = document.createElement("div");
    head.className = "help-head";
    head.append(title, close);
    const list = document.createElement("dl");
    for (const [what, how] of HELP) {
      const dt = document.createElement("dt");
      dt.textContent = what;
      const dd = document.createElement("dd");
      dd.textContent = how;
      list.append(dt, dd);
    }
    help.append(head, list);
    help.hidden = false;
    close.focus();
  }
  help.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") help.hidden = true;
  });
  help.addEventListener("pointerdown", (e) => e.stopPropagation());
  document.body.append(help);

  stage.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (e.target.closest("textarea, input")) return;
    if (page.editing) stopEditing(true);
    let nodeEl = e.target.closest(".node");
    if (nodeEl?.classList.contains("is-group") && !e.target.closest(".group-label")) nodeEl = null;
    const edgeEl = e.target.closest("[data-edge]");
    if (nodeEl) nodeMenu(e, nodeEl.dataset.id);
    else if (edgeEl) edgeMenu(e, edgeEl.dataset.edge);
    else boardMenu(e, toWorld(e.clientX, e.clientY));
  });
  // Elsewhere in the page (the bars): no web view menu either.
  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest?.("textarea, input")) e.preventDefault();
  });

  // ---- Find ---------------------------------------------------------------------------------------
  const findBar = document.createElement("div");
  findBar.className = "bar find-bar";
  findBar.hidden = true;
  const findInput = document.createElement("input");
  findInput.className = "find-input";
  findInput.placeholder = "Find on the canvas";
  findInput.setAttribute("aria-label", "Find on the canvas");
  const findCount = document.createElement("span");
  findCount.className = "find-count";
  const findClose = button("find-close", "none", "Close (Esc)");
  findBar.append(findInput, findCount, findClose);
  document.body.append(findBar);
  findBar.addEventListener("pointerdown", (e) => e.stopPropagation());
  let matches = [];
  let matchAt = -1;
  const textOf = (n) => [n.text, n.file, n.url, n.label].filter(Boolean).join(" ").toLowerCase();
  function runFind() {
    const q = findInput.value.trim().toLowerCase();
    matches = q ? page.doc.nodes.filter((n) => textOf(n).includes(q)).map((n) => n.id) : [];
    for (const [id, el] of nodeEls) el.classList.toggle("is-match", matches.includes(id));
    matchAt = matches.length ? Math.min(Math.max(matchAt, 0), matches.length - 1) : -1;
    findCount.textContent = q
      ? matches.length
        ? `${matchAt + 1} of ${matches.length}`
        : "No results"
      : "";
  }
  function stepFind(dir) {
    if (!matches.length) return;
    matchAt = (matchAt + dir + matches.length) % matches.length;
    const id = matches[matchAt];
    select([id]);
    reveal([id]);
    runFind();
  }
  function openFind() {
    findBar.hidden = false;
    document.body.classList.add("is-finding");
    findInput.focus();
    findInput.select();
    runFind();
  }
  function closeFind() {
    findBar.hidden = true;
    document.body.classList.remove("is-finding");
    for (const el of nodeEls.values()) el.classList.remove("is-match");
    matches = [];
  }
  findInput.addEventListener("input", () => {
    matchAt = 0;
    runFind();
    if (matches.length) reveal([matches[0]]);
  });
  findInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") stepFind(e.shiftKey ? -1 : 1);
    else if (e.key === "Escape") closeFind();
  });
  findClose.addEventListener("click", closeFind);

  return {
    openFind,
    showHelp,
    openAlignMenu,
    close: closeMenu,
    setClip: (value) => {
      clip = value;
    },
    afterRender: () => {
      if (!findBar.hidden) runFind();
    },
  };
};
