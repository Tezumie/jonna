// The MCP registry from New MCP server (D207): searching registry.modelcontextprotocol.io (or
// `agent.mcp.registryUrl`; empty: don't) through the IDE's web fetch path (Rust `web_fetch`, as
// @docs and the agent's web_fetch use), with the built-in gallery as the offline list.
// Entries found are kept for this window so agent.installMcpServer can install them by id;
// an entry from the registry isn't vetted, so a person installing one sees what it runs first.
// Command: agent.searchMcpRegistry. Parsing is core/mcp/registry.ts.
import { aiIpc } from "../../core/ipc/agent";
import type { DisposableStore } from "../../core/lifecycle/index";
import { type GalleryEntry, galleryEntry, searchGallery } from "../../core/mcp/gallery";
import {
  parseRegistryList,
  parseRegistryServer,
  registryBase,
  registryEntry,
  registryRefusal,
  registrySearchUrl,
  registryServerUrl,
} from "../../core/mcp/registry";
import { s } from "../../core/schema/index";
import type { WorkbenchServices } from "../../workbench/services";

export interface RegistryHit extends GalleryEntry {
  /** The registry's name for it ("io.github.acme/weather"). */
  registryName: string;
}

/** What the last searches found, by id (installable by agent.installMcpServer { id }). */
const found = new Map<string, RegistryHit>();

export function registryHit(id: string): RegistryHit | undefined {
  return found.get(id);
}

function base(services: WorkbenchServices): string | null {
  const setting = services.settings.peek<unknown>("agent.mcp.registryUrl");
  if (setting === "") return null;
  return registryBase(setting);
}

async function fetchJson(url: string): Promise<unknown> {
  const page = await aiIpc.webFetch(url, 2_000_000);
  if (page.status >= 400) throw new Error(`the registry answered ${page.status}`);
  try {
    return JSON.parse(page.text) as unknown;
  } catch {
    throw new Error("the registry's answer isn't JSON");
  }
}

const keep = (name: string, entry: GalleryEntry): RegistryHit => {
  // Two registry servers with the same last segment: the second gets its owner's name too. So
  // does one named like a built-in server: installing by id would install the built-in one
  // (agent.installMcpServer looks there first), not the entry the user picked.
  let id = entry.id;
  const taken = found.get(id);
  if ((taken && taken.registryName !== name) || galleryEntry(id))
    id = `${name.split("/")[0]?.split(".").pop() ?? "x"}-${entry.id}`.slice(0, 64);
  const hit = { ...entry, id, registryName: name };
  found.set(id, hit);
  return hit;
};

/** Servers matching `query` in the registry; the built-in list when it can't be reached. */
export async function searchRegistry(
  services: WorkbenchServices,
  query: string,
  limit = 30,
): Promise<{
  servers: RegistryHit[] | GalleryEntry[];
  source: "registry" | "builtin";
  error?: string;
  /** Servers left out for a runner option the IDE refuses (D223: `--privileged`, `-v /:/host`). */
  refused?: { name: string; reason: string }[];
}> {
  const at = base(services);
  if (!at)
    return {
      servers: searchGallery(query),
      source: "builtin",
      error: "registry search is off (agent.mcp.registryUrl)",
    };
  try {
    const list = parseRegistryList(await fetchJson(registrySearchUrl(at, query, limit)));
    const servers = list.flatMap((server) => {
      const entry = registryEntry(server);
      return entry ? [keep(server.name, entry)] : [];
    });
    const refused = list.flatMap((server) => {
      const reason = registryEntry(server) ? null : registryRefusal(server);
      return reason ? [{ name: server.name, reason }] : [];
    });
    return { servers, source: "registry", ...(refused.length && { refused }) };
  } catch (err) {
    return {
      servers: searchGallery(query),
      source: "builtin",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** One registry server by its registry name (for an install of something not searched for). */
export async function lookUpRegistry(
  services: WorkbenchServices,
  name: string,
): Promise<RegistryHit | null> {
  const at = base(services);
  if (!at) return null;
  const server = parseRegistryServer(await fetchJson(registryServerUrl(at, name)));
  const entry = server ? registryEntry(server) : null;
  return server && entry ? keep(server.name, entry) : null;
}

export function registerMcpRegistry(sub: DisposableStore, services: WorkbenchServices): void {
  sub.add(
    services.dispatcher.register({
      id: "agent.searchMcpRegistry",
      title: "Search the MCP registry",
      category: "Agent",
      description:
        "Searches the official MCP registry (registry.modelcontextprotocol.io, or agent.mcp.registryUrl) for servers matching `query`: id, title, what it does, local (npx, uvx, docker) or remote, what it runs. Install one with agent.installMcpServer { id }. Without network (or with agent.mcp.registryUrl empty) it searches the built-in list instead and says so.",
      input: s.object({
        query: s.string(),
        limit: s.integer({ min: 1, max: 100 }).optional(),
      }),
      effects: ["network"],
      agent: "discoverable",
      palette: false,
      run: async ({ query, limit }) => {
        const r = await searchRegistry(services, query, limit ?? 30);
        return {
          source: r.source,
          ...(r.refused && { refused: r.refused }),
          ...(r.error && {
            note: `The registry couldn't be searched (${r.error}): the built-in list instead.`,
          }),
          servers: r.servers.map((e) => ({
            id: e.id,
            title: e.title,
            description: e.description,
            kind: e.kind,
            ...("registryName" in e && { registryName: e.registryName }),
            runs: e.config.url ?? [e.config.command, ...(e.config.args ?? [])].join(" "),
            ...(e.needs && { needs: e.needs }),
            ...(e.inputs?.length && { inputs: e.inputs.map((i) => i.description) }),
            ...(e.warnings?.length && { warnings: e.warnings }),
          })),
        };
      },
    }),
  );
}
