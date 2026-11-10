// The agent's native services: model providers (chat, models, API keys) and app-data storage of
// sessions and checkpoints.
import { type Disposable, toDisposable } from "../lifecycle/index";
import type { WatchBatch } from "./fs";
import { Channel, call } from "./invoke";

// Model providers (Rust: src-tauri/src/ai). Chat streams normalized events over a Channel; API keys
// are set here but never read back.
export type ProviderKind = "ollama" | "openai" | "anthropic";

export interface ProviderRef {
  /** Settings id; also the key under which its API key is stored. */
  id: string;
  kind: ProviderKind;
  baseUrl: string;
}

export interface ModelInfo {
  id: string;
  size: number | null;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  remote: boolean;
  /** Dollars per million tokens, when the provider lists them (OpenRouter, D199). */
  pricing?: {
    input: number;
    output: number;
    cacheRead?: number | null;
    cacheWrite?: number | null;
  } | null;
  /** It answers with images (OpenRouter's output modalities, D381). */
  outputImages?: boolean;
}

export interface ModelDetails {
  tools: boolean | null;
  thinking: boolean | null;
  vision: boolean | null;
  contextLength: number | null;
  /** Most output tokens per request (Anthropic). */
  maxOutputTokens?: number | null;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  images?: string[];
  /** Provider reasoning blocks sent back unchanged (Anthropic thinking with signatures). */
  thinkingBlocks?: unknown[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: unknown;
}

export interface ChatRequest {
  provider: ProviderRef;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  think?: boolean;
  temperature?: number;
  contextLength?: number;
  /** Most tokens to generate (editor completions). */
  maxTokens?: number;
  /** Prompt cache lifetime where the provider takes hints ("5m" | "1h"; Anthropic). */
  cacheTtl?: string;
  /** Reasoning effort (Anthropic: low … max). */
  effort?: string;
  /** How long Ollama keeps the model and its prompt cache loaded ("30m"). */
  keepAlive?: string;
  /** A one-off prompt: don't write it to the provider's cache (writes cost extra). */
  noCache?: boolean;
  /** What the reply may hold: `["image", "text"]` for a model that draws (D381). */
  modalities?: string[];
}

export type ChatEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  /** An image in the reply (D381): base64 `data` of type `mime`, or a link (`url`). */
  | { kind: "image"; mime: string; data: string; url?: string }
  | { kind: "reasoning"; block: unknown }
  | { kind: "toolCall"; id: string; name: string; arguments: unknown }
  | {
      kind: "toolProgress";
      name: string;
      path: string | null;
      chars: number;
      /** The call's id, when the provider gave it. */
      id?: string;
      /** show_widget's arguments so far, as partial JSON (D355). */
      arguments?: string;
    }
  | {
      kind: "done";
      stopReason: string;
      /** All prompt tokens, cached ones included. */
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens?: number | null;
      cacheWriteTokens?: number | null;
      /** The request's cost in dollars as the provider reported it (OpenRouter), D201. */
      cost?: number | null;
    };

/** A rate-limit bucket from a provider's response headers (D201). */
export interface RateLimitBucket {
  name: string;
  limit: number | null;
  remaining: number | null;
  /** As sent: an RFC 3339 time (Anthropic) or a duration such as "6m0s" (OpenAI). */
  reset: string | null;
}

export interface RateLimits {
  observedAt: number;
  buckets: RateLimitBucket[];
  status: number;
}

/** OpenRouter's key credits in dollars (GET /api/v1/key). */
export interface ProviderCredits {
  limit: number | null;
  usage: number | null;
  remaining: number | null;
  usageDaily: number | null;
  usageWeekly: number | null;
  usageMonthly: number | null;
  limitReset: string | null;
  freeTier: boolean | null;
}

export interface ProviderLimits {
  rate: RateLimits | null;
  credits: ProviderCredits | null;
  creditsError: string | null;
}

/** A fill-in-the-middle request (D204): the endpoint shape, the code around the cursor. */
export interface FimRequest {
  provider: ProviderRef;
  style: "ollama" | "openai" | "mistral" | "deepseek";
  model: string;
  prompt: string;
  suffix: string;
  maxTokens: number;
  temperature?: number;
  stop?: string[];
}

export interface FimReply {
  /** False: the provider or model has no FIM (use the chat prompt). */
  supported: boolean;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export const aiIpc = {
  /** One image from a provider's images API (OpenAI's gpt-image / DALL·E, D381). */
  generateImage: (
    requestId: string,
    request: { provider: ProviderRef; model: string; prompt: string; size?: string },
  ): Promise<{ mime: string; data: string }[]> =>
    call<{ mime: string; data: string }[]>("ai_image_generate", { requestId, request }),
  /** Speech to text (D180): base64 audio to the provider's /audio/transcriptions. */
  /** Embeddings for the codebase index (D227): one vector per input, at most 256 inputs. */
  embed: (provider: ProviderRef, model: string, inputs: string[]): Promise<number[][]> =>
    call<number[][]>("ai_embed", { provider, model, inputs }),
  transcribe: (
    provider: ProviderRef,
    model: string,
    audio: string,
    mime: string,
    language?: string,
  ): Promise<string> =>
    call<string>("ai_transcribe", {
      provider,
      model,
      audio,
      mime,
      ...(language && { language }),
    }),
  listModels: (provider: ProviderRef): Promise<ModelInfo[]> =>
    call<ModelInfo[]>("ai_list_models", { provider }),
  modelDetails: (provider: ProviderRef, model: string): Promise<ModelDetails> =>
    call<ModelDetails>("ai_model_details", { provider, model }),
  /**
   * Streams a reply. Resolves after the stream's own "done" event: the command can return before
   * the last channel messages are delivered, and a tool call arriving after that was being lost.
   */
  chat: (requestId: string, request: ChatRequest, onEvent: (e: ChatEvent) => void): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let streamDone = false;
      let callDone = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (!streamDone || !callDone) return;
        clearTimeout(timer);
        resolve();
      };
      const channel = new Channel<ChatEvent>((event) => {
        onEvent(event);
        if (event.kind === "done") {
          streamDone = true;
          finish();
        }
      });
      call<void>("ai_chat", { requestId, request, onEvent: channel }).then(() => {
        callDone = true;
        finish();
        // A cancelled or broken stream may never send "done": don't wait forever.
        timer = setTimeout(resolve, 2000);
      }, reject);
    }),
  /** One fill-in-the-middle completion (D204), cancelled with `cancel(requestId)`. */
  fim: (requestId: string, request: FimRequest): Promise<FimReply> =>
    call<FimReply>("ai_fim", { requestId, request }),
  cancel: (requestId: string): Promise<void> => call<void>("ai_cancel", { requestId }),
  /** The rate limits each provider (by id) last reported in its headers, this run (D201). */
  rateLimits: (): Promise<Record<string, RateLimits>> =>
    call<Record<string, RateLimits>>("ai_rate_limits"),
  /** One provider's limits; OpenRouter's key credits are fetched (network) by Rust with its key. */
  providerLimits: (provider: ProviderRef): Promise<ProviderLimits> =>
    call<ProviderLimits>("ai_provider_limits", { provider }),
  setKey: (id: string, key: string | null): Promise<void> => call<void>("ai_set_key", { id, key }),
  hasKey: (id: string): Promise<boolean> => call<boolean>("ai_has_key", { id }),
  /** One GET of an http(s) page (redirects followed, body capped) for agent context (D130). */
  webFetch: (url: string, maxBytes?: number): Promise<FetchedPage> =>
    call<FetchedPage>("web_fetch", { url, ...(maxBytes !== undefined && { maxBytes }) }),
  /**
   * A web search through `provider` (brave, tavily, exa or searxng, D200). Rust reads the key
   * (`websearch.<provider>` in the secrets file); SearXNG takes its address.
   */
  webSearch: (
    provider: string,
    query: string,
    count: number,
    searxngUrl?: string,
    /** Domains for Tavily and Exa, and Tavily's deeper search (D320). */
    options?: { includeDomains: string[]; excludeDomains: string[]; deep: boolean },
  ): Promise<{ title: string; url: string; snippet: string }[]> =>
    call("web_search", {
      provider,
      query,
      count,
      ...(searxngUrl && { searxngUrl }),
      ...(options && { options }),
    }),
};

export interface FetchedPage {
  /** Where the redirects ended. */
  url: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

// The usage log in app data (Rust: src-tauri/src/agent/usage.rs, D201): JSON lines, 90 days /
// 20 MB, local only. Records are `core/agent/usageLog` UsageRecords.
export const usageIpc = {
  append: (records: unknown[]): Promise<void> => call<void>("usage_append", { records }),
  /** Records with `t >= since` (ms), oldest first. */
  load: (since: number): Promise<unknown[]> => call<unknown[]>("usage_load", { since }),
  clear: (): Promise<number> => call<number>("usage_clear"),
};

/**
 * A chat's private folder in app data, for an external agent with no folder open (D208). Reads
 * and writes reach only files inside `root` (one such folder).
 */
export const scratchIpc = {
  dir: (session: string): Promise<string> => call<string>("agent_scratch_dir", { session }),
  read: (root: string, path: string): Promise<string> =>
    call<string>("agent_scratch_read", { root, path }),
  write: (root: string, path: string, content: string): Promise<void> =>
    call<void>("agent_scratch_write", { root, path, content }),
};

// Agent sessions and checkpoints in app data (Rust: src-tauri/src/agent).
export interface FileSnapshot {
  path: string;
  /** null: the file didn't exist. */
  content: string | null;
}

/** A worktree's changes against the commit it started from (D204). */
export interface WorktreeDiff {
  files: { path: string; added: number | null; removed: number | null }[];
  text: string;
  truncated: boolean;
}

/**
 * Worktree agents' setup and comparison (D204, Rust: src-tauri/src/agent/worktree.rs). Every call
 * checks that `path` is a worktree of the open repository.
 */
export const worktreeAgentIpc = {
  /** Copies untracked files (`.env`…) from the open folder into the worktree. */
  copy: (path: string, files: string[]): Promise<string[]> =>
    call<string[]>("agent_worktree_copy", { path, files }),
  /**
   * Runs the setup script there (the agent's shell) with the worktree's PORT / WORKTREE_* in
   * `env` (D207); cancel with execIpc.cancel(id).
   */
  run: (
    path: string,
    command: string,
    id: string,
    timeoutMs: number,
    onOutput: (chunk: string) => void,
    env?: Record<string, string>,
  ): Promise<{ exitCode: number | null; timedOut: boolean; cancelled: boolean }> =>
    call("agent_worktree_run", {
      path,
      command,
      id,
      timeoutMs,
      env: env ?? null,
      onOutput: new Channel<string>((chunk) => {
        if (chunk !== "\u0000end") onOutput(chunk);
      }),
    }),
  diff: (path: string, base: string, max?: number): Promise<WorktreeDiff> =>
    call<WorktreeDiff>("agent_worktree_diff", { path, base, max: max ?? null }),
  /**
   * Applies the worktree's changes to the open folder (git apply --3way): the files, and those
   * left with conflicts (marked, unmerged in the index: the merge editor resolves them, D207).
   */
  apply: (path: string, base: string): Promise<{ files: string[]; conflicts: string[] }> =>
    call<{ files: string[]; conflicts: string[] }>("agent_worktree_apply", { path, base }),
};

/** Local indexes of documentation sites for @docs (D204), one JSON per source in app data. */
export const docsIndexIpc = {
  save: (name: string, json: string): Promise<void> =>
    call<void>("docs_index_save", { name, json }),
  load: (name: string): Promise<string | null> => call<string | null>("docs_index_load", { name }),
  delete: (name: string): Promise<void> => call<void>("docs_index_delete", { name }),
  /**
   * A page that needs JavaScript, loaded in a hidden window (no cookies shared) and read once it
   * settles (D233): its final address, title and text; null when it didn't answer in time.
   */
  render: (
    url: string,
    timeoutMs?: number,
  ): Promise<{ url: string; title: string; text: string } | null> =>
    call("docs_render", { url, timeoutMs: timeoutMs ?? null }),
};

export const agentStoreIpc = {
  /**
   * Saves a transcript. With `expect` (a version from `version` or an earlier save), only when
   * the file is still at it: else nothing is written and `conflict` is true (another window
   * saved the chat since, D221).
   */
  save: (
    id: string,
    json: string,
    expect?: string | null,
  ): Promise<{ version: string | null; conflict: boolean }> =>
    call("agent_session_save", { id, json, expect: expect ?? null }),
  load: (id: string): Promise<string | null> => call<string | null>("agent_session_load", { id }),
  /** Per chat, a stamp that changes whenever it's saved (size and time), null when not saved (D222). */
  stamps: (ids: string[]): Promise<(string | null)[]> =>
    call<(string | null)[]>("agent_session_stamps", { ids }),
  /** The saved transcript's version (modified time and size), null when there's none (D221). */
  version: (id: string): Promise<string | null> =>
    call<string | null>("agent_session_version", { id }),
  list: (): Promise<{ id: string; meta: unknown }[]> => call("agent_session_list"),
  delete: (id: string): Promise<void> => call<void>("agent_session_delete", { id }),
  /** A chat's image kept whole (D381): base64 in, base64 out (null when it isn't kept). */
  mediaPut: (chat: string, image: string, data: string): Promise<void> =>
    call<void>("agent_media_put", { chat, image, data }),
  mediaGet: (chat: string, image: string): Promise<string | null> =>
    call<string | null>("agent_media_get", { chat, image }),
  checkpointAdd: (session: string, turn: number, files: FileSnapshot[]): Promise<void> =>
    call<void>("agent_checkpoint_add", { session, turn, files }),
  checkpointLoad: (session: string, turn: number): Promise<FileSnapshot[]> =>
    call<FileSnapshot[]>("agent_checkpoint_load", { session, turn }),
  /**
   * Helper reports waiting for a chat that wasn't open where the helper finished (D233), shared
   * by every window: `reportPut` keeps one, `reportList` lists them (no text), `reportClaim` takes
   * one, exactly once across windows (null when another took it).
   */
  reportPut: (id: string, chat: string, text: string): Promise<void> =>
    call<void>("agent_report_put", { id, chat, text }),
  reportList: (): Promise<{ id: string; chat: string; at: number }[]> => call("agent_report_list"),
  reportClaim: (id: string): Promise<string | null> =>
    call<string | null>("agent_report_claim", { id }),
  /**
   * An external agent's folder listed with sizes and times (D233: its changes without git):
   * `.gitignore`d files, dependency and build folders left out, at most `max` files.
   */
  treeStats: (
    root: string,
    max?: number,
  ): Promise<{ files: { path: string; size: number; mtimeMs: number }[]; truncated: boolean }> =>
    call("agent_tree_stats", { root, max: max ?? null }),
  /**
   * Watches the saved chats (D233): `onBatch` gets the paths of chat files saved or removed (by
   * any window). One watcher per window; dispose to stop it.
   */
  watchSessions: async (onBatch: (batch: WatchBatch) => void): Promise<Disposable> => {
    const channel = new Channel<WatchBatch>(onBatch);
    await call<void>("agent_sessions_watch", { onBatch: channel });
    return toDisposable(() => {
      channel.onmessage = () => {};
      void call<void>("agent_sessions_unwatch").catch(() => {});
    });
  },
};

// Files from outside the folder for agent messages (D131): picked with the system dialog or
// dropped onto the window from the OS; Rust keeps the list, the webview reads them one by one.
export interface OutsideFile {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
}

export const attachIpc = {
  /** The system file picker (several files); null if cancelled. Debug builds: `paths`. */
  pick: (paths?: string[]): Promise<OutsideFile[] | null> =>
    call<OutsideFile[] | null>("attach_pick", { paths: paths ?? null }),
  /** The files last dropped from the OS (or picked). */
  dropped: (): Promise<OutsideFile[]> => call<OutsideFile[]>("dropped_list"),
  /** One of them, raw bytes (20 MB at most). */
  read: async (index: number): Promise<Uint8Array> =>
    new Uint8Array(await call<ArrayBuffer>("dropped_read", { index })),
  /**
   * Saves an attachment where the user picks in the system dialog (D211); the path comes from the
   * dialog only (debug builds: `testPath`). The saved path, or null if cancelled.
   */
  saveAs: (name: string, bytes: Uint8Array, testPath?: string): Promise<string | null> =>
    call<string | null>("attachment_save", bytes, {
      headers: {
        "x-name": encodeURIComponent(name),
        ...(testPath && { "x-test-path": encodeURIComponent(testPath) }),
      },
    }),
};

// The user's own agent skills (D206): `~/<dataFolderName>/skills/<name>` folders. They're read
// and written with fsIpc (Rust lets those reach the skills folders); deleting one is its own call.
export const skillsIpc = {
  /** Deletes one of the user's own skills (a folder directly in the user skills folder). */
  deleteUserSkill: (path: string): Promise<void> => call<void>("skills_delete_user", { path }),
  /**
   * Watches the skills folders with what's inside them (D221); `onBatch` gets the changed paths.
   * Dispose to stop listening.
   */
  watch: async (onBatch: (batch: WatchBatch) => void): Promise<Disposable> => {
    const channel = new Channel<WatchBatch>(onBatch);
    await call<void>("skills_watch_start", { onBatch: channel });
    return toDisposable(() => {
      channel.onmessage = () => {};
    });
  },
  /** The skills folders to watch (others are left out by Rust). */
  setWatched: (dirs: string[]): Promise<void> => call<void>("skills_watch_set_dirs", { dirs }),
};

// A monitor's WebSocket (D328, Rust: src-tauri/src/agent/socket.rs): its frames as events.
export type MonitorSocketEvent =
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: number }
  | { kind: "error"; message: string }
  | { kind: "closed"; code: number | null; reason: string };

export const monitorSocketIpc = {
  /** Resolves once the server accepted the upgrade; frames then stream to `onEvent`. */
  open: (
    id: string,
    url: string,
    protocols: readonly string[],
    lifetimeMs: number,
    onEvent: (e: MonitorSocketEvent) => void,
  ): Promise<{ protocol: string | null }> =>
    call<{ protocol: string | null }>("agent_monitor_socket_open", {
      id,
      url,
      protocols,
      lifetimeMs,
      onEvent: new Channel<MonitorSocketEvent>(onEvent),
    }),
  close: (id: string): Promise<void> => call<void>("agent_monitor_socket_close", { id }),
};
