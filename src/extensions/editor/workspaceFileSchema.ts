// The JSON schema of a `.code-workspace` file (D251, VS Code's multi-root workspace file): its
// folders, the workspace's settings (the workspace settings schema), launch configurations,
// tasks and extension recommendations. DOM-free.

/** `settings`: the schema of workspace settings (`SettingsRegistry.jsonSchema("workspace")`). */
export function workspaceFileSchema(settings: unknown): Record<string, unknown> {
  const strings = { type: "array", items: { type: "string" } };
  return {
    type: "object",
    required: ["folders"],
    properties: {
      folders: {
        type: "array",
        description: "The workspace's folders, in order: the first is the primary one.",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "The folder's path: relative to this file's folder, or absolute (forward slashes work on every OS).",
            },
            name: {
              type: "string",
              description: "The name shown for the folder (default: its folder name).",
            },
            uri: { type: "string", description: "The folder as a URI (instead of `path`)." },
          },
          anyOf: [{ required: ["path"] }, { required: ["uri"] }],
          additionalProperties: false,
        },
      },
      settings: {
        description:
          "Workspace settings: they apply to every folder (a folder's own settings win).",
        ...(settings && typeof settings === "object" ? settings : { type: "object" }),
      },
      launch: {
        type: "object",
        description: "Launch configurations for the whole workspace (as in launch.json).",
        properties: {
          version: { type: "string" },
          configurations: { type: "array", items: { type: "object" } },
          compounds: { type: "array", items: { type: "object" } },
        },
      },
      tasks: {
        type: "object",
        description: "Tasks for the whole workspace (as in tasks.json).",
        properties: {
          version: { type: "string" },
          tasks: { type: "array", items: { type: "object" } },
          inputs: { type: "array", items: { type: "object" } },
        },
      },
      extensions: {
        type: "object",
        description: "Extensions recommended for this workspace (as in extensions.json).",
        properties: {
          recommendations: { ...strings, description: "Extension ids to recommend." },
          unwantedRecommendations: {
            ...strings,
            description: "Extension ids not to recommend.",
          },
        },
      },
      remoteAuthority: { type: "string", description: "The remote the workspace is on." },
    },
    additionalProperties: false,
    errorMessage: "Unknown workspace file property.",
  };
}
