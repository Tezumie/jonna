// A path on the host as the steps a path bar shows (the web picker, shell.ts): each step's
// name and the folder it opens. DOM-free; the host may be another system than this one.

export interface Crumb {
  label: string;
  path: string;
}

/**
 * `path` as steps from its root. `windows`: the host's paths use backslashes and drives
 * (a network path's first step is its server and share together: nothing above lists).
 */
export function pathCrumbs(path: string, windows: boolean): Crumb[] {
  const text = path.trim();
  if (!text) return [];
  if (!windows) {
    const names = text.split("/").filter(Boolean);
    const crumbs: Crumb[] = text.startsWith("/") ? [{ label: "/", path: "/" }] : [];
    let at = text.startsWith("/") ? "" : ".";
    for (const name of names) {
      at = at === "." ? name : `${at}/${name}`;
      crumbs.push({ label: name, path: at });
    }
    return crumbs;
  }
  const unc = /^\\\\([^\\]+)\\([^\\]+)\\?(.*)$/.exec(text);
  if (unc) {
    const root = `\\\\${unc[1]}\\${unc[2]}\\`;
    return [{ label: root.slice(0, -1), path: root }, ...steps(root, unc[3] ?? "")];
  }
  const drive = /^([A-Za-z]:)[\\/]?(.*)$/.exec(text);
  if (drive) {
    const root = `${drive[1]}\\`;
    return [{ label: drive[1] ?? "", path: root }, ...steps(root, drive[2] ?? "")];
  }
  return steps("", text);
}

function steps(root: string, rest: string): Crumb[] {
  const crumbs: Crumb[] = [];
  let at = root;
  for (const name of rest.split(/[\\/]/).filter(Boolean)) {
    at = at === "" || at.endsWith("\\") ? `${at}${name}` : `${at}\\${name}`;
    crumbs.push({ label: name, path: at });
  }
  return crumbs;
}

/** Folders of a home folder worth a place of their own in the picker, when they exist. */
export const HOME_PLACES = ["projects", "Projects", "Desktop", "Documents", "Downloads"];
