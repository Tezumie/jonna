// Deferred tools and tool_search (D319, like Claude Code's ToolSearch): with many MCP tools, their
// schemas fill the prompt before the agent has done anything. Deferred tools reach the model as a
// list of names with a short line each; `tool_search` returns the full definitions of the ones it
// asks for (by name, or by keywords) and from then on they're part of the chat's tool list. What a
// chat loaded is read back from its own tool_search results, so a rewind unloads what it removes,
// a summary keeps them (the items stay), and nothing else has to be saved. DOM-free; tested.

import type { ToolSpec } from "../ipc/agent";

export const TOOL_SEARCH = "tool_search";

export type DeferMode = "auto" | "always" | "never";

/** auto: deferred above this many MCP tools… */
export const AUTO_TOOL_COUNT = 30;
/** …or when their definitions add up to more than this (characters, ~6k tokens). */
export const AUTO_TOOL_CHARS = 25_000;

export const DEFAULT_MAX_RESULTS = 5;

/**
 * agent.deferTools, with D204's agent.mcp.toolSchemas read when the new one is left on auto
 * (onDemand: always, full: never).
 */
export function deferMode(value: unknown, legacy?: unknown): DeferMode {
  if (value === "always" || value === "never") return value;
  if (legacy === "onDemand") return "always";
  if (legacy === "full") return "never";
  return "auto";
}

/** Whether tools this many and this big are deferred. */
export function shouldDefer(mode: DeferMode, count: number, chars: number): boolean {
  if (count === 0 || mode === "never") return false;
  if (mode === "always") return true;
  return count > AUTO_TOOL_COUNT || chars > AUTO_TOOL_CHARS;
}

/** A tool's first sentence, short: what the deferred list says about it. */
export function shortDescription(description: string, max = 80): string {
  const line = description.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/**
 * The note with the request (the system message's tail): the deferred tools by name, and how to
 * load them. Empty when nothing is deferred.
 */
export function deferredToolsNote(
  tools: readonly Pick<ToolSpec, "name" | "description">[],
): string {
  if (!tools.length) return "";
  const lines = tools.map((t) => `- ${t.name}: ${shortDescription(t.description)}`);
  return `Deferred tools (only their names are known; load a tool's definition with ${TOOL_SEARCH} before calling it):
${lines.join("\n")}`;
}

export function toolSearchSpec(): ToolSpec {
  return {
    name: TOOL_SEARCH,
    description: `Fetches the full definitions of deferred tools (listed by name in the system prompt) so they can be called; until then a deferred tool has no parameters and can't be used. Query forms: "select:a,b" loads these exact tools; "notebook jupyter" is a keyword search, up to max_results best matches; "+slack send" requires "slack" in the name and ranks by the rest. Once a tool's definition is in the result it's callable like any other tool, for the rest of the chat.`,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: '"select:name1,name2", or keywords ("+word" must be in the name)',
        },
        max_results: {
          type: "integer",
          description: `How many keyword matches to load (default ${DEFAULT_MAX_RESULTS})`,
        },
      },
      required: ["query"],
    },
  };
}

export type ToolQuery =
  | { kind: "select"; names: string[] }
  | { kind: "keywords"; required: string[]; terms: string[] };

export function parseToolQuery(query: string): ToolQuery {
  const q = query.trim();
  const select = /^select:(.*)$/is.exec(q);
  if (select)
    return {
      kind: "select",
      names: (select[1] ?? "")
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean),
    };
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    kind: "keywords",
    required: words.filter((w) => w.startsWith("+") && w.length > 1).map((w) => w.slice(1)),
    terms: words.filter((w) => !w.startsWith("+")),
  };
}

/** A tool name's words: `mcp__github__createIssue` → mcp, github, create, issue. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function score(tool: Pick<ToolSpec, "name" | "description">, terms: readonly string[]): number {
  const name = tool.name.toLowerCase();
  const words = nameWords(tool.name);
  const description = tool.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (words.includes(term)) total += 4;
    else if (name.includes(term)) total += 2;
    if (description.includes(term)) total += 1;
  }
  return total;
}

export interface ToolSearchMatch<T> {
  matches: T[];
  /** select: names that aren't deferred tools (with close names to suggest). */
  unknown: string[];
  suggestions: string[];
}

/** The deferred tools a query picks, best first. */
export function searchTools<T extends Pick<ToolSpec, "name" | "description">>(
  query: string,
  tools: readonly T[],
  maxResults = DEFAULT_MAX_RESULTS,
): ToolSearchMatch<T> {
  const parsed = parseToolQuery(query);
  if (parsed.kind === "select") {
    const matches: T[] = [];
    const unknown: string[] = [];
    for (const wanted of parsed.names) {
      const tool =
        tools.find((t) => t.name === wanted) ??
        tools.find((t) => t.name.toLowerCase() === wanted.toLowerCase());
      if (!tool) unknown.push(wanted);
      else if (!matches.includes(tool)) matches.push(tool);
    }
    const suggestions = unknown.length
      ? tools
          .filter((t) =>
            unknown.some((u) =>
              t.name.toLowerCase().includes(u.toLowerCase().replace(/^mcp__/, "")),
            ),
          )
          .map((t) => t.name)
          .slice(0, 5)
      : [];
    return { matches, unknown, suggestions };
  }
  const max = Math.max(1, Math.min(50, Math.floor(maxResults)));
  // A query that is one tool's exact name loads that tool.
  const exact = tools.find((t) => t.name.toLowerCase() === query.trim().toLowerCase());
  if (exact) return { matches: [exact], unknown: [], suggestions: [] };
  const eligible = tools.filter((t) => {
    const name = t.name.toLowerCase();
    return parsed.required.every((r) => name.includes(r));
  });
  const ranked = eligible
    .map((t) => ({ t, s: score(t, parsed.terms) }))
    // Only required words: every tool that has them, by name.
    .filter((x) => x.s > 0 || (parsed.terms.length === 0 && parsed.required.length > 0))
    .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name));
  return { matches: ranked.slice(0, max).map((x) => x.t), unknown: [], suggestions: [] };
}

/** One loaded definition as tool_search returns it: the name first (`loadedToolNames` reads it). */
export function functionBlock(spec: ToolSpec): string {
  return `<function>${JSON.stringify({ name: spec.name, description: spec.description, parameters: spec.parameters })}</function>`;
}

/** tool_search's answer. */
export function toolSearchResult(
  query: string,
  found: ToolSearchMatch<ToolSpec>,
  deferredNames: readonly string[],
): string {
  const parts: string[] = [];
  if (found.matches.length)
    parts.push(
      `<functions>\n${found.matches.map(functionBlock).join("\n")}\n</functions>`,
      `Loaded: ${found.matches.map((t) => t.name).join(", ")}. Call them like any other tool from your next step.`,
    );
  if (found.unknown.length)
    parts.push(
      `Not deferred tools: ${found.unknown.join(", ")}.${found.suggestions.length ? ` Did you mean ${found.suggestions.join(", ")}?` : ""}`,
    );
  if (!found.matches.length && !found.unknown.length)
    parts.push(
      `No deferred tool matches "${query.trim()}". Deferred tools: ${deferredNames.slice(0, 60).join(", ")}${deferredNames.length > 60 ? ", …" : ""}.`,
    );
  return parts.join("\n\n");
}

const LOADED = /<function>\{"name":"((?:[^"\\]|\\.)+)"/g;

/** The tools a conversation loaded: the definitions its successful tool_search calls returned. */
export function loadedToolNames(
  items: readonly { type: string; name?: string; status?: string; result?: string }[],
): Set<string> {
  const names = new Set<string>();
  for (const it of items) {
    if (it.type !== "tool" || it.name !== TOOL_SEARCH || it.status !== "done" || !it.result)
      continue;
    for (const m of it.result.matchAll(LOADED)) {
      try {
        names.add(JSON.parse(`"${m[1] ?? ""}"`) as string);
      } catch {
        // not a name we wrote
      }
    }
  }
  return names;
}

/**
 * The turn's tool list after a tool_search: the list it started with (kept as it was, for the
 * prompt cache), then the tools loaded since, in the order they're offered now.
 */
export function withLoadedTools(
  turn: readonly ToolSpec[],
  current: readonly ToolSpec[],
  loaded: ReadonlySet<string>,
): ToolSpec[] {
  const have = new Set(turn.map((t) => t.name));
  const added = current.filter((t) => loaded.has(t.name) && !have.has(t.name));
  return added.length ? [...turn, ...added] : (turn as ToolSpec[]);
}

/** What a call of a deferred tool that wasn't loaded gets back. */
export function notLoadedMessage(name: string): string {
  return `Error: ${name} is a deferred tool and its definition isn't loaded, so it didn't run. Load it with ${TOOL_SEARCH} {"query": "select:${name}"}, then call it.`;
}
