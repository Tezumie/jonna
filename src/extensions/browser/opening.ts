// A browser tab's answers to its page's requests (D209): open a page here or in a new tab (a
// named one reused, a form posted into it), and relay messages and navigations between a popup's
// tab and the tab that opened it. The decisions are links.ts's; this applies them to the tabs.
import { rootsOf } from "./address";
import {
  type ExternalLinks,
  type FormSubmission,
  type PageRequest,
  relayOrigin,
  routeOpen,
  targetAllows,
} from "./links";
import type { BrowserHost, BrowserView } from "./view";

/** The popup link of a tab another tab's `window.open` opened. */
export interface PopupLink {
  /** The opener's tab id. */
  opener: string;
  /** The id of the stand-in window the opener's page holds. */
  id: string;
}

/** A form a page posted into a tab, sent by that tab once it is up (view.ts). */
export interface PendingForm {
  /** Where it goes, as the user knows it (a dev server's URL or another site's). */
  action: string;
  form: FormSubmission;
  /** A preview proxy that can serve the page it is sent from (the posting tab's). */
  via: string | null;
}

/** What a new tab is opened with besides its address. */
export interface TabExtras {
  popup?: PopupLink;
  /** Its window name (a named target). */
  name?: string;
  form?: PendingForm;
}

export function readPopup(value: unknown): PopupLink | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  return typeof o.opener === "string" && typeof o.id === "string" && /^[\w-]{1,40}$/.test(o.id)
    ? { opener: o.opener, id: o.id }
    : null;
}

const TAB_BURST = 5;
const TAB_WINDOW_MS = 10_000;
const recentTabs = new Map<string, number[]>();

/** At most a few new tabs from one tab's page in a short while (browsers block popup floods). */
export function allowTab(tabId: string, now = Date.now()): boolean {
  const recent = (recentTabs.get(tabId) ?? []).filter((t) => now - t < TAB_WINDOW_MS);
  if (recent.length >= TAB_BURST) {
    recentTabs.set(tabId, recent);
    return false;
  }
  recent.push(now);
  recentTabs.set(tabId, recent);
  return true;
}

export function forgetTab(tabId: string): void {
  recentTabs.delete(tabId);
}

/** The tab a stand-in window stands for: a popup, or a named tab a `window.open` reused. */
const popupOf = (host: BrowserHost, opener: string, id: string): BrowserView | undefined =>
  [...host.views.values()].find(
    (v) =>
      (v.popup?.opener === opener && v.popup.id === id) ||
      v.aliases.some((a) => a.opener === opener && a.id === id),
  );

/** Sends a message from `from` to `to`'s page as `method` (popupMessage / openerMessage). */
function relay(
  from: BrowserView,
  to: BrowserView,
  method: string,
  data: unknown,
  targetOrigin: string,
  extra: Record<string, unknown> = {},
): void {
  const fromReal = from.realOrigin();
  if (!fromReal) return;
  // "/" means the sender's own origin.
  const target = targetOrigin === "/" ? (from.proxyOrigin ?? fromReal) : targetOrigin;
  if (!targetAllows(target, [to.realOrigin(), to.proxyOrigin])) return;
  const origin = relayOrigin(from.proxyOrigin, fromReal, to.proxyOrigin);
  void to.page.call(method, { ...extra, data, origin }).catch(() => {});
}

export async function handleRequest(
  view: BrowserView,
  host: BrowserHost,
  request: PageRequest,
): Promise<void> {
  const { services } = host;
  switch (request.type) {
    case "open": {
      const setting = services.settings.peek<string>("browser.externalLinks");
      const externalLinks: ExternalLinks = setting === "system" ? "system" : "ide";
      const route = routeOpen(request, rootsOf(services.workspace), externalLinks);
      if (!route) return;
      if (route.kind === "system") {
        host.run("ui.openLink", { url: route.url });
        return;
      }
      const form: PendingForm | undefined = request.form && {
        action: route.address.kind === "file" ? "" : route.address.url,
        form: request.form,
        via: view.proxyOrigin,
      };
      if (route.kind === "tab") {
        const popup = request.popup ? { opener: view.tabId, id: request.popup } : undefined;
        // A named target reuses the tab of that name (as a browser reuses the named window).
        const named = request.name
          ? [...host.views.values()].find((v) => v !== view && v.windowName === request.name)
          : undefined;
        if (named) {
          if (popup) named.aliases.push(popup);
          services.dock.activateTab(named.tabId, true);
          await named.openFromPage(route.address, form);
          return;
        }
        // Page data asked for it: a page (or another site's window) can't flood the dock.
        if (!allowTab(view.tabId)) return;
        await host.openTab(route.address, view.tabId, {
          ...(popup && { popup }),
          ...(request.name && { name: request.name }),
          ...(form && { form }),
        });
        return;
      }
      await view.navigateTo(route.address, {
        replace: request.replace,
        ...(request.form && { form: request.form }),
      });
      return;
    }
    case "openerNavigate": {
      // A popup sets its opener's location: the opener's tab goes there.
      const opener = view.popup ? host.views.get(view.popup.opener) : undefined;
      const route = routeOpen(
        { url: request.url, disposition: "self" },
        rootsOf(services.workspace),
        "ide",
      );
      if (opener && route && route.kind !== "system")
        await opener.navigateTo(route.address, { replace: request.replace });
      return;
    }
    case "toOpener": {
      const opener = view.popup ? host.views.get(view.popup.opener) : undefined;
      if (opener && view.popup)
        relay(view, opener, "popupMessage", request.data, request.targetOrigin, {
          id: view.popup.id,
        });
      return;
    }
    case "close":
      // Only a page another tab opened may close itself (as browsers allow).
      if (view.popup) view.close();
      return;
    case "toPopup": {
      const popup = popupOf(host, view.tabId, request.id);
      if (popup) relay(view, popup, "openerMessage", request.data, request.targetOrigin);
      return;
    }
    case "closePopup":
      popupOf(host, view.tabId, request.id)?.close();
      return;
    case "focusPopup": {
      const popup = popupOf(host, view.tabId, request.id);
      if (popup) services.dock.activateTab(popup.tabId, true);
      return;
    }
    case "popupNavigate": {
      const popup = popupOf(host, view.tabId, request.id);
      const route = routeOpen(
        { url: request.url, disposition: "self" },
        rootsOf(services.workspace),
        "ide",
      );
      if (popup && route && route.kind !== "system") await popup.load(route.address);
      return;
    }
  }
}

/** The popup's tab closed: the opener's stand-in window says `closed`. */
export function popupClosed(host: BrowserHost, popup: PopupLink): void {
  const opener = host.views.get(popup.opener);
  if (opener) void opener.page.call("popupClosed", { id: popup.id }).catch(() => {});
}

/** An opener's tab closed: its popups' `window.opener.closed` turns true. */
export function openerClosed(host: BrowserHost, tabId: string): void {
  for (const v of host.views.values())
    if (v.popup?.opener === tabId && v.page.connected.peek())
      void v.page.call("openerClosed").catch(() => {});
}
