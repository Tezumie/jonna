// browser.* commands for DevTools data — what an agent (or the user, or MCP) needs beyond the
// page outline: requests with headers and bodies, DOM and CSS of an element, storage, highlight
// and the picker, device sizes, showing DevTools. Each one works on a tab (default: the active
// or most recent browser tab). D347: the user's own browser ("external") answers network,
// request, dom, styles, storage, setStorage, highlight and resize over the DevTools protocol
// (externalDevtools.ts), with the same outputs.

import { coordinateFrame } from "../../core/agent/browserInput";
import { browserIpc } from "../../core/ipc/browser";
import { s } from "../../core/schema/index";
import { base64, cropShot, MODEL_MAX_SIDE, type Shot, saveShot } from "../../workbench/screenshot";
import type { WorkbenchServices } from "../../workbench/services";
import { viewportFor } from "./devices";
import { DEVTOOLS_TABS } from "./devtools/index";
import { requestType } from "./devtools/network";
import { rangeStats } from "./devtools/perfModel";
import {
  type PerformancePanel,
  type PerfRecording,
  type PerfSummary,
  rate,
  recordingStats,
} from "./devtools/performance";
import type { PageTarget } from "./external";
import type { BrowserHost, BrowserView } from "./view";

const tabInput = s
  .string()
  .describe("Browser tab id (default: the active or most recent browser tab)")
  .optional();
const decoder = new TextDecoder();

type Register = WorkbenchServices["dispatcher"]["register"];

/** Element ref (from a snapshot) or CSS selector → ref. */
async function refOf(view: BrowserView, ref?: string, selector?: string): Promise<string> {
  if (ref) return ref;
  if (!selector) throw new Error("Give a ref (from browser.snapshot) or a selector.");
  const r = await view.page.call<{ matches: { id: string }[] }>("dom.query", {
    selector,
    limit: 1,
  });
  const first = r.matches[0];
  if (!first) throw new Error(`Nothing matches ${selector}.`);
  return first.id;
}

export function registerDevtoolsCommands(
  register: Register,
  target: (tab?: string) => BrowserView,
  host: BrowserHost,
  /** A tab or the user's own browser (D341): screenshots of either. */
  pageTarget: (tab?: string) => PageTarget,
): void {
  register({
    id: "browser.popOut",
    title: "Browser: open in its own window",
    description:
      "Moves a browser tab's page into its own window (the tab keeps the address bar, DevTools and agent tools; live reload keeps working), or back into the tab with `window: false`. Default: toggle.",
    input: s.object({ tab: tabInput, window: s.boolean().optional() }),
    effects: [],
    agent: "discoverable",
    run: async ({ tab, window: out }) => {
      const view = target(tab);
      await view.popOut(out);
      return { window: view.poppedOut };
    },
  });
  register({
    id: "browser.screenshot",
    title: "Take screenshot of page",
    description:
      "A PNG of the page in a browser tab as it is shown (device size included, no toolbar or DevTools). `save` writes it under the workspace's IDE folder (screenshots/) and `open` shows it; `inline` returns it as base64 `png` for agents, at the size of its coordinate `frame` (the viewport, scaled to fit 1568 px: browser.input's points), times `scale`; `region` [x0, y0, x1, y1] of the frame zooms into that part at full detail.",
    input: s.object({
      tab: tabInput,
      save: s.boolean().describe("Save it as a file (default true unless inline)").optional(),
      open: s.boolean().describe("Open the saved file in a tab").optional(),
      inline: s.boolean().describe("Return the image as base64").optional(),
      region: s
        .array(s.number())
        .describe("inline: [x0, y0, x1, y1] of the coordinate frame to zoom into")
        .optional(),
      scale: s.number({ min: 0.1, max: 1 }).describe("inline: a smaller image").optional(),
      ifShown: s
        .boolean()
        .describe("Only if the page is on screen: never brings its tab forward (recordings)")
        .optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ tab, save, open, inline, region, scale, ifShown }) => {
      const view = pageTarget(tab);
      if (ifShown && "onScreen" in view && !view.onScreen)
        throw new Error("The page isn't on screen.");
      let frame: { width: number; height: number } | null = null;
      let shot: Shot;
      if (inline) {
        const info = await view.page
          .call<{ viewport?: { width: number; height: number } }>("info")
          .catch(() => null);
        const raw = await view.capture();
        const f = coordinateFrame(info?.viewport ?? { width: raw.width, height: raw.height });
        frame = { width: f.width, height: f.height };
        const k = scale ?? 1;
        if (region) {
          const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = region;
          const left = Math.max(0, Math.min(x0, f.width));
          const top = Math.max(0, Math.min(y0, f.height));
          const right = Math.max(0, Math.min(x1, f.width));
          const bottom = Math.max(0, Math.min(y1, f.height));
          if (region.length !== 4 || right <= left || bottom <= top)
            throw new Error(
              `region: [x0, y0, x1, y1] inside the coordinate frame ${f.width}×${f.height}.`,
            );
          const sx = raw.width / f.width;
          const sy = raw.height / f.height;
          const part = {
            x: left * sx,
            y: top * sy,
            w: (right - left) * sx,
            h: (bottom - top) * sy,
          };
          // A zoom keeps the capture's own detail (device pixels), up to the model's long side.
          const fit = Math.min(1, MODEL_MAX_SIDE / Math.max(part.w, part.h)) * k;
          shot = await cropShot(raw, part, part.w * fit, part.h * fit);
        } else
          shot = await cropShot(
            raw,
            { x: 0, y: 0, w: raw.width, h: raw.height },
            f.width * k,
            f.height * k,
          );
      } else shot = await view.capture();
      const root = host.services.workspace.root.peek();
      let path: string | null = null;
      if ((save ?? !inline) && root) {
        path = await saveShot(root, "page", shot);
        if (open) host.run("editor.openFile", { path });
      }
      return {
        url: view.page.url.peek(),
        width: shot.width,
        height: shot.height,
        path,
        ...(frame && { frame }),
        ...(inline && { png: base64(shot.png) }),
      };
    },
  });
  register({
    id: "browser.devtools",
    title: "Toggle browser DevTools",
    description:
      "Shows or hides DevTools for a browser tab, optionally on a panel: elements, console, network, sources, performance, application.",
    input: s.object({
      tab: tabInput,
      panel: s
        .enum(
          DEVTOOLS_TABS.map(([id]) => id) as [
            "elements",
            "console",
            "network",
            "sources",
            "performance",
            "application",
          ],
        )
        .optional(),
      open: s.boolean().optional(),
    }),
    effects: [],
    agent: "discoverable",
    run: ({ tab, panel, open }) => {
      const view = target(tab);
      if (panel || open) view.openDevtools(panel);
      else view.toggleDevtools(open);
      return { open: open ?? true, panel: view.devtools.active };
    },
  });

  register({
    id: "browser.network",
    title: "Page requests",
    description:
      "Requests the page made (DevTools Network): method, url, status, type, size, time, newest last. Filter by `url` text, `type` (doc, fetch, js, css, img, font, media, ws, other) or `failed`. Use the id with browser.request for headers and bodies.",
    input: s.object({
      tab: tabInput,
      url: s.string().optional(),
      type: s.string().optional(),
      failed: s.boolean().optional(),
      limit: s.integer({ min: 1, max: 500 }).optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: ({ tab, url, type, failed, limit }) => {
      const list = pageTarget(tab)
        .page.requests.peek()
        .filter((r) => !url || r.url.includes(url))
        .filter((r) => !type || requestType(r) === type)
        .filter((r) => !failed || r.error || r.status >= 400)
        .slice(-(limit ?? 100));
      return {
        requests: list.map((r) => ({
          id: r.id,
          method: r.method,
          url: r.url,
          status: r.status,
          type: requestType(r),
          size: r.size,
          ms: Math.round(r.durationMs),
          ...(r.error && { error: r.error }),
          ...(!r.done && { pending: true }),
        })),
      };
    },
  });

  register({
    id: "browser.request",
    title: "Request details",
    description:
      "One request from browser.network: headers, request body and response body (text, up to `maxChars`).",
    input: s.object({
      tab: tabInput,
      id: s.string().describe("Request id from browser.network"),
      maxChars: s.integer({ min: 100, max: 200000 }).optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ tab, id, maxChars }) => {
      const t = pageTarget(tab);
      const r = t.page.requests.peek().find((x) => x.id === id);
      if (!r) throw new Error(`No request ${id} (see browser.network).`);
      const max = maxChars ?? 20000;
      const text = async (which: "request" | "response") => {
        if (t.cdp) return t.cdp.body(r, which, max);
        if (r.logId === undefined) return null;
        const bytes = await browserIpc.networkBody(r.logId, which).catch(() => null);
        if (!bytes) return null;
        const body = decoder.decode(bytes);
        return body.length > max
          ? `${body.slice(0, max)}… (${body.length - max} more characters)`
          : body;
      };
      const type = requestType(r);
      return {
        method: r.method,
        url: r.url,
        status: r.status,
        mime: r.mime,
        size: r.size,
        ms: Math.round(r.durationMs),
        requestHeaders: Object.fromEntries(r.reqHeaders),
        responseHeaders: Object.fromEntries(r.resHeaders),
        requestBody: r.hasRequestBody ? await text("request") : null,
        responseBody:
          type === "img" || type === "font" || type === "media"
            ? `(${type}, ${r.size} bytes)`
            : await text("response"),
      };
    },
  });

  register({
    id: "browser.dom",
    title: "Element HTML",
    description:
      "The outer HTML of an element (by ref from browser.snapshot or a CSS selector; default: <body>), or every match of `selector` with `all`.",
    input: s.object({
      tab: tabInput,
      ref: s.string().optional(),
      selector: s.string().optional(),
      all: s.boolean().optional(),
      maxChars: s.integer({ min: 100, max: 200000 }).optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ tab, ref, selector, all, maxChars }) => {
      const t = pageTarget(tab);
      if (all && selector) return t.page.call("dom.query", { selector, limit: 50 });
      if (t.cdp) return t.cdp.dom({ ref, selector }, maxChars ?? 20000);
      const view = target(tab);
      const id =
        ref || selector
          ? await refOf(view, ref, selector)
          : (
              await view.page.call<{ matches: { id: string }[] }>("dom.query", {
                selector: "body",
                limit: 1,
              })
            ).matches[0]?.id;
      if (!id) throw new Error("The page has no body.");
      const { html } = await view.page.call<{ html: string }>("dom.outerHTML", { id });
      const max = maxChars ?? 20000;
      return {
        ref: id,
        html:
          html.length > max
            ? `${html.slice(0, max)}… (${html.length - max} more characters)`
            : html,
      };
    },
  });

  register({
    id: "browser.styles",
    title: "Element styles",
    description:
      "CSS of an element (ref or selector): the rules that match it (selector, file, declarations), inline style, box model, and computed values (all, or those named in `properties`).",
    input: s.object({
      tab: tabInput,
      ref: s.string().optional(),
      selector: s.string().optional(),
      properties: s
        .array(s.string())
        .describe("Computed properties to return (default: a useful set)")
        .optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ tab, ref, selector, properties }) => {
      const t = pageTarget(tab);
      let id: string;
      let st: { computed: [string, string][]; [k: string]: unknown };
      if (t.cdp) {
        if (!ref && !selector) throw new Error("Give a ref (from browser.snapshot) or a selector.");
        const { ref: found, ...rest } = await t.cdp.styles({ ref, selector });
        id = found;
        st = rest;
      } else {
        const view = target(tab);
        id = await refOf(view, ref, selector);
        st = await view.page.call("dom.styles", { id });
      }
      const wanted = properties ?? [
        "display",
        "position",
        "width",
        "height",
        "margin",
        "padding",
        "color",
        "background-color",
        "font-family",
        "font-size",
        "font-weight",
        "line-height",
        "flex-direction",
        "justify-content",
        "align-items",
        "gap",
        "grid-template-columns",
        "z-index",
        "opacity",
        "overflow",
        "visibility",
        "transform",
        "border",
        "border-radius",
        "box-shadow",
      ];
      const computed = Object.fromEntries(st.computed.filter(([p]) => wanted.includes(p)));
      return { ref: id, ...st, computed };
    },
  });

  register({
    id: "browser.performance",
    title: "Measure page performance",
    description:
      "The page's load metrics (time to first byte, first and largest contentful paint, layout shift, blocking time, DOMContentLoaded, load, in ms), downloads by type, slowest requests, DOM size and memory. With `recordMs`, also records frame rate, long tasks and memory for that long (use the page meanwhile, e.g. browser.scroll) and returns their statistics.",
    input: s.object({
      tab: tabInput,
      recordMs: s.integer({ min: 250, max: 30000 }).describe("Record this long first").optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ tab, recordMs }) => {
      const page = target(tab).page;
      let recording: PerfRecording | null = null;
      if (recordMs) {
        await page.call("perf.record", { on: true });
        await new Promise((r) => setTimeout(r, recordMs));
        recording = await page.call<PerfRecording>("perf.record", { on: false });
      }
      const summary = await page.call<PerfSummary>("perf.summary");
      return {
        ...summary,
        ratings: {
          ttfb: rate("ttfb", summary.navigation?.ttfb ?? null),
          fcp: rate("fcp", summary.fcp),
          lcp: rate("lcp", summary.lcp),
          cls: summary.supported.cls === false ? "none" : rate("cls", summary.cls),
          tbt:
            summary.supported.longTasks === false
              ? "none"
              : rate("tbt", summary.longTasks.blocking),
        },
        ...(recording ? { recording: recordingStats(recording) } : {}),
      };
    },
  });

  register({
    id: "browser.record",
    title: "Record page performance",
    description:
      "Chrome's Performance recording, shown on the Performance panel's timeline: `start` records while the page is used, `reload` reloads it and records from its first request, `stop` ends it and returns its statistics (frames per second, dropped frames, long tasks and blocking time, requests, interactions, layout shift, heap) and its paint and load markers (ms from the start).",
    input: s.object({
      tab: tabInput,
      action: s.enum(["start", "reload", "stop"] as const),
    }),
    effects: [],
    agent: "discoverable",
    run: async ({ tab, action }) => {
      const view = target(tab);
      view.openDevtools("performance");
      const panel = view.devtools.panel<PerformancePanel>("performance");
      if (action === "start") await panel.start();
      else if (action === "reload") await panel.reloadAndRecord();
      else {
        const rec = await panel.stop();
        if (!rec) return { recording: false, recorded: null };
        const range = rangeStats(rec, 0, rec.duration);
        return {
          recording: false,
          recorded: {
            duration: rec.duration,
            fromNavigation: rec.fromNavigation ?? false,
            ...recordingStats(rec),
            frames: range.frames,
            dropped: range.dropped,
            requests: range.requests,
            interactions: range.interactions,
            slowestInteraction: range.slowestInteraction,
            layoutShift: range.layoutShift,
            markers: rec.markers ?? [],
          },
        };
      }
      return { recording: panel.isRecording };
    },
  });

  register({
    id: "browser.storage",
    title: "Page storage",
    description: "The page's local storage, session storage and cookies (keys and values).",
    input: s.object({ tab: tabInput }),
    effects: ["read"],
    agent: "discoverable",
    run: ({ tab }) => {
      const t = pageTarget(tab);
      return t.cdp ? t.cdp.storage() : target(tab).page.call("storage.list");
    },
  });

  register({
    id: "browser.setStorage",
    title: "Change page storage",
    description:
      "Sets or removes a key of the page's local storage, session storage or cookies, or clears one of them (area all: everything).",
    input: s.object({
      tab: tabInput,
      action: s.enum(["set", "remove", "clear"] as const),
      area: s.enum(["local", "session", "cookie", "all"] as const),
      key: s.string().optional(),
      value: s.string().optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: ({ tab, action, area, key, value }) => {
      const ext = pageTarget(tab).cdp;
      if (ext) return ext.setStorage(action, area, key, value);
      const page = target(tab).page;
      if (action === "set") return page.call("storage.set", { area, key, value });
      if (action === "remove") return page.call("storage.remove", { area, key });
      return page.call("storage.clear", { area });
    },
  });

  register({
    id: "browser.highlight",
    title: "Highlight element",
    description:
      "Outlines an element in the page (ref or selector) to show the user; without either, clears the highlight.",
    input: s.object({ tab: tabInput, ref: s.string().optional(), selector: s.string().optional() }),
    effects: [],
    agent: "discoverable",
    run: async ({ tab, ref, selector }) => {
      const ext = pageTarget(tab).cdp;
      if (ext) return ext.highlight(ref || selector ? { ref, selector } : null);
      const view = target(tab);
      const id = ref || selector ? await refOf(view, ref, selector) : null;
      await view.page.call("dom.highlight", { id });
      return { ref: id };
    },
  });

  register({
    id: "browser.reveal",
    title: "Reveal element in DevTools",
    description: "Opens DevTools on Elements with an element selected (ref or selector).",
    input: s.object({ tab: tabInput, ref: s.string().optional(), selector: s.string().optional() }),
    effects: [],
    agent: "discoverable",
    run: async ({ tab, ref, selector }) => {
      const view = target(tab);
      const id = await refOf(view, ref, selector);
      await view.revealElement(id);
      return { ref: id };
    },
  });

  register({
    id: "browser.inspect",
    title: "Select an element in the page",
    description:
      "Turns on the element picker: the user clicks an element in the page and it opens in Elements.",
    input: s.object({ tab: tabInput }),
    effects: [],
    agent: "hidden",
    run: async ({ tab }) => {
      await target(tab).togglePick();
    },
  });

  register({
    id: "browser.resize",
    title: "Device size",
    description:
      "Shows the page at a device's size (iPhone SE, iPhone 15, Pixel 8, iPad Air, Laptop, Desktop…, `landscape`) or a `width`×`height`; `device: responsive` fills the tab again. `colorScheme` light or dark emulates prefers-color-scheme (the page's media queries, matchMedia, and its color-scheme when it offers both; kept across reloads); auto ends it.",
    input: s.object({
      tab: tabInput,
      device: s.string().optional(),
      width: s.integer({ min: 200, max: 4000 }).optional(),
      height: s.integer({ min: 200, max: 4000 }).optional(),
      landscape: s.boolean().optional(),
      colorScheme: s.enum(["light", "dark", "auto"] as const).optional(),
    }),
    effects: [],
    agent: "discoverable",
    run: async ({ tab, device, width, height, landscape, colorScheme }) => {
      const ext = pageTarget(tab).cdp;
      const sized =
        device !== undefined || width !== undefined || height !== undefined || landscape;
      const viewport = sized
        ? viewportFor({
            ...(device !== undefined && { device }),
            ...(width !== undefined && { width }),
            ...(height !== undefined && { height }),
            ...(landscape !== undefined && { landscape }),
          })
        : null;
      if (ext) return ext.resize(viewport, colorScheme);
      const view = target(tab);
      if (viewport) view.setViewport(viewport);
      if (!colorScheme) return viewport ?? { unchanged: true };
      const emulated = (await view.page.emulateColorScheme(
        colorScheme === "auto" ? null : colorScheme,
      )) as Record<string, unknown>;
      return { ...(viewport ?? {}), ...emulated };
    },
  });

  register({
    id: "browser.focusAddress",
    title: "Focus address bar",
    description: "Puts the cursor in a browser tab's address bar.",
    input: s.object({ tab: tabInput }),
    effects: [],
    agent: "hidden",
    run: ({ tab }) => target(tab).focusAddress(),
  });
  void host;
}
