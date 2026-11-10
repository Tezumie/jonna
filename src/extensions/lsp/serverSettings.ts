// Language server settings (D204): the known settings of the common servers (a small built-in
// map, from each server's documentation), reading them from a server's definition, and writing
// them to the user's `lsp.servers.<name>.settings` (answers for workspace/configuration, also sent
// with workspace/didChangeConfiguration) or `.initializationOptions` (sent at start: a change
// restarts the server). DOM-free and tested.
import type { ServerConfig } from "./servers";

export type ServerSettingTarget = "settings" | "initializationOptions";

export interface ServerSettingField {
  /** Where it lives: the workspace/configuration answers, or the initialize request. */
  target: ServerSettingTarget;
  /** Its path in that object (names may hold dots: gopls' "ui.semanticTokens" is one name). */
  path: readonly string[];
  /** "string[]" and "json" are edited as JSON text. */
  type: "boolean" | "string" | "number" | "enum" | "string[]" | "json";
  enum?: readonly string[];
  default?: unknown;
  description: string;
}

const s = (
  path: string[],
  type: ServerSettingField["type"],
  description: string,
  extra: Partial<ServerSettingField> = {},
): ServerSettingField => ({ target: "settings", path, type, description, ...extra });
const init = (
  path: string[],
  type: ServerSettingField["type"],
  description: string,
  extra: Partial<ServerSettingField> = {},
): ServerSettingField => ({ target: "initializationOptions", path, type, description, ...extra });

/** Built-in server name → its main settings. Others get the JSON fields only. */
export const SERVER_SETTINGS: Readonly<Record<string, readonly ServerSettingField[]>> = {
  pyright: [
    s(["python", "analysis", "typeCheckingMode"], "enum", "How strict type checking is.", {
      enum: ["off", "basic", "standard", "strict"],
      default: "standard",
    }),
    s(
      ["python", "analysis", "diagnosticMode"],
      "enum",
      "Check only open files, or the whole workspace (its problems show in Problems).",
      {
        enum: ["openFilesOnly", "workspace"],
        default: "openFilesOnly",
      },
    ),
    s(
      ["python", "analysis", "autoImportCompletions"],
      "boolean",
      "Offer completions that add an import.",
      { default: true },
    ),
    s(
      ["python", "analysis", "useLibraryCodeForTypes"],
      "boolean",
      "Infer types from library code that has no stubs.",
      { default: true },
    ),
    s(
      ["python", "analysis", "autoSearchPaths"],
      "boolean",
      "Add common source folders (such as src) to the import search paths.",
      { default: true },
    ),
    s(["python", "analysis", "extraPaths"], "string[]", "More folders to resolve imports from.", {
      default: [],
    }),
    s(["python", "analysis", "stubPath"], "string", "Folder of custom type stubs.", {
      default: "typings",
    }),
  ],
  "rust-analyzer": [
    s(
      ["rust-analyzer", "check", "command"],
      "enum",
      "The cargo command run on save for problems.",
      {
        enum: ["check", "clippy"],
        default: "check",
      },
    ),
    s(
      ["rust-analyzer", "cargo", "allTargets"],
      "boolean",
      "Check all targets (tests, examples, benches).",
      { default: true },
    ),
    s(
      ["rust-analyzer", "cargo", "features"],
      "json",
      'Cargo features to enable: "all" or a list of names.',
      { default: [] },
    ),
    s(["rust-analyzer", "procMacro", "enable"], "boolean", "Expand procedural macros.", {
      default: true,
    }),
    s(
      ["rust-analyzer", "inlayHints", "typeHints", "enable"],
      "boolean",
      "Show inferred types inline.",
      { default: true },
    ),
    s(
      ["rust-analyzer", "inlayHints", "parameterHints", "enable"],
      "boolean",
      "Show parameter names at call sites.",
      { default: true },
    ),
    s(
      ["rust-analyzer", "lens", "enable"],
      "boolean",
      "Show code lenses (Run, Debug, references).",
      { default: true },
    ),
    s(
      ["rust-analyzer", "diagnostics", "enable"],
      "boolean",
      "Show rust-analyzer's own problems (besides cargo's).",
      { default: true },
    ),
  ],
  gopls: [
    s(["gopls", "staticcheck"], "boolean", "Run staticcheck's analyses too.", { default: false }),
    s(["gopls", "gofumpt"], "boolean", "Format with gofumpt's stricter rules.", { default: false }),
    s(
      ["gopls", "usePlaceholders"],
      "boolean",
      "Fill in parameter placeholders when completing a function call.",
      { default: false },
    ),
    s(["gopls", "semanticTokens"], "boolean", "Send semantic tokens (richer coloring).", {
      default: false,
    }),
    s(
      ["gopls", "buildFlags"],
      "string[]",
      'Flags for the build system, such as ["-tags=integration"].',
      { default: [] },
    ),
    s(
      ["gopls", "directoryFilters"],
      "string[]",
      'Folders to include or leave out, such as ["-node_modules"].',
      { default: [] },
    ),
  ],
  typescript: [
    init(
      ["preferences", "includeInlayParameterNameHints"],
      "enum",
      "Show parameter names at call sites.",
      {
        enum: ["none", "literals", "all"],
        default: "none",
      },
    ),
    init(
      ["preferences", "includeInlayFunctionLikeReturnTypeHints"],
      "boolean",
      "Show inferred return types inline.",
      { default: false },
    ),
    init(
      ["preferences", "includeInlayVariableTypeHints"],
      "boolean",
      "Show inferred variable types inline.",
      { default: false },
    ),
    init(
      ["preferences", "importModuleSpecifierPreference"],
      "enum",
      "How auto-imports write the module path.",
      {
        enum: ["shortest", "project-relative", "relative", "non-relative"],
        default: "shortest",
      },
    ),
    init(["preferences", "quotePreference"], "enum", "Quotes in auto-imports and code fixes.", {
      enum: ["auto", "double", "single"],
      default: "auto",
    }),
    init(["maxTsServerMemory"], "number", "Memory limit for tsserver, in MB.", { default: 3072 }),
    s(
      ["completions", "completeFunctionCalls"],
      "boolean",
      "Complete functions with their parameters.",
      { default: false },
    ),
    s(["diagnostics", "ignoredCodes"], "json", "Error codes not to show, such as [6133].", {
      default: [],
    }),
  ],
  clangd: [
    init(
      ["fallbackFlags"],
      "string[]",
      "Compiler flags for files without a compile_commands.json entry.",
      { default: [] },
    ),
    init(["clangdFileStatus"], "boolean", "Report what clangd is doing with each file.", {
      default: false,
    }),
  ],
  "yaml-language-server": [
    s(["yaml", "validate"], "boolean", "Check files against their schemas.", { default: true }),
    s(["yaml", "hover"], "boolean", "Show schema descriptions on hover.", { default: true }),
    s(["yaml", "completion"], "boolean", "Complete from the schemas.", { default: true }),
    s(
      ["yaml", "schemas"],
      "json",
      'Schemas for files: { "https://…/schema.json": "*.config.yaml" }.',
      { default: {} },
    ),
    s(["yaml", "customTags"], "string[]", 'Custom tags, such as ["!Ref scalar"].', { default: [] }),
  ],
  "lua-language-server": [
    s(["Lua", "runtime", "version"], "enum", "The Lua version.", {
      enum: ["Lua 5.1", "Lua 5.2", "Lua 5.3", "Lua 5.4", "LuaJIT"],
      default: "Lua 5.4",
    }),
    s(
      ["Lua", "diagnostics", "globals"],
      "string[]",
      'Globals not to report as undefined, such as ["vim"].',
      { default: [] },
    ),
    s(["Lua", "hint", "enable"], "boolean", "Show inlay hints.", { default: false }),
    s(
      ["Lua", "workspace", "checkThirdParty"],
      "boolean",
      "Offer to set up third-party libraries.",
      { default: false },
    ),
  ],
  // D218: five more of the contributed servers (from their documentation and VS Code
  // extensions' settings; LSP has no way to ask a server for its own schema).
  intelephense: [
    s(
      ["intelephense", "environment", "phpVersion"],
      "string",
      'The PHP version to check against, such as "8.3.0".',
    ),
    s(
      ["intelephense", "files", "maxSize"],
      "number",
      "Files larger than this (in bytes) aren't indexed.",
      { default: 1000000 },
    ),
    s(["intelephense", "diagnostics", "enable"], "boolean", "Report problems.", { default: true }),
    s(["intelephense", "format", "enable"], "boolean", "Format documents.", { default: true }),
    s(["intelephense", "format", "braces"], "enum", "Where formatting puts braces.", {
      enum: ["psr12", "allman", "k&r"],
      default: "psr12",
    }),
    s(
      ["intelephense", "completion", "fullyQualifyGlobalConstantsAndFunctions"],
      "boolean",
      "Complete global functions and constants with their leading backslash.",
      { default: false },
    ),
  ],
  "bash-language-server": [
    s(
      ["bashIde", "shellcheckPath"],
      "string",
      "The ShellCheck program for problems (empty: none).",
      { default: "shellcheck" },
    ),
    s(
      ["bashIde", "shellcheckArguments"],
      "string",
      'Extra ShellCheck arguments, such as "--exclude=SC2034".',
      { default: "" },
    ),
    s(
      ["bashIde", "globPattern"],
      "string",
      "Which files are read for symbols across the workspace.",
      { default: "**/*@(.sh|.inc|.bash|.command)" },
    ),
    s(
      ["bashIde", "backgroundAnalysisMaxFiles"],
      "number",
      "At most this many files are read in the background (0: none).",
      { default: 500 },
    ),
    s(
      ["bashIde", "includeAllWorkspaceSymbols"],
      "boolean",
      "Offer the symbols of all workspace files, not only sourced ones.",
      { default: false },
    ),
  ],
  taplo: [
    s(
      ["evenBetterToml", "schema", "enabled"],
      "boolean",
      "Check files against their schemas (and complete from them).",
      { default: true },
    ),
    s(
      ["evenBetterToml", "formatter", "alignEntries"],
      "boolean",
      "Align the = of consecutive entries.",
      { default: false },
    ),
    s(
      ["evenBetterToml", "formatter", "reorderKeys"],
      "boolean",
      "Sort keys alphabetically when formatting.",
      { default: false },
    ),
    s(
      ["evenBetterToml", "formatter", "arrayTrailingComma"],
      "boolean",
      "A trailing comma in arrays spread over lines.",
      { default: true },
    ),
    s(["evenBetterToml", "formatter", "columnWidth"], "number", "The line width to format to.", {
      default: 80,
    }),
  ],
  "ruby-lsp": [
    init(
      ["formatter"],
      "enum",
      "Which formatter formats documents (auto: RuboCop when the project uses it).",
      { enum: ["auto", "rubocop", "syntax_tree", "none"], default: "auto" },
    ),
    init(["linters"], "string[]", 'Linters that report problems, such as ["rubocop"].', {
      default: [],
    }),
    init(
      ["enabledFeatures"],
      "json",
      'Features to turn off or on, such as { "inlayHint": false }.',
      { default: {} },
    ),
  ],
  zls: [
    s(
      ["zls", "enable_build_on_save"],
      "boolean",
      "Run the build's check step on save and show its errors.",
      { default: false },
    ),
    s(["zls", "semantic_tokens"], "enum", "How much semantic coloring to send.", {
      enum: ["none", "partial", "full"],
      default: "full",
    }),
    s(["zls", "warn_style"], "boolean", "Warn about style (naming conventions and the like).", {
      default: false,
    }),
    s(["zls", "zig_exe_path"], "string", "The zig program (default: found on PATH)."),
  ],
};

/** A field's key as shown and typed ("python.analysis.typeCheckingMode"). */
export function fieldKey(field: ServerSettingField): string {
  return field.path.join(".");
}

export function fieldsFor(server: string): readonly ServerSettingField[] {
  return SERVER_SETTINGS[server] ?? [];
}

/** The field `key` names for `server`, or an ad-hoc one (the key split at dots) for others. */
export function fieldFor(
  server: string,
  key: string,
  target?: ServerSettingTarget,
): ServerSettingField {
  const known = fieldsFor(server).find(
    (f) => fieldKey(f) === key && (!target || f.target === target),
  );
  if (known) return known;
  return {
    target: target ?? "settings",
    path: key.split(".").filter(Boolean),
    type: "json",
    description: "",
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function getPath(value: unknown, path: readonly string[]): unknown {
  let at = value;
  for (const part of path) {
    if (!isObject(at)) return undefined;
    at = at[part];
  }
  return at;
}

/** A copy of `value` with `path` set (undefined removes it, and the objects it leaves empty). */
export function setPath(
  value: Record<string, unknown> | undefined,
  path: readonly string[],
  next: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(value ?? {}) };
  const [head, ...rest] = path;
  if (head === undefined) return out;
  if (!rest.length) {
    if (next === undefined) delete out[head];
    else out[head] = next;
    return out;
  }
  const child = setPath(isObject(out[head]) ? out[head] : undefined, rest, next);
  if (Object.keys(child).length) out[head] = child;
  else delete out[head];
  return out;
}

type UserServers = Record<string, Record<string, unknown>>;

function userServers(value: unknown): UserServers {
  if (!isObject(value)) return {};
  const out: UserServers = {};
  for (const [k, v] of Object.entries(value)) if (isObject(v)) out[k] = { ...v };
  return out;
}

/** `lsp.servers` with one server's field set (undefined: back to the server's own value). */
export function withServerSetting(
  servers: unknown,
  server: string,
  field: Pick<ServerSettingField, "target" | "path">,
  value: unknown,
): UserServers {
  const out = userServers(servers);
  const entry = out[server] ?? {};
  const target = isObject(entry[field.target])
    ? (entry[field.target] as Record<string, unknown>)
    : undefined;
  const next = setPath(target, field.path, value);
  if (Object.keys(next).length) entry[field.target] = next;
  else delete entry[field.target];
  if (Object.keys(entry).length) out[server] = entry;
  else delete out[server];
  return out;
}

/** `lsp.servers` with one server's whole `settings` / `initializationOptions` replaced (null: removed). */
export function withServerJson(
  servers: unknown,
  server: string,
  values: { settings?: Record<string, unknown> | null; initializationOptions?: unknown },
): UserServers {
  const out = userServers(servers);
  const entry = out[server] ?? {};
  for (const target of ["settings", "initializationOptions"] as const) {
    if (!(target in values)) continue;
    const v = values[target];
    const empty = v === null || v === undefined || (isObject(v) && !Object.keys(v).length);
    if (empty) delete entry[target];
    else entry[target] = v;
  }
  if (Object.keys(entry).length) out[server] = entry;
  else delete out[server];
  return out;
}

/** What the user's `lsp.servers` sets for `server` (their overrides, not the merged config). */
export function userOverrides(servers: unknown, server: string): Record<string, unknown> {
  return userServers(servers)[server] ?? {};
}

/**
 * What a settings change means for each server: `restart` (added, removed, or anything but its
 * settings changed: command, args, initializationOptions…) or `reconfigure` (only its settings:
 * workspace/didChangeConfiguration, no restart, VS Code's way).
 */
export function serverChanges(
  before: readonly ServerConfig[],
  after: readonly ServerConfig[],
): { restart: string[]; reconfigure: string[] } {
  const restart: string[] = [];
  const reconfigure: string[] = [];
  const old = new Map(before.map((c) => [c.name, c]));
  const next = new Map(after.map((c) => [c.name, c]));
  for (const name of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(name);
    const b = next.get(name);
    if (!a || !b) {
      restart.push(name);
      continue;
    }
    const { settings: sa, ...ra } = a;
    const { settings: sb, ...rb } = b;
    if (JSON.stringify(ra) !== JSON.stringify(rb)) restart.push(name);
    else if (JSON.stringify(sa ?? null) !== JSON.stringify(sb ?? null)) reconfigure.push(name);
  }
  return { restart, reconfigure };
}
