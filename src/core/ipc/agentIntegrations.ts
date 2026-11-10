// The agent's integrations with the world outside its window (Rust: ipc/plugins.rs,
// ipc/notify.rs, ipc/agent_windows.rs): Claude Code plugins (D358), chats in the IDE's other
// windows (D359) and notifications to the user's phone (D360).
import { call } from "./invoke";

export const pluginsIpc = {
  /** Writes the record of marketplaces and installed plugins (`<plugins>/plugins.json`). */
  saveRecord: (text: string): Promise<void> => call<void>("plugins_save_record", { text }),
  /** Copies the folder `source` (its folder `sub`) to `dest` in the plugins folder, replacing it. */
  copy: (source: string, dest: string, sub?: string): Promise<string> =>
    call<string>("plugins_copy", { source, sub: sub ?? null, dest }),
  /** Clones `url` (shallow, at `ref`) and puts it (its folder `sub`) at `dest`, replacing it. */
  clone: (url: string, dest: string, ref?: string, sub?: string): Promise<string> =>
    call<string>("plugins_clone", { url, gitRef: ref ?? null, sub: sub ?? null, dest }),
  /**
   * Claude Code's plugins folder (`CLAUDE_CONFIG_DIR` or `~/.claude`, then `plugins`) and its
   * `enabledPlugins` (only that of its settings), D375.
   */
  claudeInfo: (): Promise<{ dir: string | null; enabled: Record<string, unknown> | null }> =>
    call<{ dir: string | null; enabled: Record<string, unknown> | null }>("plugins_claude_info"),
  /** Fetches an npm package (`npm pack`, no scripts) to `dest` in the plugins folder (D375). */
  npm: (spec: string, dest: string, registry?: string): Promise<string> =>
    call<string>("plugins_npm", { spec, registry: registry ?? null, dest }),
  /** Removes a marketplace's or a plugin's folder (inside the plugins folder only). */
  remove: (path: string): Promise<void> => call<void>("plugins_remove", { path }),
};

export const notifyIpc = {
  /**
   * Posts a notification to the webhook: `url`, or (null) the one in the secrets file. Resolves
   * with the HTTP status; rejects with why it failed.
   */
  post: (
    url: string | null,
    body: string,
    contentType: string,
    headers: Record<string, string>,
  ): Promise<number> =>
    call<number>("notify_webhook_post", {
      url,
      body,
      contentType,
      headers: Object.entries(headers),
    }),
  /** Keeps a secret webhook URL in the secrets file (null removes it). */
  store: (url: string | null): Promise<void> => call<void>("notify_webhook_store", { url }),
};

export const windowChatsIpc = {
  /** Publishes this window's chats (`{ folder, chats }` as JSON) for the other windows. */
  publish: (json: string): Promise<void> => call<void>("agent_windows_publish", { json }),
  unpublish: (): Promise<void> => call<void>("agent_windows_unpublish"),
  /** This window's pid and the other live windows' records (JSON texts). */
  list: (): Promise<[number, string[]]> => call<[number, string[]]>("agent_windows_list"),
  /** Leaves a mail (`text`) for chat `chat`. */
  mailPut: (id: string, chat: string, text: string): Promise<void> =>
    call<void>("agent_mail_put", { id, chat, text }),
  mailList: (): Promise<{ id: string; chat: string; at: number }[]> => call("agent_mail_list"),
  /** Takes a mail: its text, or null when another window took it first. */
  mailClaim: (id: string): Promise<string | null> =>
    call<string | null>("agent_mail_claim", { id }),
};
