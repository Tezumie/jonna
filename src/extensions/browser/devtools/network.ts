// DevTools Network: every request of the preview (from the proxy's log; external windows report
// what the bridge sees). Filter by text and type, preserve log, disable cache; a row opens
// headers, payload, preview, response and timing. Right-click: copy URL / as cURL / response,
// open in a tab or in the editor.
import { h, on } from "../../../core/dom/index";
import { browserIpc } from "../../../core/ipc/browser";
import { DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import type { NetRequest } from "../page";
import {
  type DevtoolsHost,
  type DevtoolsPanel,
  filterInput,
  formatBytes,
  formatMs,
  iconButton,
  kvTable,
  languageOf,
  shortName,
  splitPanes,
  textDecoder,
  toggle,
} from "./common";

export type RequestType =
  | "doc"
  | "fetch"
  | "js"
  | "css"
  | "img"
  | "font"
  | "media"
  | "ws"
  | "other";

const TYPES: [RequestType | "all", string][] = [
  ["all", "All"],
  ["fetch", "Fetch/XHR"],
  ["doc", "Doc"],
  ["css", "CSS"],
  ["js", "JS"],
  ["img", "Img"],
  ["font", "Font"],
  ["media", "Media"],
  ["ws", "WS"],
  ["other", "Other"],
];

/** The Network filter type of a request (mime first, then extension, then initiator). */
export function requestType(r: NetRequest): RequestType {
  if (r.protocol === "websocket") return "ws";
  // What the browser said it's fetching, when it says (Sec-Fetch-Dest).
  const dest = r.reqHeaders.find(([k]) => k.toLowerCase() === "sec-fetch-dest")?.[1];
  const byDest: Record<string, RequestType> = {
    document: "doc",
    iframe: "doc",
    empty: "fetch",
    script: "js",
    worker: "js",
    style: "css",
    image: "img",
    font: "font",
    audio: "media",
    video: "media",
    websocket: "ws",
  };
  if (dest && byDest[dest]) return byDest[dest];
  const m = r.mime.toLowerCase();
  const path = r.url.split("?")[0]?.toLowerCase() ?? "";
  if (m.includes("html")) return "doc";
  if (m.includes("css") || path.endsWith(".css") || r.initiator === "link") return "css";
  if (
    m.includes("javascript") ||
    m.includes("ecmascript") ||
    /\.(m|c)?[jt]sx?$/.test(path) ||
    r.initiator === "script"
  )
    return "js";
  if (
    m.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|avif|svg|ico)$/.test(path) ||
    r.initiator === "img"
  )
    return "img";
  if (m.startsWith("font/") || /\.(woff2?|ttf|otf)$/.test(path)) return "font";
  if (m.startsWith("video/") || m.startsWith("audio/")) return "media";
  if (
    m.includes("json") ||
    r.initiator === "fetch" ||
    r.initiator === "xmlhttprequest" ||
    r.method !== "GET"
  )
    return "fetch";
  return "other";
}

/** A shell command that repeats the request. */
export function curlOf(r: NetRequest, body: string | null): string {
  const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const parts = [`curl ${q(r.url)}`];
  // Quoted too: the page reports its requests, so the method can be any text ("X;rm -rf ~").
  if (r.method !== "GET") parts.push(`-X ${q(r.method)}`);
  for (const [k, v] of r.reqHeaders) {
    if (/^(host|content-length|connection|accept-encoding)$/i.test(k)) continue;
    parts.push(`-H ${q(`${k}: ${v}`)}`);
  }
  if (body) parts.push(`--data-raw ${q(body)}`);
  return parts.join(" \\\n  ");
}

export class NetworkPanel implements DevtoolsPanel {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly rows: HTMLElement;
  private readonly details: HTMLElement;
  private readonly summary: HTMLElement;
  private filter = "";
  private type: RequestType | "all" = "all";
  private selected: string | null = null;
  private detailTab: "headers" | "payload" | "preview" | "response" | "timing" = "headers";
  private readonly detailStore = this.store.add(new DisposableStore());
  /** Requests come in storms: drawn at most once a frame, and not while the panel is hidden. */
  private shown = false;
  private frame = 0;
  /**
   * The row drawn for each request (by id), reused while the request object is unchanged, so
   * a redraw only builds the rows that are new or changed.
   */
  private drawn = new Map<string, { request: NetRequest; el: HTMLElement; bar: HTMLElement }>();
  /** The waterfall's time range when the bars were last placed. */
  private drawnRange = { start: 0, span: 0 };

  constructor(private readonly host: DevtoolsHost) {
    const s = this.store;
    const { page } = host;
    const chips = TYPES.map(([id, label]) => {
      const b = h(
        "button",
        { class: "dt-chip", type: "button", "aria-pressed": String(id === "all") },
        label,
      );
      s.add(
        on(b, "click", () => {
          this.type = id;
          for (const c of chips) c.setAttribute("aria-pressed", String(c === b));
          this.render();
        }),
      );
      return b;
    });
    const toolbar = h(
      "div",
      { class: "dt-toolbar" },
      iconButton(s, "ban", "Clear", () => {
        page.clearRequests();
        this.select(null);
      }),
      filterInput(s, "Filter URLs", (t) => {
        this.filter = t;
        this.render();
      }),
      toggle(
        s,
        "Preserve log",
        page.preserveLog,
        (on) => (page.preserveLog = on),
        "Keep requests when the page navigates",
      ),
      toggle(
        s,
        "Disable cache",
        false,
        (on) => void browserIpc.setNoCache(on).catch(() => {}),
        "Ask the server again for everything (previews)",
      ),
    );
    const typeBar = h("div", { class: "dt-toolbar dt-types" }, ...chips);
    const head = h(
      "div",
      { class: "dt-net-row dt-net-head" },
      h("span", null, "Name"),
      h("span", null, "Status"),
      h("span", null, "Method"),
      h("span", null, "Type"),
      h("span", null, "Size"),
      h("span", null, "Time"),
      h("span", null, "Waterfall"),
    );
    this.rows = h("div", { class: "dt-net-rows" });
    this.summary = h("div", { class: "dt-statusbar" });
    this.details = h("div", { class: "dt-net-details", hidden: true });
    const table = h("div", { class: "dt-net-table" }, head, this.rows);
    this.element = h(
      "div",
      { class: "dt-panel dt-network" },
      toolbar,
      typeBar,
      // The list and a request's details, resizable (the details pane keeps its width).
      splitPanes(s, table, this.details, {
        key: "network",
        sized: "second",
        size: 460,
        min: 200,
        stackBelow: 520,
        stackedShare: 0.55,
      }),
      this.summary,
    );
    s.add(
      effect(() => {
        page.requests.value;
        this.schedule();
        return undefined;
      }),
    );
    s.add({ dispose: () => cancelAnimationFrame(this.frame) });
  }

  onShow(): void {
    this.shown = true;
    this.render();
  }

  onHide(): void {
    this.shown = false;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private schedule(): void {
    if (!this.shown || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private visible(): NetRequest[] {
    return this.host.page.requests
      .peek()
      .filter(
        (r) =>
          (this.type === "all" || requestType(r) === this.type) &&
          (!this.filter || r.url.toLowerCase().includes(this.filter)),
      );
  }

  private render(): void {
    const all = this.host.page.requests.peek();
    const list = this.visible();
    const start = Math.min(...all.map((r) => r.startMs), Number.POSITIVE_INFINITY);
    const end = Math.max(...all.map((r) => r.startMs + r.durationMs), start + 1);
    const span = end - start || 1;
    const atBottom = this.rows.scrollHeight - this.rows.scrollTop - this.rows.clientHeight < 24;
    // Every bar moves when the range changes; otherwise only new rows need placing.
    const rangeChanged = start !== this.drawnRange.start || span !== this.drawnRange.span;
    this.drawnRange = { start, span };
    const place = (bar: HTMLElement, r: NetRequest) => {
      bar.style.left = `${((r.startMs - start) / span) * 100}%`;
      bar.style.width = `${Math.max(0.5, (Math.max(r.durationMs, 1) / span) * 100)}%`;
    };
    const drawn = new Map<string, { request: NetRequest; el: HTMLElement; bar: HTMLElement }>();
    const els = list.map((r) => {
      const old = this.drawn.get(r.id);
      if (old && old.request === r) {
        if (rangeChanged) place(old.bar, r);
        drawn.set(r.id, old);
        return old.el;
      }
      const row = this.buildRow(r);
      place(row.bar, r);
      drawn.set(r.id, { request: r, ...row });
      return row.el;
    });
    const previous = this.drawn;
    this.drawn = drawn;
    // Usually requests only arrive or change (pending → done): the rows shown are then the new
    // list's first ones, some rebuilt in place, and the rest are appended. Anything else
    // (filtered, cleared, trimmed) puts the rows in order again.
    const current = this.rows.children;
    let inPlace = current.length <= els.length;
    for (let i = 0; inPlace && i < current.length; i++) {
      const r = list[i];
      if (current[i] !== els[i] && (!r || previous.get(r.id)?.el !== current[i])) inPlace = false;
    }
    if (inPlace) {
      for (let i = 0; i < current.length; i++) {
        const el = els[i];
        const shown = current[i];
        if (el && shown && shown !== el) shown.replaceWith(el);
      }
      this.rows.append(...els.slice(current.length));
    } else this.rows.replaceChildren(...els);
    if (atBottom) this.rows.scrollTop = this.rows.scrollHeight;
    const bytes = list.reduce((n, r) => n + r.size, 0);
    const finish = list.length ? Math.max(...list.map((r) => r.startMs + r.durationMs)) - start : 0;
    this.summary.textContent = `${list.length}${list.length !== all.length ? ` / ${all.length}` : ""} requests · ${formatBytes(bytes)} · finished in ${formatMs(finish)}`;
    if (this.selected && !all.some((r) => r.id === this.selected)) this.select(null);
  }

  private buildRow(r: NetRequest): { el: HTMLElement; bar: HTMLElement } {
    const failed = r.error || r.status >= 400 || (r.done && r.status === 0);
    const bar = h("i");
    const el = h(
      "div",
      {
        class: `dt-net-row${failed ? " is-error" : ""}${r.id === this.selected ? " is-selected" : ""}${r.done ? "" : " is-pending"}`,
        "data-key": r.id,
        title: r.url,
      },
      h("span", { class: "dt-net-name" }, shortName(r.url)),
      h(
        "span",
        null,
        r.protocol === "websocket"
          ? "101"
          : r.status
            ? String(r.status)
            : r.error
              ? "failed"
              : r.done
                ? "—"
                : "…",
      ),
      h("span", null, r.method),
      h("span", null, requestType(r)),
      h("span", null, r.done ? formatBytes(r.size) : ""),
      h("span", null, r.done ? formatMs(r.durationMs) : "pending"),
      h("span", { class: "dt-net-fall" }, bar),
    );
    // Rows are rebuilt and dropped with the list; their listeners go with the elements.
    el.addEventListener("click", () => this.select(r.id));
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.contextMenu(e, r);
    });
    return { el, bar };
  }

  /** Shows a request's details (or closes them). */
  select(id: string | null): void {
    this.selected = id;
    for (const row of Array.from(this.rows.children))
      row.classList.toggle("is-selected", (row as HTMLElement).dataset.key === id);
    this.details.hidden = id === null;
    this.element.classList.toggle("has-details", id !== null);
    if (id) void this.renderDetails();
  }

  private async renderDetails(): Promise<void> {
    const r = this.host.page.requests.peek().find((x) => x.id === this.selected);
    if (!r) return;
    this.detailStore.clear();
    const s = this.detailStore;
    const tabs = (["headers", "payload", "preview", "response", "timing"] as const).map((t) => {
      const b = h(
        "button",
        { class: "dt-subtab", type: "button", "aria-selected": String(t === this.detailTab) },
        t[0]?.toUpperCase() + t.slice(1),
      );
      s.add(
        on(b, "click", () => {
          this.detailTab = t;
          void this.renderDetails();
        }),
      );
      return b;
    });
    const close = iconButton(s, "x", "Close", () => this.select(null));
    const content = h("div", { class: "dt-net-detail-body" });
    this.details.replaceChildren(h("div", { class: "dt-subtabs" }, close, ...tabs), content);
    const general: [string, string][] = [
      ["Request URL", r.url],
      ["Request method", r.method],
      ["Status", r.error ? `${r.status || ""} ${r.error}`.trim() : String(r.status || "—")],
      ...(r.mime ? [["Type", r.mime] as [string, string]] : []),
    ];
    switch (this.detailTab) {
      case "headers":
        content.append(
          h("div", { class: "dt-section-title" }, "General"),
          kvTable(general),
          h("div", { class: "dt-section-title" }, "Response headers"),
          kvTable(r.resHeaders, r.done ? "None" : "Waiting for the response…"),
          h("div", { class: "dt-section-title" }, "Request headers"),
          kvTable(r.reqHeaders),
        );
        break;
      case "payload": {
        const query = (() => {
          try {
            return Array.from(new URL(r.url, "http://x/").searchParams.entries());
          } catch {
            return [];
          }
        })();
        content.append(h("div", { class: "dt-section-title" }, "Query string"), kvTable(query));
        if (r.hasRequestBody) {
          const bytes = await this.host.body(r, "request");
          content.append(
            h("div", { class: "dt-section-title" }, "Request body"),
            h("pre", { class: "dt-pre" }, bytes ? pretty(textDecoder.decode(bytes)) : "Not kept."),
          );
        }
        break;
      }
      case "preview":
      case "response": {
        if (!r.done) {
          content.append(h("div", { class: "dt-empty" }, "Still loading…"));
          break;
        }
        const bytes = await this.host.body(r, "response");
        if (!bytes) {
          content.append(
            h(
              "div",
              { class: "dt-empty" },
              "The body isn't kept (too large, too old, or reported by an external window).",
            ),
          );
          break;
        }
        const type = requestType(r);
        if (this.detailTab === "preview" && type === "img") {
          const url = URL.createObjectURL(
            new Blob([bytes as BlobPart], { type: r.mime || "image/png" }),
          );
          s.add({ dispose: () => URL.revokeObjectURL(url) });
          content.append(
            h("div", { class: "dt-net-image" }, h("img", { src: url, alt: shortName(r.url) })),
          );
          break;
        }
        const text = textDecoder.decode(bytes);
        const shown = this.detailTab === "preview" ? pretty(text) : text;
        const pre = h(
          "pre",
          { class: "dt-pre dt-code" },
          shown.length > 400000 ? `${shown.slice(0, 400000)}\n…` : shown,
        );
        content.append(
          r.truncated ? h("div", { class: "dt-note" }, "Showing the first 2 MB.") : "",
          pre,
        );
        if (shown.length < 200000) {
          const nodes = await this.host.highlight(shown, languageOf(r.url, r.mime));
          if (nodes) pre.replaceChildren(...nodes);
        }
        break;
      }
      case "timing":
        content.append(
          kvTable([
            ["Started", new Date(r.startMs).toLocaleTimeString()],
            ["Waiting (time to first byte)", formatMs(r.ttfbMs)],
            ["Content download", formatMs(Math.max(0, r.durationMs - r.ttfbMs))],
            ["Total", formatMs(r.durationMs)],
            ["Size", formatBytes(r.size)],
          ]),
        );
        break;
    }
  }

  private contextMenu(e: MouseEvent, r: NetRequest): void {
    const { host } = this;
    host.menu(e, [
      { label: "Copy URL", icon: "copy", run: () => host.copy(r.url) },
      {
        label: "Copy as cURL",
        run: () =>
          void (async () => {
            const body = r.hasRequestBody ? await host.body(r, "request") : null;
            host.copy(curlOf(r, body ? textDecoder.decode(body) : null));
          })(),
      },
      {
        label: "Copy response",
        run: () => void host.body(r, "response").then((b) => b && host.copy(textDecoder.decode(b))),
      },
      {
        label: "Open in new tab",
        icon: "globe",
        separatorBefore: true,
        run: () => host.run("browser.open", { url: r.url, newTab: true }),
      },
      { label: "Show in Sources", run: () => host.revealSource(r.url) },
      {
        label: "Open in editor",
        run: () =>
          void host.workspaceFile(r.url).then((path) => {
            if (path) host.run("editor.openFile", { path });
            else
              host.services.notifications.show(
                "info",
                "That request doesn't map to a file in this folder.",
              );
          }),
      },
    ]);
  }

  reveal(id: string): void {
    this.type = "all";
    this.filter = "";
    this.render();
    this.select(id);
    this.rows.querySelector(`[data-key="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }

  dispose(): void {
    this.store.dispose();
  }
}

/** JSON pretty-printed; anything else as is. */
function pretty(text: string): string {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}
