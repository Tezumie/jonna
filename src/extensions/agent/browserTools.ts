// The agent's browser tools (PLAN §8.2 optional group "browser"): offered only while a browser
// tab is open, so local models aren't handed tools they can't use. They run the browser.*
// commands as the agent (page actions ask the user like other changes). Page content is
// untrusted: results say so. D316: Claude Code's browser tools are matched as modes and actions
// of these (find and page text in browser_snapshot; points, drag, keys, tabs in browser_act; tabs
// and color scheme in browser_inspect; zoom and scale in screenshot) plus browser_eval and
// browser_batch (browserScriptTools.ts): each tool's description goes with every request.
// D339: browser_act upload (browserUploadTool.ts); D340: start_recording / stop_recording, a GIF
// of the tab for the user (browserRecorder.ts); D341: the user's own browser as tab "external".

import {
  ACT_ACTIONS,
  actLabel,
  type OutlineLine,
  planAct,
  resizePreset,
} from "../../core/agent/browserInput";
import { markerOf, needsLocate } from "../../core/agent/browserRecording";
import type { WorkbenchServices } from "../../workbench/services";
import { isRecording, recordAction, startRecording, stopRecording } from "./browserRecorder";
import {
  asAgent,
  batchTool,
  currentBrowserTab,
  EVAL_TOOL,
  noteTab,
  text,
  UNTRUSTED,
} from "./browserScriptTools";
import { rememberShot, runUpload } from "./browserUploadTool";
import type { AgentTool, ToolHost } from "./tools";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const locator = {
  ref: { type: "string", description: "Element ref from browser_snapshot, e.g. e12" },
  selector: { type: "string", description: "CSS selector (if no ref)" },
  name: { type: "string", description: "Visible text or label of the element (if no ref)" },
};
const point = (description: string) => ({
  type: "array",
  items: { type: "number" },
  description,
});

export const BROWSER_TOOLS: AgentTool[] = [
  {
    spec: {
      name: "browser_snapshot",
      description:
        "See the page in the browser tab: an outline of headings, links, buttons and inputs with refs like [ref=e12] to use with browser_act. Also url and title. `find`: only the elements whose line (role, name, text) contains it, case-insensitively (up to 20, with refs). `text`: the page's readable text instead (its article or main content first, else the whole page).",
      parameters: obj({
        ref: { type: "string", description: "Only this element's part of the page" },
        find: { type: "string", description: "Text to look for, e.g. sign in" },
        text: { type: "boolean", description: "The page's text instead of the outline" },
        max_chars: { type: "integer", description: "text: at most this much (default 20000)" },
      }),
    },
    readOnly: true,
    verb: "Looked at page",
    target: (a) =>
      typeof a.find === "string" ? `find "${a.find}"` : a.text === true ? "text" : "",
    async run(args, host) {
      if (typeof args.find === "string" && args.find.trim()) {
        const r = (await asAgent(host, "browser.find", { query: args.find, limit: 20 })) as {
          url?: string;
          title?: string;
          matches: OutlineLine[];
          of: number;
        };
        const lines = r.matches.map((m) => `- ${m.line} [ref=${m.ref}]`);
        return {
          result: `${UNTRUSTED}${r.url ?? ""} — ${r.title ?? ""}\n${
            lines.length
              ? `${lines.length} match${lines.length === 1 ? "" : "es"} for "${args.find}":\n${text(lines.join("\n"))}`
              : `Nothing on the page matches "${args.find}" (${r.of} lines looked at). Try other words or a snapshot.`
          }`,
          summary: `${lines.length} found`,
        };
      }
      if (args.text === true) {
        const max =
          typeof args.max_chars === "number"
            ? Math.min(50000, Math.max(100, Math.round(args.max_chars)))
            : 20000;
        const r = (await asAgent(host, "browser.text", { main: true, maxChars: max })) as {
          url?: string;
          title?: string;
          from?: string;
          text?: string;
        };
        const from =
          r.from === "article"
            ? "its article"
            : r.from === "main"
              ? "its main content"
              : "the page";
        return {
          result: `${UNTRUSTED}${r.url ?? ""} — ${r.title ?? ""}\nText of ${from}:\n${r.text ?? ""}`,
          summary: r.title || r.url || "page text",
        };
      }
      const result = (await asAgent(
        host,
        "browser.snapshot",
        typeof args.ref === "string" ? { ref: args.ref } : {},
      )) as { url?: string; title?: string; snapshot?: string };
      return {
        result: `${UNTRUSTED}${result.url ?? ""} — ${result.title ?? ""}\n${text(result.snapshot ?? "")}`,
        summary: result.title || result.url || "page",
      };
    },
  },
  {
    spec: {
      name: "browser_act",
      description:
        'Do something in the browser tab: click | right_click | double_click | triple_click | hover (an element by ref, or a `coordinate`) | type (text into a ref, else at the focus; submit?) | press (key: Enter, ctrl+a, "Backspace Backspace"; repeat; on a ref or the focus) | select (value) | scroll (to top/bottom or a ref; or scroll_direction and scroll_amount at a coordinate) | drag (start_coordinate to coordinate) | navigate (url: localhost:5173, index.html, https://…) | back | forward | reload | wait (text or selector; or duration in seconds, at most 10) | new_tab (url?) | select_tab | close_tab (tab: from browser_inspect tabs) | upload (files: workspace paths, or screenshot: an id from the screenshot tool, onto a file input or drop zone by ref or coordinate) | start_recording | stop_recording (an animated GIF of the tab for the user: a frame after each action, captioned by its action_summary). Coordinates are [x, y] in the latest screenshot\'s frame. Set action_summary: a few words on what it does, shown to the user. Take a new snapshot or screenshot after the page changes. Links and redirects to other local servers stay in the tab; a link or popup that opens a new tab opens another browser tab, which becomes the one these tools act on.',
      parameters: obj(
        {
          action: { type: "string", enum: [...ACT_ACTIONS] },
          ...locator,
          coordinate: point("[x, y] in the screenshot's coordinate frame (instead of a ref)"),
          start_coordinate: point("drag: [x, y] to pick up"),
          text: { type: "string", description: "type: the text; wait: text to wait for" },
          submit: { type: "boolean" },
          key: { type: "string", description: "press: Enter, Escape, Tab, ctrl+a, cmd+shift+z…" },
          repeat: { type: "integer", description: "press: times, 1–100" },
          modifiers: { type: "string", description: "Held during a click or key: ctrl+shift" },
          value: { type: "string", description: "select: option value or label" },
          url: { type: "string", description: "navigate, new_tab: the address" },
          to: { type: "string", enum: ["top", "bottom"] },
          scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
          scroll_amount: { type: "integer", description: "scroll: wheel ticks, 1–10 (default 3)" },
          duration: { type: "number", description: "wait: seconds" },
          tab: { type: "string", description: "select_tab, close_tab: the tab id" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "upload: workspace paths",
          },
          screenshot: { type: "string", description: "upload: a screenshot's id, e.g. shot2" },
          action_summary: { type: "string", description: "What this does, e.g. Opens the menu" },
        },
        ["action"],
      ),
    },
    readOnly: false,
    verb: "Browser",
    target: actLabel,
    async run(args, host, itemId) {
      const action = String(args.action ?? "");
      if (action === "start_recording") return startRecording(host);
      if (action === "stop_recording") return stopRecording(host, itemId);
      // Where a pointer action on an element happens, for a recording's marker (D340).
      const marker =
        markerOf(args) ??
        (isRecording(host.session) && needsLocate(args)
          ? await locate(host, args).catch(() => null)
          : null);
      if (action === "upload") {
        const outcome = await runUpload(args, host);
        await recordAction(host, args, marker);
        return outcome;
      }
      const plan = planAct(args);
      if (plan.sleepMs !== undefined) {
        await new Promise((r) => setTimeout(r, plan.sleepMs));
        await recordAction(host, args, null);
        return { result: `Waited ${plan.sleepMs / 1000} s.`, summary: "waited" };
      }
      const result = await asAgent(host, plan.command, plan.input);
      // The new or chosen tab is the one the browser tools act on now.
      if (action === "new_tab" || action === "select_tab") noteTab(host);
      await recordAction(host, args, marker);
      // D346: the row says when the page got synthesized events (isTrusted false).
      const synthesized = (result as { input?: unknown } | null)?.input === "synthesized";
      return {
        result: `${UNTRUSTED}${text(result ?? "done")}`,
        summary: synthesized ? `${action} (synthesized)` : action,
      };
    },
  },
  {
    spec: {
      name: "browser_inspect",
      description:
        "DevTools data of the browser tab: network (requests: filter by url/type, failed, limit) | request (id: headers and bodies) | dom (outer HTML of ref/selector) | styles (matched CSS, box model, computed values of ref/selector) | storage (local/session storage, cookies) | tabs (the open browser tabs: id, url, which one the tools act on) | resize (preset mobile/tablet/desktop, a device: iPhone SE, Pixel 8, iPad Air…, or width+height; colorScheme light/dark/auto emulates prefers-color-scheme) | highlight (outline ref/selector for the user).",
      parameters: obj(
        {
          what: {
            type: "string",
            enum: ["network", "request", "dom", "styles", "storage", "tabs", "resize", "highlight"],
          },
          ...locator,
          id: { type: "string", description: "request: id from network" },
          url: { type: "string", description: "network: only URLs containing this" },
          type: {
            type: "string",
            description: "network: doc, fetch, js, css, img, font, ws, other",
          },
          failed: { type: "boolean", description: "network: only failed requests" },
          limit: { type: "integer", description: "network: the newest this many (default 80)" },
          device: { type: "string", description: "resize: device name or responsive" },
          preset: { type: "string", enum: ["mobile", "tablet", "desktop"] },
          width: { type: "integer" },
          height: { type: "integer" },
          colorScheme: { type: "string", enum: ["light", "dark", "auto"] },
        },
        ["what"],
      ),
    },
    readOnly: true,
    verb: "Inspected page",
    target: (a) =>
      `${String(a.what ?? "")} ${String(a.ref ?? a.selector ?? a.id ?? a.preset ?? a.device ?? a.colorScheme ?? "")}`.trim(),
    async run(args, host) {
      const what = String(args.what ?? "");
      const pick = (...keys: string[]) =>
        Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
      if (what === "tabs") return tabsOutcome(host);
      const limit =
        typeof args.limit === "number" ? Math.min(500, Math.max(1, Math.round(args.limit))) : 80;
      const call: Record<string, () => [string, Record<string, unknown>]> = {
        network: () => ["browser.network", { ...pick("url", "type", "failed"), limit }],
        request: () => ["browser.request", pick("id")],
        dom: () => ["browser.dom", pick("ref", "selector")],
        styles: () => ["browser.styles", pick("ref", "selector")],
        storage: () => ["browser.storage", {}],
        resize: () => [
          "browser.resize",
          {
            ...(typeof args.preset === "string" ? resizePreset(args.preset) : {}),
            ...pick("device", "width", "height", "colorScheme"),
          },
        ],
        highlight: () => ["browser.highlight", pick("ref", "selector")],
      };
      const entry = call[what]?.();
      if (!entry) throw new Error(`Unknown "${what}".`);
      const result = await asAgent(host, entry[0], entry[1]);
      return { result: `${UNTRUSTED}${text(result)}`, summary: what };
    },
  },
  {
    spec: {
      name: "browser_console",
      description:
        "The browser tab's console errors and warnings, uncaught exceptions and failed requests (status ≥ 400) — check after loading or acting on the page. `pattern` keeps only messages matching it (a regular expression).",
      parameters: obj({
        level: { type: "string", enum: ["error", "warn", "all"] },
        pattern: { type: "string" },
        limit: { type: "integer", description: "The newest this many (default 40)" },
      }),
    },
    readOnly: true,
    verb: "Read console",
    target: (a) => (typeof a.pattern === "string" ? a.pattern : ""),
    async run(args, host) {
      const result = await asAgent(host, "browser.console", {
        level: typeof args.level === "string" ? args.level : "warn",
        limit:
          typeof args.limit === "number" ? Math.min(300, Math.max(1, Math.round(args.limit))) : 40,
        ...(typeof args.pattern === "string" && args.pattern && { pattern: args.pattern }),
      });
      return { result: `${UNTRUSTED}${text(result)}`, summary: "console" };
    },
  },
  EVAL_TOOL,
];

/** Where an element is in the coordinate frame (a recording's marker for a click on a ref). */
async function locate(host: ToolHost, args: Record<string, unknown>) {
  const where = Object.fromEntries(
    ["ref", "selector", "name"].filter((k) => typeof args[k] === "string").map((k) => [k, args[k]]),
  );
  const r = (await host.services.dispatcher.execute("browser.locate", where)) as {
    x: number;
    y: number;
  };
  const kind = String(args.action) === "hover" ? ("hover" as const) : ("click" as const);
  return { kind, x: r.x, y: r.y };
}

/** browser_inspect tabs: the browser tabs, and which one the tools act on. */
async function tabsOutcome(host: ToolHost) {
  const r = (await host.services.dispatcher.execute("browser.list", {})) as {
    tabs: { tab: string; url: string; title: string; shownIn: string; errors: number }[];
    current?: string;
  };
  const current = r.current ?? currentBrowserTab(host.services);
  const lines = r.tabs.map(
    (t) =>
      `- ${t.tab}${t.tab === current ? " (current: the tools act on it)" : ""}: ${t.url || "empty"}${t.title ? ` — ${t.title}` : ""}${t.shownIn !== "frame" ? ` [${t.shownIn}]` : ""}${t.errors ? ` [${t.errors} errors]` : ""}`,
  );
  return {
    result: `${UNTRUSTED}${lines.length ? lines.join("\n") : "No browser tabs are open."}\nbrowser_act select_tab / close_tab / new_tab change them.`,
    summary: `${lines.length} tab${lines.length === 1 ? "" : "s"}`,
  };
}

/**
 * Screenshots (always offered): the page in a browser tab, or the whole IDE window — to check how
 * something looks, or to see what the user sees. The image goes to vision models.
 */
export const SCREENSHOT_TOOL: AgentTool = {
  spec: {
    name: "screenshot",
    description:
      'Take a screenshot to see how something looks. target "page": the page in the browser tab (run the app and open it in the browser first); its pixels are the coordinate frame browser_act\'s coordinates use, `region` [x0, y0, x1, y1] zooms into part of it and `scale` (0.1–1) makes a smaller image (coordinates stay in the full frame). target "ide": the whole IDE window as the user sees it (editors, terminals, panels). Returns the image.',
    parameters: obj({
      target: {
        type: "string",
        enum: ["page", "ide"],
        description: "Default: page if a browser tab is open, else ide",
      },
      save: {
        type: "boolean",
        description: "Also save it as a file in the workspace (default false)",
      },
      view: {
        type: "string",
        description:
          'Only part of the IDE (a smaller image): a tab id or view type from ide://layout ("agent", an extension\'s view id), or a side bar view id ("explorer.view")',
      },
      selector: { type: "string", description: "Only the element matching this CSS selector" },
      region: point("page: [x0, y0, x1, y1] of the coordinate frame to zoom into"),
      scale: { type: "number", description: "page: 0.1–1, a smaller image" },
      record: {
        type: "string",
        enum: ["start", "stop"],
        description:
          "Record an animated GIF for the user instead (a bug report, a demo): start, then stop shows it in the chat. target ide: the IDE window, with the user's clicks marked; page: the browser tab",
      },
    }),
  },
  readOnly: true,
  verb: "Took screenshot",
  target: (a) =>
    typeof a.record === "string"
      ? `${a.record} recording`
      : a.target === "ide"
        ? "IDE"
        : Array.isArray(a.region)
          ? `zoom ${a.region.join(", ")}`
          : "page",
  async run(args, host, itemId) {
    const { dispatcher } = host.services;
    // D354: a GIF of the IDE window (or the tab), as browser_act start_recording does for the tab.
    if (args.record === "stop") return stopRecording(host, itemId);
    if (args.record === "start")
      return startRecording(host, args.target === "page" ? "browser" : "ide");
    const part =
      typeof args.view === "string" && args.view
        ? { view: args.view }
        : typeof args.selector === "string" && args.selector
          ? { selector: args.selector }
          : {};
    // A part of the IDE is a picture of the IDE: target "page" with a view or selector is ignored.
    const page =
      !("view" in part || "selector" in part) &&
      (args.target === "page" || (args.target !== "ide" && hasBrowser(host.services)));
    const scale =
      typeof args.scale === "number" && args.scale > 0 ? Math.min(1, Math.max(0.1, args.scale)) : 1;
    const region = page && args.region !== undefined ? args.region : undefined;
    if (page) noteTab(host);
    const result = (await dispatcher.execute(
      page ? "browser.screenshot" : "workbench.screenshot",
      {
        inline: true,
        save: args.save === true,
        ...(page ? { ...(region !== undefined && { region }), ...(scale < 1 && { scale }) } : part),
      },
      { kind: "agent", session: host.session },
    )) as {
      png: string;
      width: number;
      height: number;
      path: string | null;
      url?: string;
      frame?: { width: number; height: number };
    };
    const what = page
      ? `the page ${result.url ?? ""}`.trim()
      : "view" in part
        ? `the IDE's ${part.view}`
        : "selector" in part
          ? `the IDE's ${part.selector}`
          : "the IDE window";
    const frame = result.frame;
    const frameNote = frame
      ? region !== undefined
        ? ` A zoom into [${String(region)}] of the coordinate frame (${frame.width}×${frame.height}): coordinates for browser_act still refer to the frame, not this image.`
        : scale < 1
          ? ` Scaled by ${scale}: the coordinate frame for browser_act is ${frame.width}×${frame.height}.`
          : ` Its pixels are the coordinate frame for browser_act (${frame.width}×${frame.height}).`
      : "";
    // Kept for browser_act upload (D339): its id goes with the result.
    const id = page ? ` (id ${rememberShot(host.session, result.png)})` : "";
    return {
      result: `Screenshot of ${what}${id}, ${result.width}×${result.height}${result.path ? `, saved to ${result.path}` : ""}.${frameNote} The image is attached; if you can't see images, use browser_snapshot instead.`,
      summary: `${result.width}×${result.height}`,
      images: [result.png],
    };
  },
};

/** browser_batch runs these (and only those the turn has). */
export const BATCH_TOOL = batchTool(() => [...BROWSER_TOOLS, SCREENSHOT_TOOL]);

/** The browser group while a browser tab is open. */
export function browserTools(services: WorkbenchServices): AgentTool[] {
  const screenshot = services.dispatcher.has("workbench.screenshot") ? [SCREENSHOT_TOOL] : [];
  return services.dispatcher.has("browser.snapshot") && hasBrowser(services)
    ? [...BROWSER_TOOLS, BATCH_TOOL, ...screenshot]
    : screenshot;
}

/** A browser tab is open, or the user's own browser is connected (D341). */
function hasBrowser(services: WorkbenchServices): boolean {
  return (
    services.dock.tabs("browser").length > 0 || services.context.get("browserExternal") === true
  );
}
