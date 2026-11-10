// The command sandbox for run_command (D336, Claude Code's sandboxed Bash): with agent.sandbox
// "auto" the agent's commands run in the operating system's sandbox where there is one
// (src-tauri/src/exec/sandbox.rs: Windows low integrity, macOS sandbox-exec, Linux bubblewrap),
// after the usual permission check. `sandbox: false` runs one outside and always asks. The policy
// is core/agent/sandbox.ts; tools.ts (run_command, askToRun), processTools.ts and monitors.ts ask
// `sandboxPlanFor`. D348–D350: each command carries what it may not read (agent.sandbox.denyRead)
// and the user's and the project's allowances (core/agent/sandboxPolicy.ts); the network filter's
// refusals come back in its result. Commands: agent.allowSandboxSuggestion (Allow on a
// suggest_sandbox_allowance card), agent.sandboxUnhideSecrets (Windows: the hidden secrets' labels
// back). State: ide://agent/sandbox.

import {
  planSandbox,
  readSandboxSetting,
  type SandboxInfo,
  type SandboxPlan,
  sandboxScope,
} from "../../core/agent/sandbox";
import {
  parseAllowanceSuggestion,
  type SandboxPolicy,
  sandboxPolicy,
  withProjectAllowance,
} from "../../core/agent/sandboxPolicy";
import { execIpc } from "../../core/ipc/process";
import type { DisposableStore } from "../../core/lifecycle/index";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import type { SessionManager } from "./sessions";

let info: SandboxInfo | null = null;
let loading: Promise<SandboxInfo | null> | null = null;

/** What this system's sandbox does; read once. */
export function loadSandboxInfo(): Promise<SandboxInfo | null> {
  loading ??= execIpc.sandboxInfo().then(
    (i) => {
      info = i;
      return i;
    },
    () => null,
  );
  return loading;
}

/** What this system's sandbox does, once known. */
export function sandboxInfo(): SandboxInfo | null {
  return info;
}

/** The policy commands run with now: the settings and the open folder's allowances. */
export function currentSandboxPolicy(services: WorkbenchServices): SandboxPolicy {
  const settings = services.settings;
  return sandboxPolicy({
    denyRead: settings.peek<unknown>("agent.sandbox.denyRead"),
    allowWrite: settings.peek<unknown>("agent.sandbox.allowWrite"),
    allowHosts: settings.peek<unknown>("agent.sandbox.allowHosts"),
    projects: settings.peek<unknown>("agent.sandbox.projects"),
    folder: services.workspace.root.peek(),
  });
}

/** Where a command runs, from agent.sandbox and the model's `sandbox` argument. */
export async function sandboxPlanFor(
  services: WorkbenchServices,
  args: Record<string, unknown>,
): Promise<SandboxPlan> {
  const setting = readSandboxSetting(services.settings.peek<unknown>("agent.sandbox"));
  return planSandbox({
    setting,
    info: setting === "off" ? null : await loadSandboxInfo(),
    requested: args.sandbox,
    remote: false,
    policy: currentSandboxPolicy(services),
  });
}

/** ide://agent/sandbox, the info read early (the first command doesn't wait for it), commands. */
export function registerSandbox(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): void {
  void loadSandboxInfo();
  sub.add(
    services.state.register("ide://agent/sandbox", {
      description:
        "The command sandbox (D336, D348–D350): agent.sandbox (auto: the agent's commands run in the operating system's sandbox where there is one; off), the mechanism here (low-integrity on Windows, sandbox-exec on macOS, bubblewrap on Linux, null: none), whether it limits writes, reads (secrets hidden) and the network (network: blocked, proxy — only tools that use the proxy settings —, open), the policy commands run with (denyRead, allowWrite, allowHosts: the user's and this folder's), and what it does and doesn't protect.",
      get: () => {
        const i = sandboxInfo();
        const policy = currentSandboxPolicy(services);
        return {
          setting: readSandboxSetting(services.settings.peek<unknown>("agent.sandbox")),
          mechanism: i?.mechanism ?? null,
          limitsWrites: i?.limitsWrites ?? false,
          limitsNetwork: i?.limitsNetwork ?? false,
          limitsReads: i?.limitsReads ?? false,
          network: i?.network ?? (i?.limitsNetwork ? "blocked" : "open"),
          policy,
          ...(i?.mechanism && { scope: sandboxScope(i, policy) }),
          note: i?.note ?? "Not known yet.",
        };
      },
    }),
  );
  const register = (c: Parameters<typeof services.dispatcher.register>[0]) =>
    sub.add(services.dispatcher.register(c));

  register({
    id: "agent.allowSandboxSuggestion",
    title: "Allow what the agent's sandbox card suggests",
    category: "Agent",
    description:
      "Allow on a suggest_sandbox_allowance card (D350), as the user's choice: keeps the card's hosts and folders for its project in agent.sandbox.projects (user settings), so the next sandboxed commands there may reach and write them, and marks the card allowed.",
    input: s.object({
      session: s.string().describe("Session id (default: the active session)").optional(),
      item: s
        .string()
        .describe("The suggest_sandbox_allowance call (default: the latest)")
        .optional(),
    }),
    effects: ["write"],
    agent: "hidden",
    palette: false,
    run: async ({ session, item }) => {
      const target = sessions.require(session);
      const it = item
        ? target.items.find((i) => i.id === item)
        : target.items.findLast(
            (i) =>
              i.type === "tool" && i.name === "suggest_sandbox_allowance" && i.status === "done",
          );
      if (it?.type !== "tool" || it.name !== "suggest_sandbox_allowance")
        throw new Error("No suggest_sandbox_allowance card in this chat.");
      const card = parseAllowanceSuggestion(it.detail);
      if (!card) throw new Error("That card has nothing to allow.");
      if (!card.added) {
        const projects = withProjectAllowance(
          services.settings.peek<unknown>("agent.sandbox.projects"),
          card.folder,
          { hosts: card.hosts, folders: card.folders },
        );
        await services.settings.update("agent.sandbox.projects", projects, "user");
        it.detail = JSON.stringify({ ...card, added: true });
        target.bump();
        void target.save();
      }
      return { folder: card.folder, hosts: card.hosts, folders: card.folders };
    },
  });

  register({
    id: "agent.sandboxUnhideSecrets",
    title: "Let sandboxed commands read my secrets again",
    category: "Agent",
    description:
      "Windows (D349): the files and folders the command sandbox hid from sandboxed commands (agent.sandbox.denyRead: a no-read-up label set once on each) get the label they had before; the next sandboxed command hides what's still in the list again, so empty the list (or turn the sandbox off) first. macOS and Linux hide them per command: nothing stays to undo.",
    input: s.object({}),
    effects: ["write"],
    agent: "hidden",
    run: async () => {
      const restored = await execIpc.sandboxUnhide();
      services.notifications.show(
        "info",
        restored.length
          ? `Sandboxed commands can read ${restored.length} hidden ${restored.length === 1 ? "path" : "paths"} again.`
          : "Nothing was hidden.",
      );
      return { restored };
    },
  });
}
