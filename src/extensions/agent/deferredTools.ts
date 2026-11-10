// Deferred tools (D319): with many MCP tools (agent.deferTools), a chat's requests carry their
// names only (a note after the system prompt) and `tool_search`, which loads the definitions the
// agent asks for. What a chat loaded is read from its own tool_search results (core/agent/
// toolSearch.ts), so it's kept with the chat, across turns and summaries, and a rewind unloads it.
// D390: the IDE's own tools that most turns never use (ON_DEMAND_TOOLS) are deferred the same way,
// as Claude Code defers its own (its worktree, cron and monitor tools): about 20k characters each
// request didn't need. Unlike an MCP tool, one of them called by name without a search just runs
// (the IDE's own messages name save_image and chat_attachments with their arguments), and from
// then on it's loaded in that chat. What every turn uses, and what the IDE's prompts ask for by
// name (wrap_up, report_findings, schedule_wakeup, widget_guide), is always offered; the browser
// tools only while a browser tab is open (browserTools.ts). agent.deferTools "never" sends all.

import type { Item } from "../../core/agent/conversation";
import type { ToolOutcome } from "../../core/agent/loop";
import {
  DEFAULT_MAX_RESULTS,
  deferMode,
  deferredToolsNote,
  loadedToolNames,
  notLoadedMessage,
  searchTools,
  shouldDefer,
  TOOL_SEARCH,
  toolSearchResult,
  toolSearchSpec,
} from "../../core/agent/toolSearch";
import type { WorkbenchServices } from "../../workbench/services";
import type { AgentTool } from "./tools";

/** The IDE's own tools that load on demand (D390): few turns use them. */
export const ON_DEMAND_TOOLS: ReadonlySet<string> = new Set([
  // Background and cross-chat work.
  "run_workflow",
  "monitor",
  "schedule",
  "watch_pr",
  "hand_off_task",
  "message_chat",
  "list_chats",
  "search_chats",
  "enter_worktree",
  "exit_worktree",
  // Images.
  "generate_image",
  "save_image",
  "chat_attachments",
  // Suggestions and the IDE's own docs.
  "suggest_skill",
  "suggest_extension",
  "suggest_mcp_server",
  "mcp_status",
  "read_guide",
]);

/**
 * The deferred tools a chat has loaded: the ones its tool_search results gave, and on-demand
 * built-ins it called by name (D390).
 */
export function loadedTools(items: readonly Item[]): Set<string> {
  const names = loadedToolNames(items);
  for (const it of items)
    if (it.type === "tool" && ON_DEMAND_TOOLS.has(it.name)) names.add(it.name);
  return names;
}

export interface ToolSplit {
  /** What the requests offer: the tools not deferred, the loaded ones, and tool_search. */
  tools: AgentTool[];
  /** Deferred and not loaded yet: named in the note only. */
  deferred: AgentTool[];
}

function toolSearchTool(catalog: readonly AgentTool[]): AgentTool {
  return {
    spec: toolSearchSpec(),
    readOnly: true,
    verb: "Loaded tools",
    target: (a) => String(a.query ?? ""),
    async run(args): Promise<ToolOutcome> {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query)
        return { result: 'Error: "query" is required ("select:name" or keywords).', isError: true };
      const max = typeof args.max_results === "number" ? args.max_results : DEFAULT_MAX_RESULTS;
      const found = searchTools(
        query,
        catalog.map((t) => t.spec),
        max,
      );
      const result = toolSearchResult(
        query,
        found,
        catalog.map((t) => t.spec.name),
      );
      const n = found.matches.length;
      return {
        result,
        summary: n ? `${n} loaded` : "no match",
        detail: found.matches.map((t) => t.name).join("\n"),
      };
    },
  };
}

/** How the chat's rows show a tool_search call ("Loaded tools select:…"). */
export const TOOL_SEARCH_ROW: AgentTool = toolSearchTool([]);

/** Splits a turn's tools into the ones its requests offer and the deferred ones. */
export function splitDeferred(
  services: WorkbenchServices,
  tools: AgentTool[],
  items: readonly Item[],
): ToolSplit {
  const mode = deferMode(
    services.settings.peek<unknown>("agent.deferTools"),
    services.settings.peek<unknown>("agent.mcp.toolSchemas"),
  );
  if (mode === "never") return { tools, deferred: [] };
  const mcp = tools.filter((t) => t.mcp);
  const deferMcp = shouldDefer(mode, mcp.length, JSON.stringify(mcp.map((t) => t.spec)).length);
  const candidates = tools.filter(
    (t) => (t.mcp && deferMcp) || (!t.mcp && ON_DEMAND_TOOLS.has(t.spec.name)),
  );
  if (!candidates.length) return { tools, deferred: [] };
  const loaded = loadedTools(items);
  const search = toolSearchTool(candidates);
  const sent: AgentTool[] = [];
  const deferred: AgentTool[] = [];
  for (const t of tools) {
    // tool_search goes where the first deferred tool was: the list's order stays the same.
    if (t === candidates[0]) sent.push(search);
    if (candidates.includes(t) && !loaded.has(t.spec.name)) deferred.push(t);
    else sent.push(t);
  }
  return { tools: sent, deferred };
}

/** The note that names the deferred tools (empty: none). */
export function deferredNote(split: ToolSplit): string {
  return deferredToolsNote(split.deferred.map((t) => t.spec));
}

/** For ide://agent/session: the deferred tools and the ones the chat loaded (nothing: none). */
export function deferredState(session: { splitTools(): ToolSplit; items: readonly Item[] }): {
  deferredTools?: string[];
  loadedTools?: string[];
} {
  const split = session.splitTools();
  if (!split.tools.some((t) => t.spec.name === TOOL_SEARCH)) return {};
  return {
    deferredTools: split.deferred.map((t) => t.spec.name),
    loadedTools: [...loadedTools(session.items)],
  };
}

/**
 * A call of a deferred MCP tool that wasn't loaded: the error saying how to load it (else null).
 * An on-demand built-in (D390) just runs: its name is ours and it checks its own arguments.
 */
export function notLoaded(split: ToolSplit, name: string): ToolOutcome | null {
  if (name === TOOL_SEARCH || ON_DEMAND_TOOLS.has(name)) return null;
  if (!split.deferred.some((t) => t.spec.name === name)) return null;
  return { result: notLoadedMessage(name), isError: true, summary: "not loaded" };
}
