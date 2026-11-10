// The manifest's contributions for the workbench providers (D233): `taskDefinitions` (VS Code's:
// the task types an extension provides, which `ide.tasks.registerTaskProvider` needs) and
// `debuggers` (the debug types it supplies adapters for, with their "Add configuration…"
// snippets). DOM-free and unit-tested.

export interface ContributedTaskDefinition {
  type: string;
  /** Properties a tasks.json entry of the type must have. */
  required: string[];
  /** The JSON Schema of its properties, as written. */
  properties: Record<string, unknown>;
}

export interface ContributedDebugSnippet {
  label: string;
  description: string;
  body: Record<string, unknown>;
}

export interface ContributedDebugger {
  type: string;
  label: string;
  languages: string[];
  snippets: ContributedDebugSnippet[];
}

/** The tasks extension's own types: a provider can't take them. */
const BUILT_IN_TASK_TYPES = new Set(["shell", "process", "npm"]);

/**
 * Debug types the debug extension runs itself (launch.ts adapterFor). An extension may contribute
 * them too (debugpy's "debugpy", ms-python's "python", as VS Code allows): its adapter runs them
 * once it supplies one, the built-in one otherwise (debug/controller.ts).
 */
export const BUILT_IN_DEBUG_TYPES =
  /^(node|node2|pwa-node|node-terminal|extensionhost|pwa-extensionhost|python|debugpy|lldb|lldb-dap|codelldb|gdb|cppdbg|cppvsdbg|go|coreclr|dotnet|netcoredbg|java|(pwa-)?(chrome|msedge|edge))$/i;

/** A task or debug type: VS Code's may have spaces ("Python Kernel Debug Adapter"). */
const TYPE = /^[A-Za-z](?:[\w. -]{0,58}[\w.-])?$/;

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function parseWorkbenchContributions(
  c: Record<string, unknown>,
  errors: string[],
): { taskDefinitions: ContributedTaskDefinition[]; debuggers: ContributedDebugger[] } {
  const taskDefinitions: ContributedTaskDefinition[] = [];
  for (const raw of arr(c.taskDefinitions).slice(0, 20)) {
    const d = obj(raw);
    const type = str(d.type);
    if (!type || !TYPE.test(type)) {
      errors.push(
        `taskDefinitions: "${String(type ?? "")}" isn't a task type (letters, digits, . - _)`,
      );
      continue;
    }
    if (BUILT_IN_TASK_TYPES.has(type.toLowerCase())) {
      errors.push(`taskDefinitions ${type}: a built-in task type`);
      continue;
    }
    if (taskDefinitions.some((t) => t.type === type)) continue;
    taskDefinitions.push({
      type,
      required: arr(d.required).filter((r): r is string => typeof r === "string"),
      properties: obj(d.properties),
    });
  }
  const debuggers: ContributedDebugger[] = [];
  for (const raw of arr(c.debuggers).slice(0, 10)) {
    const d = obj(raw);
    const type = str(d.type);
    if (!type || !TYPE.test(type)) {
      errors.push(`debuggers: "${String(type ?? "")}" isn't a debug type (letters, digits, . - _)`);
      continue;
    }
    if (debuggers.some((x) => x.type === type)) continue;
    const snippets = arr(d.configurationSnippets)
      .slice(0, 20)
      .flatMap((s): ContributedDebugSnippet[] => {
        const snippet = obj(s);
        const label = str(snippet.label);
        const body = obj(snippet.body);
        if (!label || !Object.keys(body).length) return [];
        // A snippet makes a configuration of this debugger.
        return [
          {
            label: label.slice(0, 80),
            description: (str(snippet.description) ?? "").slice(0, 200),
            body: { ...body, type },
          },
        ];
      });
    debuggers.push({
      type,
      label: (str(d.label) ?? type).slice(0, 60),
      languages: arr(d.languages)
        .filter((l): l is string => typeof l === "string")
        .slice(0, 20),
      snippets,
    });
  }
  return { taskDefinitions, debuggers };
}

/** The extension.json schema of the two contributions (manifestSchema.ts). */
export const WORKBENCH_CONTRIBUTION_SCHEMA = {
  taskDefinitions: {
    type: "array",
    description: "Task types its code provides (ide.tasks.registerTaskProvider)",
    items: {
      type: "object",
      required: ["type"],
      properties: {
        type: { type: "string" },
        required: { type: "array", items: { type: "string" } },
        properties: { type: "object" },
      },
    },
  },
  debuggers: {
    type: "array",
    description:
      "Debug types its code supplies adapters for (ide.debug.registerDebugAdapterDescriptorFactory)",
    items: {
      type: "object",
      required: ["type"],
      properties: {
        type: { type: "string" },
        label: { type: "string" },
        languages: { type: "array", items: { type: "string" } },
        configurationSnippets: {
          type: "array",
          items: {
            type: "object",
            required: ["label", "body"],
            properties: {
              label: { type: "string" },
              description: { type: "string" },
              body: { type: "object" },
            },
          },
        },
      },
    },
  },
} as const;
