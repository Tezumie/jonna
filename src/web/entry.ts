// The IDE as a page in a browser: the same front end, with a host somewhere else in place of
// the app's own backend. This entry connects first (a WebSocket to a host started with
// `--listen-ws`, carrying the wire the command-line agent already speaks), installs that as the
// transport and a browser's shell, and only then loads the window's own boot (`main.ts`), which
// runs unchanged.
//
// Where the host is doesn't matter to anything after the connection: this computer today, a
// machine with a public address or one reached through a relay later. `address.ts` is the only
// place that decides what an address may be.
import "../styles/index.css";
import "../styles/web.css";
import { h } from "../core/dom/index";
import { blockExtensionCode } from "../core/extensions/codePolicy";
import { setTransport } from "../core/ipc/invoke";
import { setShell } from "../core/ipc/shell";
import { connectStream } from "../core/ipc/streamTransport";
import { webAppSharesAccounts } from "../core/ownServices";
import { product } from "../core/product";
import { type HostLink, isLoopbackHost, linkMayConnect, parseHostLink, socketUrl } from "./address";
import { createWebShell } from "./shell";
import { socketDuplex } from "./socketDuplex";

/**
 * Whether this page is served from the origin of the account pages (product.json's
 * `accountsUrl`). A signed-in session lives in that origin's storage, and whatever runs in this
 * page can read it. So here the page trusts only a host on this computer (the person's own), and
 * runs no extension code (an extension's worker has the page's origin). A copy served from an
 * address of its own has neither limit.
 */
function sharesAccountOrigin(): boolean {
  if (isLoopbackHost(location.hostname)) return false;
  // The same name, or another name of the same domain unless product.json says the accounts
  // server keeps nothing there (`webAppSharesAccounts` has the rule).
  return webAppSharesAccounts(location.hostname);
}

/**
 * Where this tab's link is kept, so a reload reconnects. Gone when the tab closes. Not on an
 * address shared with the account pages: every page of that address could read it, and the
 * host would take the code from any of them. There a reload asks for the link again.
 */
const LINK_KEY = "web.hostLink";

/** Whether a connection is up: a link that arrives then is not followed (see `start`). */
let connected = false;

/** Whether a try is under way: a second one would be refused by the host and undo the first. */
let attempting = false;

/** How long a host has to answer the handshake once the socket is open. */
const HELLO_WITHIN_MS = 15_000;

function keepLink(link: HostLink): void {
  if (sharesAccountOrigin()) return;
  try {
    sessionStorage.setItem(LINK_KEY, JSON.stringify(link));
  } catch {
    // Storage is off: a reload asks again.
  }
}

function savedLink(): Partial<HostLink> {
  if (sharesAccountOrigin()) return {};
  try {
    const saved = JSON.parse(sessionStorage.getItem(LINK_KEY) ?? "null") as unknown;
    if (saved && typeof saved === "object") {
      const { address, token } = saved as Record<string, unknown>;
      if (typeof address === "string" && typeof token === "string") return { address, token };
    }
  } catch {
    // Nothing usable kept.
  }
  return {};
}

function forgetLink(): void {
  try {
    sessionStorage.removeItem(LINK_KEY);
  } catch {
    // Storage is off: nothing was kept.
  }
}

/**
 * Whether the browser itself keeps this page from this computer. Browsers ask before a site may
 * reach programs on the computer it is shown on (Chromium's "apps on this device" permission);
 * a page gets no reason for a failed connection, only this permission's state. True: refused.
 * False: allowed, not asked yet, or a browser without the permission.
 */
async function blockedFromThisComputer(): Promise<boolean> {
  if (isLoopbackHost(location.hostname)) return false;
  for (const name of ["loopback-network", "local-network-access"]) {
    try {
      const status = await navigator.permissions.query({ name: name as PermissionName });
      return status.state === "denied";
    } catch {
      // Not a permission this browser knows by that name.
    }
  }
  return false;
}

/**
 * The connection never opened (the browser refused it, the host isn't running, its one place
 * is taken): the code was never sent and is still good.
 */
class CodeNotSent extends Error {}

/** Connects and starts the IDE on that host. Rejects with why when the host can't be reached. */
async function connect(link: HostLink): Promise<void> {
  const guarded = sharesAccountOrigin();
  const made = socketUrl(link.address, { remote: !guarded });
  if ("error" in made) throw new Error(made.error);
  if (guarded)
    blockExtensionCode(
      "Extensions don't run in this page: it shares its address with the account pages.",
    );
  let reached = false;
  const duplex = socketDuplex(made.url, () => {
    reached = true;
  });
  const answered = connectStream(duplex, { client: "web", token: link.token });
  // Something that takes the socket and then says nothing isn't a host: don't wait for ever.
  let gaveUp: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<never>((_, fail) => {
    gaveUp = setTimeout(() => {
      duplex.close();
      fail(new Error("The host didn't answer."));
    }, HELLO_WITHIN_MS);
  });
  // The loser of the race still settles: nothing waits for it.
  answered.catch(() => {});
  const transport = await Promise.race([answered, silent])
    .catch(async (err: unknown) => {
      if (reached) throw err;
      if (isLoopbackHost(new URL(made.url).hostname) && (await blockedFromThisComputer()))
        throw new CodeNotSent(
          "The browser doesn't let this site reach programs on this computer. Allow it in the site's settings (the icon beside the address: apps on this device, or local network access), then connect again.",
        );
      throw new CodeNotSent(err instanceof Error ? err.message : String(err));
    })
    .finally(() => clearTimeout(gaveUp));
  keepLink(link);
  connected = true;
  setTransport(transport);
  setShell(createWebShell());
  transport.onClose(() => {
    if (connected) showLost();
  });
  try {
    await import("../main");
  } catch (err) {
    // The IDE's own code didn't load (the site, not the host): give the host's place back,
    // or every later try would find it taken by this one.
    connected = false;
    transport.close();
    throw new Error(
      `The page couldn't load its code (${err instanceof Error ? err.message : String(err)}). Reload it and connect again.`,
    );
  }
  document.querySelector(".web-connect")?.remove();
}

/** The connection ended under a running IDE: nothing answers any more, so say so over it. */
function showLost(): void {
  if (document.querySelector(".web-lost")) return;
  const again = h("button", { class: "button button-primary", type: "button" }, "Reconnect");
  again.addEventListener("click", () => location.reload());
  const other = h("button", { class: "button button-secondary", type: "button" }, "Another host");
  other.addEventListener("click", () => {
    forgetLink();
    location.reload();
  });
  document.body.append(
    h(
      "div",
      { class: "web-lost", role: "alertdialog", "aria-label": "Connection lost" },
      h(
        "div",
        { class: "web-card" },
        h("h1", null, "The connection to the host was lost"),
        h(
          "p",
          null,
          "Nothing here can be saved or run until it is back. Unsaved text in open editors is kept on this page until you reload.",
        ),
        h("div", { class: "web-actions" }, other, again),
      ),
    ),
  );
  again.focus();
}

/** The form that asks where the host is. `error`: why the last attempt failed. */
function showForm(start: Partial<HostLink>, error?: string): void {
  document.querySelector(".web-connect")?.remove();
  const address = h("input", {
    class: "input",
    type: "text",
    name: "address",
    placeholder: "127.0.0.1:4000",
    spellcheck: "false",
    autocomplete: "off",
    autocapitalize: "off",
  });
  address.value = start.address ?? "";
  const code = h("input", {
    class: "input",
    // Not a password field: a password manager would offer to keep the code as the site's
    // password, or fill the site's password in here.
    type: "text",
    name: "code",
    autocomplete: "one-time-code",
    spellcheck: "false",
  });
  code.value = start.token ?? "";
  const status = h("p", { class: "web-status", role: "status" }, error ?? "");
  if (error) status.classList.add("is-error");
  const submit = h("button", { class: "button button-primary", type: "submit" }, "Connect");
  const form = h(
    "form",
    { class: "web-card" },
    h("h1", null, "Connect to a computer"),
    h(
      "p",
      null,
      `${product.nameLong} in the browser works on a computer that runs its host. Start the host there and open the link it shows, or enter its address and code.`,
    ),
    h("label", null, h("span", null, "Address"), address),
    h("label", null, h("span", null, "Code"), code),
    status,
    h("div", { class: "web-actions" }, submit),
    h("p", { class: "web-note" }, "The code goes to the host only, never to this site."),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const link = { address: address.value.trim(), token: code.value.trim() };
    if (!link.address || !link.token) {
      status.textContent = "Enter the address and the code.";
      status.classList.add("is-error");
      return;
    }
    void attempt(link);
  });
  document.body.append(h("main", { class: "web-connect" }, form));
  (start.address ? code : address).focus();
}

async function attempt(link: HostLink): Promise<void> {
  if (attempting) return;
  attempting = true;
  const status = document.querySelector(".web-status");
  const button = document.querySelector<HTMLButtonElement>(".web-connect button[type=submit]");
  if (status) {
    status.textContent = "Connecting…";
    status.classList.remove("is-error");
  }
  if (button) button.disabled = true;
  try {
    await connect(link);
  } catch (err) {
    // The code isn't kept after a failed try: a wrong one would be sent again on every reload.
    forgetLink();
    showForm(
      // Unless nothing was sent (the browser stopped it, the host wasn't there): it stays in
      // the form (not in storage), so pressing Connect again is enough.
      err instanceof CodeNotSent ? link : { address: link.address },
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    attempting = false;
  }
}

function start(): void {
  document.title = product.nameLong;
  // The tab is the browser's: the title bar shows no window buttons (styles/web.css).
  document.documentElement.classList.add("is-web");
  const fromLink = parseHostLink(location.hash);
  // Out of the address bar at once: the fragment holds the code.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  const saved = savedLink();
  // A kept code belongs to the address it was kept with: a link that names another address
  // (anyone can send one) must not have this tab hand the code to whatever listens there.
  const link =
    fromLink.address && fromLink.address !== saved.address ? fromLink : { ...saved, ...fromLink };
  showForm(link);
  // By itself only to this computer; another host's address waits for Connect.
  if (linkMayConnect(link)) void attempt(link);
  // A link opened in a tab that already shows this page changes only the fragment, which
  // loads nothing: take the link and start over with it.
  // Never under a running session: whoever can change this tab's address could otherwise end
  // it, with its unsaved text, and point the tab at a host of their choosing.
  window.addEventListener("hashchange", () => {
    const next = parseHostLink(location.hash);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    if (connected || attempting || !linkMayConnect(next)) return;
    showForm(next);
    void attempt(next);
  });
}

start();
