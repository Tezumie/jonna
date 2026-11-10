// Dev-only built-in (excluded from production builds by `__DEV__`). `dev.dumpState` is the first
// proof that an agent can "see" the IDE: the same budgeted state tree agents will read.
import type { BuiltinExtension } from "../../core/extensions/index";
import { isTauri } from "../../core/ipc/invoke";
import { windowIpc } from "../../core/ipc/system";
import { LeakMonitor, liveDisposableCount } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { registerA11yCheck } from "./a11yCheck";
import manifest from "./extension.json";
import { registerIframeTest } from "./iframeTest";
import { registerLayoutCheck } from "./layoutCheck";

const LEAK_SAMPLE_MS = 10_000;

/** The parts of Chromium's EditContext / TextUpdateEvent dev.type uses (not in every DOM lib). */
interface EditContextLike extends EventTarget {
  readonly selectionStart: number;
  readonly selectionEnd: number;
}
type TextUpdateEventCtor = new (
  type: string,
  init: {
    updateRangeStart: number;
    updateRangeEnd: number;
    text: string;
    selectionStart: number;
    selectionEnd: number;
  },
) => Event;

/** The last mouse events the document saw (dev.elementsAt): what real input hit. */
const lastMouse: string[] = [];

export const devExtension: BuiltinExtension<WorkbenchServices> = {
  manifest,
  activate({ subscriptions: sub, services }) {
    const { dispatcher, state, notifications } = services;
    for (const type of [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
      "contextmenu",
    ]) {
      const listener = (e: Event) => {
        const m = e as MouseEvent;
        const t = m.target as Element | null;
        lastMouse.push(
          `${type} ${m.button} ${m.ctrlKey ? "ctrl " : ""}${m.shiftKey ? "shift " : ""}${t?.tagName.toLowerCase()}.${t ? [...t.classList].join(".") : ""} @${m.clientX},${m.clientY}`,
        );
        if (lastMouse.length > 40) lastMouse.shift();
      };
      document.addEventListener(type, listener, true);
      sub.add({ dispose: () => document.removeEventListener(type, listener, true) });
    }

    sub.add(
      dispatcher.register({
        id: "dev.dumpState",
        title: "Dump state tree",
        category: "Developer",
        description:
          "Returns the whole ide:// state tree (or one path), fitted to `budget` JSON characters. Also prints it to the console and shows it in a read-only editor.",
        input: s.object({
          path: s.string().describe("One state path, e.g. ide://editors (default: all)").optional(),
          budget: s
            .integer({ min: 200, max: 1_000_000 })
            .describe("Max JSON characters (default 32000)")
            .optional(),
          show: s.boolean().describe("Open the result in an editor tab (default true)").optional(),
        }),
        effects: ["read"],
        run: async ({ path, budget, show }, ctx) => {
          const result = path
            ? await state.get(path, { budget: budget ?? 8_000 })
            : { available: state.list(), ...(await state.getTree({ budget: budget ?? 32_000 })) };
          const text = JSON.stringify(result, null, 2);
          console.log("[dev.dumpState]", result);
          if (show !== false)
            await ctx.execute("editor.openReadOnly", { title: "ide-state.json", content: text });
          return result;
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "dev.inspectDom",
        title: "Inspect DOM",
        category: "Developer",
        description:
          "The elements matching a CSS selector in the main window: tag, classes, box, display/visibility/color/background and the start of their HTML (debugging layout and engine widgets).",
        input: s.object({
          selector: s.string(),
          limit: s.integer({ min: 1, max: 20 }).optional(),
          html: s.integer({ min: 0, max: 20000 }).describe("Characters of outerHTML").optional(),
        }),
        effects: ["read"],
        run: ({ selector, limit, html }) =>
          [...document.querySelectorAll<HTMLElement>(selector)].slice(0, limit ?? 5).map((el) => {
            const r = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return {
              tag: el.tagName.toLowerCase(),
              className: String(el.className),
              box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
              display: cs.display,
              visibility: cs.visibility,
              opacity: cs.opacity,
              color: cs.color,
              background: cs.backgroundColor,
              fontFamily: cs.fontFamily,
              borderRadius: cs.borderRadius,
              zIndex: cs.zIndex,
              position: cs.position,
              scrollTop: Math.round(el.scrollTop),
              html: el.outerHTML.slice(0, html ?? 600),
            };
          }),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "dev.setValue",
        title: "Set a field's value",
        category: "Developer",
        description:
          "Sets the value of the first input, select or textarea matching a selector and fires input and change, as the user changing it would (tests).",
        input: s.object({ selector: s.string(), value: s.string() }),
        // Changing a field can run commands as the user (a setting): not without asking an agent.
        effects: ["write"],
        run: ({ selector, value }) => {
          const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
          if (!el) throw new Error(`Nothing matches ${selector}`);
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { value: el.value };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "dev.scroll",
        title: "Scroll an element",
        category: "Developer",
        description: "Sets the scrollTop of the first element matching a selector (tests).",
        input: s.object({ selector: s.string(), top: s.number() }),
        effects: [],
        run: ({ selector, top }) => {
          const el = document.querySelector<HTMLElement>(selector);
          if (!el) throw new Error(`Nothing matches ${selector}`);
          el.scrollTop = top;
          return { scrollTop: Math.round(el.scrollTop) };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "dev.elementsAt",
        title: "Elements at a point",
        category: "Developer",
        description:
          "The elements under a viewport point, topmost first (tag, classes, data-path), and the last mouse events the document saw: tests of real mouse input.",
        input: s.object({ x: s.number(), y: s.number() }),
        effects: [],
        run: ({ x, y }) => ({
          elements: document
            .elementsFromPoint(x, y)
            .slice(0, 8)
            .map((el) => {
              const path = (el as HTMLElement).dataset?.path;
              return `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}${path ? `[${path.split(/[\\/]/).pop()}]` : ""}`;
            }),
          events: lastMouse.slice(-40),
        }),
      }),
    );
    sub.add(
      dispatcher.register({
        id: "dev.setWindowSize",
        title: "Set window size",
        category: "Developer",
        description:
          "Resizes the main window (logical px; un-maximizes it first) and waits for the layout to settle: UI tests of small windows.",
        input: s.object({
          width: s.integer({ min: 320, max: 4000 }),
          height: s.integer({ min: 240, max: 3000 }),
        }),
        effects: ["write"],
        run: async ({ width, height }) => {
          if (!isTauri()) throw new Error("Only in the app.");
          await windowIpc.unmaximize().catch(() => {});
          await windowIpc.setSize(width, height);
          await new Promise((r) => setTimeout(r, 400));
          return { width: window.innerWidth, height: window.innerHeight };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "dev.click",
        title: "Click element",
        category: "Developer",
        description:
          "Sends pointer/mouse down, up and click to the centre of the first element matching a CSS selector (UI tests of engine widgets that have no command). `right` sends a right-click (contextmenu) instead; `hover` only moves the pointer there; `double` double-clicks.",
        input: s.object({
          selector: s.string(),
          right: s.boolean().optional(),
          hover: s
            .boolean()
            .describe("Only move the pointer there (pointermove / mouseover), no click")
            .optional(),
          x: s
            .number()
            .describe("Horizontal position as a fraction of the width (default 0.5)")
            .optional(),
          double: s.boolean().describe("Two clicks, then dblclick").optional(),
          shift: s.boolean().describe("Hold Shift (D209: Shift+click)").optional(),
          ctrl: s.boolean().describe("Hold Ctrl (D209: Ctrl+click)").optional(),
        }),
        effects: ["write"],
        run: ({ selector, right, hover, x, double, shift, ctrl }) => {
          const el = document.querySelector<HTMLElement>(selector);
          if (!el) throw new Error(`No element matches ${selector}.`);
          const r = el.getBoundingClientRect();
          const at = {
            bubbles: true,
            cancelable: true,
            clientX: r.x + r.width * (x ?? 0.5),
            clientY: r.y + r.height / 2,
            button: right ? 2 : 0,
            shiftKey: shift === true,
            ctrlKey: ctrl === true,
          };
          if (hover) {
            el.dispatchEvent(new PointerEvent("pointerover", at));
            el.dispatchEvent(new PointerEvent("pointermove", at));
            el.dispatchEvent(new MouseEvent("mouseover", at));
            el.dispatchEvent(new MouseEvent("mousemove", at));
            return { hovered: el.tagName.toLowerCase() };
          }
          if (right) {
            el.dispatchEvent(new PointerEvent("pointerdown", at));
            el.dispatchEvent(new MouseEvent("mousedown", at));
            el.dispatchEvent(new MouseEvent("contextmenu", at));
            return { clicked: el.tagName.toLowerCase() };
          }
          for (let i = 0; i < (double ? 2 : 1); i++) {
            const n = { ...at, detail: i + 1 };
            el.dispatchEvent(new PointerEvent("pointerdown", n));
            el.dispatchEvent(new MouseEvent("mousedown", n));
            el.dispatchEvent(new PointerEvent("pointerup", n));
            el.dispatchEvent(new MouseEvent("mouseup", n));
            el.dispatchEvent(new MouseEvent("click", n));
          }
          if (double) el.dispatchEvent(new MouseEvent("dblclick", { ...at, detail: 2 }));
          return { clicked: el.tagName.toLowerCase() };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "dev.type",
        title: "Type into element",
        category: "Developer",
        description:
          "Sets the value of the first input matching a CSS selector (as typing would, with an input event; an element with an EditContext, the editor's, gets the text as a textupdate at its selection), then optionally presses a key there and/or releases one (UI tests of pickers and keybindings).",
        input: s.object({
          selector: s.string(),
          text: s.string().optional(),
          key: s.string().describe("A key to press after, e.g. Enter").optional(),
          code: s
            .string()
            .describe("Its KeyboardEvent.code (keybindings use it), e.g. Tab")
            .optional(),
          ctrl: s.boolean().describe("Hold Ctrl while pressing `key`").optional(),
          shift: s.boolean().describe("Hold Shift while pressing `key`").optional(),
          alt: s.boolean().describe("Hold Alt while pressing `key`").optional(),
          keyUp: s.string().describe("A key to release after, e.g. Control").optional(),
          inputType: s
            .string()
            .describe('The input event\'s inputType, e.g. "insertText" (xterm reads typing so)')
            .optional(),
        }),
        effects: ["write"],
        run: ({ selector, text, key, code, ctrl, shift, alt, keyUp, inputType }) => {
          const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
          if (!el) throw new Error(`No element matches ${selector}.`);
          el.focus();
          // The editor's native EditContext (Chromium, WebView2) gets text as the OS sends it: a
          // textupdate at its selection, so typing goes the real way (the `type` command).
          const editContext = (el as { editContext?: EditContextLike }).editContext;
          const TextUpdate = (globalThis as { TextUpdateEvent?: TextUpdateEventCtor })
            .TextUpdateEvent;
          if (text !== undefined && editContext && TextUpdate) {
            const at = editContext.selectionStart;
            editContext.dispatchEvent(
              new TextUpdate("textupdate", {
                updateRangeStart: at,
                updateRangeEnd: editContext.selectionEnd,
                text,
                selectionStart: at + text.length,
                selectionEnd: at + text.length,
              }),
            );
          } else if (text !== undefined) {
            el.value = text;
            el.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                data: text,
                ...(inputType && { inputType }),
              }),
            );
          }
          const mods = { ctrlKey: ctrl === true, shiftKey: shift === true, altKey: alt === true };
          if (key) {
            const event = new KeyboardEvent("keydown", {
              key,
              ...(code && { code }),
              ...mods,
              bubbles: true,
              cancelable: true,
            });
            // The editor engine reads the legacy keyCode (0 in synthetic events): letters and
            // digits get theirs, so its keybindings can be tested too, and so do named keys (its
            // rename box accepts on Enter's 13).
            const named: Record<string, number> = {
              Enter: 13,
              Escape: 27,
              Tab: 9,
              Backspace: 8,
              Delete: 46,
              ArrowLeft: 37,
              ArrowUp: 38,
              ArrowRight: 39,
              ArrowDown: 40,
              Home: 36,
              End: 35,
              PageUp: 33,
              PageDown: 34,
            };
            const legacy = /^[a-z0-9]$/i.test(key)
              ? key.toUpperCase().charCodeAt(0)
              : (named[key] ?? (/^F([1-9]|1[0-2])$/.test(key) ? 111 + Number(key.slice(1)) : 0));
            if (legacy) Object.defineProperty(event, "keyCode", { value: legacy });
            el.dispatchEvent(event);
          }
          if (keyUp)
            el.dispatchEvent(
              new KeyboardEvent("keyup", { key: keyUp, bubbles: true, cancelable: true }),
            );
          return { typed: text ?? "", key: key ?? null };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "dev.liveDisposables",
        title: "Show live disposables count",
        category: "Developer",
        description:
          "Number of created-but-not-disposed disposables (repeat an action; a steadily growing count means a leak).",
        input: s.empty(),
        effects: [],
        run: () => {
          const count = liveDisposableCount();
          notifications.show("info", `Live disposables: ${count}`);
          return { count };
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "dev.notify",
        title: "Show a test notification",
        category: "Developer",
        description:
          "Shows a notification (UI tests of the toasts: the same one again shows as one with a count, D345).",
        input: s.object({
          kind: s.enum(["info", "success", "warning", "error"] as const).optional(),
          message: s.string(),
        }),
        effects: [],
        run: ({ kind, message }) => {
          notifications.show(kind ?? "info", message);
          return {};
        },
      }),
    );
    sub.add(
      dispatcher.register({
        id: "dev.reload",
        title: "Reload window",
        category: "Developer",
        description: "Reloads the frontend (loses unsaved changes).",
        input: s.empty(),
        effects: ["destructive"],
        confirm: () => "Reload the window? Unsaved changes will be lost.",
        // The layout and terminals' output saved first (a reload brings them back, D204).
        run: async () => {
          await services.persistence.flush().catch(() => {});
          location.reload();
        },
      }),
    );

    sub.add(
      state.register("ide://dev/keyboard", {
        description:
          "Dev only: last key presses with how they resolved, plus all context keys (keybinding troubleshooting).",
        get: () => ({
          recent: services.keyboard.recent,
          context: services.context.snapshot(),
          activeElement: describe(document.activeElement),
        }),
      }),
    );

    registerIframeTest(sub, services);
    registerLayoutCheck(sub, services);
    registerA11yCheck(sub, services);

    // Warn in the console when live disposables grow steadily (PLAN §5).
    const monitor = new LeakMonitor(6);
    const timer = setInterval(() => {
      if (monitor.sample())
        console.warn(`Possible leak: live disposables keep growing (${liveDisposableCount()}).`);
    }, LEAK_SAMPLE_MS);
    sub.add({ dispose: () => clearInterval(timer) });
  },
};

function describe(el: Element | null): string {
  if (!el) return "none";
  const part = el.closest("[data-part]")?.getAttribute("data-part");
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className ? `.${el.className.trim().split(/\s+/).join(".")}` : ""}${part ? ` (part: ${part})` : ""}`;
}
