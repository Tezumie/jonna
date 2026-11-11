// JSON schemas for the IDE's own JSONC files: user and workspace settings.json (from the
// contributed settings registry) and keybindings.json (commands from the dispatcher), so editing
// them gets completion, hovers and validation (D56). Re-sent when settings or the folder change.
// Every folder's settings.json gets the workspace schema (its .vscode one too); a multi-root
// workspace's `.code-workspace` file gets its own (folders, settings, launch, tasks; D251).

import { manifestSchema } from "../../core/extensions/manifestSchema";
import type { DisposableStore } from "../../core/lifecycle/index";
import { joinPath } from "../../core/paths/index";
import { effect } from "../../core/reactive/index";
import type { WorkbenchServices } from "../../workbench/services";
import { workspaceFolderCandidates } from "../../workbench/workspaceFolder";
import type { JsonSchemaAssociation } from "./engine";
import type { EditorService } from "./service";
import { workspaceFileSchema } from "./workspaceFileSchema";

/** Schema for keybindings.json: an array of { key, command, when?, args?, mac? }. */
export function keybindingsSchema(commands: readonly { id: string; title: string }[]): unknown {
  const ids = commands.map((c) => c.id);
  return {
    type: "array",
    items: {
      type: "object",
      required: ["key", "command"],
      properties: {
        key: { type: "string", description: 'Key or chord, e.g. "ctrl+k ctrl+o".' },
        mac: { type: "string", description: "Key on macOS (default: `key`)." },
        command: {
          type: "string",
          description: 'Command id; prefix with "-" to remove a default binding.',
          anyOf: [
            { enum: ids, enumDescriptions: commands.map((c) => c.title) },
            { type: "string", pattern: "^-" },
          ],
        },
        when: { type: "string", description: "Context expression, e.g. editorFocus." },
        args: { description: "Input passed to the command." },
      },
    },
  };
}

/**
 * VS Code's `fileMatch` as a pattern over file URIs: a name alone ("*.scene.json",
 * "package.json") is that file in any folder, a pattern from the root ("/.toolrc") the same in
 * the folder; one with a folder in it, or a "!" exclusion, is taken as written.
 */
export function fileMatchPattern(match: string): string {
  if (match.startsWith("!")) return `!${fileMatchPattern(match.slice(1))}`;
  if (match.startsWith("**/")) return match;
  if (match.startsWith("/")) return `**${match}`;
  return `**/${match}`;
}

export function registerJsonSchemas(
  sub: DisposableStore,
  services: WorkbenchServices,
  editors: EditorService,
): void {
  const { settings, dispatcher, workspace } = services;
  const associations = (): JsonSchemaAssociation[] => {
    const out: JsonSchemaAssociation[] = [];
    const user = settings.filePath("user");
    const file = workspace.file.peek();
    // A multi-root workspace's settings are in its workspace file (schema below), not a settings.json.
    const ws = workspace.root.peek() && !file ? settings.filePath("workspace") : null;
    if (user)
      out.push({
        uri: "ide://schemas/settings-user",
        files: [user],
        schema: settings.registry.jsonSchema("user"),
      });
    // Each folder's settings.json: the IDE's own folder's and the aliases' (.vscode…).
    const folderFiles = workspace
      .folderPaths()
      .flatMap((folder) =>
        workspaceFolderCandidates().map((name) =>
          joinPath(joinPath(folder, name), "settings.json"),
        ),
      );
    const files = [...new Set([...(ws ? [ws] : []), ...folderFiles])];
    if (files.length)
      out.push({
        uri: "ide://schemas/settings-workspace",
        files,
        schema: settings.registry.jsonSchema("workspace"),
      });
    out.push({
      uri: "ide://schemas/code-workspace",
      files: file ? [file] : [],
      patterns: ["**/*.code-workspace"],
      schema: workspaceFileSchema(settings.registry.jsonSchema("workspace")),
    });
    // Extension manifests (D191): in any extensions folder, the bundled ones' too.
    out.push({
      uri: "ide://schemas/extension-manifest",
      files: [],
      // Not the IDE's own built-ins (src/extensions/*: another format, with languageServers…).
      patterns: [
        "**/extensions/*/extension.json",
        "**/bundled-extensions/*/extension.json",
        "!**/src/extensions/*/extension.json",
      ],
      schema: manifestSchema(),
    });
    // Extensions' own schemas (VS Code's jsonValidation, D419), by their file patterns.
    for (const entry of services.contributions.jsonSchemas.value)
      out.push({
        uri: entry.uri,
        files: [],
        patterns: entry.fileMatch.map(fileMatchPattern),
        schema: entry.schema,
      });
    const keys = settings.keybindingsPath;
    if (keys)
      out.push({
        uri: "ide://schemas/keybindings",
        files: [keys],
        schema: keybindingsSchema(dispatcher.list()),
      });
    return out;
  };
  editors.whenEngine((engine) => {
    sub.add(
      effect(() => {
        settings.version.value;
        workspace.root.value;
        workspace.folders.value;
        workspace.file.value;
        engine.setJsonSchemas(associations());
        return undefined;
      }),
    );
  });
  // Emmet (D199): on by default, like VS Code, in markup, stylesheets and JSX/TSX.
  editors.whenEngine((engine) => {
    sub.add(
      effect(() => {
        settings.version.value;
        const on = settings.peek<boolean>("emmet.enabled") !== false;
        const excluded = new Set(settings.peek<string[]>("emmet.excludeLanguages") ?? []);
        engine.setEmmet(on ? EMMET_LANGUAGES.filter((l) => !excluded.has(l)) : []);
        return undefined;
      }),
    );
  });
}

/** Where Emmet works (VS Code's defaults, with our JSX ids). */
const EMMET_LANGUAGES = [
  "html",
  "vue",
  "svelte",
  "php",
  "astro",
  "css",
  "scss",
  "less",
  "sass",
  "jsx",
  "tsx",
];
