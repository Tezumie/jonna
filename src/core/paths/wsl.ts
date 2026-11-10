// WSL folders seen from Windows (D192): `\\wsl.localhost\<distro>\<linux path>` (or `\\wsl$\…`).
// DOM-free; the Rust side has the same parser (src-tauri/src/wsl.rs).

export interface WslLocation {
  distro: string;
  /** The Linux path, `/`-separated. */
  linux: string;
}

export function parseWslPath(path: string): WslLocation | null {
  const p = path.replaceAll("/", "\\");
  const rest = p.startsWith("\\\\?\\UNC\\") ? p.slice(8) : p.startsWith("\\\\") ? p.slice(2) : null;
  if (rest === null) return null;
  const parts = rest.split("\\").filter(Boolean);
  const host = (parts[0] ?? "").toLowerCase();
  if ((host !== "wsl.localhost" && host !== "wsl$") || !parts[1]) return null;
  // As the Rust parser: a name with quotes or `$` isn't one WSL would have.
  if (/["'`$]/.test(parts[1])) return null;
  return { distro: parts[1], linux: `/${parts.slice(2).join("/")}` };
}
