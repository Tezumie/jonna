// The user's own Chrome or Edge as a target of the browser commands (D341): connected over the
// DevTools protocol on a debugging port (one the IDE started with a profile of its own, or one the
// user started), it is the "external" tab of browser.list. The same bridge as the tabs' is
// installed in its page (reporting through a protocol binding, called through Runtime.evaluate),
// so a `Page` drives it as it drives a tab: snapshot, find, text, clicks, typing, keys, uploads,
// console. Screenshots are Page.captureScreenshot. One page at a time: the tab it was connected to
// (or the one browser.connectExternal `url` picks). The protocol half is core/browser/cdp.ts.
// D346: its input is a person's (Input.dispatchMouseEvent / dispatchKeyEvent / insertText, and
// drag interception for HTML drag and drop; trustedInput.ts). D347: its DevTools data (requests,
// DOM, styles, storage, highlight, emulation, the browser's own console lines) comes over the
// protocol too (externalDevtools.ts).
import {
  bindingMessage,
  bindingName,
  bridgeCall,
  bridgeInstall,
  CdpClient,
  type CdpTarget,
  DEFAULT_DEBUG_PORT,
  EXTERNAL_TAB,
  externalUrl,
  launchArgs,
  parsePort,
  parseTargets,
  pickExternalPage,
  pngSize,
} from "../../core/browser/cdp";
import { modifierBits, type Point } from "../../core/browser/trustedInput";
import { browserIpc } from "../../core/ipc/browser";
import { fsIpc } from "../../core/ipc/fs";
import { debugSocketIpc } from "../../core/ipc/process";
import type { Disposable } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import type { Shot } from "../../workbench/screenshot";
import type { TaskExecution, WorkbenchServices } from "../../workbench/services";
import { workspaceFolderPath } from "../../workbench/workspaceFolder";
import { ExternalDevtools } from "./externalDevtools";
import { Page } from "./page";
import type { InputSink } from "./trustedInput";

export { EXTERNAL_TAB };

/** What the page commands need of a target: a browser tab, or the user's own browser. */
export interface PageTarget {
  readonly page: Page;
  capture(): Promise<Shot>;
  /** Trusted input (D346), or why the page takes synthesized input only. */
  inputSink?(): InputSink | string;
  /** The DevTools protocol's data commands (D347): the user's own browser only. */
  readonly cdp?: ExternalDevtools | null;
}

let socketIds = 0;

export class ExternalBrowser implements PageTarget, Disposable {
  /** Connected to a page (state for ide://browser and the agent's tools). */
  readonly connected = signal(false);
  /** The browser commands act on it when no tab is given (browser.selectTab "external"). */
  readonly selected = signal(false);
  private client: CdpClient | null = null;
  private socket: string | null = null;
  private current: Page | null = null;
  private port = 0;
  private browserName = "";
  private launched: TaskExecution | null = null;
  private mainFrame = "";
  private devtools: ExternalDevtools | null = null;
  /** Calls waiting for a protocol event (drag interception). */
  private readonly waiters = new Set<{ method: string; done: (params: unknown) => void }>();

  constructor(private readonly services: WorkbenchServices) {}

  get page(): Page {
    if (!this.current)
      throw new Error(
        "The external browser isn't connected (browser.launchExternal or browser.connectExternal).",
      );
    return this.current;
  }

  /** Whether `tab` (or no tab while it's selected) means this browser. */
  handles(tab?: string): boolean {
    return tab === EXTERNAL_TAB || (!tab && this.selected.peek() && this.connected.peek());
  }

  select(): { tab: string; url: string; title: string } {
    const page = this.page;
    this.selected.value = true;
    this.updateContext();
    return { tab: EXTERNAL_TAB, url: page.url.peek(), title: page.title.peek() };
  }

  deselect(): void {
    if (!this.selected.peek()) return;
    this.selected.value = false;
    this.updateContext();
  }

  /** How browser.list shows it. */
  summary(): {
    tab: string;
    url: string;
    title: string;
    shownIn: string;
    connected: boolean;
    errors: number;
    warnings: number;
  } | null {
    const page = this.current;
    if (!page || !this.connected.peek()) return null;
    return {
      tab: EXTERNAL_TAB,
      url: page.url.peek(),
      title: page.title.peek(),
      shownIn: `your ${this.browserName || "browser"} (port ${this.port})`,
      connected: page.connected.peek(),
      errors: page.console.peek().filter((e) => e.level === "error").length,
      warnings: page.console.peek().filter((e) => e.level === "warn").length,
    };
  }

  /**
   * Starts the installed Chrome or Edge with a debugging port and a profile of its own (in the
   * workspace's IDE folder, kept out of git; the user's everyday profile can't take a port while
   * it runs), then connects to it.
   */
  async launch(kind: "chrome" | "edge", port: number, url?: string) {
    const name = kind === "edge" ? "Edge" : "Chrome";
    const exe = await debugSocketIpc.findBrowser(kind).catch(() => null);
    if (!exe) throw new Error(`${name} wasn't found on this computer.`);
    const root = this.services.workspace.root.peek();
    if (!root) throw new Error("Open a folder first: the browser's profile is kept in it.");
    const profile = workspaceFolderPath(root, "external-browser-profile");
    await fsIpc.createDir(workspaceFolderPath(root), "external-browser-profile").catch(() => {});
    await fsIpc
      .write(joinPath(profile, ".gitignore"), new TextEncoder().encode("*\n"))
      .catch(() => {});
    this.disconnect();
    this.launched = await this.services.taskTerminals.run({
      label: `${name} (port ${port})`,
      spec: { kind: "process", command: exe, args: launchArgs(port, profile, url) },
      cwd: root,
      presentation: {
        reveal: "never",
        focus: false,
        panel: "dedicated",
        clear: false,
        close: false,
      },
    });
    let ended = false;
    void this.launched.exited.then(() => {
      ended = true;
    });
    // Its page, once the port answers.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const list = await this.targets(port).catch(() => null);
      if (list?.length) break;
      if (ended) throw new Error(`${name} closed before it opened its debugging port.`);
      if (Date.now() > deadline)
        throw new Error(`${name} didn't open its debugging port (${port}).`);
      await new Promise((r) => setTimeout(r, 300));
    }
    return this.connect(port, url ? externalUrl(url) : undefined, name);
  }

  private async targets(port: number): Promise<CdpTarget[]> {
    return parseTargets(await debugSocketIpc.targets("127.0.0.1", port));
  }

  /** Connects to a browser's page on `port` (the one at `url`, else its first ordinary page). */
  async connect(port: number = DEFAULT_DEBUG_PORT, url?: string, name?: string) {
    let list: CdpTarget[];
    try {
      list = await this.targets(port);
    } catch (err) {
      throw new Error(
        `Nothing answers on port ${port}: start Chrome or Edge with --remote-debugging-port=${port} (browser.launchExternal does). ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const target = pickExternalPage(list, url);
    if (!target?.webSocketDebuggerUrl) throw new Error(`No page to connect to on port ${port}.`);
    this.disconnect();
    const socket = `external-browser-${++socketIds}`;
    const binding = bindingName();
    const page = new Page(EXTERNAL_TAB, "window", (message) => {
      void this.client
        ?.request("Runtime.evaluate", { expression: bridgeCall(message) })
        .catch(() => {});
    });
    const client = new CdpClient(
      (text) => void debugSocketIpc.send(socket, text).catch(() => {}),
      (method, params) => this.event(page, binding, method, params),
    );
    this.client = client;
    this.socket = socket;
    this.current = page;
    this.port = port;
    this.browserName = name ?? (/edg/i.test(target.url ?? "") ? "Edge" : "browser");
    try {
      await debugSocketIpc.connect(socket, target.webSocketDebuggerUrl, (e) => {
        if (e.kind === "message") client.handle(e.body);
        else if (this.socket === socket)
          this.disconnect(`The browser closed the connection (${e.reason}).`);
      });
      const install = bridgeInstall(await browserIpc.bridgeSource(), binding);
      await client.request("Runtime.enable");
      await client.request("Runtime.addBinding", { name: binding });
      await client.request("Page.enable");
      const tree = await client.request<{ frameTree?: { frame?: { id?: string } } }>(
        "Page.getFrameTree",
      );
      this.mainFrame = tree.frameTree?.frame?.id ?? "";
      await client.request("Page.addScriptToEvaluateOnNewDocument", { source: install });
      const devtools = new ExternalDevtools(
        (method, params) => client.request(method, params ?? {}),
        page,
        () => this.mainFrame,
      );
      this.devtools = devtools;
      await devtools.start().catch(() => {});
      // The page already open: installed now (a bridge left from an earlier connection takes the
      // new binding), then asked to say it's there.
      await client.request("Runtime.evaluate", { expression: install });
      await client.request("Runtime.evaluate", {
        expression: bridgeCall({ ns: "ide-host", type: "hello" }),
      });
      if (url && target.url && !target.url.startsWith(url))
        await client.request("Page.navigate", { url });
      await page.whenReady(10000).catch(() => {});
    } catch (err) {
      // Only this connection's: a newer connect (or a disconnect) may have replaced it meanwhile.
      if (this.current === page) this.disconnect();
      throw err;
    }
    // Replaced while it connected (another connect, a disconnect): that one stands.
    if (this.current !== page) throw new Error("The connection was replaced while it started.");
    this.connected.value = true;
    this.updateContext();
    return { tab: EXTERNAL_TAB, port, url: page.url.peek(), title: page.title.peek() };
  }

  private event(page: Page, binding: string, method: string, params: unknown): void {
    if (page !== this.current) return;
    for (const w of this.waiters) if (w.method === method) w.done(params);
    this.devtools?.event(method, params);
    if (method === "Runtime.bindingCalled") {
      const message = bindingMessage(params, binding);
      if (message) page.handle(message);
    } else if (method === "Page.frameStartedLoading") {
      const frame = (params as { frameId?: unknown } | null)?.frameId;
      if (frame === this.mainFrame) {
        page.beginLoad();
        this.devtools?.newDocument();
      }
    } else if (method === "Inspector.detached") this.disconnect("The browser's page went away.");
  }

  /** Lets go of the browser (it stays open). True when it was connected. */
  disconnect(reason = "Disconnected from the external browser."): boolean {
    const was = !!this.current;
    this.client?.close(reason);
    if (this.socket) void debugSocketIpc.close(this.socket).catch(() => {});
    this.current?.abort(reason);
    this.current?.dispose();
    this.client = null;
    this.socket = null;
    this.current = null;
    this.devtools = null;
    for (const w of this.waiters) w.done(null);
    this.connected.value = false;
    this.selected.value = false;
    this.updateContext();
    return was;
  }

  private request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) throw new Error("The external browser isn't connected.");
    return this.client.request<T>(method, params);
  }

  /** The DevTools data commands for this page (D347), while connected. */
  get cdp(): ExternalDevtools | null {
    return this.current ? this.devtools : null;
  }

  /** The protocol's event `method` (its params), or null after `timeoutMs` or a disconnect. */
  private waitFor(method: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve) => {
      const w = {
        method,
        done: (params: unknown) => {
          clearTimeout(timer);
          this.waiters.delete(w);
          resolve(params);
        },
      };
      const timer = setTimeout(() => w.done(null), timeoutMs);
      this.waiters.add(w);
    });
  }

  /** A person's input over the protocol (D346): points are the page's CSS pixels as they are. */
  inputSink(): InputSink | string {
    if (!this.client) return "the external browser isn't connected";
    const send = (call: { method: string; params: Record<string, unknown> }) =>
      this.request(call.method, call.params);
    return {
      send,
      place: (at) => at,
      focus: () => true,
      release: () => {},
      htmlDrag: (from, to, mods) => this.htmlDrag(from, to, modifierBits(mods)),
    };
  }

  /**
   * HTML drag and drop as Chrome does it for automation: with drags intercepted, a press and
   * moves start the drag and the browser hands over its data (Input.dragIntercepted), which is
   * then dragged over and dropped at the target with Input.dispatchDragEvent.
   */
  private async htmlDrag(from: Point, to: Point, modifiers: number): Promise<boolean> {
    const mouse = (type: string, at: Point, extra: Record<string, unknown> = {}) =>
      this.request("Input.dispatchMouseEvent", {
        type,
        x: at.x,
        y: at.y,
        modifiers,
        pointerType: "mouse",
        ...extra,
      });
    await this.request("Input.setInterceptDrags", { enabled: true });
    try {
      const intercepted = this.waitFor("Input.dragIntercepted", 2000);
      await mouse("mouseMoved", from);
      await mouse("mousePressed", from, { button: "left", buttons: 1, clickCount: 1 });
      const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      await mouse("mouseMoved", mid, { button: "left", buttons: 1 });
      await mouse("mouseMoved", to, { button: "left", buttons: 1 });
      const data = (await intercepted) as { data?: unknown } | null;
      if (!data?.data) {
        await mouse("mouseReleased", to, { button: "left", buttons: 0, clickCount: 1 });
        return false;
      }
      for (const type of ["dragEnter", "dragOver", "drop"])
        await this.request("Input.dispatchDragEvent", {
          type,
          x: to.x,
          y: to.y,
          data: data.data,
          modifiers,
        });
      await mouse("mouseReleased", to, { button: "left", buttons: 0, clickCount: 1 });
      return true;
    } finally {
      await this.request("Input.setInterceptDrags", { enabled: false }).catch(() => {});
    }
  }

  async navigate(address: string): Promise<{ url: string; title: string }> {
    const page = this.page;
    const r = await this.request<{ errorText?: string }>("Page.navigate", {
      url: externalUrl(address),
    });
    if (r.errorText) throw new Error(`The browser couldn't open it: ${r.errorText}.`);
    await page.whenReady(10000).catch(() => {});
    return { url: page.url.peek(), title: page.title.peek() };
  }

  async history(direction: "back" | "forward"): Promise<unknown> {
    return this.page.call(direction);
  }

  async reload(): Promise<void> {
    await this.request("Page.reload");
  }

  /** The page's viewport as the browser draws it (device pixels). */
  async capture(): Promise<Shot> {
    const r = await this.request<{ data?: string }>("Page.captureScreenshot", { format: "png" });
    const bin = atob(r.data ?? "");
    const png = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) png[i] = bin.charCodeAt(i);
    const size = pngSize(png);
    if (!size) throw new Error("The browser's screenshot couldn't be read.");
    return { png, ...size };
  }

  private updateContext(): void {
    this.services.context.set("browserExternal", this.connected.peek());
    this.services.context.set(
      "browserExternalCurrent",
      this.connected.peek() && this.selected.peek(),
    );
  }

  dispose(): void {
    this.disconnect();
    // The browser the IDE started ends with it (its terminal would end it anyway).
    this.launched = null;
  }
}

type Register = WorkbenchServices["dispatcher"]["register"];

export function registerExternalCommands(register: Register, external: ExternalBrowser): void {
  register({
    id: "browser.launchExternal",
    title: "Open your own browser for the agent…",
    description:
      'Starts the installed Chrome or Edge with a debugging port and a profile of its own (kept in the workspace\'s IDE folder), connects to it and makes it the target of the browser commands (tab "external"): snapshot, find, text, clicks, typing and keys as trusted events, uploads, console, screenshots, and DevTools data (network with bodies, dom, styles, storage, highlight, resize). `url` opens first.',
    input: s.object({
      browser: s
        .enum(["chrome", "edge"] as const)
        .describe("Default: chrome")
        .optional(),
      port: s.integer({ min: 1024, max: 65535 }).describe("Default 9222").optional(),
      url: s.string().optional(),
    }),
    effects: ["exec"],
    agent: "discoverable",
    run: async ({ browser, port, url }) => {
      const r = await external.launch(browser ?? "chrome", port ?? DEFAULT_DEBUG_PORT, url);
      external.select();
      return r;
    },
  });
  register({
    id: "browser.connectExternal",
    title: "Connect to your own browser…",
    description:
      'Connects to a Chrome or Edge the user started with --remote-debugging-port (default 9222): its page at `url`, else its first page. It becomes the target of the browser commands (tab "external") until another tab is chosen.',
    input: s.object({
      port: s.string().describe("9222, or localhost:9222").optional(),
      url: s.string().describe("The page to use, by its address's start").optional(),
    }),
    effects: ["network"],
    agent: "discoverable",
    run: async ({ port, url }) => {
      const p = port === undefined ? DEFAULT_DEBUG_PORT : parsePort(port);
      if (p === null) throw new Error(`"${port}" isn't a port (1024–65535).`);
      const r = await external.connect(p, url ? externalUrl(url) : undefined);
      external.select();
      return r;
    },
  });
  register({
    id: "browser.disconnectExternal",
    title: "Disconnect from your own browser",
    description: "Lets go of the user's own browser (it stays open).",
    input: s.empty(),
    effects: [],
    agent: "discoverable",
    run: () => ({ disconnected: external.disconnect() }),
  });
}
