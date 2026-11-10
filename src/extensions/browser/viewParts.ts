// Parts of the browser tab (view.ts) that only use its public side: what DevTools talks to, the
// toolbar's More menu and DevTools badges, the empty tab's server list, and the workspace file a
// shown URL serves.
import { h } from "../../core/dom/index";
import { browserIpc } from "../../core/ipc/browser";
import { fsIpc } from "../../core/ipc/fs";
import { isWithin, resolveInRoot } from "../../core/paths/index";
import { icon } from "../../ui/Icon";
import { type MenuItem, showContextMenu } from "../../ui/Menu";
import { setTooltip } from "../../ui/Tooltip";
import type { WorkbenchServices } from "../../workbench/services";
import { type Address, displayAddress, parseAddress, type Roots } from "./address";
import type { DevtoolsHost } from "./devtools/common";
import type { NetworkPanel } from "./devtools/network";
import type { SourcesPanel } from "./devtools/sources";
import { type Page, problemCounts } from "./page";
import type { BrowserHost, BrowserView } from "./view";

export function devtoolsHostFor(view: BrowserView, host: BrowserHost): DevtoolsHost {
  const { page } = view;
  return {
    page,
    tabId: view.tabId,
    services: host.services,
    reload: () => view.reload(),
    // The panel's highlight is this tab's, even while the user's own browser is the one the
    // browser commands act on (D347).
    run: (command, input) =>
      host.run(
        command,
        command === "browser.highlight" ? { tab: view.tabId, ...(input as object) } : input,
      ),
    body: async (request, which) => {
      if (request.logId !== undefined)
        return browserIpc.networkBody(request.logId, which).catch(() => null);
      if (which === "request") return null;
      const text = await page
        .call<{ text: string }>("fetchText", { url: view.rawUrl(request.url) })
        .then((r) => r.text)
        .catch(() => null);
      return text === null ? null : new TextEncoder().encode(text);
    },
    resourceText: async (url) => {
      const logged = [...page.requests.peek()]
        .reverse()
        .find((r) => r.url === url && r.done && r.logId !== undefined);
      if (logged?.logId !== undefined) {
        const bytes = await browserIpc.networkBody(logged.logId, "response").catch(() => null);
        if (bytes) return new TextDecoder().decode(bytes);
      }
      const r = await page.call<{ text: string }>("fetchText", { url: view.rawUrl(url) });
      return r.text;
    },
    workspaceFile: (url) => view.workspaceFile(url),
    displayUrl: (url) => view.mapUrl(url),
    revealElement: (id) => void view.revealElement(id),
    revealRequest: (id) => {
      view.openDevtools("network");
      view.devtools.panel<NetworkPanel>("network").reveal(id);
    },
    revealSource: (url, line) => {
      view.openDevtools("sources");
      void view.devtools.panel<SourcesPanel>("sources").open(url, line);
    },
    highlight: async (code, lang) => {
      const html = await host.services.documents.highlight(code, lang).catch(() => null);
      if (!html) return null;
      const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
      return Array.from(doc.body.firstElementChild?.childNodes ?? []);
    },
    copy: (text) => host.run("ui.copyText", { text }),
    menu: (e, items) => void showContextMenu(e.clientX, e.clientY, items),
  };
}

/** What the More menu needs to know about the tab and can do with it. */
export interface MoreMenuState {
  address: Address | null;
  root: Roots;
  deviceMode: boolean;
  /** The whole tab is in a window of its own. */
  inOwnWindow: boolean;
  /** The page is in a window of its own. */
  popped: boolean;
  /** Other sites can show inside the tab (`browser.embedSites`). */
  embedSites: boolean;
  devtools: boolean;
  liveOnEdit: boolean;
  run(command: string, input?: unknown): void;
  hardReload(): void;
  toggleDevice(): void;
  toggleWindow(): void;
  popOut(): void;
  toggleDevtools(): void;
  openNetwork(): void;
  clearSiteData(): void;
  toggleLiveOnEdit(): void;
}

export function moreMenuItems(m: MoreMenuState): MenuItem[] {
  const a = m.address;
  return [
    { label: "Reload without cache", icon: "refresh-cw", run: () => m.hardReload() },
    {
      label: "Copy address",
      icon: "copy",
      run: () => m.run("ui.copyText", { text: a ? displayAddress(a, m.root) : "" }),
    },
    {
      label: m.deviceMode ? "Leave device mode" : "Device size (responsive mode)",
      icon: "monitor-smartphone",
      separatorBefore: true,
      run: () => m.toggleDevice(),
    },
    ...(a && a.kind === "external" && (m.embedSites || m.popped)
      ? [
          {
            label: m.popped ? "Show site in this tab" : "Open site in its own window",
            icon: "app-window" as const,
            run: () => m.popOut(),
          },
        ]
      : []),
    ...(a && a.kind !== "external"
      ? [
          {
            label: m.inOwnWindow
              ? "Move back into the main window"
              : "Open in a new window (with DevTools)",
            icon: "picture-in-picture-2" as const,
            run: () => m.toggleWindow(),
          },
          {
            label: m.popped ? "Show page in this tab" : "Open only the page in a window",
            icon: "app-window" as const,
            run: () => m.popOut(),
          },
        ]
      : []),
    {
      label: "DevTools",
      icon: "code",
      separatorBefore: true,
      checked: m.devtools,
      run: () => m.toggleDevtools(),
    },
    { label: "Network", run: () => m.openNetwork() },
    { label: "Clear site data", icon: "ban", run: () => m.clearSiteData() },
    {
      label: "Live reload while typing",
      checked: m.liveOnEdit,
      separatorBefore: true,
      run: () => m.toggleLiveOnEdit(),
    },
  ];
}

/** The workspace file a shown URL serves: static previews directly, dev servers by path. */
export async function findWorkspaceFile(
  url: string,
  roots: Roots,
  /** The dev server's origin (null for a static preview). */
  targetOrigin: string | null,
): Promise<string | null> {
  if (!roots || (typeof roots !== "string" && !roots.length)) return null;
  if (!/^https?:/i.test(url)) {
    const parsed = parseAddress(url.split(/[?#]/)[0] ?? url, roots);
    return parsed?.kind === "file" ? parsed.path : null;
  }
  let path: string;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  if (targetOrigin && !url.startsWith(targetOrigin)) return null;
  // Vite and friends serve sources at their workspace paths; static servers from public/. Of
  // several folders (D251), the first that has the file.
  const folders = typeof roots === "string" ? [roots] : roots.map((f) => f.path);
  for (const root of folders)
    for (const base of ["", "public", "static", "src"]) {
      const candidate = resolveInRoot(root, `${base ? `${base}/` : ""}${path.replace(/^\/+/, "")}`);
      if (!isWithin(root, candidate)) continue;
      const stat = await fsIpc.stat(candidate).catch(() => null);
      if (stat?.kind === "file") return candidate;
    }
  return null;
}

/** The servers terminals printed, as buttons (the empty tab; filled in once known). */
export function serverList(
  dispatcher: WorkbenchServices["dispatcher"],
  go: (url: string) => Promise<unknown>,
): HTMLElement {
  const list = h("div", { class: "browser-servers" });
  if (dispatcher.has("terminal.servers"))
    void dispatcher
      .execute("terminal.servers", {})
      .then((r) => {
        const servers = (r as { servers?: { url: string }[] }).servers ?? [];
        list.replaceChildren(
          ...servers.map(({ url }) => {
            const b = h(
              "button",
              { class: "button button-secondary", type: "button" },
              icon("globe"),
              url,
            );
            b.addEventListener("click", () => void go(url));
            return b;
          }),
        );
      })
      .catch(() => {});
  return list;
}

/** The DevTools button's error / warning badges and tooltip (an effect: reads the page's logs). */
export function renderCounts(page: Page, counts: HTMLElement, button: HTMLElement): undefined {
  page.console.value;
  page.network.value;
  const { errors, warnings } = problemCounts(page);
  counts.replaceChildren(
    ...(errors ? [h("span", { class: "browser-badge is-error" }, String(errors))] : []),
    ...(warnings ? [h("span", { class: "browser-badge is-warn" }, String(warnings))] : []),
  );
  const parts = [
    errors ? `${errors} error${errors === 1 ? "" : "s"}` : "",
    warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  setTooltip(button, parts.length ? `DevTools (F12) · ${parts.join(", ")}` : "DevTools (F12)");
  return undefined;
}
