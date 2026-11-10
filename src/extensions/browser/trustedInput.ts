// Trusted input (D346): browser.input and the element actions (click, hover, press, type) send
// their events through a DevTools protocol, so the page sees a person's events (`isTrusted`), and
// fall back to the bridge's synthesized ones where that can't be done. The user's own browser
// (external.ts) takes them over its debugging socket; the built-in tab on Windows through
// WebView2's in-process protocol (Rust `browser/trusted_input.rs`; no port is opened), into the
// IDE's own webview at the frame's place (checked to be the frame first) or into a site's
// webview. The bridge (input.js `input.prepare` / `input.report`) says where events land, focuses
// and selects what typing replaces, and reports. The event sequences are core/browser/trustedInput.ts.
import { FRAME_MAX_SIDE } from "../../core/agent/browserInput";
import {
  type CdpCall,
  chordSteps,
  chordsText,
  clickSteps,
  dragSteps,
  hostPoint,
  hoverSteps,
  type InputStep,
  type Modifier,
  type Point,
  placeSteps,
  typeSteps,
  type Viewport,
  wheelSteps,
} from "../../core/browser/trustedInput";
import { browserIpc } from "../../core/ipc/browser";
import type { Platform } from "../../core/keybindings/keys";
import type { Page } from "./page";

/** Where one page's trusted events go. */
export interface InputSink {
  send(call: CdpCall): Promise<unknown>;
  /** A page point → the point the protocol takes; null when something of the IDE is on top. */
  place(at: Point, viewport: Viewport): Point | null;
  /** Keys reach the page (its frame focused in the IDE); false when they can't. */
  focus(): boolean;
  /** After the input: focus goes back to the IDE text field the user was in, if any. */
  release(): void;
  /** HTML drag and drop through the protocol's drag interception, when it can (false: it couldn't). */
  htmlDrag?(from: Point, to: Point, mods: Modifier[]): Promise<boolean>;
}

/** What browser.input takes, plus `clear` (browser.type into an element). */
export interface InputRequest {
  op: "click" | "hover" | "drag" | "scroll" | "key" | "type";
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  ref?: string;
  selector?: string;
  name?: string;
  button?: number;
  count?: number;
  modifiers?: Modifier[];
  dx?: number;
  dy?: number;
  keys?: { key: string; modifiers?: Modifier[] }[];
  repeat?: number;
  text?: string;
  submit?: boolean;
  clear?: boolean;
}

interface Prepared {
  viewport: Viewport;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  target?: string;
  covered?: string;
  over?: string;
  draggable?: boolean;
  focused?: string;
  into?: string;
}

/** A target that may take trusted input: a reason string when it can't. */
export interface TrustedTarget {
  readonly page: Page;
  inputSink?(): InputSink | string;
}

const settle = () => new Promise((r) => setTimeout(r, 120));

/**
 * Runs `request` as trusted input when the target can take it, else through `bridge` (the
 * bridge's own method for it). The result says which (`input: "trusted" | "synthesized"`) and,
 * when synthesized, why (`inputNote`).
 */
export async function runInput(
  target: TrustedTarget,
  request: InputRequest,
  bridge: () => Promise<unknown>,
  enabled: boolean,
): Promise<unknown> {
  const sink = enabled
    ? (target.inputSink?.() ?? "this page takes synthesized input")
    : "browser.trustedInput is off";
  if (typeof sink === "string") return synthesized(await bridge(), sink);
  const outcome = await trusted(target.page, sink, request);
  if (typeof outcome === "string") return synthesized(await bridge(), outcome);
  return { ...outcome, input: "trusted" };
}

function synthesized(result: unknown, why: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return {
    ...(result as Record<string, unknown>),
    input: "synthesized",
    inputNote: `Synthesized events (the page sees isTrusted false): ${why}.`,
  };
}

/** The input as protocol calls; a string when it has to go through the bridge instead. */
async function trusted(
  page: Page,
  sink: InputSink,
  r: InputRequest,
): Promise<Record<string, unknown> | string> {
  const mods = r.modifiers ?? [];
  const located = !!(r.ref || r.selector || r.name);
  const prep = await page.call<Prepared>("input.prepare", { ...r, maxSide: FRAME_MAX_SIDE });
  const at: Point = { x: prep.x ?? 0, y: prep.y ?? 0 };
  let steps: InputStep[];
  let result: Record<string, unknown>;
  switch (r.op) {
    case "click":
      steps = clickSteps(at, r.button ?? 0, r.count ?? 1, mods);
      result = {
        clicked: prep.target,
        ...(prep.covered && {
          note: `${prep.covered} is on top of it: the click went there, as a person's would.`,
        }),
      };
      break;
    case "hover":
      steps = hoverSteps(at, mods);
      result = { hovered: prep.target };
      break;
    case "drag": {
      const to = { x: prep.toX ?? 0, y: prep.toY ?? 0 };
      result = { dragged: prep.target, to: prep.over ?? null };
      if (prep.draggable) {
        // HTML drag and drop: only through drag interception (the user's browser).
        if (!sink.htmlDrag) return "HTML drag and drop in the built-in tab";
        const a = sink.place(at, prep.viewport);
        const b = sink.place(to, prep.viewport);
        if (!a || !b) return "something of the IDE covers the page there";
        if (!(await sink.htmlDrag(a, b, mods))) return "the page didn't start a drag";
        await settle();
        return { ...result, ...(await report(page)) };
      }
      steps = dragSteps(at, to, mods);
      break;
    }
    case "scroll":
      steps = wheelSteps(at, r.dx ?? 0, r.dy ?? 0, mods);
      result = { scrolled: `wheel at ${prep.target ?? "the page"}` };
      break;
    case "key": {
      const repeat = Math.min(100, Math.max(1, r.repeat ?? 1));
      const keys = r.keys ?? [];
      steps = [];
      try {
        for (let i = 0; i < repeat; i++)
          for (const k of keys) steps.push(...chordSteps(k.key, k.modifiers ?? []));
      } catch (err) {
        // A key a US keyboard doesn't have: the bridge dispatches it by name.
        return err instanceof Error ? err.message.replace(/\.$/, "") : "an unknown key";
      }
      result = { pressed: chordsText(keys, repeat) };
      break;
    }
    case "type": {
      const text = r.text ?? "";
      // Into an element: replaced at once (its text is selected), as browser.type does; at the
      // focus: typed key by key.
      steps = located
        ? text
          ? [{ method: "Input.insertText", params: { text } }]
          : chordSteps("Backspace")
        : typeSteps(text);
      if (r.submit) steps.push(...chordSteps("Enter"));
      result = { typed: [...text].length, into: prep.into };
      break;
    }
  }
  const pointer = r.op !== "key" && r.op !== "type";
  let placed: InputStep[];
  if (pointer) {
    let covered = false;
    placed = placeSteps(steps, (p) => {
      const q = sink.place(p, prep.viewport);
      if (!q) covered = true;
      return q ?? p;
    });
    if (covered) return "something of the IDE covers the page there";
  } else {
    if (!sink.focus()) return "the page's frame couldn't take the keyboard focus";
    placed = steps;
  }
  let sent = 0;
  try {
    for (const step of placed) {
      if ("waitMs" in step) await new Promise((res) => setTimeout(res, step.waitMs));
      else {
        await sink.send(step);
        sent++;
      }
    }
  } catch (err) {
    // Nothing reached the page yet: the bridge does it instead. Part of it did: say so.
    const message = err instanceof Error ? err.message : String(err);
    if (sent === 0) return `the protocol refused (${message})`;
    throw new Error(`Input stopped after ${sent} events: ${message}`);
  } finally {
    sink.release();
  }
  await settle();
  return { ...result, ...(r.op === "hover" ? {} : await report(page)) };
}

/** What the page looks like after (focus, a field's value, scroll, address); a navigation says so. */
async function report(page: Page): Promise<Record<string, unknown>> {
  const timeout = new Promise<Record<string, unknown>>((res) =>
    setTimeout(
      () => res({ navigating: true, note: "The page is loading; take a new snapshot." }),
      3000,
    ),
  );
  return Promise.race([
    page
      .call<Record<string, unknown>>("input.report")
      .catch(() => ({ navigating: true, note: "The page navigated; take a new snapshot." })),
    timeout,
  ]);
}

/** IDE elements the user types in, whose focus a trusted action gives back. */
function isTextEntry(el: Element | null): el is HTMLElement {
  if (!el || !("focus" in el)) return false;
  const tag = el.tagName;
  return (
    tag === "TEXTAREA" ||
    (tag === "INPUT" &&
      !/^(button|checkbox|radio|range|submit|reset|file|color)$/i.test(
        (el as HTMLInputElement).type,
      )) ||
    (el as HTMLElement).isContentEditable
  );
}

/**
 * The built-in tab's sink (Windows): the webview `label` shows the page, in the IDE's `frame`
 * (the IDE's own webview, or an auxiliary window's) or filling a site's webview (`frame` null).
 */
export function webviewSink(
  platform: Platform,
  label: string | null,
  frame: HTMLIFrameElement | null,
): InputSink | string {
  if (platform !== "windows")
    return "the built-in browser can't send trusted input on this system (WebView2 only); the user's own browser can (browser.connectExternal)";
  if (!label) return "the tab's window isn't known";
  const doc = frame?.ownerDocument ?? null;
  // The IDE text field the user was in (the chat box, an editor) gets its focus back after.
  const before = doc?.activeElement ?? null;
  return {
    send: (call) => browserIpc.trustedInput(label, call.method, call.params),
    place: (at, viewport) => {
      if (!frame || !doc) return at;
      const r = frame.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      const p = hostPoint(at, viewport, r);
      // Only where the frame itself is on top: never a click on the IDE.
      return doc.elementFromPoint(p.x, p.y) === frame ? p : null;
    },
    focus: () => {
      if (!frame || !doc) return true;
      if (doc.activeElement !== frame) frame.focus({ preventScroll: true });
      return doc.activeElement === frame;
    },
    release: () => {
      if (!doc || !frame || before === frame || !isTextEntry(before) || !before.isConnected) return;
      if (doc.activeElement === frame) before.focus({ preventScroll: true });
    },
  };
}
