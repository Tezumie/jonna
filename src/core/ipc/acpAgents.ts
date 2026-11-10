// The ACP agent registry's native side (D215, Rust: src-tauri/src/acp_agents): the registry file
// and icons fetched (and cached) there, binary agents downloaded, checked and unpacked into the
// app data folder with progress over a Channel, cancelled and removed.
import { Channel, call } from "./invoke";

export interface AgentInstallProgress {
  phase: "download" | "verify" | "unpack" | "done";
  received: number;
  total: number | null;
}

export interface AgentInstallRequest {
  id: string;
  version: string;
  archive: string;
  sha256?: string;
  cmd: string;
}

export interface AgentInstalled {
  /** The agent's program, an absolute path. */
  command: string;
  dir: string;
  /** Matched the registry's SHA-256 (false: it gave none). */
  verified: boolean;
  bytes: number;
}

export const acpAgentsIpc = {
  /** This machine in the registry's terms (`windows-x86_64`…); null on others. */
  platform: (): Promise<string | null> => call<string | null>("acp_registry_platform"),
  /** The registry file's text, fetched now and cached; `url` only in test builds. */
  fetchRegistry: (url?: string): Promise<string> =>
    call<string>("acp_registry_fetch", { url: url ?? null }),
  cachedRegistry: (): Promise<string | null> => call<string | null>("acp_registry_cached"),
  icon: (id: string, url: string): Promise<string | null> =>
    call<string | null>("acp_registry_icon", { id, url }),
  install: (
    request: AgentInstallRequest,
    onProgress: (p: AgentInstallProgress) => void,
  ): Promise<AgentInstalled> =>
    call<AgentInstalled>("acp_agent_install", {
      request: { ...request, sha256: request.sha256 ?? null },
      onProgress: new Channel<AgentInstallProgress>(onProgress),
    }),
  cancel: (id: string): Promise<boolean> => call<boolean>("acp_agent_cancel", { id }),
  remove: (id: string): Promise<boolean> => call<boolean>("acp_agent_remove", { id }),
  onDisk: (): Promise<{ id: string; versions: string[] }[]> =>
    call<{ id: string; versions: string[] }[]>("acp_agents_on_disk"),
};
