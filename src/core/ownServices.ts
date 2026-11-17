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
