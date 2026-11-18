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
import { product } from "../core/product";
import { type HostLink, linkMayConnect, parseHostLink, socketUrl } from "./address";
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
  try {
    return product.accountsUrl !== "" && new URL(product.accountsUrl).origin === location.origin;
  } catch {
    return false;
  }
}

/** Where this tab's link is kept, so a reload reconnects. Gone when the tab closes. */
const LINK_KEY = "web.hostLink";

function savedLink(): Partial<HostLink> {
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

/** Connects and starts the IDE on that host. Rejects with why when the host can't be reached. */
async function connect(link: HostLink): Promise<void> {
  const guarded = sharesAccountOrigin();
  const made = socketUrl(link.address, { remote: !guarded });
  if ("error" in made) throw new Error(made.error);
  if (guarded)
    blockExtensionCode(
      "Extensions don't run in this page: it shares its address with the account pages.",
    );
  const transport = await connectStream(socketDuplex(made.url), {
    client: "web",
    token: link.token,
  });
  try {
    sessionStorage.setItem(LINK_KEY, JSON.stringify(link));
  } catch {
    // Storage is off: a reload asks again.
  }
  setTransport(transport);
  setShell(createWebShell());
  transport.onClose(() => showLost());
  document.querySelector(".web-connect")?.remove();
  await import("../main");
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
    type: "password",
    name: "code",
    autocomplete: "off",
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
    showForm({ address: link.address }, err instanceof Error ? err.message : String(err));
  }
}

function start(): void {
  document.title = product.nameLong;
  // The tab is the browser's: the title bar shows no window buttons (styles/web.css).
  document.documentElement.classList.add("is-web");
  const fromLink = parseHostLink(location.hash);
  // Out of the address bar and the history at once: the fragment holds the code.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  const link = { ...savedLink(), ...fromLink };
  showForm(link);
  // By itself only to this computer; another host's address waits for Connect.
  if (linkMayConnect(link)) void attempt(link);
  // A link opened in a tab that already shows this page changes only the fragment, which
  // loads nothing: take the link and start over with it.
  window.addEventListener("hashchange", () => {
    const next = parseHostLink(location.hash);
    if (!linkMayConnect(next)) return;
    try {
      sessionStorage.setItem(LINK_KEY, JSON.stringify(next));
    } catch {
      // Storage is off: the reload asks.
    }
    history.replaceState(null, "", location.pathname + location.search);
    location.reload();
  });
}

start();
