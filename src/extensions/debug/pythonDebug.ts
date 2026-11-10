// The built-in Python debugger's environment (D295), as ms-python.debugpy sets it up in VS Code:
// the interpreter is the configuration's `python`, else debug.pythonPath, else
// python.defaultInterpreterPath (VS Code's default "python" counts as unset), else the folder's
// virtual environment (.venv, venv, env: the same choice as the language server's, lsp/python.ts),
// else python on PATH; the configuration's `envFile` (default ${workspaceFolder}/.env) is loaded
// under its own `env`; and when ms-python.debugpy is installed, its bundled copy of debugpy
// (bundled/libs) is on the adapter's PYTHONPATH, so `pip install debugpy` isn't needed.
// The parsing and choosing are DOM-free and tested; `builtInPythonSetup` reads the files.
import { fsIpc } from "../../core/ipc/fs";
import type { WorkbenchServices } from "../../workbench/services";
import { pickInterpreter, venvCandidates } from "../lsp/python";
import type { LaunchConfig } from "./launch";

/** The extension whose bundled debugpy the built-in adapter can use. */
export const DEBUGPY_EXTENSION = "ms-python.debugpy";

const isWindows = (platform: string) => platform === "windows";

/**
 * A .env file's variables (python-dotenv's format, as VS Code's Python extensions read it):
 * `KEY=value`, `export KEY=value`, quoted values ('…' as written, "…" with \n escapes), comments
 * after `#`, and `${NAME}` filled in from earlier lines or `base` (the process environment).
 */
export function parseEnvFile(
  text: string,
  base: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] ?? "";
    let value = m[2] ?? "";
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"')
        value = value.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
      if (quote === "'") {
        out[key] = value;
        continue;
      }
    } else value = value.replace(/\s+#.*$/, "").trim();
    out[key] = value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_, name: string) => out[name] ?? base[name] ?? "",
    );
  }
  return out;
}

/**
 * The interpreter the built-in adapter runs: the configuration's own, debug.pythonPath,
 * python.defaultInterpreterPath (not VS Code's default "python"), the folder's first venv, else
 * `fallback`.
 */
export function pythonFor(options: {
  configPython: unknown;
  debugPythonPath?: string;
  defaultInterpreterPath?: string;
  folder: string;
  venvs: readonly string[];
  fallback: string;
}): string {
  const own = Array.isArray(options.configPython) ? options.configPython[0] : options.configPython;
  if (typeof own === "string" && own.trim()) return own.trim();
  if (options.debugPythonPath?.trim()) return options.debugPythonPath.trim();
  const setting = options.defaultInterpreterPath?.trim();
  return (
    pickInterpreter(setting === "python" ? undefined : setting, options.folder, options.venvs) ??
    options.fallback
  );
}

/** PYTHONPATH with `dir` first (`existing` after it). */
export function withPythonPath(dir: string, existing: string | undefined, platform: string) {
  const sep = isWindows(platform) ? ";" : ":";
  return existing ? `${dir}${sep}${existing}` : dir;
}

const exists = (path: string) =>
  fsIpc.stat(path).then(
    () => true,
    () => false,
  );

/** ms-python.debugpy's bundled/libs folder, when it's installed and enabled. */
async function bundledDebugpy(services: WorkbenchServices): Promise<string | null> {
  const snap = await services.state.get("ide://extensions").catch(() => null);
  const list = (snap?.value ?? []) as { id?: unknown; status?: unknown; root?: unknown }[];
  const ext = Array.isArray(list)
    ? list.find((e) => e.id === DEBUGPY_EXTENSION && e.status !== "disabled")
    : undefined;
  if (!ext || typeof ext.root !== "string") return null;
  const sep = isWindows(services.platform) ? "\\" : "/";
  const libs = `${ext.root.replace(/[\\/]+$/, "")}${sep}bundled${sep}libs`;
  return (await exists(`${libs}${sep}debugpy`)) ? libs : null;
}

/**
 * What the built-in adapter needs for a Python configuration: the interpreter, the
 * configuration with its envFile loaded, and the adapter's environment.
 */
export async function builtInPythonSetup(
  services: WorkbenchServices,
  config: LaunchConfig,
  fallback: string,
): Promise<{ python: string; config: LaunchConfig; adapterEnv?: Record<string, string> }> {
  const { settings, platform } = services;
  const folder = config.workspaceFolder ?? services.workspace.root.peek() ?? "";
  const venvs: string[] = [];
  if (folder && services.trust.trusted)
    for (const p of venvCandidates(folder, platform)) if (await exists(p)) venvs.push(p);
  const python = pythonFor({
    configPython: config.raw.python,
    debugPythonPath: settings.peek<string>("debug.pythonPath"),
    // A repository's own interpreter setting runs only in a trusted folder (as Pyright's).
    defaultInterpreterPath: services.trust.trusted
      ? settings.peekAt<string>("python.defaultInterpreterPath", folder)
      : undefined,
    folder,
    venvs,
    fallback,
  });
  // envFile: the configuration's, else the folder's .env (a missing file is no error).
  const sep = isWindows(platform) ? "\\" : "/";
  const envFile =
    typeof config.raw.envFile === "string" && config.raw.envFile.trim()
      ? config.raw.envFile
      : folder
        ? `${folder.replace(/[\\/]+$/, "")}${sep}.env`
        : null;
  let fromFile: Record<string, string> = {};
  if (envFile) {
    const text = await fsIpc.read(envFile).then(
      (b) => new TextDecoder().decode(b),
      () => null,
    );
    if (text !== null) fromFile = parseEnvFile(text, config.env);
  }
  const env = { ...fromFile, ...config.env };
  const next: LaunchConfig = Object.keys(fromFile).length
    ? { ...config, env, raw: { ...config.raw, env } }
    : config;
  const libs = await bundledDebugpy(services);
  return {
    python,
    config: next,
    ...(libs && { adapterEnv: { PYTHONPATH: withPythonPath(libs, undefined, platform) } }),
  };
}
