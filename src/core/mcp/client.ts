// A minimal MCP client over a JSON-RPC connection (stdio servers): initialize, list tools (all
// pages), call a tool, and follow tools/list_changed. D200: prompts and resources (listed when the
// server has them, re-listed on their list_changed), and elicitation (the server asks the user
// for input through `onElicit`). DOM-free; tested with an in-memory server.
import { Emitter } from "../events/index";
import { RpcConnection, RpcError, type Transport } from "../lsp/jsonrpc";
import type { ElicitRequest, ElicitResult } from "./elicitation";
import { type McpIcon, parseIcons } from "./icons";
import type { McpPrompt, McpPromptMessage, McpResource } from "./prompts";
import {
  readSamplingRequest,
  SAMPLING_REJECTED,
  type SamplingRequest,
  type SamplingResult,
} from "./sampling";
import type { McpResourceTemplate } from "./templates";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpCallResult {
  text: string;
  isError: boolean;
  /** Images in the result (D381): base64 `data` of type `mime`. */
  images?: { mime: string; data: string }[];
}

/** Answers a server's `elicitation/create` (the user fills a form, declines or cancels). */
export type ElicitHandler = (request: ElicitRequest) => Promise<ElicitResult>;

/**
 * Answers a server's `sampling/createMessage` (D204): the user's model's reply, or null when the
 * user refused (the server gets MCP's user-rejected error).
 */
export type SampleHandler = (request: SamplingRequest) => Promise<SamplingResult | null>;

type ListKind = "tools" | "prompts" | "resources";

export class McpClient {
  readonly connection: RpcConnection;
  tools: McpTool[] = [];
  prompts: McpPrompt[] = [];
  resources: McpResource[] = [];
  /** Resource templates (D204): URIs with variables the user fills in. */
  resourceTemplates: McpResourceTemplate[] = [];
  serverName = "";
  /** initialize's `serverInfo.icons` (MCP 2025-11-25), checked (icons.ts). */
  serverIcons: McpIcon[] = [];
  /** What the server said it has (initialize's `capabilities`). */
  serverCapabilities: {
    tools?: unknown;
    prompts?: unknown;
    resources?: { subscribe?: boolean; listChanged?: boolean } | unknown;
  } = {};
  /** The server sent notifications/resources/updated for a URI (D204). */
  private readonly updated = new Emitter<string>();
  readonly onDidUpdateResource = this.updated.event;
  /** URIs this client subscribed to. */
  readonly subscribed = new Set<string>();
  private readonly changed = new Emitter<void>();
  /** The tool list changed (tools/list_changed). */
  readonly onDidChangeTools = this.changed.event;
  private readonly listsChanged = new Emitter<"prompts" | "resources">();
  /** The prompt or resource list changed (their list_changed), after re-listing. */
  readonly onDidChangeList = this.listsChanged.event;
  /** Re-lists in flight, and whether another notification came meanwhile (listed once more). */
  private readonly relisting = new Map<ListKind, boolean>();
  private disposed = false;

  constructor(
    transport: Transport,
    private readonly clientName: string,
    private readonly onElicit?: ElicitHandler,
    private readonly onSample?: SampleHandler,
  ) {
    this.connection = new RpcConnection(transport);
    this.connection.onNotification("notifications/resources/updated", (params) => {
      const uri = (params as { uri?: unknown } | null)?.uri;
      if (typeof uri === "string" && !this.disposed) this.updated.fire(uri);
    });
    this.connection.onRequest("sampling/createMessage", async (params) => {
      const request = readSamplingRequest(params);
      if (!request) throw new RpcError(-32602, "sampling/createMessage: invalid params");
      if (!this.onSample) throw new RpcError(-32601, "This client doesn't support sampling.");
      const result = await this.onSample(request);
      if (!result) throw new RpcError(SAMPLING_REJECTED.code, SAMPLING_REJECTED.message);
      return result;
    });
    this.connection.onNotification("notifications/tools/list_changed", () => this.relist("tools"));
    this.connection.onNotification("notifications/prompts/list_changed", () =>
      this.relist("prompts"),
    );
    this.connection.onNotification("notifications/resources/list_changed", () =>
      this.relist("resources"),
    );
    this.connection.onRequest("ping", () => ({}));
    this.connection.onRequest("roots/list", () => ({ roots: [] }));
    this.connection.onRequest("elicitation/create", async (params) => {
      const p = (params ?? {}) as ElicitRequest;
      if (!this.onElicit) return { action: "decline" };
      return this.onElicit({
        message: typeof p.message === "string" ? p.message : "",
        requestedSchema: p.requestedSchema,
        ...(typeof p.mode === "string" && { mode: p.mode }),
      });
    });
  }

  /**
   * A list_changed notification: list again. Notifications that arrive while a list is being
   * fetched lead to one more listing afterwards, not one each (servers send them in bursts).
   */
  private relist(kind: ListKind): void {
    if (this.relisting.has(kind)) {
      this.relisting.set(kind, true);
      return;
    }
    this.relisting.set(kind, false);
    const list = () =>
      kind === "tools"
        ? this.listTools()
        : kind === "prompts"
          ? this.listPrompts()
          : this.listResources();
    const run = async (): Promise<void> => {
      try {
        await list();
        if (this.disposed) return;
        if (kind === "tools") this.changed.fire();
        else this.listsChanged.fire(kind);
      } catch {
        // A server that fails to list keeps its old list.
      }
      if (this.relisting.get(kind) && !this.disposed) {
        this.relisting.set(kind, false);
        return run();
      }
      this.relisting.delete(kind);
    };
    void run();
  }

  async start(roots: { uri: string; name: string }[] = []): Promise<void> {
    this.connection.onRequest("roots/list", () => ({ roots }));
    const result = await this.connection.request<{
      serverInfo?: { name?: string; icons?: unknown };
      capabilities?: McpClient["serverCapabilities"];
    }>(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          roots: { listChanged: false },
          ...(this.onElicit && { elicitation: {} }),
          ...(this.onSample && { sampling: {} }),
        },
        clientInfo: { name: this.clientName, version: "1" },
      },
      { timeoutMs: 60000 },
    );
    this.serverName = result?.serverInfo?.name ?? "";
    this.serverIcons = parseIcons(result?.serverInfo?.icons);
    const caps = result?.capabilities;
    this.serverCapabilities = caps && typeof caps === "object" ? caps : {};
    this.connection.notify("notifications/initialized");
    // Tools as before (a failure is the server's failure to start); a server that doesn't claim
    // any may still have some, so it's asked too, and its refusal is just "no tools".
    if (this.serverCapabilities.tools !== undefined || !caps) await this.listTools();
    else await this.listTools().catch(() => []);
    // Prompts and resources are extras: a server that fails to list them still starts.
    await Promise.all([this.listPrompts().catch(() => []), this.listResources().catch(() => [])]);
  }

  /** Every page of a `<kind>/list` (at most 20). */
  private async listAll<T>(method: string, field: string): Promise<T[]> {
    const all: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.connection.request<Record<string, unknown> & { nextCursor?: string }>(
        method,
        cursor ? { cursor } : {},
        { timeoutMs: 30000 },
      );
      const items = r?.[field];
      if (Array.isArray(items)) all.push(...(items as T[]));
      cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return all;
  }

  async listTools(): Promise<McpTool[]> {
    // A tool without a name (null, a number) would throw wherever the agent's tools are built,
    // taking every server's tools down with it.
    const all = await this.listAll<McpTool>("tools/list", "tools");
    this.tools = all.filter((t) => t && typeof t === "object" && typeof t.name === "string");
    return this.tools;
  }

  async listPrompts(): Promise<McpPrompt[]> {
    if (this.serverCapabilities.prompts === undefined) {
      this.prompts = [];
      return this.prompts;
    }
    const all = await this.listAll<McpPrompt>("prompts/list", "prompts");
    this.prompts = all.filter((p) => p && typeof p.name === "string");
    return this.prompts;
  }

  async listResources(): Promise<McpResource[]> {
    if (this.serverCapabilities.resources === undefined) {
      this.resources = [];
      this.resourceTemplates = [];
      return this.resources;
    }
    const all = await this.listAll<McpResource>("resources/list", "resources");
    this.resources = all.filter((r) => r && typeof r.uri === "string");
    // Templates come with the resources (their list_changed covers both); a server without
    // any answers MethodNotFound, which is "none".
    this.resourceTemplates = await this.listAll<McpResourceTemplate>(
      "resources/templates/list",
      "resourceTemplates",
    )
      .then((list) => list.filter((t) => t && typeof t.uriTemplate === "string"))
      .catch(() => []);
    return this.resources;
  }

  /** Whether the server lets clients subscribe to resource updates. */
  get canSubscribe(): boolean {
    const r = this.serverCapabilities.resources;
    return !!r && typeof r === "object" && (r as { subscribe?: unknown }).subscribe === true;
  }

  /** Asks for notifications/resources/updated about `uri` (D204). */
  async subscribe(uri: string): Promise<boolean> {
    if (!this.canSubscribe) return false;
    if (this.subscribed.has(uri)) return true;
    await this.connection.request("resources/subscribe", { uri }, { timeoutMs: 30000 });
    this.subscribed.add(uri);
    return true;
  }

  async unsubscribe(uri: string): Promise<void> {
    if (!this.subscribed.delete(uri) || this.disposed) return;
    await this.connection
      .request("resources/unsubscribe", { uri }, { timeoutMs: 30000 })
      .catch(() => {});
  }

  getPrompt(
    name: string,
    args: Record<string, string>,
  ): Promise<{ description?: string; messages?: McpPromptMessage[] }> {
    return this.connection.request("prompts/get", { name, arguments: args }, { timeoutMs: 60000 });
  }

  readResource(uri: string): Promise<{
    contents?: { uri?: string; mimeType?: string; text?: string; blob?: string }[];
  }> {
    return this.connection.request("resources/read", { uri }, { timeoutMs: 60000 });
  }

  async call(name: string, args: unknown, timeoutMs = 300000): Promise<McpCallResult> {
    const r = await this.connection.request<{
      content?: {
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
        resource?: { text?: string; uri?: string; blob?: string; mimeType?: string };
      }[];
      structuredContent?: unknown;
      isError?: boolean;
    }>("tools/call", { name, arguments: args ?? {} }, { timeoutMs });
    // Images (an image part, or an embedded image resource) come back as images (D381).
    const images: { mime: string; data: string }[] = [];
    const parts: string[] = [];
    // A server's reply as it is: content that isn't a list, or parts that aren't objects, are skipped.
    for (const c of Array.isArray(r?.content) ? r.content : []) {
      if (!c || typeof c !== "object") continue;
      if (c.type === "text") parts.push(c.text ?? "");
      else if (c.type === "image" && typeof c.data === "string")
        images.push({ mime: c.mimeType || "image/png", data: c.data });
      else if (
        c.type === "resource" &&
        c.resource?.blob &&
        c.resource.mimeType?.startsWith("image/")
      )
        images.push({ mime: c.resource.mimeType, data: c.resource.blob });
      else if (c.type === "resource")
        parts.push(c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`);
      else parts.push(`[${c.type}]`);
    }
    if (parts.length === 0 && r?.structuredContent !== undefined)
      parts.push(JSON.stringify(r.structuredContent));
    return {
      text: parts.join("\n"),
      isError: r?.isError === true,
      ...(images.length > 0 && { images }),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.connection.dispose();
    this.changed.dispose();
    this.listsChanged.dispose();
    this.updated.dispose();
  }
}

/** MCP tool names allow [a-zA-Z0-9_-], ≤ 64 characters; ours are "mcp__<server>__<tool>". */
export function agentToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}
