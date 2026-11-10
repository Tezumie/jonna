// browser.* commands for driving a page as a person would (D316): input at a point of the page or
// on an element (clicks with a button and count, hover, drag, wheel, keys, typing at the focus),
// find (outline lines with refs), and choosing or closing a browser tab. The bridge half is
// src-tauri/src/browser/input.js; agents reach these through browser_act and browser_snapshot.
// D339: files into a page (browser.upload); D340: where an element is (browser.locate); D341: the
// user's own browser is a target too ("external", external.ts). D346: input goes as a person's
// (trusted events) where it can (trustedInput.ts).
import { FRAME_MAX_SIDE, findInOutline, type OutlineLine } from "../../core/agent/browserInput";
import {
  describeFiles,
  type FileTarget,
  mimeType,
  planTransfer,
  UPLOAD_MAX_FILES,
} from "../../core/agent/browserUpload";
import { fsIpc } from "../../core/ipc/fs";
import { basename } from "../../core/paths/index";
import { s } from "../../core/schema/index";
import { base64 } from "../../workbench/screenshot";
import type { WorkbenchServices } from "../../workbench/services";
import { EXTERNAL_TAB, type ExternalBrowser, type PageTarget } from "./external";
import { type InputRequest, runInput } from "./trustedInput";
import type { BrowserHost } from "./view";

type Register = WorkbenchServices["dispatcher"]["register"];

const tabInput = s
  .string()
  .describe("Browser tab id (default: the active or most recent browser tab)")
  .optional();
const modifiers = s
  .array(s.enum(["ctrl", "shift", "alt", "meta"] as const))
  .describe("Modifier keys held")
  .optional();

export function registerInputCommands(
  register: Register,
  /** A browser tab, or the user's own browser (D341): what page input needs. */
  pageTarget: (tab?: string) => PageTarget,
  host: BrowserHost,
  external: ExternalBrowser,
  /** browser.trustedInput (D346). */
  trustedInputOn: () => boolean,
): void {
  register({
    id: "browser.input",
    title: "Page input",
    description:
      "Input in a page as a person gives it: `op` click (button 0 left / 2 right, count 1–3), hover, drag (from fromX/fromY or an element to x/y), scroll (dx/dy pixels at a point), key (keys with modifiers, repeat), type (text at the focus). Points `x`/`y` are in the screenshot's coordinate frame (the viewport scaled to fit 1568 px, as browser.screenshot `inline` reports); or an element by ref/selector/name. Events are trusted (isTrusted) through the DevTools protocol in the user's own browser and the built-in tab on Windows, else synthesized; the result's `input` says which.",
    input: s.object({
      tab: tabInput,
      op: s.enum(["click", "hover", "drag", "scroll", "key", "type"] as const),
      x: s.number().optional(),
      y: s.number().optional(),
      fromX: s.number().optional(),
      fromY: s.number().optional(),
      ref: s.string().optional(),
      selector: s.string().optional(),
      name: s.string().optional(),
      button: s.integer({ min: 0, max: 2 }).optional(),
      count: s.integer({ min: 1, max: 3 }).optional(),
      modifiers,
      dx: s.number().optional(),
      dy: s.number().optional(),
      keys: s
        .array(s.object({ key: s.string(), modifiers }))
        .describe("key: the keys in order (DOM key names: Enter, a, ArrowDown)")
        .optional(),
      repeat: s.integer({ min: 1, max: 100 }).optional(),
      text: s.string().optional(),
      submit: s.boolean().optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ tab, ...params }) => {
      const t = pageTarget(tab);
      return runInput(
        t,
        params as InputRequest,
        () => t.page.call("input.do", { ...params, maxSide: FRAME_MAX_SIDE }),
        trustedInputOn(),
      );
    },
  });

  register({
    id: "browser.find",
    title: "Find in page",
    description:
      "Elements of the page whose outline line (role, name, text) contains `query`, case-insensitively: up to `limit` lines with refs for browser.click / browser.type.",
    input: s.object({
      tab: tabInput,
      query: s.string(),
      limit: s.integer({ min: 1, max: 100 }).optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ tab, query, limit }) => {
      const r = await pageTarget(tab).page.call<{
        url: string;
        title: string;
        lines: OutlineLine[];
      }>("outline", {});
      const lines = Array.isArray(r.lines) ? r.lines : [];
      const matches = findInOutline(lines, query, limit ?? 20);
      return { url: r.url, title: r.title, matches, of: lines.length };
    },
  });

  register({
    id: "browser.upload",
    title: "Upload files to page",
    description:
      "Gives files to a page (D339): set on an <input type=file> (or the one a label is for) through a DataTransfer with input and change events, or dropped on any other element (dragenter, dragover, drop). Target by ref/selector/name or a point x/y (the screenshot's coordinate frame). `files`: paths in the workspace (never outside it); `data`: files given as base64 (a screenshot). At most 10 MB in all.",
    input: s.object({
      tab: tabInput,
      ref: s.string().optional(),
      selector: s.string().optional(),
      name: s.string().optional(),
      x: s.number().optional(),
      y: s.number().optional(),
      files: s.array(s.string()).describe("Workspace paths (absolute or relative)").optional(),
      data: s
        .array(s.object({ name: s.string(), type: s.string().optional(), base64: s.string() }))
        .describe("Files as base64 bytes")
        .optional(),
    }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ tab, files, data, ...where }) => {
      const { workspace } = host.services;
      const page = pageTarget(tab).page;
      const at = { ...where, maxSide: FRAME_MAX_SIDE };
      const fromDisk = await Promise.all(
        (files ?? []).map(async (p) => {
          const path = workspace.resolve(p);
          if (!workspace.contains(path)) throw new Error(`${p} is outside the workspace.`);
          const stat = await fsIpc.stat(path).catch(() => null);
          if (stat?.kind !== "file") throw new Error(`${p} isn't a file.`);
          const name = basename(path);
          return { path, name, type: mimeType(name), size: stat.size };
        }),
      );
      const given = (data ?? []).map((d) => ({
        name: d.name,
        type: d.type ?? mimeType(d.name),
        size: Math.floor((d.base64.replace(/=+$/, "").length * 3) / 4),
        base64: d.base64,
      }));
      const planned = [...fromDisk, ...given];
      if (planned.length > UPLOAD_MAX_FILES)
        throw new Error(`At most ${UPLOAD_MAX_FILES} files at once.`);
      const fileTarget = await page.call<FileTarget>("input.fileTarget", at);
      const plan = planTransfer(fileTarget, planned);
      if ("error" in plan) throw new Error(plan.error);
      const payload = [
        ...(await Promise.all(
          fromDisk.map(async (f) => ({
            name: f.name,
            type: f.type,
            data: base64(await fsIpc.read(f.path)),
          })),
        )),
        ...given.map((g) => ({ name: g.name, type: g.type, data: g.base64 })),
      ];
      const result = await page.call<Record<string, unknown>>("input.files", {
        ...at,
        mode: plan.mode,
        files: payload,
      });
      return {
        ...result,
        mode: plan.mode,
        sent: describeFiles(planned),
        ...(plan.notes.length && { notes: plan.notes }),
      };
    },
  });

  register({
    id: "browser.locate",
    title: "Locate element in page",
    description:
      "Where an element is (its center x/y, width and height) in the screenshot's coordinate frame, after scrolling it into view as actions do. By ref, selector or name.",
    input: s.object({
      tab: tabInput,
      ref: s.string().optional(),
      selector: s.string().optional(),
      name: s.string().optional(),
    }),
    effects: ["read"],
    agent: "discoverable",
    run: async ({ tab, ...where }) =>
      pageTarget(tab).page.call("input.locate", { ...where, maxSide: FRAME_MAX_SIDE }),
  });

  register({
    id: "browser.selectTab",
    title: "Show browser tab",
    description:
      'Brings a browser tab to the front; the browser commands then act on it. "external": the user\'s own browser, when connected (browser.connectExternal).',
    input: s.object({ tab: s.string().describe("Browser tab id (browser.list)") }),
    effects: [],
    agent: "discoverable",
    run: ({ tab }) => {
      if (tab === EXTERNAL_TAB) return external.select();
      external.deselect();
      const view = host.views.get(tab);
      if (!view) throw new Error(`No browser tab ${tab} (browser.list).`);
      host.services.dock.activateTab(tab, true);
      return { tab, url: view.page.url.peek(), title: view.page.title.peek() };
    },
  });

  register({
    id: "browser.closeTab",
    title: "Close browser tab",
    description: "Closes a browser tab.",
    input: s.object({ tab: s.string().describe("Browser tab id (browser.list)") }),
    effects: ["write"],
    agent: "discoverable",
    run: async ({ tab }) => {
      // The user's own browser stays open: the IDE lets go of it.
      if (tab === EXTERNAL_TAB) return { closed: external.disconnect() };
      if (!host.views.has(tab)) throw new Error(`No browser tab ${tab} (browser.list).`);
      return { closed: await host.services.dock.closeTab(tab) };
    },
  });
}
