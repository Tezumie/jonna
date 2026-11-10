// Export as an image (D184, like Obsidian's "Export as image"): the whole canvas or what's in
// view, as PNG (1–3×) or SVG, with "privacy mode" drawing grey bars instead of text. The picture
// is built as a standalone SVG (theme colors resolved, card text wrapped and clipped, images
// inlined); a PNG is that SVG drawn on a canvas. main.js saves it next to the .canvas file.

self.canvasExport = (page) => {
  const { stage, post, boundsOf, button } = page;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const PAD = 40;
  const MAX_PIXELS = 16384;

  const css = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  /** A card's color as a concrete value (the six presets are theme tokens). */
  const colorOf = (c) => (!c ? null : /^[1-6]$/.test(c) ? css(`--label-${c}`, "#888") : c);

  /** Plain lines of a card's text: Markdown marks dropped, headings marked for bold. */
  function plain(text) {
    return String(text ?? "")
      .split("\n")
      .filter((l) => !/^\s*```/.test(l))
      .map((l) => {
        const heading = /^#{1,6}\s+/.test(l);
        const t = l
          .replace(/^#{1,6}\s+/, "")
          .replace(/^\s*[-*+]\s+\[([ xX])\]\s+/, (_, x) => (x === " " ? "☐ " : "☑ "))
          .replace(/^\s*[-*+]\s+/, "• ")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/[*_~`]/g, "")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
        return { text: t, bold: heading };
      });
  }

  const measure = document.createElement("canvas").getContext("2d");
  /** Word-wraps a line to `width` px in `font`. */
  function wrap(text, width, font) {
    measure.font = font;
    const out = [];
    let line = "";
    for (const word of text.split(/(\s+)/)) {
      const next = line + word;
      if (measure.measureText(next).width > width && line.trim()) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = next;
    }
    out.push(line.trimEnd());
    return out;
  }

  function buildSvg(area, privacy) {
    const doc = page.doc;
    const r = stage.getBoundingClientRect();
    const view = page.view;
    // A hidden page has no size: then the whole canvas.
    const box =
      area === "view" && r.width > 0 && r.height > 0
        ? {
            x: -view.x / view.zoom,
            y: -view.y / view.zoom,
            width: r.width / view.zoom,
            height: r.height / view.zoom,
          }
        : (() => {
            const b = boundsOf(doc.nodes);
            return {
              x: b.x - PAD,
              y: b.y - PAD,
              width: b.width + PAD * 2,
              height: b.height + PAD * 2,
            };
          })();
    const font = css("--font-ui", "system-ui, sans-serif");
    const bg = css("--bg-app", "#141414");
    const card = css("--bg-surface-raised", "#222");
    const border = css("--border-default", "#333");
    const fg = css("--fg-default", "#e6e6e6");
    const muted = css("--fg-muted", "#999");
    const edgeColor = css("--fg-subtle", "#777");
    const parts = [];
    parts.push(
      `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="${esc(bg)}"/>`,
    );
    const order = [
      ...doc.nodes.filter((n) => n.type === "group"),
      ...doc.nodes.filter((n) => n.type !== "group"),
    ];
    // Groups under the arrows, cards over them (as on screen).
    for (const n of order.filter((x) => x.type === "group")) {
      const c = colorOf(n.color) ?? muted;
      parts.push(
        `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" fill="${esc(c)}" fill-opacity="0.07" stroke="${esc(c)}" stroke-opacity="0.35"/>`,
      );
      const bgImage = n.background ? page.previews.get(n.background)?.image : null;
      if (bgImage)
        parts.push(
          `<image href="${esc(bgImage)}" x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" preserveAspectRatio="${n.backgroundStyle === "ratio" ? "xMidYMid meet" : "xMidYMid slice"}"/>`,
        );
      if (n.label)
        parts.push(
          privacy
            ? `<rect x="${n.x}" y="${n.y - 26}" width="${Math.min(n.width, n.label.length * 8 + 20)}" height="18" rx="4" fill="${esc(muted)}" fill-opacity="0.4"/>`
            : `<text x="${n.x + 4}" y="${n.y - 10}" fill="${esc(fg)}" font-family="${esc(font)}" font-size="14" font-weight="600">${esc(n.label)}</text>`,
        );
    }
    for (const e of doc.edges) {
      const shape = page.edgeShape(e);
      if (!shape) continue;
      const c = colorOf(e.color) ?? edgeColor;
      parts.push(`<path d="${shape.d}" fill="none" stroke="${esc(c)}" stroke-width="2"/>`);
      for (const head of shape.heads)
        parts.push(`<path d="${head}" fill="${esc(c)}" stroke="${esc(c)}"/>`);
      if (e.label && shape.mid) {
        const w = e.label.length * 7 + 16;
        parts.push(
          `<rect x="${shape.mid.x - w / 2}" y="${shape.mid.y - 10}" width="${w}" height="20" rx="4" fill="${esc(bg)}"/>`,
          privacy
            ? `<rect x="${shape.mid.x - w / 2 + 6}" y="${shape.mid.y - 3}" width="${w - 12}" height="6" rx="3" fill="${esc(muted)}" fill-opacity="0.5"/>`
            : `<text x="${shape.mid.x}" y="${shape.mid.y + 4}" text-anchor="middle" fill="${esc(muted)}" font-family="${esc(font)}" font-size="12">${esc(e.label)}</text>`,
        );
      }
    }
    let clipId = 0;
    for (const n of order.filter((x) => x.type !== "group")) {
      const c = colorOf(n.color);
      parts.push(
        `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" fill="${esc(card)}" stroke="${esc(c ?? border)}"/>`,
      );
      if (c)
        parts.push(
          `<rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="8" fill="${esc(c)}" fill-opacity="0.12"/>`,
        );
      const id = `c${clipId++}`;
      parts.push(
        `<clipPath id="${id}"><rect x="${n.x + 1}" y="${n.y + 1}" width="${n.width - 2}" height="${n.height - 2}" rx="7"/></clipPath>`,
      );
      const inner = [];
      const preview = n.file ? page.previews.get(n.file) : null;
      const image = preview && typeof preview === "object" ? preview.image : null;
      let lines;
      if (n.type === "file") {
        const name = String(n.file ?? "")
          .split("/")
          .pop();
        lines = [{ text: name, bold: true }];
        if (
          !image &&
          preview &&
          typeof preview === "object" &&
          typeof preview.markdown === "string"
        )
          lines.push(...plain(preview.markdown).slice(0, 60));
      } else if (n.type === "link") lines = [{ text: n.url, bold: true }];
      else lines = plain(n.text);
      let y = n.y + 24;
      const maxW = n.width - 28;
      for (const line of lines) {
        const f = `${line.bold ? "600 " : ""}13px ${font}`;
        for (const piece of wrap(line.text, maxW, f)) {
          if (y > n.y + n.height - 8) break;
          if (privacy) {
            const w = Math.min(maxW, measure.measureText(piece).width);
            if (w > 0)
              inner.push(
                `<rect x="${n.x + 14}" y="${y - 9}" width="${w}" height="8" rx="4" fill="${esc(muted)}" fill-opacity="0.45"/>`,
              );
          } else if (piece)
            inner.push(
              `<text x="${n.x + 14}" y="${y}" fill="${esc(line.bold ? fg : fg)}" font-family="${esc(font)}" font-size="13"${line.bold ? ' font-weight="600"' : ""}>${esc(piece)}</text>`,
            );
          y += 20;
        }
      }
      if (image)
        inner.push(
          `<image href="${esc(image)}" x="${n.x + 14}" y="${n.y + 36}" width="${n.width - 28}" height="${Math.max(0, n.height - 50)}" preserveAspectRatio="xMidYMid meet"/>`,
        );
      parts.push(`<g clip-path="url(#${id})">${inner.join("")}</g>`);
    }
    return {
      svg: `<svg xmlns="${SVG_NS}" viewBox="${box.x} ${box.y} ${box.width} ${box.height}" width="${Math.round(box.width)}" height="${Math.round(box.height)}">${parts.join("")}</svg>`,
      width: box.width,
      height: box.height,
    };
  }

  function toPng(svg, width, height, scale) {
    // Kept under the browser's canvas limit.
    const k = Math.min(scale, MAX_PIXELS / width, MAX_PIXELS / height);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(width * k));
          canvas.height = Math.max(1, Math.round(height * k));
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL("image/png");
          // "data:," is what an over-large canvas gives: an empty picture, not a success.
          if (data.length < 32) throw new Error("the picture is too large to draw");
          resolve(data.slice(data.indexOf(",") + 1));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("the picture couldn't be drawn"));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
  }

  // ---- The dialog ---------------------------------------------------------------------------------
  const dialog = document.createElement("div");
  dialog.className = "help export";
  dialog.hidden = true;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "Export as image");
  document.body.append(dialog);
  dialog.addEventListener("pointerdown", (e) => e.stopPropagation());
  dialog.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") dialog.hidden = true;
  });

  const choice = (name, label, options, value) => {
    const row = document.createElement("label");
    row.className = "export-row";
    const text = document.createElement("span");
    text.textContent = label;
    const select = document.createElement("select");
    select.name = name;
    for (const [v, l] of options) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      if (v === value) o.selected = true;
      select.append(o);
    }
    row.append(text, select);
    return row;
  };

  function open() {
    if (!page.doc.nodes.length) {
      page.toast("There's nothing on the canvas to export yet.");
      return;
    }
    dialog.replaceChildren();
    const head = document.createElement("div");
    head.className = "help-head";
    const title = document.createElement("div");
    title.className = "help-title";
    title.textContent = "Export as image";
    const close = button("export-close", "none", "Close (Esc)");
    close.addEventListener("click", () => (dialog.hidden = true));
    head.append(title, close);
    const form = document.createElement("div");
    form.className = "export-form";
    form.append(
      choice(
        "format",
        "Format",
        [
          ["png", "PNG"],
          ["svg", "SVG"],
        ],
        "png",
      ),
      choice(
        "area",
        "Area",
        [
          ["all", "The whole canvas"],
          ["view", "What's in view"],
        ],
        "all",
      ),
      choice(
        "scale",
        "Size (PNG)",
        [
          ["1", "1×"],
          ["2", "2×"],
          ["3", "3×"],
        ],
        "2",
      ),
    );
    const privacy = document.createElement("label");
    privacy.className = "export-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.name = "privacy";
    privacy.append(box, document.createTextNode(" Hide the text (privacy mode)"));
    const go = document.createElement("button");
    go.type = "button";
    go.className = "export-go";
    go.textContent = "Export";
    const status = document.createElement("div");
    status.className = "file-note";
    go.addEventListener("click", async () => {
      const get = (n) => form.querySelector(`[name="${n}"]`).value;
      status.textContent = "Exporting…";
      try {
        const built = buildSvg(get("area"), box.checked);
        if (get("format") === "svg")
          post({ type: "exportFile", path: page.file?.path, format: "svg", text: built.svg });
        else {
          const data = await toPng(built.svg, built.width, built.height, Number(get("scale")));
          post({ type: "exportFile", path: page.file?.path, format: "png", data });
        }
        dialog.hidden = true;
      } catch (err) {
        status.textContent = `Couldn't export: ${err instanceof Error ? err.message : String(err)}`;
      }
    });
    dialog.append(head, form, privacy, go, status);
    dialog.hidden = false;
    go.focus();
  }

  /** An export asked for by a command (canvas.export): no dialog; errors go back to it. */
  async function run(options) {
    try {
      if (!page.doc.nodes.length) throw new Error("the canvas is empty");
      const built = buildSvg(options.area, options.privacy);
      if (options.format === "svg")
        post({
          type: "exportFile",
          request: options.request,
          path: page.file?.path,
          format: "svg",
          text: built.svg,
        });
      else {
        const data = await toPng(built.svg, built.width, built.height, options.scale);
        post({
          type: "exportFile",
          request: options.request,
          path: page.file?.path,
          format: "png",
          data,
        });
      }
    } catch (err) {
      post({
        type: "exportError",
        request: options.request,
        path: page.file?.path,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { open, run, buildSvg };
};
