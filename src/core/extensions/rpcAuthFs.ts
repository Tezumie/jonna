// The worker side of `ide.authentication`, `ide.secrets` and file system providers (D233).
// An authentication provider signs the user in to a service (VS Code's AuthenticationProvider);
// any extension asks for a session with `getSession`, and the IDE asks the user before giving one
// extension another's. Secrets are the extension's own, kept in the OS keychain the IDE uses for
// its keys. A file system provider serves a URI scheme ("memfs:/a.txt") to the editor and the
// explorer; bytes cross as base64. The host calls back through "provider" calls. DOM-free,
// unit-tested.
import type { Disposable } from "./rpc";
import type { OnCall, Request } from "./rpcTerminals";

type Answer<T> = T | null | undefined | Promise<T | null | undefined>;

/** VS Code's AuthenticationSession. */
export interface AuthenticationSession {
  id: string;
  accessToken: string;
  account: { id: string; label: string };
  scopes: string[];
}

export interface AuthenticationProvider {
  /**
   * The signed-in sessions (those with every scope in `scopes`, when given). Without it, the IDE
   * keeps the sessions `createSession` returns in the keychain itself.
   */
  getSessions?(scopes?: string[]): Answer<AuthenticationSession[]>;
  /** Signs in (open a page, ask for a token…); throw when the user cancels. */
  createSession(scopes: string[]): AuthenticationSession | Promise<AuthenticationSession>;
  removeSession?(sessionId: string): void | Promise<void>;
}

export interface GetSessionOptions {
  /** Sign in when there's no session (the user is asked first). */
  createIfNone?: boolean;
  /** Sign in again even when there's a session. */
  forceNewSession?: boolean;
  /** Never ask the user: no session unless one was already allowed. */
  silent?: boolean;
}

export interface AuthenticationApi {
  registerAuthenticationProvider(
    id: string,
    label: string,
    provider: AuthenticationProvider,
    options?: { supportsMultipleAccounts?: boolean },
  ): Disposable & { fireDidChangeSessions(): void };
  /** A session of provider `providerId` (another extension's: only once the user allows it). */
  getSession(
    providerId: string,
    scopes: string[],
    options?: GetSessionOptions,
  ): Promise<AuthenticationSession | undefined>;
  onDidChangeSessions(listener: (event: { providerId: string }) => void): Disposable;
}

/** The extension's own secrets (VS Code's SecretStorage), in the OS keychain. */
export interface SecretsApi {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type FileType = "file" | "directory";

export interface FileStatInfo {
  type: FileType;
  size?: number;
  /** Milliseconds since the epoch. */
  mtime?: number;
  readonly?: boolean;
}

export interface FileChange {
  /** A URI of the provider's scheme. */
  path: string;
  kind: "created" | "changed" | "deleted";
}

/** VS Code's FileSystemProvider; every path is a URI of its scheme ("memfs:/a/b.txt"). */
export interface FileSystemProvider {
  stat(path: string): FileStatInfo | Promise<FileStatInfo>;
  readDirectory(path: string): [string, FileType][] | Promise<[string, FileType][]>;
  /** Text (UTF-8) or bytes. */
  readFile(path: string): string | Uint8Array | Promise<string | Uint8Array>;
  writeFile?(
    path: string,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): void | Promise<void>;
  createDirectory?(path: string): void | Promise<void>;
  delete?(path: string, options: { recursive: boolean }): void | Promise<void>;
  rename?(from: string, to: string, options: { overwrite: boolean }): void | Promise<void>;
  /** Called once; report changes with `fireDidChange`. */
  watch?(path: string, options: { recursive: boolean }): Disposable | undefined;
}

export interface FileSystemsApi {
  registerFileSystemProvider(
    scheme: string,
    provider: FileSystemProvider,
    options?: { label?: string; isReadonly?: boolean },
  ): Disposable & { fireDidChange(changes: FileChange[]): void };
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Bytes as base64 (no btoa: it isn't in every worker, nor in tests' runtime the same way). */
export function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let n = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const v = [0, 1, 2, 3].map((k) => B64.indexOf(clean[i + k] ?? "A"));
    const [a = 0, b = 0, c = 0, d = 0] = v;
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (n < out.length) out[n++] = (triple >> 16) & 255;
    if (i + 2 < clean.length && n < out.length) out[n++] = (triple >> 8) & 255;
    if (i + 3 < clean.length && n < out.length) out[n++] = triple & 255;
  }
  return out.subarray(0, n);
}

export function createAuthFsApis(
  request: Request,
  on: OnCall,
): { authentication: AuthenticationApi; secrets: SecretsApi; fileSystems: FileSystemsApi } {
  const changeListeners = new Set<(event: { providerId: string }) => void>();
  let listening = false;
  on("auth.didChange", (args: { providerId?: unknown }) => {
    const event = { providerId: String(args?.providerId ?? "") };
    for (const l of [...changeListeners]) l(event);
    return null;
  });

  const authentication: AuthenticationApi = {
    registerAuthenticationProvider(id, label, provider, options = {}) {
      const key = `auth.${String(id)}`;
      const offs = [
        on(`${key}.getSessions`, async (args: { scopes?: unknown }) => {
          if (typeof provider.getSessions !== "function") return null;
          const scopes = Array.isArray(args?.scopes) ? args.scopes.map(String) : undefined;
          const list = await provider.getSessions(scopes);
          return Array.isArray(list) ? list : [];
        }),
        on(`${key}.createSession`, async (args: { scopes?: unknown }) =>
          provider.createSession(Array.isArray(args?.scopes) ? args.scopes.map(String) : []),
        ),
        on(`${key}.removeSession`, async (args: { sessionId?: unknown }) => {
          await provider.removeSession?.(String(args?.sessionId ?? ""));
          return null;
        }),
      ];
      const forget = () => {
        for (const off of offs) off();
      };
      void request("auth.register", {
        id: String(id),
        label: String(label ?? id),
        supportsMultipleAccounts: options?.supportsMultipleAccounts === true,
        storesSessions: typeof provider?.getSessions !== "function",
      }).catch((err: unknown) => {
        forget();
        console.error(err instanceof Error ? err.message : String(err));
      });
      return {
        fireDidChangeSessions: () =>
          void request("auth.changed", { id: String(id) }).catch(() => {}),
        dispose: () => {
          forget();
          void request("auth.unregister", { id: String(id) }).catch(() => {});
        },
      };
    },
    getSession: (providerId, scopes, options = {}) =>
      request<AuthenticationSession | null>("auth.getSession", {
        providerId: String(providerId),
        scopes: Array.isArray(scopes) ? scopes.map(String) : [],
        createIfNone: options.createIfNone === true,
        forceNewSession: options.forceNewSession === true,
        silent: options.silent === true,
      }).then((s) => s ?? undefined),
    onDidChangeSessions(listener) {
      changeListeners.add(listener);
      if (!listening) {
        listening = true;
        void request("auth.listen").catch(() => {
          listening = false;
        });
      }
      return { dispose: () => changeListeners.delete(listener) };
    },
  };

  const secrets: SecretsApi = {
    get: (key) =>
      request<string | null>("secrets.get", { key: String(key) }).then((v) => v ?? undefined),
    store: (key, value) => request("secrets.store", { key: String(key), value: String(value) }),
    delete: (key) => request("secrets.delete", { key: String(key) }),
  };

  let fsSeq = 0;
  const fileSystems: FileSystemsApi = {
    registerFileSystemProvider(scheme, provider, options = {}) {
      const id = `fs${++fsSeq}`;
      const path = (args: { path?: unknown }) => String(args?.path ?? "");
      const need = <K extends keyof FileSystemProvider>(name: K) => {
        const fn = provider[name];
        if (typeof fn !== "function") throw new Error(`The file system can't ${String(name)}.`);
        return fn.bind(provider) as NonNullable<FileSystemProvider[K]>;
      };
      let watcher: Disposable | undefined;
      const offs = [
        on(`${id}.stat`, async (args: { path?: unknown }) => {
          const s = await provider.stat(path(args));
          return {
            type: s?.type === "directory" ? "directory" : "file",
            size: typeof s?.size === "number" ? s.size : 0,
            mtime: typeof s?.mtime === "number" ? s.mtime : 0,
            readonly: s?.readonly === true,
          };
        }),
        on(`${id}.readDirectory`, async (args: { path?: unknown }) => {
          const list = await provider.readDirectory(path(args));
          return (Array.isArray(list) ? list : []).map((e) =>
            Array.isArray(e) ? [String(e[0]), e[1] === "directory" ? "directory" : "file"] : e,
          );
        }),
        on(`${id}.readFile`, async (args: { path?: unknown }) => {
          const content = await provider.readFile(path(args));
          const bytes =
            typeof content === "string"
              ? new TextEncoder().encode(content)
              : (content ?? new Uint8Array());
          return toBase64(bytes);
        }),
        on(
          `${id}.writeFile`,
          async (args: {
            path?: unknown;
            data?: unknown;
            create?: unknown;
            overwrite?: unknown;
          }) => {
            await need("writeFile")(path(args), fromBase64(String(args?.data ?? "")), {
              create: args?.create !== false,
              overwrite: args?.overwrite !== false,
            });
            return null;
          },
        ),
        on(`${id}.createDirectory`, async (args: { path?: unknown }) => {
          await need("createDirectory")(path(args));
          return null;
        }),
        on(`${id}.delete`, async (args: { path?: unknown; recursive?: unknown }) => {
          await need("delete")(path(args), { recursive: args?.recursive === true });
          return null;
        }),
        on(`${id}.rename`, async (args: { from?: unknown; to?: unknown; overwrite?: unknown }) => {
          await need("rename")(String(args?.from ?? ""), String(args?.to ?? ""), {
            overwrite: args?.overwrite === true,
          });
          return null;
        }),
      ];
      const forget = () => {
        for (const off of offs) off();
        watcher?.dispose();
        watcher = undefined;
      };
      const name = String(scheme ?? "").toLowerCase();
      void request("fs.registerProvider", {
        id,
        scheme: name,
        label: String(options?.label ?? name),
        readonly: options?.isReadonly === true || typeof provider?.writeFile !== "function",
      }).then(
        () => {
          // Watched from the root once registered (the explorer's section shows all of it).
          if (typeof provider.watch === "function")
            watcher = provider.watch(`${name}:/`, { recursive: true }) ?? undefined;
        },
        (err: unknown) => {
          forget();
          console.error(err instanceof Error ? err.message : String(err));
        },
      );
      return {
        fireDidChange: (changes) =>
          void request("fs.changed", {
            id,
            changes: (Array.isArray(changes) ? changes : []).slice(0, 1000).map((c) => ({
              path: String(c?.path ?? ""),
              kind: c?.kind === "created" || c?.kind === "deleted" ? c.kind : "changed",
            })),
          }).catch(() => {}),
        dispose: () => {
          forget();
          void request("fs.unregisterProvider", { id }).catch(() => {});
        },
      };
    },
  };

  return { authentication, secrets, fileSystems };
}
