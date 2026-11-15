// Risky folders (D213, the model in core/security/riskyFolders.ts): the user's Downloads (and
// folders in it), the home folder, the Desktop, temp and drive roots. `RiskyFolders` knows where they are
// (from Rust's app info, a test override and `security.riskyFolders`); `askRiskyOpen`
// (riskyOpenDialog.ts) is the caution shown before one opens as the workspace. The workspace trust
// service owns one (`services.trust.risky`); the agent asks before working in them
// (extensions/agent/riskyGuard.ts). DOM-free.
import { appIpc } from "../core/ipc/system";
import { signal } from "../core/reactive/index";
import {
  downloadsFolderOf,
  type FolderPlatform,
  folderKey,
  type RiskyMatch,
  riskyFolderOf,
  type UserFolders,
} from "../core/security/riskyFolders";

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
