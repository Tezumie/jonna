// Remote locations (D252): a folder or workspace file on another machine, as the recent list, the
// window registry and the command line name it — `ssh://<host><absolute path>` (the host as the
// user wrote it: an ~/.ssh/config alias or user@host, an optional :port). Inside a remote window
// paths are the remote's plain POSIX paths ("/home/me/app"); only these location strings carry
// the host. DOM-free.

/** ssh, WSL, or a container (a dev container, D266: `container:<user@id>`). */
export type RemoteKind = "ssh" | "wsl" | "container";

export interface RemoteAuthority {
  kind: RemoteKind;
  /**
   * ssh: the host as written (alias, user@host, user@host:port); wsl: the distribution;
   * container: [user@]<container id or name>.
   */
  host: string;
}

export interface RemoteLocation {
  authority: RemoteAuthority;
  /** Absolute POSIX path on the remote ("/" when only the host is named). */
  path: string;
}

/** "ssh:box" / "wsl:Ubuntu": how a window's remote is passed between processes. */
export function authorityString(a: RemoteAuthority): string {
  return `${a.kind}:${a.host}`;
}

export function parseAuthority(text: string): RemoteAuthority | null {
  const m = /^(ssh|wsl|container):(.+)$/.exec(text.trim());
  if (!m?.[1] || !m[2]) return null;
  const host = m[2].trim();
  if (!validHost(m[1] as RemoteKind, host)) return null;
  return { kind: m[1] as RemoteKind, host };
}

/**
 * A host the user typed or picked: letters, digits and `._-@:` (no spaces, slashes, quotes or
 * shell characters: it goes to `ssh` as one argument, never through a shell, but an option-like
 * "-oProxyCommand=…" must not get through either).
 */
export function validHost(kind: RemoteKind, host: string): boolean {
  if (!host || host.length > 255 || host.startsWith("-")) return false;
  if (kind === "wsl") return /^[A-Za-z0-9._-]+$/.test(host);
  if (kind === "container") return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host);
  return /^[A-Za-z0-9._@:[\]%-]+$/.test(host);
}

/** `ssh://box/home/me/app` (the path's characters as they are, spaces encoded). */
export function formatRemoteLocation(loc: RemoteLocation): string {
  const path = loc.path.startsWith("/") ? loc.path : `/${loc.path}`;
  return `${loc.authority.kind}://${loc.authority.host}${path.replaceAll("%", "%25").replaceAll(" ", "%20")}`;
}

/** A remote location string, or null for anything else (a local path). */
export function parseRemoteLocation(text: string): RemoteLocation | null {
  const m = /^(ssh|wsl|container):\/\/([^/]+)(\/.*)?$/.exec(text);
  if (!m?.[1] || !m[2]) return null;
  const kind = m[1] as RemoteKind;
  if (!validHost(kind, m[2])) return null;
  let path: string;
  try {
    path = decodeURIComponent(m[3] ?? "/");
  } catch {
    return null;
  }
  // No ".." tricks in a stored location: it names one folder.
  if (path.split("/").some((p) => p === "..")) return null;
  return { authority: { kind, host: m[2] }, path };
}

export function isRemoteLocation(text: string): boolean {
  return parseRemoteLocation(text) !== null;
}

/** "SSH: box" / "WSL: Ubuntu": the status bar's and titles' name for a remote. */
export function remoteLabel(a: RemoteAuthority): string {
  const name = a.kind === "ssh" ? "SSH" : a.kind === "wsl" ? "WSL" : "Dev container";
  return `${name}: ${a.host}`;
}
