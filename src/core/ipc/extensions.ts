// Third-party extensions on disk (Rust: src-tauri/src/extensions, D102).
import type { ProxyInfo } from "./browser";
import { Channel, call } from "./invoke";

export interface ExtEntry {
  /** The folder holding the manifest. */
  root: string;
  /** "extension.json", or "package.json" for a VS Code extension. */
  manifestFile: string;
  manifest: string;
  /** Loaded with "Load unpacked" (development). */
  dev: boolean;
  /** Newest file modification time (ms): unpacked extensions reload when it changes. */
  mtimeMs: number;
  /** A VS Code package's package.nls.json text (D256). */
  nls?: string;
}

export interface FetchResult {
  status: number;
  headers: [string, string][];
  body: string;
}

export const extIpc = {
  list: (): Promise<{ entries: ExtEntry[]; registry: string }> => call("ext_list"),
  peek: (folder: string): Promise<ExtEntry> => call("ext_peek", { folder }),
  saveRegistry: (json: string): Promise<void> => call("ext_registry_save", { json }),
  read: async (root: string, path: string): Promise<Uint8Array> =>
    new Uint8Array(await call<ArrayBuffer>("ext_read", { root, path })),
  readText: async (root: string, path: string): Promise<string> =>
    new TextDecoder().decode(await extIpc.read(root, path)),
  files: (root: string): Promise<{ path: string; size: number }[]> => call("ext_files", { root }),
  install: (source: string, id: string): Promise<string> => call("ext_install", { source, id }),
  uninstall: (id: string): Promise<void> => call("ext_uninstall", { id }),
  /** Bundled extensions the user uninstalled, back (disabled); their ids (D183). */
  restoreBundled: (): Promise<string[]> => call("ext_restore_bundled"),
  /** One bundled extension's own files, back in place of the user's changed copy (D189). */
  reinstallBundled: (id: string): Promise<void> => call("ext_reinstall_bundled", { id }),
  /** A git repository's files in a scratch folder (shallow, no history, D185); its path. */
  downloadGit: (
    url: string,
    reference?: string,
  ): Promise<{ folder: string; extensions: string[] }> =>
    call("ext_download_git", { url, reference: reference ?? null }),
  /** A .vsix file unpacked into a scratch folder (discard it with `discardDownload`). */
  unpackVsix: (file: string): Promise<{ folder: string; extensions: string[] }> =>
    call("ext_unpack_vsix", { file }),
  discardDownload: (folder: string): Promise<void> => call("ext_discard_download", { folder }),
  /** Writes the Node extension host's script to the data folder (D255); its path. */
  nodeHostScript: (text: string): Promise<string> => call("ext_node_host_script", { text }),
  /** Open VSX's search (D254): its JSON (parse with core/extensions/openVsx). */
  storeSearch: (
    query: string,
    opts: { category?: string; offset?: number; size?: number; sortBy?: string } = {},
  ): Promise<string> =>
    call("ext_store_search", {
      query,
      category: opts.category ?? null,
      offset: opts.offset ?? null,
      size: opts.size ?? null,
      sortBy: opts.sortBy ?? null,
    }),
  /** An extension's details on Open VSX (the latest version without `version`): its JSON. */
  storeDetails: (namespace: string, name: string, version?: string): Promise<string> =>
    call("ext_store_details", { namespace, name, version: version ?? null }),
  /**
   * A file of an extension on Open VSX (its `files` addresses only): an icon (512 KB), a
   * README's image (5 MB) as bytes.
   */
  storeImage: async (url: string, kind: "icon" | "image"): Promise<Uint8Array> =>
    new Uint8Array(await call<ArrayBuffer>("ext_store_file", { url, kind })),
  /** Its README, changelog or package.json as text (2 MB). */
  storeText: async (url: string): Promise<string> =>
    new TextDecoder().decode(await call<ArrayBuffer>("ext_store_file", { url, kind: "text" })),
  /** Downloads a `.vsix` from Open VSX, checked against its SHA-256 (discardDownload after). */
  storeDownload: (
    namespace: string,
    name: string,
    version?: string,
  ): Promise<{ file: string; version: string }> =>
    call("ext_store_download", { namespace, name, version: version ?? null }),
  /** A GitHub user's picture (cached a week by the backend), as bytes. */
  githubAvatar: async (login: string): Promise<Uint8Array> =>
    new Uint8Array(await call<ArrayBuffer>("ext_github_avatar", { login })),
  deleteUnpacked: (root: string): Promise<void> => call("ext_delete_unpacked", { root }),
  storageLoad: (id: string): Promise<string> => call("ext_storage_load", { id }),
  storageSave: (id: string, json: string): Promise<void> => call("ext_storage_save", { id, json }),
  /** Extension `id`'s own secret (keychain; D233), null when none. */
  secretGet: (id: string, key: string): Promise<string | null> =>
    call("ext_secret_get", { id, key }),
  /** Stores (null: removes) extension `id`'s own secret. */
  secretSet: (id: string, key: string, value: string | null): Promise<void> =>
    call("ext_secret_set", { id, key, value }),
  fetch: (request: {
    url: string;
    method?: string;
    headers?: [string, string][];
    body?: string;
  }): Promise<FetchResult> => call("ext_fetch", { request }),
  /** The pinned Node.js for extensions' code (D267): the downloaded program, if any. */
  nodeStatus: (): Promise<{ version: string; path: string | null; available: boolean }> =>
    call("ext_node_status"),
  /** Downloads the pinned Node.js from nodejs.org, checked against its SHA-256; its path. */
  nodeInstall: (
    onProgress: (p: { phase: string; received: number; total: number | null }) => void,
  ): Promise<string> =>
    call("ext_node_install", {
      onProgress: new Channel<{ phase: string; received: number; total: number | null }>(
        onProgress,
      ),
    }),
  /** `embed`: its pages may frame https sites (granted `web.embed`, D187). */
  webviewProxy: (root: string, embed = false): Promise<ProxyInfo> =>
    call("ext_webview_proxy", { root, embed }),
  /**
   * A run-time webview panel's HTML, served on the folder's origin at `/__webview-<name>.html`
   * (null removes it).
   */
  webviewPage: (root: string, name: string, html: string | null): Promise<void> =>
    call("ext_webview_page", { root, name, html }),
  /**
   * Folders the extension's pages may read files from besides its own (VS Code's
   * localResourceRoots), at `/__fs/<absolute path>`: only those inside the open workspace (or the
   * extension's folder) are kept; replaces its list and returns what was kept.
   */
  webviewRoots: (root: string, roots: string[]): Promise<string[]> =>
    call("ext_webview_roots", { root, roots }),
};
