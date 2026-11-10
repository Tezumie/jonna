// What cards show beyond plain text (D187): Markdown files rendered by the IDE as its preview
// renders them (with the preview's own styles for the current theme), web pages shown inside
// link cards, and dragging things out of a card — a link, an image or a heading of a note — onto
// the board as cards of their own. `self.canvasCards(page)` is called by viewer.js with its page
// API.
(() => {
  const DRAG = "application/x-canvas-item";

  self.canvasCards = (page) => {
    /** file\0subpath → { html } | { error } | "loading" */
    const rendered = new Map();
    let cssVersion = 0;

    // ---- The IDE's Markdown styles ---------------------------------------------------------------
    function setCss(css) {
      let el = document.getElementById("ide-md-css");
      if (!el) {
        el = document.createElement("style");
        el.id = "ide-md-css";
        // Before the canvas's own sheet: its rules for cards win where both apply.
        document.head.prepend(el);
      }
      el.textContent = String(css);
      cssVersion++;
    }
    const askCss = () => page.post({ type: "mdCss" });

    // ---- Markdown file cards ---------------------------------------------------------------------
    const keyOf = (n) => `${n.file}\u0000${n.subpath ?? ""}`;
    /** For the card's redraw signature: changes when its rendering arrives. */
    function mdState(n) {
      if (n.type !== "file" || !/\.(md|markdown)$/i.test(n.file ?? "")) return "";
      const r = rendered.get(keyOf(n));
      return `${typeof r === "object" ? (r.error ? "e" : "r") : (r ?? "")}:${cssVersion}`;
    }
    /** Fills `el` with the IDE's rendering of the card's note (asked for once); `fallback` meanwhile. */
    function markdownInto(el, n, fallback) {
      const k = keyOf(n);
      const r = rendered.get(k);
      if (r === undefined) {
        rendered.set(k, "loading");
        page.post({ type: "renderMd", path: page.file?.path, file: n.file, subpath: n.subpath });
      }
      // HTML the IDE built from the note and cleaned (editor.renderMarkdown); else our own.
      el.innerHTML = r && typeof r === "object" && !r.error ? r.html : fallback;
      if (!el.innerHTML.trim()) el.innerHTML = '<p class="placeholder">Empty note</p>';
      markDraggable(el, n);
    }
    function receiveRendered(m) {
      rendered.set(
        `${m.file}\u0000${m.subpath ?? ""}`,
        m.error ? { error: m.error } : { html: m.html },
      );
      page.refresh((n) => n.type === "file" && n.file === m.file);
    }
    function stale(fileName) {
      for (const k of [...rendered.keys()])
        if (k.startsWith(`${fileName}\u0000`)) rendered.delete(k);
    }
    function clear() {
      rendered.clear();
    }

    // ---- Web pages in link cards -----------------------------------------------------------------
    /** A page's address for showing it in a card: video sites' players, else as given. */
    function embedUrl(url) {
      try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\.|^m\./, "");
        if (host === "youtube.com" && u.pathname === "/watch" && u.searchParams.get("v"))
          return `https://www.youtube.com/embed/${encodeURIComponent(u.searchParams.get("v"))}`;
        if (host === "youtu.be" && u.pathname.length > 1)
          return `https://www.youtube.com/embed/${encodeURIComponent(u.pathname.slice(1))}`;
        if (host === "vimeo.com" && /^\/\d+$/.test(u.pathname))
          return `https://player.vimeo.com/video${u.pathname}`;
        return u.protocol === "https:" ? u.href : null;
      } catch {
        return null;
      }
    }
    const shows = (n) => page.prefs.embedPages && n.embed !== false && !!embedUrl(n.url ?? "");
    function linkInto(body, n, hostName) {
      body.innerHTML = "";
      const head = document.createElement("div");
      head.className = "file-head link-head";
      head.innerHTML = `${page.ICONS.link}<span class="file-name"></span><span class="file-path"></span>`;
      head.querySelector(".file-name").textContent = hostName(n.url);
      body.append(head);
      const src = shows(n) ? embedUrl(n.url) : null;
      if (src) {
        // The site runs in its own origin, sandboxed: no popups, no navigating the canvas. Some
        // sites refuse to be shown inside another page; "Show as a link" (its menu) for those.
        const frame = document.createElement("iframe");
        frame.className = "web-frame";
        frame.setAttribute(
          "sandbox",
          "allow-scripts allow-same-origin allow-forms allow-presentation",
        );
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.setAttribute("loading", "lazy");
        frame.setAttribute("allow", "fullscreen; picture-in-picture; encrypted-media");
        frame.title = n.url;
        frame.src = src;
        head.querySelector(".file-path").textContent = "Select the card to use the page";
        body.append(frame);
      } else {
        const url = document.createElement("div");
        url.className = "link-url";
        url.textContent = n.url;
        body.append(url);
      }
    }

    // ---- Dragging things out of a card ------------------------------------------------------------
    const dirOf = (p) =>
      String(p).includes("/") ? String(p).slice(0, String(p).lastIndexOf("/")) : "";
    /** A link or image path of a note, as a project path (null: outside the project). */
    function resolve(base, rel) {
      const clean = String(rel).split(/[?#]/)[0];
      let decoded = clean;
      try {
        decoded = decodeURI(clean);
      } catch {
        // as written
      }
      const parts = [];
      for (const part of `${base ? `${base}/` : ""}${decoded}`.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
          if (!parts.length) return null;
          parts.pop();
        } else parts.push(part);
      }
      return parts.join("/") || null;
    }
    /** Links, images and (in a note) headings can be dragged out once the card is selected. */
    function markDraggable(el, n) {
      for (const item of el.querySelectorAll("a, .md-link, img, h1, h2, h3, h4, h5, h6")) {
        if (/^H\d$/.test(item.tagName) && n.type !== "file") continue;
        item.dataset.drag = "1";
        item.draggable = true;
      }
    }
    function payloadOf(item, n) {
      const base = n.type === "file" ? dirOf(n.file) : "";
      if (/^H\d$/.test(item.tagName))
        return { kind: "file", file: n.file, subpath: `#${item.textContent.trim()}` };
      if (item.tagName === "IMG") {
        const src = item.dataset.src ?? "";
        if (/^https?:\/\//i.test(src)) return { kind: "link", url: src };
        const f = src && !/^[a-z][a-z0-9+.-]*:/i.test(src) ? resolve(base, src) : null;
        return f ? { kind: "file", file: f } : null;
      }
      const href = item.dataset.url ?? item.getAttribute("href") ?? "";
      if (/^https?:\/\//i.test(href)) return { kind: "link", url: href };
      if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
      const f = resolve(base, href);
      if (!f) return null;
      const frag = /#(.+)$/.exec(href)?.[1];
      return frag && /\.(md|markdown)$/i.test(f)
        ? { kind: "file", file: f, subpath: `#${decodeURIComponent(frag).replace(/-/g, " ")}` }
        : { kind: "file", file: f };
    }
    /** Whether a press should start the browser's own drag (an item, or selected text, of a selected card). */
    function startsNativeDrag(e) {
      const body = e.target.closest?.(".node.is-selected .node-body");
      // Ctrl+click is "open the link", not a drag.
      if (!body || e.button !== 0 || e.ctrlKey || e.metaKey || page.readOnly()) return false;
      if (e.target.closest("[data-drag]")) return true;
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !body.contains(sel.anchorNode))
        return false;
      for (const r of sel.getRangeAt(0).getClientRects())
        if (
          e.clientX >= r.left &&
          e.clientX <= r.right &&
          e.clientY >= r.top &&
          e.clientY <= r.bottom
        )
          return true;
      return false;
    }
    /** A press on a card's scrollbar scrolls; it doesn't move the card. */
    function onScrollbar(e) {
      const el = e.target;
      if (!(el instanceof HTMLElement)) return false;
      if (!el.matches(".node-body, .file-markdown, .file-preview, .md-pre pre, .md-table-wrap"))
        return false;
      const r = el.getBoundingClientRect();
      const scale = r.width / (el.offsetWidth || 1);
      const bar = (el.offsetWidth - el.clientWidth) * scale;
      const barY = (el.offsetHeight - el.clientHeight) * scale;
      return (bar > 0 && e.clientX > r.right - bar) || (barY > 0 && e.clientY > r.bottom - barY);
    }

    const { stage } = page;
    // Links in a rendered note never navigate the page: Ctrl+click opens them (the browser, or
    // the editor for the project's files), as for links in text cards.
    stage.addEventListener("click", (e) => {
      const a = e.target.closest?.(".node-body a[href]");
      if (!a) return;
      e.preventDefault();
      if (!(e.ctrlKey || e.metaKey)) return;
      const nodeEl = a.closest(".node");
      const n = nodeEl ? page.byId(nodeEl.dataset.id) : null;
      const p = n ? payloadOf(a, n) : null;
      if (p?.kind === "link") page.post({ type: "openLink", url: p.url });
      else if (p?.kind === "file") page.post({ type: "openFile", file: p.file });
    });
    stage.addEventListener("dragstart", (e) => {
      const nodeEl = e.target.closest?.(".node");
      const item = e.target.closest?.("[data-drag]");
      // Only from a selected card: elsewhere a press moves the card.
      if (!nodeEl?.classList.contains("is-selected") || page.readOnly()) {
        e.preventDefault();
        return;
      }
      const n = page.byId(nodeEl.dataset.id);
      if (!n) return;
      if (item) {
        const payload = payloadOf(item, n);
        if (!payload) {
          e.preventDefault();
          return;
        }
        e.dataTransfer.setData(DRAG, JSON.stringify(payload));
        e.dataTransfer.setData("text/plain", payload.url ?? payload.file);
      }
      e.dataTransfer.effectAllowed = "copy";
    });
    const accepts = (e) => {
      const types = [...(e.dataTransfer?.types ?? [])];
      // Files from the computer aren't taken (the IDE's own drop handling owns those).
      return !types.includes("Files") && (types.includes(DRAG) || types.includes("text/plain"));
    };
    stage.addEventListener("dragover", (e) => {
      if (!accepts(e) || page.readOnly()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    stage.addEventListener("drop", (e) => {
      if (!accepts(e) || page.readOnly()) return;
      e.preventDefault();
      const at = page.toWorld(e.clientX, e.clientY);
      let payload = null;
      try {
        payload = JSON.parse(e.dataTransfer.getData(DRAG) || "null");
      } catch {
        payload = null;
      }
      if (payload?.kind === "link" || payload?.kind === "file") {
        page.addItem(payload, at);
        return;
      }
      const text = e.dataTransfer.getData("text/plain");
      if (!text.trim()) return;
      const n = page.addCard(at.x - 130, at.y - 40, false, text.slice(0, 20000));
      if (n) page.toast("Added the text as a card");
    });

    return {
      setCss,
      askCss,
      mdState,
      markdownInto,
      receiveRendered,
      stale,
      clear,
      linkInto,
      markDraggable,
      startsNativeDrag,
      onScrollbar,
      embedUrl,
    };
  };
})();
