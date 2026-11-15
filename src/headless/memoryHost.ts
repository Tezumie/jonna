// A small backend kept in memory, for tests of the screenless session: the commands a session
// needs to start and open a folder (app info, saved state, settings files, a file tree), answered
// from maps. Paths are POSIX ("/ws/src/a.ts"). Give its `commands` to fakeBackend, with more
// handlers beside them for what a test exercises. DOM-free and Node-free.
import type { FakeCommand } from "./fakeBackend";

export interface MemoryHostOptions {
  /** The backend's OS as its app info reports it (default "linux"). */
  os?: "linux" | "windows" | "macos";
  /** Files by absolute path; their folders exist too. */
  files?: Readonly<Record<string, string>>;
}

export interface MemoryHost {
  /** The file tree: path → text. Tests may read and change it. */
  readonly files: Map<string, string>;
  /** Saved state by scope ("global", "workspace"), as the JSON text the session wrote. */
  readonly state: Map<string, string>;
  /** Audit entries the dispatcher appended (JSON text each). */
  readonly audit: string[];
  /** The folder open as the workspace, or null. */
  root(): string | null;
  readonly commands: Record<string, FakeCommand>;
}

const notFound = (path: string): never => {
  throw { code: "NotFound", message: `not found: ${path}` };
};

export function memoryHost(options: MemoryHostOptions = {}): MemoryHost {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const state = new Map<string, string>();
  const audit: string[] = [];
  let root: string | null = null;
  const isDir = (path: string): boolean => {
    const prefix = path.endsWith("/") ? path : `${path}/`;
    for (const file of files.keys()) if (file.startsWith(prefix)) return true;
    return false;
  };
  const text = (path: string): string => files.get(path) ?? notFound(path);
  const bytes = (value: string): ArrayBuffer => {
    const encoded = new TextEncoder().encode(value);
    return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  };
  const str = (args: Record<string, unknown>, key: string): string => String(args[key] ?? "");
  const commands: Record<string, FakeCommand> = {
    app_info: () => ({
      dataDir: "/data",
      configDir: "/config",
      logsDir: "/logs",
      auditLog: "/logs/audit.jsonl",
      os: options.os ?? "linux",
      arch: "x86_64",
      processStartMs: 0,
      debugBuild: true,
      launchFolder: null,
      homeDir: "/home/user",
      testScript: null,
      osBuild: null,
      userFolders: { downloads: ["/home/user/Downloads"], desktop: [], temp: ["/tmp"] },
    }),
    page_loaded: () => null,
    audit_append: (args) => {
      audit.push(str(args, "entry"));
      return null;
    },
    state_load: (args) => state.get(str(args, "scope")) ?? null,
    state_save: (args) => {
      state.set(str(args, "scope"), str(args, "json"));
      return null;
    },
    settings_paths: (args) => ({
      userSettings: "/config/settings.json",
      userKeybindings: "/config/keybindings.json",
      workspaceSettings: root ? `${root}/${str(args, "folderName")}/settings.json` : null,
      configDir: "/config",
    }),
    settings_watch_start: () => null,
    settings_watch_set_dirs: () => null,
    workspace_open: (args) => {
      const path = str(args, "path");
      if (!isDir(path)) notFound(path);
      root = path;
      return path;
    },
    workspace_close: () => {
      root = null;
      return null;
    },
    workspace_folders: () => (root ? [root] : []),
    fs_read: (args) => bytes(text(str(args, "path"))),
    fs_stat: (args) => {
      const path = str(args, "path");
      const file = files.get(path);
      if (file !== undefined)
        return { kind: "file", size: file.length, mtimeMs: 0, readonly: false };
      if (isDir(path)) return { kind: "dir", size: 0, mtimeMs: 0, readonly: false };
      return notFound(path);
    },
    fs_list_dir: (args) => {
      const dir = str(args, "path");
      if (!isDir(dir)) notFound(dir);
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const entries = new Map<string, "file" | "dir">();
      for (const file of files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const rest = file.slice(prefix.length);
        const slash = rest.indexOf("/");
        entries.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? "file" : "dir");
      }
      return [...entries].map(([name, kind]) => ({
        name,
        path: `${prefix}${name}`,
        kind,
        isSymlink: false,
        ignored: false,
      }));
    },
    // The body is the file's bytes; the path comes in a header, as the desktop sends it.
    fs_write: (body, callOptions) => {
      const headers = (callOptions as { headers?: Record<string, string> } | undefined)?.headers;
      const path = decodeURIComponent(headers?.["x-path"] ?? "");
      files.set(path, new TextDecoder().decode(body as unknown as Uint8Array));
      return null;
    },
  };
  return { files, state, audit, root: () => root, commands };
}
