// A JSON Schema of extension.json (D191, wishlist 12): the editor validates and completes a
// manifest with it, and agents read it (extensions.manifestSchema) instead of inventing fields.
// The parser (thirdParty.ts) stays the authority; this describes what it reads.
import { WORKBENCH_CONTRIBUTION_SCHEMA } from "./manifestWorkbench";
import { PERMISSIONS } from "./thirdParty";

const str = (description: string) => ({ type: "string", description });
const strings = (description: string) => ({
  type: "array",
  items: { type: "string" },
  description,
});
const icon = str(
  'An icon of the IDE\'s set by name ("rocket"; extensions.listIcons), or for the extension itself an image file of it (PNG, JPEG, GIF, WebP, SVG)',
);

export function manifestSchema(): Record<string, unknown> {
  const permission = {
    anyOf: [
      { enum: Object.keys(PERMISSIONS), enumDescriptions: Object.values(PERMISSIONS) },
      { type: "string", pattern: "^network:[a-z0-9.*-]+$", description: "network:<host>" },
    ],
  };
  const command = {
    type: "object",
    required: ["id", "title"],
    properties: {
      id: str("<name>.<camelCase>, e.g. todo.scan"),
      title: str("Shown in the palette and menus (sentence case)"),
      description: str("One sentence: what it does (agents read it)"),
      category: str("Palette group"),
      agent: { enum: ["discoverable", "hidden"], description: "Offered to agents (default)" },
      when: str('A context-key clause; unavailable while false ("gitRepo")'),
      effects: {
        type: "array",
        items: { enum: ["read", "write", "exec", "network", "destructive"] },
        description: "What it does; [] for UI-only. Agents and permission checks use it.",
      },
      input: {
        type: "object",
        description:
          'A small JSON Schema of its input ({ "type": "object", "properties": …, "required": [...] }; string, number, integer, boolean, array, object; description, enum): agents see it and input is checked before the handler runs',
      },
    },
  };
  const view = {
    type: "object",
    required: ["id", "title", "location", "type"],
    properties: {
      id: str("<name>.<camelCase>"),
      title: str("Tab or sidebar title"),
      location: { enum: ["sidebar", "panel", "editor"] },
      type: { enum: ["tree", "webview"] },
      icon,
      path: str('An HTML file of the extension (type "webview")'),
      codePage: {
        type: "boolean",
        description:
          'type "webview": its code writes the page with ide.ui.webview(id).setHtml(html) instead of "path"',
      },
      sectionOf: str(
        'A sidebar view it can be a section of ("scm.view", "explorer.view"), while hidden from the activity bar',
      ),
      sectionOrder: { type: "number", description: "Its place among the sections (top first)" },
    },
  };
  const menuItem = {
    type: "object",
    required: ["command"],
    properties: {
      location: {
        enum: [
          "explorer/context",
          "editor/context",
          "editor/title",
          "view/title",
          "menubar/view",
          "notebook/toolbar",
          "notebook/cell/title",
          "notebook/kernelSource",
          "view/item/context",
        ],
      },
      command: str("One of this extension's commands"),
      title: str("Label (default: the command's title)"),
      icon,
      when: str(
        "Context expression, e.g. resourceExtname == .ts (tree rows: view == my.view && viewItem == file)",
      ),
      group: str(
        'Menu group with an optional @order, e.g. "navigation", "2_edit@1"; "inline" puts a tree row\'s item on the row as a button',
      ),
    },
  };
  const setting = {
    type: "object",
    required: ["type"],
    properties: {
      type: { enum: ["string", "number", "integer", "boolean", "array", "object"] },
      default: {},
      description: str("Shown in the settings editor"),
      enum: { type: "array" },
      minimum: { type: "number" },
      maximum: { type: "number" },
      tags: strings("Words the settings search finds with @tag:"),
    },
  };
  const program = {
    type: "object",
    required: ["name", "command"],
    properties: {
      name: str("Shown in the IDE"),
      command: str("Program to start"),
      args: strings("Its arguments"),
      description: str("What it is"),
    },
  };
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "IDE extension manifest (extension.json)",
    type: "object",
    required: ["id", "version", "displayName"],
    properties: {
      $schema: { type: "string" },
      id: {
        ...str("publisher.name, lowercase, e.g. acme.todo"),
        pattern: "^[a-z0-9-]+\\.[a-z0-9.-]+$",
      },
      version: { ...str("Semantic version, e.g. 1.0.0"), pattern: "^\\d+\\.\\d+\\.\\d+" },
      displayName: str("Shown in the Extensions view"),
      description: str("One sentence"),
      main: str("Worker code (a .js file of the extension); declarative-only extensions have none"),
      icon,
      screenshots: {
        type: "array",
        maxItems: 12,
        description: "Pictures shown above the README (files of the extension)",
        items: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              required: ["path"],
              properties: { path: { type: "string" }, caption: { type: "string" } },
            },
          ],
        },
      },
      activation: strings(
        '"*", "onStartupFinished", "onLanguage:<id>", "workspaceContains:<glob>", "onFileSystem:<scheme>", "onUri", "onNotebook:<type>", "onDebug"',
      ),
      activationEvents: strings("VS Code's name for `activation` (either works)"),
      host: {
        type: "string",
        enum: ["worker", "node"],
        description:
          'Where its code runs: "worker" (the sandbox, default) or "node" (a Node.js process: npm packages, files, programs; needs the "node" permission)',
      },
      permissions: {
        type: "array",
        items: permission,
        description: "What the user is asked to allow",
      },
      readsSettings: strings(
        'Other settings its code reads ("debug.pythonPath", "markdown.*"); agent/ai/mcp/accounts/http and secret-like keys are refused',
      ),
      namespaces: strings(
        'Built-in namespaces its names may use ("git"): only for extensions that come with the IDE',
      ),
      author: str("Who made it"),
      authors: {
        type: "array",
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            github: { type: "string" },
            avatar: { type: "string" },
            url: { type: "string" },
          },
        },
      },
      repository: str("https://… or owner/repo"),
      homepage: str("A web page"),
      license: str("SPDX id, e.g. MIT"),
      categories: strings("Up to 12"),
      keywords: strings("Up to 12"),
      contributes: {
        type: "object",
        additionalProperties: false,
        properties: {
          commands: { type: "array", items: command },
          keybindings: {
            type: "array",
            items: {
              type: "object",
              required: ["key", "command"],
              properties: {
                key: { type: "string" },
                mac: { type: "string" },
                command: { type: "string" },
                when: { type: "string" },
              },
            },
          },
          settings: {
            type: "object",
            description: "Keys start with the extension's name: todo.tags",
            additionalProperties: setting,
          },
          views: { type: "array", items: view },
          menus: {
            description: 'A list of items with "location", or { "explorer/context": [items] }',
            anyOf: [
              { type: "array", items: menuItem },
              { type: "object", additionalProperties: { type: "array", items: menuItem } },
            ],
          },
          viewers: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "title", "extensions"],
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                extensions: strings('File extensions, e.g. [".board"]'),
                path: str("The viewer's HTML file (or codePage)"),
                codePage: {
                  type: "boolean",
                  description:
                    "Its code writes each tab's page: { ide: 'viewerOpened', path, instance } arrives, then ide.ui.webview(id).setHtml(html, instance)",
                },
                default: { type: "boolean", description: "Opens these files by default" },
                icon,
              },
            },
          },
          notebooks: {
            type: "array",
            description:
              "Notebook file formats it reads and writes (ide.notebooks.registerSerializer); they open in the notebook editor",
            items: {
              type: "object",
              required: ["type", "displayName", "extensions"],
              properties: {
                type: str("Notebook type id, starting with the extension's id or prefix"),
                displayName: str("Shown in Reopen with… and the kernel picker"),
                extensions: strings(
                  'File endings, e.g. [".toynb"], or [".nb.py"] (the longest ending wins)',
                ),
                default: {
                  type: "boolean",
                  description: "Its files open as notebooks by default (else: Reopen with…)",
                },
              },
            },
          },
          notebookRenderers: {
            type: "array",
            description:
              "Output renderers: a script of the extension draws outputs of these mime types in the notebook's sandboxed output frame (activate(context) → { renderOutputItem(item, element) })",
            items: {
              type: "object",
              required: ["id", "entrypoint", "mimeTypes"],
              properties: {
                id: str("Renderer id, starting with the extension's id or prefix"),
                displayName: str("Shown in the extension's page"),
                entrypoint: str("The renderer's script (a .js file of the extension)"),
                mimeTypes: strings('Mime types it draws, e.g. ["application/vnd.acme.chart+json"]'),
              },
            },
          },
          themes: { type: "array", items: { type: "object" }, description: "VS Code color themes" },
          iconThemes: { type: "array", items: { type: "object" } },
          productIconThemes: { type: "array", items: { type: "object" } },
          languages: { type: "array", items: { type: "object" } },
          grammars: { type: "array", items: { type: "object" } },
          snippets: { type: "array", items: { type: "object" } },
          problemMatchers: {
            type: "array",
            items: { type: "object", required: ["name"] },
            description: 'Named problem matchers (VS Code\'s format); tasks use "$name"',
          },
          problemPatterns: {
            type: "array",
            items: { type: "object", required: ["name"] },
            description: 'Named problem patterns; a matcher\'s pattern can be "$name"',
          },
          agents: {
            type: "array",
            items: program,
            description: "ACP agents (needs shell + agent)",
          },
          mcpServers: {
            type: "array",
            items: program,
            description: "MCP servers (needs shell + agent)",
          },
          modelProviders: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "name", "baseUrl"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                baseUrl: { type: "string" },
              },
            },
          },
          ...WORKBENCH_CONTRIBUTION_SCHEMA,
          agentTools: strings("Commands of this extension the agent gets as tools"),
          state: {
            type: "array",
            description:
              "State paths its code fills (ide.state.register): under ide://ext/<id>/, with a description",
            items: {
              anyOf: [
                { type: "string" },
                {
                  type: "object",
                  required: ["path"],
                  properties: { path: { type: "string" }, description: { type: "string" } },
                },
              ],
            },
          },
        },
      },
    },
  };
}
