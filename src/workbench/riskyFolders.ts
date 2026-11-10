// Risky folders (D213, the model in core/security/riskyFolders.ts): the user's Downloads (and
// folders in it), the home folder, the Desktop, temp and drive roots. `RiskyFolders` knows where they are
// (from Rust's app info, a test override and `security.riskyFolders`); `askRiskyOpen` is the
// caution shown before one opens as the workspace. The workspace trust service owns one
// (`services.trust.risky`); the agent asks before working in them (extensions/agent/riskyGuard.ts).
import { appIpc } from "../core/ipc/system";
import { basename } from "../core/paths/index";
import { signal } from "../core/reactive/index";
import {
  downloadsFolderOf,
  type FolderPlatform,
  folderKey,
  type RiskyMatch,
  riskyFolderOf,
  riskyLabel,
  riskyReason,
  type UserFolders,
} from "../core/security/riskyFolders";
import { showDialog } from "../ui/Dialog";

export type { RiskyKind, RiskyMatch } from "../core/security/riskyFolders";

export class RiskyFolders {
  private folders: UserFolders = { home: null, downloads: [], desktop: [], temp: [] };
  private platform: FolderPlatform = "linux";
  private loading: Promise<void> | null = null;
  /** Test runs: replaces the Downloads list (security.setTestDownloadsFolder). */
  private testDownloads: string[] | null = null;
  private extra: () => readonly string[] = () => [];
  /** Bumped when the folders are known or change (the trust state and ide://workspace redo). */
  readonly version = signal(0);

  /** Loads the folders once (app info); later calls share it. Never rejects. */
  ready(): Promise<void> {
    this.loading ??= appIpc
      .info()
      .then((info) => {
        this.platform = info.os === "windows" ? "windows" : info.os === "macos" ? "mac" : "linux";
        this.folders = {
          home: info.homeDir,
          downloads: info.userFolders?.downloads ?? [],
          desktop: info.userFolders?.desktop ?? [],
          temp: info.userFolders?.temp ?? [],
        };
        this.version.value++;
      })
      .catch(() => {});
    return this.loading;
  }

  /** Folders the user added (security.riskyFolders), read when needed. */
  setExtra(read: () => readonly string[]): void {
    this.extra = read;
    this.version.value++;
  }

  /** Test hook: the Downloads folder is `path` (null: the real one again). */
  setTestDownloads(path: string | null): void {
    this.testDownloads = path ? [path] : null;
    this.version.value++;
  }

  known(): UserFolders {
    return this.testDownloads ? { ...this.folders, downloads: this.testDownloads } : this.folders;
  }

  get home(): string | null {
    return this.folders.home;
  }

  get os(): FolderPlatform {
    return this.platform;
  }

  /** Whether `path` is a risky folder (or inside Downloads), and which. */
  riskOf(path: string | null): RiskyMatch | null {
    return path ? riskyFolderOf(path, this.known(), this.platform, this.extraFolders()) : null;
  }

  /** The Downloads folder `path` is in, or null. */
  downloadsOf(path: string): string | null {
    return downloadsFolderOf(path, this.known(), this.platform, this.extraFolders());
  }

  /** Every Downloads-like folder (for command lines that name one). */
  downloadFolders(): string[] {
    return [...this.known().downloads, ...this.extraFolders()];
  }

  key(path: string): string {
    return folderKey(path, this.platform);
  }

  private extraFolders(): string[] {
    return this.extra().filter((p) => typeof p === "string" && p.trim() !== "");
  }
}

export type RiskyOpenChoice = "restricted" | "trusted" | "cancel";

/**
 * The caution before a risky folder opens: what's risky about it, in plain words, and three
 * choices — open in restricted mode (the default), open and trust, cancel — with "Don't ask
 * again for this folder".
 */
export async function askRiskyOpen(
  path: string,
  match: RiskyMatch,
  /** `path` is inside the risky folder rather than the folder itself. */
  nested: boolean,
): Promise<{ choice: RiskyOpenChoice; dontAsk: boolean }> {
  let dontAsk = false;
  const label = riskyLabel(match.kind);
  const name = basename(path) || path;
  const title = nested ? `“${name}” is in ${label}` : `Open ${label}?`;
  const choice = await showDialog<RiskyOpenChoice>({
    title,
    message: `${riskyReason(match.kind)}\n\nIn restricted mode, agents don't load this folder's instruction files (AGENTS.md, CLAUDE.md, rules, skills), its tasks, debugging, tests and git don't run, and an agent asks before it works here. You can still browse and edit every file, and trust the folder later with "Manage workspace trust".`,
    actions: [
      { label: "Cancel", value: "cancel", variant: "secondary" },
      { label: "Open and trust", value: "trusted", variant: "secondary" },
      { label: "Open in restricted mode", value: "restricted", variant: "primary" },
    ],
    cancelValue: "cancel",
    defaultValue: "restricted",
    size: "md",
    checkbox: {
      label: "Don't ask again for this folder",
      detail: path,
      onCheck: (checked) => (dontAsk = checked),
    },
  });
  return { choice, dontAsk };
}
