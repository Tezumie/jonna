// The agent's live objects for whoever hosts it without the window: a terminal front end or a
// server reads a chat's signals and subscribes to its events (sessionEvents.ts) through these.
// Everything a person does still goes through the dispatcher's commands; this is for observing,
// and for what a host sets up once (a chat's model for one run). Set by the agent's activation
// (core.ts). DOM-free.
import type { WorkbenchServices } from "../../workbench/services";
import type { ProviderRegistry } from "./providers";
import type { SessionManager } from "./sessions";

export interface AgentRuntime {
  readonly sessions: SessionManager;
  readonly providers: ProviderRegistry;
}

const runtimes = new WeakMap<WorkbenchServices, AgentRuntime>();

/** The agent's live objects for these services; undefined until the agent has activated. */
export function agentRuntime(services: WorkbenchServices): AgentRuntime | undefined {
  return runtimes.get(services);
}

/** Set by the agent's activation; null when it ends. */
export function setAgentRuntime(services: WorkbenchServices, runtime: AgentRuntime | null): void {
  if (runtime) runtimes.set(services, runtime);
  else runtimes.delete(services);
}
