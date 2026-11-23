// How the page comes to a hosted machine without anyone typing an address (D467): it goes to
// the account service's launch page (product.json `workspaceLaunchPath`) with a number made
// here, and that page, where the person is signed in, starts their machine and sends the tab
// back with the machine's link and the same number. Only a link that carries the number this
// tab made is followed by itself: a link is something anyone can send, and a host is trusted
// with the page. The same trip can sign the machine in to the account (a code for a PKCE
// challenge made here). DOM-free; tested.
import { type HostLink, parseHostLink } from "./address";

/** What the page was opened with (its fragment). */
export type Arrival =
  /** Nothing: the page's bare address. */
  | { kind: "bare" }
  /** `#connect`: the form, without a trip to the launch page. */
  | { kind: "form" }
  /** `#workspace`: the account's machine, by way of the launch page. */
  | { kind: "workspace" }
  /** `#h=…&t=…`: a host's link; from the launch page with `n` (and `c`, a sign-in code). */
  | { kind: "link"; link: Partial<HostLink>; nonce?: string; code?: string }
  /** `#signin&code=…&state=…`: the sign-in page coming back, in the tab opened for it. */
  | { kind: "signIn"; code: string; state: string }
  /** The sign-in page coming back without a code: cancelled, or refused. */
  | { kind: "signInEnded" };

/** What a launch or a sign-in sends back: letters, digits, `-` and `_` only. */
const PLAIN = /^[A-Za-z0-9_-]{8,256}$/;

export function readArrival(hash: string): Arrival {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const plain = (key: string) => {
    const value = params.get(key) ?? "";
    return PLAIN.test(value) ? value : undefined;
  };
  if (params.has("signin")) {
    const code = plain("code");
    const state = plain("state");
    return code && state ? { kind: "signIn", code, state } : { kind: "signInEnded" };
  }
  const link = parseHostLink(hash);
  if (link.address || link.token) {
    const nonce = plain("n");
    const code = plain("c");
    return { kind: "link", link, ...(nonce && { nonce }), ...(code && { code }) };
  }
  if (params.has("workspace")) return { kind: "workspace" };
  if (params.has("connect")) return { kind: "form" };
  return { kind: "bare" };
}

/** Unpadded base64url (RFC 4648 §5). */
export function base64url(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A number nobody can guess, as text. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The PKCE challenge for a verifier (S256). */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** A trip to the launch page that this tab began. */
export interface PendingLaunch {
  nonce: string;
  /** The verifier of the sign-in code asked for, when one was. */
  verifier?: string;
  /** When it left (ms). */
  at: number;
}

/** How long a trip may take: the launch page may wait for a machine to start, or a sign-in. */
export const LAUNCH_WITHIN_MS = 30 * 60_000;

/** The launch page's address for a trip: the number, and the challenge when a code is wanted. */
export function launchUrl(page: string, nonce: string, challenge?: string): string {
  const params = new URLSearchParams({ n: nonce, ...(challenge && { c: challenge }) });
  return `${page.replace(/#.*$/, "")}#${params.toString()}`;
}

/** The cookie that tells the launch page a trip was begun by this page (see `launchCookie`). */
export const LAUNCH_COOKIE = "launch_n";

/**
 * The cookie to set before leaving for the launch page: a digest of the trip's number, for
 * the launch page's own path, gone in two minutes. The launch page acts by itself (starts a
 * machine, has a sign-in code made) only when it finds the digest of the number it was given:
 * a link to it that someone else wrote carries a number but no cookie, and then it asks for
 * a click first. Null when this page can't set one the launch page would see: the launch
 * page must be on this page's own name or a parent of it (`app.example.com` and
 * `example.com`), and reached over https.
 */
export function launchCookie(pageHost: string, launchPage: string, digest: string): string | null {
  let url: URL;
  try {
    url = new URL(launchPage);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const here = pageHost.toLowerCase();
  if (url.protocol !== "https:" || !host.includes(".") || /^[\d.]+$/.test(host)) return null;
  if (here !== host && !here.endsWith(`.${host}`)) return null;
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(digest)) return null;
  return `${LAUNCH_COOKIE}=${digest}; Domain=${host}; Path=${url.pathname || "/"}; Max-Age=120; Secure; SameSite=Strict`;
}

/** Whether a link came back from the trip this tab began. */
export function fromOwnLaunch(
  arrival: Arrival,
  pending: PendingLaunch | null,
  now: number,
): arrival is Extract<Arrival, { kind: "link" }> & { link: HostLink } {
  if (arrival.kind !== "link" || !pending || !arrival.nonce) return false;
  if (!arrival.link.address || !arrival.link.token) return false;
  if (now - pending.at > LAUNCH_WITHIN_MS || now < pending.at) return false;
  return arrival.nonce === pending.nonce;
}

/** A pending trip as it is kept for the tab, read back; null for anything else. */
export function readPending(kept: string | null): PendingLaunch | null {
  try {
    const value = JSON.parse(kept ?? "null") as unknown;
    if (!value || typeof value !== "object") return null;
    const { nonce, verifier, at } = value as Record<string, unknown>;
    if (typeof nonce !== "string" || !PLAIN.test(nonce) || typeof at !== "number") return null;
    return { nonce, at, ...(typeof verifier === "string" && PLAIN.test(verifier) && { verifier }) };
  } catch {
    return null;
  }
}

/** The sign-in page's address for a sign-in whose code comes back to `redirect` (this page). */
export function authorizeUrl(
  accounts: string,
  redirect: string,
  challenge: string,
  state: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "desktop",
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${accounts.replace(/\/+$/, "")}/oauth/authorize?${params.toString()}`;
}
