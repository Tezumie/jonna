// The IDE's own account (Rust: src-tauri/src/accounts, D140). `base` is the accounts server
// (product.json `accountsUrl`, or the `accounts.serverUrl` setting while developing it).
import { Channel, call } from "./invoke";

export interface AccountProfile {
  id: string;
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
  plan?: string | null;
  /** Whether sync is open to this account (D435), and the storage it has. */
  sync?: boolean;
  storageLimit?: number;
  /**
   * Where the sync subscription stands. "lapsed": it ended; `sync` stays true, `storageLimit`
   * is 0, and what is synced can be read until `syncUntil` (ms), then it is deleted.
   */
  syncState?: "on" | "lapsed" | "off" | null;
  syncUntil?: number | null;
  /** Sync is on sale to this account and it doesn't have it: an offer may be shown. */
  syncOffered?: boolean;
  supporter?: boolean;
}

export const accountsIpc = {
  profile: (base: string): Promise<AccountProfile | null> =>
    call<AccountProfile | null>("account_profile", { base }),
  /**
   * The profile as the server has it now (D414): tokens refreshed when they've run out; null
   * when the server ended the session; the saved profile when it can't be reached.
   */
  check: (base: string): Promise<AccountProfile | null> =>
    call<AccountProfile | null>("account_check", { base }),
  /** Opens nothing itself: `onUrl` gets the sign-in page to open in the browser. */
  signIn: (base: string, onUrl: (url: string) => void): Promise<AccountProfile> =>
    call<AccountProfile>("account_sign_in", { base, onUrl: new Channel<string>(onUrl) }),
  cancel: (): Promise<void> => call<void>("account_cancel"),
  signOut: (): Promise<void> => call<void>("account_sign_out"),
  /** An account picture's bytes (cached a day by Rust); `base`: the accounts server, if any. */
  avatar: async (url: string, base: string): Promise<Uint8Array> =>
    new Uint8Array(await call<ArrayBuffer>("account_avatar", { url, base })),
};
