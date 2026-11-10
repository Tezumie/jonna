// One prompt to an external agent (D207): Claude Code, Codex, Gemini CLI or GitHub Copilot write
// a commit message or tidy memory for the user who picked one of them for that feature. The
// agent starts over ACP in the folder, gets one message, and its answer's text is returned; it
// may not read or write files, run commands or ask for anything (every request is refused), and
// it's stopped afterwards. Slower than a model API (the agent starts each time), so only the
// features that aren't typed against (commit messages, memory) offer it.
import { AcpClient, type AcpHost } from "../../core/acp/client";
import type { UsageSource } from "../../core/agent/usageLog";
import { scratchIpc } from "../../core/ipc/agent";
import { startStdioProcess } from "../../core/ipc/process";
import { product } from "../../core/product";
import type { WorkbenchServices } from "../../workbench/services";
import { expandArgs } from "../lsp/servers";
import { type ExternalAgentConfig, externalAgents } from "./acpAgents";
import { newId } from "./ids";
import { recordAgentUsage } from "./usageLog";

/** Features an external agent may answer for (not the ones typed against). */
export const AGENT_FEATURES: ReadonlySet<string> = new Set(["commit", "memory"]);

/** The external agent a feature model key names ("acp/<name>"), if it's configured. */
export function agentFor(services: WorkbenchServices, key: string): ExternalAgentConfig | null {
  if (!key.startsWith("acp/")) return null;
  const name = key.slice(4);
  return externalAgents(services).find((a) => a.name === name) ?? null;
}

const refuse = () => {
  throw new Error("Not available for this one-off request.");
};

export async function runAgentPrompt(
  services: WorkbenchServices,
  config: ExternalAgentConfig,
  text: string,
  signal?: AbortSignal,
  timeoutMs = 120_000,
  /** The feature it answers for, in the usage log (D208). */
  source: UsageSource = "commit",
): Promise<string> {
  // No folder open: a private folder of its own in app data (D208), like a chat's.
  const root = services.workspace.root.peek() ?? (await scratchIpc.dir("one-off"));
  let answer = "";
  const stderr: string[] = [];
  const host: AcpHost = {
    update: (_sid, u) => {
      if (u.sessionUpdate !== "agent_message_chunk") return;
      const c = (u as { content?: { type?: string; text?: string } }).content;
      if (c?.type === "text" && typeof c.text === "string") answer += c.text;
    },
    // Nothing is allowed: the answer is text only.
    requestPermission: async () => ({ outcome: "cancelled" }),
    readTextFile: async () => refuse(),
    writeTextFile: async () => refuse(),
    createTerminal: async () => refuse(),
    terminalOutput: () => refuse(),
    waitForTerminalExit: async () => refuse(),
    killTerminal: () => {},
    releaseTerminal: () => {},
  };
  // The agent exiting (not signed in, a crash) fails the request at once rather than after
  // the timeout; set once the client exists.
  let exited: (() => void) | null = null;
  const process = await startStdioProcess(
    `acp-once:${newId("o")}`,
    {
      command: config.command,
      args: expandArgs(config.args, root),
      cwd: root,
      env: config.env ?? {},
      framing: "ndjson",
    },
    {
      stderr: (line) => {
        stderr.push(line);
        if (stderr.length > 20) stderr.shift();
      },
      exit: () => exited?.(),
    },
  );
  const client = new AcpClient(process.transport, host);
  exited = () => client.connection.close("the agent exited");
  let session: string | null = null;
  let timedOut = false;
  const stop = () => {
    if (session) client.cancel(session);
    client.dispose();
    void process.stop().catch(() => {});
  };
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  try {
    await client.initialize(product.nameLong);
    session = await client.newSession(root);
    await client.prompt(session, [{ type: "text", text }]);
    recordAgentUsage(services, {
      source,
      agent: config.name,
      model: client.settings.find((s) => s.category === "model")?.current ?? "",
      usage: client.lastUsage,
      cost: null,
    });
    return answer.trim();
  } catch (err) {
    if (signal?.aborted) return "";
    const detail = stderr.slice(-3).join(" ").trim();
    const why = timedOut
      ? `no answer within ${Math.round(timeoutMs / 1000)} s`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new Error(`${config.name} didn't answer: ${why}${detail ? ` (${detail})` : ""}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    stop();
  }
}
