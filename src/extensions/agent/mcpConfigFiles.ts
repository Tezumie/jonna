// The agent's MCP config files and switches (split from mcp.ts in D245): which mcp.json a server
// is added to, adding and removing servers there (comments kept), the user's own mcp.json, and the
// servers and tools the user turned off.

import { fsIpc } from "../../core/ipc/fs";
import { dirname, joinPath } from "../../core/paths/index";
import { signal } from "../../core/reactive/index";
import { parseJsonc } from "../../core/settings/jsonc";
import { setJsoncProperty } from "../../core/settings/jsoncEdit";
import type { WorkbenchServices } from "../../workbench/services";
import {
  workspaceFolderName,
  workspaceFolderPath,
  workspaceFolderPaths,
} from "../../workbench/workspaceFolder";

/** The workspace's folders (D251), the first first; the first alone before the list is known. */
export function workspaceMcpFolders(
  services: WorkbenchServices,
): readonly { path: string; name: string }[] {
  const folders = services.workspace.folders.peek();
  if (folders.length) return folders;
  const root = services.workspace.root.peek();
  return root ? [{ path: root, name: root }] : [];
}

/** A folder's MCP config files, in order of precedence (its IDE folder's, .vscode's, .mcp.json). */
export function folderMcpFiles(root: string): string[] {
  return [
    ...workspaceFolderPaths(root, "mcp.json"),
    joinPath(joinPath(root, ".vscode"), "mcp.json"),
    joinPath(root, ".mcp.json"),
  ].filter((p, i, all) => all.indexOf(p) === i);
}

/** The folder's mcp.json to add servers to: .vscode/mcp.json when there is one. */
export async function folderMcpFile(root: string): Promise<string> {
  const vscode = joinPath(joinPath(root, ".vscode"), "mcp.json");
  const hasVscode = await fsIpc.stat(vscode).then(
    () => true,
    () => false,
  );
  if (!hasVscode) await fsIpc.createDir(root, workspaceFolderName()).catch(() => {});
  return hasVscode ? vscode : workspaceFolderPath(root, "mcp.json");
}

async function readConfigText(path: string): Promise<{ text: string; doc: McpFileDoc }> {
  const text = await fsIpc
    .read(path)
    .then((b) => new TextDecoder().decode(b))
    .catch(() => "");
  const parsed = parseJsonc(text);
  if (text.trim() && !parsed.ok)
    throw new Error(
      `${path} has a syntax error (line ${parsed.ok ? 0 : parsed.error.line}); fix it first so nothing in it is lost.`,
    );
  const doc = (
    parsed.ok && parsed.value && typeof parsed.value === "object" ? parsed.value : {}
  ) as McpFileDoc;
  return { text, doc };
}

interface McpFileDoc {
  servers?: Record<string, unknown>;
  inputs?: { id: string }[];
}

/** Bumped when the IDE writes an mcp.json (install, remove): the MCP section redraws at once. */
export const mcpConfigVersion = signal(0);

/** Servers the user turned off (`agent.mcp.disabledServers`, D205): listed, never started. */
export function disabledServers(services: WorkbenchServices): Set<string> {
  const v = services.settings.peek<unknown>("agent.mcp.disabledServers");
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
}

/** Tools the user turned off per server (`agent.mcp.disabledTools`: { server: [tool] }). */
export function disabledTools(services: WorkbenchServices): Map<string, Set<string>> {
  const v = services.settings.peek<unknown>("agent.mcp.disabledTools");
  const out = new Map<string, Set<string>>();
  if (v && typeof v === "object" && !Array.isArray(v))
    for (const [server, tools] of Object.entries(v))
      if (Array.isArray(tools))
        out.set(server, new Set(tools.filter((x): x is string => typeof x === "string")));
  return out;
}

/**
 * Adds (or replaces) a server in an mcp.json, comments kept, with its inputs (D193; the gallery's
 * Install, D204).
 */
export async function writeServerEntry(
  path: string,
  name: string,
  server: Record<string, unknown>,
  inputs?: readonly {
    id: string;
    description: string;
    password?: boolean;
    options?: readonly string[];
    default?: string;
  }[],
): Promise<void> {
  const { text, doc } = await readConfigText(path);
  let next = setJsoncProperty(text, "servers", { ...(doc.servers ?? {}), [name]: server });
  if (inputs?.length) {
    const kept = (doc.inputs ?? []).filter((i) => !inputs.some((n) => n.id === i.id));
    next = setJsoncProperty(next, "inputs", [
      ...kept,
      ...inputs.map((i) =>
        i.options?.length
          ? {
              type: "pickString",
              id: i.id,
              description: i.description,
              options: [...i.options],
              ...(i.default !== undefined && { default: i.default }),
            }
          : {
              type: "promptString",
              id: i.id,
              description: i.description,
              password: i.password !== false,
              ...(i.default !== undefined && i.password === false && { default: i.default }),
            },
      ),
    ]);
  }
  await fsIpc.write(path, new TextEncoder().encode(next));
  mcpConfigVersion.value++;
}

/** Takes a server out of an mcp.json (comments kept); false when it wasn't there. */
export async function removeServerEntry(path: string, name: string): Promise<boolean> {
  const { text, doc } = await readConfigText(path);
  if (!doc.servers || !(name in doc.servers)) return false;
  const { [name]: _gone, ...rest } = doc.servers;
  await fsIpc.write(path, new TextEncoder().encode(setJsoncProperty(text, "servers", rest)));
  mcpConfigVersion.value++;
  return true;
}

/** `<config>/mcp.json`: the user's MCP servers for every folder (D193). */
export function userMcpPath(services: WorkbenchServices): string | null {
  const settingsFile = services.settings.filePath("user");
  return settingsFile ? joinPath(dirname(settingsFile), "mcp.json") : null;
}
