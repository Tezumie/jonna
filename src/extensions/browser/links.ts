// Where a page's links, popups and redirects go (D209): DOM-free, tested. The bridge
// (`links.js`) cancels a navigation the frame can't make itself and sends `open`: another local
// server comes back through its own preview proxy in the same tab, `target=_blank` and
// `window.open` become IDE browser tabs, other sites follow `browser.externalLinks`. Popups keep a
// relay to the tab that opened them (`toOpener` / `toPopup`), so sign-in popups that post their
// result back keep working.
import { type Address, parseAddress, type Roots } from "./address";

/** A form the page submitted to another origin, sent again to that origin's proxy. */
export interface FormSubmission {
  method: "post";
  enctype: string;
  /** Name and value pairs (values are strings, or File objects from the frame). */
  entries: [string, unknown][];
}

/** What the bridge asked of the IDE (page data: validated here). */
export type PageRequest =
  | {
      type: "open";
      url: string;
      /** `self`: this tab goes there; `tab`: a new browser tab. */
      disposition: "self" | "tab";
      replace: boolean;
      /** The id of the popup stand-in the page holds (window.open), for the relay. */
      popup?: string;
      /** A named target (`window.open(url, name)`, `target="name"`): the tab of that name. */
      name?: string;
      /** A form posted there (this tab or a new one). */
      form?: FormSubmission;
    }
  | { type: "toOpener"; data: unknown; targetOrigin: string }
  /** A popup sets its opener's location. */
  | { type: "openerNavigate"; url: string; replace: boolean }
  | { type: "close" }
  | { type: "toPopup"; id: string; data: unknown; targetOrigin: string }
  | { type: "closePopup" | "focusPopup"; id: string }
  | { type: "popupNavigate"; id: string; url: string };

const str = (v: unknown, max = 4000): string => (typeof v === "string" ? v.slice(0, max) : "");
const httpUrl = (v: unknown): string | null => {
  const s = str(v, 8000);
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
};
/** A window name that picks a tab (`_blank`, `_self` and the like don't). */
export const tabName = (v: unknown): string => {
  const s = str(v, 200).trim();
  return s.startsWith("_") ? "" : s;
};
const popupId = (v: unknown): string | null => {
  const s = str(v, 40);
  return /^[\w-]{1,40}$/.test(s) ? s : null;
};

function parseForm(v: unknown): FormSubmission | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.entries)) return undefined;
  const entries = (o.entries as unknown[])
    .slice(0, 2000)
    .filter((e): e is [string, unknown] => Array.isArray(e) && typeof e[0] === "string");
  const enctype = str(o.enctype, 100).toLowerCase();
  return {
    method: "post",
    enctype: ["multipart/form-data", "text/plain"].includes(enctype)
      ? enctype
      : "application/x-www-form-urlencoded",
    entries: entries.map(([k, value]) => [k.slice(0, 1000), value]),
  };
}

/** A bridge message about opening pages or relaying popups, or null for anything else. */
export function parseRequest(message: Record<string, unknown>): PageRequest | null {
  switch (message.type) {
    case "open": {
      const url = httpUrl(message.url);
      if (!url) return null;
      const disposition = message.disposition === "tab" ? "tab" : "self";
      const popup = popupId(message.popup);
      const form = parseForm(message.form);
      const name = disposition === "tab" ? tabName(message.name) : "";
      return {
        type: "open",
        url,
        disposition,
        replace: message.replace === true,
        ...(popup && { popup }),
        ...(name && { name }),
        ...(form && { form }),
      };
    }
    case "openerNavigate": {
      const url = httpUrl(message.url);
      return url ? { type: "openerNavigate", url, replace: message.replace === true } : null;
    }
    case "toOpener":
      return {
        type: "toOpener",
        data: message.data,
        targetOrigin: str(message.targetOrigin, 500) || "/",
      };
    case "close":
      return { type: "close" };
    case "toPopup":
    case "closePopup":
    case "focusPopup":
    case "popupNavigate": {
      const id = popupId(message.id);
      if (!id) return null;
      if (message.type === "toPopup")
        return {
          type: "toPopup",
          id,
          data: message.data,
          targetOrigin: str(message.targetOrigin, 500) || "/",
        };
      if (message.type === "popupNavigate") {
        const url = httpUrl(message.url);
        return url ? { type: "popupNavigate", id, url } : null;
      }
      return { type: message.type, id };
    }
    default:
      return null;
  }
}

/**
 * The preview proxies this window started: proxy origin → what it serves (a dev server's origin,
 * or a folder). A frame that went back to another proxy's page (history across ports) is still
 * ours; any other origin isn't.
 */
export class ProxyMap {
  private readonly targets = new Map<string, string>();

  remember(proxyOrigin: string, target: string): void {
    this.targets.set(proxyOrigin, target);
  }

  has(proxyOrigin: string): boolean {
    return this.targets.has(proxyOrigin);
  }

  /** The folder a static preview's proxy serves (null for a dev server's, or an unknown proxy). */
  folder(proxyOrigin: string): string | null {
    const t = this.targets.get(proxyOrigin);
    return t && !/^https?:\/\//i.test(t) ? t : null;
  }

  /** The dev server origin a proxy serves, or null for a folder (or an unknown proxy). */
  upstream(proxyOrigin: string): string | null {
    const t = this.targets.get(proxyOrigin);
    return t && /^https?:\/\//i.test(t) ? t : null;
  }

  /** A proxy URL as the address the user knows (the dev server's URL), else the URL itself. */
  realUrl(url: string): string {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return url;
    }
    const up = this.upstream(origin);
    return up && url.startsWith(origin) ? up + url.slice(origin.length) : url;
  }
}

/** The process-wide map (every browser tab shares the proxies). */
export const proxies = new ProxyMap();

export type ExternalLinks = "ide" | "system";

/** Where an `open` goes: this tab, a new tab, or the system browser (other sites, if set). */
export type OpenRoute =
  | { kind: "here"; address: Address }
  | { kind: "tab"; address: Address }
  | { kind: "system"; url: string };

export function routeOpen(
  request: { url: string; disposition: "self" | "tab" },
  root: Roots,
  externalLinks: ExternalLinks,
): OpenRoute | null {
  const address = parseAddress(proxies.realUrl(request.url), root);
  if (!address || address.kind === "file") return null;
  if (address.kind === "external" && externalLinks === "system")
    return { kind: "system", url: address.url };
  return { kind: request.disposition === "tab" ? "tab" : "here", address };
}

/**
 * The origin a relayed message says it came from. Two pages of the same dev server see each
 * other at the proxy's origin (the address in their own `location`); a page of another server
 * is seen at that server's real origin (what an app configures for its sign-in server).
 */
export function relayOrigin(
  fromProxy: string | null,
  fromReal: string,
  toProxy: string | null,
): string {
  return fromProxy && fromProxy === toProxy ? fromProxy : fromReal;
}

/**
 * Whether a postMessage `targetOrigin` lets the message reach a page known by these origins (its
 * proxy's and its real one). The caller turns "/" into the sender's own origin first.
 */
export function targetAllows(targetOrigin: string, receiver: (string | null)[]): boolean {
  if (targetOrigin === "*") return true;
  let wanted: string;
  try {
    wanted = new URL(targetOrigin).origin;
  } catch {
    return false; // unreadable: postMessage would throw at the sender
  }
  return receiver.some((o) => o !== null && o === wanted);
}
