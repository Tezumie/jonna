// show_widget's card and frame (D334). The widget is the model's code: it runs in a frame on the
// output origin (src-tauri/notebook/output/widget.html, the notebook outputs' local server),
// sandboxed without same-origin, under a policy with no network. The frame gets the code and the
// IDE's theme by message and posts back only its height, that it drew, an error, a clicked link
// and sendPrompt's text; each is checked here (a prompt or a link only while the frame has focus,
// that is right after the user clicked in it, and rate-limited).
//
// A chat re-renders its items often; an iframe moved or rebuilt reloads. So a widget's card is
// made once per chat view and returned as the same element every time (morph leaves it alone).
//
// D355: a widget is drawn while the model writes it. The streaming call's arguments come with its
// draft (core/agent/widgetStream.ts); the card shows under the turn, its frame gets the code so
// far by message (at most every 150 ms, no scripts) and morphs it in, and when the call is
// complete the tool's row adopts that same card and frame: the finished code is drawn once, with
// its scripts, without a reload.

import type { Item } from "../../../core/agent/conversation";
import { widgetDraft } from "../../../core/agent/widgetStream";
import {
  MAX_WIDGET_HEIGHT,
  PromptLimiter,
  parseWidget,
  promptText,
  WIDGET_VARIABLES,
  type Widget,
  type WidgetMode,
  widgetHeight,
  widgetLabel,
} from "../../../core/agent/widgets";
import { h, on } from "../../../core/dom/index";
import { DisposableStore } from "../../../core/lifecycle/index";
import { icon } from "../../../ui/Icon";
import { setTooltip } from "../../../ui/Tooltip";
import { outputOrigin } from "../../editor/notebook/outputFrame";
import { THEME_TOKENS } from "../../extensions/webview";

const NS = "ide-widget";

/** The tokens a widget gets: the pages' (THEME_TOKENS) and the guide's. */
const TOKENS = [...new Set([...THEME_TOKENS, ...Object.values(WIDGET_VARIABLES).flat()])];

let scheme: "dark" | "light" = "dark";

/** The IDE's theme now, as a widget gets it. */
export function widgetTheme(): { vars: Record<string, string>; scheme: "dark" | "light" } {
  const style = getComputedStyle(document.documentElement);
  const vars = Object.fromEntries(
    TOKENS.map((t) => [t, style.getPropertyValue(t).trim()]).filter(([, v]) => v),
  );
  return { vars, scheme };
}

/** What each widget's frame did, by `${session}:${item}` (ide://agent/widgets). */
export interface WidgetStatus {
  rendered: boolean;
  height: number;
  errors: string[];
  prompts: number;
  /** Drafts painted while the call was written (D355). */
  paints: number;
  /** Drawn while it was written: the finished widget took over the draft's frame (D355). */
  streamed: boolean;
  /** Times its page loaded: 1 unless the frame was moved or rebuilt (a reload draws again). */
  loads: number;
}
export const widgetStatus = new Map<string, WidgetStatus>();

export interface WidgetFrameHost {
  /** sendPrompt's text, from a click in the frame (checked and rate-limited here). */
  prompt(text: string): void;
  openLink(url: string): void;
  /** It drew, or its height or errors changed. */
  changed?(): void;
}

/** Live frames (those on the page): theme changes and messages go to them. */
const live = new Set<WidgetFrame>();
const listening = new WeakSet<Window>();

function listenOn(win: Window | null): void {
  if (!win || listening.has(win)) return;
  listening.add(win);
  win.addEventListener("message", (e: MessageEvent) => {
    if (!e.source) return;
    for (const f of live)
      if (e.source === f.frame.contentWindow) {
        f.handle(e.data);
        return;
      }
  });
}

/**
 * Frames no longer on the page are dropped (one that comes back re-joins when it reloads); a new
 * one may not be on the page yet.
 */
function prune(): void {
  const now = Date.now();
  for (const f of live) if (!f.frame.isConnected && now - f.created > 30_000) live.delete(f);
}

/** The theme went to every widget (the IDE's theme changed). */
export function refreshWidgetThemes(kind: "dark" | "light"): void {
  scheme = kind;
  prune();
  const theme = widgetTheme();
  for (const f of live) f.post({ theme });
}

export class WidgetFrame {
  readonly frame: HTMLIFrameElement;
  private readonly store = new DisposableStore();
  private ready = false;
  private readonly limiter = new PromptLimiter();
  private lastLink = 0;
  /** A UI test's click inside: prompts may come without the frame having focus until then. */
  private testUntil = 0;
  private clicked: ((found: boolean) => void) | null = null;
  /** The code so far while the call is written (D355), until `finish`. */
  private draftCode: { code: string; mode: WidgetMode } | null = null;
  readonly status: WidgetStatus;
  readonly created = Date.now();

  constructor(
    /** null while the call is still written: drafts are shown until `finish` (D355). */
    private widget: Widget | null,
    private readonly host: WidgetFrameHost,
    /** Fills its container (a tab) instead of sizing to its content. */
    private readonly fill: boolean,
    /** Where its status is kept (ide://agent/widgets), if anywhere. */
    statusKey?: string,
  ) {
    this.status = {
      rendered: false,
      height: 0,
      errors: [],
      prompts: 0,
      paints: 0,
      streamed: false,
      loads: 0,
    };
    if (statusKey) widgetStatus.set(statusKey, this.status);
    this.frame = h("iframe", {
      class: { "agent-widget-frame": true, "is-fill": fill },
      // Scripts only: no same-origin (it can't reach the IDE), no popups, forms or navigating
      // the IDE. Its own policy (widget.html) allows no network.
      sandbox: "allow-scripts",
      title: widgetLabel(widget?.title ?? ""),
      loading: "eager",
      referrerpolicy: "no-referrer",
    }) as HTMLIFrameElement;
    if (!fill) this.frame.style.height = "0px";
    prune();
    live.add(this);
    listenOn(window);
    this.store.add(
      on(this.frame, "load", () => {
        // Moved in the page (or into another window): it reloaded, and draws again.
        live.add(this);
        listenOn(this.frame.ownerDocument.defaultView);
        this.ready = false;
        // The blank page a frame has before its address is set doesn't count.
        if (this.frame.getAttribute("src")) this.status.loads++;
        this.post({ ping: true }, true);
      }),
    );
    void outputOrigin().then(
      (origin) => {
        if (this.store.isDisposed) return;
        this.frame.src = `${origin}/widget.html`;
      },
      (err: unknown) => this.fail(err instanceof Error ? err.message : String(err)),
    );
  }

  private fail(message: string): void {
    this.status.errors.push(`The widget can't be shown: ${message}`);
    this.host.changed?.();
  }

  /** Where its status is kept from now on (a draft's frame, adopted by its call's row). */
  keepStatusAt(key: string): void {
    widgetStatus.set(key, this.status);
  }

  /** The code so far (D355): drawn without scripts, morphed into what's there. */
  showDraft(code: string, mode: WidgetMode): void {
    if (this.widget) return;
    this.draftCode = { code, mode };
    this.postDraft();
  }

  /** The call is complete: the finished widget is drawn, scripts and all. */
  finish(widget: Widget): void {
    this.widget = widget;
    this.frame.title = widgetLabel(widget.title);
    this.postRender();
  }

  private postDraft(): void {
    if (!this.draftCode) return;
    const theme = widgetTheme();
    this.post({
      draft: {
        code: this.draftCode.code,
        mode: this.draftCode.mode,
        fill: this.fill,
        theme: theme.vars,
        scheme: theme.scheme,
        maxHeight: MAX_WIDGET_HEIGHT,
      },
    });
  }

  private postRender(): void {
    if (!this.widget) return;
    const theme = widgetTheme();
    this.post({
      render: {
        code: this.widget.code,
        mode: this.widget.mode,
        fill: this.fill,
        theme: theme.vars,
        scheme: theme.scheme,
        maxHeight: MAX_WIDGET_HEIGHT,
      },
    });
  }

  post(message: Record<string, unknown>, always = false): void {
    if (!this.ready && !always) return;
    this.frame.contentWindow?.postMessage({ ns: NS, ...message }, "*");
  }

  /** The frame has focus: the user clicked or typed in it. */
  private focused(): boolean {
    if (Date.now() < this.testUntil) return true;
    const doc = this.frame.ownerDocument;
    return doc.activeElement === this.frame && doc.hasFocus();
  }

  handle(data: unknown): void {
    const m = data as Record<string, unknown> | null;
    if (!m || m.ns !== NS) return;
    if (m.ready) {
      this.ready = true;
      if (this.widget) this.postRender();
      else this.postDraft();
    } else if (m.painted) {
      this.status.paints++;
      this.host.changed?.();
    } else if (m.rendered) {
      this.status.rendered = true;
      this.host.changed?.();
    } else if ("height" in m) {
      const px = widgetHeight(m.height);
      if (px === null || this.fill) return;
      this.status.height = px;
      this.frame.style.height = `${px}px`;
      this.frame.setAttribute(
        "scrolling",
        typeof m.height === "number" && m.height > MAX_WIDGET_HEIGHT ? "yes" : "no",
      );
      this.host.changed?.();
    } else if ("prompt" in m) {
      const text = promptText(m.prompt);
      if (!text || !this.focused() || !this.limiter.allow(Date.now())) return;
      this.status.prompts++;
      this.host.prompt(text);
    } else if (typeof m.link === "string") {
      const now = Date.now();
      if (!/^https?:\/\//i.test(m.link) || !this.focused() || now - this.lastLink < 1000) return;
      this.lastLink = now;
      this.host.openLink(m.link);
    } else if (typeof m.error === "string") {
      if (this.status.errors.length < 5) this.status.errors.push(m.error.slice(0, 300));
      this.host.changed?.();
    } else if ("clicked" in m) {
      this.clicked?.(m.clicked === true);
      this.clicked = null;
    }
  }

  /** UI tests: clicks the first element matching `selector` inside, as the user would. */
  testClick(selector: string): Promise<boolean> {
    if (!this.ready) return Promise.resolve(false);
    this.testUntil = Date.now() + 2000;
    return new Promise((resolve) => {
      this.clicked = resolve;
      this.post({ testClick: selector });
      setTimeout(() => resolve(false), 2000);
    });
  }

  /** Disposed with the frame (its card's timers). */
  own(d: { dispose(): void }): void {
    this.store.add(d);
  }

  dispose(): void {
    live.delete(this);
    this.store.dispose();
  }
}

// ---- The card in the chat -------------------------------------------------------------------------

export interface WidgetCardHost {
  session: string;
  item: string;
  /** The call's id: a draft of the same call hands over its card (D355). */
  callId?: string;
  run(command: string, input?: unknown): void;
  openLink(href: string): void;
}

interface CardEntry {
  el: HTMLElement;
  frame: WidgetFrame;
  code: string;
  /** Its title and loading lines changed (a draft's grow as they're written). */
  setMeta(title: string, loading: readonly string[], finished?: boolean): void;
}

/** Cards by chat view (its item host), then by `${session}:${item}`. */
const cards = new WeakMap<object, Map<string, CardEntry>>();

/** Every card's frame by `${session}:${item}` (the newest), for UI tests' clicks. */
const framesByItem = new Map<string, WidgetFrame>();

/** The frame showing a widget in the chat (UI tests). */
export function widgetFrameOf(session: string, item: string): WidgetFrame | undefined {
  const f = framesByItem.get(`${session}:${item}`);
  return f?.frame.isConnected ? f : undefined;
}

/**
 * show_widget's card for this view: the same element for as long as the call's code is the same;
 * null when there's nothing to draw (the call failed: shown as a row).
 */
export function widgetCard(
  view: object,
  args: unknown,
  failed: boolean,
  host: WidgetCardHost,
): HTMLElement | null {
  const draftKey = host.callId ? `${host.session}#${host.callId}` : "";
  const widget = parseWidget(args);
  if (failed || "error" in widget) {
    // A draft of a call that failed goes (the row says why).
    if (draftKey) dropDraft(view, draftKey);
    return null;
  }
  const key = `${host.session}:${host.item}`;
  let byKey = cards.get(view);
  if (!byKey) {
    byKey = new Map();
    cards.set(view, byKey);
  }
  const have = byKey.get(key);
  if (have && have.code === widget.code) return have.el;
  have?.frame.dispose();
  // Drawn while it was written (D355): the draft's card and frame carry on as the widget's.
  const draft = !have && draftKey ? drafts.get(view)?.get(draftKey) : undefined;
  let entry: CardEntry;
  if (draft) {
    clearTimeout(draft.timer);
    drafts.get(view)?.delete(draftKey);
    draftStatus.delete(draftKey);
    entry = draft.entry;
    draft.ids.item = host.item;
    entry.code = widget.code;
    entry.setMeta(widget.title, widget.loading, true);
    entry.el.dataset.key = `widget-${key}`;
    entry.el.classList.remove("is-draft");
    setMode(entry.el, widget.mode);
    entry.frame.status.streamed = true;
    entry.frame.keepStatusAt(key);
    entry.frame.finish(widget);
  } else entry = buildCard(widget, { ...host }, key);
  byKey.set(key, entry);
  // Frames gone from the page (a closed chat) aren't kept for tests' clicks; a new one may not be
  // on the page yet.
  const now = Date.now();
  for (const [k, f] of framesByItem)
    if (!f.frame.isConnected && now - f.created > 30_000) framesByItem.delete(k);
  framesByItem.set(key, entry.frame);
  return entry.el;
}

/**
 * The chat view closed: its cards' frames and drafts go, with their timers (a draft whose call
 * never finished kept turning its loading lines forever).
 */
export function disposeWidgetCards(view: object): void {
  for (const entry of cards.get(view)?.values() ?? []) entry.frame.dispose();
  cards.delete(view);
  for (const key of [...(drafts.get(view)?.keys() ?? [])]) dropDraft(view, key);
  drafts.delete(view);
}

/** What a card's buttons act on: the item is known once the call is complete (a draft's isn't). */
interface CardIds {
  session: string;
  item: string;
  run(command: string, input?: unknown): void;
  openLink(href: string): void;
}

function buildCard(
  widget: Widget | null,
  ids: CardIds,
  key: string | undefined,
  meta: { title: string; mode: WidgetMode; loading: readonly string[] } = {
    title: widget?.title ?? "",
    mode: widget?.mode ?? "html",
    loading: widget?.loading ?? [],
  },
): CardEntry {
  const target = () => ({ session: ids.session, item: ids.item });
  const loading = h("div", { class: "agent-widget-loading agent-thought is-shimmer" });
  let lines = meta.loading.length ? [...meta.loading] : ["Drawing the widget"];
  let line = 0;
  loading.textContent = lines[0] ?? "";
  const card: { el?: HTMLElement } = {};
  const timer = setInterval(() => {
    line = (line + 1) % lines.length;
    loading.textContent = lines[line] ?? "";
  }, 1600);
  const stopLoading = () => clearInterval(timer);
  // Not drawn after a while (the frame can't load): the lines stop turning. A draft's call may
  // take longer than that to write: its clock starts when the call is complete.
  let giveUp = widget ? setTimeout(stopLoading, 30_000) : undefined;
  const errorLine = h("div", { class: "agent-widget-error" });
  const frame = new WidgetFrame(
    widget,
    {
      prompt: (text) => {
        if (ids.item) ids.run("agent.sendFromWidget", { ...target(), text });
      },
      openLink: (url) => ids.openLink(url),
      changed: () => {
        const el = card.el;
        if (!el) return;
        const s = frame.status;
        el.classList.toggle("is-rendered", s.rendered);
        // The loading lines show until the first paint, a draft's or the finished widget's.
        if (s.rendered || s.paints > 0 || s.errors.length) {
          stopLoading();
          loading.remove();
        }
        errorLine.textContent = s.errors.length ? `Script error: ${s.errors[0]}` : "";
      },
    },
    false,
    key,
  );
  frame.own({
    dispose: () => {
      stopLoading();
      clearTimeout(giveUp);
    },
  });
  const action = (glyph: Parameters<typeof icon>[0], label: string, command: string) => {
    const b = h(
      "button",
      { class: "icon-button agent-widget-action", type: "button", "aria-label": label },
      icon(glyph),
    );
    setTooltip(b, label);
    on(b, "click", () => {
      if (ids.item) ids.run(command, target());
    });
    return b;
  };
  const title = h("span", { class: "agent-widget-title" }, widgetLabel(meta.title));
  const el = h(
    "div",
    {
      class: {
        "agent-display": true,
        "agent-widget": true,
        [`is-${meta.mode}`]: true,
        "is-draft": !widget,
      },
      "data-key": key ? `widget-${key}` : "widget-draft",
      "data-widget": meta.title,
    },
    h(
      "div",
      { class: "agent-widget-head" },
      title,
      h(
        "span",
        { class: "agent-widget-actions" },
        action("maximize-2", "Open in a tab", "agent.openWidget"),
        action("copy", "Copy code", "agent.copyWidgetCode"),
        action("download", "Save as file…", "agent.saveWidget"),
      ),
    ),
    h("div", { class: "agent-widget-body" }, loading, frame.frame),
    errorLine,
  );
  card.el = el;
  return {
    el,
    frame,
    code: widget?.code ?? "",
    setMeta: (name, more, finished) => {
      if (name && name !== el.dataset.widget) {
        title.textContent = widgetLabel(name);
        el.dataset.widget = name;
      }
      if (more.length && more.join("\n") !== lines.join("\n")) {
        lines = [...more];
        line = Math.min(line, lines.length - 1);
        loading.textContent = lines[line] ?? "";
      }
      if (finished && giveUp === undefined) giveUp = setTimeout(stopLoading, 30_000);
    },
  };
}

// ---- Drafts: a widget drawn while it's written (D355) ----------------------------------------------

interface DraftEntry {
  entry: CardEntry;
  /** What its buttons act on; the item is filled in when the call's row adopts it. */
  ids: CardIds;
  /** The code last sent to the frame, and when. */
  sent: string;
  sentAt: number;
  timer?: ReturnType<typeof setTimeout>;
  touched: number;
  /** The newest partial arguments (a repaint held back reads them when it runs). */
  args: string;
}

/** The card's SVG / HTML class (a draft's is known once its code starts). */
function setMode(el: HTMLElement, mode: WidgetMode): void {
  el.classList.toggle("is-svg", mode === "svg");
  el.classList.toggle("is-html", mode === "html");
}

/** Draft cards by chat view, then by `${session}#${call id}`. */
const drafts = new WeakMap<object, Map<string, DraftEntry>>();

/** What each draft's frame did (ide://agent/widgets `drafts`), by `${session}#${call id}`. */
const draftStatus = new Map<string, { title: string; chars: number; status: WidgetStatus }>();

/** How often a draft is repainted at most (the provider sends it about as often). */
const DRAFT_EVERY_MS = 150;

function dropDraft(view: object, key: string): void {
  const d = drafts.get(view)?.get(key);
  if (!d) return;
  clearTimeout(d.timer);
  d.entry.frame.dispose();
  drafts.get(view)?.delete(key);
  draftStatus.delete(key);
}

/** Drafts no longer drawn (a turn stopped mid-call) and left alone a while go. */
function pruneDrafts(view: object): void {
  const now = Date.now();
  for (const [key, d] of drafts.get(view) ?? [])
    if (!d.entry.el.isConnected && now - d.touched > 10_000) dropDraft(view, key);
}

/** The show_widget call being written at the end of the conversation, if any. */
export function streamingWidget(items: readonly Item[]): { id: string; args: string } | null {
  const last = items[items.length - 1];
  if (last?.type !== "assistant" || !last.streaming) return null;
  const d = last.toolDraft;
  if (d?.name !== "show_widget" || d.args === undefined) return null;
  return { id: d.id ?? `${last.id}-draft`, args: d.args };
}

/**
 * The card of a show_widget call still being written (D355), under the turn where the finished
 * card will be: the code so far is painted (no scripts) at most every 150 ms; its loading lines
 * show until the first paint. Null while there's nothing to show yet.
 */
export function widgetDraftCard(
  view: object,
  call: { id: string; args: string },
  host: Omit<WidgetCardHost, "item" | "callId">,
): HTMLElement | null {
  pruneDrafts(view);
  const key = `${host.session}#${call.id}`;
  let byKey = drafts.get(view);
  if (!byKey) {
    byKey = new Map();
    drafts.set(view, byKey);
  }
  let d = byKey.get(key);
  // The chat redraws for other reasons too: the same arguments aren't read again.
  if (d && d.args === call.args) {
    d.touched = Date.now();
    return d.entry.el;
  }
  const draft = widgetDraft(call.args);
  if (!d) {
    if (!draft.code && !draft.loading.length) return null;
    const ids: CardIds = {
      session: host.session,
      item: "",
      run: host.run,
      openLink: host.openLink,
    };
    const entry = buildCard(null, ids, undefined, draft);
    d = { entry, ids, sent: "", sentAt: 0, touched: Date.now(), args: call.args };
    byKey.set(key, d);
  }
  d.touched = Date.now();
  d.args = call.args;
  d.entry.setMeta(draft.title, draft.loading);
  if (draft.code) setMode(d.entry.el, draft.mode);
  draftStatus.set(key, { title: draft.title, chars: draft.chars, status: d.entry.frame.status });
  const entry = d;
  const send = () => {
    entry.timer = undefined;
    const latest = widgetDraft(entry.args);
    if (!latest.code || latest.code === entry.sent) return;
    entry.sent = latest.code;
    entry.sentAt = Date.now();
    entry.entry.frame.showDraft(latest.code, latest.mode);
  };
  if (draft.code && draft.code !== d.sent && !d.timer) {
    const wait = DRAFT_EVERY_MS - (Date.now() - d.sentAt);
    if (wait <= 0) send();
    else d.timer = setTimeout(send, wait);
  }
  return d.entry.el;
}

/** The drafts of a chat being drawn now (ide://agent/widgets). */
export function widgetDrafts(
  session: string,
): { call: string; title: string; chars: number; paints: number; height: number }[] {
  return [...draftStatus]
    .filter(([key]) => key.startsWith(`${session}#`))
    .map(([key, d]) => ({
      call: key.slice(session.length + 1),
      title: d.title,
      chars: d.chars,
      paints: d.status.paints,
      height: d.status.height,
    }));
}
