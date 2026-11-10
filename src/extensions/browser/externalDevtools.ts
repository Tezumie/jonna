// DevTools data of the user's own browser (D347), over its DevTools protocol socket: requests
// with bodies (Network), element HTML (DOM.getOuterHTML), matched and computed styles (CSS),
// storage and cookies (DOMStorage, Network cookies, HttpOnly ones too), the highlight (Overlay),
// device size and color scheme (Emulation), and console lines page script can't see
// (Log.entryAdded: failed loads, security, interventions). The browser commands route here for
// tab "external" and give the same outputs as for a built-in tab; core/browser/cdpDevtools.ts
// maps the messages.
import {
  bodyText,
  boxSize,
  type CdpRequest,
  colorSchemeMedia,
  deviceMetrics,
  failedRequest,
  findExpression,
  HIGHLIGHT_CONFIG,
  logEntry,
  NetworkLog,
  REF_OF_ELEMENT,
  type SheetSources,
  sheetSource,
  storageId,
  storageResult,
  stylesResult,
} from "../../core/browser/cdpDevtools";
import type { Viewport } from "./devices";
import type { Page } from "./page";

type Request = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

export interface Locator {
  ref?: string;
  selector?: string;
  name?: string;
}

interface Evaluated {
  result?: { objectId?: string; value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

const GROUP = "ide-devtools";
/** How long a document's own request counts as the new page's (it may come before the load). */
const DOCUMENT_GRACE_MS = 5000;

export class ExternalDevtools {
  private readonly network = new NetworkLog();
  private readonly sheets = new Map<string, string>();
  private readonly enabled = new Set<string>();
  /** The main frame's last document request, kept across the log's clearing for a new page. */
  private documentRequest: { id: string; at: number; record: CdpRequest | null } | null = null;

  constructor(
    private readonly request: Request,
    private readonly page: Page,
    private readonly mainFrame: () => string,
  ) {}

  /** Starts following requests and the browser's own console lines. */
  async start(): Promise<void> {
    await this.request("Network.enable", { maxPostDataSize: 65536 });
    // The bridge's request reports (from inside the page) would double these.
    this.page.proxied = true;
    await this.request("Log.enable");
  }

  /** A protocol event (untrusted: only the fields used are read). */
  event(method: string, params: unknown): void {
    if (method.startsWith("Network.")) {
      const p = (params ?? {}) as { type?: unknown; frameId?: unknown; requestId?: unknown };
      if (
        method === "Network.requestWillBeSent" &&
        p.type === "Document" &&
        p.frameId === this.mainFrame() &&
        typeof p.requestId === "string"
      )
        this.documentRequest = { id: p.requestId, at: Date.now(), record: null };
      for (const r of this.network.apply(method, params)) {
        this.page.addRequest(r);
        if (this.documentRequest?.id === r.id) this.documentRequest.record = r;
        // Failed loads the bridge doesn't see (it reports fetch and XHR itself).
        const failed =
          r.initiator === "fetch" || r.initiator === "xmlhttprequest" ? null : failedRequest(r);
        if (failed) this.page.handle({ type: "network", ...failed });
      }
    } else if (method === "Log.entryAdded") {
      const entry = logEntry(params);
      if (entry) this.page.addConsole(entry);
    } else if (method === "CSS.styleSheetAdded") {
      const sheet = sheetSource(params);
      if (sheet) {
        if (this.sheets.size > 5000) this.sheets.clear();
        this.sheets.set(sheet[0], sheet[1]);
      }
    }
  }

  /** A new document began (its logs were cleared): its own request is listed again. */
  newDocument(): void {
    const doc = this.documentRequest;
    if (!doc || Date.now() - doc.at > DOCUMENT_GRACE_MS) return;
    // It may have started before the page said it was loading (its copy went with the old log).
    if (doc.record && !doc.record.done) this.page.addRequest(doc.record);
  }

  private async enable(domain: string): Promise<void> {
    if (this.enabled.has(domain)) return;
    await this.request(`${domain}.enable`);
    this.enabled.add(domain);
  }

  /** The bridge's element for a locator, as a protocol object, and its ref. */
  private async element(locator: Locator): Promise<{ objectId: string; ref: string }> {
    const r = await this.request<Evaluated>("Runtime.evaluate", {
      expression: findExpression(locator),
      objectGroup: GROUP,
    });
    if (r.exceptionDetails) {
      const text = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "";
      throw new Error(text.split("\n")[0]?.replace(/^\w*Error: /, "") || "No such element.");
    }
    const objectId = r.result?.objectId;
    if (!objectId) throw new Error("No such element.");
    const ref = await this.request<Evaluated>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: REF_OF_ELEMENT,
      returnByValue: true,
    });
    return { objectId, ref: String(ref.result?.value ?? "") };
  }

  private release(): void {
    void this.request("Runtime.releaseObjectGroup", { objectGroup: GROUP }).catch(() => {});
  }

  private async nodeId(objectId: string): Promise<number> {
    await this.enable("DOM");
    await this.request("DOM.getDocument", { depth: 0 });
    const r = await this.request<{ nodeId?: number }>("DOM.requestNode", { objectId });
    if (!r.nodeId) throw new Error("The element left the page.");
    return r.nodeId;
  }

  /** browser.dom: an element's outer HTML (default <body>). */
  async dom(locator: Locator, maxChars: number): Promise<{ ref: string; html: string }> {
    const has = locator.ref || locator.selector || locator.name;
    const el = await this.element(has ? locator : { selector: "body" });
    try {
      const r = await this.request<{ outerHTML?: string }>("DOM.getOuterHTML", {
        objectId: el.objectId,
      });
      const html = r.outerHTML ?? "";
      return {
        ref: el.ref,
        html:
          html.length > maxChars
            ? `${html.slice(0, maxChars)}… (${html.length - maxChars} more characters)`
            : html,
      };
    } finally {
      this.release();
    }
  }

  /** browser.styles: the shape of the bridge's dom.styles, from the browser's own cascade. */
  async styles(locator: Locator) {
    const el = await this.element(locator);
    try {
      const nodeId = await this.nodeId(el.objectId);
      await this.enable("CSS");
      const sheets: SheetSources = this.sheets;
      const [matched, computed, model] = await Promise.all([
        this.request("CSS.getMatchedStylesForNode", { nodeId }),
        this.request<{ computedStyle?: unknown }>("CSS.getComputedStyleForNode", { nodeId }),
        this.request("DOM.getBoxModel", { nodeId }).catch(() => null),
      ]);
      return {
        ref: el.ref,
        ...stylesResult(matched, computed.computedStyle, sheets, boxSize(model)),
      };
    } finally {
      this.release();
    }
  }

  private origin(): string {
    try {
      const o = new URL(this.page.url.peek()).origin;
      return o === "null" ? "" : o;
    } catch {
      return "";
    }
  }

  /** browser.storage: local and session storage, and the page's cookies with their attributes. */
  async storage() {
    const origin = this.origin();
    if (!origin) return storageResult("", {}, {}, {});
    await this.enable("DOMStorage");
    const [local, session, cookies] = await Promise.all([
      this.request("DOMStorage.getDOMStorageItems", { storageId: storageId(origin, true) }),
      this.request("DOMStorage.getDOMStorageItems", { storageId: storageId(origin, false) }),
      this.request("Network.getCookies", { urls: [this.page.url.peek()] }),
    ]);
    return storageResult(origin, local, session, cookies);
  }

  /** browser.setStorage: set, remove or clear a key of local / session storage or cookies. */
  async setStorage(
    action: "set" | "remove" | "clear",
    area: "local" | "session" | "cookie" | "all",
    key = "",
    value = "",
  ): Promise<{ ok: boolean }> {
    const origin = this.origin();
    if (!origin) throw new Error("This page has no storage of its own.");
    const url = this.page.url.peek();
    await this.enable("DOMStorage");
    const areas = area === "all" ? (["local", "session", "cookie"] as const) : [area];
    for (const a of areas) {
      if (a === "cookie") {
        if (action === "set") {
          const r = await this.request<{ success?: boolean }>("Network.setCookie", {
            name: key,
            value,
            url,
            path: "/",
          });
          if (r.success === false) throw new Error("The browser refused the cookie.");
        } else if (action === "remove")
          await this.request("Network.deleteCookies", { name: key, url });
        else {
          const r = await this.request<{
            cookies?: { name?: string; domain?: string; path?: string }[];
          }>("Network.getCookies", { urls: [url] });
          for (const c of r.cookies ?? [])
            if (c.name)
              await this.request("Network.deleteCookies", {
                name: c.name,
                domain: c.domain,
                path: c.path,
              });
        }
        continue;
      }
      const id = storageId(origin, a === "local");
      if (action === "set")
        await this.request("DOMStorage.setDOMStorageItem", { storageId: id, key, value });
      else if (action === "remove")
        await this.request("DOMStorage.removeDOMStorageItem", { storageId: id, key });
      else await this.request("DOMStorage.clear", { storageId: id });
    }
    return { ok: true };
  }

  /** browser.highlight: the browser's own overlay on an element; null clears it. */
  async highlight(locator: Locator | null): Promise<{ ref: string | null }> {
    await this.enable("DOM");
    await this.enable("Overlay");
    if (!locator) {
      await this.request("Overlay.hideHighlight");
      return { ref: null };
    }
    const el = await this.element(locator);
    try {
      await this.request("Overlay.highlightNode", {
        highlightConfig: HIGHLIGHT_CONFIG,
        objectId: el.objectId,
      });
      return { ref: el.ref };
    } finally {
      this.release();
    }
  }

  /** browser.resize: device metrics and prefers-color-scheme, held across the page's loads. */
  async resize(
    viewport: Viewport | null,
    colorScheme?: "light" | "dark" | "auto",
  ): Promise<Record<string, unknown>> {
    if (viewport) {
      const m = deviceMetrics(viewport);
      await this.request(m.method, m.params);
    }
    if (colorScheme)
      await this.request(
        "Emulation.setEmulatedMedia",
        colorSchemeMedia(colorScheme === "auto" ? null : colorScheme),
      );
    if (!viewport && !colorScheme) return { unchanged: true };
    return { ...(viewport ?? {}), ...(colorScheme && { colorScheme }) };
  }

  /** A request's body (`id` from browser.network): null when there is none or it's gone. */
  async body(
    r: { id: string; hasRequestBody?: boolean },
    which: "request" | "response",
    maxChars: number,
  ): Promise<string | null> {
    try {
      if (which === "request") {
        if (!r.hasRequestBody) return null;
        const p = await this.request<{ postData?: string }>("Network.getRequestPostData", {
          requestId: r.id,
        });
        return bodyText(p.postData, false, maxChars);
      }
      const b = await this.request<{ body?: string; base64Encoded?: boolean }>(
        "Network.getResponseBody",
        { requestId: r.id },
      );
      return bodyText(b.body, b.base64Encoded, maxChars);
    } catch {
      return null;
    }
  }
}
