// The Performance recording as Chrome draws it (D147): an overview of the whole recording (frame
// rate, long tasks, memory) where dragging picks the span shown; under it a time ruler and one
// track per kind of activity — frames (late and dropped ones colored), frames per second, the
// main thread's long tasks (the part over 50 ms hatched), network requests, interactions,
// timings (paint and load markers, the page's own marks), layout shifts and memory. Dragging
// across the tracks selects a range, summarized below; Ctrl+wheel zooms, Shift+wheel pans. The
// pointer shows a line across the tracks and a readout of what's under it.
import { h, on } from "../../../core/dom/index";
import { type Disposable, DisposableStore, MutableDisposable } from "../../../core/lifecycle/index";
import { formatBytes, formatMs, shortName } from "./common";
import {
  frameAt,
  frameSpans,
  type PerfRecording,
  type PerfRequest,
  packRows,
  type RangeStats,
  rangeStats,
  rateInteraction,
  sampleAt,
  tickLabel,
  tickStep,
  ticks,
} from "./perfModel";

const SVG = "http://www.w3.org/2000/svg";
const svg = (tag: string, attrs: Record<string, string | number>): SVGElement => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};
const asHtml = (el: SVGElement) => el as unknown as HTMLElement;
/** Pointer capture for a drag (a synthetic pointer, as in tests, can't be captured). */
const capture = (el: HTMLElement, pointerId: number) => {
  try {
    el.setPointerCapture(pointerId);
  } catch {
    /* not an active pointer */
  }
};

/** Request types as the Network panel colors them (document, style, script…). */
function requestKind(type: string): string {
  if (type === "document" || type === "navigation" || type === "iframe") return "doc";
  if (type === "css" || type === "link") return "css";
  if (type === "script") return "js";
  if (type === "img" || type === "image" || type === "video" || type === "audio") return "img";
  if (type === "fetch" || type === "xmlhttprequest" || type === "beacon") return "xhr";
  return "other";
}

export interface TimelineOptions {
  /** Draw the memory track. */
  memory: boolean;
  displayUrl(url: string): string;
  /** A request bar was clicked. */
  openRequest(url: string): void;
}

interface Track {
  id: string;
  label: string;
  height: number;
  draw(lane: HTMLElement, v0: number, v1: number): void;
}

export class PerfTimeline implements Disposable {
  readonly element: HTMLElement;
  private readonly store = new DisposableStore();
  /** Listeners of the drawn tracks (replaced on each redraw). */
  private readonly drawn = this.store.add(new MutableDisposable<DisposableStore>());
  private readonly overview: HTMLElement;
  private readonly windowEl: HTMLElement;
  private readonly dims: [HTMLElement, HTMLElement];
  private readonly main: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly cursor: HTMLElement;
  private readonly readout: HTMLElement;
  private readonly selectionEl: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly tracks: Track[];
  private v0 = 0;
  private v1: number;
  private selection: [number, number] | null = null;
  private readonly end: number;

  constructor(
    private readonly rec: PerfRecording,
    private readonly options: TimelineOptions,
  ) {
    this.end = Math.max(1, rec.duration);
    this.v1 = this.end;
    this.tracks = this.buildTracks();
    this.windowEl = h("div", { class: "dt-tl-window" });
    this.dims = [h("div", { class: "dt-tl-dim" }), h("div", { class: "dt-tl-dim" })];
    this.overview = h(
      "div",
      { class: "dt-tl-overview", "aria-label": "Overview: drag to choose the span shown" },
      this.overviewChart(),
      ...this.dims,
      this.windowEl,
    );
    this.grid = h("div", { class: "dt-tl-grid" });
    this.cursor = h("div", { class: "dt-tl-cursor", hidden: true });
    this.selectionEl = h("div", { class: "dt-tl-selection", hidden: true });
    this.readout = h("div", { class: "dt-tl-readout", hidden: true });
    this.overlay = h("div", { class: "dt-tl-overlay" }, this.selectionEl, this.cursor);
    this.main = h("div", { class: "dt-tl-main" });
    this.summary = h("div", { class: "dt-tl-summary" });
    this.element = h(
      "div",
      { class: "dt-tl" },
      this.overview,
      h("div", { class: "dt-tl-frame" }, this.grid, this.main, this.overlay, this.readout),
      this.summary,
    );
    this.wireOverview();
    this.wireMain();
    this.render();
    // The ruler's ticks follow the width.
    let width = 0;
    const observer = new ResizeObserver(() => {
      const w = this.overlay.clientWidth;
      if (Math.abs(w - width) < 40) return;
      width = w;
      this.render();
    });
    observer.observe(this.overlay);
    this.store.add({ dispose: () => observer.disconnect() });
  }

  /** Back to the whole recording. */
  showAll(): void {
    this.v0 = 0;
    this.v1 = this.end;
    this.selection = null;
    this.render();
  }

  /** Shows the selected range across the width. */
  zoomToSelection(): void {
    if (!this.selection) return;
    [this.v0, this.v1] = this.selection;
    this.selection = null;
    this.render();
  }

  get zoomed(): boolean {
    return this.v0 > 0 || this.v1 < this.end;
  }

  // ---- Tracks ---------------------------------------------------------------------------------

  private buildTracks(): Track[] {
    const r = this.rec;
    const tracks: Track[] = [];
    const frames = r.frames ?? [];
    if (frames.length > 1)
      tracks.push({
        id: "frames",
        label: "Frames",
        height: 18,
        draw: (l, a, b) => this.drawFrames(l, a, b),
      });
    tracks.push({ id: "fps", label: "FPS", height: 44, draw: (l, a, b) => this.drawFps(l, a, b) });
    tracks.push({
      id: "main",
      label: "Main thread",
      height: 24,
      draw: (l, a, b) => this.drawTasks(l, a, b),
    });
    const requests = r.requests ?? [];
    if (requests.length) {
      // Every request gets a row of its own when needed (stacking them made the labels
      // unreadable); past 8 rows the track scrolls.
      this.requestRows = packRows(requests, requests.length);
      const rows = Math.max(0, ...this.requestRows.map((p) => p.row)) + 1;
      this.networkRows = rows;
      tracks.push({
        id: "network",
        label: "Network",
        height: Math.min(rows, 8) * 15 + 4,
        draw: (l, a, b) => this.drawRequests(l, a, b),
      });
    }
    if (r.interactions?.length)
      tracks.push({
        id: "interactions",
        label: "Interactions",
        height: 20,
        draw: (l, a, b) => this.drawInteractions(l, a, b),
      });
    if (r.markers?.length || r.timings?.length)
      tracks.push({
        id: "timings",
        label: "Timings",
        height: r.timings?.some((t) => t.duration > 0) ? 38 : 20,
        draw: (l, a, b) => this.drawTimings(l, a, b),
      });
    if (r.shifts?.length)
      tracks.push({
        id: "shifts",
        label: "Layout shifts",
        height: 18,
        draw: (l, a, b) => this.drawShifts(l, a, b),
      });
    if (this.options.memory && r.samples.some((s) => s.heap !== undefined || s.nodes !== undefined))
      tracks.push({
        id: "memory",
        label: "Memory",
        height: 48,
        draw: (l, a, b) => this.drawMemory(l, a, b),
      });
    return tracks;
  }

  private pct(t: number, v0 = this.v0, v1 = this.v1): number {
    return ((t - v0) / Math.max(0.001, v1 - v0)) * 100;
  }

  /** A block at [start, start + duration] in the shown span, or null when outside it. */
  private block(
    cls: string,
    start: number,
    duration: number,
    info: string,
    ...children: (HTMLElement | string)[]
  ): HTMLElement | null {
    if (start + duration < this.v0 || start > this.v1) return null;
    const left = this.pct(start);
    const width = this.pct(start + duration) - left;
    return h(
      "div",
      {
        class: `dt-tl-block ${cls}`,
        "data-info": info,
        style: { left: `${left}%`, width: `${width}%` },
      },
      ...children,
    );
  }

  private drawFrames(lane: HTMLElement, v0: number, v1: number): void {
    const chart = svg("svg", {
      viewBox: `${v0} 0 ${Math.max(0.001, v1 - v0)} 1`,
      preserveAspectRatio: "none",
    });
    const gap = (v1 - v0) / 2000;
    for (const [start, d, rating] of frameSpans(this.rec.frames ?? [])) {
      if (start + d < v0 || start > v1) continue;
      chart.append(
        svg("rect", {
          class: `dt-tl-frame-box is-${rating}`,
          x: start,
          y: 0,
          width: Math.max(gap, d - gap),
          height: 1,
        }),
      );
    }
    lane.append(asHtml(chart));
  }

  /** Frames per second as a filled line (with the 60 fps line dashed). */
  private fpsChart(v0: number, v1: number, height = 1): SVGElement {
    const span = Math.max(0.001, v1 - v0);
    const chart = svg("svg", { viewBox: `${v0} 0 ${span} ${height}`, preserveAspectRatio: "none" });
    const y = (fps: number) => height - (Math.min(70, fps) / 70) * height;
    chart.append(svg("line", { class: "dt-tl-guide", x1: v0, x2: v1, y1: y(60), y2: y(60) }));
    const pts = this.rec.samples.map((s) => `${s.t},${y(s.fps)}`);
    if (pts.length) {
      const first = this.rec.samples[0];
      const last = this.rec.samples.at(-1);
      chart.append(
        svg("polygon", {
          class: "dt-tl-fps-area",
          points: `${first?.t ?? 0},${height} ${pts.join(" ")} ${last?.t ?? 0},${height}`,
        }),
        svg("polyline", { class: "dt-tl-fps-line", points: pts.join(" ") }),
      );
    }
    return chart;
  }

  private drawFps(lane: HTMLElement, v0: number, v1: number): void {
    lane.append(asHtml(this.fpsChart(v0, v1)));
  }

  private drawTasks(lane: HTMLElement, _v0: number, _v1: number): void {
    if (this.rec.supported.longTasks === false) {
      lane.append(
        h("span", { class: "dt-tl-na" }, "Long tasks: not reported by this engine (WebKit)"),
      );
      return;
    }
    for (const t of this.rec.longTasks) {
      const over = Math.max(0, t.duration - 50);
      const el = this.block(
        "is-task",
        t.start,
        t.duration,
        `Long task · ${formatMs(t.duration)} (${formatMs(over)} blocking) at ${formatMs(t.start)}`,
        h("span", { class: "dt-tl-task-over", style: { left: `${(50 / t.duration) * 100}%` } }),
      );
      if (el) lane.append(el);
    }
  }

  private requestRows: { item: PerfRequest; row: number }[] = [];
  private networkRows = 0;
  /** The network track's vertical scroll (kept when zooming redraws it). */
  private networkScroll = 0;

  private drawRequests(lane: HTMLElement, _v0: number, _v1: number): void {
    const inner = h("div", {
      class: "dt-tl-lane-inner",
      style: { height: `${this.networkRows * 15 + 4}px` },
    });
    lane.append(inner);
    if (this.networkRows > 8) {
      lane.classList.add("is-scrolling");
      this.drawn.value?.add(
        on(lane, "scroll", () => {
          this.networkScroll = lane.scrollTop;
        }),
      );
      requestAnimationFrame(() => {
        lane.scrollTop = this.networkScroll;
      });
    }
    for (const { item: q, row } of this.requestRows) {
      const url = this.options.displayUrl(q.url);
      const duration = Math.max(1, q.end - q.start);
      const el = this.block(
        `is-request is-${requestKind(q.type)}`,
        q.start,
        duration,
        `${shortName(url)} · ${q.type} · ${formatMs(duration)}${q.size ? ` · ${formatBytes(q.size)}` : ""}`,
        h("span", { class: "dt-tl-label" }, shortName(url)),
      );
      if (!el) continue;
      el.style.top = `${2 + row * 15}px`;
      el.dataset.url = q.url;
      inner.append(el);
    }
  }

  private drawInteractions(lane: HTMLElement, _v0: number, _v1: number): void {
    for (const e of this.rec.interactions ?? []) {
      const el = this.block(
        `is-interaction is-${rateInteraction(e.duration)}`,
        e.start,
        e.duration,
        `${e.name}${e.target ? ` on ${e.target}` : ""} · ${formatMs(e.duration)} until the next paint${e.processing !== undefined ? ` (handlers ${formatMs(e.processing)})` : ""}`,
        h("span", { class: "dt-tl-label" }, e.name),
      );
      if (el) lane.append(el);
    }
  }

  private drawTimings(lane: HTMLElement, _v0: number, _v1: number): void {
    for (const m of this.rec.markers ?? []) {
      if (m.t < this.v0 || m.t > this.v1) continue;
      lane.append(
        h(
          "div",
          {
            class: `dt-tl-marker is-${m.name.toLowerCase()}`,
            "data-info": `${m.label} · ${formatMs(m.t)}`,
            style: { left: `${this.pct(m.t)}%` },
          },
          m.name,
        ),
      );
    }
    for (const t of this.rec.timings ?? []) {
      const el =
        t.duration > 0
          ? this.block(
              "is-measure",
              t.start,
              t.duration,
              `${t.name} · ${formatMs(t.duration)}`,
              h("span", { class: "dt-tl-label" }, t.name),
            )
          : t.start >= this.v0 && t.start <= this.v1
            ? h("div", {
                class: "dt-tl-mark",
                "data-info": `performance.mark("${t.name}") · ${formatMs(t.start)}`,
                style: { left: `${this.pct(t.start)}%` },
              })
            : null;
      if (!el) continue;
      if (t.duration > 0) el.style.top = "20px";
      lane.append(el);
    }
  }

  private drawShifts(lane: HTMLElement, _v0: number, _v1: number): void {
    for (const s of this.rec.shifts ?? []) {
      if (s.t < this.v0 || s.t > this.v1) continue;
      lane.append(
        h("div", {
          class: "dt-tl-shift",
          "data-info": `Layout shift · ${s.value} at ${formatMs(s.t)}`,
          style: { left: `${this.pct(s.t)}%` },
        }),
      );
    }
  }

  private drawMemory(lane: HTMLElement, v0: number, v1: number): void {
    const span = Math.max(0.001, v1 - v0);
    const chart = svg("svg", { viewBox: `${v0} 0 ${span} 1`, preserveAspectRatio: "none" });
    const line = (key: "heap" | "nodes", cls: string) => {
      const pts = this.rec.samples.filter((s) => s[key] !== undefined);
      if (pts.length < 2) return;
      const values = pts.map((s) => s[key] ?? 0);
      const lo = Math.min(...values);
      const hi = Math.max(lo + 1, ...values);
      chart.append(
        svg("polyline", {
          class: cls,
          points: pts
            .map((s) => `${s.t},${0.92 - (((s[key] ?? lo) - lo) / (hi - lo)) * 0.84}`)
            .join(" "),
        }),
      );
    };
    line("heap", "dt-tl-heap");
    line("nodes", "dt-tl-nodes");
    lane.append(asHtml(chart));
  }

  // ---- Overview -------------------------------------------------------------------------------

  private overviewChart(): HTMLElement {
    const chart = this.fpsChart(0, this.end, 1);
    chart.classList.add("dt-tl-overview-chart");
    for (const t of this.rec.longTasks)
      chart.append(
        svg("rect", {
          class: "dt-tl-overview-task",
          x: t.start,
          y: 0,
          width: t.duration,
          height: 0.16,
        }),
      );
    for (const m of this.rec.markers ?? [])
      if (m.name === "L" || m.name === "DCL" || m.name === "FCP")
        chart.append(
          svg("line", {
            class: `dt-tl-overview-marker is-${m.name.toLowerCase()}`,
            x1: m.t,
            x2: m.t,
            y1: 0,
            y2: 1,
          }),
        );
    return asHtml(chart);
  }

  private timeAt(el: HTMLElement, clientX: number, v0: number, v1: number): number {
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    return v0 + f * (v1 - v0);
  }

  private wireOverview(): void {
    let from: number | null = null;
    this.store.add(
      on(this.overview, "pointerdown", (e) => {
        if (e.button !== 0) return;
        capture(this.overview, e.pointerId);
        from = this.timeAt(this.overview, e.clientX, 0, this.end);
      }),
    );
    this.store.add(
      on(this.overview, "pointermove", (e) => {
        if (from === null) return;
        const t = this.timeAt(this.overview, e.clientX, 0, this.end);
        if (Math.abs(this.pct(t, 0, this.end) - this.pct(from, 0, this.end)) < 0.5) return;
        this.v0 = Math.min(from, t);
        this.v1 = Math.max(from + 0.001, t, this.v0 + Math.min(5, this.end));
        this.selection = null;
        this.render();
      }),
    );
    const up = () => {
      from = null;
    };
    this.store.add(on(this.overview, "pointerup", up));
    this.store.add(on(this.overview, "pointercancel", up));
    this.store.add(on(this.overview, "dblclick", () => this.showAll()));
  }

  // ---- Tracks: hover, select, zoom ------------------------------------------------------------

  private wireMain(): void {
    let from: number | null = null;
    let fromX = 0;
    /** The request bar pressed (a click without a drag opens it in Network). */
    let bar: string | undefined;
    const lanesTime = (clientX: number) => this.timeAt(this.overlay, clientX, this.v0, this.v1);
    this.store.add(
      on(this.main, "pointerdown", (e) => {
        if (e.button !== 0 || !this.inLanes(e.clientX)) return;
        bar = (e.target as Element).closest<HTMLElement>("[data-url]")?.dataset.url;
        capture(this.main, e.pointerId);
        from = lanesTime(e.clientX);
        fromX = e.clientX;
      }),
    );
    this.store.add(
      on(this.main, "pointermove", (e) => {
        this.hover(e);
        if (from === null || Math.abs(e.clientX - fromX) < 3) return;
        const t = lanesTime(e.clientX);
        this.selection = [Math.min(from, t), Math.max(from, t)];
        this.drawSelection();
      }),
    );
    const up = (e: PointerEvent) => {
      if (from === null) return;
      if (Math.abs(e.clientX - fromX) < 3) {
        this.selection = null;
        this.drawSelection();
        if (bar) this.options.openRequest(bar);
      }
      from = null;
      this.renderSummary();
    };
    this.store.add(on(this.main, "pointerup", up));
    this.store.add(on(this.main, "pointercancel", up));
    this.store.add(
      on(this.main, "pointerleave", () => {
        this.cursor.hidden = true;
        this.readout.hidden = true;
      }),
    );
    this.store.add(
      on(
        this.main,
        "wheel",
        (e) => {
          const pan = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
          if (!(e.ctrlKey || e.metaKey) && !pan) return;
          e.preventDefault();
          const span = this.v1 - this.v0;
          if (pan) {
            const d =
              ((e.shiftKey ? e.deltaY : e.deltaX) / Math.max(1, this.overlay.clientWidth)) * span;
            const shift = Math.max(-this.v0, Math.min(this.end - this.v1, d));
            this.v0 += shift;
            this.v1 += shift;
          } else {
            const at = lanesTime(e.clientX);
            const k = e.deltaY > 0 ? 1.25 : 0.8;
            const next = Math.max(Math.min(5, this.end), Math.min(this.end, span * k));
            const f = (at - this.v0) / span;
            this.v0 = Math.max(0, at - f * next);
            this.v1 = Math.min(this.end, this.v0 + next);
            this.v0 = Math.max(0, this.v1 - next);
          }
          this.render();
        },
        { passive: false },
      ),
    );
  }

  private inLanes(clientX: number): boolean {
    const r = this.overlay.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right;
  }

  private hover(e: PointerEvent): void {
    if (!this.inLanes(e.clientX)) {
      this.cursor.hidden = true;
      this.readout.hidden = true;
      return;
    }
    const r = this.overlay.getBoundingClientRect();
    const t = this.timeAt(this.overlay, e.clientX, this.v0, this.v1);
    this.cursor.hidden = false;
    this.cursor.style.left = `${e.clientX - r.left}px`;
    const item = (e.target as Element).closest<HTMLElement>("[data-info]")?.dataset.info;
    const sample = sampleAt(this.rec.samples, t);
    const frame = frameAt(this.rec.frames ?? [], t);
    const lines: string[] = [formatMs(t)];
    if (item) lines.push(item);
    else {
      if (frame)
        lines.push(`Frame ${formatMs(frame[1])} (${Math.round(1000 / Math.max(1, frame[1]))} fps)`);
      else if (sample) lines.push(`${sample.fps} fps`);
      if (sample?.heap !== undefined) lines.push(`Heap ${formatBytes(sample.heap)}`);
      if (sample?.nodes !== undefined) lines.push(`${sample.nodes} DOM nodes`);
    }
    this.readout.replaceChildren(
      h("strong", null, lines[0] ?? ""),
      ...lines.slice(1).map((l) => h("span", null, l)),
    );
    this.readout.hidden = false;
    const frame0 = this.readout.parentElement?.getBoundingClientRect();
    if (!frame0) return;
    const x = e.clientX - frame0.left;
    const y = e.clientY - frame0.top;
    const w = this.readout.offsetWidth;
    this.readout.style.left = `${x + 12 + w > frame0.width ? Math.max(0, x - 12 - w) : x + 12}px`;
    this.readout.style.top = `${Math.max(0, Math.min(frame0.height - this.readout.offsetHeight, y + 12))}px`;
  }

  private drawSelection(): void {
    const sel = this.selection;
    this.selectionEl.hidden = !sel;
    if (!sel) return;
    const left = Math.max(0, this.pct(sel[0]));
    const right = Math.min(100, this.pct(sel[1]));
    this.selectionEl.style.left = `${left}%`;
    this.selectionEl.style.width = `${Math.max(0, right - left)}%`;
    this.selectionEl.dataset.label = formatMs(sel[1] - sel[0]);
  }

  // ---- Rendering ------------------------------------------------------------------------------

  private render(): void {
    const { v0, v1 } = this;
    // Overview window.
    const l = this.pct(v0, 0, this.end);
    const r = this.pct(v1, 0, this.end);
    this.windowEl.style.left = `${l}%`;
    this.windowEl.style.width = `${Math.max(0.3, r - l)}%`;
    this.dims[0].style.width = `${l}%`;
    this.dims[1].style.left = `${r}%`;
    this.dims[1].style.width = `${100 - r}%`;

    // Ruler and grid lines.
    const target = Math.max(3, Math.round((this.overlay.clientWidth || 600) / 90));
    const step = tickStep(v1 - v0, target);
    const ruler = h("div", { class: "dt-tl-lane dt-tl-ruler" });
    this.grid.replaceChildren();
    for (const t of ticks(v0, v1, target)) {
      const left = `${this.pct(t)}%`;
      ruler.append(h("span", { class: "dt-tl-tick", style: { left } }, tickLabel(t, step)));
      this.grid.append(h("span", { class: "dt-tl-gridline", style: { left } }));
    }
    for (const m of this.rec.markers ?? [])
      if (m.t >= v0 && m.t <= v1)
        this.grid.append(
          h("span", {
            class: `dt-tl-gridline is-marker is-${m.name.toLowerCase()}`,
            style: { left: `${this.pct(m.t)}%` },
          }),
        );

    this.drawn.value = new DisposableStore();
    const rows: HTMLElement[] = [
      h("div", { class: "dt-tl-track is-ruler" }, h("div", { class: "dt-tl-head" }), ruler),
    ];
    for (const track of this.tracks) {
      const lane = h("div", { class: `dt-tl-lane is-${track.id}` });
      track.draw(lane, v0, v1);
      rows.push(
        h(
          "div",
          { class: `dt-tl-track is-${track.id}`, style: { height: `${track.height}px` } },
          h(
            "div",
            { class: "dt-tl-head" },
            h("span", { class: "dt-tl-head-label" }, track.label),
            track.id === "memory" ? this.memoryKey() : null,
          ),
          lane,
        ),
      );
    }
    this.main.replaceChildren(...rows);
    this.drawSelection();
    this.renderSummary();
  }

  private memoryKey(): HTMLElement {
    return h(
      "span",
      { class: "dt-tl-keys" },
      h("span", { class: "dt-tl-key is-heap" }, "Heap"),
      h("span", { class: "dt-tl-key is-nodes" }, "Nodes"),
    );
  }

  private renderSummary(): void {
    const [a, b] = this.selection ?? [this.v0, this.v1];
    const s = rangeStats(this.rec, a, b);
    const title = this.selection
      ? `Selection · ${formatMs(a)} – ${formatMs(b)}`
      : this.zoomed
        ? `Shown · ${formatMs(a)} – ${formatMs(b)}`
        : "Whole recording";
    this.summary.replaceChildren(
      h(
        "div",
        { class: "dt-tl-summary-title" },
        h("span", null, title),
        h("span", { class: "dt-note" }, formatMs(s.duration)),
      ),
      h("div", { class: "dt-tl-stats" }, ...this.stats(s)),
    );
  }

  private stats(s: RangeStats): HTMLElement[] {
    const stat = (label: string, value: string, tone = "") =>
      h(
        "div",
        { class: `dt-tl-stat${tone ? ` is-${tone}` : ""}` },
        h("span", { class: "dt-tl-stat-value" }, value),
        h("span", { class: "dt-tl-stat-label" }, label),
      );
    const out = [
      stat(
        "Frames per second",
        s.averageFps === null ? "–" : String(s.averageFps),
        s.averageFps === null
          ? ""
          : s.averageFps >= 55
            ? "good"
            : s.averageFps >= 30
              ? "ok"
              : "poor",
      ),
      stat("Dropped frames", `${s.dropped} of ${s.frames}`, s.dropped ? "ok" : ""),
    ];
    if (this.rec.supported.longTasks !== false)
      out.push(
        stat(
          "Long tasks",
          s.longTasks ? `${s.longTasks} · ${formatMs(s.blocking)} blocking` : "None",
          s.blocking > 600 ? "poor" : s.blocking > 200 ? "ok" : "",
        ),
      );
    if (this.rec.requests?.length)
      out.push(stat("Requests", s.requests ? `${s.requests} · ${formatBytes(s.bytes)}` : "None"));
    if (s.slowestInteraction)
      out.push(
        stat(
          "Slowest interaction",
          `${s.slowestInteraction.name} · ${formatMs(s.slowestInteraction.duration)}`,
          rateInteraction(s.slowestInteraction.duration),
        ),
      );
    if (this.rec.shifts?.length)
      out.push(
        stat(
          "Layout shift",
          String(s.layoutShift),
          s.layoutShift > 0.25 ? "poor" : s.layoutShift > 0.1 ? "ok" : "",
        ),
      );
    if (s.heap)
      out.push(
        stat(
          "JavaScript heap",
          s.heap.min === s.heap.max
            ? formatBytes(s.heap.max)
            : `${formatBytes(s.heap.min)} – ${formatBytes(s.heap.max)}`,
        ),
      );
    return out;
  }

  dispose(): void {
    this.store.dispose();
    this.element.remove();
  }
}
