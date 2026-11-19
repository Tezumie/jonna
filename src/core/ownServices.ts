// The online services a build uses, DOM-free: the accounts server, the pages of it the app opens
// in the browser, and whether Sync is part of the build. Everything here is read from
// product.json (docs/own-services.md), so a build made from this code with other services, or
// with none, changes that file and nothing else. The one seam the accounts and sync extensions
// and the list of built-in extensions read; nothing else spells a server address or a page.
import { product } from "./product";

/** The part of product.json that names the services. */
export interface OwnServices {
  /** The accounts server; empty: the build has no account of its own. */
  readonly accountsUrl: string;
  /** The account page: a path on the accounts server, or a whole URL. */
  readonly accountPagePath: string;
  /** The page where a plan is bought, renewed or cancelled: a path, or a whole URL. */
  readonly planPagePath: string;
  /** The page where a subscriber's team is managed: a path, or a whole URL; empty: no teams. */
  readonly teamPagePath: string;
  /** Where the front end is served as a website (a path, or a whole URL); empty: nowhere. */
  readonly webAppPath: string;
  /** True: the accounts server keeps nothing another name of its domain can reach. */
  readonly webAppSubdomainIsolated: boolean;
  /** False leaves Sync out of the build. */
  readonly syncBuiltIn: boolean;
}

/** Whether the build has an account of its own (sign-in, profile): it names an accounts server. */
export function hasAccounts(config: OwnServices = product): boolean {
  return config.accountsUrl.trim() !== "";
}

/** Whether Sync is part of the build: switched on, and there is an account to sync. */
export function hasSync(config: OwnServices = product): boolean {
  return config.syncBuiltIn && hasAccounts(config);
}

/**
 * Whether `url` names this computer itself (`localhost`, `127.0.0.1`, `[::1]`, a name ending
 * in `.localhost`): where a server under development runs.
 */
export function isLoopbackServer(url: string): boolean {
  let host: string;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]"
  );
}

/** Whether this is a build with the development features (never a released one). */
function developmentBuild(): boolean {
  return typeof __DEV__ !== "undefined" && __DEV__;
}

/**
 * The accounts server in use, without a trailing slash: the build's, or the
 * `accounts.serverUrl` setting, which is for developing the server. The setting counts only
 * when it names this computer itself, or in a development build: a settings file (which
 * anything on the computer can write) must not be able to send the account's sign-in, and
 * what the team publishes, to a server of someone's choosing. Empty in a build without
 * accounts, whatever the setting says.
 */
export function accountsServer(
  setting: string | undefined,
  config: OwnServices = product,
  development: boolean = developmentBuild(),
): string {
  if (!hasAccounts(config)) return "";
  const asked = setting?.trim() ?? "";
  const honoured = asked !== "" && (development || isLoopbackServer(asked));
  return (honoured ? asked : config.accountsUrl.trim()).replace(/\/+$/, "");
}

/** Whether the service has a page for plans. Without one the app says nothing of plans or payment. */
export function hasPlanPage(config: OwnServices = product): boolean {
  return config.planPagePath.trim() !== "";
}

/** Whether the service has a page for teams. Without one the app says nothing about teams. */
export function hasTeamPage(config: OwnServices = product): boolean {
  return config.teamPagePath.trim() !== "";
}

/**
 * Whether the build has teams' libraries (what a team publishes so every member's IDE works
 * the same way: rules, skills, commands, default settings…): Sync is part of the build, since a
 * team is a Sync subscriber and the people they invited, and the service has teams.
 */
export function hasTeams(config: OwnServices = product): boolean {
  return hasSync(config) && hasTeamPage(config);
}

/** A page of the service: `page` on the server `base`, or `page` itself when it is a whole URL. */
function pageUrl(base: string, page: string): string {
  if (/^https?:\/\//i.test(page)) return page;
  const root = base.replace(/\/+$/, "");
  return page.startsWith("/") || page.startsWith("#") ? `${root}${page}` : `${root}/${page}`;
}

/**
 * The page that is the front end as a website (it connects to a host, src/web), or null when the
 * build names none.
 */
export function webAppUrl(config: OwnServices = product): string | null {
  const page = config.webAppPath.trim();
  if (!page) return null;
  if (/^https?:\/\//i.test(page)) return page;
  return hasAccounts(config) ? pageUrl(config.accountsUrl, page) : null;
}

/** The last two labels of a host name: a rough "same domain" without a list of public suffixes. */
function domainOf(host: string): string {
  return host.split(".").slice(-2).join(".");
}

/**
 * Whether a page on the host name `pageHost` shares its address with the account pages, so that
 * what runs in one can reach what the other keeps. The web front end trusts less there
 * (src/web/entry.ts: this computer only, no extension code, the code in memory only).
 *
 * The same name always does. Another name of the same domain (`app.example.com` beside
 * `example.com` or `www.example.com`) is another origin, with storage of its own, but the same
 * site: a cookie set for the whole domain reaches both. So it counts as shared too, unless
 * product.json says the accounts server sets no such cookie (`webAppSubdomainIsolated`).
 * Without a list of public suffixes "the same domain" is the last two labels, which errs on the
 * careful side (`a.co.uk` and `b.co.uk` count as one). A build without accounts shares nothing.
 *
 * `scripts/web-host.mjs` decides the same way when it starts a host: keep the two alike.
 */
export function webAppSharesAccounts(pageHost: string, config: OwnServices = product): boolean {
  if (!hasAccounts(config)) return false;
  let accounts: string;
  try {
    accounts = new URL(config.accountsUrl.trim()).hostname.toLowerCase();
  } catch {
    // An address that can't be read is no reason to trust more.
    return true;
  }
  const here = pageHost.trim().toLowerCase();
  if (here === accounts) return true;
  if (config.webAppSubdomainIsolated) return false;
  // Numbers aren't names: two addresses that end alike are two machines.
  if (/^[\d.]+$/.test(here) || here.includes(":") || !here.includes(".")) return false;
  return domainOf(here) === domainOf(accounts);
}

/** The account page (devices, storage, resetting sync) of the accounts server `base`. */
export function accountPageUrl(base: string, config: OwnServices = product): string {
  return pageUrl(base, config.accountPagePath);
}

/** The page where a plan is bought, renewed or cancelled. Payment happens there, never here. */
export function planPageUrl(base: string, config: OwnServices = product): string {
  return pageUrl(base, config.planPagePath);
}

/** The page where a team is managed (inviting, removing, seats). Teams change there, never here. */
export function teamPageUrl(base: string, config: OwnServices = product): string {
  return pageUrl(base, config.teamPagePath);
}
