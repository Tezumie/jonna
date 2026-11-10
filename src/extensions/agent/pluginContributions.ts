// What the installed and enabled Claude Code plugins bring (D358), for the places that read the
// IDE's own commands, skills, subagents, hooks and MCP servers: each plugin's folders and its
// hooks and servers (`${CLAUDE_PLUGIN_ROOT}` already resolved; only the ones the user allowed at
// install). Kept apart from plugins.ts so those places don't load the plugin manager.
import type { PluginLspServer } from "../../core/agent/plugins";
import { signal } from "../../core/reactive/index";

export interface ActivePlugin {
  /** `name@marketplace`. */
  id: string;
  name: string;
  /** Its folder (`${CLAUDE_PLUGIN_ROOT}`). */
  dir: string;
  /** Absolute folders of its slash commands, subagents and skills. */
  commandDirs: string[];
  agentDirs: string[];
  skillDirs: string[];
  /** Its hooks table (Claude Code's format), when the user let them run. */
  hooks: unknown;
  /** Its MCP servers (`{ name: config }`), when the user let them start. */
  mcpServers: Record<string, unknown> | null;
  /** Absolute folders of its output styles (D375). */
  outputStyleDirs: string[];
  /** Its language servers, when the user let them start (D375). */
  lspServers: PluginLspServer[] | null;
  /** Installed by Claude Code and used in place (D375). */
  fromClaude?: boolean;
}

/** The enabled plugins' parts; set by plugins.ts when they're read. */
export const activePlugins = signal<readonly ActivePlugin[]>([]);

/** How a plugin's part is labeled where it shows ("plugin formatter"). */
export function pluginLabel(name: string): string {
  return `plugin ${name}`;
}
