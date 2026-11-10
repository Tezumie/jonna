// DevTools Performance (D146, D147): record (or reload and record) the page as Chrome does and
// see it on a timeline (timeline.ts); the page's load (time to first byte, first and largest
// contentful paint, layout shift, DOMContentLoaded, load, blocking time) rated like Lighthouse's
// Core Web Vitals, what it downloaded by type, its slowest requests, DOM size and memory. The
// engine decides what's measurable: WebView2 (Chromium) reports everything; WebKit has no LCP,
// CLS, long tasks, interactions or memory, and those show as not available.
import { h, on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { effect } from "../../../core/reactive/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import {
  type DevtoolsHost,
  type DevtoolsPanel,
  formatBytes,
  formatMs,
  iconButton,
  shortName,
} from "./common";
import type { PerfRecording } from "./perfModel";
import { PerfTimeline } from "./timeline";

export interface PerfSummary {
  url: string;
  navigation: {
    ttfb: number;
    domInteractive: number;
    domContentLoaded: number;
    load: number;
    transfer: number;
    type: string;
  } | null;
  fcp: number | null;
  fp: number | null;
  lcp: number | null;
  cls: number;
  supported: { lcp?: boolean; cls?: boolean; longTasks?: boolean };
  longTasks: { count: number; blocking: number };
  resources: {
    count: number;
    bytes: number;
    byType: Record<string, { count: number; bytes: number; time: number }>;
  };
  slowest: { url: string; type: string; duration: number; size: number }[];
  dom: { nodes: number; depth: number };
  memory: { used: number; total: number; limit: number } | null;
}

export type { PerfRecording } from "./perfModel";

type Rating = "good" | "ok" | "poor" | "none";

/** Web Vitals thresholds (good below the first, poor above the second). */
const THRESHOLDS: Record<string, [number, number]> = {
  ttfb: [800, 1800],
  fcp: [1800, 3000],
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  tbt: [200, 600],
};

export function rate(metric: string, value: number | null): Rating {
  const t = THRESHOLDS[metric];
  if (!t || value === null) return "none";
  return value <= t[0] ? "good" : value <= t[1] ? "ok" : "poor";
}

/** Recording statistics: average and lowest frame rate, long tasks, blocking time, heap growth. */
export function recordingStats(r: PerfRecording) {
  const fps = r.samples.map((s) => s.fps);
  const heaps = r.samples.flatMap((s) => (s.heap === undefined ? [] : [s.heap]));
  return {
    averageFps: fps.length ? Math.round(fps.reduce((a, b) => a + b, 0) / fps.length) : null,
    lowestFps: fps.length ? Math.min(...fps) : null,
    longTasks: r.longTasks.length,
    blocking: r.longTasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0),
    heapChange: heaps.length > 1 ? (heaps.at(-1) ?? 0) - (heaps[0] ?? 0) : null,
  };
}

/** Where a value sits on its metric's scale: good, needs improvement, poor (the last open-ended). */
function gauge(metric: string, value: number): HTMLElement | null {
  const t = THRESHOLDS[metric];
  if (!t) return null;
  const max = t[1] * 1.5;
  const at = Math.min(1, Math.max(0, value / max)) * 100;
  return h(
    "span",
    { class: "dt-gauge", "aria-hidden": "true" },
    h("span", { class: "dt-gauge-seg is-good", style: { "flex-grow": String(t[0]) } }),
    h("span", { class: "dt-gauge-seg is-ok", style: { "flex-grow": String(t[1] - t[0]) } }),
    h("span", { class: "dt-gauge-seg is-poor", style: { "flex-grow": String(max - t[1]) } }),
    h("span", { class: "dt-gauge-mark", style: { left: `${at}%` } }),
  );
}

const RATING_LABEL: Record<Rating, string> = {
  good: "Good",
  ok: "Needs work",
  poor: "Poor",
  none: "",
};

type RecordState =
  | { kind: "idle" }
  /**
   * Waiting for the new document: the old one still answers meanwhile, told apart by its time
   * origin (unload messages don't always arrive, so the connection may never look dropped).
   */
  | { kind: "reloading"; origin: number | null; since: number; retried: boolean }
  | { kind: "recording"; since: number; restarted: boolean };

export class PerformancePanel implements DevtoolsPanel {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  private readonly body: HTMLElement;
  private readonly status: HTMLElement;
  private readonly pulse: HTMLElement;
  private readonly statusTitle: HTMLElement;
  private readonly statusNote: HTMLElement;
  private readonly results: HTMLElement;
  private readonly recordButton: HTMLButtonElement;
  private readonly reloadButton: HTMLButtonElement;
  private readonly zoomOut: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private state: RecordState = { kind: "idle" };
  private last: PerfRecording | null = null;
  private timeline: PerfTimeline | null = null;
  private memory = true;
  private timer = 0;
  private live: { fps: number | null; heap: number | null } = { fps: null, heap: null };

  constructor(private readonly host: DevtoolsHost) {
    const s = this.store;
    const run = (action: string) => () => host.run("browser.record", { tab: host.tabId, action });
    this.recordButton = h(
      "button",
      { class: "dt-chip dt-record", type: "button", "aria-pressed": "false" },
      icon("circle-dot"),
      h("span", { class: "dt-label" }, "Record"),
    );
    setTooltip(this.recordButton, "Record what the page does while you use it");
    s.add(
      on(this.recordButton, "click", () =>
        this.state.kind === "idle" ? run("start")() : run("stop")(),
      ),
    );
    this.reloadButton = h(
      "button",
      { class: "dt-chip dt-record-reload", type: "button" },
      icon("rotate-cw"),
      h("span", { class: "dt-label" }, "Reload and record"),
    );
    setTooltip(this.reloadButton, "Reload the page and record from its start until you stop");
    s.add(on(this.reloadButton, "click", run("reload")));
    this.zoomOut = iconButton(s, "zoom-out", "Show the whole recording", () =>
      this.timeline?.showAll(),
    );
    this.clearButton = iconButton(s, "trash-2", "Clear the recording", () => {
      this.last = null;
      this.recordingEl = null;
      void this.refresh();
    });
    const memory = h(
      "label",
      { class: "dt-check" },
      h("input", { class: "checkbox", type: "checkbox", checked: true }),
      h("span", null, "Memory"),
    );
    setTooltip(memory, "Show the JavaScript heap and DOM nodes in the recording");
    s.add(
      on(memory, "change", (e) => {
        this.memory = (e.target as HTMLInputElement).checked;
        this.showRecording();
      }),
    );
    const toolbar = h(
      "div",
      { class: "dt-toolbar" },
      this.recordButton,
      this.reloadButton,
      h("span", { class: "dt-sep" }),
      iconButton(s, "refresh-cw", "Measure the load again", () => void this.refresh()),
      this.zoomOut,
      this.clearButton,
      memory,
      h("span", { class: "dt-spacer" }),
    );
    this.pulse = h("span", { class: "dt-perf-pulse" });
    this.statusTitle = h("strong", null);
    this.statusNote = h("span", { class: "dt-note" });
    const stop = h(
      "button",
      { class: "button button-secondary dt-perf-stop", type: "button" },
      icon("square"),
      "Stop",
    );
    s.add(on(stop, "click", run("stop")));
    this.status = h(
      "div",
      { class: "dt-perf-status", hidden: true },
      h(
        "div",
        { class: "dt-perf-status-card" },
        this.pulse,
        h("div", { class: "dt-perf-status-text" }, this.statusTitle, this.statusNote),
        stop,
      ),
    );
    this.results = h("div", { class: "dt-perf-results" });
    this.body = h("div", { class: "dt-perf" }, this.status, this.results);
    this.element = h("div", { class: "dt-panel dt-performance" }, toolbar, this.body);
    s.add({ dispose: () => clearInterval(this.timer) });
    // A new document while recording (reload and record, or the page navigated): record it from
    // its start.
    // (The poll checks too; this is quicker when a new document's bridge says it's ready.)
    let documents = host.page.documents.peek();
    s.add(
      effect(() => {
        const n = host.page.documents.value;
        if (n !== documents && this.state.kind !== "idle") void this.poll();
        documents = n;
        return undefined;
      }),
    );
    this.syncToolbar();
  }

  onShow(): void {
    if (this.state.kind === "idle") void this.refresh();
  }

  get isRecording(): boolean {
    return this.state.kind !== "idle";
  }

  /** Starts recording (`browser.record`). */
  async start(): Promise<void> {
    if (this.state.kind !== "idle") return;
    await this.host.page.call("perf.record", { on: true });
    this.state = { kind: "recording", since: Date.now(), restarted: false };
    this.startTicking();
  }

  /** Reloads the page and records it from its start until stopped (Chrome's reload and record). */
  async reloadAndRecord(): Promise<void> {
    if (this.state.kind !== "idle") await this.stop().catch(() => null);
    const origin = await this.peek().then(
      (p) => p.origin ?? null,
      () => null,
    );
    this.state = { kind: "reloading", origin, since: Date.now(), retried: false };
    this.startTicking();
    this.host.reload();
  }

  private peek(): Promise<{
    recording: boolean;
    fps?: number | null;
    heap?: number | null;
    origin?: number;
  }> {
    return this.host.page.call("perf.record", { peek: true });
  }

  /** Stops and shows the recording; null when there was nothing recorded. */
  async stop(): Promise<PerfRecording | null> {
    if (this.state.kind === "idle") return this.last;
    clearInterval(this.timer);
    this.state = { kind: "idle" };
    let rec: PerfRecording | null = null;
    try {
      rec = await this.host.page.call<PerfRecording>("perf.record", { on: false });
    } catch (err) {
      this.host.services.notifications.show(
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
    this.syncToolbar();
    if (rec && rec.duration > 0) {
      this.last = rec;
      this.recordingEl = null;
    }
    await this.refresh();
    return rec && rec.duration > 0 ? rec : null;
  }

  private startTicking(): void {
    clearInterval(this.timer);
    this.syncToolbar();
    this.timer = window.setInterval(() => void this.poll(), 300);
    void this.poll();
  }

  /** Restarts the recording in a new document, from its start. */
  private async restart(): Promise<void> {
    try {
      await this.host.page.call("perf.record", { on: true, fromNavigation: true });
      this.state = { kind: "recording", since: Date.now(), restarted: true };
    } catch {
      /* not connected yet: the poll retries */
    }
  }

  private polling = false;

  private async poll(): Promise<void> {
    if (this.polling || this.state.kind === "idle") return;
    this.polling = true;
    try {
      const state = this.state;
      const peek = await this.peek().catch(() => null);
      if (state !== this.state || !peek) return;
      if (state.kind === "reloading") {
        // A new document (another time origin): record it from its start.
        if (peek.origin !== undefined && peek.origin !== state.origin) await this.restart();
        else if (!state.retried && Date.now() - state.since > 4000) {
          // The reload didn't happen (the page was busy, or swallowed it): once more.
          state.retried = true;
          this.host.reload();
        }
      } else if (!peek.recording) await this.restart();
      else this.live = { fps: peek.fps ?? null, heap: peek.heap ?? null };
    } finally {
      this.polling = false;
      this.renderStatus();
    }
  }

  private syncToolbar(): void {
    const on = this.state.kind !== "idle";
    this.recordButton.setAttribute("aria-pressed", String(on));
    this.recordButton.replaceChildren(
      icon(on ? "square" : "circle-dot"),
      h("span", { class: "dt-label" }, on ? "Stop" : "Record"),
    );
    setTooltip(
      this.recordButton,
      on ? "Stop and show the recording" : "Record what the page does while you use it",
    );
    this.reloadButton.disabled = on;
    this.zoomOut.hidden = on || !this.last;
    this.clearButton.hidden = on || !this.last;
    this.status.hidden = !on;
    this.results.hidden = on;
    if (on) this.renderStatus();
  }

  /** Chrome's status card while recording: what's happening, for how long, live readings. */
  private renderStatus(): void {
    const st = this.state;
    if (st.kind === "idle") return;
    const reloading = st.kind === "reloading";
    const seconds = st.kind === "recording" ? Math.floor((Date.now() - st.since) / 1000) : 0;
    this.pulse.classList.toggle("is-waiting", reloading);
    this.statusTitle.textContent = reloading
      ? "Reloading…"
      : st.restarted
        ? "Recording the page from its load"
        : "Recording";
    this.statusNote.textContent = reloading
      ? "Recording starts with the new page."
      : `${seconds} s · ${this.live.fps ?? "–"} fps${this.live.heap ? ` · heap ${formatBytes(this.live.heap)}` : ""}`;
  }

  async refresh(): Promise<void> {
    let summary: PerfSummary;
    try {
      summary = await this.host.page.call<PerfSummary>("perf.summary");
    } catch (err) {
      this.results.replaceChildren(
        h("div", { class: "dt-empty" }, err instanceof Error ? err.message : String(err)),
      );
      return;
    }
    if (this.state.kind !== "idle") return;
    // The recording keeps its zoom, selection and scroll when the panel comes back: only the
    // load metrics are measured again.
    if (this.last && !this.recordingEl) this.recordingEl = this.recordingSection(this.last);
    if (!this.last) {
      this.timeline?.dispose();
      this.timeline = null;
      this.recordingEl = null;
    }
    const scroll = this.body.scrollTop;
    this.results.replaceChildren(
      this.recordingEl ?? this.landing(),
      this.loadSection(summary),
      this.resourcesSection(summary),
      this.pageSection(summary),
    );
    this.body.scrollTop = scroll;
    this.syncToolbar();
  }

  /** The shown recording's section (kept while the recording is the same). */
  private recordingEl: HTMLElement | null = null;

  private showRecording(): void {
    const old = this.results.querySelector(".dt-perf-recording");
    if (!this.last || !old) return;
    this.recordingEl = this.recordingSection(this.last);
    old.replaceWith(this.recordingEl);
  }

  /** Before the first recording: what the two buttons do. */
  private landing(): HTMLElement {
    const hint = (name: "circle-dot" | "rotate-cw", text: string) =>
      h("div", { class: "dt-perf-hint" }, icon(name), h("span", null, text));
    return h(
      "section",
      { class: "dt-perf-section dt-perf-landing" },
      hint(
        "circle-dot",
        "Record, use the page, then stop to see frames, the main thread, requests and memory on a timeline.",
      ),
      hint("rotate-cw", "Reload and record captures the page's load from its first request."),
    );
  }

  private section(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
    return h(
      "section",
      { class: "dt-perf-section" },
      h("h3", { class: "dt-perf-title" }, title),
      ...children,
    );
  }

  /** A metric card: label and rating, value, and for rated metrics where it sits on the scale. */
  private metric(
    label: string,
    value: string,
    rating: Rating,
    hint: string,
    scale?: { key: string; value: number },
  ): HTMLElement {
    const el = h(
      "div",
      { class: `dt-metric is-${rating}` },
      h(
        "div",
        { class: "dt-metric-head" },
        h("span", { class: "dt-metric-label" }, label),
        rating === "none" ? null : h("span", { class: "dt-metric-rating" }, RATING_LABEL[rating]),
      ),
      h("span", { class: "dt-metric-value" }, value),
      scale && rating !== "none" ? gauge(scale.key, scale.value) : null,
    );
    setTooltip(el, hint);
    return el;
  }

  private loadSection(p: PerfSummary): HTMLElement {
    const ms = (v: number | null) => (v === null ? "not available" : formatMs(v));
    const n = p.navigation;
    const missing = (supported: boolean | undefined) =>
      supported === false
        ? "This engine doesn't report it (WebKit); WebView2 on Windows does."
        : "";
    const scale = (key: string, v: number | null | undefined) =>
      v === null || v === undefined ? undefined : { key, value: v };
    return this.section(
      "Page load",
      h(
        "div",
        { class: "dt-metrics" },
        this.metric(
          "Time to first byte",
          ms(n?.ttfb ?? null),
          rate("ttfb", n?.ttfb ?? null),
          "From the request to the first byte of the page. Good under 800 ms.",
          scale("ttfb", n?.ttfb),
        ),
        this.metric(
          "First contentful paint",
          ms(p.fcp),
          rate("fcp", p.fcp),
          "When the first text or image was painted. Good under 1.8 s.",
          scale("fcp", p.fcp),
        ),
        this.metric(
          "Largest contentful paint",
          ms(p.lcp),
          rate("lcp", p.lcp),
          missing(p.supported.lcp) ||
            "When the largest text or image was painted. Good under 2.5 s.",
          scale("lcp", p.lcp),
        ),
        this.metric(
          "Layout shift",
          p.supported.cls === false ? "not available" : String(p.cls),
          p.supported.cls === false ? "none" : rate("cls", p.cls),
          missing(p.supported.cls) ||
            "How much the layout moved unexpectedly (CLS). Good under 0.1.",
          p.supported.cls === false ? undefined : scale("cls", p.cls),
        ),
        this.metric(
          "Total blocking time",
          p.supported.longTasks === false ? "not available" : formatMs(p.longTasks.blocking),
          p.supported.longTasks === false ? "none" : rate("tbt", p.longTasks.blocking),
          missing(p.supported.longTasks) ||
            `Time the main thread was busy beyond 50 ms at a time (${p.longTasks.count} long tasks). Good under 200 ms.`,
          p.supported.longTasks === false ? undefined : scale("tbt", p.longTasks.blocking),
        ),
        this.metric(
          "DOMContentLoaded",
          ms(n?.domContentLoaded ?? null),
          "none",
          "The HTML was parsed and its deferred scripts ran.",
        ),
        this.metric(
          "Load",
          ms(n?.load ?? null),
          "none",
          "Everything the page needed (images, styles…) finished loading.",
        ),
      ),
    );
  }

  private resourcesSection(p: PerfSummary): HTMLElement {
    const types = Object.entries(p.resources.byType).sort((a, b) => b[1].bytes - a[1].bytes);
    const max = Math.max(1, ...types.map(([, t]) => t.bytes));
    const network = this.host.page.requests.peek();
    return this.section(
      "Downloads",
      h(
        "div",
        { class: "dt-perf-table" },
        ...types.map(([type, t]) =>
          h(
            "div",
            { class: "dt-perf-row" },
            h("span", { class: "dt-perf-name" }, type),
            h(
              "span",
              { class: "dt-perf-bar" },
              h("span", { class: "dt-perf-fill", style: { width: `${(t.bytes / max) * 100}%` } }),
            ),
            h("span", { class: "dt-perf-num" }, `${t.count}`),
            h("span", { class: "dt-perf-num" }, formatBytes(t.bytes)),
          ),
        ),
        h(
          "div",
          { class: "dt-perf-row is-total" },
          h("span", { class: "dt-perf-name" }, "Total"),
          h("span", { class: "dt-perf-bar" }),
          h("span", { class: "dt-perf-num" }, `${p.resources.count}`),
          h(
            "span",
            { class: "dt-perf-num" },
            formatBytes(p.resources.bytes + (p.navigation?.transfer ?? 0)),
          ),
        ),
      ),
      p.slowest.length ? h("h4", { class: "dt-perf-subtitle" }, "Slowest requests") : null,
      h(
        "div",
        { class: "dt-perf-table" },
        ...p.slowest.map((r) => {
          const row = h(
            "button",
            { class: "dt-perf-row is-link", type: "button" },
            h("span", { class: "dt-perf-name" }, shortName(this.host.displayUrl(r.url))),
            h("span", { class: "dt-perf-type" }, r.type),
            h("span", { class: "dt-perf-num" }, formatMs(r.duration)),
            h("span", { class: "dt-perf-num" }, r.size ? formatBytes(r.size) : "–"),
          );
          setTooltip(row, this.host.displayUrl(r.url));
          const request = this.findRequest(r.url, network);
          this.store.add(
            on(row, "click", () => {
              if (request) this.host.revealRequest(request.id);
              else this.host.revealSource(r.url);
            }),
          );
          return row;
        }),
      ),
    );
  }

  private pageSection(p: PerfSummary): HTMLElement {
    return this.section(
      "Page",
      h(
        "div",
        { class: "dt-metrics" },
        this.metric(
          "DOM elements",
          String(p.dom.nodes),
          p.dom.nodes > 1500 ? "ok" : "none",
          "Lighthouse flags pages over about 1,500 elements.",
        ),
        this.metric(
          "DOM depth",
          String(p.dom.depth),
          p.dom.depth > 32 ? "ok" : "none",
          "Deep nesting makes style and layout slower (Lighthouse flags over 32).",
        ),
        this.metric(
          "JavaScript memory",
          p.memory
            ? `${formatBytes(p.memory.used)} of ${formatBytes(p.memory.total)}`
            : "not available",
          "none",
          p.memory
            ? `Limit ${formatBytes(p.memory.limit)}`
            : "This engine doesn't report it (WebKit); WebView2 on Windows does.",
        ),
      ),
    );
  }

  /**
   * Network's entry for a URL the page reported. Network lists URLs as the user knows them
   * (`displayUrl`), so both are compared that way, and with the query left out as a fallback
   * (a static preview's log has none).
   */
  private findRequest(
    url: string,
    requests = this.host.page.requests.peek(),
  ): import("../page").NetRequest | undefined {
    const shown = this.host.displayUrl(url);
    const bare = (u: string) => u.split(/[?#]/)[0] ?? u;
    const list = [...requests].reverse();
    return (
      list.find((q) => q.url === shown || q.url === url) ??
      list.find((q) => bare(q.url) === bare(shown))
    );
  }

  private recordingSection(r: PerfRecording): HTMLElement {
    this.timeline?.dispose();
    this.timeline = new PerfTimeline(r, {
      memory: this.memory,
      displayUrl: (url) => this.host.displayUrl(url),
      openRequest: (url) => {
        const request = this.findRequest(url);
        if (request) this.host.revealRequest(request.id);
        else this.host.revealSource(url);
      },
    });
    const section = this.section(
      `Recording · ${formatMs(r.duration)}${r.fromNavigation ? " · from the page's load" : ""}`,
      h(
        "div",
        { class: "dt-note dt-perf-help" },
        "Drag the overview to zoom, drag across the tracks to select. Ctrl+wheel zooms, Shift+wheel pans.",
      ),
      this.timeline.element,
    );
    section.classList.add("dt-perf-recording");
    return section;
  }

  dispose(): void {
    if (this.state.kind !== "idle")
      void this.host.page.call("perf.record", { on: false }).catch(() => {});
    this.timeline?.dispose();
    this.store.dispose();
  }
}
