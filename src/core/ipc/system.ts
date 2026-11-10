// The app and the OS: app info, audit log, state store, settings files, window controls, native
// dialogs, clipboard, opening links, and the IDE's own MCP server.

import { LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readImage, readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ask, confirm, message, open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { type Disposable, toDisposable } from "../lifecycle/index";
import type { WatchBatch } from "./fs";
import { Channel, call, isTauri } from "./invoke";

export interface AppInfo {
  dataDir: string;
  configDir: string;
  logsDir: string;
  auditLog: string;
  os: string;
  arch: string;
  /** Wall-clock ms since epoch when the native process started (cold-start measurement). */
  processStartMs: number;
  debugBuild: boolean;
  /** Folder passed on the command line, if any. */
  launchFolder: string | null;
  /** Started by "New window": an empty window unless a folder was given. */
  newWindow?: boolean;
  /** The user's home folder. */
  homeDir: string | null;
  /** `--run-test-script <file>`: path and contents. */
  testScript: { path: string; text: string } | null;
  /** Windows build number (22631…), null elsewhere. */
  osBuild: number | null;
  /** Downloads, Desktop and temp folders (each as found and canonical), D213. */
  userFolders?: { downloads: string[]; desktop: string[]; temp: string[] };
  /**
   * The remote this window works on (D252, "ssh:box"): connect before opening the folder
   * (`launchFolder` is then the remote's path). Null for a local window.
   */
  remote?: string | null;
}

export const appIpc = {
  info: (): Promise<AppInfo> => call<AppInfo>("app_info"),
  /** Test runs: one line on the process's stdout. */
  testLog: (line: string): Promise<void> => call<void>("test_log", { line }),
  /** Test runs: exit with `code`. */
  exit: (code: number): Promise<void> => call<void>("app_exit", { code }),
  /**
   * Starts another IDE window on `folder`; false in test runs (nothing is spawned). `env`: plain
   * variables its commands and terminals inherit (a worktree agent's PORT, D204).
   */
  /** `tag` (a worktree agent's chat, D207): remembered, so windowsAlive can tell it closed. */
  newWindow: (folder?: string, env?: Record<string, string>, tag?: string): Promise<boolean> =>
    call<boolean>("app_new_window", { folder: folder ?? null, env: env ?? null, tag: tag ?? null }),
  /**
   * Starts a window on a remote (D252): `remote` "ssh:box" / "wsl:Ubuntu", `folder` its POSIX
   * path there (none: an empty remote window). False in test runs.
   */
  newRemoteWindow: (folder: string | undefined, remote: string): Promise<boolean> =>
    call<boolean>("app_new_window", { folder: folder ?? null, env: null, tag: null, remote }),
  /** One of the last session's windows, reopened where that folder's window was (D229). */
  restoreWindow: (folder: string): Promise<boolean> =>
    call<boolean>("app_new_window", { folder, env: null, tag: null, restored: true }),
  /**
   * Per tag: true while that window runs, false once closed, null when unknown (D207). A tag this
   * process didn't start (this window restarted) is answered from the window registry by its
   * folder in `folders` (same order): open when a running window has it open (D222).
   */
  windowsAlive: (tags: string[], folders?: string[]): Promise<(boolean | null)[]> =>
    call<(boolean | null)[]>("app_windows_alive", { tags, folders: folders ?? null }),
  /**
   * Windows: reads PATH again from the system (D200), so a tool an installer just added is found
   * without a restart. False when nothing changed (always, elsewhere).
   */
  refreshPath: (): Promise<boolean> => call<boolean>("app_refresh_path"),
};

export const auditIpc = {
  /** Appends one JSON object to `<appData>/logs/audit.jsonl` (rotated at 10 MB, 5 kept). */
  append: (entry: object): Promise<void> =>
    call<void>("audit_append", { entry: JSON.stringify(entry) }),
};

export type StateScope = "global" | "workspace";

/** Persisted JSON state (atomic writes in Rust). Workspace scope requires an open workspace. */
export const storeIpc = {
  load: (scope: StateScope): Promise<string | null> => call<string | null>("state_load", { scope }),
  save: (scope: StateScope, json: string): Promise<void> =>
    call<void>("state_save", { scope, json }),
};

// Settings/keybindings file locations and their watcher (Rust: src-tauri/src/ipc/settings.rs).
// The files are read and written with `fsIpc`, which may reach these user config files too.
export interface SettingsPaths {
  userSettings: string;
  userKeybindings: string;
  /** `<root>/<workspaceFolderName>/settings.json` when a folder is open. */
  workspaceSettings: string | null;
  configDir: string;
  /**
   * A multi-root workspace's other folders' settings files (`<folder>/<workspaceFolderName>/
   * settings.json`), read, written and watched like `workspaceSettings`. Absent with one folder.
   */
  folderSettings?: { folder: string; path: string }[];
}

export const settingsIpc = {
  /** Saves a settings profile where the user picks (debug builds: `path`); null if cancelled. */
  saveProfile: (fileName: string, json: string, path?: string): Promise<string | null> =>
    call<string | null>("profile_save", { fileName, json, path: path ?? null }),
  /** Reads a profile file the user picks (debug builds: `path`): [path, text], or null. */
  openProfile: (path?: string): Promise<[string, string] | null> =>
    call<[string, string] | null>("profile_open", { path: path ?? null }),
  paths: (folderName: string): Promise<SettingsPaths> =>
    call<SettingsPaths>("settings_paths", { folderName }),
  /** Deletes the user's own prompt file (`<config>/commands/*.md`…) or a file in the folder. */
  deleteUserFile: (path: string): Promise<void> => call<void>("user_file_delete", { path }),
  /** settings.json of VS Code, Insiders, Cursor and VSCodium found on this machine. */
  /** VS Code-family editors here, or the User folder at `dir` (D193). */
  editorProfiles: (dir?: string): Promise<EditorProfile[]> =>
    call<EditorProfile[]>("settings_editor_profiles", { dir: dir ?? null }),
  vscodeUser: (): Promise<{ app: string; path: string; text: string }[]> =>
    call<{ app: string; path: string; text: string }[]>("settings_vscode_user"),
  /** Starts the settings watcher; dispose to stop receiving batches. */
  watch: async (onBatch: (batch: WatchBatch) => void): Promise<Disposable> => {
    const channel = new Channel<WatchBatch>(onBatch);
    await call<void>("settings_watch_start", { onBatch: channel });
    return toDisposable(() => {
      channel.onmessage = () => {};
    });
  },
  setDirs: (dirs: string[]): Promise<void> => call<void>("settings_watch_set_dirs", { dirs }),
};

// Window controls for the custom title bar.
const win = () => getCurrentWindow();
/** Full screen began from a maximized window: maximize it again on the way out. */
let fullscreenFromMaximized = false;

export const windowIpc = {
  /** Flashes the taskbar button (bounces the Dock icon) without taking focus (D254). */
  requestAttention: (): Promise<void> =>
    isTauri() ? call<void>("app_request_attention") : Promise.resolve(),
  /** Brings the window to the front with keyboard focus (the OS may refuse a background app). */
  focus: (): Promise<void> => win().setFocus(),
  minimize: (): Promise<void> => win().minimize(),
  toggleMaximize: (): Promise<void> => win().toggleMaximize(),
  isMaximized: (): Promise<boolean> => win().isMaximized(),
  /** Closes without running close-requested handlers (use after the user confirmed). */
  destroy: (): Promise<void> => win().destroy(),
  /** Inner size in logical (CSS) pixels. */
  innerSize: async (): Promise<{ width: number; height: number }> => {
    const size = await win().innerSize();
    const scale = await win().scaleFactor();
    return { width: Math.round(size.width / scale), height: Math.round(size.height / scale) };
  },
  setSize: (width: number, height: number): Promise<void> =>
    win().setSize(new LogicalSize(width, height)),
  unmaximize: (): Promise<void> => win().unmaximize(),
  isFullscreen: (): Promise<boolean> => win().isFullscreen(),
  /** Zooms the whole UI (1 = 100 %). */
  setZoom: (scale: number): Promise<void> => getCurrentWebview().setZoom(scale),
  /**
   * Full screen on or off (D387). A maximized window is restored first and maximized again
   * afterwards: on Windows, going full screen from maximized left the page at its maximized
   * height (a taskbar-high gap at the bottom).
   */
  toggleFullscreen: async (): Promise<boolean> => {
    const w = win();
    const next = !(await w.isFullscreen());
    if (next) {
      fullscreenFromMaximized = await w.isMaximized();
      if (fullscreenFromMaximized) await w.unmaximize();
      await w.setFullscreen(true);
    } else {
      await w.setFullscreen(false);
      if (fullscreenFromMaximized && !(await w.isMaximized())) await w.toggleMaximize();
      fullscreenFromMaximized = false;
    }
    return next;
  },
  /** Calls `handler` whenever the window is resized (maximize/restore included). */
  onResized: async (handler: () => void): Promise<Disposable> =>
    toDisposable(await win().onResized(handler)),
  /**
   * Intercepts OS-initiated closes (Alt+F4, Cmd+Q, dock). `handler` returns true to allow closing.
   */
  onCloseRequested: async (handler: () => Promise<boolean>): Promise<Disposable> => {
    const unlisten = await win().onCloseRequested(async (event) => {
      if (!(await handler())) event.preventDefault();
    });
    return toDisposable(unlisten);
  },
};

// Native dialogs (official tauri-plugin-dialog), behind one typed wrapper.
/**
 * Before a native file dialog (D210): Clone repository opened the folder picker straight from
 * the Enter that confirmed the URL, and on Windows the pointer stayed hidden over the dialog
 * ("hide pointer while typing" hides it in the webview, which then never sees the mouse move
 * that shows it again). So: leave the text field, let the key's events finish, and have the
 * native side show the arrow pointer. Nothing in the page sets a busy cursor or an overlay here.
 */
async function beforeNativeDialog(): Promise<void> {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur();
  // A timer, not a frame: a window in the background may not paint.
  await new Promise<void>((resolve) => setTimeout(resolve, 16));
  if (isTauri()) await call<void>("app_show_cursor").catch(() => {});
}

export const dialogIpc = {
  pickFolder: async (title: string, defaultPath?: string): Promise<string | null> => {
    await beforeNativeDialog();
    const picked = await open({ directory: true, multiple: false, title, defaultPath });
    return typeof picked === "string" ? picked : null;
  },
  /** `filters`: e.g. [{ name: "Extension packages", extensions: ["vsix"] }]. */
  pickFile: async (
    title: string,
    defaultPath?: string,
    filters?: { name: string; extensions: string[] }[],
  ): Promise<string | null> => {
    await beforeNativeDialog();
    const picked = await open({
      directory: false,
      multiple: false,
      title,
      defaultPath,
      ...(filters && { filters }),
    });
    return typeof picked === "string" ? picked : null;
  },
  /** Files or folders (several with `multiple`); null when cancelled (D257: extensions' dialogs). */
  pickPaths: async (options: {
    title?: string;
    defaultPath?: string;
    directory: boolean;
    multiple: boolean;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<string[] | null> => {
    await beforeNativeDialog();
    const picked = await open({
      directory: options.directory,
      multiple: options.multiple,
      ...(options.title && { title: options.title }),
      ...(options.defaultPath && { defaultPath: options.defaultPath }),
      ...(options.filters?.length && { filters: options.filters }),
    });
    if (picked === null) return null;
    return Array.isArray(picked) ? picked : [picked];
  },
  pickSavePath: async (title: string, defaultPath?: string): Promise<string | null> => {
    await beforeNativeDialog();
    return (await save({ title, defaultPath })) ?? null;
  },
  confirm: (text: string, title: string, okLabel = "OK"): Promise<boolean> =>
    confirm(text, { title, kind: "warning", okLabel, cancelLabel: "Cancel" }),
  ask: (text: string, title: string): Promise<boolean> => ask(text, { title, kind: "info" }),
  error: async (text: string, title: string): Promise<void> => {
    await message(text, { title, kind: "error" });
  },
};

// System clipboard through the Tauri clipboard plugin. Works from any code path (menus, async
// commands) — unlike `navigator.clipboard`/`execCommand`, which WebView2 and WebKitGTK only allow
// inside a fresh user gesture and sometimes block with a permission prompt.
export const clipboardIpc = {
  writeText: async (text: string): Promise<void> => {
    if (isTauri()) await writeText(text);
    else await navigator.clipboard.writeText(text);
  },
  readText: async (): Promise<string> => {
    if (isTauri()) return (await readText()) ?? "";
    return navigator.clipboard.readText();
  },
  /** A picture on the clipboard (a screenshot) as PNG bytes, or null when there's none. */
  readImagePng: async (): Promise<Uint8Array | null> => {
    if (!isTauri()) return null;
    try {
      const image = await readImage();
      const { width, height } = await image.size();
      // RGBA bytes (looked up by name: the color checker would read the call as a CSS color).
      const pixels: Uint8Array = await image["rgba" as "rgba"]();
      if (!width || !height || pixels.length < width * height * 4) return null;
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return new Uint8Array(await blob.arrayBuffer());
    } catch {
      return null; // no picture (text, nothing)
    }
  },
};

// Opens web links in the system browser (Tauri opener plugin; http, https and mailto only).
export const openerIpc = {
  /** Shows a file or folder in the OS file manager (Explorer, Finder, …), selected. */
  revealInOs: async (path: string): Promise<void> => {
    if (isTauri()) await revealItemInDir(path);
  },
  openUrl: async (url: string): Promise<void> => {
    if (!/^(https?:|mailto:)/i.test(url)) throw new Error(`Not a web link: ${url}`);
    if (isTauri()) await openUrl(url);
    else window.open(url, "_blank", "noopener");
  },
};

// MCP server (Rust: src-tauri/src/mcp). The server forwards tool calls and resource reads to the
// webview over a Channel; the answers go back with `respond`.
export interface McpInfo {
  url: string;
  port: number;
  /** Per-session bearer token (changes every time the server starts). */
  token: string;
}

export type McpRequest =
  | { kind: "call"; id: number; client: string; command: string; input: unknown }
  | { kind: "read"; id: number; client: string; uri: string }
  /** The caller of request `id` went away (Claude Code disconnected, D223): drop what it waits for. */
  | { kind: "cancel"; id: number };

/** How an agent that takes only stdio MCP servers reaches the IDE's (D223). */
export interface McpStdioProxy {
  /** The IDE's own executable. */
  command: string;
  /** Its proxy flag; the server's address follows it. */
  flag: string;
  /** The environment variable that carries the token (never the command line). */
  tokenEnv: string;
}

export interface McpToolSpec {
  command: string;
  title: string;
  description: string;
  inputSchema: unknown;
  core: boolean;
  readOnly: boolean;
}

/** One editor's profile for "Import from VS Code" (D193). */
export interface EditorProfile {
  app: string;
  dir: string;
  settings: string | null;
  keybindings: string | null;
  mcp: string | null;
  snippets: [string, string][];
  extensions: string[];
}

export interface McpRemoteReply {
  status: number;
  sessionId: string | null;
  messages: string[];
}

/** The agent's MCP client side (D193): remote servers and other tools' server lists. */
export const mcpClientIpc = {
  /** POSTs one JSON-RPC message to a remote server (Streamable HTTP). */
  /** `server`: whose stored inputs its headers may use (and no other's). */
  /**
   * `onMessage` gets the server's own requests and notifications from the reply stream as they
   * arrive (an elicitation the server waits on before it answers, D200).
   */
  post: (
    server: string,
    url: string,
    headers: Record<string, string>,
    sessionId: string | null,
    body: string,
    onMessage: (message: string) => void = () => {},
  ): Promise<McpRemoteReply> =>
    call<McpRemoteReply>("mcp_remote_post", {
      server,
      url,
      headers,
      sessionId,
      body,
      onMessage: new Channel<string>(onMessage),
    }),
  /** [source, text] of the MCP configs other tools keep (Claude Desktop, Cursor, VS Code…). */
  discover: (): Promise<[string, string][]> => call<[string, string][]>("mcp_discover"),
  /** OAuth (D204): whether the agent is signed in to a remote server (never the tokens). */
  oauthStatus: (server: string, url: string): Promise<McpSignInStatus> =>
    call<McpSignInStatus>("mcp_oauth_status", { server, url }),
  /** Discovery, registration and PKCE; open `authorizeUrl`, then `oauthFinish`. */
  oauthBegin: (
    server: string,
    url: string,
    clientName: string,
    clientId?: string,
  ): Promise<{ flow: string; authorizeUrl: string }> =>
    call("mcp_oauth_begin", { server, url, clientName, clientId: clientId ?? null }),
  /** Waits for the browser's redirect and stores the tokens. `visit`: UI tests only. */
  oauthFinish: (flow: string, visit = false): Promise<McpSignInStatus> =>
    call<McpSignInStatus>("mcp_oauth_finish", { flow, visit }),
  oauthSignOut: (server: string): Promise<void> => call<void>("mcp_oauth_sign_out", { server }),
  /**
   * Opens a remote server's standing GET stream (D207): its notifications and requests while no
   * POST is open. `id` names it (a new one under the same id replaces it).
   */
  listen: (
    id: string,
    server: string,
    url: string,
    headers: Record<string, string>,
    sessionId: string | null,
    onEvent: (event: McpStreamEvent) => void,
  ): Promise<void> =>
    call<void>("mcp_remote_listen", {
      id,
      server,
      url,
      headers,
      sessionId,
      onEvent: new Channel<McpStreamEvent>(onEvent),
    }),
  unlisten: (id: string): Promise<boolean> => call<boolean>("mcp_remote_unlisten", { id }),
};

/** What a remote server's GET stream reports (Rust: src-tauri/src/mcp/stream.rs). */
export type McpStreamEvent =
  | { kind: "message"; text: string }
  | { kind: "state"; state: "open" | "retrying" | "unsupported" | "closed"; detail?: string };

export interface McpSignInStatus {
  signedIn: boolean;
  /** Seconds since the epoch. */
  expiresAt: number | null;
  canRefresh: boolean;
  scope: string | null;
}

/** Claude Code's IDE integration (D204, Rust: src-tauri/src/mcp/ide_ws.rs). */
export interface IdeIntegrationInfo {
  port: number;
  lockFile: string;
  connected: number;
}

export const ideIntegrationIpc = {
  start: (
    onRequest: (request: McpRequest) => void,
    folders: string[],
    ideName: string,
  ): Promise<IdeIntegrationInfo> =>
    call<IdeIntegrationInfo>("ide_integration_start", {
      onRequest: new Channel<McpRequest>(onRequest),
      folders,
      ideName,
    }),
  update: (folders: string[]): Promise<void> => call<void>("ide_integration_update", { folders }),
  stop: (): Promise<void> => call<void>("ide_integration_stop"),
  info: (): Promise<IdeIntegrationInfo | null> =>
    call<IdeIntegrationInfo | null>("ide_integration_info"),
  notify: (method: "selection_changed" | "at_mentioned", params: unknown): Promise<number> =>
    call<number>("ide_integration_notify", { method, params }),
  respond: (id: number, result: unknown, error?: string): Promise<void> =>
    call<void>("ide_integration_respond", {
      id,
      result: error ? null : (result ?? null),
      error: error ?? null,
    }),
};

export const mcpIpc = {
  start: (onRequest: (request: McpRequest) => void): Promise<McpInfo> =>
    call<McpInfo>("mcp_start", { onRequest: new Channel<McpRequest>(onRequest) }),
  stop: (): Promise<void> => call<void>("mcp_stop"),
  info: (): Promise<McpInfo | null> => call<McpInfo | null>("mcp_info"),
  stdioProxy: (): Promise<McpStdioProxy> => call<McpStdioProxy>("mcp_stdio_proxy"),
  setCatalog: (
    tools: McpToolSpec[],
    resources: { uri: string; description: string }[],
  ): Promise<void> => call<void>("mcp_set_catalog", { tools, resources }),
  respond: (id: number, result: unknown, error?: string): Promise<void> =>
    call<void>("mcp_respond", {
      id,
      result: error ? null : (result ?? null),
      error: error ?? null,
    }),
};

// Updates (D192, Rust: src-tauri/src/update): only in builds made with an update endpoint.
export interface UpdateInfo {
  configured: boolean;
  current: string;
  available: string | null;
  notes: string | null;
  date: string | null;
  /** The channel checked (D204): "beta" only when asked for and the build has a beta endpoint. */
  channel: "stable" | "beta";
  betaAvailable: boolean;
}

export type UpdateChannel = "stable" | "beta";

export type UpdateProgress =
  | { kind: "started"; total: number | null }
  | { kind: "progress"; downloaded: number }
  | { kind: "installing" };

export const updateIpc = {
  check: (channel: UpdateChannel = "stable"): Promise<UpdateInfo> =>
    call<UpdateInfo>("update_check", { channel }),
  /** Downloads, verifies and installs, then the app restarts (it doesn't return on success). */
  install: (channel: UpdateChannel, onProgress: (p: UpdateProgress) => void): Promise<void> =>
    call<void>("update_install", {
      channel,
      onProgress: new Channel<UpdateProgress>(onProgress),
    }),
};

// WSL folders (D192, Rust: src-tauri/src/wsl.rs). Windows only; empty elsewhere.
export const wslIpc = {
  distros: (): Promise<{ name: string }[]> =>
    isTauri() ? call<{ name: string }[]>("wsl_distros") : Promise.resolve([]),
  /** The distribution's home folder as a Windows path (\\wsl.localhost\<distro>\home\me). */
  home: (distro: string): Promise<string> => call<string>("wsl_home", { distro }),
};
