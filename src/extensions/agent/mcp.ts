// MCP client for the agent (PLAN §8.1, D193): servers start on the first agent message and their
// tools become agent tools named mcp__<server>__<tool>. Read-only tools (readOnlyHint) run
// freely; others ask first (once, always for the session, or deny). The servers stop when the
// folder closes or a config changes.
//
// Where servers come from (core/mcp/config.ts): agent.mcpServers, the folder's mcp.json files
// (`.vscode/mcp.json`, `<IDE folder>/mcp.json`, `.mcp.json` — only in a trusted folder that
// isn't a risky one like Downloads (D213), and each server is approved once), other tools'
// configs when agent.mcp.discovery is on, and extensions.
// Local servers run over stdio (through the Rust host); `url` servers over Streamable HTTP
// (Rust makes the requests). `${input:…}` values are asked once: password ones are stored as
// secrets and filled in by Rust, so the agent and the webview never see them.
// Reading and writing the mcp.json files themselves: mcpConfigFiles.ts.

import { Emitter } from "../../core/events/index";
import { fromBase64 } from "../../core/extensions/rpcAuthFs";
import { aiIpc } from "../../core/ipc/agent";
import { fsIpc } from "../../core/ipc/fs";
import { type StdioProcess, startStdioProcess } from "../../core/ipc/process";
import { appIpc, mcpClientIpc } from "../../core/ipc/system";
import type { DisposableStore } from "../../core/lifecycle/index";
import type { Transport } from "../../core/lsp/jsonrpc";
import { pathToUri } from "../../core/lsp/uri";
import { agentToolName, McpClient, type McpTool, type SampleHandler } from "../../core/mcp/client";
import {
  describeServer,
  identityHash,
  inputIds,
  type McpSource,
  mergeServers,
  parseEnvFile,
  type ResolvedServer,
  secretId,
  serverSignature,
  substitute,
  usesRawSecret,
} from "../../core/mcp/config";
import type { ElicitRequest, ElicitResult } from "../../core/mcp/elicitation";
import { exitReason } from "../../core/mcp/exitReason";
import type { McpIcon } from "../../core/mcp/icons";
import type { SamplingRequest } from "../../core/mcp/sampling";
import { basename, isAbsolute, joinPath, samePath } from "../../core/paths/index";
import { product } from "../../core/product";
import { effect, signal } from "../../core/reactive/index";
import { s } from "../../core/schema/index";
import { parseJsonc } from "../../core/settings/jsonc";
import { type McpServerConfig, parseMcpConfig } from "../../core/settings/vscodeImport";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderName } from "../../workbench/workspaceFolder";
import {
  disabledServers,
  disabledTools,
  folderMcpFile,
  folderMcpFiles,
  userMcpPath,
  workspaceMcpFolders,
  writeServerEntry,
} from "./mcpConfigFiles";
import { isSignInError, RemoteTransport } from "./mcpRemote";
import { activePlugins, pluginLabel } from "./pluginContributions";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";
import type { AgentTool } from "./tools";
import { pngBase64 } from "./uploads";
import { pickWorkspaceFolder } from "./workspaceFolderPick";

interface Running {
  name: string;
  client: McpClient;
  stop(): Promise<void>;
}

export interface McpStatus {
  name: string;
  state: "starting" | "running" | "failed" | "waiting";
  tools: number;
  /** Its prompts (slash commands) and resources (@-mentions), D200. */
  prompts?: number;
  resources?: number;
  error?: string;
  /** Where it's configured: "settings", ".vscode/mcp.json", "Claude Desktop"… */
  source?: string;
  transport?: "stdio" | "http";
  /** A remote server answered 401: the user signs in (OAuth, D204). */
  needsSignIn?: boolean;
  /** Resource templates and subscribed resources (D204). */
  templates?: number;
  subscribed?: number;
  /** A remote server's standing GET stream (D207): open, retrying, unsupported, closed. */
  stream?: "open" | "retrying" | "unsupported" | "closed";
  /** Times the stream was opened again after it dropped. */
  streamReconnects?: number;
  /** Its `serverInfo.icons` (checked; the MCP servers page shows one). */
  icons?: McpIcon[];
}

let homeDir: Promise<string | null> | null = null;
/** The user's home folder (`${userHome}`). */
const home = (): Promise<string | null> =>
  (homeDir ??= appIpc
    .info()
    .then((i) => i.homeDir)
    .catch(() => null));

export class McpClients {
  private running = new Map<string, Running>();
  private starting: Promise<void> | null = null;
  /**
   * Bumped by stopAll. A start still awaiting its process or handshake when the folder switches
   * (or the config changes) sees a different value afterwards and stops what it started instead
   * of adding a server for the old folder.
   */
  private generation = 0;
  readonly statuses = signal<readonly McpStatus[]>([]);
  /** Session grants: "<session>\0<tool>". */
  private readonly granted = new Set<string>();
  /** Folder servers the user allowed to start (their signatures), kept per workspace. */
  approved = new Set<string>();
  /** Folder servers declined in this window (asked again after a restart). */
  private readonly declined = new Set<string>();
  /** Servers whose process or handshake is under way (not started twice). */
  private readonly launching = new Set<string>();
  /** Inputs the user dismissed in this window: not asked again on every message. */
  private readonly skippedInputs = new Set<string>();
  /** Non-password input values, asked once per window. */
  private readonly inputValues = new Map<string, string>();
  /** The last resolved list (for `ide://agent/mcp` and the servers menu). */
  servers: ResolvedServer[] = [];

  /** Answers a server's elicitation/create (D200; set by mcpFeatures.ts). */
  elicit: (server: string, request: ElicitRequest) => Promise<ElicitResult> = async () => ({
    action: "decline",
  });
  /** Answers a server's sampling/createMessage (D204; set by mcpSampling.ts); null: refused. */
  sample: (
    server: string,
    request: SamplingRequest,
    stopped: AbortSignal,
  ) => ReturnType<SampleHandler> = async () => null;
  /** A running server's prompt or resource list changed (D200). */
  private readonly listsChanged = new Emitter<string>();
  readonly onDidChangeLists = this.listsChanged.event;

  constructor(private readonly services: WorkbenchServices) {}

  /** The servers running now, with their clients (prompts, resources; D200). */
  runningServers(): { name: string; client: McpClient }[] {
    return [...this.running.values()].map((r) => ({ name: r.name, client: r.client }));
  }

  /** The workspace folder each folder source came from (D251): its servers run there. */
  private readonly sourceFolders = new WeakMap<McpSource, string>();

  /** The file each folder source was read from. */
  private readonly sourceFiles = new WeakMap<McpSource, string>();

  /** The mcp.json a folder source came from (null for any other source). */
  fileOfSource(source: McpSource): string | null {
    return this.sourceFiles.get(source) ?? null;
  }

  /** The folder a server runs in: its config file's folder, else the first folder. */
  folderOfServer(server: ResolvedServer): string | null {
    return this.sourceFolders.get(server.source) ?? this.services.workspace.root.peek();
  }

  /** Every place servers are configured, in order of precedence. */
  async sources(): Promise<McpSource[]> {
    const { settings } = this.services;
    const out: McpSource[] = [];
    const raw = settings.peek<Record<string, Record<string, unknown>>>("agent.mcpServers");
    if (raw && typeof raw === "object") {
      const parsed = parseMcpConfig({ servers: raw });
      const servers: McpSource["servers"] = { ...parsed.servers };
      for (const [name, c] of Object.entries(raw))
        if (c && typeof c === "object" && c.enabled === false) servers[name] = { enabled: false };
      out.push({ label: "settings", kind: "settings", servers, inputs: parsed.inputs });
    }
    // The user's own mcp.json next to settings.json (VS Code keeps one there too; "Import from
    // VS Code" copies it here).
    const userFile = userMcpPath(this.services);
    if (userFile) {
      const text = await fsIpc
        .read(userFile)
        .then((b) => new TextDecoder().decode(b))
        .catch(() => null);
      const parsed = text === null ? null : parseJsonc(text);
      if (parsed?.ok) {
        const { servers, inputs } = parseMcpConfig(parsed.value);
        out.push({ label: "user mcp.json", kind: "settings", servers, inputs });
      }
    }
    // D358: the enabled plugins' servers the user let start when installing them.
    for (const p of activePlugins.peek()) {
      if (!p.mcpServers) continue;
      const { servers, inputs } = parseMcpConfig({ servers: p.mcpServers });
      out.push({ label: pluginLabel(p.name), kind: "settings", servers, inputs });
    }
    // Every folder's own files (D251), the first folder's first; with several folders the label
    // names the folder ("api/.vscode/mcp.json"), and the server runs in its folder.
    // D213: never from a risky folder (Downloads, home, Desktop, temp, a drive root), even trusted:
    // a downloaded .mcp.json would start its programs with the agent's first message. Each
    // folder is checked on its own.
    const folders = workspaceMcpFolders(this.services);
    if (this.services.trust.trusted)
      for (const folder of folders) {
        if (this.services.trust.risky.riskOf(folder.path)) continue;
        for (const path of folderMcpFiles(folder.path)) {
          const text = await fsIpc
            .read(path)
            .then((b) => new TextDecoder().decode(b))
            .catch(() => null);
          if (text === null) continue;
          const parsed = parseJsonc(text);
          if (!parsed.ok) continue;
          const { servers, inputs } = parseMcpConfig(parsed.value);
          const rel = path.slice(folder.path.length + 1).replaceAll("\\", "/");
          const label = folders.length > 1 ? `${folder.name}/${rel}` : rel;
          const source: McpSource = { label, kind: "workspace", servers, inputs };
          this.sourceFolders.set(source, folder.path);
          this.sourceFiles.set(source, path);
          out.push(source);
        }
      }
    if (settings.peek<boolean>("agent.mcp.discovery") === true) {
      for (const [label, text] of await mcpClientIpc.discover().catch(() => [])) {
        const parsed = parseJsonc(text);
        if (!parsed.ok) continue;
        const { servers, inputs } = parseMcpConfig(parsed.value);
        if (Object.keys(servers).length) out.push({ label, kind: "discovered", servers, inputs });
      }
    }
    // Servers extensions bring (D176); a user's entry of the same name wins.
    const contributed: McpSource["servers"] = {};
    for (const m of this.services.extensionFeatures.mcpServers.peek())
      contributed[m.name] = {
        command: m.command,
        ...(m.args && { args: [...m.args] }),
        ...(m.env && { env: { ...m.env } }),
      };
    out.push({ label: "extensions", kind: "extension", servers: contributed, inputs: [] });
    return out;
  }

  /** Starts configured servers that aren't running (once at a time). */
  ensure(session?: AgentSession): Promise<void> {
    if (!this.starting) {
      const pending: Promise<void> = this.startAll(session).finally(() => {
        // stopAll may have let a newer start begin meanwhile: only clear our own.
        if (this.starting === pending) this.starting = null;
      });
      this.starting = pending;
    }
    return this.starting;
  }

  private setStatus(status: McpStatus): void {
    this.statuses.value = [...this.statuses.peek().filter((s) => s.name !== status.name), status];
  }

  /** A folder's server runs commands from the repository: the user says yes once. */
  private async approve(server: ResolvedServer, session?: AgentSession): Promise<boolean> {
    if (server.source.kind !== "workspace") return true;
    const sig = serverSignature(server.name, server.config);
    if (this.approved.has(sig)) return true;
    if (this.declined.has(sig) || !session) return false;
    const what = describeServer(server.config);
    const answer = await session.ask({
      title: `Start MCP server ${server.name} from ${server.source.label}?`,
      heading: `Start MCP server ${server.name}?`,
      detail: `Configured in ${server.source.label}. It runs with your permissions.`,
      code: what.slice(0, 1200),
      kind: "tool",
      always: "always for this folder",
      evenWithFullAccess: true,
    });
    if (answer === "deny") {
      this.declined.add(sig);
      return false;
    }
    if (answer === "always") {
      this.approved.add(sig);
      this.services.persistence.scheduleSave();
    }
    return true;
  }

  /** The value for `${input:id}`: asked once; a password one is stored as a secret. */
  private async input(server: ResolvedServer, id: string): Promise<string | null> {
    const skipKey = `${server.name}\0${id}`;
    if (this.skippedInputs.has(skipKey)) return null;
    const value = await this.askInput(server, id);
    if (value === null) this.skippedInputs.add(skipKey);
    return value;
  }

  private async askInput(server: ResolvedServer, id: string): Promise<string | null> {
    const declared = server.source.inputs.find((i) => i.id === id);
    // Undeclared inputs are treated as passwords (the safe guess).
    const password = declared ? declared.password : true;
    const prompt = `${server.name}: ${declared?.description ?? id}`;
    if (password) {
      // Keyed by what the server is, not only its name (D223): another config's "github"
      // pointing elsewhere doesn't get this one's key.
      const key = secretId(server.name, id, await identityHash(server.config));
      // Kept under the name only (before D223): still used for the user's own servers (their
      // settings, their mcp.json); a folder's or another tool's server is asked again.
      const legacy = secretId(server.name, id);
      if (
        server.source.kind === "settings" &&
        !(await aiIpc.hasKey(key).catch(() => false)) &&
        (await aiIpc.hasKey(legacy).catch(() => false))
      )
        return `\${secret:${legacy}}`;
      if (!(await aiIpc.hasKey(key).catch(() => false))) {
        const value = await this.services.quickInput.prompt({
          prompt: `${prompt} (stored on this computer, never shown to the agent)`,
          password: true,
        });
        if (!value) return null;
        await aiIpc.setKey(key, value);
      }
      return `\${secret:${key}}`;
    }
    const remembered = this.inputValues.get(`${server.name}\0${id}`);
    if (remembered !== undefined) return remembered;
    // A pickString input (D223): one of its choices, the default first.
    if (declared?.options?.length) {
      const options = declared.options;
      const first = declared.default && options.includes(declared.default) ? declared.default : "";
      const picked = await this.services.quickInput.pick(
        [...(first ? [first] : []), ...options.filter((o) => o !== first)].map((o) => ({
          id: o,
          label: o,
          ...(o === first && { description: "default" }),
        })),
        { placeholder: prompt },
      );
      if (!picked) return null;
      this.inputValues.set(`${server.name}\0${id}`, picked.id);
      return picked.id;
    }
    const value = await this.services.quickInput.prompt({
      prompt,
      ...(declared?.default && { value: declared.default }),
    });
    if (value === undefined || value === null) return null;
    this.inputValues.set(`${server.name}\0${id}`, value);
    return value;
  }

  private async startAll(session?: AgentSession): Promise<void> {
    const root = this.services.workspace.root.peek();
    if (!root) return;
    const generation = this.generation;
    const stale = () => generation !== this.generation;
    const off = disabledServers(this.services);
    this.servers = mergeServers(await this.sources()).filter((s) => !off.has(s.name));
    if (stale()) return;
    const starts: Promise<void>[] = [];
    for (const server of this.servers.filter(
      (s) => !this.running.has(s.name) && !this.launching.has(s.name),
    )) {
      const { name, source } = server;
      const transport = server.config.url ? "http" : "stdio";
      const status = (s: Omit<McpStatus, "name" | "source" | "transport">) =>
        this.setStatus({ name, source: source.label, transport, ...s });
      // Only `${input:…}` may lead to a stored secret: a config naming one itself is refused.
      if (usesRawSecret(server.config)) {
        status({ state: "failed", tools: 0, error: "uses ${secret:…}; declare an input instead" });
        continue;
      }
      if (!(await this.approve(server, session))) {
        status({ state: "waiting", tools: 0, error: "not approved for this folder" });
        continue;
      }
      if (stale()) return;
      // Inputs first (one prompt at a time), then start.
      const values = new Map<string, string>();
      let missing = false;
      for (const id of inputIds(server.config)) {
        const value = await this.input(server, id).catch(() => null);
        if (value === null) {
          missing = true;
          break;
        }
        values.set(id, value);
      }
      if (missing) {
        status({
          state: "waiting",
          tools: 0,
          error: "an input wasn't given (MCP servers… → Restart asks again)",
        });
        continue;
      }
      // A folder's server runs in that folder (${workspaceFolder} is it, D251).
      const folder = this.folderOfServer(server) ?? root;
      const config = substitute(
        server.config,
        { workspaceFolder: folder, userHome: await home() },
        (id) => values.get(id) ?? "",
      );
      this.launching.add(name);
      starts.push(
        this.startOne(server, config, folder, generation, status).finally(() =>
          this.launching.delete(name),
        ),
      );
    }
    // The turn waits for them: their tools are there for its first step.
    await Promise.all(starts);
  }

  private async startOne(
    server: ResolvedServer,
    config: McpServerConfig,
    root: string,
    generation: number,
    status: (s: Omit<McpStatus, "name" | "source" | "transport">) => void,
  ): Promise<void> {
    const { name } = server;
    const stale = () => generation !== this.generation;
    status({ state: "starting", tools: 0 });
    let stop: (() => Promise<void>) | undefined;
    let onRunning: (r: Running) => void = () => {};
    let remoteTransport: RemoteTransport | undefined;
    let client: McpClient | undefined;
    // Aborted when this server stops or exits: its sampling requests stop too (D223).
    const gone = new AbortController();
    // Why a local server's process ended, once it has: its requests fail at once with it (a
    // server that couldn't start waited out initialize's 60 s, and Reconnect seemed stuck).
    let exitedWith: string | null = null;
    const counts = () => ({
      state: "running" as const,
      tools: client?.tools.length ?? 0,
      prompts: client?.prompts.length ?? 0,
      resources: client?.resources.length ?? 0,
      ...(client?.resourceTemplates.length && { templates: client.resourceTemplates.length }),
      ...(client?.subscribed.size && { subscribed: client.subscribed.size }),
      ...(remoteTransport?.streamState && { stream: remoteTransport.streamState }),
      ...(remoteTransport?.reconnects && { streamReconnects: remoteTransport.reconnects }),
      ...(client?.serverIcons.length && { icons: client.serverIcons }),
    });
    try {
      let transport: Transport;
      if (config.url) {
        const remote = new RemoteTransport(name, config.url, config.headers ?? {}, {
          stepUp: (scope) => this.stepUp(name, scope),
          onStreamState: () => {
            const current = this.statuses.peek().find((x) => x.name === name);
            if (current?.state === "running") status(counts());
          },
        });
        transport = remote;
        remoteTransport = remote;
        stop = async () => remote.dispose();
      } else {
        const stderr: string[] = [];
        let env = { ...(config.env ?? {}) };
        if (config.envFile) {
          const file = isAbsolute(config.envFile) ? config.envFile : joinPath(root, config.envFile);
          const text = await fsIpc
            .read(file)
            .then((b) => new TextDecoder().decode(b))
            .catch(() => {
              throw new Error(`can't read its envFile ${config.envFile}`);
            });
          env = { ...parseEnvFile(text), ...env };
        }
        let entry: Running | undefined;
        const process: StdioProcess = await startStdioProcess(
          `mcp:${name}`,
          {
            command: config.command ?? "",
            args: config.args ?? [],
            cwd: config.cwd
              ? isAbsolute(config.cwd)
                ? config.cwd
                : joinPath(root, config.cwd)
              : root,
            env,
            framing: "ndjson",
          },
          {
            stderr: (line) => {
              stderr.push(line);
              if (stderr.length > 50) stderr.shift();
            },
            exit: () => {
              gone.abort();
              const why = exitReason(stderr);
              exitedWith = `The server exited${why ? `: ${why}` : ""}`;
              client?.connection.close(exitedWith);
              if (entry && this.running.get(name) === entry) {
                this.running.delete(name);
                status({
                  state: "failed",
                  tools: 0,
                  error: exitReason(stderr) || "exited",
                });
              }
            },
          },
        );
        transport = process.transport;
        stop = () => process.stop();
        onRunning = (r) => {
          entry = r;
        };
      }
      if (stale()) {
        await stop();
        return;
      }
      const started = new McpClient(
        transport,
        product.nameLong,
        (request) => this.elicit(name, request),
        (request) => this.sample(name, request, gone.signal),
      );
      client = started;
      // It may have exited already (a missing script): nothing will answer.
      if (exitedWith) started.connection.close(exitedWith);
      // MCP's roots: every folder of the workspace (D251), the server's own first.
      const roots = workspaceMcpFolders(this.services);
      await started.start(
        (roots.length ? roots : [{ path: root, name: basename(root) }])
          .slice()
          .sort((a, b) => Number(samePath(b.path, root)) - Number(samePath(a.path, root)))
          .map((f) => ({
            uri: pathToUri(f.path),
            name: roots.length > 1 ? f.name : basename(f.path),
          })),
      );
      if (stale()) {
        started.dispose();
        await stop();
        return;
      }
      // Notifications between requests (D207): a server without a GET stream answers 405.
      remoteTransport?.listen();
      const end = stop;
      const running: Running = {
        name,
        client: started,
        stop: async () => {
          gone.abort();
          started.dispose();
          await end();
        },
      };
      this.running.set(name, running);
      onRunning(running);
      status(counts());
      // The client's emitters are disposed with it: no listener outlives the server.
      started.onDidChangeTools(() => status(counts()));
      started.onDidChangeList(() => {
        status(counts());
        this.listsChanged.fire(name);
      });
    } catch (err) {
      await stop?.().catch(() => {});
      if (stale()) return; // stopped on purpose: no failure to report
      const message = err instanceof Error ? err.message : String(err);
      // A remote server that wants a sign-in waits for it (D204): Sign in on the MCP servers
      // page, or agent.mcpSignIn.
      if (config.url && isSignInError(message)) {
        status({ state: "waiting", tools: 0, error: "needs a sign-in", needsSignIn: true });
        this.services.notifications.show("info", `MCP server ${name} needs a sign-in.`, {
          actions: [
            {
              label: "Sign in",
              run: () => void this.services.dispatcher.execute("agent.mcpSignIn", { server: name }),
            },
          ],
        });
        return;
      }
      status({ state: "failed", tools: 0, error: message });
      this.services.notifications.show("warning", `MCP server ${name}: ${message}`);
    }
  }

  /** A running server's tools as it lists them (every one, turned off or not). */
  serverTools(name: string): readonly McpTool[] | null {
    return this.running.get(name)?.client.tools ?? null;
  }

  /**
   * The agent's MCP tools, each with its full definition: with many of them a chat defers them
   * (D319, deferredTools.ts) and tool_search loads the ones the agent needs.
   */
  tools(): AgentTool[] {
    const off = disabledTools(this.services);
    const all = [...this.running.values()].flatMap((r) =>
      r.client.tools
        .filter((t) => !off.get(r.name)?.has(t.name))
        .map((t) => ({ r, t, name: agentToolName(r.name, t.name) })),
    );
    const out: AgentTool[] = [];
    for (const { r, t, name } of all) {
      const readOnly = t.annotations?.readOnlyHint === true;
      const danger = t.annotations?.destructiveHint === true;
      const description = `[MCP ${r.name}] ${t.description ?? t.title ?? t.name}`.slice(0, 1024);
      out.push({
        spec: {
          name,
          description,
          parameters: t.inputSchema ?? { type: "object", properties: {} },
        },
        readOnly,
        mcp: true,
        verb: `${r.name}:`,
        target: () => t.name,
        run: async (args, host, itemId) => {
          const key = `${host.session}\0${name}`;
          // MCP tools protection (D179): every call asks, read-only ones too, even with full
          // access; "this session" still covers the rest of the chat.
          const protect = this.services.settings.peek<boolean>("agent.mcpProtection") === true;
          // Per-category auto-approve (D204): "server" or "server/tool" patterns.
          const rule = this.autoApprove(`${r.name}/${t.name}`);
          if (rule === "allow" && !protect) {
            // Allowed by agent.autoApprove.mcp: no question.
          } else if (rule === "ask" || ((protect || !readOnly) && !this.granted.has(key))) {
            // An Ask pattern asks every time, even with full access (like commands and paths):
            // no "this session" answer that would stop it asking.
            const answer = await host.ask({
              ...((protect || rule === "ask") && { evenWithFullAccess: true }),
              title: `Use \`${t.name}\` from MCP server ${r.name}`,
              heading: `Use ${t.name}`,
              detail:
                rule === "ask"
                  ? `From MCP server ${r.name}. agent.autoApprove says to ask before this tool.`
                  : `From MCP server ${r.name}`,
              code: JSON.stringify(args, null, 2).slice(0, 600),
              kind: "tool",
              ...(!danger && rule !== "ask" && { always: "this session" }),
              danger,
            });
            if (answer === "deny")
              return {
                result: "The user denied this tool call.",
                denied: true,
                summary: "denied",
              };
            if (answer === "always") this.granted.add(key);
          }
          // A step-up sign-in while the call waits shows on its row (D223).
          const off = this.watchStepUp(r.name, (line) => host.output(itemId, `${line}\n`));
          const result = await r.client.call(t.name, args).finally(off);
          // Its images show in the chat with ids (save_image keeps one), and a model that sees
          // images gets them too, as PNG (D381).
          const media = (result.images ?? []).map((i) => ({ ...i, source: t.name }));
          const seen = (
            await Promise.all(
              media
                .slice(0, 4)
                .map((m) =>
                  pngBase64(new Blob([fromBase64(m.data) as BlobPart], { type: m.mime })),
                ),
            )
          ).filter((png): png is string => png !== null);
          const pictures = media.length
            ? `${media.length} image${media.length === 1 ? "" : "s"}`
            : "";
          return {
            result:
              result.text.length > 16000
                ? `${result.text.slice(0, 16000)}\n… (truncated)`
                : result.text || (pictures ? `(${pictures})` : "(no output)"),
            isError: result.isError,
            summary: result.isError
              ? "error"
              : [result.text ? `${result.text.length} chars` : "", pictures]
                  .filter(Boolean)
                  .join(" · "),
            detail: result.text.slice(0, 4000),
            ...(media.length > 0 && { media }),
            ...(seen.length > 0 && { images: seen }),
          };
        },
      });
    }
    return out;
  }

  /**
   * A remote server refused a call for lack of scope (403 insufficient_scope, D207): the user is
   * asked, then signs in again for the old and the new scopes (agent.mcpSignIn without the
   * restart), and the call is sent once more. Asked once per server at a time.
   */
  private async stepUp(name: string, scope: string): Promise<boolean> {
    const tell = (line: string) => {
      for (const w of this.stepUpWatchers.get(name) ?? []) w(line);
      this.stepUps.set(name, line);
    };
    try {
      tell(
        `${name} needs more access${scope ? ` (${scope})` : ""}: waiting for you to sign in again…`,
      );
      const ok = await this.askStepUp(name, scope);
      tell(ok ? "Signed in: sending the call again." : "Not signed in: the call fails.");
      return ok;
    } finally {
      this.stepUps.delete(name);
    }
  }

  /** Who wants to hear about a step-up sign-in of a server (its calls' rows, D223). */
  private readonly stepUpWatchers = new Map<string, Set<(line: string) => void>>();
  /** The step-ups under way, by server: what they're waiting for (ide://agent/mcp). */
  readonly stepUps = new Map<string, string>();

  /** Hears `server`'s step-up progress until the returned function is called. */
  watchStepUp(server: string, listener: (line: string) => void): () => void {
    const set = this.stepUpWatchers.get(server) ?? new Set<(line: string) => void>();
    this.stepUpWatchers.set(server, set);
    set.add(listener);
    const waiting = this.stepUps.get(server);
    if (waiting) listener(waiting);
    return () => {
      set.delete(listener);
      if (!set.size) this.stepUpWatchers.delete(server);
    };
  }

  private async askStepUp(name: string, scope: string): Promise<boolean> {
    const picked = await this.services.quickInput.pick(
      [
        {
          id: "signIn",
          label: "Sign in again",
          description: scope ? `to grant ${scope}` : "to grant more access",
        },
        { id: "no", label: "Not now", description: "The call fails" },
      ],
      { placeholder: `MCP server ${name} needs more access${scope ? ` (${scope})` : ""}` },
    );
    if (picked?.id !== "signIn") return false;
    try {
      await this.services.dispatcher.execute("agent.mcpSignIn", { server: name, restart: false });
      return true;
    } catch (err) {
      this.services.notifications.show(
        "warning",
        `MCP server ${name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** agent.autoApprove's decision for "server/tool" (set by autoApprove.ts, D204). */
  autoApprove: (subject: string) => "allow" | "ask" | null = () => null;

  /** Stops these servers (an extension changed or removed them); others keep running. */
  async stop(names: readonly string[]): Promise<void> {
    // A restart asks again for inputs dismissed earlier.
    for (const key of [...this.skippedInputs])
      if (names.includes(key.split("\0")[0] ?? "")) this.skippedInputs.delete(key);
    const gone = names.flatMap((n) => {
      const r = this.running.get(n);
      this.running.delete(n);
      return r ? [r] : [];
    });
    this.statuses.value = this.statuses.peek().filter((s) => !names.includes(s.name));
    await Promise.all(gone.map((r) => r.stop().catch(() => {})));
  }

  async stopAll(): Promise<void> {
    this.generation++;
    // A start in flight finishes on its own (and stops what it made); the next ensure starts anew.
    this.starting = null;
    const all = [...this.running.values()];
    this.running.clear();
    this.statuses.value = [];
    await Promise.all(all.map((r) => r.stop().catch(() => {})));
  }

  /**
   * A config file or setting changed: restart only when what it resolves to differs from what's
   * running. (Our own write in agent.addMcpServer, seen a moment later by the watcher, would
   * otherwise stop the servers a turn has just started.)
   */
  async configChanged(): Promise<void> {
    const signature = (list: readonly ResolvedServer[]) =>
      JSON.stringify(list.map((s) => [s.name, s.source.label, s.config]));
    for (let i = 0; i < 3; i++) {
      if (this.starting) await this.starting.catch(() => {});
      // Nothing started yet: the next turn reads the config afresh anyway.
      if (!this.running.size) {
        if (this.starting) continue;
        this.statuses.value = this.statuses.peek().filter((s) => s.state !== "waiting");
        return;
      }
      const off = disabledServers(this.services);
      const next = mergeServers(await this.sources()).filter((s) => !off.has(s.name));
      if (this.starting) continue; // a turn began meanwhile: compare with what it started
      if (signature(next) !== signature(this.servers)) await this.stopAll();
      return;
    }
  }

  disposeEvents(): void {
    this.listsChanged.dispose();
  }

  /** A server just installed (the gallery, D204) starts without asking: the user chose it. */
  async approveInstalled(name: string): Promise<void> {
    const server = mergeServers(await this.sources()).find((s) => s.name === name);
    if (!server) return;
    this.approved.add(serverSignature(server.name, server.config));
    this.services.persistence.scheduleSave();
  }

  /**
   * Values typed into a suggest_mcp_server card (D343) for a server just added: a password one
   * is stored as its secret (as the hidden box would store it), others kept for this window.
   * Ids the server's config doesn't use are ignored. The ids stored.
   */
  async presetInputs(name: string, values: Readonly<Record<string, string>>): Promise<string[]> {
    const server = mergeServers(await this.sources()).find((s) => s.name === name);
    if (!server) return [];
    const used = inputIds(server.config);
    const stored: string[] = [];
    for (const [id, value] of Object.entries(values)) {
      if (!value || !used.includes(id)) continue;
      const declared = server.source.inputs.find((i) => i.id === id);
      if (declared ? declared.password : true)
        await aiIpc.setKey(secretId(server.name, id, await identityHash(server.config)), value);
      else this.inputValues.set(`${server.name}\0${id}`, value);
      this.skippedInputs.delete(`${server.name}\0${id}`);
      stored.push(id);
    }
    return stored;
  }

  /** Forgets a server's stored password inputs (asked again on its next start). */
  async forgetInputs(name: string): Promise<number> {
    const server = this.servers.find((s) => s.name === name);
    if (!server) throw new Error(`No MCP server named ${name}.`);
    let n = 0;
    const identity = await identityHash(server.config);
    for (const id of inputIds(server.config)) {
      this.inputValues.delete(`${name}\0${id}`);
      let forgot = false;
      for (const key of [secretId(name, id, identity), secretId(name, id)])
        if (await aiIpc.hasKey(key).catch(() => false)) {
          await aiIpc.setKey(key, null);
          forgot = true;
        }
      if (forgot) n++;
    }
    await this.stop([name]);
    return n;
  }
}

export function registerMcpClients(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
): McpClients {
  const clients = new McpClients(services);
  sessions.extraTools = () => clients.tools();
  sessions.prepare = (session) => clients.ensure(session);
  sub.add(services.workspace.onDidClose(() => void clients.stopAll()));
  // Folders added or removed (D251): their mcp.json files count from the next turn.
  sub.add(services.workspace.onDidChangeFolders(() => void clients.configChanged()));
  sub.add(
    services.settings.model.onDidChange((keys) => {
      if (
        keys.includes("agent.mcpServers") ||
        keys.includes("agent.mcp.discovery") ||
        keys.includes("agent.mcp.disabledServers")
      )
        void clients.configChanged();
    }),
  );
  // A folder's mcp.json changed: the next turn starts what it says now.
  // Only the config files themselves (not some package's mcp.json under node_modules).
  const isConfig = (path: string) => {
    const known = [
      userMcpPath(services),
      ...workspaceMcpFolders(services).flatMap((f) => folderMcpFiles(f.path)),
    ];
    return known.some((p) => p && samePath(p, path));
  };
  for (const event of [
    "files.didSave",
    "files.didChange",
    "files.didCreate",
    "files.didDelete",
  ] as const)
    sub.add(
      services.events.on(event, ({ path }) => {
        if (isConfig(path)) void clients.configChanged();
      }),
    );
  // Folder servers the user allowed, per workspace.
  sub.add(
    services.persistence.register("agent.mcpApproved", {
      save: () => [...clients.approved],
      restore: (data) => {
        clients.approved = new Set(
          Array.isArray(data) ? data.filter((x): x is string => typeof x === "string") : [],
        );
      },
    }),
  );
  // An extension added, changed or took away a server: stop just those (the next turn starts
  // what's configured). Reloading an extension with the same servers changes nothing.
  const signature = () =>
    new Map(
      services.extensionFeatures.mcpServers.value.map(
        (m) => [m.name, JSON.stringify([m.command, m.args, m.env])] as const,
      ),
    );
  let contributed = new Map<string, string>();
  sub.add(
    effect(() => {
      const next = signature();
      const changed = [...new Set([...contributed.keys(), ...next.keys()])].filter(
        (name) => contributed.get(name) !== next.get(name),
      );
      contributed = next;
      if (changed.length) void clients.stop(changed);
      return undefined;
    }),
  );
  sub.add({ dispose: () => void clients.stopAll() });
  sub.add({ dispose: () => clients.disposeEvents() });

  // What's configured and how it's doing.
  const describe = async () => {
    const resolved = mergeServers(await clients.sources());
    const statuses = clients.statuses.peek();
    return resolved.map((r) => {
      const s = statuses.find((x) => x.name === r.name);
      return {
        name: r.name,
        source: r.source.label,
        transport: r.config.url ? "http" : "stdio",
        target: r.config.url ?? [r.config.command, ...(r.config.args ?? [])].join(" "),
        inputs: inputIds(r.config),
        state: s?.state ?? "not started",
        tools: s?.tools ?? 0,
        ...(s?.prompts && { prompts: s.prompts }),
        ...(s?.resources && { resources: s.resources }),
        ...(s?.error && { error: s.error }),
        ...(s?.stream && { stream: s.stream }),
        ...(s?.streamReconnects && { streamReconnects: s.streamReconnects }),
        // Its icon from serverInfo.icons: an https address, or "embedded" (a data: picture).
        ...(s?.icons?.[0] && {
          icon: s.icons[0].src.startsWith("data:") ? "embedded" : s.icons[0].src,
        }),
        ...(clients.stepUps.has(r.name) && { signingIn: clients.stepUps.get(r.name) }),
      };
    });
  };
  sub.add(
    services.state.register("ide://agent/mcp", {
      description:
        "The agent's MCP servers: name, where each is configured (settings, .vscode/mcp.json, .mcp.json, Claude Desktop…), stdio or http, its state and its tool, prompt and resource counts. Servers start with the agent's first message.",
      get: () => describe(),
    }),
  );
  sub.add(
    services.dispatcher.register({
      id: "agent.mcpServers",
      title: "MCP servers",
      category: "Agent",
      description:
        "Lists the agent's MCP servers and what they're doing; pick one to restart it or forget its stored inputs. `restart` / `forgetInputs` name a server to act on directly.",
      input: s.object({
        restart: s.string().describe("A server to restart").optional(),
        forgetInputs: s.string().describe("A server whose stored inputs to forget").optional(),
      }),
      effects: ["exec"],
      agent: "hidden",
      run: async ({ restart, forgetInputs }) => {
        if (forgetInputs) return { forgotten: await clients.forgetInputs(forgetInputs) };
        if (restart) {
          await clients.stop([restart]);
          await clients.ensure(sessions.find(undefined) ?? undefined);
          return { restarted: restart };
        }
        const list = await describe();
        if (!list.length) {
          services.notifications.show(
            "info",
            `No MCP servers yet. Add them to ${workspaceFolderName()}/mcp.json in this folder (.vscode/mcp.json and .mcp.json are read too), or ask the agent to add one. Turn on agent.mcp.discovery to use the servers Claude Desktop, Claude Code, Cursor or VS Code already have.`,
          );
          return { servers: [] };
        }
        const picked = await services.quickInput.pick(
          list.map((x) => ({
            id: x.name,
            label: x.name,
            description: `${x.state}${x.tools ? ` · ${x.tools} tools` : ""}${x.prompts ? ` · ${x.prompts} prompts` : ""}${x.resources ? ` · ${x.resources} resources` : ""} · ${x.source}`,
            detail: x.error ?? x.target,
          })),
          { placeholder: "MCP servers" },
        );
        if (!picked) return { servers: list };
        const action = await services.quickInput.pick(
          [
            { id: "restart", label: "Restart" },
            ...(list.find((x) => x.name === picked.id)?.inputs.length
              ? [{ id: "forget", label: "Forget its stored inputs (asked again)" }]
              : []),
          ],
          { placeholder: picked.id },
        );
        if (action?.id === "restart") {
          await clients.stop([picked.id]);
          await clients.ensure(sessions.find(undefined) ?? undefined);
        } else if (action?.id === "forget") await clients.forgetInputs(picked.id);
        return { servers: list };
      },
    }),
  );
  sub.add(
    services.dispatcher.register({
      id: "agent.addMcpServer",
      title: "Add MCP server",
      category: "Agent",
      description:
        'Adds an MCP server to this folder\'s mcp.json (VS Code\'s format; .vscode/mcp.json when the folder has one). In a multi-root workspace `folder` (a folder\'s path or name) says which folder\'s; without it, the active editor\'s folder, else the user picks. For a key or token, don\'t ask the user to paste it into the chat: put `${input:<id>}` where it goes (an env value, a header) and declare it in `inputs` with password true. The user is asked for it in a hidden box when the server starts; it\'s stored on their computer and never shown to you. The user approves the server before it\'s added. Example: { name: "github", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${input:github-token}" }, inputs: [{ id: "github-token", description: "GitHub personal access token", password: true }] }.',
      input: s.object({
        name: s.string().describe("Server name (letters, digits, - and _)"),
        command: s.string().describe("A local server's program (npx, uvx, node…)").optional(),
        args: s.array(s.string()).optional(),
        env: s
          .unknown()
          .describe("Environment (name → value); values may use ${input:id}")
          .optional(),
        url: s.string().describe("A remote server's address (Streamable HTTP)").optional(),
        headers: s
          .unknown()
          .describe("Request headers (name → value); values may use ${input:id}")
          .optional(),
        inputs: s
          .array(
            s.object({
              id: s.string(),
              description: s.string(),
              password: s.boolean().optional(),
            }),
          )
          .optional(),
        folder: s
          .string()
          .describe("Multi-root workspaces: the folder (its path or name) whose mcp.json to use")
          .optional(),
      }),
      effects: ["write", "exec"],
      agent: "discoverable",
      run: async (
        { name, command, args, env: rawEnv, url, headers: rawHeaders, inputs, folder },
        ctx,
      ) => {
        const strings = (v: unknown, what: string): Record<string, string> | undefined => {
          if (v === undefined) return undefined;
          if (!v || typeof v !== "object" || Array.isArray(v))
            throw new Error(`\`${what}\` is an object of names to strings.`);
          const out: Record<string, string> = {};
          for (const [k, x] of Object.entries(v)) {
            if (typeof x !== "string") throw new Error(`\`${what}.${k}\` must be a string.`);
            out[k] = x;
          }
          return out;
        };
        const env = strings(rawEnv, "env");
        const headers = strings(rawHeaders, "headers");
        if (!services.workspace.root.peek())
          throw new Error("Open a folder first: MCP servers are added to its mcp.json.");
        const root = await pickWorkspaceFolder(
          services,
          folder,
          "Add the MCP server to which folder's mcp.json?",
        );
        if (!root) return { added: false, reason: "No folder was picked." };
        if (!/^[\w-]{1,64}$/.test(name))
          throw new Error("Use letters, digits, - and _ in the name.");
        if (!!command === !!url)
          throw new Error("Give either `command` (local) or `url` (remote).");
        // Values given straight in env/headers would sit in the file: secrets go through inputs.
        const literal = Object.values({ ...env, ...headers }).find(
          (v) => !v.includes("${input:") && /(sk-|ghp_|github_pat_|xox[bp]-|AKIA)[\w-]{8,}/.test(v),
        );
        if (literal)
          throw new Error(
            "That value looks like a key: use ${input:<id>} and declare the input with password true, so the user types it in a hidden box.",
          );
        const server: Record<string, unknown> = url
          ? { type: "http", url, ...(headers && { headers }) }
          : { type: "stdio", command, ...(args && { args }), ...(env && { env }) };
        if (usesRawSecret({ ...(url ? { url } : { command, args }), env, headers }))
          throw new Error("Don't use ${secret:…}: declare an input with password true instead.");
        // Anyone but the user (an agent, an extension, an MCP client) needs the user's yes.
        const byAgent = ctx.caller.kind !== "user" && ctx.caller.kind !== "test";
        if (byAgent) {
          const session = sessions.find(undefined);
          if (!session) throw new Error("No agent chat to ask the user in.");
          const answer = await session.ask({
            title: `Add MCP server ${name}?`,
            heading: `Add MCP server ${name}?`,
            detail: `To ${services.workspace.folders.peek().length > 1 ? `${services.workspace.folderOf(root)?.name ?? root}'s` : "this folder's"} mcp.json. It runs with your permissions.${inputs?.length ? ` You'll be asked for: ${inputs.map((i) => i.description).join(", ")}.` : ""}`,
            code: describeServer({ ...(url ? { url } : { command, args }), env, headers }),
            kind: "tool",
            evenWithFullAccess: true,
          });
          if (answer === "deny") return { added: false, reason: "The user declined." };
        }
        const path = await folderMcpFile(root);
        await writeServerEntry(path, name, server, inputs);
        // Approved by adding it: it starts with the next message without asking again.
        clients.approved.add(
          serverSignature(
            name,
            parseMcpConfig({ servers: { [name]: server } }).servers[name] ?? {},
          ),
        );
        services.persistence.scheduleSave();
        await clients.stopAll();
        return {
          added: true,
          file: services.workspace.relative(path),
          note: inputs?.length
            ? "The user will be asked for the inputs when the server starts (the next message)."
            : "It starts with the next message.",
        };
      },
    }),
  );
  return clients;
}
