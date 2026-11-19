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
import {
  type CodeSignIn,
  onAccountKnown,
  setArrivedSignIn,
  setPageSignIn,
} from "../core/ipc/pageSignIn";
import { setShell } from "../core/ipc/shell";
import { connectStream } from "../core/ipc/streamTransport";
import {
  hasAccounts,
  isLoopbackServer,
  webAppSharesAccounts,
  workspaceLaunchUrl,
} from "../core/ownServices";
import { product } from "../core/product";
import { logo } from "../ui/Logo";
import { type HostLink, isLoopbackHost, linkMayConnect, socketUrl } from "./address";
import {
  authorizeUrl,
  challengeOf,
  fromOwnLaunch,
  launchUrl,
  type PendingLaunch,
  randomToken,
  readArrival,
  readPending,
} from "./launch";
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

/** The trip to the launch page this tab began (`launch.ts`), kept for the tab until it is back. */
const LAUNCH_KEY = "web.launch";

/** "1" once a host opened here was seen signed in to the account: no code is asked for then. */
const ACCOUNT_KEY = "web.accountOn";

/** "1" for the next load of this tab: show the form (asked for with "Another host"). */
const FORM_KEY = "web.form";

/** Where sign-in tabs tell the tab that opened them the code they came back with. */
const SIGN_IN_CHANNEL = "web.signIn";

/** A link as it is kept: `workspace` when it came from the launch page (the account's machine). */
type KeptLink = HostLink & { workspace?: boolean };

/** This page's own address, without what follows `?` or `#`: where a sign-in comes back to. */
const pageAddress = (): string => location.origin + location.pathname;

/**
 * The account service's page that starts the person's machine and sends the tab back with its
 * link, or null when there is none for this page: a build that names none, or a page that
 * shares its address with the account pages (it trusts only this computer). A page served
 * from this computer goes to one only when asked to in its address (`?launch=`, itself on this
 * computer): how the trip is tried against a service under development.
 */
function launchPage(): string | null {
  if (sharesAccountOrigin()) return null;
  if (isLoopbackHost(location.hostname)) {
    const asked = new URLSearchParams(location.search).get("launch")?.trim() ?? "";
    return asked && isLoopbackServer(asked) ? asked : null;
  }
  return workspaceLaunchUrl();
}

/** Whether a connection is up: a link that arrives then is not followed (see `start`). */
let connected = false;

/** Whether a try is under way: a second one would be refused by the host and undo the first. */
let attempting = false;

/** How long a host has to answer the handshake once the socket is open. */
const HELLO_WITHIN_MS = 15_000;

function keepLink(link: KeptLink): void {
  if (sharesAccountOrigin()) return;
  try {
    sessionStorage.setItem(
      LINK_KEY,
      JSON.stringify({
        address: link.address,
        token: link.token,
        ...(link.workspace && { workspace: true }),
      }),
    );
  } catch {
    // Storage is off: a reload asks again.
  }
}

function savedLink(): Partial<KeptLink> {
  if (sharesAccountOrigin()) return {};
  try {
    const saved = JSON.parse(sessionStorage.getItem(LINK_KEY) ?? "null") as unknown;
    if (saved && typeof saved === "object") {
      const { address, token, workspace } = saved as Record<string, unknown>;
      if (typeof address === "string" && typeof token === "string")
        return { address, token, ...(workspace === true && { workspace: true }) };
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

/** The trip this tab began, taken out of storage: it counts once. */
function takePending(): PendingLaunch | null {
  try {
    const pending = readPending(sessionStorage.getItem(LAUNCH_KEY));
    sessionStorage.removeItem(LAUNCH_KEY);
    return pending;
  } catch {
    return null;
  }
}

function accountSeenOn(): boolean {
  try {
    return localStorage.getItem(ACCOUNT_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Leaves for the launch page, which comes back with the machine's link (`start` reads it).
 * A sign-in code is asked for along the way unless the machine was last seen signed in.
 */
async function goLaunch(page: string): Promise<void> {
  showOpening("Finding your workspace…");
  const nonce = randomToken();
  let verifier: string | undefined;
  let challenge: string | undefined;
  if (hasAccounts() && !accountSeenOn()) {
    verifier = randomToken();
    challenge = await challengeOf(verifier).catch(() => undefined);
  }
  const pending: PendingLaunch = {
    nonce,
    at: Date.now(),
    ...(verifier && challenge && { verifier }),
  };
  try {
    sessionStorage.setItem(LAUNCH_KEY, JSON.stringify(pending));
  } catch {
    // Nothing can be kept, so the link that comes back couldn't be told from anyone's.
    showForm(
      {},
      "This browser keeps nothing for the page, so it can't open a workspace by itself.",
    );
    return;
  }
  location.replace(launchUrl(page, nonce, pending.verifier ? challenge : undefined));
}

/**
 * Signs in to the account in a tab of its own: the sign-in page comes back to this page's
 * address with a code, and that tab passes it here (`start`, a `signIn` arrival). The tab is
 * opened at once, while the browser still counts the click.
 */
function signInInTab(base: string): Promise<CodeSignIn> {
  const tab = window.open("about:blank", "_blank");
  if (!tab)
    return Promise.reject(
      new Error("The browser blocked the sign-in tab. Allow pop-ups for this page and try again."),
    );
  const verifier = randomToken();
  const state = randomToken(16);
  const redirect = pageAddress();
  return new Promise<CodeSignIn>((resolve, reject) => {
    const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      channel.close();
      clearTimeout(tooLong);
      clearInterval(watch);
      run();
    };
    const tooLong = setTimeout(
      () => finish(() => reject(new Error("The sign-in wasn't finished in time."))),
      5 * 60_000,
    );
    // A tab closed by hand: the code, if one came, arrives a moment before.
    const watch = setInterval(() => {
      if (!tab.closed) return;
      clearInterval(watch);
      setTimeout(() => finish(() => reject(new Error("The sign-in tab was closed."))), 1500);
    }, 1000);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data as { code?: unknown; state?: unknown } | null;
      if (!data || data.state !== state || typeof data.code !== "string") return;
      const code = data.code;
      finish(() => resolve({ code, verifier, redirect }));
    };
    challengeOf(verifier).then(
      (challenge) => tab.location.replace(authorizeUrl(base, redirect, challenge, state)),
      (err: unknown) => {
        tab.close();
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      },
    );
  });
}

/** Connects and starts the IDE on that host. Rejects with why when the host can't be reached. */
async function connect(link: KeptLink, signIn?: CodeSignIn): Promise<void> {
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
  setShell(
    createWebShell(
      link.workspace
        ? { name: "Cloud workspace", cloud: true }
        : { name: new URL(made.url).host, cloud: false },
    ),
  );
  if (!guarded && hasAccounts()) {
    // The host is another computer: the sign-in page comes back here, not to a listener there.
    if (!isLoopbackHost(new URL(made.url).hostname)) setPageSignIn(signInInTab);
    setArrivedSignIn(signIn ?? null);
    if (link.workspace)
      onAccountKnown((signedIn) => {
        try {
          if (signedIn) localStorage.setItem(ACCOUNT_KEY, "1");
          else localStorage.removeItem(ACCOUNT_KEY);
        } catch {
          // Nothing kept: a code is asked for each time.
        }
      });
  }
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
    // The form, not a trip to the launch page.
    try {
      sessionStorage.setItem(FORM_KEY, "1");
    } catch {
      // Nothing kept: the page decides as if opened anew.
    }
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

/** What shows while the page is on its way to the account's machine: a bar, and what is happening. */
function showOpening(text: string): void {
  document.querySelector(".web-connect")?.remove();
  document.body.append(
    h(
      "main",
      { class: "web-connect" },
      h(
        "div",
        { class: "web-opening", role: "status" },
        logo(40),
        h("h1", null, "Opening your workspace"),
        h("div", { class: "web-opening-bar", "aria-hidden": "true" }),
        h("p", { class: "web-status" }, text),
      ),
    ),
  );
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

/**
 * Tries a link. `signIn`: a sign-in code that came with it. `relaunch`: the launch page to go
 * to when it fails (a kept link to the account's machine, which has stopped since or has a
 * new code: the launch page starts it and gives the link of now).
 */
async function attempt(
  link: KeptLink,
  options: { signIn?: CodeSignIn; relaunch?: string | null } = {},
): Promise<void> {
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
    await connect(link, options.signIn);
  } catch (err) {
    // The code isn't kept after a failed try: a wrong one would be sent again on every reload.
    forgetLink();
    if (options.relaunch) {
      attempting = false;
      void goLaunch(options.relaunch);
      return;
    }
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
  let arrival = readArrival(location.hash);
  // Out of the address bar at once: the fragment holds the code.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  try {
    if (sessionStorage.getItem(FORM_KEY) === "1") {
      sessionStorage.removeItem(FORM_KEY);
      if (arrival.kind === "bare") arrival = { kind: "form" };
    }
  } catch {
    // Storage is off: as opened.
  }
  // The sign-in page came back, in the tab opened for it: the code goes to the tab that
  // asked (only that one knows what makes it worth anything), and this tab is done.
  if (arrival.kind === "signIn" || arrival.kind === "signInEnded") {
    const signedIn = arrival.kind === "signIn";
    if (arrival.kind === "signIn") {
      const channel = new BroadcastChannel(SIGN_IN_CHANNEL);
      channel.postMessage({ code: arrival.code, state: arrival.state });
      channel.close();
    }
    document.body.append(
      h(
        "main",
        { class: "web-connect" },
        h(
          "div",
          { class: "web-card" },
          h("h1", null, signedIn ? "Signed in" : "Not signed in"),
          h("p", null, "You can close this tab and go back to the editor."),
        ),
      ),
    );
    setTimeout(() => window.close(), 400);
    return;
  }
  const page = launchPage();
  const pending = takePending();
  const saved = savedLink();
  // A trip is only ever begun from a page that has a launch page (`goLaunch`), so a number
  // kept for this tab is proof enough that one was.
  if (fromOwnLaunch(arrival, pending, Date.now())) {
    // The account's own machine, as the launch page gave it: no form, no question.
    showOpening("Connecting…");
    const signIn =
      arrival.code && pending?.verifier
        ? { code: arrival.code, verifier: pending.verifier, redirect: pageAddress() }
        : undefined;
    void attempt({ ...arrival.link, workspace: true }, { ...(signIn && { signIn }) });
  } else if (arrival.kind === "link") {
    // A kept code belongs to the address it was kept with: a link that names another address
    // (anyone can send one) must not have this tab hand the code to whatever listens there.
    const fromLink = arrival.link;
    const link =
      fromLink.address && fromLink.address !== saved.address
        ? fromLink
        : { address: saved.address, token: saved.token, ...fromLink };
    showForm(link);
    // By itself only to this computer; another host's address waits for Connect.
    if (linkMayConnect(link)) void attempt(link);
  } else if (arrival.kind === "workspace" && page) {
    void goLaunch(page);
  } else if (arrival.kind === "bare" && saved.address && saved.token) {
    // A reload: the link this tab was connected with, which the person typed or was given
    // by the launch page. The account's machine may have stopped since: the launch page then.
    if (saved.workspace) showOpening("Connecting…");
    else showForm(saved);
    void attempt(
      { address: saved.address, token: saved.token, ...(saved.workspace && { workspace: true }) },
      { relaunch: saved.workspace ? page : null },
    );
  } else if (arrival.kind === "bare" && page) {
    void goLaunch(page);
  } else {
    showForm(arrival.kind === "form" ? {} : saved);
  }
  // A link opened in a tab that already shows this page changes only the fragment, which
  // loads nothing: take the link and start over with it.
  // Never under a running session: whoever can change this tab's address could otherwise end
  // it, with its unsaved text, and point the tab at a host of their choosing.
  window.addEventListener("hashchange", () => {
    const next = readArrival(location.hash);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    if (connected || attempting || next.kind !== "link" || !linkMayConnect(next.link)) return;
    showForm(next.link);
    void attempt(next.link);
  });
}

start();
