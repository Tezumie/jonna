// What MCP servers offer besides tools (D200): prompts as slash commands in the composer
// (`/mcp__<server>__<prompt> args`), resources as @-mentions (`@mcp <server> <uri>`), the
// `agent.mcpResources` / `agent.mcpPrompts` commands, and elicitation — a server asking the user
// for input, answered in quick inputs: the server's message with Answer / Decline (Esc cancels),
// then one box per field, checked against the server's schema.

import type { DisposableStore } from "../../core/lifecycle/index";
import {
  acceptContent,
  type ElicitField,
  type ElicitRequest,
  type ElicitResult,
  elicitFields,
  fieldPrompt,
  parseFieldValue,
} from "../../core/mcp/elicitation";
import {
  argumentHint,
  parsePromptArgs,
  parseResourceMention,
  promptCommandName,
  promptContext,
  resourceContext,
  resourceLabel,
  resourceMention,
} from "../../core/mcp/prompts";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";
import { registerMentionSource, registerSlashSource } from "./composerExtras";
import type { McpClients } from "./mcp";
import { fillTemplate, isTemplate, registerResourceWatch } from "./mcpResources";
import type { AgentSession } from "./session";
import type { SessionManager } from "./sessions";

const SKIP = "#skip";

/** Asks the user what a server's `elicitation/create` wants (quick inputs, one at a time). */
async function askElicitation(
  services: WorkbenchServices,
  server: string,
  request: ElicitRequest,
): Promise<ElicitResult> {
  const { quickInput } = services;
  // Only forms: the URL mode of later revisions (sign in on a page) isn't supported yet.
  if (request.mode && request.mode !== "form") return { action: "decline" };
  let fields: ElicitField[];
  try {
    fields = elicitFields(request.requestedSchema);
  } catch (err) {
    services.notifications.show(
      "warning",
      `MCP server ${server} asked for something the IDE can't show (${err instanceof Error ? err.message : String(err)}); declined.`,
    );
    return { action: "decline" };
  }
  const message = request.message.replace(/\s+/g, " ").trim().slice(0, 300);
  const first = await quickInput.pick(
    [
      {
        id: "accept",
        label: fields.length ? "Answer…" : "Accept",
        description: fields.length ? fields.map((f) => f.label).join(", ") : "",
      },
      { id: "decline", label: "Decline", description: "The server is told you said no" },
    ],
    { placeholder: `MCP server ${server} asks: ${message || "a question"}` },
  );
  if (!first) return { action: "cancel" };
  if (first.id === "decline") return { action: "decline" };
  const values: Record<string, string | number | boolean | undefined> = {};
  for (const field of fields) {
    const title = `${server}: ${fieldPrompt(field)}`;
    if (field.kind === "boolean" || field.kind === "enum") {
      const options =
        field.kind === "boolean"
          ? [
              { id: "true", label: "Yes" },
              { id: "false", label: "No" },
            ]
          : (field.options ?? []).map((o) => ({ id: o.value, label: o.label }));
      // The default first, so Enter takes it.
      const preferred = field.default === undefined ? undefined : String(field.default);
      options.sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred));
      const picked = await quickInput.pick(
        [...options, ...(field.required ? [] : [{ id: SKIP, label: "Leave empty" }])],
        { placeholder: title },
      );
      if (!picked) return { action: "cancel" };
      if (picked.id === SKIP) continue;
      values[field.name] = field.kind === "boolean" ? picked.id === "true" : picked.id;
      continue;
    }
    const typed = await quickInput.prompt({
      prompt: `${title} (don't enter passwords or keys here)`,
      ...(field.default !== undefined && { value: String(field.default) }),
      validate: (v) => parseFieldValue(field, v).error,
    });
    if (typed === undefined) return { action: "cancel" };
    const parsed = parseFieldValue(field, typed);
    if (parsed.error) return { action: "cancel" };
    values[field.name] = parsed.value;
  }
  return acceptContent(fields, values);
}

export function registerMcpFeatures(
  sub: DisposableStore,
  services: WorkbenchServices,
  sessions: SessionManager,
  clients: McpClients,
): void {
  // Elicitations one at a time: a second quick input would close the first. One waiting per
  // server: a server that asks again before its question is answered gets "decline" (a
  // misbehaving one can't pile up dialogs), and what still waits when this goes is declined.
  let queue: Promise<unknown> = Promise.resolve();
  const waiting = new Set<string>();
  let disposed = false;
  clients.elicit = (server, request) => {
    if (disposed || waiting.has(server)) return Promise.resolve({ action: "decline" as const });
    waiting.add(server);
    const next = queue
      .then(() =>
        disposed ? { action: "decline" as const } : askElicitation(services, server, request),
      )
      .finally(() => waiting.delete(server));
    queue = next.catch(() => {});
    return next;
  };
  sub.add({
    dispose: () => {
      disposed = true;
      clients.elicit = async () => ({ action: "decline" });
    },
  });

  const findPrompt = (command: string) => {
    for (const { name, client } of clients.runningServers())
      for (const p of client.prompts)
        if (promptCommandName(name, p.name) === command) return { server: name, client, prompt: p };
    return null;
  };
  const findServer = (server: string) =>
    clients.runningServers().find((r) => r.name === server)?.client;

  // Prompts as slash commands.
  sub.add(
    registerSlashSource({
      list: () =>
        clients.runningServers().flatMap(({ name, client }) =>
          client.prompts.map((p) => {
            const hint = argumentHint(p);
            const about = p.title ?? p.description ?? p.name;
            return {
              name: promptCommandName(name, p.name),
              description: `${about}${hint ? ` ${hint}` : ""}`.slice(0, 120),
              source: `MCP ${name}`,
            };
          }),
        ),
      expand: async (command, args, session) => {
        if (!command.startsWith("mcp__")) return null;
        let found = findPrompt(command);
        if (!found) {
          // The servers start with the first message: start them, then look again.
          await clients.ensure(session).catch(() => {});
          found = findPrompt(command);
        }
        if (!found) return null;
        const { values, missing } = parsePromptArgs(found.prompt, args);
        for (const name of missing) {
          const arg = found.prompt.arguments?.find((a) => a.name === name);
          const typed = await services.quickInput.prompt({
            prompt: `/${command}: ${arg?.description ?? name}`,
            placeholder: name,
          });
          if (!typed?.trim()) throw new Error(`/${command} needs ${name}.`);
          values[name] = typed.trim();
        }
        const result = await found.client.getPrompt(found.prompt.name, values);
        return promptContext(found.server, found.prompt.name, result);
      },
    }),
  );

  // Resource templates and subscriptions (D204).
  const watch = registerResourceWatch(sub, services, clients, sessions);
  const askVariable = (server: string, template: string) => async (name: string) => {
    const typed = await services.quickInput.prompt({
      prompt: `${server}: ${template} — ${name}`,
      placeholder: name,
    });
    return typed === undefined || typed === null ? null : typed;
  };

  // Resources as @-mentions.
  const readResource = async (server: string, uri: string, session?: AgentSession) => {
    let client = findServer(server);
    if (!client) {
      await clients.ensure(session ?? sessions.find(undefined) ?? undefined).catch(() => {});
      client = findServer(server);
    }
    if (!client) throw new Error(`MCP server ${server} isn't running.`);
    return client.readResource(uri);
  };
  sub.add(
    registerMentionSource({
      prefix: "@mcp ",
      icon: "server",
      items: (query) => {
        const q = query.trim().toLowerCase().replace(/^@/, "");
        const out = clients.runningServers().flatMap(({ name, client }) => [
          ...client.resources
            .filter(
              (r) =>
                !q || `${name} ${r.uri} ${r.name ?? ""} ${r.title ?? ""}`.toLowerCase().includes(q),
            )
            .map((r) => ({
              id: resourceMention(name, r.uri),
              label: resourceLabel(r),
              description: `MCP ${name} · ${r.description ?? r.uri}`.slice(0, 120),
              icon: "server" as const,
            })),
          // Templates: their variables are asked when the message is sent (D204).
          ...client.resourceTemplates
            .filter(
              (t) =>
                !q ||
                `${name} ${t.uriTemplate} ${t.name ?? ""} ${t.title ?? ""}`
                  .toLowerCase()
                  .includes(q),
            )
            .map((t) => ({
              id: resourceMention(name, t.uriTemplate),
              label: `${t.title ?? t.name ?? t.uriTemplate} (fill in)`,
              description: `MCP ${name} · ${t.description ?? t.uriTemplate}`.slice(0, 120),
              icon: "server" as const,
            })),
        ]);
        return out.slice(0, 30);
      },
      label: (mention) => {
        const m = parseResourceMention(mention);
        if (!m) return mention;
        const client = findServer(m.server);
        const r = client?.resources.find((x) => x.uri === m.uri);
        const t = client?.resourceTemplates.find((x) => x.uriTemplate === m.uri);
        if (t) return `${t.title ?? t.name ?? t.uriTemplate} (fill in)`;
        return resourceLabel(r ?? { uri: m.uri });
      },
      context: async (mention, session) => {
        const m = parseResourceMention(mention);
        if (!m) return `${mention}: not an MCP resource.`;
        let uri = m.uri;
        try {
          if (isTemplate(uri)) uri = await fillTemplate(uri, {}, askVariable(m.server, m.uri));
          const text = resourceContext(m.server, uri, await readResource(m.server, uri, session));
          // Watched from now on: a change reaches this chat's next message.
          const subscribed = session ? await watch.attached(m.server, uri, session.id) : false;
          return subscribed
            ? `${text}\n\n(The IDE follows this resource: if it changes, its new text comes with the next message.)`
            : text;
        } catch (err) {
          return `MCP resource ${uri} from ${m.server} (couldn't be read: ${err instanceof Error ? err.message : String(err)})`;
        }
      },
    }),
  );

  const { dispatcher } = services;
  sub.add(
    dispatcher.register({
      id: "agent.mcpResources",
      title: "MCP resources",
      category: "Agent",
      description:
        "Lists the resources and resource templates the running MCP servers offer (server, uri or uriTemplate, name, description), or with `uri` reads one and returns its text. A template's `uri` is filled in from `values` (variable → value). `subscribe` true follows it: when it changes, its new text comes with the chat's next message. The user can also @-mention them in the message box. `server` narrows the list or says whose resource `uri` is.",
      input: s.object({
        server: s.string().optional(),
        uri: s.string().describe("A resource (or a template) to read").optional(),
        values: s.unknown().describe("A template's variables (name → string)").optional(),
        subscribe: s.boolean().optional(),
      }),
      effects: ["read"],
      agent: "discoverable",
      run: async ({ server, uri: wanted, values, subscribe }, ctx) => {
        const running = clients.runningServers().filter((r) => !server || r.name === server);
        if (!wanted)
          return {
            resources: running.flatMap(({ name, client }) =>
              client.resources.map((r) => ({
                server: name,
                uri: r.uri,
                ...(r.name && { name: r.name }),
                ...(r.description && { description: r.description }),
                ...(r.mimeType && { mimeType: r.mimeType }),
              })),
            ),
            templates: running.flatMap(({ name, client }) =>
              client.resourceTemplates.map((t) => ({
                server: name,
                uriTemplate: t.uriTemplate,
                ...(t.name && { name: t.name }),
                ...(t.description && { description: t.description }),
              })),
            ),
            ...(!clients.runningServers().length && {
              note: "No MCP server is running yet: they start with the agent's first message.",
            }),
          };
        const owner =
          server ??
          running.find(
            ({ client }) =>
              client.resources.some((r) => r.uri === wanted) ||
              client.resourceTemplates.some((t) => t.uriTemplate === wanted),
          )?.name;
        if (!owner) throw new Error(`No running MCP server lists ${wanted}; give \`server\`.`);
        const given: Record<string, string> = {};
        if (values && typeof values === "object")
          for (const [k, v] of Object.entries(values)) if (typeof v === "string") given[k] = v;
        const uri = isTemplate(wanted)
          ? await fillTemplate(wanted, given, async (name) => {
              if (ctx.caller.kind !== "user") throw new Error(`Give ${name} in \`values\`.`);
              return askVariable(owner, wanted)(name);
            })
          : wanted;
        // MCP protection (D179): reading asks too, like read-only tools.
        const caller = ctx.caller;
        const session =
          caller.kind === "agent" || caller.kind === "acp"
            ? (sessions.find(caller.session) ?? undefined)
            : undefined;
        if (session && services.settings.peek<boolean>("agent.mcpProtection") === true) {
          const answer = await session.ask({
            title: `Read ${uri} from MCP server ${owner}`,
            heading: "Read an MCP resource",
            code: uri,
            kind: "tool",
            evenWithFullAccess: true,
          });
          if (answer === "deny") throw new Error("The user denied reading this resource.");
        }
        const result = await readResource(owner, uri, session);
        const target = session ?? sessions.find(undefined);
        const subscribed =
          subscribe && target ? await watch.attached(owner, uri, target.id) : false;
        return {
          server: owner,
          uri,
          text: resourceContext(owner, uri, result),
          ...(subscribe && { subscribed }),
        };
      },
    }),
  );
  sub.add(
    dispatcher.register({
      id: "agent.mcpPrompts",
      title: "MCP prompts",
      category: "Agent",
      description:
        "Lists the prompts the running MCP servers offer, as the slash commands they are in the agent's message box (`/mcp__<server>__<prompt>`), or with `command` returns that prompt's text for `arguments` (name → value).",
      input: s.object({
        command: s.string().describe("mcp__<server>__<prompt>").optional(),
        arguments: s.unknown().describe("Argument values (name → string)").optional(),
      }),
      effects: ["read"],
      agent: "hidden",
      run: async ({ command, arguments: raw }) => {
        if (!command)
          return {
            prompts: clients.runningServers().flatMap(({ name, client }) =>
              client.prompts.map((p) => ({
                command: `/${promptCommandName(name, p.name)}`,
                server: name,
                name: p.name,
                ...(p.description && { description: p.description }),
                arguments: (p.arguments ?? []).map((a) => ({
                  name: a.name,
                  required: a.required === true,
                })),
              })),
            ),
          };
        const found = findPrompt(command.replace(/^\//, ""));
        if (!found) throw new Error(`No running MCP server has the prompt ${command}.`);
        const values: Record<string, string> = {};
        if (raw && typeof raw === "object")
          for (const [k, v] of Object.entries(raw)) if (typeof v === "string") values[k] = v;
        const missing = (found.prompt.arguments ?? [])
          .filter((a) => a.required && !values[a.name])
          .map((a) => a.name);
        if (missing.length) throw new Error(`${command} needs ${missing.join(", ")}.`);
        const result = await found.client.getPrompt(found.prompt.name, values);
        return { text: promptContext(found.server, found.prompt.name, result) };
      },
    }),
  );
}
