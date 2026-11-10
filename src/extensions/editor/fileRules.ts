// What the editor applies to a file beyond its document: read-only by the settings or the
// session's override (readOnlyFiles.ts, VS Code's), and its secret values hidden
// (secretValues.ts, `editor.hideSecrets`). Views read `readOnly` / `hideSecrets` inside an effect:
// both follow the settings and the session through signals.

import { fsIpc } from "../../core/ipc/fs";
import { pathKey } from "../../core/paths/index";
import { signal } from "../../core/reactive/index";
import { uriScheme } from "../../workbench/extensionRegistries";
import type { WorkbenchServices } from "../../workbench/services";
import { isReadOnlyFile, ReadOnlySession } from "./readOnlyFiles";
import { DEFAULT_SECRET_FILES, isSecretFile } from "./secretValues";
import { isUntitled } from "./untitled";

export class EditorFileRules {
  readonly session = new ReadOnlySession();
  /** Bumped when the session or a file's write permission changes. */
  private readonly version = signal(0);
  /** files.readonlyFromPermissions: whether each file asked about lacks write permission. */
  private readonly noPermission = new Map<string, boolean>();
  private readonly asking = new Set<string>();

  constructor(private readonly services: Pick<WorkbenchServices, "settings" | "workspace">) {}

  /** A file on disk the rules apply to (not generated text or an untitled document). */
  private static applies(path: string): boolean {
    return !!path && !path.startsWith("virtual:") && !isUntitled(path) && !uriScheme(path);
  }

  /** Whether the file is kept read-only (whatever its document allows). */
  readOnly(path: string): boolean {
    if (!EditorFileRules.applies(path)) return false;
    const { settings, workspace } = this.services;
    settings.version.value;
    this.version.value;
    const key = pathKey(path);
    const fromPermissions = settings.peek<boolean>("files.readonlyFromPermissions") === true;
    return isReadOnlyFile(this.session.get(key), workspace.relative(path), path, {
      include: settings.peek<Record<string, unknown>>("files.readonlyInclude") ?? {},
      exclude: settings.peek<Record<string, unknown>>("files.readonlyExclude") ?? {},
      noWritePermission: fromPermissions && this.lacksPermission(path, key),
    });
  }

  /** Whether the session overrides the settings for the file (Reset… is offered then). */
  overridden(path: string): boolean {
    this.version.value;
    return this.session.get(pathKey(path)) !== undefined;
  }

  /** Read-only / writable for the rest of the session; null: back to the settings. */
  setSession(path: string, readOnly: boolean | null): void {
    this.session.set(pathKey(path), readOnly);
    this.version.value = this.version.peek() + 1;
  }

  renamed(from: string, to: string): void {
    this.session.rename(pathKey(from), pathKey(to));
    this.version.value = this.version.peek() + 1;
  }

  /** Whether the file's secret values are covered (editor.hideSecrets, editor.secretFiles). */
  hideSecrets(path: string): boolean {
    if (!EditorFileRules.applies(path)) return false;
    const { settings } = this.services;
    settings.version.value;
    if (settings.peek<boolean>("editor.hideSecrets") !== true) return false;
    const patterns = settings.peek<string[]>("editor.secretFiles") ?? DEFAULT_SECRET_FILES;
    return isSecretFile(path, patterns);
  }

  /** Asked once per file (a write later doesn't change it within the session). */
  private lacksPermission(path: string, key: string): boolean {
    const known = this.noPermission.get(key);
    if (known !== undefined) return known;
    if (!this.asking.has(key)) {
      this.asking.add(key);
      void fsIpc
        .stat(path)
        .then((st) => st.readonly)
        .catch(() => false)
        .then((readonly) => {
          this.asking.delete(key);
          this.noPermission.set(key, readonly);
          if (readonly) this.version.value = this.version.peek() + 1;
        });
    }
    return false;
  }
}
