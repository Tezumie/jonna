// Risky workspace roots (D213). Browsers save files from the web into the Downloads folder
// without asking, plain text included: an AGENTS.md or CLAUDE.md dropped there is read by an AI
// agent started in that folder as its instructions, and can talk it into changing its own
// configuration (an MCP server in ~/.codex/config.toml, ANTHROPIC_BASE_URL in
// .claude/settings.json). So the IDE treats a few folders as risky:
//
//   downloads  the Downloads folder (Windows' Known Folder, macOS ~/Downloads, Linux's
//              XDG_DOWNLOAD_DIR and ~/Downloads) and every folder inside it (an extracted zip);
//              also the folders in `security.riskyFolders`, which count the same way
//   home       the home folder itself: everything lies around in it, Downloads included
//   desktop    the Desktop itself: where files land by drag, browsers on some systems
//   temp       the temp folder itself: where archives are opened and attachments saved
//   root       a drive or file system root itself (C:\, D:\, /, \\server\share): a USB stick or
//              a downloaded disk image opens there, and everything on the drive lies below it
//
// Only Downloads counts with its subfolders: projects under the home folder, the Desktop,
// temp or a drive root are ordinary (a test run's folder is under temp). DOM-free and tested; the folders
// themselves come from Rust (app_info's userFolders).

export type RiskyKind = "downloads" | "home" | "desktop" | "temp" | "root";

export type FolderPlatform = "windows" | "mac" | "linux";

/** The user's folders, as Rust resolves them (each list: the folder as found and canonical). */
export interface UserFolders {
  home: string | null;
  downloads: readonly string[];
  desktop: readonly string[];
  temp: readonly string[];
}

export interface RiskyMatch {
  kind: RiskyKind;
  /** The risky folder it is, or is inside of. */
  folder: string;
}

/** `\\?\C:\x` → `C:\x`; no trailing separator (a root keeps its own). */
export function cleanFolder(path: string): string {
  let p = path.trim();
  if (p.startsWith("\\\\?\\UNC\\")) p = `\\\\${p.slice(8)}`;
  else if (p.startsWith("\\\\?\\")) p = p.slice(4);
  const windows = /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\");
  if (windows) p = p.replaceAll("/", "\\");
  const root = /^[A-Za-z]:\\?|^\\\\[^\\]+\\[^\\]+|^\//.exec(p)?.[0].length ?? 0;
  while (p.length > Math.max(root, 1) && /[\\/]$/.test(p)) p = p.slice(0, -1);
  return p;
}

/**
 * Comparison key: Windows paths and (by default) macOS ones compare without case, as their file
 * systems do; Linux paths exactly.
 */
export function folderKey(path: string, platform: FolderPlatform): string {
  const p = cleanFolder(path);
  const windows = /^[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\");
  return windows || platform === "mac" ? p.toLowerCase() : p;
}

/** Whether `path` is `folder` or inside it. */
export function insideFolder(folder: string, path: string, platform: FolderPlatform): boolean {
  if (!folder.trim() || !path.trim()) return false;
  const f = folderKey(folder, platform);
  const p = folderKey(path, platform);
  if (p === f) return true;
  const sep = f.includes("\\") && !f.includes("/") ? "\\" : "/";
  return p.startsWith(f.endsWith(sep) ? f : `${f}${sep}`);
}

/**
 * Which risky folder `path` is (or, for Downloads and `extra`, is inside of), or null. Downloads
 * wins over the others: a Downloads folder that is the home folder still counts as Downloads.
 */
export function riskyFolderOf(
  path: string,
  folders: UserFolders,
  platform: FolderPlatform,
  extra: readonly string[] = [],
): RiskyMatch | null {
  if (!path.trim()) return null;
  for (const folder of [...folders.downloads, ...extra])
    if (folder.trim() && insideFolder(folder, path, platform))
      return { kind: "downloads", folder: cleanFolder(folder) };
  const same = (folder: string) => folderKey(folder, platform) === folderKey(path, platform);
  if (folders.home && same(folders.home))
    return { kind: "home", folder: cleanFolder(folders.home) };
  for (const folder of folders.desktop)
    if (folder.trim() && same(folder)) return { kind: "desktop", folder: cleanFolder(folder) };
  for (const folder of folders.temp)
    if (folder.trim() && same(folder)) return { kind: "temp", folder: cleanFolder(folder) };
  if (isFileSystemRoot(path)) return { kind: "root", folder: cleanFolder(path) };
  return null;
}

/** Whether `path` is a drive or file system root: `C:\`, `C:`, `/`, `\\server\share`. */
export function isFileSystemRoot(path: string): boolean {
  const p = cleanFolder(path);
  return /^[A-Za-z]:\\?$/.test(p) || p === "/" || /^\\\\[^\\]+\\[^\\]+$/.test(p);
}

/** The Downloads folder (or `extra` one) that `path` is inside of, or null. */
export function downloadsFolderOf(
  path: string,
  folders: UserFolders,
  platform: FolderPlatform,
  extra: readonly string[] = [],
): string | null {
  const match = riskyFolderOf(
    path,
    { ...folders, home: null, desktop: [], temp: [] },
    platform,
    extra,
  );
  return match ? match.folder : null;
}

/**
 * Whether a command line names `folder`: its absolute path, or the home-relative spellings
 * shells use (`~/Downloads`, `$HOME/Downloads`, `%USERPROFILE%\Downloads`,
 * `$env:USERPROFILE\Downloads`), or — when the command runs in the home folder — `Downloads/…`
 * as a relative path. A heuristic for run_command and terminals: a shell can reach anything.
 */
export function mentionsFolder(
  line: string,
  folder: string,
  home: string | null,
  platform: FolderPlatform,
  cwd?: string | null,
): boolean {
  const text = line.replace(/["']/g, "");
  const f = cleanFolder(folder);
  const fold = (s: string) => (platform === "linux" ? s : s.toLowerCase());
  const hay = fold(text.replaceAll("\\", "/"));
  const abs = fold(f.replaceAll("\\", "/"));
  const boundary = (s: string, at: number, len: number) => {
    const next = s.charAt(at + len);
    return next === "" || /[/\s;&|)>]/.test(next);
  };
  const find = (needle: string) => {
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1))
      if (boundary(hay, at, needle.length)) return true;
    return false;
  };
  if (find(abs)) return true;
  if (!home) return false;
  const h = cleanFolder(home);
  if (!insideFolder(h, f, platform) || folderKey(h, platform) === folderKey(f, platform))
    return false;
  const rest = fold(
    f
      .slice(h.length)
      .replace(/^[\\/]+/, "")
      .replaceAll("\\", "/"),
  );
  const braced = ["$", "{HOME}/"].join("");
  for (const prefix of ["~/", "$HOME/", braced, "%USERPROFILE%/", "$env:USERPROFILE/"])
    if (find(fold(prefix) + rest)) return true;
  // Relative to a command run in the home folder: `ls Downloads`, `cat Downloads/x`.
  if (cwd && folderKey(cwd, platform) === folderKey(h, platform)) {
    const re = new RegExp(
      `(^|[\\s=(])(\\./)?${rest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[/\\s;&|)>])`,
    );
    if (re.test(hay)) return true;
  }
  return false;
}

/** How the folder reads in a sentence: "your Downloads folder". */
export function riskyLabel(kind: RiskyKind): string {
  switch (kind) {
    case "downloads":
      return "your Downloads folder";
    case "home":
      return "your home folder";
    case "desktop":
      return "your Desktop";
    case "temp":
      return "the temporary files folder";
    case "root":
      return "the root of a drive";
  }
}

/** Why the folder is risky, in plain words (the open dialog, the agent's questions). */
export function riskyReason(kind: RiskyKind): string {
  switch (kind) {
    case "downloads":
      return "Your browser saves files here from the web without asking, plain text files included. A downloaded AGENTS.md or CLAUDE.md can hold instructions written to trick an AI agent into changing its settings or sending your data elsewhere.";
    case "home":
      return "Your home folder holds everything, Downloads and the agents' own settings included. A downloaded instructions file or a planted one can trick an AI agent working here.";
    case "desktop":
      return "Files dropped or saved on the Desktop come from anywhere. A downloaded instructions file there can trick an AI agent working in it.";
    case "temp":
      return "Programs save attachments and open archives here. A file from the web there can hold instructions written to trick an AI agent.";
    case "root":
      return "Everything on the drive lies below its root, a USB stick's or a downloaded disk image's files included. An instructions file placed there can trick an AI agent working in it.";
  }
}
