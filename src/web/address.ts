// Where a host is and how a page reaches it: the link the host's own computer shows
// (`#h=<address>&t=<code>`), and the WebSocket address for what a person typed. DOM-free; tested.

/** What a connection needs: where the host listens, and the code it was started with. */
export interface HostLink {
  address: string;
  token: string;
}

/**
 * A link's fragment (`#h=127.0.0.1:4000&t=…`). The fragment is used because a browser never
 * sends it to the site that serves the page: the code stays between this tab and the host.
 */
export function parseHostLink(hash: string): Partial<HostLink> {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const address = params.get("h")?.trim();
  const token = params.get("t")?.trim();
  return { ...(address && { address }), ...(token && { token }) };
}

/**
 * Whether a link may connect by itself. Only to this computer: a link is something anyone can
 * send, and a host is trusted with the page, so a link naming another machine is never followed
 * without the person typing that address themself.
 */
export function linkMayConnect(link: Partial<HostLink>): link is HostLink {
  if (!link.address || !link.token) return false;
  const made = socketUrl(link.address, { remote: false });
  return "url" in made;
}

/** The fragment for a link (`parseHostLink` reads it back). */
export function hostLinkHash(link: HostLink): string {
  return `#${new URLSearchParams({ h: link.address, t: link.token }).toString()}`;
}

/** Whether a host name is this computer itself. */
export function isLoopbackHost(host: string): boolean {
  // Exactly the two names the page's content policy lets it connect to (policy.json).
  const name = host.toLowerCase();
  return name === "localhost" || name === "127.0.0.1";
}

/**
 * The WebSocket address for what was typed: `127.0.0.1:4000`, `localhost:4000`, a host name
 * (`dev.example.com`), or a whole `ws://` / `wss://` address.
 *
 * This computer is reached without encryption (nothing leaves it). Any other host only with it
 * (`wss://`): the code and everything after it would otherwise cross the network in the clear.
 * With `remote: false` only this computer is an answer (see `entry.ts`: a page that shares its
 * origin with the account pages trusts no host but the person's own).
 */
export function socketUrl(
  typed: string,
  options: { remote?: boolean } = {},
): { url: string } | { error: string } {
  const text = typed.trim();
  if (!text) return { error: "Enter the host's address." };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `ws://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: "That isn't an address like 127.0.0.1:4000 or dev.example.com." };
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    return { error: "The address must start with ws:// or wss://." };
  if (url.username || url.password)
    return { error: "The address can't hold a name or a password." };
  const local = isLoopbackHost(url.hostname);
  if (!local && options.remote === false)
    return {
      error:
        "This page connects to this computer only (127.0.0.1). A host on another computer needs the page served from an address of its own.",
    };
  // A bare name that isn't this computer: encrypted, since nothing said otherwise.
  if (!local && url.protocol === "ws:") {
    if (/^ws:\/\//i.test(text))
      return { error: "A host on another computer needs an encrypted address (wss://)." };
    url.protocol = "wss:";
  }
  url.hash = "";
  return { url: url.toString() };
}
