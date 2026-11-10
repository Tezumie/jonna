// DevTools data of the user's own browser over the DevTools protocol (D347): its requests
// (Network events into the same records the built-in tab's proxy log gives), matched and computed
// styles, storage and cookies, console lines the page's script can't see (Log.entryAdded), device
// metrics and media emulation, and the highlight. The browser commands give the same outputs as
// for a built-in tab; this maps the protocol's messages to them. DOM-free and tested.

/** One request, shaped like extensions/browser/page.ts NetRequest (structurally the same). */
export interface CdpRequest {
  id: string;
  method: string;
  url: string;
  status: number;
  mime: string;
  size: number;
  startMs: number;
  ttfbMs: number;
  durationMs: number;
  reqHeaders: [string, string][];
  resHeaders: [string, string][];
  error?: string;
  protocol: "http" | "websocket";
  done: boolean;
  hasRequestBody?: boolean;
  initiator?: string;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
const str = (v: unknown, max = 4000): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Protocol headers ({name: value}) as pairs; a value with new lines is several headers. */
export function headerPairs(headers: unknown): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj(headers))) {
    if (typeof v !== "string") continue;
    for (const part of v.split("\n")) out.push([k.slice(0, 200), part.slice(0, 8000)]);
    if (out.length >= 200) break;
  }
  return out;
}

/** The protocol's resource type → the initiator names requestType() reads. */
const INITIATORS: Record<string, string> = {
  Document: "navigation",
  Stylesheet: "link",
  Script: "script",
  Image: "img",
  Font: "font",
  Media: "media",
  Fetch: "fetch",
  XHR: "xmlhttprequest",
  WebSocket: "websocket",
  EventSource: "fetch",
};

interface Live {
  record: CdpRequest;
  /** The protocol's monotonic timestamp (seconds) when it started. */
  started: number;
  redirects: number;
}

/** At most this many requests are followed at once (a page that never finishes some). */
const MAX_LIVE = 2000;

/**
 * Network.* events into request records. `apply` returns the records that changed (a redirect
 * ends one and starts the next), to add or replace by id.
 */
export class NetworkLog {
  private readonly live = new Map<string, Live>();

  apply(method: string, params: unknown): CdpRequest[] {
    const p = obj(params);
    const id = str(p.requestId, 200);
    if (!id) return [];
    switch (method) {
      case "Network.requestWillBeSent": {
        const out: CdpRequest[] = [];
        const before = this.live.get(id);
        const request = obj(p.request);
        if (before && p.redirectResponse) {
          // The redirect ends the earlier hop (kept under an id of its own).
          const res = obj(p.redirectResponse);
          out.push({
            ...before.record,
            id: `${id}:${before.redirects + 1}`,
            status: num(res.status),
            mime: str(res.mimeType, 200),
            resHeaders: headerPairs(res.headers),
            durationMs: Math.max(0, (num(p.timestamp) - before.started) * 1000),
            done: true,
          });
        }
        if (this.live.size >= MAX_LIVE) this.live.clear();
        const record: CdpRequest = {
          id,
          method: str(request.method, 16) || "GET",
          url: str(request.url, 4000),
          status: 0,
          mime: "",
          size: 0,
          startMs: num(p.wallTime) * 1000 || Date.now(),
          ttfbMs: 0,
          durationMs: 0,
          reqHeaders: headerPairs(request.headers),
          resHeaders: [],
          protocol: "http",
          done: false,
          ...(request.hasPostData === true && { hasRequestBody: true }),
          ...(INITIATORS[str(p.type, 40)] && { initiator: INITIATORS[str(p.type, 40)] }),
        };
        this.live.set(id, {
          record,
          started: num(p.timestamp),
          redirects: before && p.redirectResponse ? before.redirects + 1 : 0,
        });
        out.push(record);
        return out;
      }
      case "Network.responseReceived": {
        const l = this.live.get(id);
        if (!l) return [];
        const res = obj(p.response);
        l.record = {
          ...l.record,
          status: num(res.status),
          mime: str(res.mimeType, 200),
          resHeaders: headerPairs(res.headers),
          ttfbMs: Math.max(0, (num(p.timestamp) - l.started) * 1000),
        };
        // Headers the request really went with (cookies included), when the browser says.
        const sent = headerPairs(res.requestHeaders);
        if (sent.length) l.record.reqHeaders = sent;
        return [l.record];
      }
      case "Network.loadingFinished":
      case "Network.loadingFailed": {
        const l = this.live.get(id);
        if (!l) return [];
        this.live.delete(id);
        const failed = method === "Network.loadingFailed";
        const error = failed
          ? p.canceled === true
            ? "cancelled"
            : str(p.blockedReason, 200) || str(p.errorText, 500) || "failed"
          : "";
        l.record = {
          ...l.record,
          size: failed ? l.record.size : num(p.encodedDataLength),
          durationMs: Math.max(0, (num(p.timestamp) - l.started) * 1000),
          done: true,
          ...(error && { error }),
        };
        return [l.record];
      }
      case "Network.webSocketCreated": {
        const record: CdpRequest = {
          id,
          method: "GET",
          url: str(p.url, 4000),
          status: 101,
          mime: "",
          size: 0,
          startMs: Date.now(),
          ttfbMs: 0,
          durationMs: 0,
          reqHeaders: [],
          resHeaders: [],
          protocol: "websocket",
          done: false,
          initiator: "websocket",
        };
        this.live.set(id, { record, started: 0, redirects: 0 });
        return [record];
      }
      case "Network.webSocketClosed": {
        const l = this.live.get(id);
        if (!l) return [];
        this.live.delete(id);
        l.record = { ...l.record, done: true };
        return [l.record];
      }
      default:
        return [];
    }
  }

  /** A new document: requests still open belong to the old one. */
  clear(): void {
    this.live.clear();
  }
}

/** A failed request as browser.console lists it (status ≥ 400 or no answer), or null. */
export function failedRequest(
  r: CdpRequest,
): { method: string; url: string; status: number; error?: string; time: number } | null {
  if (!r.done || (r.status < 400 && !r.error) || r.error === "cancelled") return null;
  return {
    method: r.method,
    url: r.url,
    status: r.status,
    ...(r.error && { error: r.error }),
    time: Date.now(),
  };
}

/** A body from Network.getResponseBody / getRequestPostData as text, cut at `max`. */
export function bodyText(body: unknown, base64Encoded: unknown, max: number): string {
  let text = typeof body === "string" ? body : "";
  if (base64Encoded === true) {
    try {
      const bin = atob(text);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      text = new TextDecoder().decode(bytes);
    } catch {
      text = "";
    }
  }
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

/** A Log.entryAdded line for the console (what page script can't see: network, security…). */
export function logEntry(
  params: unknown,
): { level: "info" | "warn" | "error"; text: string; time: number; source?: string } | null {
  const e = obj(obj(params).entry);
  const levels: Record<string, "info" | "warn" | "error"> = {
    info: "info",
    warning: "warn",
    error: "error",
  };
  const level = levels[str(e.level, 20)];
  // Verbose lines (violations) are noise; the console API's own lines come from the bridge.
  if (!level || str(e.source, 40) === "console-api") return null;
  const url = str(e.url, 2000);
  const line = typeof e.lineNumber === "number" ? `:${e.lineNumber + 1}` : "";
  return {
    level,
    text: str(e.text, 4000),
    time: num(e.timestamp) || Date.now(),
    ...(url && { source: `${url}${line}` }),
  };
}

interface CssProperty {
  name?: unknown;
  value?: unknown;
  important?: unknown;
  disabled?: unknown;
  implicit?: unknown;
  parsedOk?: unknown;
}

/** A protocol CSSStyle's written declarations as [name, value, important, enabled]. */
export function declarations(style: unknown): [string, string, boolean, boolean][] {
  const props = obj(style).cssProperties;
  if (!Array.isArray(props)) return [];
  return (props as CssProperty[])
    .filter((p) => p && p.implicit !== true && typeof p.name === "string" && p.parsedOk !== false)
    .map((p) => [
      String(p.name),
      str(p.value, 2000).replace(/\s*!important\s*$/, ""),
      p.important === true,
      p.disabled !== true,
    ]);
}

/** Style sheet ids → where they come from (CSS.styleSheetAdded headers). */
export type SheetSources = ReadonlyMap<string, string>;

/** A CSS.styleSheetAdded header → [id, its URL, or "<style>" for one in the page]. */
export function sheetSource(params: unknown): [string, string] | null {
  const h = obj(obj(params).header);
  const id = str(h.styleSheetId, 200);
  if (!id) return null;
  const url = str(h.sourceURL, 2000);
  return [id, url && h.isInline !== true ? url : "<style>"];
}

/** The longhands the box model reads. */
const SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * CSS.getMatchedStylesForNode, CSS.getComputedStyleForNode and the border box's size as the
 * built-in tab's `dom.styles` answers: inline declarations, the rules that match (the last one to
 * apply first; the browser's own defaults left out, as there), computed pairs and the box model.
 */
export function stylesResult(
  matched: unknown,
  computed: unknown,
  sheets: SheetSources,
  size: { width: number; height: number } | null,
) {
  const m = obj(matched);
  const rules: { selector: string; source: string; props: [string, string, boolean, boolean][] }[] =
    [];
  const list = Array.isArray(m.matchedCSSRules) ? m.matchedCSSRules : [];
  for (const match of list) {
    const rule = obj(obj(match).rule);
    if (rule.origin === "user-agent") continue;
    const style = obj(rule.style);
    const sheet = str(rule.styleSheetId, 200);
    const start = obj(obj(style.range)).startLine;
    const where = sheets.get(sheet) ?? (sheet ? "<style>" : "");
    rules.push({
      selector: str(obj(rule.selectorList).text, 2000),
      source: where && typeof start === "number" ? `${where}:${start + 1}` : where,
      props: declarations(style),
    });
  }
  const pairs: [string, string][] = Array.isArray(computed)
    ? (computed as unknown[]).flatMap((c) => {
        const o = obj(c);
        return typeof o.name === "string" ? [[o.name, str(o.value, 2000)] as [string, string]] : [];
      })
    : [];
  const value = new Map(pairs);
  const box = (prefix: string, suffix = "") =>
    SIDES.map((side) => value.get(`${prefix}-${side}${suffix}`) ?? "0px");
  return {
    inline: declarations(m.inlineStyle),
    rules: rules.reverse(),
    computed: pairs,
    box: {
      width: Math.round((size?.width ?? 0) * 100) / 100,
      height: Math.round((size?.height ?? 0) * 100) / 100,
      margin: box("margin"),
      border: box("border", "-width"),
      padding: box("padding"),
      position: value.get("position") ?? "",
      display: value.get("display") ?? "",
    },
  };
}

/** The width and height of DOM.getBoxModel's border box, or null. */
export function boxSize(model: unknown): { width: number; height: number } | null {
  const m = obj(obj(model).model);
  return typeof m.width === "number" && typeof m.height === "number"
    ? { width: m.width, height: m.height }
    : null;
}

const clip = (v: unknown) => str(v, 20000);

/**
 * DOMStorage items and Network.getCookies as the built-in tab's `storage.list`: origin, local
 * and session pairs, cookie pairs — plus each cookie's attributes (HttpOnly ones included, which
 * the page's script can't read).
 */
export function storageResult(origin: string, local: unknown, session: unknown, cookies: unknown) {
  const items = (v: unknown): [string, string][] => {
    const entries = obj(v).entries;
    return Array.isArray(entries)
      ? (entries as unknown[]).flatMap((e) =>
          Array.isArray(e) && typeof e[0] === "string"
            ? [[e[0].slice(0, 2000), clip(e[1])] as [string, string]]
            : [],
        )
      : [];
  };
  const list = Array.isArray(obj(cookies).cookies) ? (obj(cookies).cookies as unknown[]) : [];
  const parsed = list.map(obj).filter((c) => typeof c.name === "string");
  return {
    origin,
    local: items(local),
    session: items(session),
    cookies: parsed.map((c) => [str(c.name, 2000), clip(c.value)] as [string, string]),
    cookieAttributes: parsed.map((c) => ({
      name: str(c.name, 2000),
      domain: str(c.domain, 500),
      path: str(c.path, 500),
      ...(typeof c.expires === "number" && c.expires > 0
        ? { expires: new Date(c.expires * 1000).toISOString() }
        : { expires: "session" }),
      httpOnly: c.httpOnly === true,
      secure: c.secure === true,
      ...(typeof c.sameSite === "string" && { sameSite: c.sameSite }),
    })),
  };
}

/** The DOMStorage id of an origin's local or session storage. */
export function storageId(origin: string, local: boolean) {
  return { securityOrigin: origin, isLocalStorage: local };
}

/** Emulation for browser.resize: the viewport (null: the window's own again). */
export function deviceMetrics(viewport: { width: number | null; height: number | null }): {
  method: string;
  params: Record<string, unknown>;
} {
  if (viewport.width === null || viewport.height === null)
    return { method: "Emulation.clearDeviceMetricsOverride", params: {} };
  return {
    method: "Emulation.setDeviceMetricsOverride",
    params: {
      width: viewport.width,
      height: viewport.height,
      // The screen's own scale; phones and tablets (narrower than a laptop) as mobile.
      deviceScaleFactor: 0,
      mobile: viewport.width < 1024,
    },
  };
}

/** Emulation.setEmulatedMedia for prefers-color-scheme (null: the browser's own again). */
export function colorSchemeMedia(scheme: "light" | "dark" | null): Record<string, unknown> {
  return { features: [{ name: "prefers-color-scheme", value: scheme ?? "" }] };
}

/** Overlay.highlightNode's look: Chrome DevTools' own colors for content, padding, border, margin. */
export const HIGHLIGHT_CONFIG = {
  showInfo: true,
  showStyles: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};

/** The expression that gives the bridge's element for a ref, selector or name (its object). */
export function findExpression(locator: {
  ref?: string;
  selector?: string;
  name?: string;
}): string {
  const p = {
    ...(locator.ref && { ref: locator.ref }),
    ...(locator.selector && { selector: locator.selector }),
    ...(locator.name && { name: locator.name }),
  };
  return `window.__ideBridge.internal.find(${JSON.stringify(p)})`;
}

/** The function (called on the element) that gives its bridge ref. */
export const REF_OF_ELEMENT = "function () { return window.__ideBridge.internal.refFor(this); }";
